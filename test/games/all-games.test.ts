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
import { countdown } from "../fixtures/countdown";
import { guess } from "../fixtures/guess";
import { defaultGameOptions, parseGameOptions } from "../../src/lib/options";

const PLAYERS = ["p1", "p2"];

/** 既定のオプションで始める。 */
const initGame = (game: AnyGame, players: string[], seed: string, options = defaultGameOptions(game)) =>
  game.init(players, seed, options);

/**
 * ランダム Bot で1試合。同時手番でも、行動できるプレイヤーからランダムに選ぶ。
 * 合法手を列挙しないゲームは練習相手の打ち方で打つ。
 */
function playRandom(game: AnyGame, seed: string, options = defaultGameOptions(game)) {
  const r = createRng(`bot:${seed}`);
  let state = initGame(game, PLAYERS, seed, options);
  const actions: LogEntry[] = [];
  let turn = 0;
  while (game.result(state) === null) {
    const cur = game.currentPlayers(state);
    expect(cur.length).toBeGreaterThan(0);
    const pid = cur[r.int(cur.length)]!;
    let action: unknown;
    if (game.legalActions) {
      const legal = game.legalActions(state, pid);
      expect(legal.length).toBeGreaterThan(0);
      action = legal[r.int(legal.length)];
    } else {
      action = practiceAction(game, state, pid, r)!.action;
    }
    actions.push({ turn, player: pid, action, at: 0 });
    state = game.apply(state, pid, action, rngForTurn(seed, turn));
    turn++;
    expect(turn).toBeLessThan(1000);
  }
  return { state, actions };
}

// 登録済みのゲームに加えて、拡張点（ゲームオプション・合法手を列挙しない）を使うテスト用のゲームも同じ検査にかける
const suite: Record<string, AnyGame> = {
  ...games,
  [countdown.id]: countdown as AnyGame,
  [guess.id]: guess as AnyGame,
};

