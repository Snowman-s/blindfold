import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { games, getGame } from "../games/registry";
import { extractToken, newRoomId, sha256Hex, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../lib/auth";
import {
  DEFAULT_TURN_TIME_MS,
  gameOptionsKey,
  parseGameOptions,
  roomOptions,
  turnTimeMs,
  WAITING_LIST_TTL_MS,
} from "../lib/options";
import { actionBody, CLOSE_LEFT_ROOM } from "../lib/protocol";
import { gameRules, rulesMarkdown, type GameRules } from "../lib/rules";
import type { RoomResult } from "../room/GameRoom";
import {
  bearerSecurity,
  errBody,
  errors,
  openEnum,
  ResultSchema,
  RoomIdParam,
  RoomStateSchema,
  validationHook,
} from "./schemas";

type AppEnv = { Bindings: Env };

export const routes = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

// トークンを URL に載せるとアクセスログやブラウザ履歴に残るので、?token= は明示的に拒否する
// （黙って無視すると、プレイヤーのつもりのクライアントが観戦者として扱われてしまう）。
routes.use("/rooms/*", async (c, next) => {
  if (new URL(c.req.url).searchParams.has("token")) {
    return c.json(
      errBody(
        "BAD_REQUEST",
        `pass the token in the Authorization header (REST) or as the "${WS_TOKEN_PROTOCOL_PREFIX}<token>" subprotocol (WebSocket), not in the URL`,
      ),
      400,
    );
  }
  await next();
});

/** RoomResult を HTTP レスポンスにする。ルート定義の型とは動的ステータスが合わないので never にキャストする。 */
function respond<T>(c: Context<AppEnv>, r: RoomResult<T>, okStatus: ContentfulStatusCode = 200): never {
  return (r.ok ? c.json(r.data as object, okStatus) : c.json(errBody(r.code, r.message), r.status)) as never;
}

const room = (c: Context<AppEnv>) => c.env.GAME_ROOM.getByName(c.req.param("id") ?? "");

/** X-Api-Key をユーザー ID に解決する。ヘッダーが無ければ null、キーが無効なら undefined。 */
async function resolveUser(c: Context<AppEnv>): Promise<string | null | undefined> {
  const key = c.req.header("x-api-key");
  if (!key) return null;
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE key_hash = ?")
    .bind(await sha256Hex(key))
    .first<{ id: string }>();
  return row?.id;
}

const ApiKeyHeader = z.object({ "x-api-key": z.string().optional() });

const LISTS_LEGAL = z
  .boolean()
  .describe(
    "True if state messages list the legal moves in `legal` when you may act. If false, `legal` is never sent: build the action from actionSchema and the rules (an illegal one is rejected with ILLEGAL_ACTION)",
  );

/** POST /rooms・/quickmatch の gameOptions（中身はゲームごとの optionsSchema で DO / ルートが検証する）。 */
const GAME_OPTIONS_IN = z
  .unknown()
  .optional()
  .describe("Options specific to the game, matching optionsSchema in /games/{id}/rules. Omit for the defaults. Games without options reject any value");

const GameInfo = z
  .object({
    id: z.string(),
    rulesVersion: z.number().int().describe("Version of the game's rules (an integer, bumped whenever a change could make an old log replay differently). Rooms started with an older version fail with GAME_REMOVED"),
    viewVersion: z
      .number()
      .int()
      .describe("Version of the shape of view (an integer, bumped when a view field is removed, renamed, changes type or meaning, or gets a new value in a fixed set; not when a field is added)"),
    minPlayers: z.number().int(),
    maxPlayers: z.number().int(),
    listsLegalActions: LISTS_LEGAL,
    hasOptions: z.boolean().describe("True if the game takes gameOptions (see optionsSchema in its rules)"),
    summary: z.string(),
    rulesUrl: z.string().describe("Rules in JSON. Append .md for the Markdown version"),
  })
  .openapi("GameInfo");

routes.openapi(
  createRoute({
    method: "get",
    path: "/games",
    tags: ["games"],
    operationId: "listGames",
    summary: "List available games",
    responses: { 200: { description: "Games", content: { "application/json": { schema: z.array(GameInfo) } } } },
  }),
  (c) =>
    c.json(
      Object.values(games).map((g) => ({
        id: g.id,
        rulesVersion: g.rulesVersion,
        viewVersion: g.viewVersion,
        minPlayers: g.minPlayers,
        maxPlayers: g.maxPlayers,
        listsLegalActions: g.legalActions !== undefined,
        hasOptions: g.optionsSchema !== undefined,
        summary: g.docs.summary,
        rulesUrl: `/games/${g.id}/rules`,
      })),
      200,
    ),
);

const GameIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "tictactoe" }),
});

