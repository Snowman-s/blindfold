import { describe, expect, it } from "vitest";
import { draftcards as g, internals, type DraftCardsState } from "../../src/games/draftcards";
import { cards } from "../../src/games/draftcards/cards";
import { PACK_SIZE, ROUNDS, START } from "../../src/games/draftcards/constants";
import type { DraftCardsAction } from "../../src/games/draftcards/schemas";
import { GameError } from "../../src/games/types";
import { createRng, rngForTurn } from "../../src/lib/rng";
import { replay, type LogEntry } from "../../src/lib/replay";

// 使う札（cards.ts）:
// #1 場 2 回 A+1 / #2 費用 B2・場 4 回 B+1 / #5 場 2 回 C+1 / #8 費用 B3・場 3 回 B+1×場 / #20 場 1 回 C+1 B+1
// #23 一番少ないもの +1 / #24 C+1×場・A+1 / #37 費用 A1 B3・A+3 C+3 / #43 費用 B1・move C1・C+1
// #44 費用 B1・選んだ人 B−1・C+2（order 12）/ #51 remove・B+2（order 14）/ #57 cancel・A+1（order 2）

const rng = createRng("1");
const seats = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
type Res = { A: number; B: number; C: number };

/** プレイ中（ラウンド 1）の局面を直接作る。 */
function board(n: number, over: Partial<DraftCardsState> = {}): DraftCardsState {
  const players = seats(n);
  const each = <T>(f: () => T) => Object.fromEntries(players.map((p) => [p, f()]));
  return {
    players,
    out: {},
    phase: "play",
    pick: PACK_SIZE,
    round: 1,
    packs: players.map(() => []),
    hands: each(() => [] as number[]),
    picks: {},
    acts: {},
    resources: each(() => ({ ...START })),
    fields: each(() => [] as { card: number; times: number }[]),
    lastRound: null,
    ...over,
  };
}
const act = (s: DraftCardsState, pid: string, a: DraftCardsAction) => g.apply(s, pid, a, rng);
const res = (s: DraftCardsState, pid: string): Res => s.resources[pid]!;
type View = Record<string, unknown> & { lastRound: { round: number; steps: Record<string, unknown>[] } | null };
const view = (s: DraftCardsState, pid: string | null) => g.view(s, pid) as View;
const playStep = (s: DraftCardsState, id: number) => s.lastRound!.steps.find((x) => x.kind === "play" && x.card === id)!;

