import { SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import type { AnyGame } from "../../src/games/types";
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";
import { replay } from "../../src/lib/replay";
import { countdown } from "../fixtures/countdown";
import { guess, GUESS_MAX } from "../fixtures/guess";
import { BASE, call } from "./helpers";

// ゲームオプション（countdown）と合法手を列挙しないゲーム（guess）を、このファイルの間だけ登録する
beforeAll(() => {
  games[countdown.id] = countdown as AnyGame;
  games[guess.id] = guess as AnyGame;
});
afterAll(() => {
  delete games[countdown.id];
  delete games[guess.id];
});

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

/** 受信を溜めておき、条件に合うメッセージを待つ。 */
async function connect(roomId: string, token?: string) {
  const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": token ? `${WS_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${token}` : WS_PROTOCOL,
    },
  });
  const ws = res.webSocket!;
  ws.accept();
  open.push(ws);
  const msgs: any[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    msgs.push(JSON.parse(e.data as string));
    waiters.splice(0).forEach((w) => w());
  });
  return {
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    async next(pred: (m: any) => boolean): Promise<any> {
      for (;;) {
        const i = msgs.findIndex(pred);
        if (i >= 0) return msgs.splice(i, 1)[0];
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };
}

async function room(game: string, body: Record<string, unknown> = {}) {
  const { status, json } = await call("POST", "/rooms", { body: { game, ...body } });
  expect(status).toBe(201);
  const a = (await call("POST", `/rooms/${json.roomId}/join`)).json;
  const b = (await call("POST", `/rooms/${json.roomId}/join`)).json;
  const seats: Record<string, { playerId: string; token: string }> = { [a.playerId]: a, [b.playerId]: b };
  return { roomId: json.roomId as string, host: json.hostToken as string, seats };
}

/** REST で、手番の人が legal の先頭を打ち続けて終わらせる。 */
async function playOutWithLegal(roomId: string, seats: Record<string, { token: string }>) {
  for (let i = 0; i < 100; i++) {
    const s = (await call("GET", `/rooms/${roomId}/state`)).json;
    if (s.status === "finished") return s;
    const pid = s.currentPlayers[0] as string;
    const me = (await call("GET", `/rooms/${roomId}/state`, { token: seats[pid]!.token })).json;
    const r = await call("POST", `/rooms/${roomId}/action`, { token: seats[pid]!.token, body: { turn: me.turn, action: me.legal[0] } });
    expect(r.status).toBe(200);
  }
  throw new Error("did not finish");
}

describe("ゲーム固有のオプション（gameOptions）", () => {
  it("既定値を補って記録され、state・WS・log・replay・matches に載る。シード + オプション + ログで再現できる", async () => {
    const { roomId, host, seats } = await room(countdown.id, { gameOptions: { start: 4 } });
    const waiting = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(waiting.gameOptions).toEqual({ start: 4, maxStep: 2 });

    const spec = await connect(roomId);
    expect((await spec.next((m) => m.type === "state")).gameOptions).toEqual({ start: 4, maxStep: 2 });
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const started = await spec.next((m) => m.type === "state" && m.status === "playing");
    expect(started.view.left).toBe(4); // init に渡っている

    await playOutWithLegal(roomId, seats);
    const log = (await call("GET", `/rooms/${roomId}/log`)).json;
    expect(log.gameOptions).toEqual({ start: 4, maxStep: 2 });
    const final = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(replay(countdown as AnyGame, log).result).toEqual(final.result);
    expect((await call("GET", `/rooms/${roomId}/replay`)).json.gameOptions).toEqual({ start: 4, maxStep: 2 });

    const matches = (await call("GET", `/matches?game=${countdown.id}`)).json as any[];
    expect(matches.find((m) => m.id === roomId)?.gameOptions).toEqual({ start: 4, maxStep: 2 });
  });

  it("オプションの無いゲームは null。未知のキー・範囲外の値・オプションの無いゲームへの指定は 400", async () => {
    const t = await room("tictactoe");
    expect((await call("GET", `/rooms/${t.roomId}/state`)).json.gameOptions).toBeNull();
    for (const body of [
      { game: countdown.id, gameOptions: { start: 4, extra: true } },
      { game: countdown.id, gameOptions: { start: 0 } },
      { game: countdown.id, gameOptions: "x" },
      { game: "tictactoe", gameOptions: {} },
    ]) {
      const r = await call("POST", "/rooms", { body });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("BAD_REQUEST");
    }
  });

  it("再戦はゲームオプションを引き継ぐ", async () => {
    const { roomId, host, seats } = await room(countdown.id, { gameOptions: { start: 3, maxStep: 1 } });
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    await playOutWithLegal(roomId, seats);
    const r = await call("POST", `/rooms/${roomId}/rematch`, { token: seats["p1"]!.token });
    expect(r.status).toBe(200);
    expect((await call("GET", `/rooms/${r.json.roomId}/state`)).json.gameOptions).toEqual({ start: 3, maxStep: 1 });
  });

  it("クイックマッチは同じゲームオプション（既定値を補った値）のルームにだけ入る", async () => {
    const turnTimeMs = 4321_000;
    // 変則オプションの autoStart ルームは、既定のオプションのクイックマッチに拾われない
    const odd = (await call("POST", "/rooms", {
      body: { game: countdown.id, options: { autoStart: true, turnTimeMs }, gameOptions: { start: 30 } },
    })).json;
    await call("POST", `/rooms/${odd.roomId}/join`);
    const list = (await call("GET", `/rooms?game=${countdown.id}`)).json as any[];
    expect(list.find((x) => x.roomId === odd.roomId)?.gameOptions).toEqual({ start: 30, maxStep: 2 });

    const plain = await call("POST", "/quickmatch", { body: { game: countdown.id, options: { turnTimeMs } } });
    expect(plain.json.created).toBe(true);
    expect(plain.json.roomId).not.toBe(odd.roomId);
    // 省略と既定値の明示は同じ扱い
    const explicit = await call("POST", "/quickmatch", {
      body: { game: countdown.id, options: { turnTimeMs }, gameOptions: { start: 5, maxStep: 2 } },
    });
    expect(explicit.json).toMatchObject({ roomId: plain.json.roomId, created: false });
    // 同じ変則オプションなら入る
    const same = await call("POST", "/quickmatch", { body: { game: countdown.id, options: { turnTimeMs }, gameOptions: { start: 30 } } });
    expect(same.json).toMatchObject({ roomId: odd.roomId, created: false });

    const bad = await call("POST", "/quickmatch", { body: { game: countdown.id, gameOptions: { nope: 1 } } });
    expect(bad.status).toBe(400);
  });

  it("/games と /games/:id/rules にオプションの有無・Schema・既定値が載る", async () => {
    const list = (await call("GET", "/games")).json as any[];
    expect(list.find((g) => g.id === countdown.id)).toMatchObject({ hasOptions: true, listsLegalActions: true });
    expect(list.find((g) => g.id === "tictactoe")).toMatchObject({ hasOptions: false, listsLegalActions: true });
    const rules = (await call("GET", `/games/${countdown.id}/rules`)).json;
    expect(rules.optionsSchema).toHaveProperty("type", "object");
    expect(rules.defaultGameOptions).toEqual({ start: 5, maxStep: 2 });
  });
});

describe("合法手を列挙しないゲーム（legalActions 未定義）", () => {
  it("手番のプレイヤーにも legal は付かず、行動は apply で検証される", async () => {
    const { roomId, host, seats } = await room(guess.id);
    const wa = await connect(roomId, seats["p1"]!.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const s = await wa.next((m) => m.type === "state" && m.status === "playing");
    expect(s.currentPlayers).toEqual(["p1"]);
    expect(s).not.toHaveProperty("legal");
    const rest = (await call("GET", `/rooms/${roomId}/state`, { token: seats["p1"]!.token })).json;
    expect(rest).not.toHaveProperty("legal");

    // 形は正しいが範囲外：ILLEGAL_ACTION。同じ turn でやり直せる
    wa.send({ type: "action", turn: 0, action: { guess: GUESS_MAX + 1 } });
    expect((await wa.next((m) => m.type === "error")).code).toBe("ILLEGAL_ACTION");
    wa.send({ type: "action", turn: 0, action: { guess: 50 } });
    expect((await wa.next((m) => m.type === "state" && m.turn === 1)).view.guesses).toHaveLength(1);

    const list = (await call("GET", "/games")).json as any[];
    expect(list.find((g) => g.id === guess.id)).toMatchObject({ listsLegalActions: false });
  });

  it("練習相手は practiceAction で打ち、最後まで進む", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: guess.id, options: { practice: true } } });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    const ws = await connect(json.roomId, me.token);
    // 自分も二分探索で打つ
    for (let i = 0; i < 50; i++) {
      const s = await ws.next((m) => m.type === "state" || m.type === "end");
      if (s.type === "end") return expect(s.reason).toBe("normal");
      if (s.status !== "playing" || !s.currentPlayers.includes(me.playerId)) continue;
      ws.send({ type: "action", turn: s.turn, action: guess.practiceAction!(fromView(s.view), me.playerId, null!) });
    }
    throw new Error("did not finish");
  });
});

