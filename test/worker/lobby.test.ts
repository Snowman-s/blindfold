import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";
import { WAITING_LIST_TTL_MS } from "../../src/lib/options";
import { BASE, call, newRoom, playOut } from "./helpers";

// D1 はテスト間で共有されるので、クイックマッチの候補が他のテストと混ざらないよう、テストごとに持ち時間を変える。
let nextTurnTime = 61_000;
const uniqueTurnTime = () => nextTurnTime++;

const listed = async (query = "") => (await call("GET", `/rooms${query}`)).json as any[];
const find = async (roomId: string, query = "") => (await listed(query)).find((r) => r.roomId === roomId);

describe("GET /rooms", () => {
  it("作成直後から待機中の一覧に載り、join で人数が増え、開始すると進行中に移る", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const roomId: string = json.roomId;
    expect(await find(roomId)).toMatchObject({
      roomId,
      game: "tictactoe",
      status: "waiting",
      players: 0,
      maxPlayers: 2,
      autoStart: false,
      turnTimeMs: 5 * 60 * 1000,
    });
    await call("POST", `/rooms/${roomId}/join`);
    expect((await find(roomId))?.players).toBe(1);
    await call("POST", `/rooms/${roomId}/join`);
    // 満席なので待機中の一覧からは消える
    expect(await find(roomId)).toBeUndefined();
    await call("POST", `/rooms/${roomId}/start`, { token: json.hostToken });
    expect(await find(roomId, "?status=playing")).toMatchObject({ status: "playing", players: 2 });
    expect(await find(roomId, "?status=playing&game=highcard")).toBeUndefined();
  });

  it("終了した試合はどちらの一覧にも出ない（索引は finished になる）", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    expect(await find(roomId, "?status=playing")).toBeUndefined();
    const row = await env.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(roomId).first<{ status: string }>();
    expect(row?.status).toBe("finished");
  });

  it("unlisted と練習ルームは載らない", async () => {
    const u = (await call("POST", "/rooms", { body: { game: "tictactoe", options: { unlisted: true } } })).json;
    const p = (await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true } } })).json;
    const ids = (await listed("?limit=100")).map((r) => r.roomId);
    expect(ids).not.toContain(u.roomId);
    expect(ids).not.toContain(p.roomId);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE id IN (?, ?)").bind(u.roomId, p.roomId).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("長く更新のない待機中ルームは出さない。不正なクエリは 400", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    await env.DB.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - WAITING_LIST_TTL_MS - 1, json.roomId)
      .run();
    expect(await find(json.roomId, "?limit=100")).toBeUndefined();
    expect((await call("GET", "/rooms?status=finished")).status).toBe(400);
    expect((await call("GET", "/rooms?limit=0")).status).toBe(400);
  });
});

describe("options.autoStart", () => {
  it("満席になった join で開始する（ホストの start は不要。後から呼ぶと ALREADY_STARTED）", async () => {
    const { roomId, host, a } = await newRoom("tictactoe", { autoStart: true });
    const s = await call("GET", `/rooms/${roomId}/state`, { token: a.token });
    expect(s.json.status).toBe("playing");
    expect(s.json.legal).toBeDefined(); // p1 が先手
    expect((await call("POST", `/rooms/${roomId}/start`, { token: host })).json.error.code).toBe("ALREADY_STARTED");
    expect((await find(roomId, "?status=playing"))?.autoStart).toBe(true);
  });

  it("練習相手との併用は 400", async () => {
    const r = await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true, autoStart: true } } });
    expect(r.status).toBe(400);
  });
});

it("/openapi.json に一覧とクイックマッチが載る", async () => {
  const r = await call("GET", "/openapi.json");
  expect(r.status).toBe(200);
  expect(r.json.paths["/rooms"].get).toBeDefined();
  expect(r.json.paths["/quickmatch"].post).toBeDefined();
});

