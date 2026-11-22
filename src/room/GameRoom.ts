import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { getGame } from "../games/registry";
import { GameError, type AnyGame, type GameResult } from "../games/types";
import { extractWsAuth, newRoomId, newToken, randomHex } from "../lib/auth";
import { DEFAULT_TURN_TIME_MS, roomOptions } from "../lib/options";
import {
  clientMessage,
  CLOSE_LEFT_ROOM,
  errBody,
  toWsErrorCode,
  type EndReason,
  type RoomStatus,
  type ServerMessage,
} from "../lib/protocol";
import { applyResign, applyTimeout, replayFrames, type LogEntry, type ReplayLog } from "../lib/replay";
import { practiceAction } from "../lib/practice";
import { createRng, rngForTurn, type Seed } from "../lib/rng";

export type RoomError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 500;
  code: string;
  message: string;
};
export type RoomResult<T> = { ok: true; data: T } | RoomError;

const fail = (status: RoomError["status"], code: string, message: string): RoomError => ({
  ok: false,
  status,
  code,
  message,
});
const ok = <T>(data: T): RoomResult<T> => ({ ok: true, data });
const NOT_FOUND = fail(404, "ROOM_NOT_FOUND", "room not found");

export interface RoomState {
  game: string;
  status: RoomStatus;
  turn: number;
  players: string[];
  currentPlayers: string[];
  view: unknown;
  /** 呼び出したプレイヤーが今行動できるときだけ付く */
  legal?: unknown[];
  /** 現在の手番の締め切り（epoch ms）。playing 以外は null */
  deadline: number | null;
  /** サーバーの現在時刻（epoch ms）。クライアントは deadline - now で残り時間を出す（時計ずれ対策） */
  now: number;
  result: GameResult | null;
  /** 終了後に誰かが再戦を申し込んだときだけ付く */
  rematch?: RematchInfo;
}

/** 再戦の案内。roomId は新しいルーム、requestedBy は申し込んだ（このルームでの）プレイヤー ID。 */
export interface RematchInfo {
  roomId: string;
  requestedBy: string[];
}

export interface ReplayFrames {
  game: string;
  seed: Seed;
  players: string[];
  /** frames[i] は turn=i の観戦視点。action はそのターンに適用された行動（最初のフレームは null）。 */
  frames: { turn: number; view: unknown; action: LogEntry | null }[];
  result: GameResult | null;
}

/**
 * WS に持たせる情報。token は接続時に使ったトークン（サーバー内にだけ保存され、クライアントには送らない）。
 * 再戦ルームでは退出した席に同じ ID で座り直せるので、ID だけでなくトークンも一致する接続だけをその席として扱う。
 * token が無いのはこの仕組みの導入前に繋いだ接続で、ID だけで判定する。
 */
type Attachment = { playerId: string | null; token?: string };

/**
 * サーバーが書くログの行は player = "" で表す（プレイヤー ID と衝突しない）。
 * 持ち時間切れは action = {"$timeout":[...]}、投了は action = {"$resign":"p1"}。
 */
const SYSTEM_PLAYER = "";
const systemEvent = z.union([
  z.strictObject({ $timeout: z.array(z.string()) }),
  z.strictObject({ $resign: z.string() }),
]);

/**
 * D1 への結果書き込みが失敗したときの再試行（alarm で指数バックオフ、最大1時間おき）。
 * D1 の日次上限は UTC 0時にリセットされるので、終了から 26 時間は諦めない（alarm 1回 = 1リクエスト）。
 */
const PERSIST_RETRY_BASE_MS = 30_000;
const PERSIST_RETRY_MAX_MS = 60 * 60 * 1000;
const PERSIST_RETRY_WINDOW_MS = 26 * 60 * 60 * 1000;

/** setAlarm が失敗したときのその場での再試行間隔。 */
const ALARM_RETRY_DELAYS_MS = [50, 200, 1000];

/**
 * 練習相手が1回の呼び出し（リクエスト / alarm）で続けて打つ手数の上限。
 * Free プランは CPU 時間が短いので、上限に達したら alarm を「今」に張って続きはそちらで打つ。
 */
const MAX_BOT_STEPS_PER_CALL = 32;

/** commit() で確定した結果。確定後の副作用（alarm・配信・D1）に使う。 */
type Committed =
  | { kind: "waiting" }
  | { kind: "playing"; deadline: number }
  | { kind: "finished"; result: GameResult };

/** 視点によらない状態の共通部分（buildState / broadcast で1回だけ読む）。 */
type RoomCore = {
  game: AnyGame;
  status: RoomStatus;
  players: string[];
  snap: { turn: number; state: unknown } | null;
  currentPlayers: string[];
  deadline: number | null;
  result: GameResult | null;
  rematch: RematchInfo | null;
};

