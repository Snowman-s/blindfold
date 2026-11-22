import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GameError, type AnyGame, type GameDefinition } from "../../src/games/types";
import { gameExamples } from "../../src/lib/examples";

/** 3人そろわないと始められない、全員が1回ずつ pass したら終わるテスト用のゲーム。 */
type S = { players: string[]; turn: number };
const threePlayer: GameDefinition<S, { pass: true }> = {
  id: "test-three",
  rulesVersion: 1,
  viewVersion: 1,
  minPlayers: 3,
  maxPlayers: 3,
  actionSchema: z.object({ pass: z.literal(true) }),
  viewSchema: z.strictObject({ players: z.array(z.string()), turn: z.number().int() }),
  docs: { summary: "test", rules: "test", view: "test", examples: [] },
  init(players) {
    if (players.length !== 3) throw new GameError("BAD_REQUEST", "needs exactly 3 players");
    return { players, turn: 0 };
  },
  currentPlayers: (s) => (s.turn < s.players.length ? [s.players[s.turn]!] : []),
  legalActions(s, pid) {
    return this.currentPlayers(s).includes(pid) ? [{ pass: true }] : [];
  },
  apply(s, pid) {
    if (!this.currentPlayers(s).includes(pid)) throw new GameError("NOT_YOUR_TURN", "not your turn");
    return { ...s, turn: s.turn + 1 };
  },
  view: (s) => s,
  result: (s) => (s.turn >= s.players.length ? { winners: [s.players.at(-1)!] } : null),
};

describe("gameExamples", () => {
  it("ゲームの最少人数だけプレイヤーを座らせる", () => {
    const ex = gameExamples(threePlayer as AnyGame);
    expect(ex.log.players).toEqual(["p1", "p2", "p3"]);
    expect(ex.player.players).toEqual(["p1", "p2", "p3"]);
    expect(ex.end.winners).toEqual(["p3"]);
  });
});