const GameRulesSchema = z
  .object({
    id: z.string(),
    version: z
      .string()
      .describe("Hash of the content (also sent as ETag). Changes on any edit, even a typo fix; it is a cache key, not a compatibility signal"),
    apiVersion: z.string().describe("API version (semver), the same as in the guide and the OpenAPI spec"),
    rulesVersion: z.number().int().describe("Version of the game's rules (an integer, bumped whenever a change could make an old log replay differently). Rooms started with an older version fail with GAME_REMOVED"),
    viewVersion: z
      .number()
      .int()
      .describe("Version of the shape of view (an integer, bumped when a view field is removed, renamed, changes type or meaning, or gets a new value in a fixed set; not when a field is added)"),
    minPlayers: z.number().int(),
    maxPlayers: z.number().int(),
    listsLegalActions: LISTS_LEGAL,
    summary: z.string(),
    rules: z.string().describe("Markdown: goal, turns, how the game is decided, timeouts"),
    view: z.string().describe("Markdown: meaning of each field of view, and how it differs by viewer"),
    viewSchema: z
      .unknown()
      .describe("JSON Schema of view (fields that only some viewers receive are optional). Does not forbid extra fields: new ones may be added"),
    actionSchema: z.unknown().describe("JSON Schema of action"),
    optionsSchema: z
      .unknown()
      .describe("JSON Schema of gameOptions (POST /rooms), or null if the game has no options. Unknown keys are rejected"),
    defaultGameOptions: z.unknown().describe("gameOptions used when none are given (null if the game has no options)"),
    options: z.string().nullable().describe("Markdown: meaning of each game option. null if the game has no options"),
    examples: z.array(z.object({ action: z.unknown(), meaning: z.string() })),
    stateExamples: z
      .array(z.object({ title: z.string(), message: z.unknown() }))
      .describe("Example state messages generated from the engine: start, after one action (each viewer), finished"),
    endExample: z.unknown().describe("The end message that follows the finished example"),
    common: z.string().describe("Markdown: how to play, common to all games (turn, legal, errors)"),
  })
  .openapi("GameRules");

/**
 * /rules と /rules.md の共通部分。説明は静的なので長めにキャッシュさせる。
 * version を ETag にして、変わっていなければ 304 を返す。
 */
