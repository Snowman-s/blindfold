import { z } from "zod";
import { GameError, type GameDefinition } from "../types";
import { createRng } from "../../lib/rng";
import { DECK_SIZE, ROUNDS } from "./constants";
import { docs } from "./docs";

/**
 * ハイカード: 隠し情報（手札・伏せた札）と同時手番を持つ2人用カードゲーム。
 * 1〜13 の札から各自5枚配られ、毎ラウンド両者が1枚ずつ同時に伏せて出す。
 * 大きい札が1勝。5ラウンド終了時に勝ち数が多い方が勝ち。
 * ルールの説明（LLM 向け・英語）は docs.ts。
 */
export { DECK_SIZE, ROUNDS };

export interface HighCardState {
  players: [string, string];
  hands: Record<string, number[]>;
  /** 今ラウンドに伏せた札。両者が出すと公開して null に戻る。 */
  played: Record<string, number | null>;
  round: number;
  wins: Record<string, number>;
  history: { cards: Record<string, number>; winner: string | null }[];
}

export type HighCardAction = { card: number };

const actionSchema = z.object({ card: z.number().int().min(1).max(DECK_SIZE) });

const card = z.number().int().min(1).max(DECK_SIZE);
const perPlayer = <T extends z.ZodType>(v: T) => z.record(z.string(), v);

const viewSchema = z.strictObject({
  players: z.array(z.string()).length(2).describe("The two player IDs"),
  round: z.number().int().min(0).max(ROUNDS).describe(`Number of finished rounds. ${ROUNDS} = game over`),
  wins: perPlayer(z.number().int().min(0)).describe("Player ID -> rounds won"),
  history: z
    .array(
      z.strictObject({
        cards: perPlayer(card).describe("Player ID -> card played in that round"),
        winner: z.string().nullable().describe("Player ID who won the round"),
      }),
    )
    .describe("Finished rounds, oldest first"),
  handSizes: perPlayer(z.number().int().min(0)).describe("Player ID -> number of cards left in hand"),
  hasPlayed: perPlayer(z.boolean()).describe("Player ID -> whether that player has played a card this round"),
  hand: z.array(card).optional().describe("Players only (absent for spectators): your remaining cards, ascending"),
  myPlayed: card
    .nullable()
    .optional()
    .describe("Players only (absent for spectators): the card you played this round, or null if you have not played yet"),
});

export const highcard: GameDefinition<HighCardState, HighCardAction> = {
  id: "highcard",
  rulesVersion: 1,
  viewVersion: 1,
  minPlayers: 2,
  maxPlayers: 2,
  actionSchema,
  viewSchema,
  docs,

  init(players, seed) {
    if (players.length !== 2 || players[0] === players[1]) {
      throw new GameError("BAD_REQUEST", "highcard requires 2 distinct players");
    }
    const [a, b] = [players[0]!, players[1]!];
    const rng = createRng(seed);
    const deck = Array.from({ length: DECK_SIZE }, (_, i) => i + 1);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return {
      players: [a, b],
      hands: {
        [a]: deck.slice(0, ROUNDS).sort((x, y) => x - y),
        [b]: deck.slice(ROUNDS, ROUNDS * 2).sort((x, y) => x - y),
      },
      played: { [a]: null, [b]: null },
      round: 0,
      wins: { [a]: 0, [b]: 0 },
      history: [],
    };
  },

  currentPlayers(s) {
    if (s.round >= ROUNDS) return [];
    return s.players.filter((p) => s.played[p] === null);
  },

  legalActions(s, pid) {
    if (!this.currentPlayers(s).includes(pid)) return [];
    return s.hands[pid]!.map((card) => ({ card }));
  },

  apply(s, pid, a) {
    if (s.round >= ROUNDS) throw new GameError("ILLEGAL_ACTION", "game is over");
    if (!this.currentPlayers(s).includes(pid)) throw new GameError("NOT_YOUR_TURN", "not your turn");
    if (!s.hands[pid]!.includes(a.card)) throw new GameError("ILLEGAL_ACTION", "card is not in your hand");

    const hands = { ...s.hands, [pid]: s.hands[pid]!.filter((c) => c !== a.card) };
    const played = { ...s.played, [pid]: a.card };
    const [p0, p1] = s.players;
    if (played[p0] === null || played[p1] === null) return { ...s, hands, played };

    // 両者が出したので公開して勝敗を決める
    const c0 = played[p0]!;
    const c1 = played[p1]!;
    const winner = c0 === c1 ? null : c0 > c1 ? p0 : p1;
    return {
      ...s,
      hands,
      played: { [p0]: null, [p1]: null },
      round: s.round + 1,
      wins: winner ? { ...s.wins, [winner]: s.wins[winner]! + 1 } : s.wins,
      history: [...s.history, { cards: { [p0]: c0, [p1]: c1 }, winner }],
    };
  },

  // 他人の手札と、まだ公開されていない伏せ札は含めない。
  view(s, pid) {
    const me = pid !== null && s.players.includes(pid) ? pid : null;
    return {
      players: s.players,
      round: s.round,
      wins: s.wins,
      history: s.history,
      handSizes: Object.fromEntries(s.players.map((p) => [p, s.hands[p]!.length])),
      hasPlayed: Object.fromEntries(s.players.map((p) => [p, s.played[p] !== null])),
      ...(me ? { hand: s.hands[me], myPlayed: s.played[me] } : {}),
    };
  },

  result(s) {
    if (s.round < ROUNDS) return null;
    const [p0, p1] = s.players;
    const w0 = s.wins[p0]!;
    const w1 = s.wins[p1]!;
    return {
      winners: w0 === w1 ? [] : [w0 > w1 ? p0 : p1],
      scores: { [p0]: w0, [p1]: w1 },
    };
  },
};
