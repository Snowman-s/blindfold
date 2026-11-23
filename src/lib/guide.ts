import { z } from "zod";
import { games } from "../games/registry";
import type { AnyGame } from "../games/types";
import { sha256Hex, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "./auth";
import {
  DEFAULT_TURN_TIME_MS,
  FINISHED_ROOM_TTL_MS,
  PLAYING_LIST_GRACE_MS,
  roomOptions,
  WAITING_LIST_TTL_MS,
  WAITING_ROOM_TTL_MS,
} from "./options";
import { compactJson, gameExamples } from "./examples";
import {
  CLOSE_GAME_REMOVED,
  CLOSE_LEFT_ROOM,
  CLOSE_REPLACED,
  CLOSE_ROOM_DELETED,
  CLOSE_TOO_MANY_ERRORS,
  MAX_SOCKETS_PER_SEAT,
  MAX_SPECTATOR_SOCKETS,
  WS_MAX_STRIKES,
  WS_STRIKE_DECAY_MS,
} from "./protocol";
import { replayFrames } from "./replay";
import { API_VERSION } from "./version";

/**
 * クライアント開発者（主にコーディングエージェント）向けのガイド（GET /guide.md, /llms.txt）。
 * 「この URL を見てクライアントを作って」だけで、ソースを読まずにクライアントが書けることを目標にする。
 *
 * - 手書きの仕様は実装とずれるので、メッセージ型・オプション・ゲーム一覧・state の例はコードから生成する。
 * - 取得ツールは長いページを要約・切り詰めることがあるので、間違えると動かない文字列は冒頭の TL;DR に置く。
 * - 本文は Base URL を `{{BASE}}` のまま組み立ててハッシュを取り（version）、配信時にリクエストのオリジンで置き換える。
 */

const BASE = "{{BASE}}";

const json = (v: unknown) => compactJson(v);
const code = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

function gameSection(game: AnyGame): string {
  const players = game.minPlayers === game.maxPlayers ? `${game.minPlayers}` : `${game.minPlayers}-${game.maxPlayers}`;
  const ex = gameExamples(game);
  return [
    `### \`${game.id}\` (${players} players)`,
    "",
    game.docs.summary,
    "",
    `Full rules, view fields, the JSON Schema of \`view\`, and more example messages (start of the game, every viewer,` +
      ` finished game and \`end\`): [${BASE}/games/${game.id}/rules.md](${BASE}/games/${game.id}/rules.md)` +
      ` (JSON: \`/games/${game.id}/rules\`, fields \`viewSchema\` and \`stateExamples\`).`,
    "",
    "Action JSON Schema:",
    code("json", json(z.toJSONSchema(game.actionSchema))),
    "",
    ...(game.legalActions
      ? []
      : ["This game does **not** list legal moves (`listsLegalActions: false`): `legal` is never sent. Build the action from the schema and the rules.", ""]),
    ...(game.optionsSchema
      ? ["Game options (`gameOptions` in `POST /rooms`; see the rules for their meaning):", code("json", json(z.toJSONSchema(game.optionsSchema))), ""]
      : []),
    game.legalActions
      ? `Example \`state\` after one move, as **${ex.actor}** (who may act now, so \`legal\` is present):`
      : `Example \`state\` after one move, as **${ex.actor}** (who may act now):`,
    code("json", json(ex.player)),
    "",
    "The same moment as a **spectator** (no token). Hidden information (if the game has any) is removed and `legal` is absent:",
    code("json", json(ex.spectator)),
  ].join("\n");
}

const EXAMPLE_ROOM_ID = "3f9c0a1b2d4e";

/**
 * /log・/replay・/users/:id・/matches の応答例。最初のゲームを固定シードで最後まで進めた試合から作る
 * （テストで OpenAPI のスキーマに通して、形がずれていないことを確かめる）。
 */
export function responseExamples() {
  const game = Object.values(games)[0]!;
  const ex = gameExamples(game);
  const log = ex.log;
  const { frames, result } = replayFrames(game, log);
  const allFrames = frames.map((f, i) => ({
    turn: f.turn,
    view: game.view(f.state, null),
    action: i === 0 ? null : log.actions[i - 1]!,
  }));
  const last = log.actions[log.actions.length - 1]!;
  const user = { id: "u_8b1e2f3a4c5d", name: "alice", stats: { played: 3, wins: 2, losses: 1, draws: 0 } };
  const outcome = (p: string) => (result!.winners.includes(p) ? "win" : result!.winners.length === 0 ? "draw" : "loss");
  return {
    game,
    log,
    /** 長いので最初の2フレームと最後のフレームだけ。 */
    replay: {
      game: log.game,
      rulesVersion: log.rulesVersion,
      seed: log.seed,
      gameOptions: log.gameOptions,
      players: log.players,
      frames: [...allFrames.slice(0, 2), allFrames[allFrames.length - 1]!],
      result,
    },
    timeoutEntry: { turn: 3, player: null, action: null, at: last.at, timeout: ["p2"] },
    resignEntry: { turn: 3, player: null, action: null, at: last.at, resign: "p1" },
    user,
    match: {
      id: EXAMPLE_ROOM_ID,
      game: log.game,
      rulesVersion: log.rulesVersion,
      gameOptions: log.gameOptions,
      players: log.players,
      startedAt: log.actions[0]!.at,
      finishedAt: last.at,
      reason: "normal" as const,
      results: log.players.map((p, i) => ({
        playerId: p,
        userId: i === 0 ? user.id : null,
        outcome: outcome(p),
        score: result!.scores?.[p] ?? null,
      })),
    },
  };
}

function responseShapes(): string {
  const r = responseExamples();
  return [
    "### 8.1 `GET /rooms/{id}/log`",
    "",
    "Available once the game is `finished`. Before that it fails with `NOT_FINISHED` (403), because the seed would reveal",
    "hidden information.",
    `\`seed\` + \`gameOptions\` + \`actions\` reproduce the game exactly. Example (a finished \`${r.game.id}\` game):`,
    code("json", json(r.log)),
    code(
      "ts",
      [
        "type Log = {",
        "  game: string; rulesVersion: number; seed: string;",
        "  gameOptions: unknown;   // the room's game options (defaults filled in); null for games without options",
        "  players: string[]; actions: LogEntry[]; // actions[i].turn === i",
        "};",
        "type LogEntry = {",
        "  turn: number;           // the turn it was applied at; applying it produced turn + 1",
        "  player: string | null;  // who acted; null on a timeout / resignation entry",
        "  action: unknown | null; // the action as sent; null on a timeout / resignation entry",
        "  at: number;             // epoch ms (server clock)",
        "  timeout?: string[];     // only on a timeout entry: the players who ran out of time",
        "  resign?: string;        // only on a resignation entry: the player who resigned",
        "};",
      ].join("\n"),
    ),
    "Timeouts and resignations are entries written by the server. They take up one `turn` each, like an action.",
    "A timeout entry and a resignation entry (each would be one element of `actions`):",
    code("json", json([r.timeoutEntry, r.resignEntry])),
    "",
    "### 8.2 `GET /rooms/{id}/replay`",
    "",
    "The same game as a list of spectator views, one per turn: `frames[i].turn === i`, `frames[0]` is the initial",
    "position and the last frame is the final one. **`frames[i].action` is the log entry that produced frame `i`**",
    "(`actions[i - 1]` of `/log`, same shape including timeout / resignation entries); it is `null` for `frames[0]`.",
    "`result` is `{ winners, scores }` as in `end`. The server keeps only the current rules of each game, so once a",
    "game's `rulesVersion` has gone up, replays of games played with an older version fail with `GAME_REMOVED` (410);",
    "`/log` still works. Example, showing only the first two and the last frame:",
    code("json", json(r.replay)),
    "",
    "### 8.3 `GET /users/{id}` and `GET /matches`",
    "",
    "`POST /users` with `{\"name\":\"alice\"}` returns `{ userId, name, apiKey }` (201). The `apiKey` is shown only once.",
    "If it may have leaked, `POST /users/{userId}/key` with the current key as `X-Api-Key` returns `{ userId, apiKey }`",
    "with a new key; the old one is rejected from then on. A lost key cannot be recovered.",
    "`GET /users/{id}` counts the recorded games joined with that user's `X-Api-Key` (practice games are not recorded):",
    code("json", json(r.user)),
    "`GET /matches?game=&limit=` lists finished games, newest first. `id` is the room ID, so `/rooms/{id}/log` and",
    `\`/replay\` work with it for ${FINISHED_ROOM_TTL_MS / 86400000} days after the end (then the room is deleted; the match stays listed).`,
    "`userId` is null for a seat joined without `X-Api-Key`. `outcome` is `win`, `loss` or",
    "`draw`; `draw` only for a game its rules decided as a draw (if everyone timed out, everyone gets `loss` and",
    "`winners` is empty). `score` is the game's score for that seat, or null if the game has none.",
    code("json", json([r.match])),
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
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: a platform error page (e.g. daily request limit reached). Retry later.
    throw new Error(\`\${path}: HTTP \${res.status} (non-JSON response, retry later)\`);
  }
  if (!res.ok) throw new Error(\`\${path}: HTTP \${res.status} \${data.error?.code} \${data.error?.message}\`);
  return data;
}

/**
 * Plays one game as a player. Resolves with the \`end\` message.
 * Uses \`legal\`, so it works for games with \`listsLegalActions: true\` (such as tictactoe, used below).
 */
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

const RECONNECT_CLIENT = `// Keeps one seat connected until the game ends: pings, and reconnects with backoff.
// BASE as in section 6, wsBase as in 1.4. onMessage(msg, ws) runs your game loop; reset its "answered turn" per socket.
function connect(roomId, token, onMessage, delay = 1000, failures = 0) {
  const ws = new WebSocket(\`\${wsBase}/rooms/\${roomId}/ws\`, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token]);
  let ended = false;
  let opened = false;
  let pinger;
  ws.addEventListener("open", () => {
    opened = true;
    delay = 1000;
    failures = 0;
    pinger = setInterval(() => ws.send('{"type":"ping"}'), 30_000);
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "end") ended = true;
    onMessage(msg, ws);
  });
  ws.addEventListener("close", async (ev) => {
    clearInterval(pinger);
    // ${CLOSE_LEFT_ROOM} = you left the room (1.2), ${CLOSE_ROOM_DELETED} = the room was deleted, ${CLOSE_GAME_REMOVED} = its game was removed (1.10)
    // ${CLOSE_TOO_MANY_ERRORS} = too many errors (a bug), ${CLOSE_REPLACED} = a newer connection with this token took over
    if (ended || [${CLOSE_LEFT_ROOM}, ${CLOSE_ROOM_DELETED}, ${CLOSE_GAME_REMOVED}, ${CLOSE_TOO_MANY_ERRORS}, ${CLOSE_REPLACED}].includes(ev.code)) return;
    if (!opened && ++failures % 3 === 0) {
      // A refused upgrade looks like any other drop (code 1006). Ask REST why, and stop for good on 401 / 404 / 410.
      const res = await fetch(\`\${BASE}/rooms/\${roomId}/state\`, { headers: { Authorization: \`Bearer \${token}\` } }).catch(() => null);
      if (res && [401, 404, 410].includes(res.status)) return console.error("seat is gone:", res.status);
    }
    const wait = delay * (0.5 + Math.random());
    setTimeout(() => connect(roomId, token, onMessage, Math.min(delay * 2, 30_000), failures), wait);
  });
}`;

const QUICKMATCH_CLIENT =`// Play one game against whoever else is looking for a tictactoe game.
const me = await post("/quickmatch", { game: "tictactoe" }); // { roomId, playerId, token, created }
console.log(me.created ? "waiting for an opponent..." : "joined an open room");
const end = await play(me.roomId, me.token);
console.log(end.winners.length === 0 ? "draw" : end.winners.includes(me.playerId) ? "you won" : "you lost", end.scores);`;

const MESSAGE_TYPES = `// Client -> server (WebSocket text frames, JSON)
type ClientMessage =
  | { type: "action"; turn: number; action: unknown } // turn = \`turn\` of the latest state; action = e.g. one element of \`legal\`
  | { type: "resign" }                               // give up (by default: you lose, everyone else wins, the game ends)
  | { type: "ping" };                                 // answered with { type: "pong" } (free keepalive if sent exactly like this)

// Server -> client
// The "state" message is the same object as GET /rooms/{id}/state returns, plus type: "state".
type ServerMessage =
  | {
      type: "state";
      game: string;                 // game ID
      rulesVersion: number;         // rules version of this room (fixed when the room is created)
      gameOptions: unknown;         // the room's game options (defaults filled in); null for games without options
      status: "waiting" | "playing" | "finished";
      turn: number;                 // number of actions applied so far; echo it when acting
      players: string[];            // all player IDs in seat order ("p1", "p2", ...)
      currentPlayers: string[];     // player IDs who may act now (several = simultaneous turn)
      view: unknown;                // game-specific board as seen by the receiver (hidden info removed); null while waiting
      legal?: unknown[];            // present only if the receiver may act now and the game lists legal moves
      deadline: number | null;      // epoch ms (server clock) by which currentPlayers must act; null when not playing
      phaseTurn: number | null;     // turn at which the current (simultaneous) turn began; equals turn otherwise; null when not playing (1.5)
      now: number;                  // server clock (epoch ms) when this message was built; time left = deadline - now
      result: { winners: string[]; scores?: Record<string, number> } | null; // set once finished (same as in "end")
      endReason: "normal" | "timeout" | "resign" | null; // set once finished (same as reason in "end"); null otherwise
      last: {                       // what produced this state (the last log entry without its action); null before the first action (1.5)
        turn: number;               // the turn it was applied at; this state's turn is last.turn + 1
        player: string | null;      // who acted; null for a timeout or resignation
        at: number;                 // when it was applied (epoch ms, server clock)
        timeout?: string[];         // only on a timeout: the players who ran out of time
        resign?: string;            // only on a resignation: the player who resigned
      } | null;
      rematch?: { roomId: string; requestedBy: string[] }; // only after the end, once someone asked for a rematch (1.9)
    }
  | { type: "error"; code: string; message: string } // the same codes as REST (1.6), e.g. "STALE_TURN"
  | {
      type: "end";
      winners: string[];            // empty = draw (or everyone timed out)
      scores?: Record<string, number>;
      reason: "normal" | "timeout" | "resign"; // normal = decided by the game's rules
    }
  | { type: "pong" };`;

function buildGuide(): string {
  const gameList = Object.values(games);
  return [
    "# blindfold — Client Developer Guide",
    "",
    "_No board to look at. Still a game._",
    "",
    "blindfold hosts turn-based games that are played entirely over an HTTP + WebSocket API. All game logic runs on the server;",
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
        "Quick match   POST /quickmatch {game} -> { roomId, playerId, token } -> WS /rooms/{roomId}/ws -> wait -> loop (starts by itself)",
        "Flow          POST /rooms -> POST /rooms/{id}/join (once per seat) -> POST /rooms/{id}/start -> WS /rooms/{id}/ws -> loop",
        "Open rooms    GET /rooms (waiting, has a free seat) · GET /rooms?status=playing (to spectate)",
        `WS auth       new WebSocket(url, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token])   (no token = spectator; "${WS_PROTOCOL}" is required)`,
        "REST auth     Authorization: Bearer <token>",
        "Never         put a token in the URL: ?token= is rejected with 400",
        'Act           {"type":"action","turn":<turn of latest state>,"action":<one element of legal, unchanged>}',
        "Loop          on every `state`: if your playerId is in `currentPlayers`, send one action for that `turn` (once), e.g. an element of `legal`",
        "STALE_TURN    ignore it and wait for the next `state`",
        'Resign        {"type":"resign"} over WS, or POST /rooms/{id}/resign (Bearer token): you lose, the game ends',
        "End           `end` message: { winners, scores, reason }",
        "Leave         POST /rooms/{id}/leave (Bearer token): undo a join before the game starts",
        "Rematch       POST /rooms/{id}/rematch (Bearer token) after the end -> { roomId, playerId, token } in a new room",
        `API version   ${API_VERSION}   (0.x: may change without notice; ignore unknown fields. Section 9)`,
        `Changelog     ${BASE}/changelog.md`,
        `Usage policy  ${BASE}/policy.md   (shared free budget: no polling, no bulk creation; what is public)`,
      ].join("\n"),
    ),
    "",
    "- Sending an element of `legal` unchanged is always accepted. You never need to compute legality yourself, as long",
    "  as the game lists legal moves (`listsLegalActions: true` in `GET /games`" +
      (gameList.every((g) => g.legalActions)
        ? "; true for every game today"
        : `; false for ${gameList.filter((g) => !g.legalActions).map((g) => `\`${g.id}\``).join(", ")}`) +
      "). For a game",
    "  that does not, `legal` is never sent and you build the action from the game's action schema (section 5).",
    "- State is pushed over the WebSocket after every change. Do not poll `GET /rooms/{id}/state`: the service runs on a",
    "  free tier with a daily request budget.",
    "- By using the API you agree to the usage policy, `GET /policy.md`: a short page on the shared budget, fair play,",
    "  what is public and how long data is kept.",
    "- CORS is enabled for all REST endpoints (any origin; `Authorization`, `Content-Type` and `X-Api-Key` are allowed), so",
    "  a browser app on another origin can call the API directly.",
    "",
    "## 1. Lifecycle, step by step",
    "",
    "### 1.0 Finding an opponent",
    "",
    "Pick one of these. All of them end with a player `token` and a WebSocket connection (1.4).",
    "",
    "1. **Quick match (recommended for bots).** `POST /quickmatch` with `{\"game\":\"tictactoe\"}` joins the oldest open",
    "   auto-start room of that game with the same `turnTimeMs` and `seats`, or creates one if there is none. The game starts by itself",
    "   as soon as the room is full, so nobody calls `start`.",
    code("sh", `curl -X POST ${BASE}/quickmatch -H 'Content-Type: application/json' -d '{"game":"tictactoe"}'`),
    code("json", json({ roomId: EXAMPLE_ROOM_ID, playerId: "p1", token: "<token>", created: true })),
    "   `created: true` means you made a new room and are waiting for someone else. Connect the WebSocket **right away**",
    "   with your `token`: you receive `state` messages with `status: \"waiting\"` (and a growing `players`) until the room",
    "   fills, then a `status: \"playing\"` state, with `legal` if you move first. Optional body `options.turnTimeMs`,",
    "   `options.seats` and `gameOptions` (all matched exactly, after filling in defaults) and header `X-Api-Key` work as for `/rooms`",
    "   and `/join`. Nobody gets a `hostToken`.",
    `   A room you created stops being offered to others ${WAITING_LIST_TTL_MS / 60000} minutes after its last join. If nobody`,
    "   has joined by then, call `POST /rooms/{roomId}/leave` with your token (1.2) and `/quickmatch` again.",
    "2. **Browse open rooms.** `GET /rooms` lists public waiting rooms that still have a free seat",
    "   (`?game=&limit=`; each item has `roomId`, `game`, `gameOptions`, `players`, `maxPlayers`, `autoStart`, `turnTimeMs`). Join one",
    "   with `POST /rooms/{roomId}/join`. The list is an index and can lag a little: if the join fails with `ROOM_FULL`,",
    `   \`ALREADY_STARTED\` or \`ROOM_NOT_FOUND\`, try the next room. Rooms not updated for ${WAITING_LIST_TTL_MS / 60000} minutes are not listed.`,
    "3. **Host your own room** (1.1). Rooms are listed in `GET /rooms` by default; pass `options.unlisted: true` to keep",
    "   it private and share `roomId` yourself. Pass `options.autoStart: true` to start automatically when the room is",
    "   full. Without it, the creator must call `start` (1.3) once enough players have joined.",
    "",
    "Practice rooms (`options.practice`) are never listed and never matched.",
    "",
    "### 1.1 Create a room",
    code("sh", `curl -X POST ${BASE}/rooms -H 'Content-Type: application/json' -d '{"game":"tictactoe"}'`),
    code("json", json({ roomId: EXAMPLE_ROOM_ID, hostToken: "<hostToken>" })),
    "",
    "`options` is optional. Unknown keys are rejected with 400. Its JSON Schema:",
    code("json", json(z.toJSONSchema(roomOptions))),
    `\`turnTimeMs\` is the time limit per turn; the default is ${DEFAULT_TURN_TIME_MS} ms (${DEFAULT_TURN_TIME_MS / 60000} minutes).`,
    "`seats` is the number of seats, between the game's `minPlayers` and `maxPlayers` (`GET /games`; outside that range",
    "is 400); the default is `maxPlayers`. The room is full at `seats` players (later joins get `ROOM_FULL`), and",
    "`GET /rooms` reports it as the room's `maxPlayers`. Games with a fixed number of players leave nothing to choose.",
    "",
    "**Game options:** some games take options of their own (`hasOptions: true` in `GET /games`). Pass them as",
    "`gameOptions` next to `options`, e.g. `{\"game\":\"<id>\",\"gameOptions\":{...}}`. Their JSON Schema, defaults and",
    "meaning are `optionsSchema`, `defaultGameOptions` and `options` in `/games/{id}/rules`. Omitted fields take their",
    "defaults; unknown keys, and any `gameOptions` for a game without options, are rejected with 400. The filled-in",
    "value is part of every `state` (`gameOptions`), `GET /rooms`, `/log` and `/matches`, and a rematch keeps it.",
    "",
    '**Practice opponent:** with `"options": {"practice": true}`, the server fills the empty seats (up to `seats`, or',
    "`minPlayers` if `seats` is omitted) with built-in bots when the game starts. They take the seats after the joined players (join once and you are `p1`,",
    "the bot is `p2`), play a simple legal move (random unless the game defines its own) as soon as it is their turn,",
    "and never time out. They are for checking your client's flow, not for strength. Use this to test your",
    "client alone: create, join once, start, connect. Practice games are not recorded in `/users/{id}` or `/matches`.",
    "",
    "**Auto start:** with `\"autoStart\": true` the game starts as soon as the room is full (`seats` players; no `start` call;",
    "a later `start` gets `ALREADY_STARTED`). It cannot be combined with `practice` (400).",
    "",
    "**Listing:** every room except practice rooms appears in `GET /rooms` while it waits for players and while it is",
    "being played. `\"unlisted\": true` hides it from the list and from quick match; only people who know `roomId` can join.",
    "",
    "`hostToken` is only for starting the game. It is **not** a player token: the creator must also join to play.",
    "",
    "### 1.2 Join (once per seat)",
    code("sh", `curl -X POST ${BASE}/rooms/{roomId}/join`),
    code("json", json({ playerId: "p1", token: "<token>" })),
    "",
    "- Player IDs are assigned in join order: `p1`, `p2`, ... Keep `token` secret; it identifies the seat.",
    "- Joining fails with `ROOM_FULL` or `ALREADY_STARTED` (409), or `ROOM_RESERVED` (403) for a rematch room (1.9).",
    "  With `X-Api-Key`, a user can take only one seat per room: a second join with the same key gets `ALREADY_JOINED` (409).",
    `- **Leaving:** before the game starts, \`POST /rooms/{roomId}/leave\` with \`Authorization: Bearer <token>\` frees your`,
    `  seat. Your token stops working and the server closes your WebSockets to that room with close code ${CLOSE_LEFT_ROOM}`,
    "  (do not reconnect). Seat numbers are not reused, so the next player to join gets a new ID and `players` can have",
    "  gaps (for example `[\"p2\", \"p3\"]`). Turn order is the order of `players` (seat order), which is join order",
    "  except in a rematch room, where the seats are fixed in advance (1.9). Once the game has started, leaving gets",
    "  `ALREADY_STARTED` (409): resign instead (1.8).",
    "- Optional: send `X-Api-Key: <apiKey>` (from `POST /users` with `{\"name\":\"...\"}`) to record the result on that user.",
    "- To test alone, create the room with `options.practice` (see 1.1) and join once, or join twice and run two connections.",
    "",
    "### 1.3 Start (room creator only)",
    code("sh", `curl -X POST ${BASE}/rooms/{roomId}/start -H 'Authorization: Bearer <hostToken>'`),
    "Requires at least `minPlayers` players (`NOT_ENOUGH_PLAYERS`, 409), counting practice bots. A player token gets `NOT_HOST` (403).",
    "",
    "**How the host knows when to start:** `hostToken` cannot open a WebSocket (401: it is not a player token). Connect",
    "with your own player token (or as a spectator, without a token) before others join. Every join pushes a",
    "`state` with `status: \"waiting\"` and the updated `players` list; once `players.length` reaches the number you",
    "want (at least `minPlayers`), call `start`. Do not poll `/state` for this. Or simply create the room with",
    "`options.autoStart` and skip this step.",
    "",
    "### 1.4 Connect the WebSocket",
    code(
      "js",
      [
        `const wsBase = "${BASE}".replace(/^http/, "ws"); // http -> ws, https -> wss`,
        `const ws = new WebSocket(\`\${wsBase}/rooms/\${roomId}/ws\`, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token]);`,
        `// The server answers with the "${WS_PROTOCOL}" subprotocol. Clients that can set headers may send`,
        `// \`Authorization: Bearer <token>\` instead of the token subprotocol, but must still offer "${WS_PROTOCOL}".`,
        `// To spectate, offer only "${WS_PROTOCOL}".`,
      ].join("\n"),
    ),
    "",
    `- \`${WS_PROTOCOL}\` is the version of the WebSocket protocol (the messages in section 2) and is required. The server`,
    "  picks the newest version you offer that it supports and answers with it. If a later version changes the messages",
    "  in a breaking way, it gets a new name (`blindfold.v2`) and the old one keeps working for a while, so a client that",
    `  offers only \`${WS_PROTOCOL}\` keeps getting the messages it was written for.`,
    "- You may connect before or after the game starts. Right after connecting you receive the current `state`",
    "  (`status` may be `waiting`), and if the game is already over, an `end` message right after it.",
    "- Reconnecting is always safe: the first `state` tells you everything. You do not need to keep local state (see 1.10).",
    "- If the upgrade is refused (404 unknown room, 401 invalid token, 400 token in the URL or a missing / malformed",
    "  subprotocol, 410 the game is no longer available, 429 too many upgrades from your IP address, 503 too many",
    "  spectators in the room),",
    "  a browser `WebSocket` cannot read the status or the body: it only fires `error` and `close` (usually code 1006).",
    "  To find out why, call `GET /rooms/{id}/state` with the same token in `Authorization: Bearer`: an unknown room (404)",
    "  or an invalid token (401) fails there too, with a JSON error body. If `/state` succeeds, check the URL (no `?token=`)",
    "  and the subprotocol list (exactly `[\"" + WS_PROTOCOL + "\", \"" + WS_TOKEN_PROTOCOL_PREFIX + "<token>\"]`). 429 and 503",
    "  are not visible from `/state`: keep backing off.",
    "",
    "### 1.5 The game loop",
    "",
    "On every `state` message:",
    "1. Render `view` (see the game's rules for its fields).",
    "2. If your `playerId` is in `currentPlayers` (and `status` is `playing`), it is your move. Choose one element of",
    '   `legal` and send `{"type":"action","turn":<state.turn>,"action":<element>}`. Send at most one action per `turn`.',
    "   On a simultaneous turn the `turn` goes up each time another player acts. An action carrying an older `turn` of the",
    "   same simultaneous turn is still accepted as long as you may still act, so you do not need to resend.",
    "   A `state` built before your action was processed can still arrive after you sent it (another player acted",
    "   first). Remember the `turn` you sent: if it is `>= state.phaseTurn` and you are still in `currentPlayers`, your",
    "   action is on its way; do not act again. `phaseTurn` is the turn at which the current turn began (it stays the",
    "   same through a simultaneous turn), so once it moves past the `turn` you sent, it is a new turn and you may act.",
    "   In a game that does not list legal moves (`listsLegalActions: false`), `legal` is absent: build the action",
    "   from the game's action schema; if it is rejected with `ILLEGAL_ACTION`, you may send another one for the same `turn`.",
    "3. Otherwise wait. The next `state` arrives when anyone acts (including on simultaneous turns, where",
    "   `currentPlayers` lists several players and shrinks as they act).",
    "",
    "Your own seat is your `playerId` from `join`; compare it with `currentPlayers` and the IDs in `view`. In games that",
    "list legal moves, `legal` is present exactly when you may act, so checking for it works too.",
    "",
    "**What just happened (optional).** Every `state` carries `last`, the event that produced it: who acted (`player`), or",
    "who timed out (`timeout`) or resigned (`resign`). What the move was is up to the game's `view` (for example the last",
    "cell played or the battles of the last round; see the game's rules), so only what you may see is shown. The server",
    "sends every change to every connection in order, so within one connection you never miss a `state`. A client",
    "that only plays can ignore all of this. If you want to show or animate each event:",
    "- Treat the first `state` after connecting (or reconnecting) as the current position: draw it without animation.",
    "  Its `last` may be long past (`now - last.at` tells how long).",
    "- Animate only `state`s received after that on the same connection, and only when `last.turn` changes. The same",
    "  `last` can arrive again (for example the extra `state` after a rematch request), and in games with rounds the",
    "  round's events stay in `view` while several `state`s of the next round arrive; the game's rules say how to tell.",
    "",
    "### 1.6 Errors",
    "",
    "WebSocket errors arrive as `{ \"type\": \"error\", code, message }` and do not close the connection.",
    "",
    "| code | meaning | what to do |",
    "|---|---|---|",
    "| `STALE_TURN` | `turn` is not the current turn (duplicate, outdated, or the deadline passed); an older `turn` of the same simultaneous turn is accepted while you may still act | wait for the next `state` |",
    "| `NOT_YOUR_TURN` | you may not act now | wait for a `state` whose `currentPlayers` includes you |",
    "| `ILLEGAL_ACTION` | the move breaks the rules | send an element of `legal` (or, without `legal`, another action) |",
    "| `NOT_PLAYING` | the game has not started yet or is already over (for example an action sent after `end`) | wait for a `playing` state, or stop |",
    "| `UNAUTHORIZED` | the connection has no valid player token (a spectator, or a seat that was left) | reconnect with a player token |",
    "| `GAME_REMOVED` | the game (or the rules version the room was created with) is no longer on the server | stop; nothing can be done in this room |",
    "| `BAD_REQUEST` | malformed JSON / message / action shape | fix the message format |",
    "| `INTERNAL` | server-side failure while handling the message | resend the same action if its `turn` is still current; otherwise wait for the next `state` (or reconnect) |",
    "",
    "The WebSocket uses the same codes as the REST API (below), so the same error has the same code on both. New codes",
    "may be added: handle an unknown one like `BAD_REQUEST`.",
    "",
    "REST errors use HTTP status codes with the body `{ \"error\": { \"code\": \"...\", \"message\": \"...\" } }`.",
    "Codes: `BAD_REQUEST` (400), `UNKNOWN_GAME` (400), `ILLEGAL_ACTION` (400), `UNAUTHORIZED` (401), `NOT_HOST` (403),",
    "`NOT_YOUR_TURN` (403), `NOT_FINISHED` (403), `ROOM_RESERVED` (403), `ROOM_NOT_FOUND` (404: unknown or deleted room, or",
    "an ID that is not 12 lowercase hex characters), `NOT_FOUND` (404: unknown",
    "route, unknown game in `/games/{id}/rules`, unknown user in `/users/{id}`), `ALREADY_STARTED` / `ROOM_FULL` / `ALREADY_JOINED` /",
    "`NOT_ENOUGH_PLAYERS` / `NOT_PLAYING` / `STALE_TURN` (409), `GAME_REMOVED` (410: the game, or the rules version the",
    "room was created with, is no longer on the server; nothing can be done in that room, but the `/log` of a finished one still works),",
    "`UPGRADE_REQUIRED` (426), `RATE_LIMITED` (429), `INTERNAL` (500), `TOO_MANY_CONNECTIONS` (503: the room already has",
    "the most spectator WebSockets it accepts).",
    "",
    "- Every endpoint that reads or changes a room, `GET /rooms`, `GET /matches`, `GET /users/{id}`, user creation and",
    "  WebSocket upgrades are rate-limited per IP address. Over the limit they fail with 429 `RATE_LIMITED` and a",
    "  `Retry-After` header (seconds): wait that long before retrying. Normal play is not affected: messages on an open",
    "  WebSocket are not rate-limited (only errors are, see \"Errors are limited\" in 1.10), and the limits leave room for",
    "  reconnecting with backoff and for an occasional `/state`, but not for polling `/state` every second.",
    "- `GET /rooms/{id}/state` with an **invalid** token fails with 401 `UNAUTHORIZED`. It does not fall back to the",
    "  spectator view; to spectate, send no `Authorization` header at all.",
    "- **Not every error response is JSON.** When the service's daily request limit is used up (it resets at 00:00 UTC),",
    "  or the platform itself fails, the response may be an HTML error page (typically 429 or 5xx) instead of the JSON body",
    "  above. Read the body as text, parse it only if it is JSON, and retry later with backoff on a non-JSON response or",
    "  any 5xx. The minimal client in section 6 does this.",
    "",
    "### 1.7 Deadlines",
    "",
    "`deadline` is an epoch-millisecond timestamp on the **server's** clock. If a player in `currentPlayers` has not",
    "acted by then, the server resolves the timeout itself (by default the player who timed out loses; some games define",
    "their own handling, see the game's rules). An action that arrives after the deadline is rejected with `STALE_TURN`.",
    "",
    "Every `state` also carries `now`, the server clock when the message was built. Do not compare `deadline` with your",
    "own `Date.now()`: the client's clock may be off by seconds or more. Take the time left from the server's values and",
    "count down locally from the moment the message arrived:",
    code(
      "js",
      [
        "const remainingMs = state.deadline - state.now; // time left when the server sent this state",
        "const localDeadline = Date.now() + remainingMs;  // the same moment on your own clock (minus network delay)",
      ].join("\n"),
    ),
    "Network delay makes this slightly optimistic, so keep a safety margin. Show a countdown in UIs; bots should",
    "simply act promptly.",
    "",
    "### 1.8 Resigning",
    "",
    'Send `{"type":"resign"}` over the WebSocket (or `POST /rooms/{id}/resign` with `Authorization: Bearer <token>`).',
    "You may resign at any time while the game is `playing`, even when it is not your turn. By default you lose, all",
    "other players win, and the game ends immediately (`end` with `reason: \"resign\"`). Some games define their own",
    "handling (for example, only your seat drops out and the game goes on); see the game's rules. It cannot be undone.",
    "Resigning before the game starts or after it ended is rejected with `NOT_PLAYING` (409 over REST).",
    "Spectators cannot resign (`UNAUTHORIZED`). A resignation is recorded in `/rooms/{id}/log` as",
    "`{ player: null, action: null, resign: \"p1\" }` and takes up one `turn`, like a timeout.",
    "",
    "### 1.9 End of game",
    "",
    "Everyone receives `{ \"type\": \"end\", \"winners\": [...], \"scores\": {...}, \"reason\": \"...\" }` after the final",
    "`state` (`status: \"finished\"`). An empty `winners` means a draw. `reason` is `normal` (decided by the game's rules),",
    "`timeout` or `resign`; the final `state` (and `GET /rooms/{id}/state` afterwards) has the same value in `endReason`.",
    "You may close the socket (the server does not close it for you).",
    "",
    "**Rematch.** To play again with the same players, every player calls `POST /rooms/{roomId}/rematch` on the",
    "finished room with their own token. The first call creates a new room (same game and options); each call seats the",
    "caller there and returns `{ roomId, playerId, token }` for the **new** room. Connect to it right away (1.4): it",
    "starts by itself once every player has called rematch, and you receive `waiting` states until then. Seats are",
    "rotated by one, so your `playerId` changes (in a two-player game, first and second player swap). The seat order is",
    "fixed when the room is created; it does not depend on who calls rematch first. Calling again (also after",
    "leaving the new room) returns the same seat and token. Only players of the old room can sit there (others get `ROOM_RESERVED`), and",
    "the room is not listed. Practice bots are added again when it starts, so a practice rematch starts at once.",
    "Before the end you get `NOT_FINISHED` (403).",
    "",
    "When someone asks, everyone still connected to the finished room receives one more `state` (after `end`) with",
    "`rematch: { roomId, requestedBy }`; `GET /rooms/{id}/state` shows it too. A bot that wants rematches can simply",
    "call rematch after every `end`. To decline after accepting, leave the new room (`POST /rooms/{newRoomId}/leave`).",
    "`requestedBy` means \"has asked at least once\"; who is seated right now is the new room's `players`. The other",
    "players may never answer, so if the new room has not started within a time you choose, leave it and move on.",
    "",
    "### 1.10 Disconnects, reconnects and long-running clients",
    "",
    "**A disconnect is not a loss.** The server does not care whether your socket is open; only the deadline matters.",
    "Reconnect and act before `deadline` and nothing is lost. If you stay disconnected past the deadline, the turn times",
    "out exactly as if you had been connected and idle (by default you lose). Other players are not told that you left.",
    "",
    `**Several connections per token are allowed, up to ${MAX_SOCKETS_PER_SEAT}.** You may open more than one WebSocket with the same`,
    "token (for example a bot and a UI, or an old socket that has not noticed it is dead). Every connection receives every",
    "broadcast. Only the first action for a `turn` is applied; the same-turn action from another connection gets",
    `\`STALE_TURN\`. Opening one more than ${MAX_SOCKETS_PER_SEAT} closes the oldest connection of that seat with close code ${CLOSE_REPLACED}.`,
    `A room accepts up to ${MAX_SPECTATOR_SOCKETS} spectator connections; beyond that the upgrade fails with 503 \`TOO_MANY_CONNECTIONS\`.`,
    "",
    "**Keepalive.** While a socket is open, send `{\"type\":\"ping\"}` about every 30 seconds. The server answers",
    "`{\"type\":\"pong\"}` without waking the room, so pings do not use the request budget. This works only for that exact",
    "string (no spaces, no extra fields); any other ping is still answered but counts like an error (see below). A silent socket may be dropped",
    "by proxies, and the pong tells you the socket is still alive: if nothing arrives within about 10 seconds of a ping,",
    "close the socket and reconnect.",
    "",
    `**Errors are limited.** Every \`error\` the server sends on a socket counts against it. The count drops by one every`,
    `${WS_STRIKE_DECAY_MS / 1000} seconds; when it goes over ${WS_MAX_STRIKES}, the server closes the socket with close code ${CLOSE_TOO_MANY_ERRORS}.`,
    "Applied actions and resignations never count. A client that waits for its turn and sends the `turn` it was given",
    "never gets near the limit, so being closed this way means a bug: fix it before reconnecting.",
    "",
    "**When the server closes a socket.** In normal operation the server never closes a socket by itself, not even after",
    "`end`; that is up to you. It closes one only when it echoes a close you started, when you left the room",
    `(close code ${CLOSE_LEFT_ROOM}; do not reconnect), when the room is deleted (close code ${CLOSE_ROOM_DELETED}; do not reconnect, see below),`,
    `when the room's game or rules version is no longer on the server (close code ${CLOSE_GAME_REMOVED}; do not reconnect, see below),`,
    `when a newer connection with the same token replaced it (close code ${CLOSE_REPLACED}; do not reconnect),`,
    `when it sent too many errors (close code ${CLOSE_TOO_MANY_ERRORS}; do not reconnect until the bug is fixed),`,
    "or when the platform reports an error on the socket (close code 1011).",
    "A socket can also drop without a close frame (code 1006 in browsers) when",
    "the network fails or the service is redeployed. Treat every unexpected `close` the same way: reconnect.",
    "",
    "**Reconnecting.** Open a new WebSocket with the same URL and token. The first message is the current `state`",
    "(followed by `end` if the game is over), so you need no local state.",
    "",
    "- Back off between attempts: about 1 s, 2 s, 4 s, ... up to 30 s, with random jitter. Reset the delay once a",
    "  connection opens. Turns last minutes by default, so a short outage does not cost the game.",
    "- Forget which `turn` you already answered. If the first `state` still has that `turn` and lists you in",
    "  `currentPlayers`, your action was lost: send it again. Had it been applied, the turn would have moved on.",
    "- Stop after an `end` message. A browser cannot see why an upgrade failed (see 1.4), so after a few failed attempts",
    "  call `GET /rooms/{id}/state` with the token: 404 (unknown room), 401 (invalid token) or 410 (`GAME_REMOVED`) means stop; anything else",
    "  means keep retrying with backoff.",
    "",
    code("js", RECONNECT_CLIENT),
    "",
    "**Persist your seat.** Tokens cannot be reissued, and there is no way to look your seat up again. Save `roomId`,",
    "`playerId` and `token` (to a file, `localStorage`, ...) as soon as `join` or `quickmatch` returns, so a restarted",
    "process can reconnect and continue. Keep them private: anyone with the token plays your seat. `hostToken` is needed",
    "only until `start`.",
    "",
    "**How long rooms live.** Rooms are deleted after a while; then every endpoint of the room answers 404",
    `\`ROOM_NOT_FOUND\` and open sockets are closed with code ${CLOSE_ROOM_DELETED}.`,
    `- A waiting room is deleted ${WAITING_ROOM_TTL_MS / 3600000} hours after its last change (creation, join or leave). It drops out of`,
    `  \`GET /rooms\` and quick match much earlier, ${WAITING_LIST_TTL_MS / 60000} minutes after its last update, but can be joined by \`roomId\` until it is deleted.`,
    "- A game in progress is never deleted; an abandoned one ends by itself as its deadlines run out.",
    "- When a game's `rulesVersion` goes up (or a game is withdrawn), every room created with the old version, waiting,",
    `  in progress or finished, answers 410 \`GAME_REMOVED\` and its open sockets are closed with code ${CLOSE_GAME_REMOVED}. It is no`,
    `  longer listed and is deleted within ${FINISHED_ROOM_TTL_MS / 86400000} days; the \`/log\` of a finished one stays available until then.`,
    `- A finished room keeps its \`state\`, \`/log\` and \`/replay\` for ${FINISHED_ROOM_TTL_MS / 86400000} days after the end. Download`,
    "  `/rooms/{id}/log` within that time if you need a permanent record. `GET /matches` and `GET /users/{id}` keep the result.",
    "",
    "## 2. Message reference (WebSocket)",
    "",
    code("ts", MESSAGE_TYPES),
    "",
    "## 3. REST endpoints",
    "",
    "| method | path | auth | purpose |",
    "|---|---|---|---|",
    "| GET | `/games` | - | list games (`id`, `rulesVersion`, `viewVersion`, `minPlayers`, `maxPlayers`, `listsLegalActions`, `hasOptions`, `summary`, `rulesUrl`) |",
    "| GET | `/games/{id}/rules` · `/games/{id}/rules.md` | - | rules, view fields, action schema (JSON / Markdown) |",
    "| POST | `/quickmatch` | optional `X-Api-Key` | `{ game, options?: { turnTimeMs }, gameOptions? }` -> `{ roomId, playerId, token, created }` |",
    "| GET | `/rooms` | - | public rooms: `?status=waiting` (default, free seats) or `playing`; `&game=&limit=` |",
    "| POST | `/rooms` | - | `{ game, options?, gameOptions? }` -> `{ roomId, hostToken }` |",
    "| POST | `/rooms/{id}/join` | optional `X-Api-Key` | -> `{ playerId, token }` |",
    "| POST | `/rooms/{id}/start` | Bearer hostToken | start the game |",
    "| POST | `/rooms/{id}/leave` | Bearer token | leave before the game starts (undo join) |",
    "| POST | `/rooms/{id}/rematch` | Bearer token | after the end: `{ roomId, playerId, token }` in a new room with the same players |",
    "| GET | `/rooms/{id}/state` | optional Bearer token | current state (player view with token, spectator view without) |",
    "| POST | `/rooms/{id}/action` | Bearer token | `{ turn, action }`; REST alternative to the WS action message |",
    "| POST | `/rooms/{id}/resign` | Bearer token | resign (by default you lose and the game ends) |",
    "| GET | `/rooms/{id}/ws` | subprotocol token (optional) | WebSocket |",
    "| GET | `/rooms/{id}/log` | - | action log (after the game ends) |",
    "| GET | `/rooms/{id}/replay` | - | spectator view for every turn (after the game ends) |",
    "| POST | `/users` | - | `{ name }` -> `{ userId, apiKey }` |",
    "| POST | `/users/{id}/key` | `X-Api-Key` | -> `{ userId, apiKey }` with a new key (the old one stops working) |",
    "| GET | `/users/{id}` | - | user and results |",
    "| GET | `/matches` | - | finished matches (`?game=&limit=`) |",
    "",
    "`GET /rooms/{id}/state`, `POST /rooms/{id}/action`, `/start`, `/resign` and `/leave` return the same object as the",
    "`state` message, without the `type` field.",
    `Full OpenAPI spec: [${BASE}/openapi.json](${BASE}/openapi.json).`,
    "",
    "## 4. Spectating, replays and results",
    "",
    "- Find games in progress with `GET /rooms?status=playing` (public rooms only). A game is listed as long as it has shown",
    `  activity within its time per turn plus ${PLAYING_LIST_GRACE_MS / 3600000} hours; one that has gone quiet longer drops out of the list.`,
    "- Connect to `/rooms/{id}/ws` with only the `" + WS_PROTOCOL + "` subprotocol (no token) to receive spectator `state` messages.",
    "- After the game ends, `GET /rooms/{id}/replay` gives the spectator view at every turn. Use it to build a",
    "  replay viewer. Finished games are listed in `GET /matches`. Response shapes and examples: section 8.",
    "",
    "## 5. Games",
    "",
    "Each game defines its own `view` and `action`. Examples below are generated from the real game engine. For typed",
    "clients (TypeScript types, Python dataclasses, ...), generate the types from `viewSchema` and `actionSchema` in",
    "`GET /games/{id}/rules` (JSON Schema) instead of guessing from the examples.",
    "",
    gameList.map(gameSection).join("\n\n"),
    "",
    "## 6. Minimal client (copy-paste)",
    "",
    "Creates a tictactoe room with a practice bot, joins once, and plays random legal moves until the game ends.",
    "Replace `pick(legal, view)` with your own strategy.",
    "",
    code("js", MINIMAL_CLIENT),
    "",
    "To play against another client (or a person) instead, replace the last block with a quick match. Run the same",
    "code twice and the two instances meet in one room; `play()` waits through the `waiting` states by itself:",
    "",
    code("js", QUICKMATCH_CLIENT),
    "",
    "## 7. Checklist for a correct client",
    "",
    "- [ ] Tokens are sent only in the `Authorization` header or the WebSocket subprotocol, never in the URL.",
    "- [ ] Every action carries the `turn` of the latest `state`, and at most one action is sent per `turn`.",
    "- [ ] Whether you may act is decided by `currentPlayers`; actions are taken from `legal` (or match the game's action",
    "  schema exactly, for games that do not list legal moves).",
    "- [ ] `STALE_TURN` and other errors do not crash the client; it waits for the next `state`.",
    "- [ ] REST responses that are not JSON (or are 5xx) are retried later instead of crashing the JSON parser.",
    "- [ ] A 429 `RATE_LIMITED` response waits for its `Retry-After` seconds before the same request is retried.",
    `- [ ] The client does not poll \`/state\`, and does not reconnect after close code ${CLOSE_TOO_MANY_ERRORS} or ${CLOSE_REPLACED}.`,
    "- [ ] The UI handles `status: \"waiting\"` (before start) and `view` fields that only some viewers receive.",
    "- [ ] On `end`, the result is shown and the socket is closed.",
    "- [ ] Countdowns use `deadline - now` from the `state`, not the local clock.",
    "- [ ] `roomId`, `playerId` and `token` are saved; an unexpected `close` leads to a reconnect with backoff.",
    "- [ ] While the socket is open, exactly `{\"type\":\"ping\"}` (no spaces) is sent about every 30 seconds.",
    "- [ ] Unknown fields, unknown message `type`s and unknown error codes are ignored, not treated as fatal.",
    "- [ ] Unknown values of `status`, `reason`, `outcome` and other enum-like fields in responses are handled (see",
    "  section 9), not treated as fatal.",
    `- [ ] The WebSocket offers the \`${WS_PROTOCOL}\` subprotocol.`,
    "",
    "## 8. Response reference (logs, replays, users, matches)",
    "",
    "Needed for replay viewers and result pages, not for playing. Full schemas are in the OpenAPI spec.",
    "",
    responseShapes(),
    "",
    "## 9. Versions and compatibility",
    "",
    "There are several different version values. Do not confuse them:",
    "",
    "| Name | Where | Meaning |",
    "|---|---|---|",
    "| `version` | heading of this guide and of `/games/{id}/rules.md`, `version` in `/games/{id}/rules`, `ETag` | Hash of the content. Changes on any edit, even a typo fix. Use it only as a cache key (`If-None-Match` returns 304 while it is unchanged) |",
    "| `rulesVersion` | `/games`, `/games/{id}/rules`, and per game in `GET /rooms/{id}/state`, `/log`, `/replay`, `/matches` | Version of one game's rules, an integer. Bumped when a game's rules or `action` format change, or anything else that makes an old log replay differently. A room records the value when it is created. The server keeps only the current version: rooms created with an older one (waiting, in progress or finished) fail with `GAME_REMOVED` (410), and their `/replay` too; `/log` of a finished room stays available |",
    "| `viewVersion` | `/games`, `/games/{id}/rules` | Version of the shape of one game's `view`, an integer. Bumped when a `view` field is removed or renamed, changes type or meaning, or gets a new value in a fixed set (such as a new kind of cell); not when a field is added. Unlike `rulesVersion`, a room in progress switches to the new shape |",
    `| WebSocket subprotocol | \`${WS_PROTOCOL}\` (section 1.4) | Version of the WebSocket messages. Negotiated per connection |`,
    `| \`apiVersion\` | TL;DR above, \`apiVersion\` in \`/games/{id}/rules\`, \`info.version\` in \`/openapi.json\` | Version of the API, in semver. Currently \`${API_VERSION}\` |`,
    "",
    "The API is experimental while `apiVersion` is `0.x`: breaking changes may be released without notice, with only a",
    "minor version bump. From `1.0.0`, breaking changes bump the major version.",
    "",
    "**Changes that are not breaking** (made at any time, so clients must tolerate them):",
    "",
    "- New fields in REST responses, in WebSocket messages and in a game's `view`. Ignore fields you do not know. The",
    "  `viewSchema` in `/games/{id}/rules` describes today's fields and does not forbid extra ones; do not make your",
    "  parser reject them.",
    "- New values of enum-like fields in responses and messages: `status` (`waiting`, `playing`, `finished`), `reason`",
    "  (`normal`, `timeout`, `resign`), `outcome` (`win`, `loss`, `draw`) and similar. The OpenAPI spec types them as",
    "  strings and lists today's values in the description. Treat an unknown `reason` like `normal`, an unknown",
    "  `outcome` as neither a win nor a loss, and an unknown `status` as neither `waiting` nor `finished` (keep",
    "  listening for the next `state`). This does not apply to values inside a game's `view`, which follow `viewVersion`.",
    "- New WebSocket message `type`s (skip them) and new error codes (handle them like `BAD_REQUEST` over the",
    "  WebSocket; over REST go by the HTTP status).",
    "- New games (including games that take `gameOptions` or do not list legal moves), endpoints, and optional request",
    "  fields, room options or game options.",
    "- Rewording of this guide, the rules text or error messages. Do not match on `message` text; use `code`.",
    "",
    "**Breaking changes**: removing or renaming a field, changing its type or meaning, making a request field",
    "required, changing authentication, and changing a game's rules or its `action` format. A game's rules and",
    "`action` format change only together with its `rulesVersion`; rooms created with the old version then end with",
    "`GAME_REMOVED`, and their replays are no longer available (the log is).",
    "Breaking changes to a game's `view` bump its `viewVersion`.",
    "",
    "Changes are listed in the changelog, `GET /changelog.md` (Markdown, newest first, with an `ETag`).",
    "",
    "To stay up to date, cache this guide and `/games/{id}/rules` with their `ETag`. When the content changes, compare",
    "`apiVersion` with the one you built against, and `rulesVersion` / `viewVersion` with the ones your bot was written for. A",
    "long-running bot can re-check the rules of its game when it starts.",
    "",
    "When something is being phased out, responses that use it may carry the headers `Deprecation` (RFC 9745, e.g.",
    "`Deprecation: @1767225600`, the time it was deprecated as Unix seconds), `Sunset` (RFC 8594, an HTTP date after",
    "which it may stop working) and `Link: <...>; rel=\"deprecation\"` pointing at the explanation. They are best-effort:",
    "while `apiVersion` is `0.x` something may also break without them. Log them so that you notice in time; browser",
    "clients can read them (they are exposed through CORS).",
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
