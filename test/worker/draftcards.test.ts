import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { BASE, call } from "./helpers";

describe("draftcards（部屋で通しで遊ぶ）", () => {
  it("練習相手と 3 人で、同時手番のドラフトとラウンドを最後まで進められ、ほかの人の手札は見えない", async () => {
    const { json } = await call("POST", "/rooms", { body: { game: "draftcards", options: { practice: true, seats: 3 } } });
    const me = (await call("POST", `/rooms/${json.roomId}/join`)).json;
    expect((await call("POST", `/rooms/${json.roomId}/start`, { token: json.hostToken })).status).toBe(200);
    let acted = 0;
    for (let i = 0; i < 40; i++) {
      const s = (await call("GET", `/rooms/${json.roomId}/state`, { token: me.token })).json;
      expect(s.players).toHaveLength(3);
      expect(s.view).not.toHaveProperty("hands");
      const spectator = (await call("GET", `/rooms/${json.roomId}/state`)).json;
      expect(spectator.view).not.toHaveProperty("hand");
      expect(spectator.view).not.toHaveProperty("pack");
      if (s.status === "finished") {
        expect(acted).toBe(6 + 6); // ピック 6 回とラウンド 6 回
        expect(s.view.phase).toBe("over");
        expect(Object.keys(s.result.scores).sort()).toEqual(s.players.slice().sort());
        return;
      }
      // 練習相手は同時手番の始めに打つので、行動できるのは自分だけ
      expect(s.currentPlayers).toEqual([me.playerId]);
      expect(s.legal.length).toBeGreaterThan(0);
      const r = await call("POST", `/rooms/${json.roomId}/action`, { token: me.token, body: { turn: s.turn, action: s.legal[0] } });
      expect(r.status).toBe(200);
      acted++;
    }
    throw new Error("did not finish");
  });

  it("rules に catalog（カードの読み方・schema・全カード）が載り、Markdown にも出る", async () => {
    const r = (await call("GET", "/games/draftcards/rules")).json;
    expect(r.catalog.items.length).toBeGreaterThanOrEqual(56);
    expect(r.catalog.schema).toHaveProperty("type", "object");
    expect(r.catalog.docs).toContain("#### Effects");
    expect((await call("GET", "/games/tictactoe/rules")).json.catalog).toBeNull();
    const md = await (await SELF.fetch(`${BASE}/games/draftcards/rules.md`)).text();
    expect(md).toContain("## Catalog");
    expect(md).toContain(JSON.stringify(r.catalog.items[0]));
  });
});
