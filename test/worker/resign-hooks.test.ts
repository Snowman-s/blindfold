import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { games } from "../../src/games/registry";
import type { AnyGame } from "../../src/games/types";
import { WS_PROTOCOL } from "../../src/lib/auth";
import { elimination } from "../fixtures/elimination";
import { BASE, call, playOut } from "./helpers";

// onResign / onTimeout を持つテスト専用のゲームを、このファイルの間だけ登録する
beforeAll(() => {
  games[elimination.id] = elimination as AnyGame;
});
afterAll(() => {
  delete games[elimination.id];
});

const stub = (id: string) => env.GAME_ROOM.getByName(id);

async function room(n: number) {
  const { json } = await call("POST", "/rooms", { body: { game: elimination.id } });
  const ps: { playerId: string; token: string }[] = [];
  for (let i = 0; i < n; i++) ps.push((await call("POST", `/rooms/${json.roomId}/join`)).json);
  await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
  return { roomId: json.roomId as string, ps };
}

async function endMessage(roomId: string) {
  const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": WS_PROTOCOL },
  });
  const ws = res.webSocket!;
  const msgs: any[] = [];
  const got = new Promise<any>((resolve) =>
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      msgs.push(m);
      if (m.type === "end") resolve(m);
    }),
  );
  ws.accept();
  const m = await got;
  ws.close();
  return m;
}

const reasonInD1 = async (id: string) =>
  (await env.DB.prepare("SELECT reason FROM matches WHERE id = ?").bind(id).first<{ reason: string }>())?.reason;

describe("onResign を定義したゲーム", () => {
  it("投了者だけが抜けて試合が続き、最後に決着すると reason=resign。リプレイも一致する", async () => {
    const { roomId, ps } = await room(3);
    const [p1, p2] = ps;

    const r1 = await call("POST", `/rooms/${roomId}/resign`, { token: p2!.token }); // 手番でない p2 が抜ける
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ status: "playing", turn: 1, currentPlayers: ["p1"], view: { alive: ["p1", "p3"] } });
    expect(r1.json.deadline).toBeGreaterThan(Date.now());

    const again = await call("POST", `/rooms/${roomId}/resign`, { token: p2!.token });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe("ILLEGAL_ACTION");

    await call("POST", `/rooms/${roomId}/action`, { token: p1!.token, body: { turn: 1, action: { pass: true } } });
    const r2 = await call("POST", `/rooms/${roomId}/resign`, { token: p1!.token });
    expect(r2.json).toMatchObject({ status: "finished", turn: 3, result: { winners: ["p3"] } });

    expect(await endMessage(roomId)).toMatchObject({ winners: ["p3"], reason: "resign" });
    expect(await reasonInD1(roomId)).toBe("resign");
    const rp = (await call("GET", `/rooms/${roomId}/replay`)).json;
    expect(rp.result).toEqual(r2.json.result);
    expect(rp.frames.map((f: { turn: number }) => f.turn)).toEqual([0, 1, 2, 3]);
  });

  it("onTimeout で決着したときは reason=timeout", async () => {
    const { roomId } = await room(2);
    await runInDurableObject(stub(roomId), (_i, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'deadline'", String(Date.now() - 1));
    });
    expect(await runDurableObjectAlarm(stub(roomId))).toBe(true);
    const s = (await call("GET", `/rooms/${roomId}/state`)).json;
    expect(s).toMatchObject({ status: "finished", result: { winners: ["p2"] } });
    expect(await endMessage(roomId)).toMatchObject({ reason: "timeout" });
    expect(await reasonInD1(roomId)).toBe("timeout");
  });
});

describe("行動ログの読み込み", () => {
  it("知らない形のシステム行は時間切れと読み替えずにエラーにする", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" } });
    const a = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    const b = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await playOut(json.roomId, json.hostToken, a, b);
    expect((await call("GET", `/rooms/${json.roomId}/log`)).status).toBe(200);
    await runInDurableObject(stub(json.roomId), (_i, state) => {
      state.storage.sql.exec("INSERT INTO actions(turn, player, action, at) VALUES (5, '', '{\"$unknown\":1}', 0)");
    });
    // 500 の原因は GameRoom が console.error に出す。わざと起こすエラーなので、このテストの間だけ黙らせて中身を確かめる
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call("GET", `/rooms/${json.roomId}/log`);
      expect(res.status).toBe(500);
      expect(res.json.error.code).toBe("INTERNAL");
      expect(logged).toHaveBeenCalledWith(
        "failed to read action log",
        expect.objectContaining({ message: "corrupt system log row at turn 5" }),
      );
    } finally {
      logged.mockRestore();
    }
  });
});
