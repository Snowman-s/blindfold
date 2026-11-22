import { z } from "zod";
import { createRng } from "../../src/lib/rng";
import { GameError, type GameDefinition } from "../../src/games/types";

/**
 * テスト専用のゲーム（registry には載せない）。ゲーム固有のオプション（optionsSchema）の検証に使う。
 * 数 start から始め、手番の人が 1〜maxStep を引く。0 にした人の勝ち。先手はシードで決まる。
 */
export interface CountdownOptions {
  start: number;
  maxStep: number;
}

export interface CountdownState {
  players: string[];
  left: number;
  maxStep: number;
  turn: number; // players の中の手番のインデックス
  winner: string | null;
}

const optionsSchema = z.strictObject({
  start: z.number().int().min(1).max(50).default(5).describe("Starting number"),
  maxStep: z.number().int().min(1).max(3).default(2).describe("Largest number that can be taken in one move"),
});

export const countdown: GameDefinition<CountdownState, { take: number }, CountdownOptions> = {
  id: "test-countdown",
  rulesVersion: 1,
  viewVersion: 1,
  minPlayers: 2,
  maxPlayers: 2,
  actionSchema: z.strictObject({ take: z.number().int().min(1).max(3) }),
  viewSchema: z.strictObject({
    players: z.array(z.string()),
    left: z.number().int(),
    maxStep: z.number().int(),
    turn: z.number().int(),
    winner: z.string().nullable(),
  }),
  optionsSchema,
  docs: {
    summary: "test",
    rules: "test",
    view: "test",
    options: "- `start`: starting number\n- `maxStep`: largest number per move",
    examples: [{ action: { take: 1 }, meaning: "take one" }],
  },
  init(players, seed, options) {
    return {
      players: [...players],
      left: options.start,
      maxStep: options.maxStep,
      turn: createRng(seed).int(players.length),
      winner: null,
    };
  },
  currentPlayers: (s) => (s.winner === null ? [s.players[s.turn]!] : []),
  legalActions(s, pid) {
    if (!this.currentPlayers(s).includes(pid)) return [];
    return Array.from({ length: Math.min(s.maxStep, s.left) }, (_, i) => ({ take: i + 1 }));
  },
  apply(s, pid, a) {
    if (!this.currentPlayers(s).includes(pid)) throw new GameError("NOT_YOUR_TURN", "not your turn");
    if (a.take > s.maxStep || a.take > s.left) throw new GameError("ILLEGAL_ACTION", "too many");
    const left = s.left - a.take;
    return { ...s, left, turn: (s.turn + 1) % s.players.length, winner: left === 0 ? pid : null };
  },
  view: (s) => s,
  result: (s) => (s.winner === null ? null : { winners: [s.winner] }),
};
