import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { randomPick, runBot, type SocketLike } from "../../bots/bot-core";
import { games } from "../../src/games/registry";
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";
import { replay } from "../../src/lib/replay";
import { LogSchema, ReplaySchema } from "../../src/routes/rooms";
import { BASE, call, newRoom, playOut } from "./helpers";
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

/** 接続直後から受信を溜める（初回の state を取りこぼさない）。bot にもそのまま渡せる。 */
class Conn implements SocketLike {
  msgs: any[] = [];
  private waiters: (() => void)[] = [];
  private listeners: ((ev: { data: unknown }) => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      this.msgs.push(JSON.parse(e.data as string));
      this.listeners.forEach((l) => l({ data: e.data }));
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  send(data: string) {
    this.ws.send(data);
  }
  close() {
    this.ws.close();
  }
  addEventListener(type: "message" | "close", fn: any) {
    if (type === "close") return this.ws.addEventListener("close", fn);
    this.msgs.forEach((m) => fn({ data: JSON.stringify(m) })); // 溜めた分を再生
    this.listeners.push(fn);
  }
  async next(pred: (m: any) => boolean): Promise<any> {
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

/** ブラウザと同じく、トークンはサブプロトコルで渡す。版のサブプロトコルは観戦でも必須。 */
const wsHeaders = (token?: string): Record<string, string> => ({
  Upgrade: "websocket",
  "Sec-WebSocket-Protocol": token ? `${WS_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${token}` : WS_PROTOCOL,
});

async function connect(roomId: string, token?: string): Promise<Conn> {
  const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, { headers: wsHeaders(token) });
  expect(res.status).toBe(101);
  expect(res.headers.get("Sec-WebSocket-Protocol")).toBe(WS_PROTOCOL); // トークンは応答に載せない
  const ws = res.webSocket!;
  ws.accept(); // クライアント側の accept（DO 側は Hibernation API）
  open.push(ws);
  return new Conn(ws);
}
const stub = (id: string) => env.GAME_ROOM.getByName(id);

/** 締め切りだけ過去にずらす（alarm は発火させない = 発火が遅れている状況）。 */
async function pastDeadline(roomId: string) {
  await runInDurableObject(stub(roomId), (_i, state) => {
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'deadline'", String(Date.now() - 1));
  });
}

describe("WebSocket", () => {
  it("アップグレード要求がなければ 426、不正トークンは 401、存在しないルームは 404", async () => {
    const { roomId } = await newRoom("tictactoe");
    expect((await call("GET", `/rooms/${roomId}/ws`)).status).toBe(426);
    const bad = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, { headers: wsHeaders("nope") });
    expect(bad.status).toBe(401);
    const none = await SELF.fetch(`${BASE}/rooms/zzz/ws`, { headers: { Upgrade: "websocket" } });
    expect(none.status).toBe(404);
  });

  it("接続直後に state が届き、行動すると全員にその視点の state が配信される", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wa = await connect(roomId, a.token);
    const wb = await connect(roomId, b.token);
    const spec = await connect(roomId);
    expect((await wa.next((m) => m.type === "state")).status).toBe("waiting");

    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const sa = await wa.next((m) => m.status === "playing");
    const sb = await wb.next((m) => m.status === "playing");
    await spec.next((m) => m.status === "playing");
    expect(sa.legal).toHaveLength(9); // 手番のプレイヤーにだけ legal
    expect(sb.legal).toBeUndefined();
    expect(sa.currentPlayers).toEqual(["p1"]);

    wa.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 4 } }));
    const sb1 = await wb.next((m) => m.turn === 1);
    expect(sb1.legal).toHaveLength(8);
    expect((await spec.next((m) => m.turn === 1)).legal).toBeUndefined();
    expect((await wa.next((m) => m.turn === 1)).legal).toBeUndefined();
  });

  it("state にサーバー時刻 now が入る（WS・REST とも）", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    const t0 = Date.now();
    const wa = await connect(roomId, a.token);
    const s0 = await wa.next((m) => m.type === "state");
    expect(s0.now).toBeGreaterThanOrEqual(t0);
    const r = (await call("POST", `/rooms/${roomId}/start`, { token: host })).json;
    expect(r.now).toBeGreaterThanOrEqual(t0);
    expect(r.deadline - r.now).toBeGreaterThan(0);
    const s1 = await wa.next((m) => m.status === "playing");
    expect(s1.deadline - s1.now).toBeGreaterThan(0);
  });

  it("同じトークンで複数接続でき、両方に配信される。2本目の同ターンの手は STALE_TURN", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    const w1 = await connect(roomId, a.token);
    const w2 = await connect(roomId, a.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await w1.next((m) => m.status === "playing");
    await w2.next((m) => m.status === "playing");
    w1.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 0 } }));
    await w2.next((m) => m.turn === 1);
    w2.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 1 } }));
    expect((await w2.next((m) => m.type === "error")).code).toBe("STALE_TURN");
    expect((await w1.next((m) => m.turn === 1)).view).toEqual((await w2.next((m) => m.turn === 1)).view);
  });

  it("切断しても負けにならず、再接続すると現在の state（legal 付き）が届いて続きを打てる", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wa = await connect(roomId, a.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await wa.next((m) => m.status === "playing");
    wa.close();
    const wb = await connect(roomId, b.token);
    const wa2 = await connect(roomId, a.token);
    const s = await wa2.next((m) => m.type === "state");
    expect(s).toMatchObject({ status: "playing", turn: 0 });
    expect(s.legal).toHaveLength(9);
    wa2.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 4 } }));
    expect((await wb.next((m) => m.turn === 1)).legal).toHaveLength(8);
  });

  it("REST の行動も WS 接続に配信される", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wb = await connect(roomId, b.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } });
    const s = await wb.next((m) => m.turn === 1);
    expect(s.legal).toHaveLength(8);
  });

  it("エラーは REST と同じコードで返り、接続は維持される", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wa = await connect(roomId, a.token);
    const wb = await connect(roomId, b.token);
    const spec = await connect(roomId);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await wa.next((m) => m.status === "playing");

    wa.send("not json");
    expect((await wa.next((m) => m.type === "error")).code).toBe("BAD_REQUEST");
    wa.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 99 } }));
    expect((await wa.next((m) => m.type === "error" && m.message === "invalid action")).code).toBe("BAD_REQUEST");

    wb.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 0 } }));
    expect((await wb.next((m) => m.type === "error")).code).toBe("NOT_YOUR_TURN");
    spec.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 0 } }));
    expect((await spec.next((m) => m.type === "error")).code).toBe("UNAUTHORIZED");

    wa.send(JSON.stringify({ type: "action", turn: 5, action: { cell: 0 } }));
    expect((await wa.next((m) => m.type === "error" && m.code === "STALE_TURN")).code).toBe("STALE_TURN");

    wa.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 0 } }));
    await wb.next((m) => m.turn === 1);
    wb.send(JSON.stringify({ type: "action", turn: 1, action: { cell: 0 } }));
    expect((await wb.next((m) => m.type === "error" && m.code === "ILLEGAL_ACTION")).code).toBe("ILLEGAL_ACTION");

    wa.send(JSON.stringify({ type: "ping" }));
    expect((await wa.next((m) => m.type === "pong")).type).toBe("pong");
  });

  it("終了済みルームに接続すると state の後に end が届く", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const ws = await connect(roomId);
    const end = await ws.next((m) => m.type === "end");
    expect(end.winners).toEqual(["p1"]);
  });
});

