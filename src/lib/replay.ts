import type { GameDefinition, GameResult } from "../games/types";
import { rngForTurn, type Seed } from "./rng";

type AnyGame = GameDefinition<unknown, unknown>;

/** 行動ログの1行。timeout があれば持ち時間切れ（player / action は無視）。 */
export interface LogEntry {
  turn: number;
  player: string | null;
  action: unknown;
  at: number;
  timeout?: string[];
}

export interface ReplayLog {
  game: string;
  seed: Seed;
  players: string[];
  actions: LogEntry[];
}

/**
 * 持ち時間切れの解決（alarm とリプレイで共有する純粋関数）。
 * onTimeout 未定義のゲームは、時間切れのプレイヤーの負け（残りが勝者）。
 * 全員が時間切れなら winners は空で、全員の負け（引き分けではない。D1 には outcome = 'loss' で記録する）。
 */
export function applyTimeout(
  game: AnyGame,
  state: unknown,
  pids: string[],
  players: string[],
  seed: Seed,
  turn: number,
): { state: unknown; forfeit: GameResult | null } {
  if (game.onTimeout) {
    return { state: game.onTimeout(state, pids, rngForTurn(seed, turn)), forfeit: null };
  }
  const winners = players.filter((p) => !pids.includes(p));
  const scores: Record<string, number> = {};
  for (const p of players) scores[p] = pids.includes(p) ? 0 : 1;
  return { state, forfeit: { winners, scores } };
}

export interface Frame {
  turn: number;
  state: unknown;
}

/** 初期シード + 行動ログから、各ターンの状態を再現する。frames[i] は turn=i の状態。 */
export function replayFrames(game: AnyGame, log: ReplayLog): { frames: Frame[]; forfeit: GameResult | null } {
  let state = game.init(log.players, log.seed);
  let forfeit: GameResult | null = null;
  const frames: Frame[] = [{ turn: 0, state }];
  for (const e of log.actions) {
    if (e.turn !== frames.length - 1) throw new Error(`log gap at turn ${e.turn}`);
    if (e.timeout) {
      const r = applyTimeout(game, state, e.timeout, log.players, log.seed, e.turn);
      state = r.state;
      forfeit = r.forfeit;
    } else {
      state = game.apply(state, e.player!, game.actionSchema.parse(e.action), rngForTurn(log.seed, e.turn));
    }
    frames.push({ turn: e.turn + 1, state });
  }
  return { frames, forfeit };
}

export function replay(game: AnyGame, log: ReplayLog) {
  const { frames, forfeit } = replayFrames(game, log);
  const last = frames[frames.length - 1]!;
  return { state: last.state, turn: last.turn, result: game.result(last.state) ?? forfeit };
}
