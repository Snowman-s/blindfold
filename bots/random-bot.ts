/**
 * 合法手からランダムに選ぶ Bot（Node 22+ で実行）。
 *
 *   pnpm tsx bots/random-bot.ts --url http://localhost:8787 --room <roomId> [--host-token <hostToken>]
 *   pnpm tsx bots/random-bot.ts --url http://localhost:8787 --game tictactoe   # ルームを作って参加
 *
 * 自分でルームを作った場合か --host-token を渡した場合は、人数が揃ったら自動で開始する。
 */
import { parseArgs } from "node:util";
import { randomPick, runBot } from "./bot-core";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    room: { type: "string" },
    game: { type: "string", default: "tictactoe" },
    "api-key": { type: "string" },
    "host-token": { type: "string" },
  },
});
const base = values.url!.replace(/\/$/, "");

async function api<T>(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error?.code} ${json.error?.message}`);
  return json;
}

let roomId = values.room;
/** 作成者用トークン（自分で作ったか --host-token で渡されたとき）。持っていれば人数が揃ったら開始する。 */
let hostToken: string | null = values["host-token"] ?? null;
if (!roomId) {
  const created = await api<{ roomId: string; hostToken: string }>("POST", "/rooms", { body: { game: values.game } });
  roomId = created.roomId;
  hostToken = created.hostToken;
  console.log(`room created: ${roomId}`);
}

const { playerId, token } = await api<{ playerId: string; token: string }>("POST", `/rooms/${roomId}/join`, {
  headers: values["api-key"] ? { "X-Api-Key": values["api-key"] } : {},
});
console.log(`joined as ${playerId}`);

const state = await api<{ game: string }>("GET", `/rooms/${roomId}/state`);
const games = await api<{ id: string; minPlayers: number }[]>("GET", "/games");
const minPlayers = games.find((g) => g.id === state.game)?.minPlayers ?? 2;

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/rooms/${roomId}/ws?token=${token}`);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("websocket connection failed")));
});

const end = await runBot(ws, {
  pick: randomPick,
  startWhen:
    hostToken
      ? { players: minPlayers, start: async () => void (await api("POST", `/rooms/${roomId}/start`, { headers: { Authorization: `Bearer ${hostToken}` } })) }
      : undefined,
});
console.log(`finished: winners=${JSON.stringify(end.winners)} scores=${JSON.stringify(end.scores ?? {})}`);
ws.close();
