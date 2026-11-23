import { GameError, type AnyGame, type GameResult } from "../games/types";
import type { EndReason, LastEvent, RematchInfo, RoomState, RoomStatus, ServerMessage } from "../lib/protocol";
import { applyResign, applyTimeout } from "../lib/replay";
import { FINISHED_ROOM_TTL_MS, WAITING_ROOM_TTL_MS, type RoomOptions } from "../lib/options";
import { rngForTurn, type Seed } from "../lib/rng";
import { sameSimultaneousTurn } from "../lib/turns";

/**
 * GameRoom の状態遷移と、配る状態の組み立て（純粋関数）。
 * ストレージ（store.ts）・D1（d1.ts）・alarm・配信には触らない。時刻も引数で受け取る。
 * GameRoom（DO）はここで決めた結果を1トランザクションで書き、その後で副作用を行う。
 */

export type RoomError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 410 | 500;
  code: string;
  message: string;
};
export type RoomResult<T> = { ok: true; data: T } | RoomError;

export const fail = (status: RoomError["status"], code: string, message: string): RoomError => ({
  ok: false,
  status,
  code,
  message,
});
export const ok = <T>(data: T): RoomResult<T> => ({ ok: true, data });
export const NOT_FOUND = fail(404, "ROOM_NOT_FOUND", "room not found");

/** エンジン（ゲーム、または記録したルールの版）がもうサーバーに無いルーム。logAvailable は終了済み（/log が返る）か。 */
export function gameRemoved(gameId: string, rulesVersion: number, logAvailable: boolean): RoomError {
  return fail(
    410,
    "GAME_REMOVED",
    `the game ${gameId} (rules version ${rulesVersion}) is no longer available on this server` +
      (logAvailable ? "; the log is still available from /rooms/{id}/log" : ""),
  );
}

export type Snapshot = { turn: number; state: unknown };

/** 視点によらない状態の共通部分（REST の状態・配信で1回だけ読む）。 */
export type RoomCore = {
  game: AnyGame;
  status: RoomStatus;
  /** ルームの作成時に記録したルールの版 */
  rulesVersion: number;
  gameOptions: unknown;
  players: string[];
  snap: Snapshot | null;
  currentPlayers: string[];
  deadline: number | null;
  /** 今の手番が始まったターン（playing 以外は null） */
  phaseTurn: number | null;
  result: GameResult | null;
  /** 試合が終わった理由（finished 以外は null） */
  endReason: EndReason | null;
  /** この状態を作った出来事（ログの最後の行。まだ無ければ null） */
  last: LastEvent | null;
  rematch: RematchInfo | null;
};

/** pid（観戦者は null）から見た状態。legal は pid が今行動でき、ゲームが合法手を列挙するときだけ付ける。 */
export function roomState(core: RoomCore, pid: string | null, now: number): RoomState {
  const { game, status, rulesVersion, gameOptions, players, snap, currentPlayers, deadline, phaseTurn, result, endReason, last, rematch } =
    core;
  const out: RoomState = {
    game: game.id,
    rulesVersion,
    gameOptions,
    status,
    turn: snap?.turn ?? 0,
    players,
    currentPlayers,
    view: snap ? game.view(snap.state, pid) : null,
    deadline,
    phaseTurn,
    now,
    result,
    endReason,
    last,
  };
  if (snap && pid && status === "playing" && currentPlayers.includes(pid) && game.legalActions) {
    out.legal = game.legalActions(snap.state, pid);
  }
  if (rematch) out.rematch = rematch;
  return out;
}

/** WS の state メッセージは REST の状態と同じフィールド（type が付くだけ）。 */
export const stateMessage = (s: RoomState): ServerMessage => ({ type: "state", ...s });

export const endMessage = (r: GameResult, reason: EndReason): ServerMessage => ({
  type: "end",
  winners: r.winners,
  ...(r.scores ? { scores: r.scores } : {}),
  reason,
});

/** ゲーム自身の結果。なければ時間切れ・投了による決着（forfeit）。 */
export const resultOf = (game: AnyGame, state: unknown, forfeit: GameResult | null): GameResult | null =>
  game.result(state) ?? forfeit;

