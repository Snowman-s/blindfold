import type { Context, MiddlewareHandler } from "hono";

/**
 * 廃止予定の告知（RFC 9745 Deprecation / RFC 8594 Sunset）。
 * 廃止予定のルートには `deprecated(info)` をミドルウェアとして付け、廃止予定のフィールドなど
 * 「使ったときだけ」付けたいものはハンドラ内で `markDeprecated(c, info)` を呼ぶ。
 * どちらもベストエフォート（0.x の間はヘッダー無しで壊すこともある）。WS のメッセージには付けられない。
 * ヘッダーは CORS の exposeHeaders に入れてあるので、別オリジンのブラウザからも読める。
 */
export interface DeprecationInfo {
  /** 廃止予定になった時刻。過去でも未来でもよい（未来なら「その時点から廃止予定」）。 */
  since: Date;
  /** これ以降は動かなくなりうる時刻（任意）。since より後にすること。 */
  sunset?: Date;
  /** 説明のページ（移行方法など）。省略時は変更履歴。相対 URL はリクエストの URL を基準に解釈される。 */
  link?: string;
}

export const DEFAULT_DEPRECATION_LINK = "/changelog.md";

/** レスポンスに付けるヘッダー（純粋関数）。Link は rel ごとに1要素。 */
export function deprecationHeaders(info: DeprecationInfo): { deprecation: string; sunset?: string; links: string[] } {
  if (info.sunset && info.sunset.getTime() <= info.since.getTime()) {
    throw new Error("sunset must be after since");
  }
  const link = info.link ?? DEFAULT_DEPRECATION_LINK;
  // RFC 9745: Structured Field の Date（"@" + Unix 秒）
  const out: { deprecation: string; sunset?: string; links: string[] } = {
    deprecation: `@${Math.floor(info.since.getTime() / 1000)}`,
    links: [`<${link}>; rel="deprecation"; type="text/markdown"`],
  };
  if (info.sunset) {
    // RFC 8594: HTTP-date（IMF-fixdate）
    out.sunset = info.sunset.toUTCString();
    out.links.push(`<${link}>; rel="sunset"; type="text/markdown"`);
  }
  return out;
}

/** このレスポンスに廃止予定のヘッダーを付ける。既にある Link には追記する。 */
export function markDeprecated(c: Context, info: DeprecationInfo): void {
  const h = deprecationHeaders(info);
  c.header("Deprecation", h.deprecation);
  if (h.sunset) c.header("Sunset", h.sunset);
  for (const l of h.links) c.header("Link", l, { append: true });
}

/** ルート全体が廃止予定のときに付けるミドルウェア。 */
export function deprecated(info: DeprecationInfo): MiddlewareHandler {
  // 不正な指定（sunset <= since）は最初のリクエストを待たず、ルートを定義した時点で例外にする
  const h = deprecationHeaders(info);
  return async (c, next) => {
    await next();
    // WS のアップグレード（101）は Response を作り直すと webSocket が失われるので素通りさせる
    if (c.res.status === 101) return;
    // DO の fetch() などから来た Response はヘッダーが書き換え不可のことがあるので、コピーしてから付ける
    const res = c.res;
    const headers = new Headers(res.headers);
    headers.set("Deprecation", h.deprecation);
    if (h.sunset) headers.set("Sunset", h.sunset);
    for (const l of h.links) headers.append("Link", l);
    // 一度 undefined にしないと、Hono が古い応答のヘッダー（Link など）で上書きしてしまう
    c.res = undefined;
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
