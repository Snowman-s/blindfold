/** Authorization: Bearer <token> か ?token= からプレイヤートークンを取り出す。 */
export function extractToken(req: Request): string | null {
  const h = req.headers.get("Authorization");
  if (h) {
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (m) return m[1]!;
  }
  return new URL(req.url).searchParams.get("token");
}

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
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
