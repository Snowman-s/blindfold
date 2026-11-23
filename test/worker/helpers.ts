import { SELF } from "cloudflare:test";
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../../src/lib/auth";

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

/** WS で接続する（token が無ければ観戦）。closed は閉じられたときの close コード（10 秒で閉じられなければ失敗）。 */
export async function connect(roomId: string, token?: string) {
  const protocols = token ? `${WS_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${token}` : WS_PROTOCOL;
  const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols },
  });
  const ws = res.webSocket!;
  // 閉じられないまま待ち続けるとスイート全体が止まるので、10 秒で失敗にする（スイート全体を並列で回すと遅くなるので余裕を持たせる）
  const closed = Promise.race([
    new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code))),
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("socket was not closed")), 10_000)),
  ]);
  closed.catch(() => {});
  ws.accept();
  return { ws, closed };
}
