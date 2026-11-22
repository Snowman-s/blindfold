import { describe, expect, it } from "vitest";
import { frontier as g, isOver, MAX_MISSED, type FrontierState, type Order } from "../../src/games/frontier";
import { GameError, type AnyGame } from "../../src/games/types";
import { createRng, rngForTurn } from "../../src/lib/rng";
import { replay, type LogEntry } from "../../src/lib/replay";

const rng = createRng("1");
const opts = { maxRounds: 20, nodesPerPlayer: 6, fog: false };
const seats = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

/**
 * 手で作る小さな盤面。0 - 1 - 2 の一本道と 1 - 3。
 * 0: p1（7）、1: 中立（2）、2: p2（5）、3: p2（0）
 */
function board(over: Partial<FrontierState> = {}): FrontierState {
  return {
    players: ["p1", "p2"],
    alive: ["p1", "p2"],
    out: {},
    nodes: [
      { production: 1, owner: "p1", troops: 7 },
      { production: 2, owner: null, troops: 2 },
      { production: 1, owner: "p2", troops: 5 },
      { production: 1, owner: "p2", troops: 0 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
    ],
    round: 0,
    maxRounds: 10,
    fog: false,
    orders: { p1: null, p2: null },
    missed: { p1: 0, p2: 0 },
    lastMoves: [],
    ...over,
  };
}
const act = (s: FrontierState, pid: string, orders: Order[]) => g.apply(s, pid, { orders }, rng);
const both = (s: FrontierState, o1: Order[], o2: Order[]) => act(act(s, "p1", o1), "p2", o2);

/** 状態の不変条件：決着していなければ必ず誰かが行動できる（止まった状態にならない）。 */
function checkInvariant(s: FrontierState) {
  if (g.result(s) === null) expect(g.currentPlayers(s).length).toBeGreaterThan(0);
  else expect(g.currentPlayers(s)).toEqual([]);
  for (const n of s.nodes) expect(n.troops).toBeGreaterThanOrEqual(0);
  for (const p of s.alive) expect(s.nodes.some((n) => n.owner === p)).toBe(true);
}

describe("frontier: マップ", () => {
  it("どの人数・大きさでも連結で、席ごとに同じ条件（産出・本拠地の兵力・次数の組）", () => {
    for (let n = 2; n <= 4; n++) {
      for (let k = 3; k <= 12; k++) {
        for (let seed = 0; seed < 10; seed++) {
          const s = g.init(seats(n), `m${seed}`, { ...opts, nodesPerPlayer: k });
          expect(s.nodes).toHaveLength(n * k + 1);
          // 連結
          const seen = new Set([0]);
          const queue = [0];
          while (queue.length) {
            const v = queue.shift()!;
            for (const [a, b] of s.edges) {
              const w = a === v ? b : b === v ? a : -1;
              if (w >= 0 && !seen.has(w)) {
                seen.add(w);
                queue.push(w);
              }
            }
          }
          expect(seen.size).toBe(s.nodes.length);
          // 各席の本拠地から見た（距離, 産出, 守備兵）の多重集合が同じ
          const profile = (home: number) => {
            const dist = new Map([[home, 0]]);
            const q = [home];
            while (q.length) {
              const v = q.shift()!;
              for (const [a, b] of s.edges) {
                const w = a === v ? b : b === v ? a : -1;
                if (w >= 0 && !dist.has(w)) {
                  dist.set(w, dist.get(v)! + 1);
                  q.push(w);
                }
              }
            }
            return [...dist].map(([i, d]) => `${d}:${s.nodes[i]!.production}:${s.nodes[i]!.troops}`).sort().join(",");
          };
          const homes = s.players.map((p) => s.nodes.findIndex((x) => x.owner === p));
          expect(new Set(homes.map(profile)).size).toBe(1);
        }
      }
    }
  });

  it("人数の範囲外・重複は BAD_REQUEST", () => {
    expect(() => g.init(["p1"], "1", opts)).toThrow(GameError);
    expect(() => g.init(seats(5), "1", opts)).toThrow(GameError);
    expect(() => g.init(["p1", "p1"], "1", opts)).toThrow(GameError);
  });
});

describe("frontier: 解決", () => {
  it("docs の例：エッジ上で削り合い、到着先では最大勢力が差の分だけ残る", () => {
    // 0（p1, 7）と 2（p2, 5）を直接つないだ盤面
    const s0 = board({ edges: [[0, 1], [0, 2], [1, 2], [1, 3]] });
    const s = both(s0, [{ from: 0, to: 2, count: 6 }], [{ from: 2, to: 0, count: 2 }]);
    expect(s.round).toBe(1);
    expect(s.nodes[2]).toEqual({ production: 1, owner: "p1", troops: 1 + 1 }); // 3 対 4 → p1 が 1 残し、産出 +1
    expect(s.nodes[0]).toEqual({ production: 1, owner: "p1", troops: 1 + 1 });
    expect(s.lastMoves).toEqual([
      { player: "p1", from: 0, to: 2, count: 6 },
      { player: "p2", from: 2, to: 0, count: 2 },
    ]);
  });

  it("命令を出す順番に結果が依存しない", () => {
    const o1 = [{ from: 0, to: 1, count: 7 }];
    const o2 = [{ from: 2, to: 1, count: 5 }];
    const a = both(board(), o1, o2);
    const b = act(act(board(), "p2", o2), "p1", o1);
    expect(a).toEqual(b);
    // 7 対 5 対 中立 2 → p1 が 2 残す（+産出 2）
    expect(a.nodes[1]).toEqual({ production: 2, owner: "p1", troops: 4 });
  });

  it("最大が同数なら全滅し、持ち主は変わらない", () => {
    const s = both(board(), [{ from: 0, to: 1, count: 5 }], [{ from: 2, to: 1, count: 5 }]);
    expect(s.nodes[1]).toEqual({ production: 2, owner: null, troops: 0 });
  });

  it("同じ持ち主の逆向きの移動はぶつからない。中立は産出しない", () => {
    const s0 = board({
      nodes: [
        { production: 1, owner: "p1", troops: 3 },
        { production: 2, owner: "p1", troops: 4 },
        { production: 1, owner: "p2", troops: 5 },
        { production: 1, owner: null, troops: 1 },
      ],
    });
    const s = both(s0, [{ from: 0, to: 1, count: 3 }, { from: 1, to: 0, count: 4 }], []);
    expect(s.nodes[0]!.troops).toBe(4 + 1);
    expect(s.nodes[1]!.troops).toBe(3 + 2);
    expect(s.nodes[3]!.troops).toBe(1);
  });

  it("全ノードを失ったプレイヤーは脱落し、残り1人で決着", () => {
    const s = both(board(), [], [{ from: 2, to: 1, count: 5 }]);
    expect(s.nodes[1]!.owner).toBe("p2");
    const s0 = board({
      nodes: [
        { production: 1, owner: "p1", troops: 1 },
        { production: 2, owner: "p2", troops: 9 },
        { production: 1, owner: "p2", troops: 0 },
        { production: 1, owner: "p2", troops: 0 },
      ],
    });
    const end = both(s0, [], [{ from: 1, to: 0, count: 9 }]);
    expect(end.alive).toEqual(["p2"]);
    expect(end.out).toEqual({ p1: "eliminated" });
    expect(g.result(end)).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 5 } });
    checkInvariant(end);
  });

  it("maxRounds で終わり、産出の合計が多い方が勝つ（同点なら兵の多い方）", () => {
    let s = board({ maxRounds: 1 });
    s = both(s, [], []);
    expect(isOver(s)).toBe(true);
    // 産出は p1 = 1, p2 = 2
    expect(g.result(s)).toEqual({ winners: ["p2"], scores: { p1: 1, p2: 2 } });
    const tie = both(
      board({
        maxRounds: 1,
        nodes: [
          { production: 1, owner: "p1", troops: 7 },
          { production: 2, owner: null, troops: 2 },
          { production: 1, owner: "p2", troops: 5 },
          { production: 1, owner: null, troops: 0 },
        ],
      }),
      [],
      [],
    );
    expect(g.result(tie)!.winners).toEqual(["p1"]);
  });
});

