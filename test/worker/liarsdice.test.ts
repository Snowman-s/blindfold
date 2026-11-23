import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("liarsdice（部屋で通しで遊ぶ）", () => {
  it("練習相手と 3 人で、最小の宣言かダウトを繰り返すと決着し、他人の目は見えない", async () => {
    const { json } = await call("POST", "/rooms", {
      body: { game: "liarsdice", options: { practice: true, seats: 3 }, gameOptions: { startDice: 2 } },
    });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    expect((await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken })).status).toBe(200);
    for (let i = 0; i < 60; i++) {
      const s = (await call("GET", `/rooms/${json.roomId}/state`, { token: me.token })).json;
      expect(s).not.toHaveProperty("legal");
      expect(s.view).not.toHaveProperty("dice");
      if (s.status === "finished") {
        expect(s.result.winners).toHaveLength(1);
        expect(Object.keys(s.result.scores).sort()).toEqual(s.players.slice().sort());
        return;
      }
      if (!s.view.alive.includes(me.playerId)) {
        // 脱落後は見ているだけ（練習相手どうしで進む）
        expect(s.view.myDice).toEqual([]);
        expect(s.currentPlayers).not.toContain(me.playerId);
        expect((await call("POST", `/rooms/${json.roomId}/resign`, { token: me.token })).status).not.toBe(200);
        continue;
      }
      expect(s.currentPlayers).toEqual([me.playerId]);
      expect(s.view.myDice).toHaveLength(s.view.diceCounts[me.playerId]);
      const face = (s.view.minBids as (number | null)[]).findIndex((q) => q !== null) + 1;
      const action = s.view.currentBid ? { type: "challenge" } : { type: "bid", quantity: s.view.minBids[face - 1], face };
      const r = await call("POST", `/rooms/${json.roomId}/action`, { token: me.token, body: { turn: s.turn, action } });
      expect(r.status).toBe(200);
    }
    throw new Error("did not finish");
  });

  it("宣言を上げられない手は ILLEGAL_ACTION で、理由が書いてある", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "liarsdice", options: { seats: 2 } } });
    const ps = [(await call("POST", `/rooms/${json.roomId}/join`)).json, (await call("POST", `/rooms/${json.roomId}/join`)).json];
    await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken });
    const s = (await call("GET", `/rooms/${json.roomId}/state`)).json;
    const actor = ps.find((p) => p.playerId === s.currentPlayers[0])!;
    const send = (action: unknown) => call("POST", `/rooms/${json.roomId}/action`, { token: actor.token, body: { turn: s.turn, action } });
    const ones = await send({ type: "bid", quantity: 1, face: 1 });
    expect(ones.json.error.code).toBe("ILLEGAL_ACTION");
    expect(ones.json.error.message).toContain("ones are wild");
    expect((await send({ type: "challenge" })).json.error.code).toBe("ILLEGAL_ACTION");
    expect((await send({ type: "bid", quantity: 11, face: 3 })).json.error.code).toBe("ILLEGAL_ACTION");
    expect((await send({ type: "bid", quantity: 2, face: 3 })).status).toBe(200);
  });
});
