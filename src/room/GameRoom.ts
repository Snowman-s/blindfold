import { DurableObject } from "cloudflare:workers";
import { getGame } from "../games/registry";
import type { AnyGame, GameResult } from "../games/types";
import { extractWsAuth, hashToken, newRoomId, newToken, randomHex, rematchToken, sha256Hex } from "../lib/auth";
import {
  DEFAULT_TURN_TIME_MS,
  FINISHED_ROOM_TTL_MS,
  parseGameOptions,
  PLAYING_INDEX_REFRESH_MS,
  roomOptions,
  WAITING_ROOM_TTL_MS,
} from "../lib/options";
import {
  clientMessage,
  CLOSE_GAME_REMOVED,
  CLOSE_LEFT_ROOM,
  CLOSE_REPLACED,
  CLOSE_ROOM_DELETED,
  CLOSE_TOO_MANY_ERRORS,
  errBody,
  MAX_SOCKETS_PER_SEAT,
  MAX_SPECTATOR_SOCKETS,
  type RoomState,
  type ServerMessage,
  WS_MAX_STRIKES,
  WS_STRIKE_DECAY_MS,
} from "../lib/protocol";
import { replayFrames, type LogEntry, type ReplayLog } from "../lib/replay";
import { practiceAction } from "../lib/practice";
import { createRng, type Seed } from "../lib/rng";
import { matchStatements, roomIndexStatement } from "./d1";
import {
  decideAction,
  decideResign,
  decideTimeout,
  endMessage,
  fail,
  gameRemoved,
  nextDeadline,
  NOT_FOUND,
  ok,
  practiceBotCount,
  rematchSeats,
  resultOf,
  roomState,
  stateMessage,
  type Resolution,
  type RoomCore,
  type RoomError,
  type RoomResult,
} from "./logic";
import { migrateSchema } from "./schema";
import { RoomStore } from "./store";

/**
 * 1試合 = 1インスタンスの Durable Object。
 *
 * 役割の分担：
 * - logic.ts … 状態遷移と配る状態の組み立て（純粋関数。何を書くかを決める）
 * - store.ts … DO 内 SQLite の読み書き
 * - d1.ts    … D1 に書く文の組み立て
 * - ここ     … RPC の入口・トランザクション（commit）・確定後の副作用（alarm・配信・D1・練習相手）
 */

export type { RoomError, RoomResult } from "./logic";
export type { RoomState } from "../lib/protocol";

export interface ReplayFrames {
  game: string;
  rulesVersion: number;
  seed: Seed;
  gameOptions: unknown;
  players: string[];
  /** frames[i] は turn=i の観戦視点。action はそのターンに適用された行動（最初のフレームは null）。 */
  frames: { turn: number; view: unknown; action: LogEntry | null }[];
  result: GameResult | null;
}

/**
 * WS に持たせる情報。tokenHash は接続時に使ったトークンのハッシュ（attachment も保存されるので、トークンそのものは持たない）。
 * 再戦ルームでは退出した席に同じ ID で座り直せるので、ID だけでなくトークンも一致する接続だけをその席として扱う。
 * protocol は交渉したサブプロトコル（apigames.v1 など）。版ごとに配信を変えるときに使う。
 * at は接続した時刻（同じ席の接続が上限を超えたとき、いちばん古いものを閉じるため。getWebSockets() の順序は保証されない）。
 * strikes / strikeAt はエラーのリーキーバケット（WS_MAX_STRIKES）。strikeAt の時点で strikes 溜まっていた、という意味。
 */
type Attachment = ({ playerId: null } | { playerId: string; tokenHash: string }) & {
  protocol: string;
  at: number;
  strikes: number;
  strikeAt: number;
};

/** WS のタグ（acceptWebSocket の第2引数）。getWebSockets(tag) で接続を数える。 */
const SPECTATOR_TAG = "spectator";
const seatTag = (pid: string) => `seat:${pid}`;

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
  | { kind: "waiting"; cleanupAt: number }
  | { kind: "playing"; deadline: number }
  | { kind: "finished"; result: GameResult };

