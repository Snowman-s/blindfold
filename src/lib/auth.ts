/**
 * WS のサブプロトコル（プロトコルの版）。クライアントは対応する版を1つ以上提示し、サーバーはその中で最も新しいものを選んで応答する。
 * 1.0 以降に WS の破壊的変更をするときは新しい版（apigames.v2）を足し、古い版はしばらく並べて残す。
 * 新しい順に並べる。WS_PROTOCOL は今の最新版。
 */
export const WS_PROTOCOLS = ["apigames.v1"] as const;
export const WS_PROTOCOL = WS_PROTOCOLS[0];
/** WS でトークンを渡すサブプロトコルの接頭辞。`apigames.token.<token>` の形で送る（版を含まない）。 */
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
  | { ok: true; token: string | null; protocol: string }
  | { ok: false; message: string };

/**
 * WS 用: ブラウザの WebSocket はヘッダーを付けられないので、サブプロトコルでトークンを受け取る。
 *   new WebSocket(url, ["apigames.v1", "apigames.token.<token>"])
 * 版のサブプロトコルは必須（未指定を v1 とみなすと、v1 を外したときに黙って壊れるため）。
 * 応答ではトークンを含まない版のサブプロトコルを選ぶ（トークンを応答ヘッダーに載せないため）。
 * トークンのサブプロトコルが無ければ Authorization: Bearer（Node などヘッダーを付けられるクライアント向け）。
 */
export function extractWsAuth(req: Request): WsAuth {
  const offered = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const tokens = offered.filter((p) => p.startsWith(WS_TOKEN_PROTOCOL_PREFIX));
  if (tokens.length > 1) return { ok: false, message: "multiple token subprotocols" };
  const protocol = WS_PROTOCOLS.find((p) => offered.includes(p));
  if (!protocol) {
    return { ok: false, message: `offer the "${WS_PROTOCOL}" subprotocol (supported: ${WS_PROTOCOLS.join(", ")})` };
  }
  const fromProtocol = tokens[0]?.slice(WS_TOKEN_PROTOCOL_PREFIX.length) ?? null;
  if (fromProtocol === "") return { ok: false, message: "empty token subprotocol" };
  return { ok: true, token: fromProtocol ?? extractToken(req), protocol };
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newToken(): string {
  return randomHex(24);
}

export function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** ルーム ID の形式（newRoomId が作る形）。これに合わない ID では DO を起こさない。 */
export const ROOM_ID_RE = /^[0-9a-f]{12}$/;

export function isRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return toHex(new Uint8Array(d));
}

/** トークンの保存用ハッシュ（DO にはトークンそのものを保存しない）。null はそのまま。 */
export async function hashToken(token: string | null): Promise<string | null> {
  return token === null ? null : sha256Hex(token);
}

/**
 * 再戦ルームの席のトークン。元のルームのトークンから導出するので、どこにも保存せずに「何度呼んでも同じトークン」を返せる。
 * 元のトークンを持つ人は rematch を呼べば同じものを受け取れるので、導出できても権限は増えない。
 */
export async function rematchToken(oldToken: string, newRoomId: string): Promise<string> {
  return (await sha256Hex(`rematch:${newRoomId}:${oldToken}`)).slice(0, 48);
}

export function newApiKey(): string {
  return "ak_" + newToken();
}

export function newUserId(): string {
  return "u_" + newRoomId();
}
