import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import type { AnyGame } from "../../src/games/types";
import { elimination } from "../fixtures/elimination";
import { call } from "./helpers";

// 2〜3人のゲーム（elimination）を、このファイルの間だけ登録する
beforeAll(() => {
  games[elimination.id] = elimination as AnyGame;
});
afterAll(() => {
  delete games[elimination.id];
});

// D1 はテスト間で共有されるので、クイックマッチの候補が他のテストと混ざらないよう、テストごとに持ち時間を変える。
let nextTurnTime = 71_000;
const uniqueTurnTime = () => nextTurnTime++;

const create = async (options: Record<string, unknown>) =>
  call("POST", "/rooms", { body: { game: elimination.id, options } });
const join = async (roomId: string) => call("POST", `/rooms/${roomId}/join`);
const state = async (roomId: string) => (await call("GET", `/rooms/${roomId}/state`)).json;
const indexRow = (roomId: string) =>
  env.DB.prepare("SELECT max_players FROM rooms WHERE id = ?").bind(roomId).first<{ max_players: number }>();

describe("options.seats", () => {
  it("ゲームの人数の範囲外は 400", async () => {
    expect((await create({ seats: 1 })).status).toBe(400);
    expect((await create({ seats: 4 })).status).toBe(400);
    expect((await call("POST", "/rooms", { body: { game: "tictactoe", options: { seats: 3 } } })).status).toBe(400);
    const q = await call("POST", "/quickmatch", { body: { game: elimination.id, options: { seats: 4 } } });
    expect(q.status).toBe(400);
  });

  it("定員で満席になり、autoStart はその人数で始まる。索引の max_players も定員", async () => {
    const { json } = await create({ seats: 2, autoStart: true });
    expect((await indexRow(json.roomId))?.max_players).toBe(2);
    await join(json.roomId);
    await join(json.roomId);
    const s = await state(json.roomId);
    expect(s.status).toBe("playing");
    expect(s.players).toEqual(["p1", "p2"]);
    expect((await join(json.roomId)).json.error.code).toBe("ALREADY_STARTED");
  });

  it("autoStart でなければ、定員を超える join は ROOM_FULL", async () => {
    const { json } = await create({ seats: 2 });
    await join(json.roomId);
    await join(json.roomId);
    const r = await join(json.roomId);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ROOM_FULL");
  });

  it("省略時の定員は maxPlayers", async () => {
    const { json } = await create({ autoStart: true });
    expect((await indexRow(json.roomId))?.max_players).toBe(3);
    await join(json.roomId);
    await join(json.roomId);
    expect((await state(json.roomId)).status).toBe("waiting");
    await join(json.roomId);
    expect((await state(json.roomId)).status).toBe("playing");
  });

  it("練習相手は定員まで埋める（省略時は minPlayers まで）", async () => {
    for (const [options, n] of [[{ practice: true, seats: 3 }, 3], [{ practice: true }, 2]] as const) {
      const { json } = await create(options);
      await join(json.roomId);
      expect((await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken })).status).toBe(200);
      expect((await state(json.roomId)).players).toHaveLength(n);
    }
  });

  it("クイックマッチは定員の同じ部屋だけを組み合わせる", async () => {
    const turnTimeMs = uniqueTurnTime();
    const qm = async (seats?: number) =>
      (await call("POST", "/quickmatch", { body: { game: elimination.id, options: { turnTimeMs, seats } } })).json;
    const a = await qm(2);
    expect(a.created).toBe(true);
    const b = await qm(); // 省略時は maxPlayers（3）なので a の部屋には入らない
    expect(b.created).toBe(true);
    expect(b.roomId).not.toBe(a.roomId);
    const c = await qm(3); // 明示した 3 と省略は同じ部屋
    expect(c.roomId).toBe(b.roomId);
    const d = await qm(2);
    expect(d.roomId).toBe(a.roomId);
    expect((await state(a.roomId)).status).toBe("playing");
    expect((await state(b.roomId)).status).toBe("waiting");
  });
});