async function withRules(c: Context<AppEnv>, id: string, render: (r: GameRules) => Response): Promise<Response> {
  const game = getGame(id);
  if (!game) return c.json(errBody("NOT_FOUND", "unknown game"), 404);
  const r = await gameRules(game);
  const etag = `"${r.version}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "public, max-age=3600");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  return render(r);
}

routes.openapi(
  createRoute({
    method: "get",
    path: "/games/{id}/rules",
    tags: ["games"],
    operationId: "getGameRules",
    summary: "Game rules",
    description:
      "Rules, how to read `view`, the JSON Schemas of `view` and `action`, example states, and how to play (common to all games). " +
      "The same content as one Markdown page: `/games/{id}/rules.md`.",
    request: { params: GameIdParam },
    responses: {
      200: { description: "Game rules", content: { "application/json": { schema: GameRulesSchema } } },
      304: { description: "Not modified since the version in If-None-Match" },
      404: errors[404],
    },
  }),
  async (c) => withRules(c, c.req.valid("param").id, (r) => c.json(r, 200)),
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/games/{id}/rules.md",
    tags: ["games"],
    operationId: "getGameRulesMarkdown",
    summary: "Game rules (one Markdown page)",
    request: { params: GameIdParam },
    responses: {
      200: { description: "Markdown", content: { "text/markdown": { schema: z.string() } } },
      304: { description: "Not modified since the version in If-None-Match" },
      404: errors[404],
    },
  }),
  async (c) =>
    withRules(c, c.req.valid("param").id, (r) =>
      c.body(rulesMarkdown(r), 200, { "Content-Type": "text/markdown; charset=utf-8" }),
    ),
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms",
    tags: ["rooms"],
    operationId: "createRoom",
    summary: "Create a room",
    description:
      "`options.turnTimeMs` (1000-86400000) sets the time limit per turn; the default is 5 minutes. By default a player who times out loses. " +
      "With `options.practice: true`, server-side practice bots fill the empty seats (up to minPlayers) when the game starts (how they play depends on the game; practice games are not recorded). " +
      "With `options.autoStart: true`, the game starts as soon as maxPlayers have joined (cannot be combined with practice). " +
      "Rooms are listed in `GET /rooms` by default; pass `options.unlisted: true` to hide a room (practice rooms are never listed). " +
      "Unknown options are rejected with 400. " +
      "`gameOptions` are options specific to the game (see `optionsSchema` in `/games/{id}/rules`; games without options reject them with 400). " +
      "Defaults are filled in and recorded with the room, its log and its match. The returned `hostToken` is needed to start the game (`/rooms/{id}/start`); only the creator has it.",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              game: z.string().openapi({ example: "tictactoe" }),
              options: roomOptions.optional(),
              gameOptions: GAME_OPTIONS_IN,
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: {
          "application/json": {
            schema: z.object({
              roomId: z.string(),
              hostToken: z.string().describe("The creator's token for starting the game. Not a player token"),
            }),
          },
        },
      },
      400: errors[400],
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    if (!getGame(body.game)) return c.json(errBody("UNKNOWN_GAME", `unknown game: ${body.game}`), 400);
    const roomId = newRoomId();
    const r = await c.env.GAME_ROOM.getByName(roomId).init(roomId, body.game, body.options, body.gameOptions);
    return r.ok ? c.json({ roomId, hostToken: r.data.hostToken }, 201) : respond(c, r);
  },
);

const RoomSummary = z
  .object({
    roomId: z.string(),
    game: z.string(),
    gameOptions: z.unknown().describe("Game-specific options of the room (defaults filled in). null for games without options"),
    status: openEnum(["waiting", "playing"], "Same as status in the room state."),
    players: z.number().int().describe("Number of players who have joined"),
    maxPlayers: z.number().int(),
    autoStart: z.boolean().describe("If true, the game starts by itself once the room is full"),
    turnTimeMs: z.number().int(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("RoomSummary");

routes.openapi(
  createRoute({
    method: "get",
    path: "/rooms",
    tags: ["rooms"],
    operationId: "listRooms",
    summary: "List public rooms (waiting or playing)",
    description:
      "`status=waiting` (default): waiting rooms with a free seat, updated within the last 30 minutes. " +
      "`status=playing`: games in progress (for spectating). Finished games are in `/matches`. " +
      "Unlisted and practice rooms are never listed. The list is an index and may lag: if a join fails with `ROOM_FULL` or similar, try the next room.",
    request: {
      query: z.object({
        status: z.enum(["waiting", "playing"]).default("waiting").openapi({ param: { name: "status", in: "query" } }),
        game: z.string().optional().openapi({ param: { name: "game", in: "query" } }),
        limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: {
      200: { description: "Rooms, most recently updated first", content: { "application/json": { schema: z.array(RoomSummary) } } },
      400: errors[400],
    },
  }),
  async (c) => {
    const { status, game, limit } = c.req.valid("query");
    const rows = await c.env.DB.prepare(
      `SELECT id, game, game_options, status, players, max_players, auto_start, turn_time_ms, created_at, updated_at
       FROM rooms
       WHERE status = ?1 AND (?2 IS NULL OR game = ?2)
         AND (?1 <> 'waiting' OR (players < max_players AND updated_at > ?3))
       ORDER BY updated_at DESC, id LIMIT ?4`,
    )
      .bind(status, game ?? null, Date.now() - WAITING_LIST_TTL_MS, limit)
      .all<{
        id: string; game: string; game_options: string; status: "waiting" | "playing"; players: number; max_players: number;
        auto_start: number; turn_time_ms: number; created_at: number; updated_at: number;
      }>();
    return c.json(
      rows.results.map((r) => ({
        roomId: r.id,
        game: r.game,
        gameOptions: JSON.parse(r.game_options) as unknown,
        status: r.status,
        players: r.players,
        maxPlayers: r.max_players,
        autoStart: r.auto_start === 1,
        turnTimeMs: r.turn_time_ms,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      200,
    );
  },
);

/** クイックマッチで試す既存ルームの数（1回の呼び出しで DO を何度も叩かないように）。 */
const QUICKMATCH_CANDIDATES = 5;

routes.openapi(
  createRoute({
    method: "post",
    path: "/quickmatch",
    tags: ["rooms"],
    operationId: "quickMatch",
    summary: "Quick match (join an open room, or create one)",
    description:
      "Joins the oldest public auto-start room of the same game, game options and turn time that has a free seat, or creates such a room (`autoStart: true`) and joins it. " +
      "The game starts by itself once the room is full, so connect the WebSocket with the returned `token` right away and wait (you receive `status: \"waiting\"` states, then `playing`). " +
      "`created` tells whether a new room was created. No `hostToken` is returned (nobody can start early). Send `X-Api-Key` to record the result on your user.",
    request: {
      headers: ApiKeyHeader,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              game: z.string().openapi({ example: "tictactoe" }),
              options: z.strictObject({ turnTimeMs: turnTimeMs.optional() }).optional(),
              gameOptions: GAME_OPTIONS_IN,
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Joined",
        content: {
          "application/json": {
            schema: z.object({
              roomId: z.string(),
              playerId: z.string(),
              token: z.string(),
              created: z.boolean().describe("True if a new room was created (wait for opponents)"),
            }),
          },
        },
      },
      400: errors[400],
      401: errors[401],
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const game = getGame(body.game);
    if (!game) return c.json(errBody("UNKNOWN_GAME", `unknown game: ${body.game}`), 400);
    const userId = await resolveUser(c);
    if (userId === undefined) return c.json(errBody("UNAUTHORIZED", "invalid api key"), 401);
    const time = body.options?.turnTimeMs ?? DEFAULT_TURN_TIME_MS;
    // 既定値を補った値で照合する（省略と、既定値を明示したものは同じルームに入る）
    const gopts = parseGameOptions(game, body.gameOptions);
    if (!gopts.ok) return c.json(errBody("BAD_REQUEST", gopts.message), 400);

    // 古い部屋から埋める（同時に2つ作られても、次に来た人が古い方に入る）
    const candidates = await c.env.DB.prepare(
      `SELECT id FROM rooms
       WHERE status = 'waiting' AND game = ? AND game_options = ? AND auto_start = 1 AND turn_time_ms = ?
         AND players < max_players AND updated_at > ?
       ORDER BY created_at, id LIMIT ?`,
    )
      .bind(game.id, gameOptionsKey(gopts.value), time, Date.now() - WAITING_LIST_TTL_MS, QUICKMATCH_CANDIDATES)
      .all<{ id: string }>();
    for (const { id } of candidates.results) {
      const r = await c.env.GAME_ROOM.getByName(id).join(userId);
      if (r.ok) return c.json({ roomId: id, ...r.data, created: false }, 201);
      // 索引が古い（満席・開始済み・存在しない）ので次の候補へ
    }

    const roomId = newRoomId();
    const stub = c.env.GAME_ROOM.getByName(roomId);
    const init = await stub.init(roomId, game.id, { autoStart: true, turnTimeMs: time }, gopts.value);
    if (!init.ok) return respond(c, init);
    const r = await stub.join(userId);
    return r.ok ? c.json({ roomId, ...r.data, created: true }, 201) : respond(c, r);
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms/{id}/join",
    tags: ["rooms"],
    operationId: "joinRoom",
    summary: "Join a room",
    description:
      "Player IDs are assigned in join order: p1, p2, ... (numbers of seats that were left are not reused). Seat order (= `players`) is the turn order. " +
      "Rematch rooms cannot be joined here (`ROOM_RESERVED` 403; use `POST /rooms/{id}/rematch` on the finished room). Send `X-Api-Key` to record the result on that user.",
    request: {
      params: RoomIdParam,
      headers: ApiKeyHeader,
    },
    responses: {
      201: {
        description: "Joined",
        content: { "application/json": { schema: z.object({ playerId: z.string(), token: z.string() }) } },
      },
      401: errors[401],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => {
    const userId = await resolveUser(c);
    if (userId === undefined) return c.json(errBody("UNAUTHORIZED", "invalid api key"), 401);
    return respond(c, await room(c).join(userId), 201);
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms/{id}/start",
    tags: ["rooms"],
    operationId: "startRoom",
    summary: "Start the game (room creator only)",
    description:
      "Send the `hostToken` from `POST /rooms` as `Authorization: Bearer`. A player token gets 403. Returns the spectator view.",
    security: bearerSecurity,
    request: { params: RoomIdParam },
    responses: {
      200: { description: "Started", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      403: errors[403],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => respond(c, await room(c).start(extractToken(c.req.raw))),
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/rooms/{id}/state",
    tags: ["rooms"],
    operationId: "getState",
    summary: "Get the current state",
    description: "With `Authorization: Bearer <token>`, the view of that player; without it, the spectator view. An invalid token is rejected with 401 (no fallback to the spectator view).",
    security: [...bearerSecurity, {}],
    request: { params: RoomIdParam },
    responses: {
      200: { description: "Current state", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      404: errors[404],
      410: errors[410],
    },
  }),
  async (c) => respond(c, await room(c).getState(extractToken(c.req.raw))),
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms/{id}/action",
    tags: ["rooms"],
    operationId: "postAction",
    summary: "Send an action (for simple bots without WebSocket)",
    description:
      "A secondary option. REST has no way to wait for the other players, so use the WebSocket (`/rooms/{id}/ws`) to play a full game. " +
      "Do not poll `/state` (it uses up the free-tier request budget). " +
      "If `turn` is not the current turn, the action is rejected with `STALE_TURN` (409). " +
      "An action that arrives after the deadline also gets `STALE_TURN`, after the timeout is resolved on the spot.",
    security: bearerSecurity,
    request: {
      params: RoomIdParam,
      body: {
        required: true,
        content: {
          "application/json": { schema: actionBody },
        },
      },
    },
    responses: {
      200: { description: "State after the action", content: { "application/json": { schema: RoomStateSchema } } },
      400: errors[400],
      401: errors[401],
      403: errors[403],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    return respond(c, await room(c).act(extractToken(c.req.raw), body.turn, body.action));
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms/{id}/resign",
    tags: ["rooms"],
    operationId: "resign",
    summary: "Resign",
    description:
      "Allowed at any time while the game is playing, even when it is not your turn. By default the resigning player loses, all other players win, and the game ends immediately (some games define their own handling). " +
      "Over the WebSocket, send `{\"type\":\"resign\"}`. Before the start or after the end: `NOT_PLAYING` (409). It cannot be undone.",
    security: bearerSecurity,
    request: { params: RoomIdParam },
    responses: {
      200: { description: "State after resigning (status is finished, unless the game goes on without you)", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => respond(c, await room(c).resign(extractToken(c.req.raw))),
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms/{id}/leave",
    tags: ["rooms"],
    operationId: "leaveRoom",
    summary: "Leave a waiting room (undo join)",
    description:
      "Only before the game starts (after that: `ALREADY_STARTED` 409; resign instead). Your seat is freed, your token stops working, " +
      `and the server closes your WebSockets to this room with close code ${CLOSE_LEFT_ROOM}. Seat numbers are not reused: the next player to join gets a new ID. ` +
      "Returns the spectator view.",
    security: bearerSecurity,
    request: { params: RoomIdParam },
    responses: {
      200: { description: "Left", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => respond(c, await room(c).leave(extractToken(c.req.raw))),
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/rooms/{id}/rematch",
    tags: ["rooms"],
    operationId: "rematch",
    summary: "Rematch (same players, new room)",
    description:
      "Call it on the finished room with your player token. The first call creates a new room with the same game and options; " +
      "every call seats the caller there and returns the new `roomId`, `playerId` and `token`. Seats are rotated by one " +
      "(in a two-player game, first and second player swap). Only the players of this room can take those seats (others get `ROOM_RESERVED` 403). " +
      "The new game starts by itself once every player has called rematch (practice bots are added again at start). " +
      "Calling again returns the same seat and token. The finished room's `state` gets `rematch: { roomId, requestedBy }`, pushed over the WebSocket, " +
      "so the other players can see the offer (`requestedBy` lists everyone who has asked at least once). " +
      "The others may never answer: if the new room does not start within a time you choose, leave it. To decline after accepting, leave the new room (`POST /rooms/{newId}/leave`). Before the end: `NOT_FINISHED` 403.",
    security: bearerSecurity,
    request: { params: RoomIdParam },
    responses: {
      200: {
        description: "Your seat in the new room",
        content: {
          "application/json": { schema: z.object({ roomId: z.string(), playerId: z.string(), token: z.string() }) },
        },
      },
      401: errors[401],
      403: errors[403],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => respond(c, await room(c).rematch(extractToken(c.req.raw))),
);

export const LogEntrySchema = z
  .object({
    turn: z.number().int().describe("The turn this entry was applied at (0, 1, 2, ...). Applying it produced turn + 1"),
    player: z.string().nullable().describe("Who acted. null for a timeout or resignation entry (written by the server)"),
    action: z.unknown().describe("The action as sent (an element of legal). null for a timeout or resignation entry"),
    at: z.number().describe("When it was applied (epoch ms, server clock)"),
    timeout: z.array(z.string()).optional().describe("Present only on a timeout entry: the players who ran out of time"),
    resign: z.string().optional().describe("Present only on a resignation entry: the player who resigned"),
  })
  .openapi("LogEntry");

export const LogSchema = z
  .object({
    game: z.string(),
    rulesVersion: z
      .number()
      .int()
      .describe("Rules version the game was played with. If it differs from rulesVersion in /games/{id}/rules, the rules changed later and /replay is no longer available for this game"),
    seed: z.string().describe("Initial seed (128 bits, 32 hex characters)"),
    gameOptions: z.unknown().describe("Game-specific options the game was played with (defaults filled in). null for games without options"),
    players: z.array(z.string()),
    actions: z.array(LogEntrySchema).describe("Every entry in turn order; actions[i].turn === i"),
  })
  .openapi("ReplayLog");

export const ReplaySchema = z
  .object({
    game: z.string(),
    rulesVersion: z.number().int().describe("Rules version the game was played with (always the current one; older games fail with GAME_REMOVED)"),
    seed: z.string(),
    gameOptions: z.unknown(),
    players: z.array(z.string()),
    frames: z
      .array(
        z.object({
          turn: z.number().int(),
          view: z.unknown().describe("Spectator view at this turn"),
          action: LogEntrySchema.nullable().describe(
            "The log entry that produced this frame (= actions[turn - 1] of /log). null for the first frame (turn 0)",
          ),
        }),
      )
      .describe("frames[i].turn === i. The first frame is the initial position, the last one the final position"),
    result: ResultSchema.nullable(),
  })
  .openapi("Replay");

routes.openapi(
  createRoute({
    method: "get",
    path: "/rooms/{id}/log",
    tags: ["rooms"],
    operationId: "getLog",
    summary: "Action log (for replays)",
    description: "Available only after the game has ended, so that the seed cannot reveal hidden information. `seed` + `gameOptions` + `actions` reproduce the game exactly.",
    request: { params: RoomIdParam },
    responses: {
      200: { description: "Action log", content: { "application/json": { schema: LogSchema } } },
      403: errors[403],
      404: errors[404],
    },
  }),
  async (c) => respond(c, await room(c).getLog()),
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/rooms/{id}/replay",
    tags: ["rooms"],
    operationId: "getReplay",
    summary: "Spectator view for every turn, reproduced from the log",
    description:
      "Available only after the game has ended. Fails with `GAME_REMOVED` (410) if the game's rules have changed since it was played " +
      "(its `rulesVersion` is older than the current one), because the server keeps only the current rules; `/rooms/{id}/log` still returns the log.",
    request: { params: RoomIdParam },
    responses: {
      200: {
        description: "Replay",
        content: {
          "application/json": { schema: ReplaySchema },
        },
      },
      403: errors[403],
      404: errors[404],
      410: errors[410],
      409: errors[409],
    },
  }),
  async (c) => respond(c, await room(c).getReplay()),
);

// WebSocket。Hono の openapi() の型に乗らないので、ドキュメントだけ登録して通常ルートで処理する。
routes.openAPIRegistry.registerPath({
  method: "get",
  path: "/rooms/{id}/ws",
  tags: ["rooms"],
  operationId: "connectWebSocket",
  summary: "Upgrade to WebSocket",
  description:
    `To connect as a player, pass the subprotocols \`["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}<token>"]\`` +
    ` (e.g. \`new WebSocket(url, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token])\`). ` +
    `The server answers with the \`${WS_PROTOCOL}\` subprotocol. Clients that can set headers may send \`Authorization: Bearer\` instead of the token subprotocol. ` +
    `The \`${WS_PROTOCOL}\` subprotocol (the version of the WebSocket messages) is required, also for spectators and with Bearer. ` +
    "Without a token you are a spectator. `?token=` is rejected with 400.\n\n" +
    "Server -> client: `state` / `error` / `end` / `pong`. " +
    'Client -> server: `{"type":"action","turn":N,"action":{...}}`, `{"type":"resign"}` and `{"type":"ping"}`.',
  request: { params: RoomIdParam },
  responses: {
    101: { description: "Switching Protocols" },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    410: errors[410],
    426: errors[426],
  },
});

routes.get("/rooms/:id/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json(errBody("UPGRADE_REQUIRED", "expected WebSocket upgrade"), 426);
  }
  return await room(c).fetch(c.req.raw);
});