describe("draftcards: 解決", () => {
  it("費用を払えない札は何も起こさず捨てられる", () => {
    let s = board(2, { hands: { p1: [37], p2: [1] }, resources: { p1: { A: 3, B: 2, C: 1 }, p2: { ...START } } });
    s = act(s, "p1", { type: "play", card: 37 });
    s = act(s, "p2", { type: "discard", card: 1 });
    expect(playStep(s, 37)).toMatchObject({ paid: false, effects: [], placed: false, changes: [] });
    expect(s.hands["p1"]).toEqual([]);
    expect(res(s, "p1")).toEqual({ A: 3, B: 3, C: 1 }); // ラウンド 2 の初めの B+1 だけ
  });

  it("order の早い札が先に効き、後の札の費用が払えなくなることがある", () => {
    let s = board(2, { hands: { p1: [2], p2: [44] } });
    s = act(s, "p1", { type: "play", card: 2 }); // 費用 B2（order 60）
    s = act(s, "p2", { type: "play", card: 44, chosen: "p1" }); // p1 の B −1（order 12）
    expect(playStep(s, 44)).toMatchObject({ paid: true });
    expect(playStep(s, 2)).toMatchObject({ paid: false, placed: false });
    expect(s.fields["p1"]).toEqual([]);
  });

  it("cancel はほかの人の札（remove も）を止めるが、自分の札と次のラウンドの each は止めない", () => {
    let s = board(3, {
      hands: { p1: [44], p2: [57], p3: [51] },
      fields: { p1: [], p2: [{ card: 1, times: 2 }], p3: [] },
    });
    s = act(s, "p1", { type: "play", card: 44, chosen: "p2" });
    s = act(s, "p2", { type: "play", card: 57 });
    s = act(s, "p3", { type: "play", card: 51, target: 1 });
    expect(playStep(s, 44)).toMatchObject({ effects: [{ index: 0, canceled: ["p2"], changes: [] }, { index: 1, canceled: [] }] });
    expect(playStep(s, 51)).toMatchObject({ effects: [{ index: 0, canceled: ["p2"] }, { index: 1 }] });
    expect(s.fields["p2"]).toEqual([{ card: 1, times: 1 }]); // 外されず、ラウンド 2 の初めに効いた
    expect(res(s, "p1")).toEqual({ A: 3, B: 2, C: 3 }); // B2 −1（費用）+1、C+2 は自分への効果なので効く
    expect(res(s, "p2")).toEqual({ A: 5, B: 3, C: 1 }); // 自分の cancel の A+1、場の A+1、B は減らない
    expect(res(s, "p3")).toEqual({ A: 3, B: 5, C: 1 });
  });

  it("per: field は now では置く前の場、each では去る前の場（自分を含む）を数える", () => {
    let s = board(2, {
      hands: { p1: [24], p2: [23] },
      fields: { p1: [{ card: 1, times: 1 }, { card: 8, times: 1 }], p2: [] },
    });
    s = act(s, "p1", { type: "play", card: 24 });
    s = act(s, "p2", { type: "play", card: 23 });
    expect(playStep(s, 24)).toMatchObject({ effects: [{ changes: [{ player: "p1", res: "C", delta: 2 }] }, {}] });
    // ラウンド 2 の初め: #1 が A+1 して残り 0、それでも #8 は 2 枚と数えて B+2。そのあと 2 枚とも去る
    const each8 = s.lastRound!.steps.find((x) => x.kind === "each" && x.card === 8)!;
    expect(each8).toMatchObject({ round: 2, times: 0, effects: [{ changes: [{ player: "p1", res: "B", delta: 2 }] }] });
    expect(s.lastRound!.steps.filter((x) => x.kind === "leave").map((x) => [x.card, x.why])).toEqual([
      [1, "expired"],
      [8, "expired"],
    ]);
    expect(s.fields["p1"]).toEqual([]);
    expect(res(s, "p1")).toEqual({ A: 5, B: 5, C: 3 });
  });

  it("least は同点の全部に足し、move は持っている分だけ取る", () => {
    let s = board(2, {
      hands: { p1: [23], p2: [43] },
      resources: { p1: { A: 1, B: 1, C: 0 }, p2: { A: 3, B: 2, C: 1 } },
    });
    s = act(s, "p1", { type: "play", card: 23 });
    s = act(s, "p2", { type: "play", card: 43, chosen: "p1" }); // order 38 で先に解決。p1 の C は 0
    expect(playStep(s, 43)).toMatchObject({ effects: [{ changes: [] }, { changes: [{ player: "p2", res: "C", delta: 1 }] }] });
    expect(playStep(s, 23)).toMatchObject({ effects: [{ changes: [{ player: "p1", res: "C", delta: 1 }] }] });
    let t = board(2, { hands: { p1: [23], p2: [1] }, resources: { p1: { A: 1, B: 1, C: 2 }, p2: { ...START } } });
    t = act(t, "p1", { type: "play", card: 23 });
    t = act(t, "p2", { type: "discard", card: 1 });
    expect(playStep(t, 23)).toMatchObject({
      effects: [{ changes: [{ player: "p1", res: "A", delta: 1 }, { player: "p1", res: "B", delta: 1 }] }],
    });
  });

  it("場が上限を超えると、置いたあとにいちばん古い札が去る", () => {
    let s = board(2, {
      hands: { p1: [2], p2: [23] },
      fields: { p1: [{ card: 1, times: 2 }, { card: 5, times: 2 }, { card: 20, times: 1 }], p2: [] },
    });
    s = act(s, "p1", { type: "play", card: 2 });
    s = act(s, "p2", { type: "play", card: 23 });
    const steps = s.lastRound!.steps;
    const i = steps.findIndex((x) => x.kind === "play" && x.card === 2);
    expect(steps[i + 1]).toEqual({ kind: "leave", round: 1, player: "p1", card: 1, why: "full" });
    expect(s.fields["p1"]).toEqual([{ card: 5, times: 1 }, { card: 2, times: 3 }]); // #20 は残り 0 で去った
  });

  it("対象の札が解決までに場を去っていたら remove は何もしない（費用と残りの効果はそのまま）", () => {
    let s = board(3, { hands: { p1: [51], p2: [5], p3: [23] }, fields: { p1: [], p2: [{ card: 1, times: 2 }], p3: [] } });
    s = act(s, "p1", { type: "play", card: 51, target: 1 });
    s = act(s, "p3", { type: "play", card: 23 });
    s = g.onResign!(s, "p2", rng); // p2 が抜けて場が空になり、残り全員が送り終えたので解決する
    expect(playStep(s, 51)).toMatchObject({ paid: true, effects: [{ canceled: [], changes: [] }, { changes: [{ res: "B", delta: 2 }] }] });
    expect(s.round).toBe(2);
  });

  it("最後のラウンドのあとは場の札が効かずに終わり、min、同点なら合計で順位を決める", () => {
    let s = board(3, {
      round: ROUNDS,
      hands: { p1: [5], p2: [23], p3: [20] },
      fields: { p1: [{ card: 1, times: 2 }], p2: [], p3: [] },
      resources: { p1: { A: 4, B: 3, C: 4 }, p2: { A: 2, B: 9, C: 3 }, p3: { A: 5, B: 3, C: 3 } },
    });
    s = act(s, "p1", { type: "discard", card: 5 });
    s = act(s, "p2", { type: "play", card: 23 });
    s = act(s, "p3", { type: "discard", card: 20 });
    expect(s.phase).toBe("over");
    expect(g.currentPlayers(s)).toEqual([]);
    expect(res(s, "p1")).toEqual({ A: 4, B: 4, C: 4 });
    expect(g.result(s)).toEqual({ winners: ["p1"], scores: { p1: 4, p2: 3, p3: 3 } });
  });
});

