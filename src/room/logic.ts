import { GameError, type AnyGame, type GameResult } from "../games/types";
import type { EndReason, RematchInfo, RoomState, RoomStatus, ServerMessage } from "../lib/protocol";
import { applyResign, applyTimeout } from "../lib/replay";
import { rngForTurn, type Seed } from "../lib/rng";

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
  result: GameResult | null;
  rematch: RematchInfo | null;
};

/** pid（観戦者は null）から見た状態。legal は pid が今行動でき、ゲームが合法手を列挙するときだけ付ける。 */
export function roomState(core: RoomCore, pid: string | null, now: number): RoomState {
  const { game, status, rulesVersion, gameOptions, players, snap, currentPlayers, deadline, result, rematch } = core;
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
    now,
    result,
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
 * 行動の検証と適用。turn が現在のターンと違えば STALE_TURN、形が違えば BAD_REQUEST、
 * ゲームが拒否すれば GameError のコード。成功なら検証済みの行動と次の状態。
 */
export function decideAction(
  game: AnyGame,
  snap: Snapshot,
  pid: string,
  turn: number,
  rawAction: unknown,
  seed: Seed,
): RoomResult<{ action: unknown; next: unknown }> {
  if (turn !== snap.turn) return fail(409, "STALE_TURN", `current turn is ${snap.turn}`);
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

/**
 * 次の締め切り。prev（変更前に行動できたプレイヤー）を渡したとき、行動できるプレイヤーが減っただけ
 * （同時手番で誰かが出した）なら前の締め切りのまま。手番が移ったとき・新しいラウンドに入ったときだけ持ち時間をリセットする。
 */
export function nextDeadline(
  prev: string[] | null,
  prevDeadline: number | null,
  pending: string[],
  now: number,
  turnTimeMs: number,
): number {
  const shrinking =
    prev !== null &&
    prevDeadline !== null &&
    pending.length > 0 &&
    pending.length < prev.length &&
    pending.every((p) => prev.includes(p));
  return shrinking ? prevDeadline : now + turnTimeMs;
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

/** 開始時に座らせる練習相手の数（参加者の後ろの空席を minPlayers まで埋める）。 */
export const practiceBotCount = (game: AnyGame, joined: number, practice: boolean): number =>
  practice ? Math.max(0, game.minPlayers - joined) : 0;
