import { describe, expect, it } from "vitest";
import { tictactoe as g } from "../../src/games/tictactoe";
import { GameError } from "../../src/games/types";
import { createRng } from "../../src/lib/rng";
import { games } from "../../src/games/registry";

const rng = createRng("1");
const P = ["a", "b"];

function play(cells: number[]) {
  let s = g.init(P, "1");
  cells.forEach((cell, i) => {
    s = g.apply(s, P[i % 2]!, { cell }, rng);
  });
  return s;
}

describe("tictactoe", () => {
  it("初期状態: 先手のみ行動でき、合法手は9個", () => {
    const s = g.init(P, "1");
    expect(g.currentPlayers(s)).toEqual(["a"]);
    expect(g.legalActions(s, "a")).toHaveLength(9);
    expect(g.legalActions(s, "b")).toEqual([]);
    expect(g.result(s)).toBeNull();
  });

  it("apply は元の状態を変更しない", () => {
    const s = g.init(P, "1");
    const before = JSON.stringify(s);
    g.apply(s, "a", { cell: 4 }, rng);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("行で勝つ", () => {
    const s = play([0, 3, 1, 4, 2]);
    expect(g.result(s)).toEqual({ winners: ["a"], scores: { a: 1, b: 0 } });
    expect(g.currentPlayers(s)).toEqual([]);
  });

  it("後手の斜めで勝つ", () => {
    const s = play([1, 0, 3, 4, 5, 8]);
    expect(g.result(s)?.winners).toEqual(["b"]);
  });

  it("引き分け", () => {
    const s = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(g.result(s)).toEqual({ winners: [], scores: { a: 0.5, b: 0.5 } });
  });

  it("不正な手は GameError", () => {
    const s = play([4]);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof GameError ? e.code : "other";
      }
      return "none";
    };
    expect(code(() => g.apply(s, "a", { cell: 0 }, rng))).toBe("NOT_YOUR_TURN");
    expect(code(() => g.apply(s, "b", { cell: 4 }, rng))).toBe("ILLEGAL_ACTION");
    expect(code(() => g.apply(play([0, 3, 1, 4, 2]), "b", { cell: 5 }, rng))).toBe("ILLEGAL_ACTION");
  });

  it("actionSchema は不正入力を弾く", () => {
    expect(g.actionSchema.safeParse({ cell: 8 }).success).toBe(true);
    expect(g.actionSchema.safeParse({ cell: 9 }).success).toBe(false);
    expect(g.actionSchema.safeParse({ cell: 1.5 }).success).toBe(false);
    expect(g.actionSchema.safeParse({}).success).toBe(false);
  });

  it("状態は JSON 往復で変わらない", () => {
    const s = play([0, 4, 8]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("同じ人数でない／重複プレイヤーは init で拒否", () => {
    expect(() => g.init(["a"], "1")).toThrow(GameError);
    expect(() => g.init(["a", "a"], "1")).toThrow(GameError);
  });
});

describe("ランダム Bot で 100 試合", () => {
  function run(seed: string) {
    const game = games["tictactoe"]!;
    const r = createRng(seed);
    let s = game.init(P, seed);
    const log: { pid: string; action: unknown }[] = [];
    while (game.result(s) === null) {
      const pid = game.currentPlayers(s)[0]!;
      const legal = game.legalActions(s, pid);
      expect(legal.length).toBeGreaterThan(0);
      const action = legal[r.int(legal.length)];
      log.push({ pid, action });
      s = game.apply(s, pid, action, r);
    }
    return { s, log };
  }

  it("全試合が例外なく終了する", () => {
    for (let seed = 0; seed < 100; seed++) {
      const { s, log } = run(String(seed));
      expect(games["tictactoe"]!.result(s)).not.toBeNull();
      expect(log.length).toBeLessThanOrEqual(9);
    }
  });

  it("初期シード + 行動ログで完全に再現できる", () => {
    const game = games["tictactoe"]!;
    for (let seed = 0; seed < 100; seed++) {
      const { s, log } = run(String(seed));
      let replay = game.init(P, String(seed));
      const r = createRng(String(seed)); // apply に渡す rng もシードから作る
      for (const { pid, action } of log) replay = game.apply(replay, pid, action, r);
      expect(replay).toEqual(s);
    }
  });
});