describe.each(Object.keys(suite))("%s", (gameId) => {
  const game = suite[gameId]!;

  it("legalActions か practiceAction のどちらかを定義している（練習相手が打てる）", () => {
    expect(game.legalActions !== undefined || game.practiceAction !== undefined).toBe(true);
  });

  it("optionsSchema は {} を受け付け、既定値は JSON 往復で変わらない。定義したら docs.options も書く", () => {
    const d = defaultGameOptions(game);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    if (game.optionsSchema) expect(game.docs.options?.length).toBeGreaterThan(0);
    else expect(d).toBeNull();
  });

  it("ランダム Bot で 100 試合が例外なく終わる", () => {
    for (let seed = 0; seed < 100; seed++) {
      const { state } = playRandom(game, String(seed));
      const res = game.result(state);
      expect(res).not.toBeNull();
      expect(game.currentPlayers(state)).toEqual([]);
    }
  });

  it("練習相手どうしで 100 試合が例外なく、合法手だけで決着する", () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = createRng(`practice:${seed}`);
      let state = initGame(game as AnyGame, PLAYERS, String(seed));
      let turn = 0;
      while (game.result(state) === null) {
        const pid = game.currentPlayers(state)[0]!;
        const pick = practiceAction(game, state, pid, r);
        expect(pick).toBeDefined();
        if (game.legalActions) expect(game.legalActions(state, pid)).toContainEqual(pick!.action);
        state = game.apply(state, pid, pick!.action, rngForTurn(String(seed), turn));
        expect(++turn).toBeLessThan(1000);
      }
    }
  });

  it("初期シード + ゲームオプション + 行動ログだけで完全に再現できる（JSON 往復を経ても）", () => {
    for (let seed = 0; seed < 100; seed++) {
      const gameOptions = defaultGameOptions(game);
      const { state, actions } = playRandom(game, String(seed), gameOptions);
      const log = JSON.parse(
        JSON.stringify({ game: gameId, rulesVersion: game.rulesVersion, seed: String(seed), gameOptions, players: PLAYERS, actions }),
      );
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
      const { actions } = playRandom(game, String(seed));
      let state = initGame(game as AnyGame, PLAYERS, String(seed));
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
    if (game.legalActions) expect(ex.player.legal).toBeDefined();
    else for (const e of ex.states) expect(e.message).not.toHaveProperty("legal");
    expect(ex.spectator).not.toHaveProperty("legal");
    expect(ex.player.gameOptions).toEqual(defaultGameOptions(game));
    // ログの例は再現でき、end と同じ結果になる
    const r = replay(game, ex.log);
    expect(r.result).toEqual({ winners: ex.end.winners, ...(ex.end.scores ? { scores: ex.end.scores } : {}) });
    expect(ex.log.actions.map((a) => a.turn)).toEqual(ex.log.actions.map((_, i) => i));
  });

  it("状態は JSON 往復で変わらず、apply は入力を変更しない", () => {
    const s = initGame(game as AnyGame, PLAYERS, "7");
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const before = JSON.stringify(s);
    const pid = game.currentPlayers(s)[0]!;
    game.apply(s, pid, practiceAction(game, s, pid, createRng("1"))!.action, createRng("1"));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("時間切れ", () => {
  it("onTimeout 未定義のゲームは、時間切れのプレイヤーの負け", () => {
    const g = games["tictactoe"]!;
    const s = initGame(g as AnyGame, PLAYERS, "1");
    const r = applyTimeout(g, s, g.currentPlayers(s), PLAYERS, "1", 0);
    expect(r.forfeit).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
    expect(r.state).toBe(s);
  });
});

describe("highcard: 隠し情報", () => {
  const s0 = highcard.init(PLAYERS, "42", null);

  it("同時手番: 最初は両者が行動でき、1人が出すと残りの1人だけになる", () => {
    expect(highcard.currentPlayers(s0)).toEqual(["p1", "p2"]);
    const card = s0.hands["p1"]![0]!;
    const s1 = highcard.apply(s0, "p1", { card }, createRng("1"));
    expect(highcard.currentPlayers(s1)).toEqual(["p2"]);
    expect(highcard.legalActions!(s1, "p1")).toEqual([]);
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
    const { state } = playRandom(highcard as AnyGame, "3");
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
    const s = initGame(game as AnyGame, PLAYERS, "x");
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
    const mid = applyResign(elimination as AnyGame, elimination.init(players, "s", null), "p2", players, "s", 0);
    expect(mid.forfeit).toBeNull();
    expect(elimination.result(mid.state as ElimState)).toBeNull();

    const r = replay(elimination as AnyGame, { game: elimination.id, rulesVersion: 1, seed: "s", gameOptions: null, players, actions });
    expect(r.turn).toBe(3);
    expect(r.result).toEqual({ winners: ["p3"] });
  });

  it("onResign が拒否した投了は GameError", () => {
    const s = elimination.init(["p1", "p2", "p3"], "s", null);
    const once = applyResign(elimination as AnyGame, s, "p2", ["p1", "p2", "p3"], "s", 0).state;
    expect(() => applyResign(elimination as AnyGame, once, "p2", ["p1", "p2", "p3"], "s", 1)).toThrow(GameError);
  });
});

describe("ゲーム固有のオプション", () => {
  it("オプションは init に渡り、シード + オプション + ログで再現できる", () => {
    const game = countdown as AnyGame;
    for (const raw of [{}, { start: 20 }, { start: 7, maxStep: 3 }]) {
      const gameOptions = game.optionsSchema!.parse(raw);
      for (let seed = 0; seed < 20; seed++) {
        const { state, actions } = playRandom(game, String(seed), gameOptions);
        const log = JSON.parse(
          JSON.stringify({ game: game.id, rulesVersion: 1, seed: String(seed), gameOptions, players: PLAYERS, actions }),
        );
        expect(replay(game, log).state).toEqual(state);
      }
    }
    expect((initGame(game, PLAYERS, "1", { start: 20, maxStep: 3 }) as { left: number }).left).toBe(20);
  });

  it("gameOptions の検証：既定値を補い、未知のキー・範囲外・オプションの無いゲームへの指定は拒否する", () => {
    expect(parseGameOptions(countdown as AnyGame, undefined)).toEqual({ ok: true, value: { start: 5, maxStep: 2 } });
    expect(parseGameOptions(countdown as AnyGame, { start: 9 })).toEqual({ ok: true, value: { start: 9, maxStep: 2 } });
    expect(parseGameOptions(countdown as AnyGame, { start: 9, extra: 1 }).ok).toBe(false);
    expect(parseGameOptions(countdown as AnyGame, { start: 0 }).ok).toBe(false);
    expect(parseGameOptions(games["tictactoe"]!, undefined)).toEqual({ ok: true, value: null });
    expect(parseGameOptions(games["tictactoe"]!, {}).ok).toBe(false);
  });

  it("rules にオプションの Schema・既定値・説明が載る。無いゲームは null", async () => {
    const r = await gameRules(countdown as AnyGame);
    expect(r.optionsSchema).toHaveProperty("type", "object");
    expect(r.defaultGameOptions).toEqual({ start: 5, maxStep: 2 });
    expect(rulesMarkdown(r)).toContain("## Game options");
    const t = await gameRules(games["tictactoe"]!);
    expect(t.optionsSchema).toBeNull();
    expect(rulesMarkdown(t)).not.toContain("## Game options");
  });
});

describe("合法手を列挙しないゲーム", () => {
  it("rules は listsLegalActions: false で、legal を使わないよう説明する", async () => {
    const r = await gameRules(guess as AnyGame);
    expect(r.listsLegalActions).toBe(false);
    expect(rulesMarkdown(r)).toContain("does **not** list legal moves");
    expect((await gameRules(games["tictactoe"]!)).listsLegalActions).toBe(true);
  });
});
