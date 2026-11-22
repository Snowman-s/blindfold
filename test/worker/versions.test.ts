import { SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { games } from "../../src/games/registry";
import type { AnyGame } from "../../src/games/types";
import { CHANGELOG } from "../../src/lib/changelog";
import { deprecated, deprecationHeaders, markDeprecated } from "../../src/lib/deprecation";
import { API_VERSION } from "../../src/lib/version";
import { BASE, call, newRoom } from "./helpers";

const semver = (v: string) => v.split(".").map(Number) as [number, number, number];
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

describe("/changelog.md", () => {
  it("先頭の版は API_VERSION で、新しい順に並ぶ", () => {
    expect(CHANGELOG[0]!.version).toBe(API_VERSION);
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(newer(CHANGELOG[i - 1]!.version, CHANGELOG[i]!.version)).toBe(true);
      expect(CHANGELOG[i - 1]!.date >= CHANGELOG[i]!.date).toBe(true);
    }
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("Markdown で返し、ETag で 304 を返す。英語だけで書かれている", async () => {
    const res = await SELF.fetch(`${BASE}/changelog.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain(`## ${API_VERSION} (`);
    expect(md).not.toMatch(/[぀-ヿ一-鿿＀-￯]/);
    const etag = res.headers.get("ETag")!;
    expect(etag).toMatch(/^"[0-9a-f]{12}"$/);
    const again = await SELF.fetch(`${BASE}/changelog.md`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("ガイドの TL;DR・9 節とルートの JSON からリンクされる", async () => {
    const md = await (await SELF.fetch(`${BASE}/guide.md`)).text();
    expect(md).toContain(`Changelog     ${BASE}/changelog.md`);
    expect(md.slice(md.indexOf("## 9."))).toContain("/changelog.md");
    const root = await (await SELF.fetch(`${BASE}/`)).json<{ changelog: string }>();
    expect(root.changelog).toBe(`${BASE}/changelog.md`);
  });
});

describe("Deprecation / Sunset", () => {
  const since = new Date("2027-01-01T00:00:00Z");
  const sunset = new Date("2027-06-30T23:59:59Z");

  it("RFC 9745 / 8594 の形式で作る", () => {
    expect(deprecationHeaders({ since })).toEqual({
      deprecation: "@1798761600",
      links: ['</changelog.md>; rel="deprecation"; type="text/markdown"'],
    });
    const h = deprecationHeaders({ since, sunset, link: "/guide.md" });
    expect(h.sunset).toBe("Wed, 30 Jun 2027 23:59:59 GMT");
    expect(h.links).toEqual([
      '</guide.md>; rel="deprecation"; type="text/markdown"',
      '</guide.md>; rel="sunset"; type="text/markdown"',
    ]);
    expect(() => deprecationHeaders({ since: sunset, sunset: since })).toThrow();
    expect(() => deprecated({ since: sunset, sunset: since })).toThrow();
  });

  it("ミドルウェアはルートの応答に、markDeprecated は呼んだ応答にだけ付ける", async () => {
    const app = new Hono();
    app.get("/old", deprecated({ since, sunset }), (c) => {
      c.header("Link", "</next>; rel=\"next\"");
      return c.json({ ok: true });
    });
    app.get("/field", (c) => {
      if (c.req.query("legacy")) markDeprecated(c, { since });
      return c.json({ ok: true });
    });

    const old = await app.request("/old");
    expect(old.headers.get("Deprecation")).toBe("@1798761600");
    expect(old.headers.get("Sunset")).toBe("Wed, 30 Jun 2027 23:59:59 GMT");
    const link = old.headers.get("Link")!;
    expect(link).toContain('rel="next"'); // 既存の Link は消さない
    expect(link).toContain('rel="deprecation"');
    expect(link).toContain('rel="sunset"');

    expect((await app.request("/field")).headers.get("Deprecation")).toBeNull();
    const legacy = await app.request("/field?legacy=1");
    expect(legacy.headers.get("Deprecation")).toBe("@1798761600");
    expect(legacy.headers.get("Sunset")).toBeNull();
  });

  it("ヘッダーを書き換えられない応答（DO の fetch() の結果など）にも付けられる", async () => {
    const app = new Hono();
    app.get("/frozen", deprecated({ since }), async () => {
      // fetch() の応答はヘッダーが immutable
      const res = await SELF.fetch(`${BASE}/rooms/nope/ws`, { headers: { Upgrade: "websocket" } });
      expect(() => res.headers.set("X-Test", "1")).toThrow();
      return res;
    });
    const res = await app.request("/frozen");
    expect(res.status).toBe(404);
    expect(res.headers.get("Deprecation")).toBe("@1798761600");
  });

  it("CORS でブラウザにも見せる", async () => {
    const res = await SELF.fetch(`${BASE}/games`, { headers: { Origin: "https://app.example" } });
    const exposed = (res.headers.get("Access-Control-Expose-Headers") ?? "").toLowerCase();
    for (const h of ["etag", "deprecation", "sunset", "link"]) expect(exposed).toContain(h);
  });
});

describe("rulesVersion", () => {
  it("/games と /games/:id/rules に載る", async () => {
    const list = (await call("GET", "/games")).json as { id: string; rulesVersion: number }[];
    for (const g of list) {
      expect(g.rulesVersion).toBe(games[g.id]!.rulesVersion);
      const r = (await call("GET", `/games/${g.id}/rules`)).json;
      expect(r.rulesVersion).toBe(g.rulesVersion);
      const md = await (await SELF.fetch(`${BASE}/games/${g.id}/rules.md`)).text();
      expect(md.split("\n")[0]).toContain(`rulesVersion ${g.rulesVersion}`);
    }
  });

  it("開始時に記録し、state・log・replay・matches で返す。ルールが変わったらリプレイを断る", async () => {
    // 共有の games.tictactoe は書き換えない（他のテストや gameRules のキャッシュに版 2 が漏れないように）。
    // tictactoe の写しを別 ID で登録し、その写しを版 2 に差し替える。
    const id = "test-rules-version";
    const v1: AnyGame = { ...(games.tictactoe as AnyGame), id, rulesVersion: 1 };
    games[id] = v1;
    try {
      await playAndCheck(id);
    } finally {
      delete games[id];
    }
  });

  async function playAndCheck(id: string) {
    const { roomId, host, a } = await newRoom(id);
    expect((await call("GET", `/rooms/${roomId}/state`)).json.rulesVersion).toBeNull();
    await call("POST", `/rooms/${roomId}/start`, { token: host });
    expect((await call("GET", `/rooms/${roomId}/state`)).json.rulesVersion).toBe(1);
    await call("POST", `/rooms/${roomId}/resign`, { token: a.token });

    const log = await call("GET", `/rooms/${roomId}/log`);
    expect(log.json.rulesVersion).toBe(1);
    const replay = await call("GET", `/rooms/${roomId}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.json.rulesVersion).toBe(1);

    const matches = (await call("GET", `/matches?game=${id}&limit=100`)).json;
    expect(matches.find((m: { id: string }) => m.id === roomId)?.rulesVersion).toBe(1);

    games[id] = { ...games[id]!, rulesVersion: 2 };
    const r = await call("GET", `/rooms/${roomId}/replay`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("RULES_CHANGED");
    // ログ自体は記録どおり返す
    const l = await call("GET", `/rooms/${roomId}/log`);
    expect(l.status).toBe(200);
    expect(l.json.rulesVersion).toBe(1);
  }
});