describe("draftcards: 行動の検証と合法手", () => {
  it("選べるのは隣の人だけ（4 人戦の向かいは選べない）、隣が抜けると隣が変わる", () => {
    const s = board(4, { hands: { p1: [44], p2: [], p3: [], p4: [] } });
    expect(internals.neighborsOf(s, "p1")).toEqual(["p4", "p2"]);
    expect(() => act(s, "p1", { type: "play", card: 44, chosen: "p3" })).toThrow(GameError);
    expect(() => act(s, "p1", { type: "play", card: 44 })).toThrow(GameError);
    expect(g.legalActions!(s, "p1")).toEqual([
      { type: "play", card: 44, chosen: "p4" },
      { type: "play", card: 44, chosen: "p2" },
      { type: "discard", card: 44 },
    ]);
    const t = g.onResign!(s, "p2", rng);
    expect(internals.neighborsOf(t, "p1")).toEqual(["p4", "p3"]);
    expect(view(t, null).neighbors).toEqual({ p1: ["p4", "p3"], p3: ["p1", "p4"], p4: ["p3", "p1"] });
  });

  it("隣の場に札が無ければ、札を選ぶ札は出せない（捨てるのはよい）", () => {
    const s = board(2, { hands: { p1: [51], p2: [] } });
    expect(g.legalActions!(s, "p1")).toEqual([{ type: "discard", card: 51 }]);
    expect(() => act(s, "p1", { type: "play", card: 51, target: 1 })).toThrow(GameError);
  });

  it("手番の重複・手札に無い札・ドラフト中の play は拒否する", () => {
    let s = board(2, { hands: { p1: [1, 5], p2: [2] } });
    expect(() => act(s, "p1", { type: "discard", card: 2 })).toThrow(GameError);
    expect(() => act(s, "p1", { type: "pick", card: 1 })).toThrow(GameError);
    s = act(s, "p1", { type: "discard", card: 1 });
    expect(() => act(s, "p1", { type: "discard", card: 5 })).toThrow(GameError);
    expect(g.currentPlayers(s)).toEqual(["p2"]);
    expect(g.legalActions!(s, "p1")).toEqual([]);
    const d = g.init(seats(2), "x", null);
    expect(() => act(d, "p1", { type: "discard", card: d.packs[0]![0]! })).toThrow(GameError);
  });
});