describe("frontier: 命令の検証", () => {
  const bad = (orders: Order[], pid = "p1") => {
    try {
      act(board(), pid, orders);
    } catch (e) {
      expect(e).toBeInstanceOf(GameError);
      return (e as GameError).message;
    }
    throw new Error("accepted");
  };
  it("他人のノード・隣でない・兵が足りない・重複・存在しないノードは ILLEGAL_ACTION で、どの命令かを示す", () => {
    expect(bad([{ from: 2, to: 1, count: 1 }])).toMatch(/orders\[0\].*not yours/);
    expect(bad([{ from: 0, to: 2, count: 1 }])).toMatch(/not adjacent/);
    expect(bad([{ from: 0, to: 1, count: 5 }, { from: 0, to: 1, count: 1 }])).toMatch(/orders\[1\].*duplicate/);
    expect(bad([{ from: 0, to: 1, count: 8 }])).toMatch(/only 7 troops/);
    expect(bad([{ from: 99, to: 1, count: 1 }])).toMatch(/does not exist/);
  });
  it("同じラウンドに2回は出せない", () => {
    const s = act(board(), "p1", []);
    expect(() => act(s, "p1", [])).toThrow(/already sent/);
    expect(g.currentPlayers(s)).toEqual(["p2"]);
  });
});

