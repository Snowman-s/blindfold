import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE_REPLACED,
  CLOSE_TOO_MANY_ERRORS,
  MAX_SOCKETS_PER_SEAT,
  MAX_SPECTATOR_SOCKETS,
  WS_MAX_STRIKES,
  WS_STRIKE_DECAY_MS,
} from "../../src/lib/protocol";
import { call, connect, newRoom } from "./helpers";

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) {
    try {
      ws.close();
    } catch {
      // すでに閉じている
    }
  }
});

/** connect + 受信の記録。 */
async function conn(roomId: string, token?: string) {
  const c = await connect(roomId, token);
  open.push(c.ws);
  const msgs: any[] = [];
  c.ws.addEventListener("message", (e) => {
    msgs.push(JSON.parse(e.data as string));
  });
  return { ...c, msgs };
}

/** 受信を待つ（DO の処理は非同期なので、条件を満たすまで少し待つ）。 */
async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const stub = (roomId: string) => env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId));

describe("WebSocket error limit", () => {
  it(`closes a socket with ${CLOSE_TOO_MANY_ERRORS} after more than ${WS_MAX_STRIKES} errors`, async () => {
    const { roomId } = await newRoom("tictactoe");
    const c = await conn(roomId);
    for (let i = 0; i < WS_MAX_STRIKES; i++) c.ws.send("not json");
    await until(() => c.msgs.filter((m) => m.type === "error").length === WS_MAX_STRIKES);
    // 上限ちょうどでは閉じない。同じルームの別の接続は影響を受けない
    const other = await conn(roomId);
    c.ws.send('{"type":"action","turn":0,"action":{}}'); // 観戦者の行動（UNAUTHORIZED）も数える
    expect(await c.closed).toBe(CLOSE_TOO_MANY_ERRORS);
    other.ws.send('{"type":"ping"}');
    await until(() => other.msgs.some((m) => m.type === "pong"));
  });

  it("does not count applied actions, and forgives errors over time", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const c = await conn(roomId, a.token);
    for (let i = 0; i < WS_MAX_STRIKES; i++) c.ws.send('{"type":"action","turn":99,"action":{"cell":0}}');
    await until(() => c.msgs.filter((m) => m.type === "error").length === WS_MAX_STRIKES);
    // 正しい手は数えない（閉じられず、そのまま適用される）
    c.ws.send('{"type":"action","turn":0,"action":{"cell":0}}');
    await until(() => c.msgs.some((m) => m.type === "state" && m.turn === 1));

    // 時間が経てば減る：溜めた時刻を WS_STRIKE_DECAY_MS * 上限ぶん前にずらすと、また上限まで送れる
    await runInDurableObject(stub(roomId), (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { strikeAt: number };
        ws.serializeAttachment({ ...att, strikeAt: att.strikeAt - WS_STRIKE_DECAY_MS * WS_MAX_STRIKES });
      }
    });
    for (let i = 0; i < WS_MAX_STRIKES; i++) c.ws.send("{}");
    await until(() => c.msgs.filter((m) => m.type === "error").length === 2 * WS_MAX_STRIKES);
    c.ws.send("{}");
    expect(await c.closed).toBe(CLOSE_TOO_MANY_ERRORS);
  });

  it("counts a ping that is not the exact auto-answered string", async () => {
    const { roomId } = await newRoom("tictactoe");
    const c = await conn(roomId);
    for (let i = 0; i <= WS_MAX_STRIKES; i++) c.ws.send('{ "type": "ping" }');
    expect(await c.closed).toBe(CLOSE_TOO_MANY_ERRORS);
    expect(c.msgs.filter((m) => m.type === "pong").length).toBeGreaterThan(0);
  });
});

describe("WebSocket connection limits", () => {
  it(`rejects spectator ${MAX_SPECTATOR_SOCKETS + 1} with 503 TOO_MANY_CONNECTIONS, but not players`, async () => {
    const { roomId, a } = await newRoom("tictactoe");
    for (let i = 0; i < MAX_SPECTATOR_SOCKETS; i++) await conn(roomId);
    const res = await SELF.fetch(`https://example.com/rooms/${roomId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "apigames.v1" },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe("TOO_MANY_CONNECTIONS");
    // プレイヤーは観戦の上限に関係なく繋がる
    const p = await conn(roomId, a.token);
    await until(() => p.msgs.some((m) => m.type === "state"));
  });

  it(`closes the oldest socket of a seat with ${CLOSE_REPLACED} beyond ${MAX_SOCKETS_PER_SEAT}`, async () => {
    const { roomId, a, b } = await newRoom("tictactoe");
    const socks = [];
    for (let i = 0; i < MAX_SOCKETS_PER_SEAT; i++) socks.push(await conn(roomId, a.token));
    await conn(roomId, b.token); // 別の席は数えない
    socks.push(await conn(roomId, a.token));
    expect(await socks[0]!.closed).toBe(CLOSE_REPLACED);
    // 残りは開いたまま
    const n = await runInDurableObject(stub(roomId), (_i, state) => state.getWebSockets(`seat:${a.playerId}`).length);
    expect(n).toBe(MAX_SOCKETS_PER_SEAT);
  });
});

describe("rate limits on reads and upgrades", () => {
  const ip = (n: number) => ({ "CF-Connecting-IP": `198.51.100.${n}` });

  it("limits WebSocket upgrades per IP before the room is reached", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      // 形式に合わない ID なので DO は起きない（制限はその前に効く）
      const res = await SELF.fetch("https://example.com/rooms/nope/ws", { headers: { Upgrade: "websocket", ...ip(1) } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("shares one limit across room reads, actions, matches and users", async () => {
    const h = ip(2);
    let last = 0;
    for (let i = 0; i < 59; i++) last = (await call("GET", "/matches", { headers: h })).status;
    expect(last).toBe(200);
    expect((await call("POST", "/rooms/000000000000/action", { body: { turn: 0, action: {} }, headers: h })).status).not.toBe(429);
    const over = await call("GET", "/rooms/000000000000/state", { headers: h });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe("RATE_LIMITED");
    // 書き込み系の制限（RL_ROOMS）は別のカウンタ
    expect((await call("POST", "/rooms", { body: { game: "tictactoe" }, headers: h })).status).toBe(201);
  });
});
