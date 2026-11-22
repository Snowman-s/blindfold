import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";
import { CLOSE_LEFT_ROOM } from "../../src/lib/protocol";
import { BASE, call, newRoom, playOut } from "./helpers";

async function connect(roomId: string, token?: string) {
  const protocols = token ? `${WS_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${token}` : WS_PROTOCOL;
  const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols },
  });
  const ws = res.webSocket!;
  const messages: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string);
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  ws.accept();
  const next = (pred: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const found = messages.find(pred);
      if (found) resolve(found);
      else waiters.push({ pred, resolve });
    });
  return { ws, messages, next, closed };
}

describe("POST /rooms/:id/leave", () => {
  it("待機中なら退出でき、トークンは無効になり、番号は再利用されない", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const roomId: string = json.roomId;
    const a = (await call("POST", `/rooms/${roomId}/join`)).json;
    const b = (await call("POST", `/rooms/${roomId}/join`)).json;
    expect(a.playerId).toBe("p1");

    const left = await call("POST", `/rooms/${roomId}/leave`, { token: a.token });
    expect(left.status).toBe(200);
    expect(left.json.players).toEqual(["p2"]);
    expect((await call("GET", `/rooms/${roomId}/state`, { token: a.token })).status).toBe(401);
    expect((await call("POST", `/rooms/${roomId}/leave`, { token: a.token })).status).toBe(401);

    const c = (await call("POST", `/rooms/${roomId}/join`)).json;
    expect(c.playerId).toBe("p3");
    const started = await call("POST", `/rooms/${roomId}/start`, { token: json.hostToken });
    expect(started.json.players).toEqual(["p2", "p3"]);
    // 先手は p2（席順 = 参加順）
    const s = await call("GET", `/rooms/${roomId}/state`, { token: b.token });
    expect(s.json.legal).toBeDefined();

    expect((await call("POST", `/rooms/${roomId}/leave`, { token: b.token })).json.error.code).toBe("ALREADY_STARTED");
  });

  it("索引の人数が減り、満席だった部屋が一覧に戻る", async () => {
    const { roomId, a } = await newRoom("tictactoe");
    const find = async () => ((await call("GET", "/rooms?limit=100")).json as any[]).find((r) => r.roomId === roomId);
    expect(await find()).toBeUndefined();
    await call("POST", `/rooms/${roomId}/leave`, { token: a.token });
    expect((await find())?.players).toBe(1);
  });

  it("練習ルームで退出・再参加しても練習相手の席と衝突しない", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true } } });
    const a = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await call("POST", `/rooms/${json.roomId}/leave`, { token: a.token });
    const b = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    expect(b.playerId).toBe("p2");
    const started = await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    expect(started.status).toBe(200);
    expect(started.json.players).toEqual(["p2", "p3"]);
  });

  it("退出したプレイヤーの WS はサーバーが閉じる。他の接続には人数の減った state が届く", async () => {
    const { roomId, a, b } = await newRoom("tictactoe");
    const wa = await connect(roomId, a.token);
    const wb = await connect(roomId, b.token);
    await wa.next((m) => m.type === "state");
    await wb.next((m) => m.type === "state");
    await call("POST", `/rooms/${roomId}/leave`, { token: a.token });
    expect(await wa.closed).toBe(CLOSE_LEFT_ROOM);
    const m = await wb.next((m) => m.type === "state" && m.players.length === 1);
    expect(m.players).toEqual(["p2"]);
    wb.ws.close();
  });

  it("nextSeat を持たない（導入前の）ルームでも、退出後の join で ID が衝突しない", async () => {
    const { roomId, a } = await newRoom("tictactoe");
    await runInDurableObject(env.GAME_ROOM.getByName(roomId), (_i, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'nextSeat'");
    });
    await call("POST", `/rooms/${roomId}/leave`, { token: a.token });
    const c = await call("POST", `/rooms/${roomId}/join`);
    expect(c.status).toBe(201);
    expect(c.json.playerId).toBe("p3");
  });

  it("トークン無しは 401、存在しないルームは 404", async () => {
    const { roomId } = await newRoom("tictactoe");
    expect((await call("POST", `/rooms/${roomId}/leave`)).status).toBe(401);
    expect((await call("POST", `/rooms/nope-room/leave`, { token: "x" })).status).toBe(404);
  });
});

