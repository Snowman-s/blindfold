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
  it("途中で投了するとそのラウンドは無効になって振り直し、手番の人から続く", () => {
    const s0 = g.init(seats(3), "r", opts);
    const first = s0.turnPlayer!;
    const s1 = bid(s0, first, 2, 3);
    const other = s1.players.find((p) => p !== first && p !== s1.turnPlayer)!;
    const s = g.onResign!(s1, other, rngForTurn("r", 1));
    expect(s.out).toEqual({ [other]: "resigned" });
    expect(s.dice[other]).toEqual([]);
    expect(s.round).toBe(2);
    expect(s.bids).toEqual([]);
    expect(s.lastRound).toBeNull();
    expect(s.turnPlayer).toBe(s1.turnPlayer);
    expect(() => g.onResign!(s, other, rng)).toThrow(GameError);
  });

  it("手番の人が時間切れになると脱落し、次の席の人から。2人なら決着", () => {
    const s0 = board({ p1: [1, 2], p2: [3, 4], p3: [5, 6] }, { turnPlayer: "p3" });
    const s = g.onTimeout!(s0, ["p3"], rng);
    expect(s.out).toEqual({ p3: "timedOut" });
    expect(s.turnPlayer).toBe("p1");
    const end = g.onTimeout!(board({ p1: [1], p2: [2] }), ["p1"], rng);
    expect(g.result(end)).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
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
