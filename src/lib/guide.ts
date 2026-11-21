import { z } from "zod";
import { games } from "../games/registry";
import type { AnyGame } from "../games/types";
import { sha256Hex, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "./auth";
import { DEFAULT_TURN_TIME_MS, roomOptions } from "./options";
import { WS_ERROR_CODES, type ServerMessage } from "./protocol";
import { rngForTurn } from "./rng";

/**
 * クライアント開発者（主にコーディングエージェント）向けのガイド（GET /guide.md, /llms.txt）。
 * 「この URL を見てクライアントを作って」だけで、ソースを読まずにクライアントが書けることを目標にする。
 *
 * - 手書きの仕様は実装とずれるので、メッセージ型・オプション・ゲーム一覧・state の例はコードから生成する。
 * - 取得ツールは長いページを要約・切り詰めることがあるので、間違えると動かない文字列は冒頭の TL;DR に置く。
 * - 本文は Base URL を `{{BASE}}` のまま組み立ててハッシュを取り（version）、配信時にリクエストのオリジンで置き換える。
 */

const BASE = "{{BASE}}";
/** 例の state に入れる締め切り（固定値。実際は epoch ms の現在時刻 + 持ち時間）。 */
const EXAMPLE_DEADLINE = 1767225600000;
const EXAMPLE_PLAYERS = ["p1", "p2"];

const json = (v: unknown) => JSON.stringify(v, null, 2);
const code = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

/**
 * 固定シードで1手進めた局面の state メッセージ（行動できるプレイヤーの視点と観戦視点）。
 * 実際のエンジンから作るので、view の形が変わっても例が古くならない。
 */
function exampleStates(game: AnyGame): { actor: string; player: ServerMessage; spectator: ServerMessage } {
  const seed = "guide-example";
  let state = game.init(EXAMPLE_PLAYERS, seed);
  const first = game.currentPlayers(state)[0]!;
  state = game.apply(state, first, game.legalActions(state, first)[0], rngForTurn(seed, 0));
  const turn = 1;
  const current = game.currentPlayers(state);
  const actor = current[0] ?? first;
  const msg = (pid: string | null): ServerMessage => {
    const legal = pid && current.includes(pid) ? game.legalActions(state, pid) : undefined;
    return {
      type: "state",
      turn,
      view: game.view(state, pid),
      ...(legal ? { legal } : {}),
      currentPlayers: current,
      deadline: EXAMPLE_DEADLINE,
      status: "playing",
      players: EXAMPLE_PLAYERS,
    };
  };
  return { actor, player: msg(actor), spectator: msg(null) };
}

function gameSection(game: AnyGame): string {
  const players = game.minPlayers === game.maxPlayers ? `${game.minPlayers}` : `${game.minPlayers}-${game.maxPlayers}`;
  const ex = exampleStates(game);
  return [
    `### \`${game.id}\` (${players} players)`,
    "",
    game.docs.summary,
    "",
    `Full rules, view fields and action schema: [${BASE}/games/${game.id}/rules.md](${BASE}/games/${game.id}/rules.md) (JSON: \`/games/${game.id}/rules\`).`,
    "",
    "Action JSON Schema:",
    code("json", json(z.toJSONSchema(game.actionSchema))),
    "",
    `Example \`state\` after one move, as **${ex.actor}** (who may act now, so \`legal\` is present):`,
    code("json", json(ex.player)),
    "",
    "The same moment as a **spectator** (no token). Hidden information (if the game has any) is removed and `legal` is absent:",
    code("json", json(ex.spectator)),
  ].join("\n");
}

const MINIMAL_CLIENT = `// Minimal random-move client. Runs in browsers and in Node.js 22+ (global fetch / WebSocket).
const BASE = "${BASE}";
const WS_BASE = BASE.replace(/^http/, "ws");

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: \`Bearer \${token}\` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(\`\${path}: \${data.error.code} \${data.error.message}\`);
  return data;
}

/** Plays one game as a player. Resolves with the \`end\` message. */
function play(roomId, token, pick = (legal) => legal[Math.floor(Math.random() * legal.length)]) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(\`\${WS_BASE}/rooms/\${roomId}/ws\`, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token]);
    let answeredTurn = -1;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state" && msg.status === "playing" && msg.legal && answeredTurn !== msg.turn) {
        answeredTurn = msg.turn; // answer each turn once
        ws.send(JSON.stringify({ type: "action", turn: msg.turn, action: pick(msg.legal, msg.view) }));
      } else if (msg.type === "error") {
        console.warn(msg.code, msg.message); // e.g. STALE_TURN: just wait for the next state
      } else if (msg.type === "end") {
        ws.close();
        resolve(msg);
      }
    });
    ws.addEventListener("close", () => reject(new Error("socket closed before the game ended")));
  });
}

// Play one game against the server's practice bot: create, join once, start, connect.
const { roomId, hostToken } = await post("/rooms", { game: "tictactoe", options: { practice: true } });
const me = await post(\`/rooms/\${roomId}/join\`); // you are p1; the bot takes p2 when the game starts
await post(\`/rooms/\${roomId}/start\`, undefined, hostToken);
const end = await play(roomId, me.token);
console.log(end.winners.length === 0 ? "draw" : end.winners.includes(me.playerId) ? "you won" : "you lost", end.scores);`;

const MESSAGE_TYPES = `// Client -> server (WebSocket text frames, JSON)
type ClientMessage =
  | { type: "action"; turn: number; action: unknown } // turn = \`turn\` of the latest state; action = one element of \`legal\`
  | { type: "ping" };                                 // answered with { type: "pong" } (free keepalive)

// Server -> client
type ServerMessage =
  | {
      type: "state";
      turn: number;                 // number of actions applied so far; echo it when acting
      view: unknown;                // game-specific board as seen by the receiver (hidden info removed)
      legal?: unknown[];            // present only if the receiver may act now
      currentPlayers: string[];     // player IDs who may act now (several = simultaneous turn)
      deadline: number | null;      // epoch ms by which currentPlayers must act; null when not playing
      status: "waiting" | "playing" | "finished";
      players: string[];            // all player IDs in join order ("p1", "p2", ...)
    }
  | { type: "error"; code: ${WS_ERROR_CODES.map((c) => `"${c}"`).join(" | ")}; message: string }
  | { type: "end"; winners: string[]; scores?: Record<string, number> } // winners empty = draw (or everyone timed out)
  | { type: "pong" };`;

function buildGuide(): string {
  const gameList = Object.values(games);
  return [
    "# apigames — Client Developer Guide",
    "",
    "apigames hosts turn-based games that are played entirely over an HTTP + WebSocket API. All game logic runs on the server;",
    "a client only renders the state it receives and sends actions. This page is everything you need to build a client",
    "(a bot, a UI, or a spectator viewer) without reading the server source.",
    "",
    "## TL;DR",
    "",
    code(
      "text",
      [
        `Base URL      ${BASE}            (WebSocket: same host, ws:// or wss://)`,
        `Games         ${gameList.map((g) => g.id).join(", ")}   (GET /games)`,
        "Flow          POST /rooms -> POST /rooms/{id}/join (once per seat) -> POST /rooms/{id}/start -> WS /rooms/{id}/ws -> loop",
        `WS auth       new WebSocket(url, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token])   (no token = spectator)`,
        "REST auth     Authorization: Bearer <token>",
        "Never         put a token in the URL: ?token= is rejected with 400",
        'Act           {"type":"action","turn":<turn of latest state>,"action":<one element of legal, unchanged>}',
        "Loop          on every `state`: if `legal` is present, send one action for that `turn` (once)",
        "STALE_TURN    ignore it and wait for the next `state`",
        "End           `end` message: { winners, scores }",
      ].join("\n"),
    ),
    "",
    "- Sending an element of `legal` unchanged is always accepted. You never need to compute legality yourself.",
    "- State is pushed over the WebSocket after every change. Do not poll `GET /rooms/{id}/state`: the service runs on a",
    "  free tier with a daily request budget.",
    "- CORS is enabled for all REST endpoints (any origin; `Authorization`, `Content-Type` and `X-Api-Key` are allowed), so",
    "  a browser app on another origin can call the API directly.",
    "",
    "## 1. Lifecycle, step by step",
    "",
    "### 1.1 Create a room",
    code("sh", `curl -X POST ${BASE}/rooms -H 'Content-Type: application/json' -d '{"game":"tictactoe"}'`),
    code("json", json({ roomId: "3f9c0a1b2d4e5f60", hostToken: "<hostToken>" })),
    "",
    "`options` is optional. Unknown keys are rejected with 400. Its JSON Schema:",
    code("json", json(z.toJSONSchema(roomOptions))),
    `\`turnTimeMs\` is the time limit per turn; the default is ${DEFAULT_TURN_TIME_MS} ms (${DEFAULT_TURN_TIME_MS / 60000} minutes).`,
    "",
    '**Practice opponent:** with `"options": {"practice": true}`, the server fills the empty seats (up to `minPlayers`)',
    "with built-in bots when the game starts. They take the seats after the joined players (join once and you are `p1`,",
    "the bot is `p2`), play a simple legal move (random unless the game defines its own) as soon as it is their turn,",
    "and never time out. They are for checking your client's flow, not for strength. Use this to test your",
    "client alone: create, join once, start, connect. Practice games are not recorded in `/users/{id}` or `/matches`.",
    "",
    "`hostToken` is only for starting the game. It is **not** a player token: the creator must also join to play.",
    "",
    "### 1.2 Join (once per seat)",
    code("sh", `curl -X POST ${BASE}/rooms/{roomId}/join`),
    code("json", json({ playerId: "p1", token: "<token>" })),
    "",
    "- Player IDs are assigned in join order: `p1`, `p2`, ... Keep `token` secret; it identifies the seat.",
    "- Joining fails with `ROOM_FULL` or `ALREADY_STARTED` (409).",
    "- Optional: send `X-Api-Key: <apiKey>` (from `POST /users` with `{\"name\":\"...\"}`) to record the result on that user.",
    "- To test alone, create the room with `options.practice` (see 1.1) and join once, or join twice and run two connections.",
    "",
    "### 1.3 Start (room creator only)",
    code("sh", `curl -X POST ${BASE}/rooms/{roomId}/start -H 'Authorization: Bearer <hostToken>'`),
    "Requires at least `minPlayers` players (`NOT_ENOUGH_PLAYERS`, 409), counting practice bots. A player token gets `NOT_HOST` (403).",
    "",
    "### 1.4 Connect the WebSocket",
    code(
      "js",
      [
        `const wsBase = "${BASE}".replace(/^http/, "ws"); // http -> ws, https -> wss`,
        `const ws = new WebSocket(\`\${wsBase}/rooms/\${roomId}/ws\`, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token]);`,
        `// The server answers with the "${WS_PROTOCOL}" subprotocol. Clients that can set headers may send`,
        "// `Authorization: Bearer <token>` on the upgrade request instead. Omit the token to spectate.",
      ].join("\n"),
    ),
    "",
    "- You may connect before or after the game starts. Right after connecting you receive the current `state`",
    "  (`status` may be `waiting`), and if the game is already over, an `end` message right after it.",
    "- Reconnecting is always safe: the first `state` tells you everything. You do not need to keep local state.",
    "",
    "### 1.5 The game loop",
    "",
    "On every `state` message:",
    "1. Render `view` (see the game's rules for its fields).",
    "2. If `legal` is present, it is your move. Choose one element and send",
    '   `{"type":"action","turn":<state.turn>,"action":<element>}`. Send at most one action per `turn`.',
    "3. Otherwise wait. The next `state` arrives when anyone acts (including on simultaneous turns, where",
    "   `currentPlayers` lists several players and shrinks as they act).",
    "",
    "Your own seat is your `playerId` from `join`; compare it with `currentPlayers` and the IDs in `view`.",
    "",
    "### 1.6 Errors",
    "",
    "WebSocket errors arrive as `{ \"type\": \"error\", code, message }` and do not close the connection.",
    "",
    "| code | meaning | what to do |",
    "|---|---|---|",
    "| `STALE_TURN` | `turn` is not the current turn (duplicate, outdated, or the deadline passed) | wait for the next `state` |",
    "| `NOT_YOUR_TURN` | you may not act now (or you are a spectator) | wait for a `state` with `legal` |",
    "| `ILLEGAL_ACTION` | the move breaks the rules, or the game is not in progress | send an element of `legal` |",
    "| `BAD_REQUEST` | malformed JSON / message / action shape | fix the message format |",
    "",
    "REST errors use HTTP status codes with the body `{ \"error\": { \"code\": \"...\", \"message\": \"...\" } }`.",
    "Codes: `BAD_REQUEST` (400), `UNKNOWN_GAME` (400), `ILLEGAL_ACTION` (400), `UNAUTHORIZED` (401), `NOT_HOST` (403),",
    "`NOT_YOUR_TURN` (403), `NOT_FINISHED` (403), `ROOM_NOT_FOUND` (404), `ALREADY_STARTED` / `ROOM_FULL` /",
    "`NOT_ENOUGH_PLAYERS` / `NOT_PLAYING` / `STALE_TURN` (409), `UPGRADE_REQUIRED` (426).",
    "",
    "### 1.7 Deadlines",
    "",
    "`deadline` is an epoch-millisecond timestamp. If a player in `currentPlayers` has not acted by then, the server",
    "resolves the timeout itself (by default the player who timed out loses; some games define their own handling,",
    "see the game's rules). An action that arrives after the deadline is rejected with `STALE_TURN`.",
    "Show a countdown in UIs; bots should simply act promptly.",
    "",
    "### 1.8 End of game",
    "",
    "Everyone receives `{ \"type\": \"end\", \"winners\": [...], \"scores\": {...} }` after the final `state`",
    "(`status: \"finished\"`). An empty `winners` means a draw. You may close the socket.",
    "",
    "## 2. Message reference (WebSocket)",
    "",
    code("ts", MESSAGE_TYPES),
    "",
    "## 3. REST endpoints",
    "",
    "| method | path | auth | purpose |",
    "|---|---|---|---|",
    "| GET | `/games` | - | list games (`id`, `minPlayers`, `maxPlayers`, `summary`, `rulesUrl`) |",
    "| GET | `/games/{id}/rules` · `/games/{id}/rules.md` | - | rules, view fields, action schema (JSON / Markdown) |",
    "| POST | `/rooms` | - | `{ game, options? }` -> `{ roomId, hostToken }` |",
    "| POST | `/rooms/{id}/join` | optional `X-Api-Key` | -> `{ playerId, token }` |",
    "| POST | `/rooms/{id}/start` | Bearer hostToken | start the game |",
    "| GET | `/rooms/{id}/state` | optional Bearer token | current state (player view with token, spectator view without) |",
    "| POST | `/rooms/{id}/action` | Bearer token | `{ turn, action }`; REST alternative to the WS action message |",
    "| GET | `/rooms/{id}/ws` | subprotocol token (optional) | WebSocket |",
    "| GET | `/rooms/{id}/log` | - | action log (after the game ends) |",
    "| GET | `/rooms/{id}/replay` | - | spectator view for every turn (after the game ends) |",
    "| POST | `/users` | - | `{ name }` -> `{ userId, apiKey }` |",
    "| GET | `/users/{id}` | - | user and results |",
    "| GET | `/matches` | - | finished matches (`?game=&limit=`) |",
    "",
    "`GET /rooms/{id}/state` and `POST /rooms/{id}/action` return the same shape as the `state` message plus",
    "`game` and `result` (`{ winners, scores } | null`), without the `type` field.",
    `Full OpenAPI spec: [${BASE}/openapi.json](${BASE}/openapi.json).`,
    "",
    "## 4. Spectating and replays",
    "",
    "- Connect to `/rooms/{id}/ws` with only the `" + WS_PROTOCOL + "` subprotocol (no token) to receive spectator `state` messages.",
    "- After the game ends, `GET /rooms/{id}/replay` returns `{ game, seed, players, frames: [{ turn, view, action }], result }`,",
    "  where `view` is the spectator view at each turn. Use it to build a replay viewer.",
    "",
    "## 5. Games",
    "",
    "Each game defines its own `view` and `action`. Examples below are generated from the real game engine.",
    "",
    gameList.map(gameSection).join("\n\n"),
    "",
    "## 6. Minimal client (copy-paste)",
    "",
    "Creates a tictactoe room with a practice bot, joins once, and plays random legal moves until the game ends.",
    "Replace `pick(legal, view)` with your own strategy. To play against another client instead, drop `practice`,",
    "share `roomId`, and have the other client join before you start.",
    "",
    code("js", MINIMAL_CLIENT),
    "",
    "## 7. Checklist for a correct client",
    "",
    "- [ ] Tokens are sent only in the `Authorization` header or the WebSocket subprotocol, never in the URL.",
    "- [ ] Every action carries the `turn` of the latest `state`, and at most one action is sent per `turn`.",
    "- [ ] Actions are taken from `legal` (or match the game's action schema exactly).",
    "- [ ] `STALE_TURN` and other errors do not crash the client; it waits for the next `state`.",
    "- [ ] The UI handles `status: \"waiting\"` (before start) and `view` fields that only some viewers receive.",
    "- [ ] On `end`, the result is shown and the socket is closed.",
    "",
  ].join("\n");
}

let cached: Promise<{ version: string; body: string }> | null = null;

/** ガイド本文（Base URL は未置換）と、その内容のハッシュ（version / ETag）。 */
export function guide(): Promise<{ version: string; body: string }> {
  return (cached ??= (async () => {
    const body = buildGuide();
    return { version: (await sha256Hex(body)).slice(0, 12), body };
  })());
}

/** Base URL を差し込んだ Markdown。 */
export function renderGuide(g: { version: string; body: string }, origin: string): string {
  return g.body.replaceAll(BASE, origin).replace(/^# (.*)$/m, `# $1 (version ${g.version})`);
}