describe("POST /rooms/:id/rematch", () => {
  it("全員が申し込むと席を入れ替えて新しい試合が始まる。同じ人が何度呼んでも同じ席", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    expect((await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json.error.code).toBe("NOT_FINISHED");
    await playOut(roomId, host, a, b);

    const wb = await connect(roomId, b.token);
    await wb.next((m) => m.type === "end");

    const ra = await call("POST", `/rooms/${roomId}/rematch`, { token: a.token });
    expect(ra.status).toBe(200);
    expect(ra.json.playerId).toBe("p2"); // 先手だった p1 は後手に
    expect(ra.json.roomId).not.toBe(roomId);
    const again = await call("POST", `/rooms/${roomId}/rematch`, { token: a.token });
    expect(again.json).toEqual(ra.json);

    // 相手には申し込みが WS で届く
    const offer = await wb.next((m) => m.type === "state" && m.rematch);
    expect(offer.rematch).toEqual({ roomId: ra.json.roomId, requestedBy: ["p1"] });
    expect(offer.status).toBe("finished");
    wb.ws.close();

    const waiting = await call("GET", `/rooms/${ra.json.roomId}/state`, { token: ra.json.token });
    expect(waiting.json.status).toBe("waiting");

    const rb = await call("POST", `/rooms/${roomId}/rematch`, { token: b.token });
    expect(rb.json).toMatchObject({ roomId: ra.json.roomId, playerId: "p1" });
    const s = await call("GET", `/rooms/${rb.json.roomId}/state`, { token: rb.json.token });
    expect(s.json.status).toBe("playing");
    expect(s.json.legal).toBeDefined(); // 後手だった b が先手

    const old = await call("GET", `/rooms/${roomId}/state`);
    expect(old.json.rematch).toEqual({ roomId: ra.json.roomId, requestedBy: ["p1", "p2"] });
  });

  it("同時に申し込んでも新しいルームは1つで、席は別々になり、試合が始まる", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const [ra, rb] = await Promise.all([
      call("POST", `/rooms/${roomId}/rematch`, { token: a.token }),
      call("POST", `/rooms/${roomId}/rematch`, { token: b.token }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.json.roomId).toBe(rb.json.roomId);
    expect([ra.json.playerId, rb.json.playerId]).toEqual(["p2", "p1"]);
    expect((await call("GET", `/rooms/${ra.json.roomId}/state`)).json.status).toBe("playing");
    expect((await call("GET", `/rooms/${roomId}/state`)).json.rematch.requestedBy.sort()).toEqual(["p1", "p2"]);
  });

  it("予約席には外から join できず、一覧にも載らない。観戦者・hostToken は 401", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    expect((await call("POST", `/rooms/${roomId}/rematch`)).status).toBe(401);
    expect((await call("POST", `/rooms/${roomId}/rematch`, { token: host })).status).toBe(401);

    const r = (await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json;
    const join = await call("POST", `/rooms/${r.roomId}/join`);
    expect(join.status).toBe(403);
    expect(join.json.error.code).toBe("ROOM_RESERVED");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE id = ?").bind(r.roomId).first<{ n: number }>();
    expect(n?.n).toBe(0);

    // 退出しても席は予約されたまま。もう一度 rematch を呼べば座り直せる（新しいトークン）
    expect((await call("POST", `/rooms/${r.roomId}/leave`, { token: r.token })).status).toBe(200);
    expect((await call("POST", `/rooms/${r.roomId}/join`)).status).toBe(403);
    const back = (await call("POST", `/rooms/${roomId}/rematch`, { token: a.token })).json;
    expect(back.playerId).toBe(r.playerId);
    expect(back.token).not.toBe(r.token);
  });

  it("座り直した席の古いトークンの WS は、その席として扱わない（view・legal を受け取れず、行動もできない）", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const rb = (await call("POST", `/rooms/${roomId}/rematch`, { token: b.token })).json; // p1（先手）
    const old = await connect(rb.roomId, rb.token);
    await old.next((m) => m.type === "state");
    // 閉じ損ねたまま座り直された状況：席のトークンだけが変わる
    await runInDurableObject(env.GAME_ROOM.getByName(rb.roomId), (_i, state) => {
      state.storage.sql.exec("UPDATE players SET token = 'reseated' WHERE id = ?", rb.playerId);
    });
    await call("POST", `/rooms/${roomId}/rematch`, { token: a.token }); // 開始
    const s = await old.next((m) => m.type === "state" && m.status === "playing");
    expect(s.legal).toBeUndefined();
    expect(s.currentPlayers).toEqual(["p1"]);
    old.ws.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 0 } }));
    const err = await old.next((m) => m.type === "error");
    expect(err.code).toBe("NOT_YOUR_TURN");
    old.ws.close();
  });

  it("練習試合の再戦は申し込んだ時点で始まり、練習相手が戻る", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true } } });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    expect((await call("POST", `/rooms/${json.roomId}/resign`, { token: me.token })).json.status).toBe("finished");

    const r = (await call("POST", `/rooms/${json.roomId}/rematch`, { token: me.token })).json;
    expect(r.playerId).toBe("p1");
    const s = await call("GET", `/rooms/${r.roomId}/state`, { token: r.token });
    expect(s.json.status).toBe("playing");
    expect(s.json.players).toEqual(["p1", "p2"]);
    expect(s.json.legal).toBeDefined();
  });

  it("API キーの紐づけを引き継ぐ", async () => {
    const user = (await call("POST", "/users", { body: { name: "rematcher" } })).json;
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const a = (await call("POST", `/rooms/${json.roomId}/join`, { headers: { "X-Api-Key": user.apiKey } })).json;
    const b = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await playOut(json.roomId, json.hostToken, a, b); // a（p1）の勝ち

    const ra = (await call("POST", `/rooms/${json.roomId}/rematch`, { token: a.token })).json; // p2
    const rb = (await call("POST", `/rooms/${json.roomId}/rematch`, { token: b.token })).json; // p1（先手）
    await call("POST", `/rooms/${ra.roomId}/resign`, { token: rb.token }); // a の勝ち
    expect((await call("GET", `/users/${user.userId}`)).json.stats).toMatchObject({ played: 2, wins: 2 });
  });

  it("/openapi.json に leave と rematch が載る", async () => {
    const r = await call("GET", "/openapi.json");
    expect(r.json.paths["/rooms/{id}/leave"].post).toBeDefined();
    expect(r.json.paths["/rooms/{id}/rematch"].post).toBeDefined();
  });
});