/** practiceAction は範囲（guesses のヒント）しか見ないので、view から組み立てられる。 */
const fromView = (v: { players: string[]; guesses: any[] }) => ({ players: v.players, secret: 0, turn: 0, guesses: v.guesses });

describe("REST の状態と WS の state は同じフィールド", () => {
  it("type 以外は一致する（game・rulesVersion・gameOptions・result も WS に載る）", async () => {
    const { roomId, host, seats } = await room(countdown.id, { gameOptions: { start: 2, maxStep: 1 } });
    const wa = await connect(roomId, seats["p1"]!.token);
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    const ws = await wa.next((m) => m.type === "state" && m.status === "playing");
    const rest = (await call("GET", `/rooms/${roomId}/state`, { token: seats["p1"]!.token })).json;
    const { type, now: _n1, ...wsRest } = ws;
    const { now: _n2, ...restRest } = rest;
    expect(type).toBe("state");
    expect(wsRest).toEqual(restRest);
    expect(Object.keys(wsRest).sort()).toEqual(Object.keys(restRest).sort());
    expect(ws).toHaveProperty("game", countdown.id);
    expect(ws).toHaveProperty("rulesVersion", 1);
    expect(ws).toHaveProperty("result", null);

    await playOutWithLegal(roomId, seats);
    const fin = await wa.next((m) => m.type === "state" && m.status === "finished");
    expect(fin.result).toEqual((await call("GET", `/rooms/${roomId}/state`)).json.result);
  });
});
