import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";
import { BASE } from "./helpers";

it("GET / はガイドへの入口を返す", async () => {
  const res = await SELF.fetch(`${BASE}/`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ name: "apigames", ok: true, guide: `${BASE}/guide.md`, openapi: `${BASE}/openapi.json` });
});

it("GET / は Accept: text/markdown ならガイド本文を返す", async () => {
  const res = await SELF.fetch(`${BASE}/`, { headers: { Accept: "text/markdown" } });
  expect(res.headers.get("Content-Type")).toMatch(/^text\/markdown/);
  expect(await res.text()).toMatch(/^# apigames — Client Developer Guide/);
});

describe("GET /guide.md", () => {
  it("Markdown で、Base URL がリクエストのオリジンに置き換わっている", async () => {
    const res = await SELF.fetch(`${BASE}/guide.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/markdown/);
    const md = await res.text();
    expect(md).not.toContain("{{BASE}}");
    expect(md).toContain(`Base URL      ${BASE}`);
  });

  it("間違えると動かない文字列が TL;DR（冒頭）にある", async () => {
    const md = await (await SELF.fetch(`${BASE}/guide.md`)).text();
    const tldr = md.slice(0, md.indexOf("## 1."));
    expect(tldr).toContain(`["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token]`);
    expect(tldr).toContain("?token= is rejected with 400");
    expect(tldr).toContain('"turn":<turn of latest state>');
  });

  it("全ゲームが、ルールへのリンクと state の例つきで載っている", async () => {
    const md = await (await SELF.fetch(`${BASE}/guide.md`)).text();
    for (const id of Object.keys(games)) {
      expect(md).toContain(`### \`${id}\``);
      expect(md).toContain(`${BASE}/games/${id}/rules.md`);
    }
    // 例の state は ServerMessage の state と同じキーを持つ
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));
    const states = blocks.filter((b) => b && b.type === "state");
    expect(states.length).toBe(Object.keys(games).length * 2);
    for (const s of states) {
      expect(Object.keys(s)).toEqual(expect.arrayContaining(["turn", "view", "currentPlayers", "deadline", "status", "players"]));
    }
  });

  it("隠し情報は観戦者の例に出ない（highcard）", async () => {
    const md = await (await SELF.fetch(`${BASE}/guide.md`)).text();
    const section = md.slice(md.indexOf("### `highcard`"));
    const [player, spectator] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((m) => JSON.parse(m[1]!))
      .filter((b) => b.type === "state");
    expect(player.view.hand).toBeDefined();
    expect(player.legal).toBeDefined();
    expect(spectator.view.hand).toBeUndefined();
    expect(spectator.legal).toBeUndefined();
  });

  it("最小クライアントが作るルームは実際に作成できる（options が正しい）", async () => {
    const md = await (await SELF.fetch(`${BASE}/guide.md`)).text();
    const m = md.match(/post\("\/rooms", \{ game: "(\w+)", options: \{ practice: (\w+) \} \}\)/);
    expect(m).not.toBeNull();
    const res = await SELF.fetch(`${BASE}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: m![1], options: { practice: JSON.parse(m![2]!) } }),
    });
    expect(res.status).toBe(201);
  });

  it("/llms.txt も同じ内容で、version の ETag で 304 を返す", async () => {
    const a = await SELF.fetch(`${BASE}/guide.md`);
    const b = await SELF.fetch(`${BASE}/llms.txt`);
    expect(await b.text()).toBe(await a.text());
    const etag = a.headers.get("ETag")!;
    expect(etag).toMatch(/^"[0-9a-f]{12}"$/);
    const c = await SELF.fetch(`${BASE}/guide.md`, { headers: { "If-None-Match": etag } });
    expect(c.status).toBe(304);
  });
});

describe("CORS", () => {
  it("プリフライトに Authorization を許可して応答する", async () => {
    const res = await SELF.fetch(`${BASE}/rooms`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("authorization");
  });

  it("通常のレスポンスにも Access-Control-Allow-Origin が付く", async () => {
    const res = await SELF.fetch(`${BASE}/games`, { headers: { Origin: "https://client.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
