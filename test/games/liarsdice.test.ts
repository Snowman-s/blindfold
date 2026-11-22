import { describe, expect, it } from "vitest";
import { liarsdice as g, type LiarsDiceOptions, type LiarsDiceState } from "../../src/games/liarsdice";
import { GameError } from "../../src/games/types";
import { createRng, rngForTurn } from "../../src/lib/rng";

const rng = createRng("1");
const opts: LiarsDiceOptions = { startDice: 5, wildOnes: true, spotOn: false };
const seats = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

/** 目を指定した局面。p1 の手番から。 */
function board(dice: Record<string, number[]>, over: Partial<LiarsDiceState> = {}): LiarsDiceState {
  const players = Object.keys(dice);
  return {
    players,
    alive: players,
    out: {},
    outRank: {},
    dice,
    inRound: players,
    round: 1,
    bids: [],
    turnPlayer: players[0]!,
    lastRound: null,
    options: opts,
    ...over,
  };
}
const bid = (s: LiarsDiceState, pid: string, quantity: number, face: number) => g.apply(s, pid, { type: "bid", quantity, face }, rng);
const view = (s: LiarsDiceState, pid: string | null) => g.view(s, pid) as Record<string, unknown>;

describe("liarsdice: 宣言", () => {
  it("ワイルドありでは最初に 1 を宣言できず、minBids はそれ以外 1", () => {
    const s = board({ p1: [1, 2, 3], p2: [4, 5, 6] });
    expect(view(s, "p1").minBids).toEqual([null, 1, 1, 1, 1, 1]);
    expect(() => bid(s, "p1", 1, 1)).toThrow(GameError);
    const s2 = board({ p1: [1, 2, 3], p2: [4, 5, 6] }, { options: { ...opts, wildOnes: false } });
    expect(view(s2, "p1").minBids).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("上げ方：同じ数なら大きい目、1 へは半分（切り上げ）以上、1 からは 2 倍 + 1 以上。総数を超えられない", () => {
    const dice = { p1: [1, 1, 2, 3, 4], p2: [2, 2, 5, 6, 6], p3: [3, 3, 4, 4, 5] }; // 計 15 個
    let s = bid(board(dice), "p1", 7, 5);
    expect(view(s, "p2").minBids).toEqual([4, 8, 8, 8, 8, 7]);
    expect(() => bid(s, "p2", 7, 4)).toThrow(GameError);
    expect(() => bid(s, "p2", 3, 1)).toThrow(GameError);
    s = bid(s, "p2", 4, 1);
    expect(view(s, "p3").minBids).toEqual([5, 9, 9, 9, 9, 9]);
    expect(() => bid(s, "p3", 8, 6)).toThrow(GameError);
    s = bid(s, "p3", 9, 2);
    expect(s.turnPlayer).toBe("p1");
    expect(() => bid(s, "p1", 16, 3)).toThrow(GameError);
    s = bid(s, "p1", 15, 6);
    // 6 の 15 個より上は 1 の 8 個以上だけ
    expect(view(s, "p2").minBids).toEqual([8, null, null, null, null, null]);
  });

  it("手番でない人・まだ宣言の無いダウトは拒否する", () => {
    const s = board({ p1: [1], p2: [2] });
    expect(() => bid(s, "p2", 1, 2)).toThrow(GameError);
    expect(() => g.apply(s, "p1", { type: "challenge" }, rng)).toThrow(GameError);
    expect(() => g.apply(bid(s, "p1", 1, 2), "p2", { type: "exact" }, rng)).toThrow(GameError); // spotOn が無効
  });
});

describe("liarsdice: ダウト", () => {
  // 4 の数（ワイルドの 1 を含む）: p1 に 1, 4、p2 に 4 → 3 個
  const dice = { p1: [1, 4, 6], p2: [2, 4, 5] };

  it("数が足りなければ宣言した人が1個失い、その人から次のラウンド。全部の目が公開される", () => {
    const s = g.apply(bid(board(dice), "p1", 4, 4), "p2", { type: "challenge" }, rng);
    expect(s.lastRound).toMatchObject({ call: "challenge", caller: "p2", count: 3, loser: "p1", gainer: null, dice });
    expect(s.dice["p1"]).toHaveLength(2);
    expect(s.dice["p2"]).toHaveLength(3);
    expect(s.round).toBe(2);
    expect(s.bids).toEqual([]);
    expect(s.turnPlayer).toBe("p1");
    expect(view(s, null).lastRound).toEqual(s.lastRound);
  });

  it("ちょうど足りていればダウトした人が1個失う。ワイルドが無ければ 1 は数えない", () => {
    const s = g.apply(bid(board(dice), "p1", 3, 4), "p2", { type: "challenge" }, rng);
    expect(s.lastRound).toMatchObject({ count: 3, loser: "p2" });
    const plain = board(dice, { options: { ...opts, wildOnes: false } });
    const t = g.apply(bid(plain, "p1", 3, 4), "p2", { type: "challenge" }, rng);
    expect(t.lastRound).toMatchObject({ count: 2, loser: "p1" });
  });

  it("exact：当たれば1個取り戻し（上限 startDice）、外れれば1個失う", () => {
    const spot = { ...opts, spotOn: true, startDice: 3 };
    const s0 = board({ p1: [1, 4, 6], p2: [2, 4] }, { options: spot });
    const hit = g.apply(bid(s0, "p1", 3, 4), "p2", { type: "exact" }, rng);
    expect(hit.lastRound).toMatchObject({ call: "exact", loser: null, gainer: "p2", count: 3 });
    expect(hit.dice["p2"]).toHaveLength(3);
    expect(hit.turnPlayer).toBe("p2");
    const full = g.apply(bid(board({ p1: [1, 4], p2: [2, 4, 4] }, { options: spot }), "p1", 4, 4), "p2", { type: "exact" }, rng);
    expect(full.dice["p2"]).toHaveLength(3); // 上限で増えない
    const miss = g.apply(bid(s0, "p1", 2, 4), "p2", { type: "exact" }, rng);
    expect(miss.lastRound).toMatchObject({ loser: "p2", gainer: null });
    expect(miss.dice["p2"]).toHaveLength(1);
  });

  it("最後のダイスを失うと脱落し、残り1人で決着。点数は順位", () => {
    const s0 = board({ p1: [4], p2: [2], p3: [3, 3] });
    // p1 が 4 を 2 個と宣言 → p2 がダウト → p1 の負けで脱落、次は p2 から
    let s = g.apply(bid(s0, "p1", 2, 4), "p2", { type: "challenge" }, rng);
    expect(s.alive).toEqual(["p2", "p3"]);
    expect(s.out).toEqual({ p1: "eliminated" });
    expect(s.turnPlayer).toBe("p2");
    expect(g.result(s)).toBeNull();
    s = { ...s, dice: { ...s.dice, p2: [5], p3: [6, 6] } };
    s = g.apply(bid(s, "p2", 1, 5), "p3", { type: "challenge" }, rng); // 5 は 1 個あるので p3 の負け
    s = { ...s, dice: { ...s.dice, p2: [5], p3: [6] } };
    s = g.apply(bid(s, "p3", 2, 6), "p2", { type: "challenge" }, rng);
    expect(g.result(s)).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 2, p3: 1 } });
    expect(g.currentPlayers(s)).toEqual([]);
    expect(view(s, "p2").minBids).toEqual([null, null, null, null, null, null]);
  });
});

