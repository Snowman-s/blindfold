import { DurableObject } from "cloudflare:workers";
import { getGame } from "../games/registry";
import type { AnyGame, GameResult } from "../games/types";
import { extractWsAuth, newRoomId, newToken, randomHex } from "../lib/auth";
import { DEFAULT_TURN_TIME_MS, parseGameOptions, roomOptions } from "../lib/options";
import { clientMessage, CLOSE_LEFT_ROOM, errBody, type RoomState, type ServerMessage } from "../lib/protocol";
import { replayFrames, type LogEntry, type ReplayLog } from "../lib/replay";
import { practiceAction } from "../lib/practice";
import { createRng, rngForTurn, type Seed } from "../lib/rng";
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
 * WS に持たせる情報。token は接続時に使ったトークン（サーバー内にだけ保存され、クライアントには送らない）。
 * 再戦ルームでは退出した席に同じ ID で座り直せるので、ID だけでなくトークンも一致する接続だけをその席として扱う。
 * protocol は交渉したサブプロトコル（apigames.v1 など）。版ごとに配信を変えるときに使う。
 */
type Attachment = { playerId: null; protocol: string } | { playerId: string; token: string; protocol: string };

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
   * このルームのエンジン。開始後は記録した rulesVersion と今の版が一致するときだけ返す（古い state を新しいルールで
   * 動かさない）。waiting の間は今の版（開始時にその版を記録する）。無ければ null（GAME_REMOVED）。
   */
  private engine(): AnyGame | null {
    return getGame(this.store.gameId()!, this.store.rulesVersion() ?? undefined) ?? null;
  }

  /** check() を通った後で使う。 */
  private game(): AnyGame {
    const g = this.engine();
    if (!g) throw new Error(`engine for ${this.store.gameId()} is not available`);
    return g;
  }

  /** RPC の入口で呼ぶ：ルームが無ければ ROOM_NOT_FOUND、エンジンが無ければ GAME_REMOVED。 */
  private check(): RoomError | null {
    if (!this.store.exists()) return NOT_FOUND;
    if (this.engine()) return null;
    return gameRemoved(this.store.gameId()!, this.store.rulesVersion());
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
    if (status === "waiting") {
      return {
        game, status, rulesVersion: null, gameOptions, players, snap: null, currentPlayers: [], deadline: null, result: null, rematch: null,
      };
    }
    const snap = this.store.loadSnapshot();
    return {
      game,
      status,
      rulesVersion: this.store.rulesVersion(),
      gameOptions,
      players,
      snap,
      currentPlayers: status === "playing" ? game.currentPlayers(snap.state) : [],
      deadline: this.deadline(),
      result: this.resultNow(game, snap.state),
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
  private socketPlayer(ws: WebSocket, seats: Map<string, string>): string | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.playerId === null) return null;
    return att.token === seats.get(att.playerId) ? att.playerId : null;
  }

  /**
   * 全接続に、その接続の視点の view を配る（end があれば続けて end も）。
   * 共通部分は1回だけ読み、同じ視点の接続（観戦者どうしなど）はメッセージを使い回す。
   */
  private broadcast(end?: GameResult): void {
    const core = this.loadCore();
    const now = Date.now();
    const seats = this.store.seatTokens();
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
      if (this.store.status() === "waiting") return { kind: "waiting" };
      const { state } = this.store.loadSnapshot();
      const game = this.game();
      const result = this.resultNow(game, state);
      if (result) {
        this.store.setMeta("status", "finished");
        this.store.setMeta("finishedAt", String(Date.now()));
        return { kind: "finished", result };
      }
      const turnTimeMs = this.store.options().turnTimeMs ?? DEFAULT_TURN_TIME_MS;
      const deadline = nextDeadline(prev, prevDeadline, game.currentPlayers(state), Date.now(), turnTimeMs);
      this.store.setMeta("deadline", String(deadline));
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
        // 読み込みから commit まで await を挟まない（他の行動と入れ替わらない）
        const next = game.apply(snap.state, bot, pick.action, rngForTurn(this.store.seed(), snap.turn));
        await this.commit(() => {
          this.store.appendAction(snap.turn, bot, pick.action);
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
      // エンジンが無いルームでは張らない（alarm が毎回失敗して再試行のたびにリクエストを消費しないように）
      if (!this.engine()) return;
      const status = this.store.status();
      const deadline = this.store.deadline();
      const needsAlarm =
        (status === "playing" && deadline !== null) ||
        (status === "finished" && this.store.getMeta("persisted") !== "1" && this.store.getMeta("roomId") !== null);
      if (!needsAlarm || (await this.ctx.storage.getAlarm()) !== null) return;
      // 締め切りが過ぎていれば即時発火し、alarm() が時間切れ処理（または D1 再試行）をする
      await this.armAlarm(status === "playing" ? deadline! : Date.now());
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
      const index = this.indexStatement();
      await this.env.DB.batch([
        ...(index ? [index] : []),
        ...matchStatements(this.env.DB, {
          id,
          game: this.store.gameId()!,
          rulesVersion: this.store.rulesVersion()!,
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
      return;
    }
    this.store.setMeta("persistAttempts", String(n + 1));
    const delay = Math.min(PERSIST_RETRY_BASE_MS * 2 ** n, PERSIST_RETRY_MAX_MS);
    await this.armAlarm(Date.now() + delay);
  }

  /** 終了済みで D1 への書き込みが済んでいなければ再試行する（alarm から呼ぶ）。 */
  private async retryPersist(): Promise<void> {
    if (this.store.getMeta("persisted") === "1") return;
    const result = this.resultNow(this.game(), this.store.loadSnapshot().state);
    if (!result) return;
    if (!(await this.persistResult(result))) await this.schedulePersistRetry();
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
    this.store.setMeta("indexRev", String(rev));
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
      updatedAt: Date.now(),
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
    if (this.store.exists()) return fail(409, "ROOM_EXISTS", "room already exists");
    const game = getGame(gameId);
    if (!game) return fail(400, "UNKNOWN_GAME", `unknown game: ${gameId}`);
    const opts = roomOptions.safeParse(options ?? {});
    if (!opts.success) return fail(400, "BAD_REQUEST", "invalid options");
    const gopts = parseGameOptions(game, gameOptions);
    if (!gopts.ok) return fail(400, "BAD_REQUEST", gopts.message);
    const hostToken = newToken();
    this.ctx.storage.transactionSync(() => {
      const s = this.store;
      s.createTables();
      s.setMeta("roomId", roomId);
      s.setMeta("gameId", gameId);
      s.setMeta("options", JSON.stringify(opts.data));
      s.setMeta("gameOptions", JSON.stringify(gopts.value));
      s.setMeta("hostToken", hostToken);
      s.setMeta("status", "waiting");
      s.setMeta("createdAt", String(Date.now()));
      // 再戦ルームでは、練習相手などの追加の席は予約席の後ろから
      s.setMeta("nextSeat", String(reserved ? Object.keys(reserved).length + 1 : 1));
      if (reserved) s.setMeta("reserved", JSON.stringify(reserved));
    });
    await this.syncIndex();
    return ok({ game: gameId, hostToken });
  }

  /** 参加。プレイヤー ID は参加順に p1, p2, ...（退出した席の番号は再利用しない） */
  async join(userId: string | null = null): Promise<RoomResult<{ playerId: string; token: string }>> {
    const bad = this.check();
    if (bad) return bad;
    if (this.store.reservedSeats()) return fail(403, "ROOM_RESERVED", "this room is reserved for a rematch");
    if (this.store.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");
    const n = this.store.playerIds().length;
    const { maxPlayers } = this.game();
    if (n >= maxPlayers) return fail(409, "ROOM_FULL", "room is full");
    const token = newToken();
    let playerId = "";
    await this.commit(() => {
      const seat = this.store.allocateSeat();
      playerId = seat.id;
      this.store.addPlayer(seat.id, token, seat.seq, userId);
    });
    // autoStart：満席になったらその場で開始する（ホストの start と競合しても startGame が status を見て1回だけ開始する）
    if (this.store.options().autoStart && n + 1 >= maxPlayers) await this.startGame();
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
    const bad = this.check();
    if (bad) return bad;
    const reserved = this.store.reservedSeats();
    const seat = reserved?.[origin];
    if (!reserved || !seat) return fail(403, "ROOM_RESERVED", "no seat is reserved for this player");
    const existing = this.store.tokenOf(seat);
    if (existing) return ok({ playerId: seat, token: existing });
    if (this.store.status() !== "waiting") return fail(409, "ALREADY_STARTED", "game already started");
    const token = newToken();
    await this.commit(() => {
      this.store.addPlayer(seat, token, Number(seat.slice(1)) - 1, userId);
    });
    if (this.store.playerIds().length >= Object.keys(reserved).length) await this.startGame();
    return ok({ playerId: seat, token });
  }

  /**
   * 待機中のルームから退出する（join の取り消し）。席は空き、トークンは無効になり、その席の WS は閉じる。
   * 再戦ルームでは席は予約されたまま（元のルームの rematch をもう一度呼べば座り直せる）。返すのは観戦視点。
   */
  async leave(token: string | null): Promise<RoomResult<RoomState>> {
    const bad = this.check();
    if (bad) return bad;
    const pid = this.store.playerByToken(token);
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
    const bad = this.check();
    if (bad) return bad;
    const pid = this.store.playerByToken(token);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    if (this.store.status() !== "finished") return fail(403, "NOT_FINISHED", "rematch is available after the game has finished");

    // 新しいルームの ID は await の前に確定させる（同時に呼ばれても1つしか作らない）
    let roomId = this.store.getMeta("rematchRoomId");
    if (!roomId) {
      roomId = newRoomId();
      this.store.setMeta("rematchRoomId", roomId);
    }
    const stub = this.env.GAME_ROOM.getByName(roomId);
    if (this.store.getMeta("rematchReady") !== "1") {
      const bots = this.store.bots();
      const reserved = rematchSeats(this.store.playerIds().filter((p) => !bots.includes(p)));
      const init = await stub.init(roomId, this.store.gameId()!, this.store.options(), this.store.gameOptions(), reserved);
      // ROOM_EXISTS は、同時に呼ばれたもう一方が作り終えたということ
      if (!init.ok && init.code !== "ROOM_EXISTS") return init;
      this.store.setMeta("rematchReady", "1");
    }
    const seat = await stub.joinReserved(pid, this.store.userOf(pid));
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
    const bad = this.check();
    if (bad) return bad;
    if (!token) return fail(401, "UNAUTHORIZED", "host token required");
    if (token !== this.store.getMeta("hostToken")) {
      return this.store.playerByToken(token)
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
        // トークンは誰にも渡さない（練習相手の席には外から行動できない）
        s.addPlayer(seat.id, newToken(), seat.seq, null);
        return seat.id;
      });
      if (botIds.length) s.setMeta("bots", JSON.stringify(botIds));
      s.setMeta("seed", String(seed));
      // init と同じトランザクションで記録する（この版のエンジンで始めた、という記録なので）
      s.setMeta("rulesVersion", String(game.rulesVersion));
      s.setMeta("startedAt", String(Date.now()));
      s.saveSnapshot(0, game.init(s.playerIds(), seed, s.gameOptions()));
      s.setMeta("status", "playing");
    });
    await this.syncIndex();
    return ok(this.buildState(null));
  }

  /** 状態取得。token があればそのプレイヤー視点、なければ観戦視点。 */
  async getState(token: string | null): Promise<RoomResult<RoomState>> {
    const bad = this.check();
    if (bad) return bad;
    await this.ensureAlarm();
    let pid: string | null = null;
    if (token) {
      pid = this.store.playerByToken(token);
      if (!pid) return fail(401, "UNAUTHORIZED", "invalid token");
    }
    return ok(this.buildState(pid));
  }

  /** REST の行動。turn が現在のターンと一致しなければ STALE_TURN。 */
  async act(token: string | null, turn: number, rawAction: unknown): Promise<RoomResult<RoomState>> {
    const bad = this.check();
    if (bad) return bad;
    const pid = this.store.playerByToken(token);
    if (!pid) return fail(401, "UNAUTHORIZED", "valid player token required");
    const r = await this.actAs(pid, turn, rawAction);
    return r.ok ? ok(this.buildState(pid)) : r;
  }

  /** REST の投了。 */
  async resign(token: string | null): Promise<RoomResult<RoomState>> {
    const bad = this.check();
    if (bad) return bad;
    const pid = this.store.playerByToken(token);
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
      rulesVersion: this.store.rulesVersion()!,
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
    if (bad) return bad;
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
    const bad = this.check();
    if (bad) return error(bad.status, bad.code, bad.message);
    await this.ensureAlarm();
    const auth = extractWsAuth(request);
    if (!auth.ok) return error(400, "BAD_REQUEST", auth.message);
    let pid: string | null = null;
    if (auth.token) {
      pid = this.store.playerByToken(auth.token);
      if (!pid) return error(401, "UNAUTHORIZED", "invalid token");
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // Hibernation API。server.accept() は使わない
    server.serializeAttachment(
      (pid
        ? { playerId: pid, token: auth.token!, protocol: auth.protocol }
        : { playerId: null, protocol: auth.protocol }) satisfies Attachment,
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

      const pid = this.socketPlayer(ws, this.store.seatTokens());
      const r =
        this.check() ??
        (msg.data.type === "resign" ? await this.resignAs(pid) : await this.actAs(pid, msg.data.turn, msg.data.action));
      // REST と同じコードをそのまま返す（読み替えると、観戦者なのか手番でないのかが区別できなくなる）
      if (!r.ok) this.send(ws, { type: "error", code: r.code, message: r.message });
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
    if (!this.engine()) {
      // 例外にすると alarm が再試行され続ける（1回 = 1リクエスト）ので、記録して止める
      console.error(`alarm skipped: ${this.check()?.message}`);
      return;
    }
    const status = this.store.status();
    if (status === "finished") return this.retryPersist();
    if (status !== "playing") return;
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
