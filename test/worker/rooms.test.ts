import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tictactoe } from "../../src/games/tictactoe";
import { rngForTurn } from "../../src/lib/rng";

const BASE = "https://example.com";

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await SELF.fetch(BASE + path, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any }; // テスト内のみ
}

async function setup() {
  const { json: created } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
  const roomId: string = created.roomId;
  const a = (await call("POST", `/rooms/${roomId}/join`)).json;
  const b = (await call("POST", `/rooms/${roomId}/join`)).json;
  return { roomId, host: created.hostToken as string, a, b };
}

describe("REST: ルーム", () => {
  it("GET /games", async () => {
    const r = await call("GET", "/games");
    expect(r.status).toBe(200);
    expect(r.json).toEqual([
      { id: "tictactoe", minPlayers: 2, maxPlayers: 2 },
      { id: "highcard", minPlayers: 2, maxPlayers: 2 },
    ]);
  });

  it("未知のゲーム・不正なボディは 400", async () => {
    expect((await call("POST", "/rooms", { body: { game: "nope" } })).status).toBe(400);
    expect((await call("POST", "/rooms", { body: { foo: 1 } })).status).toBe(400);
  });

  it("存在しないルームは 404", async () => {
    expect((await call("POST", "/rooms/nonexistent/join")).status).toBe(404);
    expect((await call("GET", "/rooms/nonexistent/state")).status).toBe(404);
  });

  it("参加・開始の制約", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const id = json.roomId;
    const host: string = json.hostToken;
    const a = (await call("POST", `/rooms/${id}/join`)).json;
    expect(a.playerId).toBe("p1");

    // 人数不足
    expect((await call("POST", `/rooms/${id}/start`, { token: host })).json.error.code).toBe("NOT_ENOUGH_PLAYERS");

    const b = (await call("POST", `/rooms/${id}/join`)).json;
    expect((await call("POST", `/rooms/${id}/join`)).status).toBe(409); // 満員

    // 作成者以外（最初に参加した p1 も含む）・不正トークン・トークンなしは開始できない
    expect((await call("POST", `/rooms/${id}/start`, { token: a.token })).status).toBe(403);
    expect((await call("POST", `/rooms/${id}/start`, { token: "nope" })).status).toBe(401);
    expect((await call("POST", `/rooms/${id}/start`, { token: b.token })).status).toBe(403);
    expect((await call("POST", `/rooms/${id}/start`)).status).toBe(401);

    expect((await call("POST", `/rooms/${id}/start`, { token: host })).status).toBe(200);
    expect((await call("POST", `/rooms/${id}/start`, { token: host })).status).toBe(409);
    expect((await call("POST", `/rooms/${id}/join`)).status).toBe(409); // 開始後は参加不可
  });
});

describe("REST: 対戦", () => {
  it("開始前は行動できない", async () => {
    const { roomId, host, a } = await setup();
    const r = await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } });
    expect(r.json.error.code).toBe("NOT_PLAYING");
  });

  it("状態取得: legal は手番のプレイヤーにだけ付く", async () => {
    const { roomId, host, a, b } = await setup();
    await call("POST", `/rooms/${roomId}/start`, { token: host });

    const sa = (await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json;
    const sb = (await call("GET", `/rooms/${roomId}/state`, { token: b.token })).json;
    const spectator = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(sa.legal).toHaveLength(9);
    expect(sb.legal).toBeUndefined();
    expect(spectator.legal).toBeUndefined();
    expect(spectator.currentPlayers).toEqual(["p1"]);
    expect(spectator.status).toBe("playing");
    // URL にトークンを載せる方式は廃止（ログ・履歴に残るため）。黙って観戦扱いにせず 400 にする
    const q = await call("GET", `/rooms/${roomId}/state?token=${a.token}`);
    expect(q.status).toBe(400);
    expect(q.json.error.code).toBe("BAD_REQUEST");
    expect((await call("GET", `/rooms/${roomId}/state`, { token: "bogus" })).status).toBe(401);
  });

  it("不正な行動のエラーコード", async () => {
    const { roomId, host, a, b } = await setup();
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const act = (token: string, turn: number, action: unknown) =>
      call("POST", `/rooms/${roomId}/action`, { token, body: { turn, action } });

    expect((await act(b.token, 0, { cell: 0 })).json.error.code).toBe("NOT_YOUR_TURN");
    expect((await act(a.token, 5, { cell: 0 })).json.error.code).toBe("STALE_TURN");
    expect((await act(a.token, 0, { cell: 99 })).json.error.code).toBe("BAD_REQUEST");
    expect((await act("bogus", 0, { cell: 0 })).status).toBe(401);

    expect((await act(a.token, 0, { cell: 4 })).status).toBe(200);
    // 二重送信は STALE_TURN
    expect((await act(a.token, 0, { cell: 4 })).json.error.code).toBe("STALE_TURN");
    // 埋まっているマス
    expect((await act(b.token, 1, { cell: 4 })).json.error.code).toBe("ILLEGAL_ACTION");
  });

  it("最後まで遊べて、ログから再現できる", async () => {
    const { roomId, host, a, b } = await setup();
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const tokens: Record<string, string> = { p1: a.token, p2: b.token };

    // 途中でログは見られない
    expect((await call("GET", `/rooms/${roomId}/log`)).status).toBe(403);

    let state = (await call("GET", `/rooms/${roomId}/state`)).json;
    while (state.status === "playing") {
      const pid: string = state.currentPlayers[0];
      const mine = (await call("GET", `/rooms/${roomId}/state`, { token: tokens[pid] })).json;
      const r = await call("POST", `/rooms/${roomId}/action`, {
        token: tokens[pid],
        body: { turn: mine.turn, action: mine.legal[0] },
      });
      expect(r.status).toBe(200);
      state = r.json;
    }
    expect(state.status).toBe("finished");
    expect(state.result).not.toBeNull();
    expect(state.currentPlayers).toEqual([]);

    // 終了後は行動できない
    const after = await call("POST", `/rooms/${roomId}/action`, {
      token: a.token,
      body: { turn: state.turn, action: { cell: 0 } },
    });
    expect(after.json.error.code).toBe("NOT_PLAYING");

    const log = (await call("GET", `/rooms/${roomId}/log`)).json;
    expect(log.game).toBe("tictactoe");
    expect(log.players).toEqual(["p1", "p2"]);
    expect(log.seed).toMatch(/^[0-9a-f]{32}$/); // 128 ビット
    expect(log.actions.map((x: { turn: number }) => x.turn)).toEqual(log.actions.map((_: unknown, i: number) => i));

    let s = tictactoe.init(log.players, log.seed);
    for (const x of log.actions) s = tictactoe.apply(s, x.player, x.action, rngForTurn(log.seed, x.turn));
    expect(tictactoe.result(s)).toEqual(state.result);
    expect(tictactoe.view(s, null)).toEqual(state.view);
  });
});

describe("壊れた JSON", () => {
  it("POST /rooms に不正な JSON を送ると 400 BAD_REQUEST", async () => {
    const res = await SELF.fetch(BASE + "/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("BAD_REQUEST");
  });
});