describe("POST /quickmatch", () => {
  it("1人目は部屋を作り、2人目はそこに入って試合が始まる。3人目は新しい部屋", async () => {
    const options = { turnTimeMs: uniqueTurnTime() };
    const first = await call("POST", "/quickmatch", { body: { game: "tictactoe", options } });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ playerId: "p1", created: true });
    expect(first.json.hostToken).toBeUndefined();

    // 1人目は WS で待つ。2人目が来たら playing の state（legal 付き）が届く
    const res = await SELF.fetch(`${BASE}/rooms/${first.json.roomId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${WS_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${first.json.token}` },
    });
    const ws = res.webSocket!;
    ws.accept();
    const playing = new Promise<any>((resolve) =>
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data as string);
        if (m.type === "state" && m.status === "playing") resolve(m);
      }),
    );

    const second = await call("POST", "/quickmatch", { body: { game: "tictactoe", options } });
    expect(second.json).toMatchObject({ roomId: first.json.roomId, playerId: "p2", created: false });
    const m = await playing;
    expect(m.players).toEqual(["p1", "p2"]);
    expect(m.legal).toBeDefined();
    ws.close();

    const third = await call("POST", "/quickmatch", { body: { game: "tictactoe", options } });
    expect(third.json.created).toBe(true);
    expect(third.json.roomId).not.toBe(first.json.roomId);
  });

  it("持ち時間・ゲームが違う部屋や、autoStart でない部屋には入らない", async () => {
    const t = uniqueTurnTime();
    const manual = (await call("POST", "/rooms", { body: { game: "tictactoe", options: { turnTimeMs: t } } })).json;
    await call("POST", "/quickmatch", { body: { game: "highcard", options: { turnTimeMs: t } } });
    const r = await call("POST", "/quickmatch", { body: { game: "tictactoe", options: { turnTimeMs: t } } });
    expect(r.json.created).toBe(true);
    expect(r.json.roomId).not.toBe(manual.roomId);
  });

  it("索引が古い（存在しない・満席の）部屋は飛ばす", async () => {
    const t = uniqueTurnTime();
    const now = Date.now();
    const insert = (id: string, createdAt: number) =>
      env.DB.prepare(
        `INSERT INTO rooms(id, game, status, players, max_players, auto_start, turn_time_ms, created_at, updated_at, rev)
         VALUES (?, 'tictactoe', 'waiting', 1, 2, 1, ?, ?, ?, 1)`,
      )
        .bind(id, t, createdAt, now)
        .run();
    await insert("ghost-room", now - 2000); // DO が存在しない
    // 実際は満席だが索引が古い部屋
    const full = (await call("POST", "/rooms", { body: { game: "tictactoe", options: { turnTimeMs: t, autoStart: true } } })).json;
    await call("POST", `/rooms/${full.roomId}/join`);
    await call("POST", `/rooms/${full.roomId}/join`);
    await env.DB.prepare("UPDATE rooms SET status = 'waiting', players = 1, created_at = ? WHERE id = ?").bind(now - 1000, full.roomId).run();

    const r = await call("POST", "/quickmatch", { body: { game: "tictactoe", options: { turnTimeMs: t } } });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    expect([full.roomId, "ghost-room"]).not.toContain(r.json.roomId);
  });

  it("未知のゲーム・未知のオプション・無効な API キーは拒否する。API キーは戦績に紐づく", async () => {
    expect((await call("POST", "/quickmatch", { body: { game: "nope" } })).json.error.code).toBe("UNKNOWN_GAME");
    expect((await call("POST", "/quickmatch", { body: { game: "tictactoe", options: { practice: true } } })).status).toBe(400);
    const bad = await call("POST", "/quickmatch", { body: { game: "tictactoe" }, headers: { "X-Api-Key": "nope" } });
    expect(bad.status).toBe(401);

    const user = (await call("POST", "/users", { body: { name: "qm" } })).json;
    const options = { turnTimeMs: uniqueTurnTime() };
    const a = (await call("POST", "/quickmatch", { body: { game: "tictactoe", options }, headers: { "X-Api-Key": user.apiKey } })).json;
    const b = (await call("POST", "/quickmatch", { body: { game: "tictactoe", options } })).json;
    expect(b.roomId).toBe(a.roomId);
    // p1（API キー付き）が上段を揃えて勝つ
    const moves: [{ token: string }, number][] = [[a, 0], [b, 3], [a, 1], [b, 4], [a, 2]];
    for (const [i, [p, cell]] of moves.entries()) {
      expect((await call("POST", `/rooms/${a.roomId}/action`, { token: p.token, body: { turn: i, action: { cell } } })).status).toBe(200);
    }
    expect((await call("GET", `/users/${user.userId}`)).json.stats).toMatchObject({ played: 1, wins: 1 });
  });
});