describe("draftcards: 隠し情報", () => {
  it("観戦者に pack・hand は無く、送った行動は解決まで誰にも見えない", () => {
    let s = board(2, { hands: { p1: [1, 5], p2: [2, 20] } });
    expect(view(s, null)).not.toHaveProperty("pack");
    expect(view(s, null)).not.toHaveProperty("hand");
    const before = { p2: view(s, "p2"), spec: view(s, null) };
    s = act(s, "p1", { type: "discard", card: 1 });
    expect(view(s, "p2")).toEqual(before.p2);
    expect(view(s, null)).toEqual(before.spec);
    s = act(s, "p2", { type: "play", card: 20 });
    const step = (v: View) => v.lastRound!.steps.find((x) => x.kind === "discard");
    expect(step(view(s, "p1"))).toMatchObject({ player: "p1", card: 1 });
    expect(step(view(s, "p2"))).toMatchObject({ player: "p1", card: null });
    expect(step(view(s, null))).toMatchObject({ player: "p1", card: null });
  });

  it("ドラフト中、ほかの人のパックと選んだ札は見えない", () => {
    let s = g.init(seats(3), "seed", null);
    const v = view(s, "p1");
    expect(v.pack).toEqual([...s.packs[0]!].sort((a, b) => a - b));
    s = act(s, "p2", { type: "pick", card: s.packs[1]![0]! });
    expect(JSON.stringify(view(s, "p1"))).not.toContain(JSON.stringify(s.packs[1]));
    expect(view(s, "p1")).toEqual(v);
  });
});

describe("draftcards: ドラフト", () => {
  it("パックは重ならない札で配られ、全員が選ぶと次の席へ回る。6 回選ぶと最後の 1 枚は自動で取ってプレイへ", () => {
    let s = g.init(seats(3), "deal", null);
    const all = s.packs.flat();
    expect(s.packs.map((p) => p.length)).toEqual([PACK_SIZE, PACK_SIZE, PACK_SIZE]);
    expect(new Set(all).size).toBe(all.length);
    const p1Pack = s.packs[0]!;
    for (const [i, p] of seats(3).entries()) s = act(s, p, { type: "pick", card: s.packs[i]![0]! });
    expect(s.packs[1]).toEqual(p1Pack.slice(1)); // p1 のパックは p2 へ
    expect(s.pick).toBe(2);
    for (let k = 2; k < PACK_SIZE; k++) for (const [i, p] of seats(3).entries()) s = act(s, p, { type: "pick", card: s.packs[i]![0]! });
    expect(s.phase).toBe("play");
    expect(s.round).toBe(1);
    expect(Object.values(s.hands).map((h) => h.length)).toEqual([PACK_SIZE, PACK_SIZE, PACK_SIZE]);
    expect(new Set(Object.values(s.hands).flat())).toEqual(new Set(all));
    expect(res(s, "p1")).toEqual({ ...START, B: START.B + 1 });
    expect(s.lastRound).toBeNull();
  });

  it("ドラフト中に時間切れになった席は自動で取り続け、パックが回る", () => {
    let s = g.init(seats(3), "t", null);
    s = act(s, "p1", { type: "pick", card: s.packs[0]![0]! });
    s = act(s, "p2", { type: "pick", card: s.packs[1]![0]! });
    s = g.onTimeout!(s, ["p3"], rngForTurn("t", 2));
    expect(s.out).toEqual({ p3: "timedOut" });
    expect(s.pick).toBe(2);
    expect(s.hands["p3"]).toHaveLength(1);
    expect(g.currentPlayers(s)).toEqual(["p1", "p2"]);
    while (s.phase === "pick") for (const p of g.currentPlayers(s)) s = act(s, p, g.legalActions!(s, p)[0]!);
    expect(s.hands["p3"]).toHaveLength(PACK_SIZE);
    expect(g.currentPlayers(s)).toEqual(["p1", "p2"]);
  });

  it("ドラフト中でも残り 1 人になればその人の勝ち。全員が同時に抜けたら勝者なし", () => {
    const s = g.init(seats(2), "x", null);
    expect(g.result(g.onResign!(s, "p2", rng))).toMatchObject({ winners: ["p1"] });
    expect(g.result(g.onTimeout!(s, ["p1", "p2"], rng))).toEqual({ winners: [], scores: { p1: 1, p2: 1 } });
  });
});