describe("frontier: 時間切れ・投了", () => {
  it("時間切れはそのラウンドを保留扱い。連続で MAX_MISSED 回なら脱落してノードは中立に", () => {
    let s = act(board(), "p1", []);
    s = g.onTimeout!(s, ["p2"], rng);
    expect(s.round).toBe(1);
    expect(s.alive).toEqual(["p1", "p2"]);
    expect(s.missed.p2).toBe(1);
    // 出せば数え直し
    s = both(s, [], []);
    expect(s.missed.p2).toBe(0);
    for (let i = 0; i < MAX_MISSED; i++) s = g.onTimeout!(act(s, "p1", []), ["p2"], rng);
    expect(s.out).toEqual({ p2: "timedOut" });
    expect(s.nodes[2]).toMatchObject({ owner: null });
    expect(g.result(s)!.winners).toEqual(["p1"]);
    checkInvariant(s);
  });

  it("他の全員が出したあとで最後の1人が投了したら、そのラウンドを解決する", () => {
    const three = board({
      players: ["p1", "p2", "p3"],
      alive: ["p1", "p2", "p3"],
      nodes: [...board().nodes, { production: 1, owner: "p3", troops: 4 }],
      edges: [[0, 1], [1, 2], [1, 3], [3, 4]],
      orders: { p1: null, p2: null, p3: null },
      missed: { p1: 0, p2: 0, p3: 0 },
    });
    let s = act(three, "p1", [{ from: 0, to: 1, count: 6 }]);
    s = act(s, "p3", []);
    s = g.onResign!(s, "p2", rng);
    expect(s.round).toBe(1);
    expect(s.out).toEqual({ p2: "resigned" });
    expect(s.nodes[2]).toEqual({ production: 1, owner: null, troops: 5 }); // 中立は産出しない
    expect(s.nodes[1]!.owner).toBe("p1");
    expect(g.currentPlayers(s)).toEqual(["p1", "p3"]);
    checkInvariant(s);
  });

  it("残っている全員が同時に時間切れで抜けたら、誰も残らず引き分け（winners が空）", () => {
    let s = board();
    for (let i = 0; i < MAX_MISSED; i++) s = g.onTimeout!(s, ["p1", "p2"], rng);
    expect(s.alive).toEqual([]);
    expect(s.out).toEqual({ p1: "timedOut", p2: "timedOut" });
    expect(g.result(s)).toEqual({ winners: [], scores: { p1: 0, p2: 0 } });
    checkInvariant(s);
  });

  it("ラウンドの解決ではプレイヤーの持つノードは減らない（互いの最後のノードを取り合っても誰かが残る）", () => {
    // 0 - 1 - 2 の一本道で p1 は 0、p2 は 2 だけを持ち、1 は中立
    const s0 = board({
      nodes: [
        { production: 1, owner: "p1", troops: 5 },
        { production: 1, owner: null, troops: 0 },
        { production: 1, owner: "p2", troops: 5 },
        { production: 1, owner: null, troops: 0 },
      ],
    });
    const s = both(s0, [{ from: 0, to: 1, count: 5 }], [{ from: 2, to: 1, count: 5 }]);
    expect(s.alive).toEqual(["p1", "p2"]);
    checkInvariant(s);
  });

  it("投了した人が出していた命令は捨てる。抜けた人の投了は ILLEGAL_ACTION", () => {
    const three = board({
      players: ["p1", "p2", "p3"],
      alive: ["p1", "p2", "p3"],
      nodes: [...board().nodes, { production: 1, owner: "p3", troops: 4 }],
      edges: [[0, 1], [1, 2], [1, 3], [3, 4]],
      orders: { p1: null, p2: null, p3: null },
      missed: { p1: 0, p2: 0, p3: 0 },
    });
    let s = act(three, "p2", [{ from: 2, to: 1, count: 5 }]);
    s = g.onResign!(s, "p2", rng);
    s = act(act(s, "p1", []), "p3", []);
    expect(s.nodes[1]).toEqual({ production: 2, owner: null, troops: 2 });
    expect(() => g.onResign!(s, "p2", rng)).toThrow(GameError);
  });
});

