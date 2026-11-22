import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isRoomId, newRoomId, sha256Hex, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";
import { FINISHED_ROOM_TTL_MS, WAITING_ROOM_TTL_MS } from "../../src/lib/options";
import { CLOSE_ROOM_DELETED } from "../../src/lib/protocol";
import { BASE, call, newRoom, playOut } from "./helpers";

const stub = (id: string) => env.GAME_ROOM.getByName(id);
const alarmOf = (id: string) => runInDurableObject(stub(id), (_i, state) => state.storage.getAlarm());
const meta = (id: string, key: string) =>
  runInDurableObject(stub(id), (_i, state) => {
    const rows = state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (rows[0]!.value as string) : null;
  });

/** 掃除の期限を過去にして alarm を発火させる。 */
async function expire(id: string) {
  await runInDurableObject(stub(id), (_i, state) => {
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'cleanupAt'", String(Date.now() - 1));
    // 今に張るとテストランナーが裏で発火させてしまうので、先に張って runDurableObjectAlarm で発火させる
    return state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub(id))).toBe(true);
}

const indexRows = async (id: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE id = ?").bind(id).first<{ n: number }>())!.n;

async function connect(roomId: string, token?: string) {
  const protocols = token ? `${WS_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${token}` : WS_PROTOCOL;
  const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols },
  });
  const ws = res.webSocket!;
  // 閉じられないまま待ち続けるとスイート全体が止まるので、2 秒で失敗にする
  const closed = Promise.race([
    new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code))),
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("socket was not closed")), 2000)),
  ]);
  closed.catch(() => {});
  ws.accept();
  return { ws, closed };
}