describe("draftcards: 抜ける", () => {
  it("行動を送ったあとに投了すると、その行動は無視され、場は空になりリソースは止まる", () => {
    let s = board(3, { hands: { p1: [5], p2: [1], p3: [20] }, fields: { p1: [{ card: 1, times: 2 }], p2: [], p3: [] } });
    s = act(s, "p1", { type: "discard", card: 5 });
    s = g.onResign!(s, "p1", rng);
    expect(s.fields["p1"]).toEqual([]);
    s = act(s, "p2", { type: "discard", card: 1 });
    s = act(s, "p3", { type: "discard", card: 20 });
    expect(s.round).toBe(2);
    expect(res(s, "p1")).toEqual(START);
    expect(s.lastRound!.steps.some((x) => "player" in x && x.player === "p1")).toBe(false);
    expect(() => g.onResign!(s, "p1", rng)).toThrow(GameError);
    expect(() => act(s, "p1", { type: "discard", card: 5 })).toThrow(GameError);
  });

  it("抜けた人は順位が付かない（残った人だけで勝者を決める）", () => {
    let s = board(3, {
      round: ROUNDS,
      hands: { p1: [5], p2: [1], p3: [20] },
      resources: { p1: { A: 9, B: 9, C: 9 }, p2: { A: 1, B: 1, C: 1 }, p3: { A: 2, B: 2, C: 2 } },
    });
    s = g.onResign!(s, "p1", rng);
    s = act(s, "p2", { type: "discard", card: 1 });
    s = act(s, "p3", { type: "discard", card: 20 });
    expect(g.result(s)).toEqual({ winners: ["p3"], scores: { p1: 9, p2: 1, p3: 2 } });
  });
});

describe("draftcards: 3〜4 人で通しで遊ぶ", () => {
  for (const n of [3, 4]) {
    it(`${n} 人: ランダムと練習相手で 50 試合ずつ決着し、view は全視点で viewSchema を満たし、ログから再現できる`, () => {
      const players = seats(n);
      for (const mode of ["random", "practice"] as const) {
        for (let seed = 0; seed < 50; seed++) {
          const r = createRng(`${mode}:${seed}`);
          let s = g.init(players, String(seed), null);
          const actions: LogEntry[] = [];
          let turn = 0;
          while (g.result(s) === null) {
            const cur = g.currentPlayers(s);
            const pid = cur[r.int(cur.length)]!;
            const legal = g.legalActions!(s, pid);
            const a = mode === "random" ? legal[r.int(legal.length)]! : g.practiceAction!(s, pid, r);
            expect(legal).toContainEqual(a);
            actions.push({ turn, player: pid, action: a, at: 0 });
            s = g.apply(s, pid, a, rngForTurn(String(seed), turn++));
            for (const v of [...players, null]) {
              const parsed = g.viewSchema.safeParse(g.view(s, v));
              if (!parsed.success) throw new Error(`${mode} ${seed} ${v}: ${parsed.error.message}`);
            }
          }
          expect(turn).toBe(n * (PACK_SIZE - 1) + n * ROUNDS);
          const log = { game: g.id, rulesVersion: g.rulesVersion, seed: String(seed), gameOptions: null, players, actions };
          expect(replay(g as never, JSON.parse(JSON.stringify(log))).state).toEqual(s);
        }
      }
    });
  }

  it("catalog の札はすべて 1 回以上どこかの試合で配られる（配り方に偏りが無い）", () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 50; seed++) for (const p of g.init(seats(4), String(seed), null).packs) for (const id of p) seen.add(id);
    expect(seen.size).toBe(cards.length);
  });
});