describe("liarsdice: 抜ける", () => {
  it("手番でない人が投了しても、ラウンド（目・宣言・手番）はそのまま続き、その人のダイスも数に入る", () => {
    const s1 = bid(board({ p1: [4, 4], p2: [1, 2], p3: [4, 6] }), "p1", 3, 4);
    const s = g.onResign!(s1, "p3", rng);
    expect(s.out).toEqual({ p3: "resigned" });
    expect(s.alive).toEqual(["p1", "p2"]);
    expect({ dice: s.dice, bids: s.bids, round: s.round, turnPlayer: s.turnPlayer }).toEqual({
      dice: s1.dice,
      bids: s1.bids,
      round: s1.round,
      turnPlayer: "p2",
    });
    expect(view(s, null)).toMatchObject({ totalDice: 6, diceCounts: { p1: 2, p2: 2, p3: 2 } });
    expect(view(s, "p3").myDice).toEqual([4, 6]);
    expect(() => g.onResign!(s, "p3", rng)).toThrow(GameError);
    // 4 は p1 に 2 個、p2 のワイルド 1 個、抜けた p3 に 1 個 → 4 個。ダウトした p2 の負け
    const t = g.apply(s, "p2", { type: "challenge" }, rng);
    expect(t.lastRound).toMatchObject({ count: 4, loser: "p2", dice: { p1: [4, 4], p2: [1, 2], p3: [4, 6] } });
    expect(t.dice["p3"]).toEqual([]);
    expect(t.inRound).toEqual(["p1", "p2"]);
    expect(view(t, null)).toMatchObject({ totalDice: 3, diceCounts: { p1: 2, p2: 1, p3: 0 } });
  });

  it("外れた人がもう抜けていれば誰もダイスを失わず、次のラウンドは席順でその次の人から", () => {
    const s1 = bid(board({ p1: [2, 2], p2: [3, 3], p3: [5, 5] }), "p1", 5, 6);
    const s = g.onResign!(s1, "p1", rng);
    const t = g.apply(s, "p2", { type: "challenge" }, rng);
    expect(t.lastRound).toMatchObject({ loser: "p1" });
    expect(view(t, null)).toMatchObject({ diceCounts: { p1: 0, p2: 2, p3: 2 } });
    expect(t.turnPlayer).toBe("p2");
  });

  it("手番の人が時間切れになると脱落し、同じラウンドを次の席の人が続ける。2人なら決着", () => {
    const s0 = bid(board({ p1: [1, 2], p2: [3, 4], p3: [5, 6] }), "p1", 2, 3);
    const s = g.onTimeout!({ ...s0 }, ["p2"], rng);
    expect(s.out).toEqual({ p2: "timedOut" });
    expect(s.turnPlayer).toBe("p3");
    expect(s.bids).toEqual(s0.bids);
    const end = g.onTimeout!(board({ p1: [1], p2: [2] }), ["p1"], rng);
    expect(g.result(end)).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
    expect(g.currentPlayers(end)).toEqual([]);
  });
});