describe("ルーム ID の形式チェック", () => {
  it("newRoomId は形式に合う", () => {
    for (let i = 0; i < 100; i++) expect(isRoomId(newRoomId())).toBe(true);
    for (const bad of ["", "nope", "ABCDEF123456", "a1b2c3d4e5f6a", "a1b2c3d4e5f", "a1b2c3d4e5g6"]) expect(isRoomId(bad)).toBe(false);
  });

  it("形式に合わない ID は DO を起こさずに 404 ROOM_NOT_FOUND（/ws も）", async () => {
    for (const [method, path] of [
      ["GET", "/rooms/nope/state"],
      ["POST", "/rooms/NOPE/join"],
      ["POST", "/rooms/a1b2c3d4e5f6a/start"],
      ["GET", "/rooms/..%2F..%2Fx/log"],
    ] as const) {
      const r = await call(method, path);
      expect(r.status, path).toBe(404);
      expect(r.json.error).toEqual({ code: "ROOM_NOT_FOUND", message: "invalid room id" });
    }
    const ws = await SELF.fetch(`${BASE}/rooms/zzz/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": WS_PROTOCOL },
    });
    expect(ws.status).toBe(404);
    expect(((await ws.json()) as { error: { message: string } }).error.message).toBe("invalid room id");
    // 形式に合う未知の ID は DO まで届く（DO の ROOM_NOT_FOUND）
    expect((await call("GET", `/rooms/${newRoomId()}/state`)).json.error.message).toBe("room not found");
  });
});

describe("同じユーザーの二重着席", () => {
  it("同じ API キーで2席目は ALREADY_JOINED。退出すれば座り直せる。キー無しは制限しない", async () => {
    const user = (await call("POST", "/users", { body: { name: "dup" } })).json;
    const headers = { "X-Api-Key": user.apiKey };
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const a = await call("POST", `/rooms/${json.roomId}/join`, { headers });
    expect(a.status).toBe(201);
    const again = await call("POST", `/rooms/${json.roomId}/join`, { headers });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("ALREADY_JOINED");

    expect((await call("POST", `/rooms/${json.roomId}/leave`, { token: a.json.token })).status).toBe(200);
    expect((await call("POST", `/rooms/${json.roomId}/join`, { headers })).status).toBe(201);
    expect((await call("POST", `/rooms/${json.roomId}/join`)).status).toBe(201);
  });

  it("クイックマッチは自分のいる部屋を飛ばして別の部屋に入る", async () => {
    const user = (await call("POST", "/users", { body: { name: "dupqm" } })).json;
    const headers = { "X-Api-Key": user.apiKey };
    const options = { turnTimeMs: 1000 + Math.floor(Math.random() * 1_000_000) };
    const first = (await call("POST", "/quickmatch", { body: { game: "tictactoe", options }, headers })).json;
    const second = (await call("POST", "/quickmatch", { body: { game: "tictactoe", options }, headers })).json;
    expect(second.roomId).not.toBe(first.roomId);
    expect(second.created).toBe(true);
  });
});

describe("POST /users/:id/key", () => {
  it("新しいキーを返し、古いキーは使えなくなる。戦績は引き継ぐ", async () => {
    const user = (await call("POST", "/users", { body: { name: "rot" } })).json;

    const r = await call("POST", `/users/${user.userId}/key`, { headers: { "X-Api-Key": user.apiKey } });
    expect(r.status).toBe(200);
    expect(r.json.userId).toBe(user.userId);
    expect(r.json.apiKey).toMatch(/^ak_/);
    expect(r.json.apiKey).not.toBe(user.apiKey);

    // 古いキー：join も再発行も 401
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    expect((await call("POST", `/rooms/${json.roomId}/join`, { headers: { "X-Api-Key": user.apiKey } })).status).toBe(401);
    expect((await call("POST", `/users/${user.userId}/key`, { headers: { "X-Api-Key": user.apiKey } })).status).toBe(401);
    // 新しいキーは使える
    expect((await call("POST", `/rooms/${json.roomId}/join`, { headers: { "X-Api-Key": r.json.apiKey } })).status).toBe(201);
    expect((await call("GET", `/users/${user.userId}`)).json.name).toBe("rot");
  });

  it("キーが無い・他人のキー・存在しないユーザーは 401", async () => {
    const a = (await call("POST", "/users", { body: { name: "a" } })).json;
    const b = (await call("POST", "/users", { body: { name: "b" } })).json;
    expect((await call("POST", `/users/${a.userId}/key`)).status).toBe(401);
    expect((await call("POST", `/users/${a.userId}/key`, { headers: { "X-Api-Key": b.apiKey } })).status).toBe(401);
    expect((await call("POST", `/users/u_nobody/key`, { headers: { "X-Api-Key": a.apiKey } })).status).toBe(401);
    // b のキーは失効していない
    expect((await call("POST", `/users/${b.userId}/key`, { headers: { "X-Api-Key": b.apiKey } })).status).toBe(200);
  });
});

describe("トークンはハッシュで保存する", () => {
  it("players・meta・WS の attachment にトークンそのものが残らない", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const conn = await connect(roomId, a.token);
    try {
    const dump = await runInDurableObject(stub(roomId), (_i, state) => {
      const rows = [
        ...state.storage.sql.exec("SELECT * FROM players").toArray(),
        ...state.storage.sql.exec("SELECT * FROM meta").toArray(),
      ];
      const atts = state.getWebSockets().map((ws) => ws.deserializeAttachment());
      return JSON.stringify([rows, atts]);
    });
    for (const t of [host, a.token, b.token]) {
      expect(dump).not.toContain(t);
      expect(dump).toContain(await sha256Hex(t));
    }
    expect(await meta(roomId, "hostToken")).toBeNull();
    // ハッシュ化しても認証はこれまでどおり
    expect((await call("POST", `/rooms/${roomId}/start`, { token: a.token })).json.error.code).toBe("NOT_HOST");
    expect((await call("POST", `/rooms/${roomId}/start`, { token: host })).status).toBe(200);
    expect((await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json.legal).toBeDefined();
    } finally {
      conn.ws.close();
    }
  });

  it("再戦の席のトークンも保存せず、何度呼んでも同じトークンを返す", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const r1 = (await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json;
    const r2 = (await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json;
    expect(r2).toEqual(r1);
    const dump = await runInDurableObject(stub(r1.roomId), (_i, state) =>
      JSON.stringify(state.storage.sql.exec("SELECT * FROM players").toArray()),
    );
    expect(dump).not.toContain(r1.token);
    expect(dump).toContain(await sha256Hex(r1.token));
  });
});

describe("ルームの掃除", () => {
  it("待機中のルームは最後の変更から WAITING_ROOM_TTL_MS で alarm が張られ、join で延びる", async () => {
    const t0 = Date.now();
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const first = (await alarmOf(json.roomId))!;
    expect(first).toBeGreaterThanOrEqual(t0 + WAITING_ROOM_TTL_MS);
    expect(first).toBeLessThan(Date.now() + WAITING_ROOM_TTL_MS + 1);
    await new Promise((r) => setTimeout(r, 5));
    await call("POST", `/rooms/${json.roomId}/join`);
    expect((await alarmOf(json.roomId))!).toBeGreaterThan(first);
    expect(Number(await meta(json.roomId, "cleanupAt"))).toBe(await alarmOf(json.roomId));
  });

  it("期限が来た待機中のルームは消え、接続は 4001 で閉じ、D1 の索引も消える", async () => {
    const { roomId, a } = await newRoom("tictactoe");
    expect(await indexRows(roomId)).toBe(1);
    const conn = await connect(roomId, a.token);
    await expire(roomId);
    expect(await conn.closed).toBe(CLOSE_ROOM_DELETED);
    expect((await call("GET", `/rooms/${roomId}/state`)).json.error.code).toBe("ROOM_NOT_FOUND");
    expect((await call("POST", `/rooms/${roomId}/join`)).status).toBe(404);
    expect(await alarmOf(roomId)).toBeNull();
    const tables = await runInDurableObject(stub(roomId), (_i, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'").toArray(),
    );
    expect(tables).toEqual([]);
    expect(await indexRows(roomId)).toBe(0);
  });

  it("早すぎた掃除の alarm は張り直すだけ。試合中は待機中の期限で消さない", async () => {
    const { roomId, host } = await newRoom("tictactoe");
    await runInDurableObject(stub(roomId), (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub(roomId))).toBe(true);
    expect((await call("GET", `/rooms/${roomId}/state`)).status).toBe(200);
    expect(await alarmOf(roomId)).toBe(Number(await meta(roomId, "cleanupAt")));

    await call("POST", `/rooms/${roomId}/start`, { token: host });
    expect(await meta(roomId, "cleanupAt")).toBeNull();
    expect(await meta(roomId, "deadline")).toBe(String(await alarmOf(roomId)));
  });

  it("終了したルームは D1 に書いた後、FINISHED_ROOM_TTL_MS で消える。matches は残る", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const finishedAt = Number(await meta(roomId, "finishedAt"));
    expect(await meta(roomId, "persisted")).toBe("1");
    expect(await alarmOf(roomId)).toBe(finishedAt + FINISHED_ROOM_TTL_MS);
    expect((await call("GET", `/rooms/${roomId}/log`)).status).toBe(200);

    await expire(roomId);
    expect((await call("GET", `/rooms/${roomId}/log`)).status).toBe(404);
    expect(await indexRows(roomId)).toBe(0);
    const m = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE id = ?").bind(roomId).first<{ n: number }>();
    expect(m!.n).toBe(1);
  });

  it("D1 への書き込みが済んでいない終了済みのルームは、掃除より再試行を優先する", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    await runInDurableObject(stub(roomId), (_i, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'persisted'");
      return state.storage.deleteAlarm();
    });
    await call("GET", `/rooms/${roomId}/state`); // ensureAlarm：再試行の alarm（今）を張る。すぐ発火する
    for (let i = 0; i < 50 && (await meta(roomId, "persisted")) !== "1"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await meta(roomId, "persisted")).toBe("1");
    expect(await alarmOf(roomId)).toBe(Number(await meta(roomId, "cleanupAt")));
    expect((await call("GET", `/rooms/${roomId}/log`)).status).toBe(200);
  });

  it("再戦ルームが掃除された後に rematch を呼ぶと、同じ ID で作り直す", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const r1 = (await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json;
    await expire(r1.roomId);
    expect((await call("GET", `/rooms/${r1.roomId}/state`)).status).toBe(404);

    const r2 = await call("POST", `/rooms/${roomId}/rematch`, { token: b.token });
    expect(r2.status).toBe(200);
    expect(r2.json.roomId).toBe(r1.roomId);
    expect((await call("GET", `/rooms/${roomId}/state`)).json.rematch.requestedBy).toEqual(["p2"]);
    const r3 = (await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json;
    expect(r3).toEqual(r1);
    expect((await call("GET", `/rooms/${r1.roomId}/state`)).json.status).toBe("playing");
  });
});
