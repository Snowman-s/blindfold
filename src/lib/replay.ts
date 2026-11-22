import type { AnyGame, GameResult } from "../games/types";
import { rngForTurn, type Seed } from "./rng";

/**
 * 行動ログの1行。timeout があれば持ち時間切れ、resign があればそのプレイヤーの投了（どちらも player / action は null）。
 */
export interface LogEntry {
  turn: number;
  player: string | null;
  action: unknown;
  at: number;
  timeout?: string[];
  resign?: string;
}

export interface ReplayLog {
  game: string;
  /** 試合の開始時に記録したルールの版（GameDefinition.rulesVersion）。今のエンジンと違えば再現できるとは限らない。 */
  rulesVersion: number;
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

/**
 * 投了の解決（DO とリプレイで共有する純粋関数）。
 * onResign 未定義のゲームは、投了したプレイヤーの負け（残りが勝者）で、状態は変えない。
 * 定義されていればその結果の状態を返す（試合が続くこともある）。不正な投了は onResign が GameError を throw する。
 */
export function applyResign(
  game: AnyGame,
  state: unknown,
  pid: string,
  players: string[],
  seed: Seed,
  turn: number,
): { state: unknown; forfeit: GameResult | null } {
  if (game.onResign) {
    return { state: game.onResign(state, pid, rngForTurn(seed, turn)), forfeit: null };
  }
  const winners = players.filter((p) => p !== pid);
  const scores: Record<string, number> = {};
  for (const p of players) scores[p] = p === pid ? 0 : 1;
  return { state, forfeit: { winners, scores } };
}

export interface Frame {
  turn: number;
  state: unknown;
}

/**
 * 初期シード + 行動ログから、各ターンの状態を再現する。frames[i] は turn=i の状態。
 * result はゲーム自身の結果、なければ時間切れ・投了による決着（forfeit）。
 */
export function replayFrames(game: AnyGame, log: ReplayLog): { frames: Frame[]; result: GameResult | null } {
  let state = game.init(log.players, log.seed);
  let forfeit: GameResult | null = null;
  const frames: Frame[] = [{ turn: 0, state }];
  for (const e of log.actions) {
    if (e.turn !== frames.length - 1) throw new Error(`log gap at turn ${e.turn}`);
    if (e.timeout) {
      const r = applyTimeout(game, state, e.timeout, log.players, log.seed, e.turn);
      state = r.state;
      forfeit = r.forfeit ?? forfeit;
    } else if (e.resign !== undefined) {
      const r = applyResign(game, state, e.resign, log.players, log.seed, e.turn);
      state = r.state;
      forfeit = r.forfeit ?? forfeit;
    } else {
      state = game.apply(state, e.player!, game.actionSchema.parse(e.action), rngForTurn(log.seed, e.turn));
    }
    frames.push({ turn: e.turn + 1, state });
  }
  return { frames, result: game.result(state) ?? forfeit };
}

export function replay(game: AnyGame, log: ReplayLog) {
  const { frames, result } = replayFrames(game, log);
  const last = frames[frames.length - 1]!;
  return { state: last.state, turn: last.turn, result };
}