describe("liarsdice: 隠し情報", () => {
  it("他人の目は view に出ず、自分の目だけが myDice に入る", () => {
    for (let seed = 0; seed < 20; seed++) {
      const s = g.init(seats(4), `h${seed}`, opts);
      expect(s.round).toBe(1);
      for (const p of s.players) expect(s.dice[p]).toHaveLength(5);
      const spectator = view(s, null);
      expect(spectator).not.toHaveProperty("myDice");
      expect(spectator).not.toHaveProperty("dice");
      expect(view(s, "p2").myDice).toEqual(s.dice["p2"]);
      expect(JSON.stringify(view(s, "p2"))).not.toContain(`"dice"`);
    }
  });

  it("最初の手番はシードで決まり、席によらず散らばる", () => {
    const firsts = new Set(Array.from({ length: 50 }, (_, i) => g.init(seats(4), `f${i}`, opts).turnPlayer));
    expect(firsts.size).toBe(4);
  });

  it("6 人・いろいろなオプションで練習相手どうしが決着する", () => {
    for (const o of [opts, { startDice: 1, wildOnes: false, spotOn: true }, { startDice: 10, wildOnes: true, spotOn: true }]) {
      for (let seed = 0; seed < 20; seed++) {
        const r = createRng(`b${seed}`);
        let s = g.init(seats(6), String(seed), o);
        let turn = 0;
        while (g.result(s) === null) {
          const pid = g.currentPlayers(s)[0]!;
          s = g.apply(s, pid, g.practiceAction!(s, pid, r), rngForTurn(String(seed), turn));
          expect(++turn).toBeLessThan(5000);
        }
        expect(g.result(s)!.winners).toHaveLength(1);
      }
    }
  });
});
