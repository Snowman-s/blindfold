import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("GET / が 200 を返す", async () => {
  const res = await SELF.fetch("https://example.com/");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "apigames", ok: true });
});