/** GameError を RoomError にする（NOT_YOUR_TURN は 403、それ以外は 400）。GameError でなければ null。 */
function fromGameError(e: unknown): RoomError | null {
  if (!(e instanceof GameError)) return null;
  return fail(e.code === "NOT_YOUR_TURN" ? 403 : 400, e.code, e.message);
}

/**
 * 送られた turn を受け付けるか。現在のターンと一致すれば受け付ける。古くても、同じ同時手番の中
 * （phaseTurn 以降。phaseTurn は同時手番が始まったターン）で、送った人がまだ行動できるなら受け付ける
 * （同時手番では他の人が出すたびに turn が進むので、届くまでに他の人が出しただけの手を STALE_TURN にしない）。
 * 二重送信は、1回目で行動できる人から外れるので STALE_TURN のまま。
 */
export function acceptsTurn(game: AnyGame, snap: Snapshot, pid: string, turn: number, phaseTurn: number): boolean {
  if (turn === snap.turn) return true;
  return phaseTurn <= turn && turn < snap.turn && game.currentPlayers(snap.state).includes(pid);
}

/**
 * 行動の検証と適用。turn を受け付けなければ（acceptsTurn）STALE_TURN、形が違えば BAD_REQUEST、
 * ゲームが拒否すれば GameError のコード。成功なら検証済みの行動と次の状態。
 * phaseTurn は今の同時手番が始まったターン（記録が無ければ snap.turn で、turn の完全一致だけを受け付ける）。
 */
export function decideAction(
  game: AnyGame,
  snap: Snapshot,
  pid: string,
  turn: number,
  rawAction: unknown,
  seed: Seed,
  phaseTurn: number = snap.turn,
): RoomResult<{ action: unknown; next: unknown }> {
  if (!acceptsTurn(game, snap, pid, turn, phaseTurn)) return fail(409, "STALE_TURN", `current turn is ${snap.turn}`);
  const parsed = game.actionSchema.safeParse(rawAction);
  if (!parsed.success) return fail(400, "BAD_REQUEST", "invalid action");
  try {
    return ok({ action: parsed.data, next: game.apply(snap.state, pid, parsed.data, rngForTurn(seed, snap.turn)) });
  } catch (e) {
    const err = fromGameError(e);
    if (err) return err;
    throw e;
  }
}

/**
 * 投了・時間切れの解決結果。forfeit があれば meta に決着として残す。
 * endReason は、それで試合が終わるとき（forfeit か、onTimeout / onResign の結果で決着）だけ付く。
 * 試合が続くときは null（後で通常の手で決着したら normal）。
 */
export type Resolution = { state: unknown; forfeit: GameResult | null; endReason: EndReason | null };

function resolution(game: AnyGame, r: { state: unknown; forfeit: GameResult | null }, reason: EndReason): Resolution {
  return { ...r, endReason: r.forfeit || game.result(r.state) ? reason : null };
}

/** 投了の解決。onResign が拒否した投了は GameError のコードで返す。 */
export function decideResign(
  game: AnyGame,
  snap: Snapshot,
  pid: string,
  players: string[],
  seed: Seed,
): RoomResult<Resolution> {
  try {
    return ok(resolution(game, applyResign(game, snap.state, pid, players, seed, snap.turn), "resign"));
  } catch (e) {
    const err = fromGameError(e);
    if (err) return err;
    throw e;
  }
}

/** 時間切れの解決。今行動できるプレイヤー全員が時間切れになる。 */
export function decideTimeout(
  game: AnyGame,
  snap: Snapshot,
  players: string[],
  seed: Seed,
): { pending: string[]; resolution: Resolution } {
  const pending = game.currentPlayers(snap.state);
  return { pending, resolution: resolution(game, applyTimeout(game, snap.state, pending, players, seed, snap.turn), "timeout") };
}

