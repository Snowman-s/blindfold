import { SELF } from "cloudflare:test";

export const BASE = "https://example.com";

export async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await SELF.fetch(BASE + path, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any }; // テスト内のみ
}

/** ルームを作って2人参加させる（開始はしない）。 */
export async function newRoom(game: string, options?: unknown) {
  const { json } = await call("POST", "/rooms", { body: { game, options } });
  const roomId: string = json.roomId;
  const a = (await call("POST", `/rooms/${roomId}/join`)).json;
  const b = (await call("POST", `/rooms/${roomId}/join`)).json;
  return { roomId, host: json.hostToken as string, a, b };
}

/** 三目並べを開始し、p1（a）が上段を揃えて勝つまで REST で打つ。 */
export async function playOut(roomId: string, host: string, a: { token: string }, b: { token: string }) {
  await call("POST", `/rooms/${roomId}/start`, { token: host });
  const moves: [{ token: string }, number][] = [[a, 0], [b, 3], [a, 1], [b, 4], [a, 2]];
  for (const [i, [p, cell]] of moves.entries()) {
    await call("POST", `/rooms/${roomId}/action`, { token: p.token, body: { turn: i, action: { cell } } });
  }
}
