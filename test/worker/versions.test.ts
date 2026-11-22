import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHANGELOG } from "../../src/lib/changelog";
import { API_VERSION } from "../../src/lib/version";
import { BASE } from "./helpers";

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
