import { z } from "zod";
import { createRng } from "../../src/lib/rng";
import { GameError, type GameDefinition } from "../../src/games/types";

/**
 * テスト専用のゲーム（registry には載せない）。合法手を列挙しない（legalActions を定義しない）ゲームの検証に使う。
 * シードで 1〜100 の秘密の数を決め、2人が交互に当てる。外れたら上か下かが公開される。当てた人の勝ち。
 * 秘密の数は view に出さない（観戦者にも）。
 */
export const GUESS_MAX = 100;

export interface GuessState {
  players: string[];
  secret: number;
  turn: number;
  guesses: { player: string; guess: number; hint: "higher" | "lower" | "correct" }[];
}

/** これまでのヒントから残っている範囲 [lo, hi]。 */
function range(s: GuessState): [number, number] {
  let lo = 1;
  let hi = GUESS_MAX;
  for (const g of s.guesses) {
    if (g.hint === "higher") lo = Math.max(lo, g.guess + 1);
    if (g.hint === "lower") hi = Math.min(hi, g.guess - 1);
  }
  return [lo, hi];
}

const winnerOf = (s: GuessState) => s.guesses.find((g) => g.hint === "correct")?.player ?? null;

export const guess: GameDefinition<GuessState, { guess: number }> = {
  id: "test-guess",
  rulesVersion: 1,
  viewVersion: 1,
  minPlayers: 2,
  maxPlayers: 2,
  // 範囲外の数も形としては受け付け、apply で ILLEGAL_ACTION にする（legal が無いので apply が唯一の検証）
  actionSchema: z.strictObject({ guess: z.number().int() }),
  viewSchema: z.strictObject({
    players: z.array(z.string()),
    next: z.string().nullable(),
    guesses: z.array(
      z.strictObject({ player: z.string(), guess: z.number().int(), hint: z.enum(["higher", "lower", "correct"]) }),
    ),
  }),
  docs: {
    summary: "test",
    rules: "test",
    view: "test",
    examples: [{ action: { guess: 50 }, meaning: "guess 50" }],
  },
  init: (players, seed) => ({ players: [...players], secret: createRng(seed).int(GUESS_MAX) + 1, turn: 0, guesses: [] }),
  currentPlayers: (s) => (winnerOf(s) === null ? [s.players[s.turn]!] : []),
  apply(s, pid, a) {
    if (!this.currentPlayers(s).includes(pid)) throw new GameError("NOT_YOUR_TURN", "not your turn");
    if (a.guess < 1 || a.guess > GUESS_MAX) throw new GameError("ILLEGAL_ACTION", `guess must be 1-${GUESS_MAX}`);
    const hint = a.guess === s.secret ? "correct" : a.guess < s.secret ? "higher" : "lower";
    return { ...s, turn: (s.turn + 1) % s.players.length, guesses: [...s.guesses, { player: pid, guess: a.guess, hint }] };
  },
  view: (s) => ({ players: s.players, next: s.players[s.turn] && winnerOf(s) === null ? s.players[s.turn]! : null, guesses: s.guesses }),
  result: (s) => {
    const w = winnerOf(s);
    return w === null ? null : { winners: [w] };
  },
  // 二分探索（必ず決着する）。legalActions が無いので必須
  practiceAction(s) {
    const [lo, hi] = range(s);
    return { guess: Math.floor((lo + hi) / 2) };
  },
};
