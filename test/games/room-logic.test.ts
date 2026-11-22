import { describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import { highcard } from "../../src/games/highcard";
import type { AnyGame } from "../../src/games/types";
import {
  decideAction,
  decideResign,
  decideTimeout,
  nextDeadline,
  nextPersistRetry,
  planAlarm,
  outcomeOf,
  practiceBotCount,
  rematchSeats,
  roomState,
  settle,
  stateMessage,
  wantedAlarm,
  type AlarmFacts,
  type RoomCore,
} from "../../src/room/logic";
import { createRng } from "../../src/lib/rng";
import { elimination } from "../fixtures/elimination";
import { guess } from "../fixtures/guess";
import { FINISHED_ROOM_TTL_MS, WAITING_ROOM_TTL_MS } from "../../src/lib/options";

// GameRoom の状態遷移は DO を起こさずに Node で確かめられる（src/room/logic.ts は Cloudflare 非依存）
const ttt = games["tictactoe"]!;
const P = ["p1", "p2"];

describe("decideAction", () => {
  const snap = { turn: 0, state: ttt.init(P, "s", null) };
  it("turn 違いは STALE_TURN、形の違いは BAD_REQUEST、ゲームの拒否はそのコード", () => {
    expect(decideAction(ttt, snap, "p1", 1, { cell: 0 }, "s")).toMatchObject({ ok: false, status: 409, code: "STALE_TURN" });
    expect(decideAction(ttt, snap, "p1", 0, { cell: 99 }, "s")).toMatchObject({ ok: false, status: 400, code: "BAD_REQUEST" });
    expect(decideAction(ttt, snap, "p2", 0, { cell: 0 }, "s")).toMatchObject({ ok: false, status: 403, code: "NOT_YOUR_TURN" });
  });
  it("成功なら検証済みの行動と次の状態（入力の状態は変えない）", () => {
    const before = JSON.stringify(snap.state);
    const r = decideAction(ttt, snap, "p1", 0, { cell: 4 }, "s");
    expect(r.ok && r.data.action).toEqual({ cell: 4 });
    expect(r.ok && (ttt.view(r.data.next, null) as { board: unknown[] }).board[4]).toBe("X");
    expect(JSON.stringify(snap.state)).toBe(before);
  });
});

describe("decideResign / decideTimeout", () => {
  it("既定は forfeit で決着し、endReason が付く", () => {
    const snap = { turn: 0, state: ttt.init(P, "s", null) };
    const r = decideResign(ttt, snap, "p1", P, "s");
    expect(r).toMatchObject({ ok: true, data: { forfeit: { winners: ["p2"] }, endReason: "resign" } });
    const t = decideTimeout(ttt, snap, P, "s");
    expect(t.pending).toEqual(["p1"]);
    expect(t.resolution).toMatchObject({ forfeit: { winners: ["p2"] }, endReason: "timeout" });
  });
  it("onResign で試合が続くときは endReason なし。拒否された投了はそのコード", () => {
    const g = elimination as AnyGame;
    const players = ["p1", "p2", "p3"];
    const snap = { turn: 0, state: g.init(players, "s", null) };
    const r = decideResign(g, snap, "p2", players, "s");
    expect(r).toMatchObject({ ok: true, data: { forfeit: null, endReason: null } });
    const again = decideResign(g, { turn: 1, state: r.ok ? r.data.state : null }, "p2", players, "s");
    expect(again.ok).toBe(false);
  });
});

describe("nextDeadline", () => {
  it("同時手番で行動できる人が減っただけなら延ばさず、手番が移ったらリセットする", () => {
    expect(nextDeadline(["p1", "p2"], 5000, ["p2"], 1000, 300)).toBe(5000);
    expect(nextDeadline(["p1"], 5000, ["p2"], 1000, 300)).toBe(1300);
    expect(nextDeadline(["p1", "p2"], 5000, ["p1", "p2"], 1000, 300)).toBe(1300); // 新しいラウンド
    expect(nextDeadline(null, 5000, ["p2"], 1000, 300)).toBe(1300);
    expect(nextDeadline(["p1", "p2"], null, ["p2"], 1000, 300)).toBe(1300);
  });
});

describe("roomState / stateMessage", () => {
  const core = (game: AnyGame, state: unknown): RoomCore => ({
    game,
    status: "playing",
    rulesVersion: 1,
    gameOptions: null,
    players: P,
    snap: { turn: 0, state },
    currentPlayers: game.currentPlayers(state),
    deadline: 10,
    result: null,
    rematch: null,
  });
  it("legal は行動できるプレイヤーにだけ付き、合法手を列挙しないゲームには付かない", () => {
    const c = core(highcard as AnyGame, highcard.init(P, "s", null));
    expect(roomState(c, "p1", 0).legal).toBeDefined();
    expect(roomState(c, null, 0)).not.toHaveProperty("legal");
    const g = core(guess as AnyGame, guess.init(P, "s", null));
    expect(roomState(g, "p1", 0)).not.toHaveProperty("legal");
  });
  it("WS の state は REST の状態に type を付けただけ", () => {
    const s = roomState(core(ttt, ttt.init(P, "s", null)), "p1", 7);
    expect(stateMessage(s)).toEqual({ type: "state", ...s });
  });
});

describe("その他", () => {
  it("再戦の席は人間の席を1つずらす", () => {
    expect(rematchSeats(["p1", "p2"])).toEqual({ p1: "p2", p2: "p1" });
    expect(rematchSeats(["p1", "p2", "p3"])).toEqual({ p1: "p3", p2: "p1", p3: "p2" });
  });
  it("練習相手の数は seats（省略時は minPlayers）までの空席", () => {
    expect(practiceBotCount(ttt, 1, { practice: true })).toBe(1);
    expect(practiceBotCount(ttt, 2, { practice: true })).toBe(0);
    expect(practiceBotCount(ttt, 1, {})).toBe(0);
    const elim = elimination as AnyGame; // 2〜3人
    expect(practiceBotCount(elim, 1, { practice: true })).toBe(1);
    expect(practiceBotCount(elim, 1, { practice: true, seats: 3 })).toBe(2);
    expect(practiceBotCount(elim, 3, { practice: true, seats: 3 })).toBe(0);
  });
  it("結果：forfeit に引き分けはない", () => {
    expect(outcomeOf({ winners: [] }, false, "p1")).toBe("draw");
    expect(outcomeOf({ winners: [] }, true, "p1")).toBe("loss");
    expect(outcomeOf({ winners: ["p1"] }, true, "p1")).toBe("win");
  });
});

describe("settle", () => {
  const base = { game: ttt, forfeit: null, prev: null, prevDeadline: null, turnTimeMs: 1000, turn: 3, prevPhaseTurn: null };
  it("待機中は最後の変更から WAITING_ROOM_TTL_MS で消す", () => {
    expect(settle({ status: "waiting" }, 10)).toEqual({ kind: "waiting", cleanupAt: 10 + WAITING_ROOM_TTL_MS });
  });
  it("決着していなければ締め切り、決着（forfeit も）していれば終了から FINISHED_ROOM_TTL_MS で消す", () => {
    const state = ttt.init(P, "s", null);
    expect(settle({ status: "playing", ...base, state }, 10)).toEqual({ kind: "playing", deadline: 1010, phaseTurn: 3 });
    const forfeit = { winners: ["p2"] };
    expect(settle({ status: "playing", ...base, state, forfeit }, 10)).toEqual({
      kind: "finished",
      result: forfeit,
      finishedAt: 10,
      cleanupAt: 10 + FINISHED_ROOM_TTL_MS,
    });
  });
});

describe("同時手番の phaseTurn と acceptsTurn", () => {
  const hc = highcard as AnyGame;
  const s0 = highcard.init(P, "s", null);
  const card = s0.hands["p1"]![0]!;
  const s1 = highcard.apply(s0, "p1", { card }, createRng("1")); // p1 が出し、p2 だけが残る
  const base = { game: hc, forfeit: null, prevDeadline: 5000, turnTimeMs: 1000 };

  it("行動できる人が減っただけなら phaseTurn と締め切りを引き継ぎ、手番が変われば今のターンから数え直す", () => {
    expect(settle({ status: "playing", ...base, state: s1, prev: P, turn: 5, prevPhaseTurn: 4 }, 10)).toEqual({
      kind: "playing",
      deadline: 5000,
      phaseTurn: 4,
    });
    // 新しいラウンド（両者が行動できる）
    expect(settle({ status: "playing", ...base, state: s0, prev: ["p2"], turn: 6, prevPhaseTurn: 4 }, 10)).toMatchObject({
      phaseTurn: 6,
    });
    // 記録の無いルームは今のターン
    expect(settle({ status: "playing", ...base, state: s1, prev: P, turn: 5, prevPhaseTurn: null }, 10)).toMatchObject({
      phaseTurn: 5,
    });
  });

  it("投了で行動できる人が変わらなければ（もう出した人の投了）phaseTurn と締め切りを引き継ぐ。通常の手なら新しいラウンド", () => {
    // p1 は出し済みで p2 だけが残っている。p1 が投了しても行動できるのは p2 のまま
    expect(
      settle({ status: "playing", ...base, state: s1, prev: ["p2"], turn: 6, prevPhaseTurn: 4, resign: true }, 10),
    ).toEqual({ kind: "playing", deadline: 5000, phaseTurn: 4 });
    expect(settle({ status: "playing", ...base, state: s1, prev: ["p2"], turn: 6, prevPhaseTurn: 4 }, 10)).toEqual({
      kind: "playing",
      deadline: 1010,
      phaseTurn: 6,
    });
    // 投了でも顔ぶれが変われば手番が移ったとみなす
    expect(
      settle({ status: "playing", ...base, state: s1, prev: ["p1"], turn: 6, prevPhaseTurn: 4, resign: true }, 10),
    ).toMatchObject({ deadline: 1010, phaseTurn: 6 });
  });

  it("同じ同時手番の中の古い turn は、送った人がまだ行動できれば受け付ける。二重送信・前の手番の turn は STALE_TURN", () => {
    const snap = { turn: 5, state: s1 };
    const p2card = s0.hands["p2"]![0]!;
    expect(decideAction(hc, snap, "p2", 4, { card: p2card }, "s", 4).ok).toBe(true);
    expect(decideAction(hc, snap, "p1", 4, { card: s1.hands["p1"]![0]! }, "s", 4)).toMatchObject({ code: "STALE_TURN" });
    expect(decideAction(hc, snap, "p2", 3, { card: p2card }, "s", 4)).toMatchObject({ code: "STALE_TURN" });
    expect(decideAction(hc, snap, "p2", 6, { card: p2card }, "s", 4)).toMatchObject({ code: "STALE_TURN" });
    // phaseTurn を渡さなければ完全一致だけ
    expect(decideAction(hc, snap, "p2", 4, { card: p2card }, "s")).toMatchObject({ code: "STALE_TURN" });
  });
});

describe("planAlarm / wantedAlarm", () => {
  const facts = (f: Partial<AlarmFacts>): AlarmFacts => ({
    status: "playing", hasEngine: true, persistPending: false, cleanupAt: null, deadline: 100, ...f,
  });
  const plan = (f: Partial<AlarmFacts>, now: number, botPending = false) => planAlarm({ ...facts(f), botPending }, now);

  it("試合中：締め切り前は張り直し、過ぎたら時間切れ。練習相手は締め切り前だけ打つ", () => {
    expect(plan({}, 50)).toEqual({ retire: false, step: "armDeadline" });
    expect(plan({}, 100)).toEqual({ retire: false, step: "timeout" });
    expect(plan({}, 50, true)).toEqual({ retire: false, step: "bots" });
    expect(plan({}, 100, true)).toEqual({ retire: false, step: "timeout" });
    expect(wantedAlarm(facts({}), 0)).toBe(100);
  });
  it("試合中は待機中に書いた cleanupAt が残っていても消さない", () => {
    expect(plan({ cleanupAt: 10 }, 50)).toEqual({ retire: false, step: "armDeadline" });
  });
  it("待機中：掃除の時刻を過ぎたら消し、早すぎれば張り直す", () => {
    expect(plan({ status: "waiting", cleanupAt: 10, deadline: null }, 10)).toEqual({ retire: false, step: "cleanup" });
    expect(plan({ status: "waiting", cleanupAt: 10, deadline: null }, 5)).toEqual({ retire: false, step: "armCleanup" });
    expect(wantedAlarm(facts({ status: "waiting", cleanupAt: 10, deadline: null }), 0)).toBe(10);
  });
  it("終了後：D1 未書き込みなら今すぐ再試行（エンジンが無くても）", () => {
    const f = { status: "finished" as const, persistPending: true, cleanupAt: 1000 };
    expect(plan(f, 50)).toEqual({ retire: false, step: "persist" });
    expect(plan({ ...f, hasEngine: false }, 50)).toEqual({ retire: true, step: "persist" });
    expect(wantedAlarm(facts(f), 50)).toBe(50);
    expect(wantedAlarm(facts({ ...f, persistPending: false }), 50)).toBe(1000);
  });
  it("エンジンが無い試合中のルームは畳んで掃除だけ（時間切れは処理しない）", () => {
    expect(plan({ hasEngine: false }, 500)).toEqual({ retire: true, step: "armCleanup" });
    expect(plan({ hasEngine: false, cleanupAt: 400 }, 500)).toEqual({ retire: false, step: "cleanup" });
    expect(wantedAlarm(facts({ hasEngine: false, cleanupAt: 400 }), 0)).toBe(400);
  });
});

describe("nextPersistRetry", () => {
  it("指数バックオフで最大1時間おき、終了から 26 時間で諦める", () => {
    expect(nextPersistRetry(0, 0, 0)).toBe(30_000);
    expect(nextPersistRetry(1, 0, 0)).toBe(60_000);
    expect(nextPersistRetry(20, 0, 0)).toBe(60 * 60 * 1000);
    expect(nextPersistRetry(0, 0, 26 * 60 * 60 * 1000 + 1)).toBeNull();
  });
});