describe("Bot 同士の対戦", () => {
  for (const game of ["tictactoe", "highcard"]) {
    it(`${game}: 最後まで終わり、ログから再現できる`, async () => {
      const { roomId, host, a, b } = await newRoom(game);
      const sockA = await connect(roomId, a.token);
      const sockB = await connect(roomId, b.token);
            const [ra, rb] = await Promise.all([
        runBot(sockA, {
          pick: randomPick,
          startWhen: {
            players: 2,
            start: async () => void (await call("POST", `/rooms/${roomId}/start`, { token: host })),
          },
        }),
        runBot(sockB, { pick: randomPick }),
      ]);
      expect(ra).toEqual(rb);

      const state = (await call("GET", `/rooms/${roomId}/state`)).json;
      expect(state.status).toBe("finished");
      expect(state.result.winners).toEqual(ra.winners);

      // ログ + シードから完全に再現できる
      const log = (await call("GET", `/rooms/${roomId}/log`)).json;
      const r = replay(games[game]!, log);
      expect(r.turn).toBe(state.turn);
      expect(r.result).toEqual(state.result);
      expect(games[game]!.view(r.state, null)).toEqual(state.view);

      // リプレイ API
      expect(LogSchema.parse(log)).toEqual(log);
      const rp = (await call("GET", `/rooms/${roomId}/replay`)).json;
      expect(ReplaySchema.parse(rp)).toEqual(rp);
      // frames[i].action は frames[i] を作ったログの行（actions[i - 1]）
      expect(rp.frames[0].action).toBeNull();
      expect(rp.frames.slice(1).map((f: { action: unknown }) => f.action)).toEqual(log.actions);
      for (const f of rp.frames) games[game]!.viewSchema.parse(f.view);
      games[game]!.viewSchema.parse(state.view);
      expect(rp.frames).toHaveLength(state.turn + 1);
      expect(rp.frames.at(-1).view).toEqual(state.view);
      expect(rp.result).toEqual(state.result);
    });
  }

  it("highcard: 観戦者・相手の state に隠し情報が含まれない", async () => {
    const { roomId, host, a, b } = await newRoom("highcard");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const sa = (await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json;
    const sb = (await call("GET", `/rooms/${roomId}/state`, { token: b.token })).json;
    const ss = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(sa.view.hand).toHaveLength(5);
    expect(sb.view.hand).toHaveLength(5);
    expect(ss.view.hand).toBeUndefined();
    expect(sa.legal).toHaveLength(5);
    await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: sa.legal[0] } });
    const ss2 = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(ss2.view.hasPlayed).toEqual({ p1: true, p2: false });
    expect(JSON.stringify(ss2.view)).not.toContain(`"myPlayed"`);
    expect(ss2.currentPlayers).toEqual(["p2"]);
  });
});