/** 次の締め切り。同じ同時手番が続いているなら前の締め切りのまま、そうでなければ持ち時間をリセットする。 */
export function nextDeadline(
  prev: string[] | null,
  prevDeadline: number | null,
  pending: string[],
  now: number,
  turnTimeMs: number,
  unchangedKeeps = false,
): number {
  return sameSimultaneousTurn(prev, prevDeadline, pending, unchangedKeeps) ? prevDeadline! : now + turnTimeMs;
}

/**
 * commit で確定する状態（write の後のルームの状態から決める）。GameRoom はこれを meta に書き、確定後の副作用に使う。
 * - waiting … 放置された待機中のルームは、最後の変更から WAITING_ROOM_TTL_MS で消す
 * - finished … 結果を確定し、終了から FINISHED_ROOM_TTL_MS で消す
 * - playing … 次の締め切り（nextDeadline）と、今の同時手番が始まったターン（phaseTurn。acceptsTurn）
 */
export type Settlement =
  | { kind: "waiting"; cleanupAt: number }
  | { kind: "playing"; deadline: number; phaseTurn: number }
  | { kind: "finished"; result: GameResult; finishedAt: number; cleanupAt: number };

export function settle(
  room:
    | { status: "waiting" }
    | {
        status: "playing";
        game: AnyGame;
        state: unknown;
        forfeit: GameResult | null;
        /** write 前に行動できたプレイヤー（締め切りを延ばすかどうか。nextDeadline） */
        prev: string[] | null;
        prevDeadline: number | null;
        turnTimeMs: number;
        /** write 後のターン */
        turn: number;
        /** write 前の phaseTurn（記録の無いルームは null） */
        prevPhaseTurn: number | null;
        /** write が投了か（行動できるプレイヤーが変わらなければ同じ手番が続く。sameSimultaneousTurn） */
        resign?: boolean;
      },
  now: number,
): Settlement {
  if (room.status === "waiting") return { kind: "waiting", cleanupAt: now + WAITING_ROOM_TTL_MS };
  const result = resultOf(room.game, room.state, room.forfeit);
  if (result) return { kind: "finished", result, finishedAt: now, cleanupAt: now + FINISHED_ROOM_TTL_MS };
  const pending = room.game.currentPlayers(room.state);
  const keep = room.resign ?? false;
  const same = sameSimultaneousTurn(room.prev, room.prevDeadline, pending, keep);
  return {
    kind: "playing",
    deadline: nextDeadline(room.prev, room.prevDeadline, pending, now, room.turnTimeMs, keep),
    phaseTurn: same && room.prevPhaseTurn !== null ? room.prevPhaseTurn : room.turn,
  };
}

/**
 * 掃除の時刻。playing の間は（待機中に書いた値が残っていても）消さない。ただしエンジンが無いルームは
 * 進めようがないので消す（cleanupAt は retire が書く）。
 */
export const cleanupDueAt = (status: RoomStatus, hasEngine: boolean, cleanupAt: number | null): number | null =>
  status === "playing" && hasEngine ? null : cleanupAt;

/** alarm の時刻を決めるのに使うルームの状態。 */
export type AlarmFacts = {
  status: RoomStatus;
  /** 作成時の rulesVersion のエンジンがあるか */
  hasEngine: boolean;
  /** 終了済みで、D1 への書き込みが済んでおらず、諦めてもいないか */
  persistPending: boolean;
  cleanupAt: number | null;
  deadline: number | null;
};

/**
 * 今張っておくべき alarm の時刻。playing なら手番の締め切り、終了後で D1 未書き込みなら今（再試行）、それ以外は掃除。
 * エンジンが無いルームは時間切れを処理できないので掃除だけ（毎回失敗する alarm でリクエストを消費しないように）。
 * D1 の再試行はエンジンを使わない（meta の result）ので、エンジンが無くても続ける。
 */
export function wantedAlarm(f: AlarmFacts, now: number): number | null {
  if (f.status === "playing" && f.hasEngine) return f.deadline;
  if (f.persistPending) return now;
  return cleanupDueAt(f.status, f.hasEngine, f.cleanupAt);
}

