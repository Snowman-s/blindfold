import { describe, expect, it } from "vitest";
import { tictactoe as g } from "../../src/games/tictactoe";
import { GameError } from "../../src/games/types";
import { createRng } from "../../src/lib/rng";

const rng = createRng("1");
const P = ["a", "b"];

function play(cells: number[]) {
  let s = g.init(P, "1", null);
  cells.forEach((cell, i) => {
    s = g.apply(s, P[i % 2]!, { cell }, rng);
  });
  return s;
}

describe("tictactoe", () => {
  it("初期状態: 先手のみ行動でき、合法手は9個", () => {
    const s = g.init(P, "1", null);
    expect(g.currentPlayers(s)).toEqual(["a"]);
    expect(g.legalActions!(s, "a")).toHaveLength(9);
    expect(g.legalActions!(s, "b")).toEqual([]);
    expect(g.result(s)).toBeNull();
  });

  it("apply は元の状態を変更しない", () => {
    const s = g.init(P, "1", null);
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

  it("view の lastCell と winLine", () => {
    const v = (cells: number[]) => g.view(play(cells), null) as { lastCell: number | null; winLine: number[] | null };
    expect(v([])).toMatchObject({ lastCell: null, winLine: null });
    expect(v([4, 0])).toMatchObject({ lastCell: 0, winLine: null });
    expect(v([0, 3, 1, 4, 2])).toMatchObject({ lastCell: 2, winLine: [0, 1, 2] });
    // この版より前のスナップショット（lastCell が無い）も読める
    const { lastCell: _, ...old } = play([4]);
    expect(g.view(old, null)).toMatchObject({ lastCell: null });
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
    expect(() => g.init(["a"], "1", null)).toThrow(GameError);
    expect(() => g.init(["a", "a"], "1", null)).toThrow(GameError);
  });
});