export class GameRoom extends DurableObject<Env> {
  private store: RoomStore;
  /** 練習相手の手を打っている最中か（commit → runBots の再入を防ぐ）。 */
  private botsRunning = false;
  /** 1回の呼び出しで練習相手が打つ手数の上限（テストで小さくできるようにインスタンスに持つ）。 */
  private botStepsPerCall = MAX_BOT_STEPS_PER_CALL;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage.sql);
    // 既存のルームのスキーマを今の版まで移行する（移行が済むまで他のイベントを受け付けない）
    if (this.store.ready) void ctx.blockConcurrencyWhile(async () => migrateSchema(ctx.storage));
    // ping は DO を起こさずに自動応答する（受信リクエスト数の節約）
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', JSON.stringify({ type: "pong" } satisfies ServerMessage)),
    );
  }

  // ---- エンジン ----

  /**
   * このルームのエンジン。作成時（init）に記録した rulesVersion と今の版が一致するときだけ返す（古い state や、
   * 古い optionsSchema で検証した gameOptions を新しいルールで動かさない）。無ければ null（GAME_REMOVED）。
   */
  private engine(): AnyGame | null {
    return getGame(this.store.gameId()!, this.store.rulesVersion()) ?? null;
  }

  /** check() を通った後で使う。 */
  private game(): AnyGame {
    const g = this.engine();
    if (!g) throw new Error(`engine for ${this.store.gameId()} is not available`);
    return g;
  }

  /**
   * RPC の入口で呼ぶ：ルームが無ければ ROOM_NOT_FOUND、エンジンが無ければ GAME_REMOVED。
   * 同期関数のまま保つ（通った後は commit まで await を挟まないため）。失敗したときは reject() で返す。
   */
  private check(): RoomError | null {
    if (!this.store.exists()) return NOT_FOUND;
    if (this.engine()) return null;
    return gameRemoved(this.store.gameId()!, this.store.rulesVersion(), this.store.status() === "finished");
  }

  /** check() の失敗を返す。GAME_REMOVED なら、その場でルームを畳む（retire）。 */
  private async reject(e: RoomError): Promise<RoomError> {
    if (e.code === "GAME_REMOVED") await this.retire();
    return e;
  }

  /**
   * エンジンが無いと分かったルームを畳む（入口の check か alarm で見つけたとき。2回目以降は何もしない）。
   * 進めようがないので、全接続を CLOSE_GAME_REMOVED で閉じ（再接続しても 410）、一覧の索引（D1 の rooms）の行を消し、
   * 進行中だったルームは終了したルームと同じ期間の後に掃除する（待機中・終了済みは cleanupAt が既にある）。
   * 索引の行は indexStatement（エンジンを使う）で上書きせず、直接消す。失敗しても一覧の鮮度の絞り込みで
   * いずれ出なくなる。
   */
  private async retire(): Promise<void> {
    if (this.store.getMeta("retired") === "1") return;
    this.ctx.storage.transactionSync(() => {
      this.store.setMeta("retired", "1");
      if (this.store.status() === "playing") {
        this.store.setMeta("cleanupAt", String(Date.now() + FINISHED_ROOM_TTL_MS));
      }
    });
    console.error(`retiring room ${this.store.getMeta("roomId")}: ${this.check()?.message}`);
    this.closeAll(CLOSE_GAME_REMOVED, "game removed");
    // D1 への書き込みの再試行を待っているなら、その alarm を掃除で上書きしない（再試行が済んだら掃除を張る）
    if (!this.persistPending()) await this.armCleanup();
    const id = this.store.getMeta("roomId");
    if (id && this.store.getMeta("indexRev") !== null && this.env.DB) {
      await this.attempt("delete room index", () => this.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run());
    }
  }

  /** 全接続を閉じる。 */
  private closeAll(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        // すでに閉じている
      }
    }
  }

  // ---- 状態の読み出し ----

  private resultNow(game: AnyGame, state: unknown): GameResult | null {
    return resultOf(game, state, this.store.forfeit());
  }

  /** playing のときの締め切り（それ以外は null）。 */
  private deadline(): number | null {
    return this.store.status() === "playing" ? this.store.deadline() : null;
  }

  private loadCore(): RoomCore {
    const game = this.game();
    const status = this.store.status();
    const players = this.store.playerIds();
    const gameOptions = this.store.gameOptions();
    const rulesVersion = this.store.rulesVersion();
    if (status === "waiting") {
      return {
        game, status, rulesVersion, gameOptions, players, snap: null, currentPlayers: [], deadline: null, result: null, rematch: null,
      };
    }
    const snap = this.store.loadSnapshot();
    return {
      game,
      status,
      rulesVersion,
      gameOptions,
      players,
      snap,
      currentPlayers: status === "playing" ? game.currentPlayers(snap.state) : [],
      deadline: this.deadline(),
      // 終了後は確定した結果（playing の間は決着していないので null）
      result: status === "finished" ? this.store.result() : null,
      rematch: status === "finished" ? this.store.rematchInfo() : null,
    };
  }

  private buildState(pid: string | null): RoomState {
    return roomState(this.loadCore(), pid, Date.now());
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

  /**
   * 接続のプレイヤー ID。もう席にいない（退出した）プレイヤーの接続や、座り直す前のトークンの接続は観戦者として扱う
   * （退出時に閉じるが、閉じ損ねても他人の視点が漏れず、行動もできないように）。
   */
  /** クライアントの誤りによるエラーを返し、エラーの上限（strike）に数える。INTERNAL（サーバーの誤り）には使わない。 */
  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: "error", code, message });
    this.strike(ws);
  }

  /**
   * エラーのリーキーバケットに1つ足す。WS_STRIKE_DECAY_MS ごとに1つ減り、WS_MAX_STRIKES を超えたら接続を閉じる
   * （受信は 20 通で1リクエスト。HTTP のレート制限は WS のメッセージには効かないので、DO の中で止める）。
   */
  private strike(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const now = Date.now();
    const strikes = Math.max(0, att.strikes - (now - att.strikeAt) / WS_STRIKE_DECAY_MS) + 1;
    if (strikes > WS_MAX_STRIKES) {
      try {
        ws.close(CLOSE_TOO_MANY_ERRORS, "too many errors");
      } catch {
        // すでに閉じている
      }
      return;
    }
    ws.serializeAttachment({ ...att, strikes, strikeAt: now } satisfies Attachment);
  }

  /**
   * 席 pid に新しい接続を受け入れる前に、同じ席の接続が MAX_SOCKETS_PER_SEAT 本未満になるよう古い順に閉じる。
   * 退出前の別のトークンの接続（再戦ルームで座り直した席）も同じ席のタグなので、まとめて古い順に数える。
   */
  private evictOldSockets(pid: string): void {
    const socks = this.ctx
      .getWebSockets(seatTag(pid))
      .map((ws) => ({ ws, at: (ws.deserializeAttachment() as Attachment | null)?.at ?? 0 }))
      .sort((a, b) => a.at - b.at);
    for (const { ws } of socks.slice(0, Math.max(0, socks.length - (MAX_SOCKETS_PER_SEAT - 1)))) {
      try {
        ws.close(CLOSE_REPLACED, "replaced by a newer connection");
      } catch {
        // すでに閉じている
      }
    }
  }

  private socketPlayer(ws: WebSocket, seats: Map<string, string>): string | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.playerId === null) return null;
    return att.tokenHash === seats.get(att.playerId) ? att.playerId : null;
  }

  /**
   * 全接続に、その接続の視点の view を配る（end があれば続けて end も）。
   * 共通部分は1回だけ読み、同じ視点の接続（観戦者どうしなど）はメッセージを使い回す。
   */
  private broadcast(end?: GameResult): void {
    const core = this.loadCore();
    const now = Date.now();
    const seats = this.store.seatTokenHashes();
    const byViewer = new Map<string | null, string>();
    const endMsg = end ? JSON.stringify(endMessage(end, this.store.endReason())) : null;
    for (const ws of this.ctx.getWebSockets()) {
      const pid = this.socketPlayer(ws, seats);
      let msg = byViewer.get(pid);
      if (msg === undefined) {
        msg = JSON.stringify(stateMessage(roomState(core, pid, now)));
        byViewer.set(pid, msg);
      }
      this.sendRaw(ws, msg);
      if (endMsg) this.sendRaw(ws, endMsg);
    }
  }

  // ---- 確定 ----

  /**
   * 状態変更の確定（join / start / 行動 / 時間切れのすべてがここを通る）。
   * write と、決着判定・締め切りの更新を1つのトランザクションで確定し、その後で alarm・配信・D1 を行う。
   * 確定後の副作用が失敗しても変更は取り消さず成功として扱う（クライアントには確定済みの状態を配る）。
   * prev は write 前に行動できたプレイヤー（締め切りを延ばすかどうかの判定。nextDeadline）。
   */
  private async commit(write: () => void, prev: string[] | null = null): Promise<void> {
    const out = this.ctx.storage.transactionSync((): Committed => {
      const prevDeadline = this.store.deadline();
      write();
      if (this.store.status() === "waiting") {
        // 放置された待機中のルームは、最後の変更から WAITING_ROOM_TTL_MS で消す
        const cleanupAt = Date.now() + WAITING_ROOM_TTL_MS;
        this.store.setMeta("cleanupAt", String(cleanupAt));
        return { kind: "waiting", cleanupAt };
      }
      const { state } = this.store.loadSnapshot();
      const game = this.game();
      const result = this.resultNow(game, state);
      if (result) {
        const now = Date.now();
        this.store.setMeta("status", "finished");
        this.store.setMeta("result", JSON.stringify(result));
        this.store.setMeta("finishedAt", String(now));
        this.store.setMeta("cleanupAt", String(now + FINISHED_ROOM_TTL_MS));
        return { kind: "finished", result };
      }
      const turnTimeMs = this.store.options().turnTimeMs ?? DEFAULT_TURN_TIME_MS;
      const deadline = nextDeadline(prev, prevDeadline, game.currentPlayers(state), Date.now(), turnTimeMs);
      this.store.setMeta("deadline", String(deadline));
      return { kind: "playing", deadline };
    });

    // ここから先は確定済み。失敗はログに残すだけで、呼び出し元にはエラーを返さない。
    if (out.kind === "finished") {
      // 締め切りの alarm は、D1 の再試行か掃除の alarm で上書きする
      await this.attempt("broadcast", () => this.broadcast(out.result));
      if (await this.persistResult(out.result)) await this.armCleanup();
      else await this.schedulePersistRetry();
      return;
    }
    await this.armAlarm(out.kind === "playing" ? out.deadline : out.cleanupAt);
    await this.attempt("broadcast", () => this.broadcast());
    if (out.kind === "playing") {
      // 索引は1手ごとには書かないが、一覧の鮮度の絞り込み（PLAYING_LIST_GRACE_MS）で長い試合が消えないよう、
      // 最後の書き込みから PLAYING_INDEX_REFRESH_MS 経っていれば書き直す（開始時の書き込みは startGame が行う）
      const indexedAt = this.store.indexedAt();
      if (indexedAt !== null && Date.now() - indexedAt >= PLAYING_INDEX_REFRESH_MS) await this.syncIndex();
      await this.runBots();
    }
  }

  /** 投了・時間切れの解決を書く（commit の write の中で呼ぶ）。 */
  private writeResolution(turn: number, r: Resolution): void {
    this.store.saveSnapshot(turn + 1, r.state);
    if (r.forfeit) this.store.setMeta("forfeit", JSON.stringify(r.forfeit));
    if (r.endReason) this.store.setMeta("endReason", r.endReason);
  }

  // ---- 練習相手 ----

  /** 今行動できる練習相手（いなければ null）。 */
  private pendingBot(): string | null {
    if (this.store.status() !== "playing") return null;
    const bots = this.store.bots();
    if (bots.length === 0) return null;
    const pending = this.game().currentPlayers(this.store.loadSnapshot().state);
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
        const snap = this.store.loadSnapshot();
        const pending = game.currentPlayers(snap.state);
        // Bot の乱数はシードと無関係に作る（手はログに残るので再現には不要）
        const pick = practiceAction(game, snap.state, bot, createRng(randomHex(16)));
        if (!pick) return; // 打てる手がなければ持ち時間切れに任せる
        // 人間の手と同じ検証を通す（actionSchema を満たさない手がログに入るとリプレイできなくなる）。
        // ログには検証済み（zod の出力）の手を書く。読み込みから commit まで await を挟まない
        const r = decideAction(game, snap, bot, snap.turn, pick.action, this.store.seed());
        if (!r.ok) {
          console.error(`practice bot ${bot} chose an invalid action: ${r.code} ${r.message}`);
          return; // 持ち時間切れに任せる
        }
        const { action, next } = r.data;
        await this.commit(() => {
          this.store.appendAction(snap.turn, bot, action);
          this.store.saveSnapshot(snap.turn + 1, next);
        }, pending);
      }
    } catch (e) {
      console.error("practice bot failed", e); // 打てなかった練習相手は持ち時間切れで負けになる
    } finally {
      this.botsRunning = false;
    }
  }

  // ---- Alarm の管理 ----

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
      const at = this.wantedAlarm();
      if (at === null || (await this.ctx.storage.getAlarm()) !== null) return;
      // 時刻が過ぎていれば即時発火し、alarm() が時間切れ処理（または D1 再試行・掃除）をする
      await this.armAlarm(at);
    } catch (e) {
      console.error("ensureAlarm failed", e);
    }
  }

  /**
   * 今張っておくべき alarm の時刻。playing なら手番の締め切り、終了後で D1 未書き込みなら今（再試行）、それ以外は掃除。
   * エンジンが無いルームは時間切れを処理できないので掃除だけ（毎回失敗する alarm でリクエストを消費しないように）。
   * D1 の再試行はエンジンを使わない（meta の result）ので、エンジンが無くても続ける。
   */
  private wantedAlarm(): number | null {
    const status = this.store.status();
    if (status === "playing" && this.engine()) return this.store.deadline();
    if (this.persistPending()) return Date.now();
    return this.cleanupDueAt();
  }

  /**
   * 掃除の時刻。playing の間は（待機中に書いた値が残っていても）消さない。ただしエンジンが無いルームは
   * 進めようがないので、終了したルームと同じ期間で消す。
   */
  private cleanupDueAt(): number | null {
    if (this.store.status() === "playing" && this.engine()) return null;
    return this.store.cleanupAt();
  }

  /** 掃除の alarm を張る（D1 への書き込みが済んだか、諦めた後）。 */
  private async armCleanup(): Promise<void> {
    const at = this.store.cleanupAt();
    if (at !== null) await this.armAlarm(at);
  }

  /** 確定後の副作用を実行し、失敗はログに残すだけにする。 */
  private async attempt(what: string, f: () => unknown): Promise<void> {
    try {
      await f();
    } catch (e) {
      console.error(`${what} failed`, e);
    }
  }

  // ---- D1 ----

  /**
   * D1 への書き込み（冪等なので何度再試行してもよい）。
   * 成功（または D1 が無い）なら meta.persisted を立てて true を返す。失敗しても試合は壊さない。
   */
  private async persistResult(result: GameResult): Promise<boolean> {
    try {
      const id = this.store.getMeta("roomId");
      // 練習試合は戦績・試合一覧に載せない（ランダム相手の勝ち数で戦績が水増しされないように）
      if (!id || !this.env.DB || this.store.options().practice) return true;
      // 畳んだルームは索引の行を消してあるので書き直さない（indexStatement はエンジンも使う）
      const index = this.store.getMeta("retired") === "1" ? null : this.indexStatement();
      await this.env.DB.batch([
        ...(index ? [index] : []),
        ...matchStatements(this.env.DB, {
          id,
          game: this.store.gameId()!,
          rulesVersion: this.store.rulesVersion(),
          seed: this.store.seed(),
          gameOptions: this.store.gameOptions(),
          players: this.store.playerUsers(),
          startedAt: Number(this.store.getMeta("startedAt")),
          finishedAt: Number(this.store.getMeta("finishedAt")),
          reason: this.store.endReason(),
          result,
          byForfeit: this.store.forfeit() !== null,
        }),
      ]);
      this.store.setMeta("persisted", "1");
      return true;
    } catch (e) {
      console.error("failed to persist result to D1", e);
      return false;
    }
  }

  /** D1 書き込みの再試行を alarm で予約する（指数バックオフ。終了から PERSIST_RETRY_WINDOW_MS で諦める）。 */
  private async schedulePersistRetry(): Promise<void> {
    const n = Number(this.store.getMeta("persistAttempts") ?? "0");
    const finishedAt = Number(this.store.getMeta("finishedAt") ?? Date.now());
    if (Date.now() - finishedAt > PERSIST_RETRY_WINDOW_MS) {
      console.error(`giving up persisting result of room ${this.store.getMeta("roomId")} after ${n} retries`);
      this.store.setMeta("persistGaveUp", "1");
      await this.armCleanup();
      return;
    }
    this.store.setMeta("persistAttempts", String(n + 1));
    const delay = Math.min(PERSIST_RETRY_BASE_MS * 2 ** n, PERSIST_RETRY_MAX_MS);
    await this.armAlarm(Date.now() + delay);
  }

  /** D1 への書き込みを諦めたか（schedulePersistRetry が期限切れで止めた）。 */
  private persistGaveUp(): boolean {
    return this.store.getMeta("persistGaveUp") === "1";
  }

  /** 終了済みで、D1 への書き込みが済んでおらず、諦めてもいないか。 */
  private persistPending(): boolean {
    return this.store.status() === "finished" && this.store.getMeta("persisted") !== "1" && !this.persistGaveUp();
  }

  /**
   * 終了済みで D1 への書き込みが済んでいなければ再試行する（alarm から呼ぶ）。済んでいれば掃除の alarm を張る。
   * 結果は終了時に meta に保存したものを使うので、エンジンが無くなったルームでも書ける。
   */
  private async retryPersist(): Promise<void> {
    if (!this.persistPending()) return this.armCleanup();
    const result = this.store.result();
    if (!result) {
      console.error(`finished room ${this.store.getMeta("roomId")} has no stored result; giving up persisting`);
      this.store.setMeta("persistGaveUp", "1");
      return this.armCleanup();
    }
    if (await this.persistResult(result)) await this.armCleanup();
    else await this.schedulePersistRetry();
  }

  // ---- 掃除 ----

  /**
   * ルームを消す（DO のストレージをすべて消し、以後は ROOM_NOT_FOUND）。D1 の matches・results は残す。
   * ストレージの削除を先に行う（ストレージ操作の間は他のイベントが入らないので、削除の途中で join などが割り込まない）。
   * 一覧の索引（rooms）の行はその後で消す。失敗しても残るのは waiting / finished の古い行で、一覧・クイックマッチには出ない。
   */
  private async cleanup(): Promise<void> {
    const id = this.store.getMeta("roomId");
    const indexed = this.store.getMeta("indexRev") !== null;
    this.closeAll(CLOSE_ROOM_DELETED, "room deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.store = new RoomStore(this.ctx.storage.sql); // テーブルが無い状態として読み直す
    if (id && indexed && this.env.DB) {
      await this.attempt("delete room index", () => this.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run());
    }
  }

  /**
   * 一覧用の索引（D1 の rooms）を今の状態で上書きする文。一覧に載せないルームや D1 が無いときは null。
   * rev は呼ぶたびに増える（同期処理の中で状態と一緒に読むので、後の rev ほど新しい状態）。
   */
  private indexStatement(): D1PreparedStatement | null {
    const opts = this.store.options();
    const id = this.store.getMeta("roomId");
    // 再戦ルームは決まったメンバーしか入れないので載せない
    if (!id || !this.env.DB || opts.unlisted || opts.practice || this.store.reservedSeats()) return null;
    const rev = Number(this.store.getMeta("indexRev") ?? "0") + 1;
    const now = Date.now();
    this.store.setMeta("indexRev", String(rev));
    this.store.setMeta("indexedAt", String(now));
    const game = this.game();
    return roomIndexStatement(this.env.DB, {
      id,
      game: game.id,
      gameOptions: this.store.gameOptions(),
      status: this.store.status(),
      players: this.store.playerIds().length,
      maxPlayers: game.maxPlayers,
      autoStart: opts.autoStart ?? false,
      turnTimeMs: opts.turnTimeMs ?? DEFAULT_TURN_TIME_MS,
      createdAt: Number(this.store.getMeta("createdAt") ?? Date.now()),
      updatedAt: now,
      rev,
    });
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

  // ---- RPC ----

  /**
   * ルーム作成。同じ ID で2回呼ぶと 409。開始権限を持つ hostToken を返す。
   * reserved（再戦用。元のルームのプレイヤー ID → 席 ID）を渡すと、その席は joinReserved でしか埋まらず、
   * 全席が埋まった時点で開始する。roomOptions には入れない（POST /rooms から誰でも指定できてしまうため）。
   * gameOptions はゲーム固有のオプション。ゲームの optionsSchema で検証し、既定値を補った値を保存する。
   */
  async init(
    roomId: string,
    gameId: string,
    options: unknown,
    gameOptions: unknown = undefined,
    reserved: Record<string, string> | null = null,
  ): Promise<RoomResult<{ game: string; hostToken: string }>> {
    // ハッシュは exists() の確認より前に取る（確認から transactionSync まで await を挟むと、
    // 再戦で同時に呼ばれた init が両方とも確認を通り、hostTokenHash を上書きし合う）
    const hostToken = newToken();
    const hostTokenHash = await sha256Hex(hostToken);
    if (this.store.exists()) return fail(409, "ROOM_EXISTS", "room already exists");
    const game = getGame(gameId);
    if (!game) return fail(400, "UNKNOWN_GAME", `unknown game: ${gameId}`);
    const opts = roomOptions.safeParse(options ?? {});
    if (!opts.success) return fail(400, "BAD_REQUEST", "invalid options");
    const gopts = parseGameOptions(game, gameOptions);
    if (!gopts.ok) return fail(400, "BAD_REQUEST", gopts.message);
    this.ctx.storage.transactionSync(() => {
      const s = this.store;
      s.createTables();
      s.setMeta("roomId", roomId);
      s.setMeta("gameId", gameId);
      // gameOptions を検証したエンジンの版。開始時ではなくここで記録する（待機中に版が上がったら、古い版で
      // 検証した gameOptions のまま新しい init で始めず GAME_REMOVED にする）
      s.setMeta("rulesVersion", String(game.rulesVersion));
      s.setMeta("options", JSON.stringify(opts.data));
      s.setMeta("gameOptions", JSON.stringify(gopts.value));
      s.setMeta("hostTokenHash", hostTokenHash);
      s.setMeta("status", "waiting");
      s.setMeta("createdAt", String(Date.now()));
      s.setMeta("cleanupAt", String(Date.now() + WAITING_ROOM_TTL_MS));
      // 再戦ルームでは、練習相手などの追加の席は予約席の後ろから
      s.setMeta("nextSeat", String(reserved ? Object.keys(reserved).length + 1 : 1));
      if (reserved) s.setMeta("reserved", JSON.stringify(reserved));
    });
    await this.armCleanup();
    await this.syncIndex();
    return ok({ game: gameId, hostToken });
  }

  /** 参加。プレイヤー ID は参加順に p1, p2, ...（退出した席の番号は再利用しない） */
  async join(userId: string | null = null): Promise<RoomResult<{ playerId: string; token: string }>> {
    const token = newToken();
    const tokenHash = await sha256Hex(token); // 状態を読む前に（ここから commit まで await を挟まない）
    const bad = this.check();
    if (bad) return this.reject(bad);
    if (this.store.reservedSeats()) return fail(403, "ROOM_RESERVED", "this room is reserved for a rematch");
    if (this.store.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");
    const n = this.store.playerIds().length;
    const { maxPlayers } = this.game();
    if (n >= maxPlayers) return fail(409, "ROOM_FULL", "room is full");
    // 同じユーザーが複数の席に座ると、自分どうしの対戦で戦績を水増しできる（API キー無しの参加は対象外）
    if (userId !== null && this.store.hasUser(userId)) {
      return fail(409, "ALREADY_JOINED", "this user already has a seat in this room");
    }
    let playerId = "";
    await this.commit(() => {
      const seat = this.store.allocateSeat();
      playerId = seat.id;
      this.store.addPlayer(seat.id, tokenHash, seat.seq, userId);
    });
    // autoStart：満席になったらその場で開始する（ホストの start と競合しても startGame が status を見て1回だけ開始する）
    if (this.store.options().autoStart && n + 1 >= maxPlayers) await this.startGame();
    else await this.syncIndex();
    return ok({ playerId, token });
  }

  /**
   * 再戦ルームの予約席に座る（元のルームの rematch から呼ぶ。origin は元のルームでのプレイヤー ID）。
   * token は元のルームが元のトークンから導出した席のトークン（rematchToken）。同じ origin なら毎回同じ値が来るので、
   * 何度呼んでも（退出した後でも）同じ席・同じトークンになる（ここではハッシュしか保存しない）。予約席が全部埋まったら開始する。
   */
  async joinReserved(
    origin: string,
    userId: string | null,
    token: string,
  ): Promise<RoomResult<{ playerId: string; token: string }>> {
    const tokenHash = await sha256Hex(token); // 状態を読む前に
    const bad = this.check();
    if (bad) return this.reject(bad);
    const reserved = this.store.reservedSeats();
    const seat = reserved?.[origin];
    if (!reserved || !seat) return fail(403, "ROOM_RESERVED", "no seat is reserved for this player");
    const existing = this.store.tokenHashOf(seat);
    if (existing) {
      return existing === tokenHash
        ? ok({ playerId: seat, token })
        : fail(403, "ROOM_RESERVED", "this seat is taken with another token");
    }
    if (this.store.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");
    await this.commit(() => {
      this.store.addPlayer(seat, tokenHash, Number(seat.slice(1)) - 1, userId);
    });
    if (this.store.playerIds().length >= Object.keys(reserved).length) await this.startGame();
    return ok({ playerId: seat, token });
  }

  /**
   * 待機中のルームから退出する（join の取り消し）。席は空き、トークンは無効になり、その席の WS は閉じる。
   * 再戦ルームでは席は予約されたまま（元のルームの rematch をもう一度呼べば座り直せる）。返すのは観戦視点。
   */
  async leave(token: string | null): Promise<RoomResult<RoomState>> {
    const tokenHash = await hashToken(token);
    const bad = this.check();
    if (bad) return this.reject(bad);
    const pid = this.store.playerByTokenHash(tokenHash);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    if (this.store.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started (resign instead)");
    // ここから commit まで await を挟まない（start と入れ替わらない）
    await this.commit(() => this.store.removePlayer(pid));
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
   * 最初の呼び出しでルームを作り、席順をそこで決める（rematchSeats）。ゲームのオプションも引き継ぐ。
   * 呼んだプレイヤーはその場で自分の席に座る。全員が呼んだら開始する（練習相手の席は開始時に埋まる）。
   * 同じプレイヤーが何度呼んでも同じ { roomId, playerId, token } が返る。
   */
  async rematch(token: string | null): Promise<RoomResult<{ roomId: string; playerId: string; token: string }>> {
    const tokenHash = await hashToken(token);
    const bad = this.check();
    if (bad) return this.reject(bad);
    const pid = this.store.playerByTokenHash(tokenHash);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    if (this.store.status() !== "finished") return fail(403, "NOT_FINISHED", "rematch is available after the game has finished");

    // 新しいルームの ID は await の前に確定させる（同時に呼ばれても1つしか作らない）
    let roomId = this.store.getMeta("rematchRoomId");
    if (!roomId) {
      roomId = newRoomId();
      this.store.setMeta("rematchRoomId", roomId);
    }
    const stub = this.env.GAME_ROOM.getByName(roomId);
    const createRoom = async (): Promise<RoomError | null> => {
      const bots = this.store.bots();
      const reserved = rematchSeats(this.store.playerIds().filter((p) => !bots.includes(p)));
      const init = await stub.init(roomId, this.store.gameId()!, this.store.options(), this.store.gameOptions(), reserved);
      // ROOM_EXISTS は、同時に呼ばれたもう一方が作り終えたということ
      if (!init.ok && init.code !== "ROOM_EXISTS") return init;
      this.store.setMeta("rematchReady", "1");
      return null;
    };
    if (this.store.getMeta("rematchReady") !== "1") {
      const e = await createRoom();
      if (e) return e;
    }
    const seatToken = await rematchToken(token!, roomId);
    let seat = await stub.joinReserved(pid, this.store.userOf(pid), seatToken);
    if (!seat.ok && seat.code === "ROOM_NOT_FOUND") {
      // 再戦ルームが誰も来ないまま掃除された。同じ ID で作り直す（申し込みも数え直す）
      this.store.setMeta("rematchRequested", "[]");
      const e = await createRoom();
      if (e) return e;
      seat = await stub.joinReserved(pid, this.store.userOf(pid), seatToken);
    }
    if (!seat.ok) return seat;

    const requested = this.store.rematchInfo()?.requestedBy ?? [];
    if (!requested.includes(pid)) {
      this.store.setMeta("rematchRequested", JSON.stringify([...requested, pid]));
      // 終了済みのルームの接続に再戦の申し込みを知らせる（end は送り直さない）
      await this.attempt("broadcast", () => this.broadcast());
    }
    return ok({ roomId, ...seat.data });
  }

  /** 試合開始（作成者 = POST /rooms で受け取った hostToken を持つ者のみ）。返すのは観戦視点。 */
  async start(token: string | null): Promise<RoomResult<RoomState>> {
    const tokenHash = await hashToken(token);
    const bad = this.check();
    if (bad) return this.reject(bad);
    if (!tokenHash) return fail(401, "UNAUTHORIZED", "host token required");
    if (tokenHash !== this.store.getMeta("hostTokenHash")) {
      return this.store.playerByTokenHash(tokenHash)
        ? fail(403, "NOT_HOST", "only the room creator can start the game")
        : fail(401, "UNAUTHORIZED", "invalid token");
    }
    return this.startGame();
  }

  /** 開始処理の本体（認証済みの start と autoStart から呼ぶ）。返すのは観戦視点。 */
  private async startGame(): Promise<RoomResult<RoomState>> {
    if (this.store.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");

    const game = this.game();
    const joined = this.store.playerIds().length;
    const botCount = practiceBotCount(game, joined, this.store.options().practice ?? false);
    if (joined + botCount < game.minPlayers) {
      return fail(409, "NOT_ENOUGH_PLAYERS", `need at least ${game.minPlayers} players`);
    }
    const seed: Seed = randomHex(16); // 128 ビット。総当たりで特定されないように
    await this.commit(() => {
      const s = this.store;
      // 練習相手は参加者の後ろの空席（minPlayers まで）に座る
      const botIds = Array.from({ length: botCount }, () => {
        const seat = s.allocateSeat();
        // どのトークンのハッシュとも一致しない値を入れる（練習相手の席には外から行動できない）
        s.addPlayer(seat.id, `bot:${randomHex(16)}`, seat.seq, null);
        return seat.id;
      });
      if (botIds.length) s.setMeta("bots", JSON.stringify(botIds));
      s.setMeta("seed", String(seed));
      s.setMeta("startedAt", String(Date.now()));
      s.deleteMeta("cleanupAt"); // 試合中は消さない（決着すると終了時から数え直す）
      s.saveSnapshot(0, game.init(s.playerIds(), seed, s.gameOptions()));
      s.setMeta("status", "playing");
    });
    await this.syncIndex();
    return ok(this.buildState(null));
  }

  /** 状態取得。token があればそのプレイヤー視点、なければ観戦視点。 */
  async getState(token: string | null): Promise<RoomResult<RoomState>> {
    const tokenHash = await hashToken(token);
    const bad = this.check();
    if (bad) return this.reject(bad);
    await this.ensureAlarm();
    let pid: string | null = null;
    if (tokenHash) {
      pid = this.store.playerByTokenHash(tokenHash);
      if (!pid) return fail(401, "UNAUTHORIZED", "invalid token");
    }
    return ok(this.buildState(pid));
  }

  /** REST の行動。turn が現在のターンと一致しなければ STALE_TURN。 */
  async act(token: string | null, turn: number, rawAction: unknown): Promise<RoomResult<RoomState>> {
    const tokenHash = await hashToken(token);
    const bad = this.check();
    if (bad) return this.reject(bad);
    const pid = this.store.playerByTokenHash(tokenHash);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    const r = await this.actAs(pid, turn, rawAction);
    return r.ok ? ok(this.buildState(pid)) : r;
  }

  /** REST の投了。 */
  async resign(token: string | null): Promise<RoomResult<RoomState>> {
    const tokenHash = await hashToken(token);
    const bad = this.check();
    if (bad) return this.reject(bad);
    const pid = this.store.playerByTokenHash(tokenHash);
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
    if (this.store.status() !== "playing") return fail(409, "NOT_PLAYING", "game is not in progress");
    // 締め切りを過ぎていれば先に時間切れを確定させる（それで決着したら投了は不要）
    if (this.deadlinePassed()) {
      await this.resolveTimeout();
      if (this.store.status() !== "playing") return fail(409, "NOT_PLAYING", "game is not in progress");
    }
    // ここから commit まで await を挟まない
    const game = this.game();
    const snap = this.store.loadSnapshot();
    const r = decideResign(game, snap, pid, this.store.playerIds(), this.store.seed());
    if (!r.ok) return r;
    await this.commit(() => {
      this.store.appendSystem(snap.turn, { $resign: pid });
      this.writeResolution(snap.turn, r.data);
    }, game.currentPlayers(snap.state));
    return ok(null);
  }

  /** REST / WS 共通の行動処理。存在するルームで、認証済みの playerId（観戦者は null）を受け取る。 */
  private async actAs(pid: string | null, turn: number, rawAction: unknown): Promise<RoomResult<null>> {
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    await this.ensureAlarm(); // 行動が拒否される場合（STALE_TURN など）でも締め切りを取り戻す
    if (this.store.status() !== "playing") return fail(409, "NOT_PLAYING", "game is not in progress");
    // 締め切りを過ぎた手は受け付けない。Alarm の発火を待たずにこの場で時間切れを確定させる
    // （ここから commit まで await を挟まないので、時間切れ処理と行動が入れ替わることはない）。
    if (this.deadlinePassed()) {
      await this.resolveTimeout();
      return fail(409, "STALE_TURN", "time is up; the turn was resolved by timeout");
    }
    const game = this.game();
    const snap = this.store.loadSnapshot();
    const r = decideAction(game, snap, pid, turn, rawAction, this.store.seed());
    if (!r.ok) return r;
    // ログ追記・スナップショット・締め切りは commit 内の1トランザクションで確定する
    await this.commit(() => {
      this.store.appendAction(snap.turn, pid, r.data.action);
      this.store.saveSnapshot(snap.turn + 1, r.data.next);
    }, game.currentPlayers(snap.state));
    return ok(null);
  }

  /** 行動ログ。シードから隠し情報が推測されないよう、終了後のみ公開する。 */
  async getLog(): Promise<RoomResult<ReplayLog>> {
    const gameId = this.store.gameId();
    if (gameId === null) return NOT_FOUND;
    if (this.store.status() !== "finished") {
      return fail(403, "NOT_FINISHED", "log is available after the game has finished");
    }
    let actions: LogEntry[];
    try {
      actions = this.store.readLog();
    } catch (e) {
      // DO から例外を投げると workerd が uncaught exception として別に出すので、ここで記録して 500 で返す
      console.error("failed to read action log", e);
      return fail(500, "INTERNAL", "internal error");
    }
    return ok({
      game: gameId,
      rulesVersion: this.store.rulesVersion(),
      seed: this.store.seed(),
      gameOptions: this.store.gameOptions(),
      players: this.store.playerIds(),
      actions,
    });
  }

  /** ログから再現した各ターンの観戦視点。終了後のみ。 */
  async getReplay(): Promise<RoomResult<ReplayFrames>> {
    const log = await this.getLog();
    if (!log.ok) return log;
    // 記録した版のエンジンでだけ再生する（今の版で古いログを再生すると、別の試合が再現されたり例外になったりする）。
    // ルールの版が上がっていれば断る。ログ自体（/log）は正しい記録なので返し続ける。
    const bad = this.check();
    if (bad) return this.reject(bad);
    const game = this.game();
    const { frames, result } = replayFrames(game, log.data);
    return ok({
      game: game.id,
      rulesVersion: log.data.rulesVersion,
      seed: log.data.seed,
      gameOptions: log.data.gameOptions,
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
    const auth = extractWsAuth(request);
    const tokenHash = auth.ok ? await hashToken(auth.token) : null;
    const bad = this.check();
    if (bad) {
      await this.reject(bad);
      return error(bad.status, bad.code, bad.message);
    }
    await this.ensureAlarm();
    if (!auth.ok) return error(400, "BAD_REQUEST", auth.message);
    let pid: string | null = null;
    if (tokenHash) {
      pid = this.store.playerByTokenHash(tokenHash);
      if (!pid) return error(401, "UNAUTHORIZED", "invalid token");
    }

    // 接続数の制限（接続1本 = 1リクエスト。拒否してもこの呼び出しの分は数えられるが、配信先が際限なく増えるのを防ぐ）。
    // 観戦は認証なしで張れるので上限で拒否する。席は本人しか張れないので、拒否せずいちばん古い接続を閉じる
    // （死んだことに気づいていない古い接続が残っていても、再接続が通るように）
    if (!pid && this.ctx.getWebSockets(SPECTATOR_TAG).length >= MAX_SPECTATOR_SOCKETS) {
      return error(503, "TOO_MANY_CONNECTIONS", `this room already has ${MAX_SPECTATOR_SOCKETS} spectators`);
    }
    if (pid) this.evictOldSockets(pid);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API。server.accept() は使わない
    this.ctx.acceptWebSocket(server, [pid ? seatTag(pid) : SPECTATOR_TAG]);
    const now = Date.now();
    const base = { protocol: auth.protocol, at: now, strikes: 0, strikeAt: now };
    server.serializeAttachment(
      (pid ? { playerId: pid, tokenHash: tokenHash!, ...base } : { playerId: null, ...base }) satisfies Attachment,
    );

    const s = this.buildState(pid);
    this.send(server, stateMessage(s));
    if (s.status === "finished" && s.result) this.send(server, endMessage(s.result, this.store.endReason()));
    // 応答で選ぶのはトークンを含まない版のサブプロトコル（トークンを応答ヘッダーに載せない）
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": auth.protocol } });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof message !== "string") {
        return this.sendError(ws, "BAD_REQUEST", "text frames only");
      }
      let json: unknown;
      try {
        json = JSON.parse(message);
      } catch {
        return this.sendError(ws, "BAD_REQUEST", "invalid JSON");
      }
      const msg = clientMessage.safeParse(json);
      if (!msg.success) {
        return this.sendError(ws, "BAD_REQUEST", "invalid message");
      }
      if (msg.data.type === "ping") {
        // 自動応答（setWebSocketAutoResponse）と文字列が一致しない ping だけがここに来る。DO を起こしているので数える
        this.send(ws, { type: "pong" });
        return this.strike(ws);
      }

      const bad = this.check();
      if (bad) {
        // エラーを送ってから閉じる（retire が全接続を閉じる）
        this.send(ws, { type: "error", code: bad.code, message: bad.message });
        await this.reject(bad);
        return;
      }
      const pid = this.socketPlayer(ws, this.store.seatTokenHashes());
      const r = msg.data.type === "resign" ? await this.resignAs(pid) : await this.actAs(pid, msg.data.turn, msg.data.action);
      // REST と同じコードをそのまま返す（読み替えると、観戦者なのか手番でないのかが区別できなくなる）
      if (!r.ok) this.sendError(ws, r.code, r.message);
      // 成功時の state は commit の broadcast で全員に届く
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
    if (!this.store.exists()) return;
    const cleanupAt = this.cleanupDueAt();
    if (cleanupAt !== null && Date.now() >= cleanupAt) return this.cleanup();
    // D1 への書き込みの再試行はエンジンを使わないので、エンジンが無くなっていても先に済ませる（戦績を失わないように）
    if (this.store.status() === "finished") {
      if (!this.engine()) await this.retire();
      return this.retryPersist();
    }
    if (!this.engine()) {
      // 例外にすると alarm が再試行され続ける（1回 = 1リクエスト）ので、畳んで掃除だけ予約する
      await this.retire();
      await this.armCleanup(); // 畳み済みでも、早すぎた alarm なら掃除の時刻で張り直す
      return;
    }
    const status = this.store.status();
    if (status !== "playing") {
      // 早すぎた（待機中に更新された）掃除の alarm。今の時刻で張り直す
      if (cleanupAt !== null) await this.armAlarm(cleanupAt);
      return;
    }
    // 練習相手の続き（runBots が1回の上限に達して張った alarm）
    if (this.pendingBot() && !this.deadlinePassed()) {
      await this.runBots();
      // 打てずに抜けた（例外・打てる手なし）ときも、締め切りの alarm を失わないようにする
      await this.ensureAlarm();
      return;
    }
    const deadline = this.store.deadline();
    // 古い alarm の誤発火ガード: 締め切りがまだ先なら張り直すだけ
    if (deadline !== null && Date.now() < deadline) {
      await this.armAlarm(deadline);
      return;
    }
    await this.resolveTimeout();
  }

  /** playing で、現在の手番の締め切りを過ぎているか。 */
  private deadlinePassed(): boolean {
    const d = this.store.deadline();
    return d !== null && Date.now() >= d;
  }

  /** 現在の手番を時間切れとして確定する（alarm と、締め切り後に届いた行動の両方から呼ぶ）。 */
  private async resolveTimeout(): Promise<void> {
    const snap = this.store.loadSnapshot();
    const { pending, resolution } = decideTimeout(this.game(), snap, this.store.playerIds(), this.store.seed());
    await this.commit(() => {
      this.store.appendSystem(snap.turn, { $timeout: pending });
      this.writeResolution(snap.turn, resolution);
    });
  }
}