export class GameRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  /** テーブルが作成済み（= init 済みのルーム）か。 */
  private ready: boolean;
  /** 練習相手の手を打っている最中か（commit → runBots の再入を防ぐ）。 */
  private botsRunning = false;
  /** 1回の呼び出しで練習相手が打つ手数の上限（テストで小さくできるようにインスタンスに持つ）。 */
  private botStepsPerCall = MAX_BOT_STEPS_PER_CALL;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // テーブルは init() で初めて作る。存在しないルーム ID へのアクセスでストレージを書かないよう、ここでは読むだけ。
    this.ready =
      this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    // ping は DO を起こさずに自動応答する（受信リクエスト数の節約）
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', JSON.stringify({ type: "pong" } satisfies ServerMessage)),
    );
  }

  // ---- 内部ヘルパー ----

  private createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, token TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT);
      CREATE TABLE IF NOT EXISTS actions(turn INTEGER, player TEXT, action TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), turn INTEGER, state TEXT);
    `);
    this.ready = true;
  }

  private getMeta(key: string): string | null {
    if (!this.ready) return null;
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (rows[0]!.value as string) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, value);
  }

  private playerIds(): string[] {
    return this.sql
      .exec("SELECT id FROM players ORDER BY seq")
      .toArray()
      .map((r) => r.id as string);
  }

  private playerByToken(token: string | null): string | null {
    if (!token) return null;
    const rows = this.sql.exec("SELECT id FROM players WHERE token = ?", token).toArray();
    return rows.length ? (rows[0]!.id as string) : null;
  }

  /**
   * 新しい席の ID を払い出す（p1, p2, ... の連番。退出しても番号は再利用しない）。
   * 再利用すると、閉じ損ねた退出者の WS（attachment に playerId を持つ）が新しい参加者の view を受け取れてしまう。
   * seq は番号と揃える（手番の順 = ORDER BY seq）。nextSeat が無いのはこの仕組みの導入前に作ったルームで、
   * 既存の席は p(seq+1) なので、最大の seq の次から払い出す（退出で行数が減っていても衝突しない）。
   * write の中（トランザクション内）で呼ぶこと。
   */
  private allocateSeat(): { id: string; seq: number } {
    const fallback = () => {
      const r = this.sql.exec("SELECT MAX(seq) AS m FROM players").toArray()[0];
      return r?.m === null || r?.m === undefined ? 1 : Number(r.m) + 2;
    };
    const stored = this.getMeta("nextSeat");
    const n = stored !== null ? Number(stored) : fallback();
    this.setMeta("nextSeat", String(n + 1));
    return { id: `p${n}`, seq: n - 1 };
  }

  /** 再戦用に席を予約したルームなら、元のルームのプレイヤー ID → このルームの席 ID。 */
  private reservedSeats(): Record<string, string> | null {
    const r = this.getMeta("reserved");
    return r ? (JSON.parse(r) as Record<string, string>) : null;
  }

  private rematchInfo(): RematchInfo | null {
    const roomId = this.getMeta("rematchRoomId");
    const by = this.getMeta("rematchRequested");
    return roomId && by ? { roomId, requestedBy: JSON.parse(by) as string[] } : null;
  }

  private loadSnapshot(): { turn: number; state: unknown } {
    const r = this.sql.exec("SELECT turn, state FROM snapshot WHERE id = 1").toArray()[0]!;
    return { turn: r.turn as number, state: JSON.parse(r.state as string) };
  }

  private saveSnapshot(turn: number, state: unknown): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO snapshot(id, turn, state) VALUES (1, ?, ?)",
      turn,
      JSON.stringify(state),
    );
  }

  private seed(): Seed {
    return this.getMeta("seed")!;
  }

  private status(): RoomStatus {
    return this.getMeta("status") as RoomStatus;
  }

  /** init 済みのルームか。 */
  private exists(): boolean {
    return this.getMeta("gameId") !== null;
  }

  private game(): AnyGame {
    return getGame(this.getMeta("gameId")!)!;
  }

  /** ゲーム自身の結果。なければ時間切れ・投了による決着（forfeit）。 */
  private resultOf(game: AnyGame, state: unknown): GameResult | null {
    const r = game.result(state);
    if (r) return r;
    const f = this.getMeta("forfeit");
    return f ? (JSON.parse(f) as GameResult) : null;
  }

  /** 試合が終わった理由。endReason が無いのは通常の決着か、endReason 導入前の時間切れ。 */
  private endReason(): EndReason {
    const r = this.getMeta("endReason");
    if (r === "timeout" || r === "resign") return r;
    return this.getMeta("forfeit") !== null ? "timeout" : "normal";
  }

  private deadline(): number | null {
    if (this.status() !== "playing") return null;
    const d = this.getMeta("deadline");
    return d ? Number(d) : null;
  }

  private loadCore(): RoomCore {
    const game = this.game();
    const status = this.status();
    const players = this.playerIds();
    if (status === "waiting") {
      return { game, status, players, snap: null, currentPlayers: [], deadline: null, result: null, rematch: null };
    }
    const snap = this.loadSnapshot();
    return {
      game,
      status,
      players,
      snap,
      currentPlayers: status === "playing" ? game.currentPlayers(snap.state) : [],
      deadline: this.deadline(),
      result: this.resultOf(game, snap.state),
      rematch: status === "finished" ? this.rematchInfo() : null,
    };
  }

  private stateFor(core: RoomCore, pid: string | null): RoomState {
    const { game, status, players, snap, currentPlayers, deadline, result, rematch } = core;
    const out: RoomState = {
      game: game.id,
      status,
      turn: snap?.turn ?? 0,
      players,
      currentPlayers,
      view: snap ? game.view(snap.state, pid) : null,
      deadline,
      now: Date.now(),
      result,
    };
    if (snap && pid && status === "playing" && currentPlayers.includes(pid)) {
      out.legal = game.legalActions(snap.state, pid);
    }
    if (rematch) out.rematch = rematch;
    return out;
  }

  private buildState(pid: string | null): RoomState {
    return this.stateFor(this.loadCore(), pid);
  }

  // ---- 配信 ----

  private send(ws: WebSocket, msg: ServerMessage): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // 切断済みの接続は無視する
    }
  }

  private stateMessage(s: RoomState): ServerMessage {
    return {
      type: "state",
      turn: s.turn,
      view: s.view,
      ...(s.legal ? { legal: s.legal } : {}),
      currentPlayers: s.currentPlayers,
      deadline: s.deadline,
      now: s.now,
      status: s.status,
      players: s.players,
      ...(s.rematch ? { rematch: s.rematch } : {}),
    };
  }

  private endMessage(r: GameResult): ServerMessage {
    return { type: "end", winners: r.winners, ...(r.scores ? { scores: r.scores } : {}), reason: this.endReason() };
  }

  /**
   * 接続のプレイヤー ID。もう席にいない（退出した）プレイヤーの接続や、座り直す前のトークンの接続は観戦者として扱う
   * （退出時に閉じるが、閉じ損ねても他人の視点が漏れず、行動もできないように）。
   */
  private socketPlayer(ws: WebSocket, seats: Map<string, string>): string | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    const pid = att?.playerId ?? null;
    if (pid === null || !seats.has(pid)) return null;
    return att?.token === undefined || att.token === seats.get(pid) ? pid : null;
  }

  /** 席 ID → 今のトークン。 */
  private seatTokens(): Map<string, string> {
    return new Map(
      this.sql
        .exec("SELECT id, token FROM players")
        .toArray()
        .map((r) => [r.id as string, r.token as string]),
    );
  }

  /**
   * 全接続に、その接続の視点の view を配る（end があれば続けて end も）。
   * 共通部分は1回だけ読み、同じ視点の接続（観戦者どうしなど）はメッセージを使い回す。
   */
  private broadcast(end?: GameResult): void {
    const core = this.loadCore();
    const seats = this.seatTokens();
    const byViewer = new Map<string | null, string>();
    const endMsg = end ? JSON.stringify(this.endMessage(end)) : null;
    for (const ws of this.ctx.getWebSockets()) {
      const pid = this.socketPlayer(ws, seats);
      let msg = byViewer.get(pid);
      if (msg === undefined) {
        msg = JSON.stringify(this.stateMessage(this.stateFor(core, pid)));
        byViewer.set(pid, msg);
      }
      this.sendRaw(ws, msg);
      if (endMsg) this.sendRaw(ws, endMsg);
    }
  }

  /**
   * 状態変更の確定（join / start / 行動 / 時間切れのすべてがここを通る）。
   * write と、決着判定・締め切りの更新を1つのトランザクションで確定し、その後で alarm・配信・D1 を行う。
   * 確定後の副作用が失敗しても変更は取り消さず成功として扱う（クライアントには確定済みの状態を配る）。
   *
   * prev（write 前に行動できたプレイヤー）を渡したとき、行動できるプレイヤーが減っただけ（同時手番で誰かが出した）なら
   * 締め切りを延ばさない。手番が移ったとき・新しいラウンドに入ったときだけ持ち時間をリセットする。
   */
  private async commit(write: () => void, prev: string[] | null = null): Promise<void> {
    const out = this.ctx.storage.transactionSync((): Committed => {
      const prevDeadline = this.getMeta("deadline");
      write();
      if (this.status() === "waiting") return { kind: "waiting" };
      const { state } = this.loadSnapshot();
      const game = this.game();
      const result = this.resultOf(game, state);
      if (result) {
        this.setMeta("status", "finished");
        this.setMeta("finishedAt", String(Date.now()));
        return { kind: "finished", result };
      }
      const pending = game.currentPlayers(state);
      const shrinking =
        prev !== null &&
        prevDeadline !== null &&
        pending.length > 0 &&
        pending.length < prev.length &&
        pending.every((p) => prev.includes(p));
      const deadline = shrinking
        ? Number(prevDeadline)
        : Date.now() + (this.options().turnTimeMs ?? DEFAULT_TURN_TIME_MS);
      this.setMeta("deadline", String(deadline));
      return { kind: "playing", deadline };
    });

    // ここから先は確定済み。失敗はログに残すだけで、呼び出し元にはエラーを返さない。
    if (out.kind === "finished") {
      await this.attempt("deleteAlarm", () => this.ctx.storage.deleteAlarm());
      await this.attempt("broadcast", () => this.broadcast(out.result));
      if (!(await this.persistResult(out.result))) await this.schedulePersistRetry();
      return;
    }
    if (out.kind === "playing") {
      await this.armAlarm(out.deadline);
    }
    await this.attempt("broadcast", () => this.broadcast());
    if (out.kind === "playing") await this.runBots();
  }

  /** 練習相手（サーバー側の Bot）のプレイヤー ID。 */
  private bots(): string[] {
    return JSON.parse(this.getMeta("bots") ?? "[]") as string[];
  }

  /** 今行動できる練習相手（いなければ null）。 */
  private pendingBot(): string | null {
    if (this.status() !== "playing") return null;
    const bots = this.bots();
    if (bots.length === 0) return null;
    const pending = this.game().currentPlayers(this.loadSnapshot().state);
    return pending.find((p) => bots.includes(p)) ?? null;
  }

  /**
   * 練習相手の手番なら、その場で打つ（練習相手の手番でなくなるか、決着するまで続ける）。
   * DO の中で打つので、受信メッセージも外部の接続も増えない。手は普通に行動ログに入るのでリプレイも変わらない。
   * 1回で MAX_BOT_STEPS_PER_CALL 手を超えるときは、alarm を今に張って続きを打つ（alarm() → runBots）。
   */
  private async runBots(): Promise<void> {
    if (this.botsRunning) return; // commit から再入したときは外側のループに任せる
    this.botsRunning = true;
    try {
      for (let i = 0; ; i++) {
        const bot = this.pendingBot();
        if (!bot) return;
        if (i >= this.botStepsPerCall) {
          await this.armAlarm(Date.now()); // 締め切りの alarm は、続きの commit で張り直される
          return;
        }
        const game = this.game();
        const snap = this.loadSnapshot();
        const pending = game.currentPlayers(snap.state);
        // Bot の乱数はシードと無関係に作る（手はログに残るので再現には不要）
        const pick = practiceAction(game, snap.state, bot, createRng(randomHex(16)));
        if (!pick) return; // 打てる手がなければ持ち時間切れに任せる
        // 読み込みから commit まで await を挟まない（他の行動と入れ替わらない）
        const next = game.apply(snap.state, bot, pick.action, rngForTurn(this.seed(), snap.turn));
        await this.commit(() => {
          this.appendLog(snap.turn, bot, pick.action);
          this.saveSnapshot(snap.turn + 1, next);
        }, pending);
      }
    } catch (e) {
      console.error("practice bot failed", e); // 打てなかった練習相手は持ち時間切れで負けになる
    } finally {
      this.botsRunning = false;
    }
  }

  /** setAlarm を短い間隔で数回まで再試行する。最後まで失敗したら false（ensureAlarm が後で張り直す）。 */
  private async armAlarm(at: number): Promise<boolean> {
    for (let i = 0; ; i++) {
      try {
        await this.ctx.storage.setAlarm(at);
        return true;
      } catch (e) {
        if (i >= ALARM_RETRY_DELAYS_MS.length) {
          console.error("setAlarm failed; will re-arm on next access", e);
          return false;
        }
        await new Promise((r) => setTimeout(r, ALARM_RETRY_DELAYS_MS[i]));
      }
    }
  }

  /**
   * 自己修復：Alarm が必要なのに設定されていなければ張り直す。
   * playing なら手番の締め切り、finished で D1 未書き込みなら再試行。リクエストの入口ごとに呼ぶ（getAlarm を読むだけ）。
   */
  private async ensureAlarm(): Promise<void> {
    try {
      const status = this.status();
      const needsAlarm =
        (status === "playing" && this.getMeta("deadline") !== null) ||
        (status === "finished" && this.getMeta("persisted") !== "1" && this.getMeta("roomId") !== null);
      if (!needsAlarm || (await this.ctx.storage.getAlarm()) !== null) return;
      // 締め切りが過ぎていれば即時発火し、alarm() が時間切れ処理（または D1 再試行）をする
      const at = status === "playing" ? Number(this.getMeta("deadline")) : Date.now();
      await this.armAlarm(at);
    } catch (e) {
      console.error("ensureAlarm failed", e);
    }
  }

  /** 確定後の副作用を実行し、失敗はログに残すだけにする。 */
  private async attempt(what: string, f: () => unknown): Promise<void> {
    try {
      await f();
    } catch (e) {
      console.error(`${what} failed`, e);
    }
  }

  /**
   * D1 への書き込み。roomId をキーに冪等（INSERT OR IGNORE）なので何度再試行してもよい。
   * 成功（または D1 が無い）なら meta.persisted を立てて true を返す。失敗しても試合は壊さない。
   */
  private async persistResult(result: GameResult): Promise<boolean> {
    try {
      const id = this.getMeta("roomId");
      // 練習試合は戦績・試合一覧に載せない（ランダム相手の勝ち数で戦績が水増しされないように）
      if (!id || !this.env.DB || this.options().practice) return true;
      const players = this.sql.exec("SELECT id, user_id FROM players ORDER BY seq").toArray();
      // 時間切れ・投了による決着（forfeit）に引き分けはない。勝者がいなければ全員の負け。
      const byForfeit = this.getMeta("forfeit") !== null;
      const outcome = (pid: string) =>
        result.winners.includes(pid) ? "win" : result.winners.length === 0 && !byForfeit ? "draw" : "loss";
      const index = this.indexStatement();
      await this.env.DB.batch([
        ...(index ? [index] : []),
        this.env.DB
          .prepare(
            "INSERT OR IGNORE INTO matches(id, game, seed, players, started_at, finished_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            id,
            this.getMeta("gameId"),
            this.seed(),
            JSON.stringify(players.map((p) => p.id)),
            Number(this.getMeta("startedAt")),
            Number(this.getMeta("finishedAt")),
            this.endReason(),
          ),
        ...players.map((p) =>
          this.env.DB
            .prepare(
              "INSERT OR IGNORE INTO results(match_id, player_id, user_id, outcome, score) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(id, p.id as string, (p.user_id as string | null) ?? null, outcome(p.id as string), result.scores?.[p.id as string] ?? null),
        ),
      ]);
      this.setMeta("persisted", "1");
      return true;
    } catch (e) {
      console.error("failed to persist result to D1", e);
      return false;
    }
  }

  /** D1 書き込みの再試行を alarm で予約する（指数バックオフ。終了から PERSIST_RETRY_WINDOW_MS で諦める）。 */
  private async schedulePersistRetry(): Promise<void> {
    const n = Number(this.getMeta("persistAttempts") ?? "0");
    const finishedAt = Number(this.getMeta("finishedAt") ?? Date.now());
    if (Date.now() - finishedAt > PERSIST_RETRY_WINDOW_MS) {
      console.error(`giving up persisting result of room ${this.getMeta("roomId")} after ${n} retries`);
      return;
    }
    this.setMeta("persistAttempts", String(n + 1));
    const delay = Math.min(PERSIST_RETRY_BASE_MS * 2 ** n, PERSIST_RETRY_MAX_MS);
    await this.armAlarm(Date.now() + delay);
  }

  /** 終了済みで D1 への書き込みが済んでいなければ再試行する（alarm から呼ぶ）。 */
  private async retryPersist(): Promise<void> {
    if (this.getMeta("persisted") === "1") return;
    const game = this.game();
    const result = this.resultOf(game, this.loadSnapshot().state);
    if (!result) return;
    if (!(await this.persistResult(result))) await this.schedulePersistRetry();
  }

  /**
   * 一覧用の索引（D1 の rooms）を今の状態で上書きする文。一覧に載せないルームや D1 が無いときは null。
   * rev は呼ぶたびに増える（同期処理の中で状態と一緒に読むので、後の rev ほど新しい状態）。
   * D1 側は rev が大きいときだけ上書きするので、await の間に追い越した古い書き込みが新しい状態を戻すことはない。
   */
  private indexStatement(): D1PreparedStatement | null {
    const opts = this.options();
    const id = this.getMeta("roomId");
    // 再戦ルームは決まったメンバーしか入れないので載せない
    if (!id || !this.env.DB || opts.unlisted || opts.practice || this.reservedSeats()) return null;
    const rev = Number(this.getMeta("indexRev") ?? "0") + 1;
    this.setMeta("indexRev", String(rev));
    const game = this.game();
    return this.env.DB.prepare(
      `INSERT INTO rooms(id, game, status, players, max_players, auto_start, turn_time_ms, created_at, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, players = excluded.players, updated_at = excluded.updated_at, rev = excluded.rev
       WHERE excluded.rev > rooms.rev`,
    ).bind(
      id,
      game.id,
      this.status(),
      this.playerIds().length,
      game.maxPlayers,
      opts.autoStart ? 1 : 0,
      opts.turnTimeMs ?? DEFAULT_TURN_TIME_MS,
      Number(this.getMeta("createdAt") ?? Date.now()),
      Date.now(),
      rev,
    );
  }

  /**
   * 索引を更新する（作成・join・開始のとき）。失敗してもログに残すだけ（索引は best-effort。本物の状態は DO にある）。
   * 終了時は persistResult の batch に含めるので、D1 の再試行に乗る。
   */
  private async syncIndex(): Promise<void> {
    await this.attempt("syncIndex", async () => {
      const st = this.indexStatement();
      if (st) await st.run();
    });
  }

  private options() {
    const parsed = roomOptions.safeParse(JSON.parse(this.getMeta("options") ?? "{}"));
    return parsed.success ? parsed.data : {};
  }

  // ---- RPC ----

  /**
   * ルーム作成。同じ ID で2回呼ぶと 409。開始権限を持つ hostToken を返す。
   * reserved（再戦用。元のルームのプレイヤー ID → 席 ID）を渡すと、その席は joinReserved でしか埋まらず、
   * 全席が埋まった時点で開始する。roomOptions には入れない（POST /rooms から誰でも指定できてしまうため）。
   */
  async init(
    roomId: string,
    gameId: string,
    options: unknown,
    reserved: Record<string, string> | null = null,
  ): Promise<RoomResult<{ game: string; hostToken: string }>> {
    if (this.getMeta("gameId") !== null) return fail(409, "ROOM_EXISTS", "room already exists");
    if (!getGame(gameId)) return fail(400, "UNKNOWN_GAME", `unknown game: ${gameId}`);
    const opts = roomOptions.safeParse(options ?? {});
    if (!opts.success) return fail(400, "BAD_REQUEST", "invalid options");
    const hostToken = newToken();
    this.ctx.storage.transactionSync(() => {
      this.createTables();
      this.setMeta("roomId", roomId);
      this.setMeta("gameId", gameId);
      this.setMeta("options", JSON.stringify(opts.data));
      this.setMeta("hostToken", hostToken);
      this.setMeta("status", "waiting");
      this.setMeta("createdAt", String(Date.now()));
      // 再戦ルームでは、練習相手などの追加の席は予約席の後ろから
      this.setMeta("nextSeat", String(reserved ? Object.keys(reserved).length + 1 : 1));
      if (reserved) this.setMeta("reserved", JSON.stringify(reserved));
    });
    await this.syncIndex();
    return ok({ game: gameId, hostToken });
  }

  /** 参加。プレイヤー ID は参加順に p1, p2, ...（退出した席の番号は再利用しない） */
  async join(userId: string | null = null): Promise<RoomResult<{ playerId: string; token: string }>> {
    if (!this.exists()) return NOT_FOUND;
    if (this.reservedSeats()) return fail(403, "ROOM_RESERVED", "this room is reserved for a rematch");
    if (this.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");
    const n = this.playerIds().length;
    const { maxPlayers } = this.game();
    if (n >= maxPlayers) return fail(409, "ROOM_FULL", "room is full");
    const token = newToken();
    let playerId = "";
    await this.commit(() => {
      const seat = this.allocateSeat();
      playerId = seat.id;
      this.sql.exec("INSERT INTO players(id, token, seq, user_id) VALUES (?, ?, ?, ?)", seat.id, token, seat.seq, userId);
    });
    // autoStart：満席になったらその場で開始する（ホストの start と競合しても startGame が status を見て1回だけ開始する）
    if (this.options().autoStart && n + 1 >= maxPlayers) await this.startGame();
    else await this.syncIndex();
    return ok({ playerId, token });
  }

  /**
   * 再戦ルームの予約席に座る（元のルームの rematch から呼ぶ。origin は元のルームでのプレイヤー ID）。
   * 同じ origin で何度呼んでも同じ席・同じトークンを返す。予約席が全部埋まったら開始する。
   */
  async joinReserved(
    origin: string,
    userId: string | null,
  ): Promise<RoomResult<{ playerId: string; token: string }>> {
    if (!this.exists()) return NOT_FOUND;
    const reserved = this.reservedSeats();
    const seat = reserved?.[origin];
    if (!reserved || !seat) return fail(403, "ROOM_RESERVED", "no seat is reserved for this player");
    const row = this.sql.exec("SELECT token FROM players WHERE id = ?", seat).toArray()[0];
    if (row) return ok({ playerId: seat, token: row.token as string });
    if (this.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");
    const token = newToken();
    await this.commit(() => {
      const seq = Number(seat.slice(1)) - 1;
      this.sql.exec("INSERT INTO players(id, token, seq, user_id) VALUES (?, ?, ?, ?)", seat, token, seq, userId);
    });
    if (this.playerIds().length >= Object.keys(reserved).length) await this.startGame();
    return ok({ playerId: seat, token });
  }

  /**
   * 待機中のルームから退出する（join の取り消し）。席は空き、トークンは無効になり、その席の WS は閉じる。
   * 再戦ルームでは席は予約されたまま（元のルームの rematch をもう一度呼べば座り直せる）。返すのは観戦視点。
   */
  async leave(token: string | null): Promise<RoomResult<RoomState>> {
    if (!this.exists()) return NOT_FOUND;
    const pid = this.playerByToken(token);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    if (this.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started (resign instead)");
    // ここから commit まで await を挟まない（start と入れ替わらない）
    await this.commit(() => {
      this.sql.exec("DELETE FROM players WHERE id = ?", pid);
    });
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment | null)?.playerId !== pid) continue;
      try {
        ws.close(CLOSE_LEFT_ROOM, "left the room");
      } catch {
        // すでに閉じている
      }
    }
    await this.syncIndex();
    return ok(this.buildState(null));
  }

  /**
   * 再戦：同じメンバーで新しいルームを作る（終了後のみ。プレイヤーのトークンで呼ぶ）。
   * 最初の呼び出しでルームを作り、席順をそこで決める（人間の席を1つずつずらす。2人なら先手と後手が入れ替わる）。
   * 呼んだプレイヤーはその場で自分の席に座る。全員が呼んだら開始する（練習相手の席は開始時に埋まる）。
   * 同じプレイヤーが何度呼んでも同じ { roomId, playerId, token } が返る。
   */
  async rematch(token: string | null): Promise<RoomResult<{ roomId: string; playerId: string; token: string }>> {
    if (!this.exists()) return NOT_FOUND;
    const pid = this.playerByToken(token);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    if (this.status() !== "finished") return fail(403, "NOT_FINISHED", "rematch is available after the game has finished");

    // 新しいルームの ID は await の前に確定させる（同時に呼ばれても1つしか作らない）
    let roomId = this.getMeta("rematchRoomId");
    if (!roomId) {
      roomId = newRoomId();
      this.setMeta("rematchRoomId", roomId);
    }
    const stub = this.env.GAME_ROOM.getByName(roomId);
    if (this.getMeta("rematchReady") !== "1") {
      const bots = this.bots();
      const humans = this.playerIds().filter((p) => !bots.includes(p));
      const n = humans.length;
      const reserved = Object.fromEntries(humans.map((p, i) => [p, `p${((i + n - 1) % n) + 1}`]));
      const init = await stub.init(roomId, this.getMeta("gameId")!, this.options(), reserved);
      // ROOM_EXISTS は、同時に呼ばれたもう一方が作り終えたということ
      if (!init.ok && init.code !== "ROOM_EXISTS") return init;
      this.setMeta("rematchReady", "1");
    }
    const userRow = this.sql.exec("SELECT user_id FROM players WHERE id = ?", pid).toArray()[0];
    const seat = await stub.joinReserved(pid, (userRow?.user_id as string | null | undefined) ?? null);
    if (!seat.ok) return seat;

    const requested = this.rematchInfo()?.requestedBy ?? [];
    if (!requested.includes(pid)) {
      this.setMeta("rematchRequested", JSON.stringify([...requested, pid]));
      // 終了済みのルームの接続に再戦の申し込みを知らせる（end は送り直さない）
      await this.attempt("broadcast", () => this.broadcast());
    }
    return ok({ roomId, ...seat.data });
  }

  /** 試合開始（作成者 = POST /rooms で受け取った hostToken を持つ者のみ）。返すのは観戦視点。 */
  async start(token: string | null): Promise<RoomResult<RoomState>> {
    if (!this.exists()) return NOT_FOUND;
    if (!token) return fail(401, "UNAUTHORIZED", "host token required");
    if (token !== this.getMeta("hostToken")) {
      return this.playerByToken(token)
        ? fail(403, "NOT_HOST", "only the room creator can start the game")
        : fail(401, "UNAUTHORIZED", "invalid token");
    }
    return this.startGame();
  }

  /** 開始処理の本体（認証済みの start と autoStart から呼ぶ）。返すのは観戦視点。 */
  private async startGame(): Promise<RoomResult<RoomState>> {
    if (this.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");

    const game = this.game();
    const joined = this.playerIds().length;
    const botCount = this.options().practice ? Math.max(0, game.minPlayers - joined) : 0;
    if (joined + botCount < game.minPlayers) {
      return fail(409, "NOT_ENOUGH_PLAYERS", `need at least ${game.minPlayers} players`);
    }
    const seed: Seed = randomHex(16); // 128 ビット。総当たりで特定されないように
    await this.commit(() => {
      // 練習相手は参加者の後ろの空席（minPlayers まで）に座る
      const botIds = Array.from({ length: botCount }, () => {
        const seat = this.allocateSeat();
        // トークンは誰にも渡さない（練習相手の席には外から行動できない）
        this.sql.exec("INSERT INTO players(id, token, seq, user_id) VALUES (?, ?, ?, NULL)", seat.id, newToken(), seat.seq);
        return seat.id;
      });
      if (botIds.length) this.setMeta("bots", JSON.stringify(botIds));
      this.setMeta("seed", String(seed));
      this.setMeta("startedAt", String(Date.now()));
      this.saveSnapshot(0, game.init(this.playerIds(), seed));
      this.setMeta("status", "playing");
    });
    await this.syncIndex();
    return ok(this.buildState(null));
  }

  /** 状態取得。token があればそのプレイヤー視点、なければ観戦視点。 */
  async getState(token: string | null): Promise<RoomResult<RoomState>> {
    if (!this.exists()) return NOT_FOUND;
    await this.ensureAlarm();
    let pid: string | null = null;
    if (token) {
      pid = this.playerByToken(token);
      if (!pid) return fail(401, "UNAUTHORIZED", "invalid token");
    }
    return ok(this.buildState(pid));
  }

  /** REST の行動。turn が現在のターンと一致しなければ STALE_TURN。 */
  async act(token: string | null, turn: number, rawAction: unknown): Promise<RoomResult<RoomState>> {
    if (!this.exists()) return NOT_FOUND;
    const pid = this.playerByToken(token);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    const r = await this.actAs(pid, turn, rawAction);
    return r.ok ? ok(this.buildState(pid)) : r;
  }

  /** REST の投了。 */
  async resign(token: string | null): Promise<RoomResult<RoomState>> {
    if (!this.exists()) return NOT_FOUND;
    const pid = this.playerByToken(token);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    const r = await this.resignAs(pid);
    return r.ok ? ok(this.buildState(pid)) : r;
  }

  /**
   * REST / WS 共通の投了。手番に関係なく、試合中ならいつでもできる。
   * 既定では投了したプレイヤーの負けで残り全員が勝つ。ゲームが onResign を定義していればそれに従う（試合が続くこともある）。
   * ログには1ターンとして残すので、リプレイでも同じ結果になる。
   */
  private async resignAs(pid: string | null): Promise<RoomResult<null>> {
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    await this.ensureAlarm();
    if (this.status() !== "playing") return fail(409, "NOT_PLAYING", "game is not in progress");
    // 締め切りを過ぎていれば先に時間切れを確定させる（それで決着したら投了は不要）
    if (this.deadlinePassed()) {
      await this.resolveTimeout();
      if (this.status() !== "playing") return fail(409, "NOT_PLAYING", "game is not in progress");
    }
    // ここから commit まで await を挟まない
    const game = this.game();
    const snap = this.loadSnapshot();
    let r: ReturnType<typeof applyResign>;
    try {
      r = applyResign(game, snap.state, pid, this.playerIds(), this.seed(), snap.turn);
    } catch (e) {
      if (e instanceof GameError) return fail(e.code === "NOT_YOUR_TURN" ? 403 : 400, e.code, e.message);
      throw e;
    }
    await this.commit(() => {
      this.appendSystemLog(snap.turn, { $resign: pid });
      this.saveSnapshot(snap.turn + 1, r.state);
      this.recordForfeit(game, r, "resign");
    }, game.currentPlayers(snap.state));
    return ok(null);
  }

  /** REST / WS 共通の行動処理。存在するルームで、認証済みの playerId（観戦者は null）を受け取る。 */
  private async actAs(pid: string | null, turn: number, rawAction: unknown): Promise<RoomResult<null>> {
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    await this.ensureAlarm(); // 行動が拒否される場合（STALE_TURN など）でも締め切りを取り戻す
    if (this.status() !== "playing") return fail(409, "NOT_PLAYING", "game is not in progress");
    // 締め切りを過ぎた手は受け付けない。Alarm の発火を待たずにこの場で時間切れを確定させる
    // （ここから commit まで await を挟まないので、時間切れ処理と行動が入れ替わることはない）。
    if (this.deadlinePassed()) {
      await this.resolveTimeout();
      return fail(409, "STALE_TURN", "time is up; the turn was resolved by timeout");
    }

    const snap = this.loadSnapshot();
    if (turn !== snap.turn) return fail(409, "STALE_TURN", `current turn is ${snap.turn}`);

    const game = this.game();
    const parsed = game.actionSchema.safeParse(rawAction);
    if (!parsed.success) return fail(400, "BAD_REQUEST", "invalid action");

    let next: unknown;
    try {
      next = game.apply(snap.state, pid, parsed.data, rngForTurn(this.seed(), snap.turn));
    } catch (e) {
      if (e instanceof GameError) {
        return fail(e.code === "NOT_YOUR_TURN" ? 403 : 400, e.code, e.message);
      }
      throw e;
    }

    // ログ追記・スナップショット・締め切りは commit 内の1トランザクションで確定する
    await this.commit(() => {
      this.appendLog(snap.turn, pid, parsed.data);
      this.saveSnapshot(snap.turn + 1, next);
    }, game.currentPlayers(snap.state));
    return ok(null);
  }

  /** 行動ログへの追記（符号化は readLog と対）。 */
  private appendLog(turn: number, player: string, action: unknown): void {
    this.appendRow(turn, player, action);
  }

  /** サーバーが書く行（持ち時間切れ・投了）。 */
  private appendSystemLog(turn: number, event: { $timeout: string[] } | { $resign: string }): void {
    this.appendRow(turn, SYSTEM_PLAYER, event);
  }

  private appendRow(turn: number, player: string, action: unknown): void {
    this.sql.exec(
      "INSERT INTO actions(turn, player, action, at) VALUES (?, ?, ?, ?)",
      turn,
      player,
      JSON.stringify(action),
      Date.now(),
    );
  }

  private readLog(): LogEntry[] {
    return this.sql
      .exec("SELECT turn, player, action, at FROM actions ORDER BY turn")
      .toArray()
      .map((r) => {
        const action = JSON.parse(r.action as string) as unknown;
        const at = r.at as number;
        if (r.player === SYSTEM_PLAYER) {
          const base = { turn: r.turn as number, player: null, action: null, at };
          const ev = systemEvent.safeParse(action);
          // 知らない形の行を時間切れなどと読み替えると、リプレイの結果が実際の試合とずれる
          if (!ev.success) throw new Error(`corrupt system log row at turn ${base.turn}`);
          return "$resign" in ev.data ? { ...base, resign: ev.data.$resign } : { ...base, timeout: ev.data.$timeout };
        }
        return { turn: r.turn as number, player: r.player as string, action, at };
      });
  }

  /** 行動ログ。シードから隠し情報が推測されないよう、終了後のみ公開する。 */
  async getLog(): Promise<RoomResult<ReplayLog>> {
    const gameId = this.getMeta("gameId");
    if (gameId === null) return NOT_FOUND;
    if (this.status() !== "finished") {
      return fail(403, "NOT_FINISHED", "log is available after the game has finished");
    }
    let actions: LogEntry[];
    try {
      actions = this.readLog();
    } catch (e) {
      // DO から例外を投げると workerd が uncaught exception として別に出すので、ここで記録して 500 で返す
      console.error("failed to read action log", e);
      return fail(500, "INTERNAL", "internal error");
    }
    return ok({ game: gameId, seed: this.seed(), players: this.playerIds(), actions });
  }

  /** ログから再現した各ターンの観戦視点。終了後のみ。 */
  async getReplay(): Promise<RoomResult<ReplayFrames>> {
    const log = await this.getLog();
    if (!log.ok) return log;
    const game = getGame(log.data.game)!;
    const { frames, result } = replayFrames(game, log.data);
    return ok({
      game: game.id,
      seed: log.data.seed,
      players: log.data.players,
      frames: frames.map((f, i) => ({
        turn: f.turn,
        view: game.view(f.state, null),
        action: i === 0 ? null : log.data.actions[i - 1]!,
      })),
      result,
    });
  }

  // ---- WebSocket（Hibernation API） ----

  /** Worker から転送された WebSocket アップグレード。トークン（サブプロトコルか Bearer）が無ければ観戦。 */
  async fetch(request: Request): Promise<Response> {
    const error = (status: number, code: string, message: string) =>
      Response.json(errBody(code, message), { status });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return error(426, "UPGRADE_REQUIRED", "expected WebSocket upgrade");
    }
    if (!this.exists()) return error(NOT_FOUND.status, NOT_FOUND.code, NOT_FOUND.message);
    await this.ensureAlarm();
    const auth = extractWsAuth(request);
    if (!auth.ok) return error(400, "BAD_REQUEST", auth.message);
    let pid: string | null = null;
    if (auth.token) {
      pid = this.playerByToken(auth.token);
      if (!pid) return error(401, "UNAUTHORIZED", "invalid token");
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // Hibernation API。server.accept() は使わない
    server.serializeAttachment((pid ? { playerId: pid, token: auth.token! } : { playerId: null }) satisfies Attachment);

    const s = this.buildState(pid);
    this.send(server, this.stateMessage(s));
    if (s.status === "finished" && s.result) this.send(server, this.endMessage(s.result));
    // 応答で選ぶのはトークンを含まない "apigames"（トークンを応答ヘッダーに載せない）
    const headers: HeadersInit = auth.protocol ? { "Sec-WebSocket-Protocol": auth.protocol } : {};
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof message !== "string") {
        return this.send(ws, { type: "error", code: "BAD_REQUEST", message: "text frames only" });
      }
      let json: unknown;
      try {
        json = JSON.parse(message);
      } catch {
        return this.send(ws, { type: "error", code: "BAD_REQUEST", message: "invalid JSON" });
      }
      const msg = clientMessage.safeParse(json);
      if (!msg.success) {
        return this.send(ws, { type: "error", code: "BAD_REQUEST", message: "invalid message" });
      }
      if (msg.data.type === "ping") return this.send(ws, { type: "pong" });

      const pid = this.socketPlayer(ws, this.seatTokens());
      const r =
        msg.data.type === "resign" ? await this.resignAs(pid) : await this.actAs(pid, msg.data.turn, msg.data.action);
      if (!r.ok) this.send(ws, { type: "error", code: toWsErrorCode(r.code), message: r.message });
      // 成功時の state は afterChange の broadcast で全員に届く
    } catch (e) {
      console.error("webSocketMessage failed", e);
      this.send(ws, { type: "error", code: "INTERNAL", message: "internal error" });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      // 1005/1006 などは close() に渡せないので正常終了コードに丸める
      ws.close(code >= 1000 && code <= 1003 ? code : 1000);
    } catch {
      // すでに閉じている
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011);
    } catch {
      // すでに閉じている
    }
  }

  // ---- Alarm（持ち時間） ----

  async alarm(): Promise<void> {
    const status = this.status();
    if (status === "finished") return this.retryPersist();
    if (status !== "playing") return;
    // 練習相手の続き（runBots が1回の上限に達して張った alarm）
    if (this.pendingBot() && !this.deadlinePassed()) {
      await this.runBots();
      // 打てずに抜けた（例外・打てる手なし）ときも、締め切りの alarm を失わないようにする
      await this.ensureAlarm();
      return;
    }
    const deadline = this.getMeta("deadline");
    // 古い alarm の誤発火ガード: 締め切りがまだ先なら張り直すだけ
    if (deadline && Date.now() < Number(deadline)) {
      await this.armAlarm(Number(deadline));
      return;
    }
    await this.resolveTimeout();
  }

  /** playing で、現在の手番の締め切りを過ぎているか。 */
  private deadlinePassed(): boolean {
    const d = this.getMeta("deadline");
    return d !== null && Date.now() >= Number(d);
  }

  /** 現在の手番を時間切れとして確定する（alarm と、締め切り後に届いた行動の両方から呼ぶ）。 */
  private async resolveTimeout(): Promise<void> {
    const game = this.game();
    const snap = this.loadSnapshot();
    const pending = game.currentPlayers(snap.state);
    const r = applyTimeout(game, snap.state, pending, this.playerIds(), this.seed(), snap.turn);

    await this.commit(() => {
      this.appendSystemLog(snap.turn, { $timeout: pending });
      this.saveSnapshot(snap.turn + 1, r.state);
      this.recordForfeit(game, r, "timeout");
    });
  }

  /**
   * 時間切れ・投了の結果を meta に残す（commit の write の中で呼ぶ）。
   * forfeit があれば決着として保存し、試合が終わるなら（forfeit か、onTimeout / onResign の結果で決着）endReason を立てる。
   * 試合が続くときは endReason を書かない（後で通常の手で決着したら normal）。
   */
  private recordForfeit(game: AnyGame, r: { state: unknown; forfeit: GameResult | null }, reason: EndReason): void {
    if (r.forfeit) this.setMeta("forfeit", JSON.stringify(r.forfeit));
    if (r.forfeit || game.result(r.state)) this.setMeta("endReason", reason);
  }
}
