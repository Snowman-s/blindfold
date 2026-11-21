/** WS でトークンを渡すサブプロトコルの接頭辞。`apigames.token.<token>` の形で送る。 */
export const WS_PROTOCOL = "apigames";
export const WS_TOKEN_PROTOCOL_PREFIX = "apigames.token.";

/**
 * REST 用: `Authorization: Bearer <token>` からトークンを取り出す。
 * URL に載ったトークンはアクセスログやブラウザ履歴に残るので、`?token=` は受け付けない。
 */
export function extractToken(req: Request): string | null {
  const h = req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

export type WsAuth =
  | { ok: true; token: string | null; protocol: string | null }
  | { ok: false; message: string };

/**
 * WS 用: ブラウザの WebSocket はヘッダーを付けられないので、サブプロトコルでトークンを受け取る。
 *   new WebSocket(url, ["apigames", "apigames.token.<token>"])
 * 応答ではトークンを含まない "apigames" を選ぶ（トークンを応答ヘッダーに載せないため）。
 * サブプロトコルが無ければ Authorization: Bearer（Node などヘッダーを付けられるクライアント向け）。
 */
export function extractWsAuth(req: Request): WsAuth {
  const offered = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const tokens = offered.filter((p) => p.startsWith(WS_TOKEN_PROTOCOL_PREFIX));
  if (tokens.length > 1) return { ok: false, message: "multiple token subprotocols" };
  const protocol = offered.includes(WS_PROTOCOL) ? WS_PROTOCOL : null;
  if (offered.length > 0 && protocol === null) {
    // サブプロトコルを提示したクライアントは、応答で1つ選ばれないと接続に失敗する
    return { ok: false, message: `offer the "${WS_PROTOCOL}" subprotocol` };
  }
  const fromProtocol = tokens[0]?.slice(WS_TOKEN_PROTOCOL_PREFIX.length) ?? null;
  if (fromProtocol === "") return { ok: false, message: "empty token subprotocol" };
  return { ok: true, token: fromProtocol ?? extractToken(req), protocol };
}

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  return randomHex(24);
}

export function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function newApiKey(): string {
  return "ak_" + newToken();
}

export function newUserId(): string {
  return "u_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
