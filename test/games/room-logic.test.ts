import { describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import { highcard } from "../../src/games/highcard";
import type { AnyGame } from "../../src/games/types";
import {
  decideAction,
  decideResign,
  decideTimeout,
  nextDeadline,
  outcomeOf,
  practiceBotCount,
  rematchSeats,
  roomState,
  stateMessage,
  type RoomCore,
} from "../../src/room/logic";
import { elimination } from "../fixtures/elimination";
import { guess } from "../fixtures/guess";

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
  it("練習相手の数は minPlayers までの空席", () => {
    expect(practiceBotCount(ttt, 1, true)).toBe(1);
    expect(practiceBotCount(ttt, 2, true)).toBe(0);
    expect(practiceBotCount(ttt, 1, false)).toBe(0);
  });
  it("結果：forfeit に引き分けはない", () => {
    expect(outcomeOf({ winners: [] }, false, "p1")).toBe("draw");
    expect(outcomeOf({ winners: [] }, true, "p1")).toBe("loss");
    expect(outcomeOf({ winners: ["p1"] }, true, "p1")).toBe("win");
  });
});