describe("frontier: 霧", () => {
  const fogged = board({ fog: true });
  const troops = (v: unknown) => (v as { nodes: { troops: number | null }[] }).nodes.map((n) => n.troops);
  it("自分のノードとその隣だけ兵数が見え、観戦者には見えない。決着後は全員に見える", () => {
    expect(troops(g.view(fogged, "p1"))).toEqual([7, 2, null, null]);
    expect(troops(g.view(fogged, "p2"))).toEqual([null, 2, 5, 0]);
    expect(troops(g.view(fogged, null))).toEqual([null, null, null, null]);
    expect(troops(g.view(board(), null))).toEqual([7, 2, 5, 0]);
    const end = both({ ...fogged, maxRounds: 1 }, [], []);
    expect(troops(g.view(end, null))).toEqual([8, 2, 6, 1]);
  });
  it("見えない移動は lastMoves に出ず、相手の今ラウンドの命令は誰にも見えない", () => {
    const s0 = board({
      fog: true,
      nodes: [...board().nodes, { production: 1, owner: "p2", troops: 3 }],
      edges: [[0, 1], [1, 2], [1, 3], [3, 4]],
    });
    const s = both(s0, [], [{ from: 4, to: 3, count: 3 }]);
    expect((g.view(s, "p1") as { lastMoves: unknown[] }).lastMoves).toEqual([]);
    expect((g.view(s, "p2") as { lastMoves: unknown[] }).lastMoves).toHaveLength(1);
    const pending = act(board(), "p1", [{ from: 0, to: 1, count: 3 }]);
    for (const viewer of ["p2", null]) {
      const v = g.view(pending, viewer) as Record<string, unknown>;
      expect(JSON.stringify(v)).not.toContain('"count":3');
      expect(v.submitted).toEqual({ p1: true, p2: false });
    }
    expect((g.view(pending, "p1") as { myOrders: unknown }).myOrders).toEqual([{ from: 0, to: 1, count: 3 }]);
  });
});

describe.each([3, 4])("frontier: %i 人", (n) => {
  const players = seats(n);
  const vg: AnyGame = g;

  it("練習相手どうし（時間切れ・投了を混ぜて）100 試合が止まらずに終わり、ログから再現でき、全視点で viewSchema を満たす", () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = createRng(`multi:${seed}`);
      const gameSeed = `seed${seed}`;
      const options = { ...opts, fog: seed % 2 === 0 };
      let s = g.init(players, gameSeed, options);
      const log: LogEntry[] = [];
      let turn = 0;
      const check = () => {
        checkInvariant(s);
        for (const v of [...players, null]) vg.viewSchema.parse(g.view(s, v));
      };
      check();
      while (g.result(s) === null) {
        const cur = g.currentPlayers(s);
        const x = r.next();
        if (x < 0.02) {
          const pid = s.alive[r.int(s.alive.length)]!;
          s = g.onResign!(s, pid, rngForTurn(gameSeed, turn));
          log.push({ turn, player: null, action: null, at: 0, resign: pid });
        } else if (x < 0.06) {
          s = g.onTimeout!(s, cur, rngForTurn(gameSeed, turn));
          log.push({ turn, player: null, action: null, at: 0, timeout: cur });
        } else {
          const pid = cur[r.int(cur.length)]!;
          const action = g.practiceAction!(s, pid, r);
          s = g.apply(s, pid, action, rngForTurn(gameSeed, turn));
          log.push({ turn, player: pid, action, at: 0 });
        }
        turn++;
        check();
        expect(turn).toBeLessThan(1000);
      }
      const replayed = replay(vg, JSON.parse(JSON.stringify({ game: g.id, rulesVersion: 1, seed: gameSeed, gameOptions: options, players, actions: log })));
      expect(replayed.state).toEqual(s);
      expect(replayed.result).toEqual(g.result(s));
    }
  }, 60_000);
});
