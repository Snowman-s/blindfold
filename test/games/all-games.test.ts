import { describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import { highcard, ROUNDS } from "../../src/games/highcard";
import { GameError } from "../../src/games/types";
import { createRng, rngForTurn } from "../../src/lib/rng";
import { applyTimeout, replay, type LogEntry } from "../../src/lib/replay";

const PLAYERS = ["p1", "p2"];

/** ランダム Bot で1試合。同時手番でも、行動できるプレイヤーからランダムに選ぶ。 */
function playRandom(gameId: string, seed: number) {
  const game = games[gameId]!;
  const r = createRng(seed ^ 0xabcdef);
  let state = game.init(PLAYERS, seed);
  const actions: LogEntry[] = [];
  let turn = 0;
  while (game.result(state) === null) {
    const cur = game.currentPlayers(state);
    expect(cur.length).toBeGreaterThan(0);
    const pid = cur[r.int(cur.length)]!;
    const legal = game.legalActions(state, pid);
    expect(legal.length).toBeGreaterThan(0);
    const action = legal[r.int(legal.length)];
    actions.push({ turn, player: pid, action, at: 0 });
    state = game.apply(state, pid, action, rngForTurn(seed, turn));
    turn++;
    expect(turn).toBeLessThan(1000);
  }
  return { state, actions };
}

describe.each(Object.keys(games))("%s", (gameId) => {
  const game = games[gameId]!;

  it("ランダム Bot で 100 試合が例外なく終わる", () => {
    for (let seed = 0; seed < 100; seed++) {
      const { state } = playRandom(gameId, seed);
      const res = game.result(state);
      expect(res).not.toBeNull();
      expect(game.currentPlayers(state)).toEqual([]);
    }
  });

  it("初期シード + 行動ログだけで完全に再現できる（JSON 往復を経ても）", () => {
    for (let seed = 0; seed < 100; seed++) {
      const { state, actions } = playRandom(gameId, seed);
      const log = JSON.parse(JSON.stringify({ game: gameId, seed, players: PLAYERS, actions }));
      const r = replay(game, log);
      expect(r.state).toEqual(state);
      expect(r.result).toEqual(game.result(state));
    }
  });

  it("状態は JSON 往復で変わらず、apply は入力を変更しない", () => {
    const s = game.init(PLAYERS, 7);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const before = JSON.stringify(s);
    const pid = game.currentPlayers(s)[0]!;
    game.apply(s, pid, game.legalActions(s, pid)[0], createRng(1));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("時間切れ", () => {
  it("onTimeout 未定義のゲームは、時間切れのプレイヤーの負け", () => {
    const g = games["tictactoe"]!;
    const s = g.init(PLAYERS, 1);
    const r = applyTimeout(g, s, g.currentPlayers(s), PLAYERS, 1, 0);
    expect(r.forfeit).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
    expect(r.state).toBe(s);
  });
});

describe("highcard: 隠し情報", () => {
  const s0 = highcard.init(PLAYERS, 42);

  it("同時手番: 最初は両者が行動でき、1人が出すと残りの1人だけになる", () => {
    expect(highcard.currentPlayers(s0)).toEqual(["p1", "p2"]);
    const card = s0.hands["p1"]![0]!;
    const s1 = highcard.apply(s0, "p1", { card }, createRng(1));
    expect(highcard.currentPlayers(s1)).toEqual(["p2"]);
    expect(highcard.legalActions(s1, "p1")).toEqual([]);
  });

  it("観戦者の view に手札・伏せ札が含まれない", () => {
    const card = s0.hands["p1"]![0]!;
    const s1 = highcard.apply(s0, "p1", { card }, createRng(1));
    const v = highcard.view(s1, null) as Record<string, unknown>;
    expect(v).not.toHaveProperty("hand");
    expect(v).not.toHaveProperty("myPlayed");
    // 伏せ札が誰かに出されたことは分かるが、その値はどこにも現れない
    expect(v.hasPlayed).toEqual({ p1: true, p2: false });
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(s1.hands["p2"]));
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(s1.hands["p1"]));
  });

  it("相手の view に自分の手札・伏せ札が漏れない", () => {
    const card = s0.hands["p1"]![0]!;
    const s1 = highcard.apply(s0, "p1", { card }, createRng(1));
    const v2 = highcard.view(s1, "p2") as { hand: number[]; myPlayed: number | null; hasPlayed: Record<string, boolean> };
    expect(v2.hand).toEqual(s1.hands["p2"]);
    expect(v2.myPlayed).toBeNull();
    expect(v2).not.toHaveProperty("hands");
    expect(v2).not.toHaveProperty("played");
    const v1 = highcard.view(s1, "p1") as { myPlayed: number | null };
    expect(v1.myPlayed).toBe(card); // 本人には見える
  });

  it("両者が出すと公開され、history に入る", () => {
    const c1 = s0.hands["p1"]![0]!;
    const c2 = s0.hands["p2"]![0]!;
    let s = highcard.apply(s0, "p1", { card: c1 }, createRng(1));
    s = highcard.apply(s, "p2", { card: c2 }, createRng(1));
    expect(s.round).toBe(1);
    expect(highcard.view(s, null)).toMatchObject({ history: [{ cards: { p1: c1, p2: c2 } }] });
    expect(highcard.currentPlayers(s)).toEqual(["p1", "p2"]);
  });

  it("不正な手は GameError", () => {
    const notMine = s0.hands["p2"]![0]!;
    expect(() => highcard.apply(s0, "p1", { card: notMine }, createRng(1))).toThrow(GameError);
    const s1 = highcard.apply(s0, "p1", { card: s0.hands["p1"]![0]! }, createRng(1));
    expect(() => highcard.apply(s1, "p1", { card: s1.hands["p1"]![0]! }, createRng(1))).toThrow(GameError); // 二度出し
  });

  it("全ラウンドで ROUNDS 回の対戦になる", () => {
    const { state } = playRandom("highcard", 3);
    expect((state as { history: unknown[] }).history).toHaveLength(ROUNDS);
  });
});
