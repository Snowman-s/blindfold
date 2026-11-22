import type { MiddlewareHandler } from "hono";
import { errBody } from "./protocol";

/**
 * Workers の Rate Limiting バインディングによる、IP ごとの書き込み系エンドポイントの制限。
 *
 * - 目的は D1・DO の乱造（ユーザー・ルームの大量作成）を止めること。429 で返したリクエストも Worker を起動するので、
 *   1日10万リクエストの無料枠そのものは守れない（それには Worker より前で止める WAF が要る。独自ドメインのときだけ使える）。
 * - カウンタは Cloudflare の拠点ごとで、結果整合の概算。上限を少し超えて通ることがある。厳密さは求めない。
 * - キーは CF-Connecting-IP。API キーやトークンは毎回変えれば回避できるので使わない。NAT で IP を共有する利用者を
 *   巻き込まないよう、上限は緩めにする（wrangler.jsonc の ratelimits）。
 * - IPv6 は /64 にまとめる（1台が /64 を丸ごと持つことが多く、/128 だとアドレスを変えるだけで回避できる）。
 * - CF-Connecting-IP は Cloudflare の外（テスト・一部のローカル実行）では付かない。そのときは制限しない。
 */
export function rateLimit(
  pick: (env: Env) => RateLimit,
  periodSec: number,
  methods: readonly string[] = ["POST"],
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const ip = c.req.header("cf-connecting-ip");
    if (!ip || !methods.includes(c.req.method)) return next();
    const { success } = await pick(c.env).limit({ key: rateLimitKey(ip) });
    if (success) return next();
    c.header("Retry-After", String(periodSec));
    return c.json(errBody("RATE_LIMITED", `too many requests; retry after ${periodSec} seconds`), 429);
  };
}

/** レート制限のキー。IPv4 はそのまま、IPv6 は先頭 64 ビット（4 グループ）に正規化する。解釈できなければそのまま。 */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const addr = ip.split("%")[0]!.toLowerCase(); // ゾーン ID（fe80::1%eth0）は落とす
  const halves = addr.split("::");
  if (halves.length > 2) return ip;
  const groups = (h: string | undefined) => (h ? h.split(":") : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  // 末尾が IPv4 表記（::ffff:1.2.3.4）でも、先頭 4 グループにしか関わらないので 2 グループとして数える
  const size = (g: string[]) => g.reduce((n, x) => n + (x.includes(".") ? 2 : 1), 0);
  const missing = 8 - size(head) - size(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return ip;
  const full = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return full
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":") + "::/64";
}
