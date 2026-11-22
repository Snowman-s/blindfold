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
