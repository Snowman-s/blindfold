import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("frontier（部屋で通しで遊ぶ）", () => {
  it("練習相手で 3 席を埋め、毎ラウンド保留し続けると maxRounds で決着する", async () => {
    const { json } = await call("POST", "/rooms", {
      body: { game: "frontier", options: { practice: true, seats: 3 }, gameOptions: { maxRounds: 5 } },
    });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    expect((await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken })).status).toBe(200);
    for (let i = 0; i < 20; i++) {
      const s = (await call("GET", `/rooms/${json.roomId}/state`, { token: me.token })).json;
      expect(s.players).toHaveLength(3);
      expect(s).not.toHaveProperty("legal");
      if (s.status === "finished") {
        expect(s.view.round).toBeLessThanOrEqual(5);
        expect(s.result.scores).toHaveProperty("p1");
        return;
      }
      // 練習相手は自分の手番ですぐ打つので、行動できるのは自分だけのはず
      expect(s.currentPlayers).toEqual([me.playerId]);
      const r = await call("POST", `/rooms/${json.roomId}/action`, { token: me.token, body: { turn: s.turn, action: { orders: [] } } });
      expect(r.status).toBe(200);
    }
    throw new Error("did not finish");
  });

  it("同じラウンドなら、他の人が先に出して turn が進んでいても、見ていた turn のままで受け付ける", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "frontier", options: { seats: 3 } } });
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push((await call("POST", `/rooms/${json.roomId}/join`)).json);
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    const send = (p: { token: string }, turn: number) =>
      call("POST", `/rooms/${json.roomId}/action`, { token: p.token, body: { turn, action: { orders: [] } } });
    const start = (await call("GET", `/rooms/${json.roomId}/state`)).json;
    expect(start.phaseTurn).toBe(0);
    // 3人とも turn 0 の state を見て送る
    expect((await send(ps[0], 0)).status).toBe(200);
    // p1 が出した後の state（p2 には、自分の手より前に作られたものとして届きうる）：turn は進むが phaseTurn は 0 のまま
    const mid = (await call("GET", `/rooms/${json.roomId}/state`)).json;
    expect(mid.turn).toBe(1);
    expect(mid.phaseTurn).toBe(0);
    expect(mid.currentPlayers).toEqual([ps[1].playerId, ps[2].playerId]);
    const dup = await send(ps[0], 0); // 二重送信
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("STALE_TURN");
    expect((await send(ps[1], 0)).status).toBe(200);
    expect((await send(ps[2], 0)).status).toBe(200);
    const s = (await call("GET", `/rooms/${json.roomId}/state`)).json;
    expect(s.turn).toBe(3);
    expect(s.view.round).toBe(1);
    expect(s.phaseTurn).toBe(3); // 新しいラウンドは turn 3 に始まった
    // 次のラウンドでは、前のラウンドの turn は受け付けない
    const old = await send(ps[1], 1);
    expect(old.json.error.code).toBe("STALE_TURN");
    expect((await send(ps[1], 3)).status).toBe(200);
  });

  it("出し終えた人がラウンドの途中で投了しても、締め切りは延びず、見ていた turn の命令も受け付ける", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "frontier", options: { seats: 3 } } });
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push((await call("POST", `/rooms/${json.roomId}/join`)).json);
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    const send = (p: { token: string }, turn: number) =>
      call("POST", `/rooms/${json.roomId}/action`, { token: p.token, body: { turn, action: { orders: [] } } });
    expect((await send(ps[0], 0)).status).toBe(200);
    expect((await send(ps[1], 0)).status).toBe(200);
    const before = (await call("GET", `/rooms/${json.roomId}/state`)).json;
    expect(before.currentPlayers).toEqual([ps[2].playerId]);
    expect((await call("POST", `/rooms/${json.roomId}/resign`, { token: ps[0].token })).status).toBe(200);
    const after = (await call("GET", `/rooms/${json.roomId}/state`)).json;
    expect(after.turn).toBe(before.turn + 1);
    expect(after.currentPlayers).toEqual([ps[2].playerId]);
    expect(after.deadline).toBe(before.deadline);
    // p3 は turn 0 の state を見て送っていた
    expect((await send(ps[2], 0)).status).toBe(200);
    expect((await call("GET", `/rooms/${json.roomId}/state`)).json.view.round).toBe(1);
  });

  it("不正な命令は ILLEGAL_ACTION で、どの命令かを示す", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "frontier", options: { practice: true } } });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    const s = (await call("GET", `/rooms/${json.roomId}/state`, { token: me.token })).json;
    const notMine = s.view.nodes.find((n: { owner: string | null }) => n.owner !== me.playerId).id;
    const r = await call("POST", `/rooms/${json.roomId}/action`, {
      token: me.token,
      body: { turn: s.turn, action: { orders: [{ from: notMine, to: 0, count: 1 }] } },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("ILLEGAL_ACTION");
    expect(r.json.error.message).toContain("orders[0]");
  });
});