/**
 * alarm が発火したときにすること。retire はエンジンが無いルームを畳んでから step を行うこと。
 * - cleanup … 掃除の時刻を過ぎた。ルームを消す
 * - persist … 終了済み。D1 への書き込みを再試行する（済んでいれば掃除の alarm を張る）
 * - armCleanup … 早すぎた掃除の alarm（待機中に更新された）か、エンジンが無いルーム。掃除の時刻で張り直す
 * - bots … 練習相手の続き（runBots が1回の上限に達して張った alarm）
 * - armDeadline … 締め切りがまだ先（古い alarm の誤発火）。締め切りで張り直す
 * - timeout … 手番の締め切りを過ぎた。時間切れを確定させる
 */
export type AlarmStep = "cleanup" | "persist" | "armCleanup" | "bots" | "armDeadline" | "timeout";

export function planAlarm(f: AlarmFacts & { botPending: boolean }, now: number): { retire: boolean; step: AlarmStep } {
  const due = cleanupDueAt(f.status, f.hasEngine, f.cleanupAt);
  if (due !== null && now >= due) return { retire: false, step: "cleanup" };
  // D1 への書き込みの再試行はエンジンを使わないので、エンジンが無くなっていても続ける（戦績を失わないように）。
  // エンジンが無いのに例外にすると alarm が再試行され続ける（1回 = 1リクエスト）ので、畳んで掃除だけ予約する
  const retire = !f.hasEngine;
  if (f.status === "finished") return { retire, step: "persist" };
  if (retire || f.status !== "playing") return { retire, step: "armCleanup" };
  const deadlinePassed = f.deadline !== null && now >= f.deadline;
  if (f.botPending && !deadlinePassed) return { retire, step: "bots" };
  if (f.deadline !== null && !deadlinePassed) return { retire, step: "armDeadline" };
  return { retire, step: "timeout" };
}

/**
 * D1 への結果書き込みが失敗したときの再試行（alarm で指数バックオフ、最大1時間おき）。
 * D1 の日次上限は UTC 0時にリセットされるので、終了から 26 時間は諦めない（alarm 1回 = 1リクエスト）。
 */
export const PERSIST_RETRY_BASE_MS = 30_000;
export const PERSIST_RETRY_MAX_MS = 60 * 60 * 1000;
export const PERSIST_RETRY_WINDOW_MS = 26 * 60 * 60 * 1000;

/** attempts 回失敗した後の次の再試行の時刻。終了から PERSIST_RETRY_WINDOW_MS を過ぎていれば null（諦める）。 */
export function nextPersistRetry(attempts: number, finishedAt: number, now: number): number | null {
  if (now - finishedAt > PERSIST_RETRY_WINDOW_MS) return null;
  return now + Math.min(PERSIST_RETRY_BASE_MS * 2 ** attempts, PERSIST_RETRY_MAX_MS);
}

export type Outcome = "win" | "loss" | "draw";

/**
 * D1 に記録する各プレイヤーの結果。時間切れ・投了による決着（byForfeit）に引き分けはなく、勝者がいなければ全員の負け。
 */
export const outcomeOf = (result: GameResult, byForfeit: boolean, pid: string): Outcome =>
  result.winners.includes(pid) ? "win" : result.winners.length === 0 && !byForfeit ? "draw" : "loss";

/**
 * 再戦ルームの席順：元のルームのプレイヤー ID → 新しいルームの席 ID。人間の席を1つずつずらす
 * （2人なら先手と後手が入れ替わる）。練習相手の席は含めない（開始時に予約席の後ろに座る）。
 */
export function rematchSeats(humans: string[]): Record<string, string> {
  const n = humans.length;
  return Object.fromEntries(humans.map((p, i) => [p, `p${((i + n - 1) % n) + 1}`]));
}

/**
 * 開始時に座らせる練習相手の数。参加者の後ろの空席を、seats を指定した部屋はその数まで、省略した部屋は minPlayers まで埋める
 * （省略時に maxPlayers まで埋めると、多人数ゲームの練習がいつも最大人数になってしまう）。
 */
export const practiceBotCount = (game: AnyGame, joined: number, opts: RoomOptions): number =>
  opts.practice ? Math.max(0, (opts.seats ?? game.minPlayers) - joined) : 0;
