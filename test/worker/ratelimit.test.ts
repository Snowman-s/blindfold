import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { rateLimitKey } from "../../src/lib/ratelimit";
import { BASE, call } from "./helpers";

// 上限は wrangler.jsonc の ratelimits（RL_USERS: 5/60s、RL_ROOMS: 30/60s）。
// カウンタは IP ごとなので、テストごとに別の IP を使って互いに干渉しないようにする。
const ip = (n: number) => ({ "CF-Connecting-IP": `203.0.113.${n}` });

describe("rate limits", () => {
  it("limits POST /users per IP and answers 429 RATE_LIMITED with Retry-After", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("POST", "/users", { body: { name: "u" }, headers: ip(1) })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);

    const res = await SELF.fetch(`${BASE}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ip(1) },
      body: JSON.stringify({ name: "u" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    // 別の IP は影響を受けない
    expect((await call("POST", "/users", { body: { name: "u" }, headers: ip(2) })).status).toBe(201);
  });

  it("shares one limit across room creation, quick match and join", async () => {
    const h = ip(3);
    const { json } = await call("POST", "/rooms", { body: { game: "tictactoe" }, headers: h });
    let last = 0;
    for (let i = 0; i < 29; i++) last = (await call("POST", `/rooms/${json.roomId}/join`, { headers: h })).status;
    // 30 回目までは通る（満席の join は 409 だが、制限ではない）
    expect(last).not.toBe(429);
    const over = await call("POST", "/quickmatch", { body: { game: "tictactoe" }, headers: h });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe("RATE_LIMITED");
  });

  it("keys IPv6 addresses by their /64", async () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:0DB8:0001:0002::ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("2001:db8:1:2::")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("not:an::ip::")).toBe("not:an::ip::");

    // 同じ /64 の別アドレスは同じカウンタを使う
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const h = { "CF-Connecting-IP": `2001:db8:aa:bb::${i + 1}` };
      statuses.push((await call("POST", "/users", { body: { name: "u" }, headers: h })).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("exposes Retry-After to browsers", async () => {
    const res = await SELF.fetch(`${BASE}/games`, { headers: { Origin: "https://app.example" } });
    expect((res.headers.get("Access-Control-Expose-Headers") ?? "").toLowerCase()).toContain("retry-after");
  });

  it("does not limit reads", async () => {
    const h = ip(4);
    for (let i = 0; i < 40; i++) expect((await call("GET", "/games", { headers: h })).status).toBe(200);
  });

  it("does not limit requests without CF-Connecting-IP (outside Cloudflare)", async () => {
    for (let i = 0; i < 8; i++) expect((await call("POST", "/users", { body: { name: "u" } })).status).toBe(201);
  });
});