describe("練習相手（options.practice）", () => {
  for (const game of ["tictactoe", "highcard"]) {
    it(`${game}: 1人で参加すると空席を 練習相手が埋め、最後まで遊べる。戦績には残らない`, async () => {
      const { json } = await call("POST", "/rooms", { body: { game, options: { practice: true } } });
      const roomId: string = json.roomId;
      const a = (await call("POST", `/rooms/${roomId}/join`)).json;
      expect(a.playerId).toBe("p1");
      const sock = await connect(roomId, a.token);
      const end = await runBot(sock, {
        pick: randomPick,
        startWhen: {
          players: 1,
          start: async () => void (await call("POST", `/rooms/${roomId}/start`, { token: json.hostToken })),
        },
      });

      const state = (await call("GET", `/rooms/${roomId}/state`)).json;
      expect(state.status).toBe("finished");
      expect(state.players).toEqual(["p1", "p2"]);
      expect(state.result.winners).toEqual(end.winners);

      // Bot の手もログに入り、シード + ログから再現できる
      const log = (await call("GET", `/rooms/${roomId}/log`)).json;
      expect(log.actions.some((e: any) => e.player === "p2")).toBe(true);
      const r = replay(games[game]!, log);
      expect(r.result).toEqual(state.result);

      const m = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE id = ?").bind(roomId).first<{ n: number }>();
      expect(m!.n).toBe(0);
    });
  }

  it("誰も参加しなくても開始でき、Bot 同士で決着する", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true } } });
    const s = await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    expect(s.status).toBe(200);
    expect(s.json.status).toBe("finished");
  });

  it("練習相手の手も actionSchema で検証し、満たさない手はログに入れない（持ち時間切れに任せる）。ログには検証後の手を書く", async () => {
    const id = "test-practice-validate";
    const base = games.tictactoe!;
    const legal = (s: unknown, pid: string) => base.legalActions!(s as never, pid);
    // p2（練習相手）は1手目だけ余計なフィールド付きの手（strip される）、2手目は範囲外の手を返す
    let calls = 0;
    games[id] = {
      ...(base as any),
      id,
      practiceAction: (s: unknown, pid: string) => (++calls === 1 ? { ...(legal(s, pid)[0] as object), extra: 1 } : { cell: 99 }),
    };
    try {
      const { json } = await call("POST", "/rooms", { body: { game: id, options: { practice: true } } });
      const a = (await call("POST", `/rooms/${json.roomId}/join`)).json;
      await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
      const s1 = (await call("POST", `/rooms/${json.roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } })).json;
      expect(s1.turn).toBe(2); // p2 の1手目は通る
      const s2 = (await call("POST", `/rooms/${json.roomId}/action`, { token: a.token, body: { turn: 2, action: { cell: 3 } } })).json;
      expect(s2.status).toBe("playing");
      expect(s2.turn).toBe(3); // p2 の2手目は弾かれ、p2 の手番のまま
      expect(s2.currentPlayers).toEqual(["p2"]);
      const rows = await runInDurableObject(stub(json.roomId), (_i, st) =>
        st.storage.sql.exec("SELECT player, action FROM actions ORDER BY turn").toArray(),
      );
      expect(rows.map((r) => JSON.parse(r.action as string))).toEqual([{ cell: 0 }, { cell: 1 }, { cell: 3 }]);
    } finally {
      delete games[id];
    }
  });

  it("1回で打つ手数の上限に達したら、続きは alarm で打つ", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true } } });
    const roomId: string = json.roomId;
    await runInDurableObject(stub(roomId) as DurableObjectStub, async (i: unknown) => {
      (i as { botStepsPerCall: number }).botStepsPerCall = 2;
    });
    // 開始のリクエストでは2手だけ打って返る
    const started = (await call("POST", `/rooms/${roomId}/start`, { token: json.hostToken })).json;
    expect(started.status).toBe("playing");
    expect(started.turn).toBe(2);
    // 続きは alarm で打たれ、決着まで進む（テスト環境では alarm が自動で発火することもある）
    let st = started;
    for (let n = 0; st.status === "playing"; n++) {
      expect(n).toBeLessThan(20);
      await runDurableObjectAlarm(stub(roomId));
      st = (await call("GET", `/rooms/${roomId}/state`)).json;
    }
    expect(st.status).toBe("finished");
    expect(st.turn).toBeGreaterThan(2);
  });

  it("人数が揃っていれば Bot は入らない。practice に真偽値以外は 400", async () => {
    const { roomId, host, a } = await newRoom("tictactoe", { practice: true });
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const st = (await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json;
    expect(st.status).toBe("playing");
    expect(st.turn).toBe(0);
    expect(st.legal).toHaveLength(9);
    expect((await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: "random" } } })).status).toBe(400);
  });
});

describe("持ち時間（Alarm）", () => {
  it("state に deadline が入る。不正な turnTimeMs は 400", async () => {
    expect((await call("POST", "/rooms", { body: { game: "tictactoe", options: { turnTimeMs: 5 } } })).status).toBe(400);
    const { roomId, host, a } = await newRoom("tictactoe", { turnTimeMs: 30_000 });
    expect((await call("GET", `/rooms/${roomId}/state`)).json.deadline).toBeNull();
    const t0 = Date.now();
    const s = (await call("POST", `/rooms/${roomId}/start`, { token: host })).json;
    expect(s.deadline).toBeGreaterThanOrEqual(t0 + 30_000);
    expect(s.deadline).toBeLessThan(t0 + 40_000);
  });

  it("締め切り前に alarm が誤発火しても何も起きない", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await runDurableObjectAlarm(stub(roomId));
    expect((await call("GET", `/rooms/${roomId}/state`)).json.status).toBe("playing");
  });

  /** 締め切りを過去にずらして alarm を発火させる。 */
  async function expire(roomId: string) {
    await pastDeadline(roomId);
    expect(await runDurableObjectAlarm(stub(roomId))).toBe(true);
  }

  it("手番のプレイヤーが時間切れで負け。WS に end が届き、ログから再現できる", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wb = await connect(roomId, b.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } });
    await expire(roomId); // p2 の手番で時間切れ

    const end = await wb.next((m) => m.type === "end");
    expect(end.winners).toEqual(["p1"]);
    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state).toMatchObject({ status: "finished", deadline: null, turn: 2 });
    expect(state.result.winners).toEqual(["p1"]);
    expect(
      (await call("POST", `/rooms/${roomId}/action`, { token: b.token, body: { turn: 2, action: { cell: 1 } } })).status,
    ).toBe(409);

    const log = (await call("GET", `/rooms/${roomId}/log`)).json;
    expect(log.actions[1]).toMatchObject({ turn: 1, player: null, timeout: ["p2"] });
    const r = replay(games["tictactoe"]!, log);
    expect(r.result).toEqual(state.result);
    expect(r.turn).toBe(2);
    const rp = (await call("GET", `/rooms/${roomId}/replay`)).json;
    expect(rp.result).toEqual(state.result);
    expect(ReplaySchema.parse(rp)).toEqual(rp);
    expect(rp.frames[2].action).toEqual({ turn: 1, player: null, action: null, at: expect.any(Number), timeout: ["p2"] });
  });

  it("同時手番では、まだ出していないプレイヤーだけが負ける", async () => {
    const { roomId, host, a } = await newRoom("highcard");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const sa = (await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json;
    await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: sa.legal[0] } });
    await expire(roomId);
    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state.status).toBe("finished");
    expect(state.result.winners).toEqual(["p1"]);
  });

  it("時間切れは D1 に reason=timeout で記録される", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await expire(roomId);
    const m = await env.DB.prepare("SELECT reason FROM matches WHERE id = ?").bind(roomId).first<{ reason: string }>();
    expect(m?.reason).toBe("timeout");
  });

  it("全員が時間切れなら引き分けではなく全員の負けとして記録される", async () => {
    const { roomId, host } = await newRoom("highcard");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await expire(roomId); // 誰も出さずに時間切れ
    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state.status).toBe("finished");
    expect(state.result.winners).toEqual([]);
    const rows = await env.DB.prepare("SELECT player_id, outcome FROM results WHERE match_id = ? ORDER BY player_id")
      .bind(roomId)
      .all<{ player_id: string; outcome: string }>();
    expect(rows.results).toEqual([
      { player_id: "p1", outcome: "loss" },
      { player_id: "p2", outcome: "loss" },
    ]);
  });

  it("同時手番で片方が出しても締め切りは延びない", async () => {
    const { roomId, host, a, b } = await newRoom("highcard", { turnTimeMs: 60_000 });
    const s0 = (await call("POST", `/rooms/${roomId}/start`, { token: host })).json;
    // 締め切りを過去寄りにずらしておき、行動後に延長されていないことを確かめる
    const d0 = s0.deadline - 30_000;
    await runInDurableObject(stub(roomId), (_i, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'deadline'", String(d0));
    });
    const sa = (await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json;
    const s1 = (await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: sa.legal[0] } }))
      .json;
    expect(s1.currentPlayers).toEqual(["p2"]);
    expect(s1.deadline).toBe(d0);
    expect(await runInDurableObject(stub(roomId), (_i, state) => state.storage.getAlarm())).toBe(d0);

    // 両者が出して次のラウンドに入ったら持ち時間はリセットされる
    const sb = (await call("GET", `/rooms/${roomId}/state`, { token: b.token })).json;
    const s2 = (await call("POST", `/rooms/${roomId}/action`, { token: b.token, body: { turn: 1, action: sb.legal[0] } }))
      .json;
    expect(s2.currentPlayers).toEqual(["p1", "p2"]);
    expect(s2.deadline).toBeGreaterThan(d0);
  });

  it("締め切り後に届いた REST の行動は拒否され、その場で時間切れが確定する", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await pastDeadline(roomId); // p1 の手番で締め切りを過ぎた
    const r = await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("STALE_TURN");

    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state).toMatchObject({ status: "finished", turn: 1, deadline: null });
    expect(state.result.winners).toEqual(["p2"]); // 遅れた p1 の手は盤面に入らず、p1 の負け
    expect(state.view.board.every((c: unknown) => c === null)).toBe(true);
    const log = (await call("GET", `/rooms/${roomId}/log`)).json;
    expect(log.actions).toEqual([expect.objectContaining({ turn: 0, player: null, timeout: ["p1"] })]);

    // 後から古い alarm が発火しても二重に処理されない
    await runDurableObjectAlarm(stub(roomId));
    expect((await call("GET", `/rooms/${roomId}/log`)).json.actions).toHaveLength(1);
  });

  it("締め切り後に届いた WS の行動は STALE_TURN になり、全員に end が届く", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wa = await connect(roomId, a.token);
    const wb = await connect(roomId, b.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await wa.next((m) => m.status === "playing");
    await pastDeadline(roomId);
    wa.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 4 } }));
    expect((await wa.next((m) => m.type === "error")).code).toBe("STALE_TURN");
    expect((await wa.next((m) => m.type === "end")).winners).toEqual(["p2"]);
    expect((await wb.next((m) => m.type === "end")).winners).toEqual(["p2"]);
  });

  it("同時手番でも締め切り後の手は受け付けず、出していなかったプレイヤーが負ける", async () => {
    const { roomId, host, a, b } = await newRoom("highcard");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const sa = (await call("GET", `/rooms/${roomId}/state`, { token: a.token })).json;
    await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: sa.legal[0] } });
    await pastDeadline(roomId);
    const sb = (await call("GET", `/rooms/${roomId}/state`, { token: b.token })).json;
    const r = await call("POST", `/rooms/${roomId}/action`, { token: b.token, body: { turn: 1, action: sb.legal[0] } });
    expect(r.json.error.code).toBe("STALE_TURN");
    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state.status).toBe("finished");
    expect(state.result.winners).toEqual(["p1"]);
  });

  /** DO インスタンスの ctx.storage.setAlarm を、最初の n 回だけ失敗させる。 */
  async function failSetAlarm(roomId: string, n: number) {
    await runInDurableObject(stub(roomId), (i) => {
      const inst = i as unknown as { ctx: DurableObjectState; __realCtx?: DurableObjectState };
      inst.__realCtx ??= inst.ctx; // 二度目以降も元の ctx から包み直す
      const real = inst.__realCtx;
      let left = n;
      const storage = new Proxy(real.storage, {
        get(target, prop) {
          if (prop === "setAlarm") {
            return (at: number) => (left-- > 0 ? Promise.reject(new Error("setAlarm down")) : target.setAlarm(at));
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const ctx = new Proxy(real, {
        get(target, prop) {
          if (prop === "storage") return storage;
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      Object.defineProperty(inst, "ctx", { value: ctx, configurable: true });
    });
  }
  const alarmOf = (roomId: string) => runInDurableObject(stub(roomId), (_i, state) => state.storage.getAlarm());

  it("setAlarm が一時的に失敗しても、その場の再試行で締め切りが張られる", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await failSetAlarm(roomId, 2);
    const r = await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } });
    expect(r.status).toBe(200);
    expect(await alarmOf(roomId)).toBe(r.json.deadline);
  });

  it("setAlarm が失敗し続けても行動は成功し、次のアクセスで締め切りが張り直される", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await failSetAlarm(roomId, 100);
    await runInDurableObject(stub(roomId), (_i, state) => state.storage.deleteAlarm());
    const r = await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 0 } } });
    expect(r.status).toBe(200); // 確定済みの行動は成功として返る
    expect(r.json.turn).toBe(1);
    expect(await alarmOf(roomId)).toBeNull();

    await failSetAlarm(roomId, 0); // 復旧
    const s = (await call("GET", `/rooms/${roomId}/state`)).json; // 観戦者のアクセスでも直る
    expect(await alarmOf(roomId)).toBe(s.deadline);
  });

  it("D1 への書き込みが失敗したら alarm で再試行する", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    let realDb: D1Database | null = null;
    await runInDurableObject(stub(roomId), (i) => {
      const inst = i as unknown as { env: Env };
      realDb = inst.env.DB;
      const broken = { batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
      inst.env = { ...inst.env, DB: broken };
    });
    await playOut(roomId, host, a, b);
    expect((await call("GET", `/rooms/${roomId}/state`)).json.status).toBe("finished");
    const count = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE id = ?").bind(roomId).first<{ n: number }>())!.n;
    expect(await count()).toBe(0);

    // 再試行用の alarm が予約されている。D1 を戻して発火させると書き込まれる
    await runInDurableObject(stub(roomId), async (i, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      const inst = i as unknown as { env: Env };
      inst.env = { ...inst.env, DB: realDb! };
    });
    expect(await runDurableObjectAlarm(stub(roomId))).toBe(true);
    expect(await count()).toBe(1);
  });
});

describe("投了（resign）", () => {
  it("WS で手番でないプレイヤーが投了すると全員に end（reason=resign）が届き、ログ・リプレイでも同じ結果になる", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    const wa = await connect(roomId, a.token);
    const wb = await connect(roomId, b.token);
    const spec = await connect(roomId);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await call("POST", `/rooms/${roomId}/action`, { token: a.token, body: { turn: 0, action: { cell: 4 } } });
    await wa.next((m) => m.turn === 1);
    wa.send(JSON.stringify({ type: "resign" })); // p2 の手番だが p1 が投了

    for (const c of [wa, wb, spec]) {
      expect(await c.next((m) => m.type === "end")).toMatchObject({ winners: ["p2"], reason: "resign" });
    }
    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state).toMatchObject({ status: "finished", turn: 2, deadline: null });
    expect(state.result).toEqual({ winners: ["p2"], scores: { p1: 0, p2: 1 } });
    expect(state.view.board[4]).toBe("X"); // 盤面は投了で変わらない

    const log = (await call("GET", `/rooms/${roomId}/log`)).json;
    expect(log.actions).toHaveLength(2);
    expect(log.actions[1]).toMatchObject({ turn: 1, player: null, action: null, resign: "p1" });
    expect(log.actions[1].timeout).toBeUndefined();
    const r = replay(games["tictactoe"]!, log);
    expect(r.result).toEqual(state.result);
    expect(r.turn).toBe(2);
    const rp = (await call("GET", `/rooms/${roomId}/replay`)).json;
    expect(rp.result).toEqual(state.result);
    expect(rp.frames.map((f: { turn: number }) => f.turn)).toEqual([0, 1, 2]);
    expect(rp.frames[2].action).toMatchObject({ resign: "p1" });

    // 後から接続しても end に reason が付く
    const late = await connect(roomId);
    expect(await late.next((m) => m.type === "end")).toMatchObject({ reason: "resign" });
  });

  it("REST で投了でき、D1 に reason=resign・投了者の負けで記録される", async () => {
    const { roomId, host, a, b } = await newRoom("highcard");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const r = await call("POST", `/rooms/${roomId}/resign`, { token: b.token });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "finished", result: { winners: ["p1"] } });
    expect(r.json.legal).toBeUndefined();

    const m = await env.DB.prepare("SELECT reason FROM matches WHERE id = ?").bind(roomId).first<{ reason: string }>();
    expect(m?.reason).toBe("resign");
    const rows = await env.DB.prepare("SELECT player_id, outcome FROM results WHERE match_id = ? ORDER BY player_id")
      .bind(roomId)
      .all<{ player_id: string; outcome: string }>();
    expect(rows.results).toEqual([
      { player_id: "p1", outcome: "win" },
      { player_id: "p2", outcome: "loss" },
    ]);
    const matches = (await call("GET", "/matches?game=highcard&limit=100")).json;
    expect(matches.find((x: { id: string }) => x.id === roomId)?.reason).toBe("resign");

    // 終了後の投了は NOT_PLAYING。勝者は変わらない
    const again = await call("POST", `/rooms/${roomId}/resign`, { token: a.token });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("NOT_PLAYING");
    expect((await call("GET", `/rooms/${roomId}/state`)).json.result.winners).toEqual(["p1"]);
  });

  it("待機中・観戦者・不正なトークンの投了は拒否される", async () => {
    const { roomId, host, a } = await newRoom("tictactoe");
    const waiting = await call("POST", `/rooms/${roomId}/resign`, { token: a.token });
    expect(waiting.status).toBe(409);
    expect(waiting.json.error.code).toBe("NOT_PLAYING");
    expect((await call("POST", `/rooms/${roomId}/resign`)).status).toBe(401);
    expect((await call("POST", `/rooms/${roomId}/resign`, { token: host })).status).toBe(401); // hostToken は席ではない
    expect((await call("POST", `/rooms/zzz/resign`, { token: a.token })).status).toBe(404);

    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const spec = await connect(roomId);
    spec.send(JSON.stringify({ type: "resign" }));
    expect((await spec.next((m) => m.type === "error")).code).toBe("UNAUTHORIZED");
    expect((await call("GET", `/rooms/${roomId}/state`)).json.status).toBe("playing");
  });

  it("WS で終了後に投了すると NOT_PLAYING（REST と同じコード）", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    const wb = await connect(roomId, b.token);
    expect(await wb.next((m) => m.type === "end")).toMatchObject({ winners: ["p1"], reason: "normal" });
    wb.send(JSON.stringify({ type: "resign" }));
    expect((await wb.next((m) => m.type === "error")).code).toBe("NOT_PLAYING");
  });

  it("締め切り後の投了は、先に時間切れが確定して NOT_PLAYING になる", async () => {
    const { roomId, host, b } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await pastDeadline(roomId); // p1 の手番で締め切りを過ぎた
    const r = await call("POST", `/rooms/${roomId}/resign`, { token: b.token });
    expect(r.status).toBe(409);
    const state = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(state.result.winners).toEqual(["p2"]); // 時間切れで p1 の負け（p2 の投了は無効）
    const ws = await connect(roomId);
    expect(await ws.next((m) => m.type === "end")).toMatchObject({ reason: "timeout" });
  });

  it("練習相手との試合でも投了できる", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe", options: { practice: true } } });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    const r = await call("POST", `/rooms/${json.roomId}/resign`, { token: me.token });
    expect(r.json).toMatchObject({ status: "finished", result: { winners: ["p2"] } });
  });
});

describe("ルームの存在確認・入力の制限", () => {
  it("存在しないルームへのアクセスでは DO にテーブルが作られない", async () => {
    const id = "ghost-room-for-test";
    expect((await call("GET", `/rooms/${id}/state`)).status).toBe(404);
    expect((await call("POST", `/rooms/${id}/join`)).status).toBe(404);
    const tables = await runInDurableObject(stub(id), (_i, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
        .toArray()
        .map((r) => r.name),
    );
    expect(tables).toEqual([]);
  });

  it("未知のオプションは 400", async () => {
    const r = await call("POST", "/rooms", { body: { game: "tictactoe", options: { junk: "x".repeat(1000) } } });
    expect(r.status).toBe(400);
  });

  it("WS のトークンは URL に載せられない（?token= は 400）", async () => {
    const { roomId, a } = await newRoom("tictactoe");
    const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws?token=${a.token}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("BAD_REQUEST");
  });

  it("版のサブプロトコル（apigames.v1）が無い・知らない版だけ・トークンが複数あるなら 400", async () => {
    const { roomId, a, b } = await newRoom("tictactoe");
    const upgrade = (protocols?: string) =>
      SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
        headers: { Upgrade: "websocket", ...(protocols !== undefined ? { "Sec-WebSocket-Protocol": protocols } : {}) },
      });
    expect((await upgrade()).status).toBe(400); // 観戦でも版は必須
    expect((await upgrade(`apigames.token.${a.token}`)).status).toBe(400);
    const unversioned = await upgrade(`apigames, apigames.token.${a.token}`); // 版の無い旧名
    expect(unversioned.status).toBe(400);
    expect(((await unversioned.json()) as any).error.message).toContain(WS_PROTOCOL);
    expect((await upgrade("apigames.v999")).status).toBe(400);
    expect((await upgrade(`${WS_PROTOCOL}, apigames.token.${a.token}, apigames.token.${b.token}`)).status).toBe(400);
  });

  it("知っている版と知らない版を並べて提示したら、知っている版を選ぶ", async () => {
    const { roomId } = await newRoom("tictactoe");
    const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `apigames.v999, ${WS_PROTOCOL}` },
    });
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe(WS_PROTOCOL);
    res.webSocket!.accept();
    open.push(res.webSocket!);
  });

  it("ヘッダーを付けられるクライアントは Authorization: Bearer でも WS に接続できる", async () => {
    const { roomId, host, b } = await newRoom("tictactoe");
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": WS_PROTOCOL, Authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe(WS_PROTOCOL);
    const ws = res.webSocket!;
    ws.accept();
    open.push(ws);
    const s = await new Conn(ws).next((m) => m.type === "state");
    expect(s.currentPlayers).toEqual(["p1"]);
    expect(s.legal).toBeUndefined(); // p2 として接続している
  });
});

describe("D1（users / matches / results）", () => {
  it("ユーザー登録 → 参加 → 終了で戦績が付く。API キーはハッシュで保存", async () => {
    const u = await call("POST", "/users", { body: { name: "alice" } });
    expect(u.status).toBe(201);
    const stored = await env.DB.prepare("SELECT key_hash FROM users WHERE id = ?")
      .bind(u.json.userId)
      .first<{ key_hash: string }>();
    expect(stored!.key_hash).not.toContain(u.json.apiKey);

    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const roomId = json.roomId;
    const host: string = json.hostToken;
    const a = (await call("POST", `/rooms/${roomId}/join`, { headers: { "X-Api-Key": u.json.apiKey } })).json;
    const b = (await call("POST", `/rooms/${roomId}/join`)).json;
    expect((await call("POST", `/rooms/${roomId}/join`, { headers: { "X-Api-Key": "bad" } })).status).toBe(401);
    await playOut(roomId, host, a, b);

    const user = await call("GET", `/users/${u.json.userId}`);
    expect(user.json.stats).toEqual({ played: 1, wins: 1, losses: 0, draws: 0 });
    expect((await call("GET", "/users/nope")).status).toBe(404);

    const list = (await call("GET", "/matches?game=tictactoe&limit=5")).json;
    const m = list.find((x: any) => x.id === roomId);
    expect(m.reason).toBe("normal");
    expect(m.results).toEqual([
      { playerId: "p1", userId: u.json.userId, outcome: "win", score: 1 },
      { playerId: "p2", userId: null, outcome: "loss", score: 0 },
    ]);
    expect((await call("GET", "/matches?limit=0")).status).toBe(400);
  });

  it("結果の書き込みは冪等（同じ試合を二重に書いても1行）", async () => {
    const { roomId, host, a, b } = await newRoom("tictactoe");
    await playOut(roomId, host, a, b);
    // persistResult を直接もう一度呼んでも、D1 には1試合分しか入らない
    const inst = stub(roomId) as unknown as { persistResult: (g: unknown, r: unknown) => Promise<void> };
    await runInDurableObject(stub(roomId) as DurableObjectStub, async (i: unknown) => {
      await (i as typeof inst).persistResult(games["tictactoe"]!, { winners: ["p1"] });
    });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM results WHERE match_id = ?")
      .bind(roomId)
      .first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});

describe("OpenAPI", () => {
  it("/docs は HTML で openapi.json を参照する", async () => {
    const res = await SELF.fetch(BASE + "/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("/openapi.json");
  });

  it("/docs の外部ファイルはバージョン固定 + SRI、CSP はインラインの初期化スクリプトだけを許可する", async () => {
    const res = await SELF.fetch(BASE + "/docs");
    const html = await res.text();
    const external = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https:[^"]+)"[^>]*>/g)];
    expect(external).toHaveLength(2);
    for (const [tag, url] of external) {
      expect(url).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\//); // @5 のような範囲指定ではない
      expect(tag).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
      expect(tag).toContain('crossorigin="anonymous"');
    }

    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(inline).toHaveLength(1);
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inline[0]!));
    const hash = btoa(String.fromCharCode(...new Uint8Array(d)));
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("/openapi.json に主要パスが含まれる", async () => {
    const r = await call("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe("3.1.0");
    const paths = Object.keys(r.json.paths);
    for (const p of [
      "/games", "/games/{id}/rules", "/games/{id}/rules.md", "/rooms", "/rooms/{id}/join", "/rooms/{id}/start", "/rooms/{id}/state", "/rooms/{id}/action",
      "/rooms/{id}/log", "/rooms/{id}/replay", "/rooms/{id}/ws", "/users", "/users/{id}/key", "/matches",
    ]) {
      expect(paths).toContain(p);
    }
    expect(r.json.paths["/rooms/{id}/ws"].get.responses["426"].description).toContain("UPGRADE_REQUIRED");
    expect(r.json.paths["/rooms"].post.responses["201"].content["application/json"].schema.properties).toHaveProperty(
      "hostToken",
    );
  });
});
