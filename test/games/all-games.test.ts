import { describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import { highcard, ROUNDS } from "../../src/games/highcard";
import { GameError } from "../../src/games/types";
import { createRng, rngForTurn } from "../../src/lib/rng";
import { gameRules, rulesMarkdown } from "../../src/lib/rules";
import { practiceAction } from "../../src/lib/practice";
import { gameExamples } from "../../src/lib/examples";
import { applyResign, applyTimeout, replay, type LogEntry } from "../../src/lib/replay";
import type { AnyGame } from "../../src/games/types";
import { elimination, type ElimState } from "../fixtures/elimination";

const PLAYERS = ["p1", "p2"];

/** ランダム Bot で1試合。同時手番でも、行動できるプレイヤーからランダムに選ぶ。 */
function playRandom(gameId: string, seed: string) {
  const game = games[gameId]!;
  const r = createRng(`bot:${seed}`);
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
      const { state } = playRandom(gameId, String(seed));
      const res = game.result(state);
      expect(res).not.toBeNull();
      expect(game.currentPlayers(state)).toEqual([]);
    }
  });

  it("練習相手どうしで 100 試合が例外なく、合法手だけで決着する", () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = createRng(`practice:${seed}`);
      let state = game.init(PLAYERS, String(seed));
      let turn = 0;
      while (game.result(state) === null) {
        const pid = game.currentPlayers(state)[0]!;
        const pick = practiceAction(game, state, pid, r);
        expect(pick).toBeDefined();
        expect(game.legalActions(state, pid)).toContainEqual(pick!.action);
        state = game.apply(state, pid, pick!.action, rngForTurn(String(seed), turn));
        expect(++turn).toBeLessThan(1000);
      }
    }
  });

  it("初期シード + 行動ログだけで完全に再現できる（JSON 往復を経ても）", () => {
    for (let seed = 0; seed < 100; seed++) {
      const { state, actions } = playRandom(gameId, String(seed));
      const log = JSON.parse(JSON.stringify({ game: gameId, seed: String(seed), players: PLAYERS, actions }));
      const r = replay(game, log);
      expect(r.state).toEqual(state);
      expect(r.result).toEqual(game.result(state));
    }
  });

  it("説明（docs）が揃っていて、行動の例は actionSchema を満たす", async () => {
    expect(game.docs.summary.length).toBeGreaterThan(0);
    expect(game.docs.rules.length).toBeGreaterThan(0);
    expect(game.docs.view.length).toBeGreaterThan(0);
    expect(game.docs.examples.length).toBeGreaterThan(0);
    for (const e of game.docs.examples) expect(game.actionSchema.safeParse(e.action).success).toBe(true);
    const r = await gameRules(game);
    expect(r.actionSchema).toHaveProperty("type", "object");
    expect(rulesMarkdown(r)).toContain(game.docs.rules);
  });

  it("view は全局面・全視点で viewSchema を満たす（余計なフィールドも無い）", () => {
    for (let seed = 0; seed < 100; seed++) {
      const { actions } = playRandom(gameId, String(seed));
      let state = game.init(PLAYERS, String(seed));
      const check = () => {
        for (const pid of [...PLAYERS, null]) {
          const v = game.view(state, pid);
          const r = game.viewSchema.safeParse(v);
          if (!r.success) throw new Error(`seed ${seed}, viewer ${pid}: ${r.error.message}`);
          expect(JSON.parse(JSON.stringify(r.data))).toEqual(v);
        }
      };
      check();
      for (const a of actions) {
        state = game.apply(state, a.player!, a.action, rngForTurn(String(seed), a.turn));
        check();
      }
    }
  });

  it("例（開始直後・1手後・決着後）は実際の view と同じ形で、決着後は end が続く", () => {
    const ex = gameExamples(game);
    const statuses = ex.states.map((e) => e.message.status);
    expect(statuses[0]).toBe("playing");
    expect(statuses.at(-1)).toBe("finished");
    for (const e of ex.states) {
      game.viewSchema.parse(e.message.view);
      if (e.message.status === "finished") {
        expect(e.message.currentPlayers).toEqual([]);
        expect(e.message.deadline).toBeNull();
        expect(e.message).not.toHaveProperty("legal");
      }
    }
    expect(ex.player.legal).toBeDefined();
    expect(ex.spectator).not.toHaveProperty("legal");
    // ログの例は再現でき、end と同じ結果になる
    const r = replay(game, ex.log);
    expect(r.result).toEqual({ winners: ex.end.winners, ...(ex.end.scores ? { scores: ex.end.scores } : {}) });
    expect(ex.log.actions.map((a) => a.turn)).toEqual(ex.log.actions.map((_, i) => i));
  });

  it("状態は JSON 往復で変わらず、apply は入力を変更しない", () => {
    const s = game.init(PLAYERS, "7");
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const before = JSON.stringify(s);
    const pid = game.currentPlayers(s)[0]!;
    game.apply(s, pid, game.legalActions(s, pid)[0], createRng("1"));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("時間切れ", () => {
  it("onTimeout 未定義のゲームは、時間切れのプレイヤーの負け", () => {
    const g = games["tictactoe"]!;
    const s = g.init(PLAYERS, "1");
    const r = applyTimeout(g, s, g.currentPlayers(s), PLAYERS, "1", 0);
    expect(r.forfeit).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
    expect(r.state).toBe(s);
  });
});

describe("highcard: 隠し情報", () => {
  const s0 = highcard.init(PLAYERS, "42");

  it("同時手番: 最初は両者が行動でき、1人が出すと残りの1人だけになる", () => {
    expect(highcard.currentPlayers(s0)).toEqual(["p1", "p2"]);
    const card = s0.hands["p1"]![0]!;
    const s1 = highcard.apply(s0, "p1", { card }, createRng("1"));
    expect(highcard.currentPlayers(s1)).toEqual(["p2"]);
    expect(highcard.legalActions(s1, "p1")).toEqual([]);
  });

  it("観戦者の view に手札・伏せ札が含まれない", () => {
    const card = s0.hands["p1"]![0]!;
    const s1 = highcard.apply(s0, "p1", { card }, createRng("1"));
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
    const s1 = highcard.apply(s0, "p1", { card }, createRng("1"));
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
    let s = highcard.apply(s0, "p1", { card: c1 }, createRng("1"));
    s = highcard.apply(s, "p2", { card: c2 }, createRng("1"));
    expect(s.round).toBe(1);
    expect(highcard.view(s, null)).toMatchObject({ history: [{ cards: { p1: c1, p2: c2 } }] });
    expect(highcard.currentPlayers(s)).toEqual(["p1", "p2"]);
  });

  it("不正な手は GameError", () => {
    const notMine = s0.hands["p2"]![0]!;
    expect(() => highcard.apply(s0, "p1", { card: notMine }, createRng("1"))).toThrow(GameError);
    const s1 = highcard.apply(s0, "p1", { card: s0.hands["p1"]![0]! }, createRng("1"));
    expect(() => highcard.apply(s1, "p1", { card: s1.hands["p1"]![0]! }, createRng("1"))).toThrow(GameError); // 二度出し
  });

  it("全ラウンドで ROUNDS 回の対戦になる", () => {
    const { state } = playRandom("highcard", "3");
    expect((state as { history: unknown[] }).history).toHaveLength(ROUNDS);
  });
});

describe("rng", () => {
  it("同じシードなら同じ列、違うシード・違うターンなら別の列", () => {
    const seq = (r: { next(): number }) => Array.from({ length: 8 }, () => r.next());
    expect(seq(createRng("abc"))).toEqual(seq(createRng("abc")));
    expect(seq(createRng("abc"))).not.toEqual(seq(createRng("abd")));
    expect(seq(rngForTurn("abc", 0))).not.toEqual(seq(rngForTurn("abc", 1)));
    for (const x of seq(createRng("range"))) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("int(n) はおおむね一様", () => {
    const r = createRng("uniform");
    const counts = Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) counts[r.int(10)]!++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });
});

describe("投了（applyResign / replay）", () => {
  it("onResign 未定義のゲームは投了者の負けで、状態は変えない", () => {
    const game = games["tictactoe"]!;
    const s = game.init(PLAYERS, "x");
    const r = applyResign(game, s, "p1", PLAYERS, "x", 0);
    expect(r.state).toEqual(s);
    expect(r.forfeit).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
  });

  it("onResign があればそれに従い、試合が続くこともある。リプレイでも同じ結果になる", () => {
    const players = ["p1", "p2", "p3"];
    const actions: LogEntry[] = [
      { turn: 0, player: null, action: null, at: 0, resign: "p2" }, // p2 が抜けても続く
      { turn: 1, player: "p1", action: { pass: true }, at: 0 },
      { turn: 2, player: null, action: null, at: 0, resign: "p1" }, // p1 が抜けて p3 の勝ち
    ];
    const mid = applyResign(elimination as AnyGame, elimination.init(players, "s"), "p2", players, "s", 0);
    expect(mid.forfeit).toBeNull();
    expect(elimination.result(mid.state as ElimState)).toBeNull();

    const r = replay(elimination as AnyGame, { game: elimination.id, seed: "s", players, actions });
    expect(r.turn).toBe(3);
    expect(r.result).toEqual({ winners: ["p3"] });
  });

  it("onResign が拒否した投了は GameError", () => {
    const s = elimination.init(["p1", "p2", "p3"], "s");
    const once = applyResign(elimination as AnyGame, s, "p2", ["p1", "p2", "p3"], "s", 0).state;
    expect(() => applyResign(elimination as AnyGame, once, "p2", ["p1", "p2", "p3"], "s", 1)).toThrow(GameError);
  });
});
