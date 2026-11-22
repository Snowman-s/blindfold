import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { games, getGame } from "../games/registry";
import { extractToken, newRoomId, sha256Hex, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../lib/auth";
import { DEFAULT_TURN_TIME_MS, roomOptions, turnTimeMs, WAITING_LIST_TTL_MS } from "../lib/options";
import { actionBody } from "../lib/protocol";
import { gameRules, rulesMarkdown, type GameRules } from "../lib/rules";
import type { RoomResult } from "../room/GameRoom";
import {
  bearerSecurity,
  errBody,
  errors,
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

const GameInfo = z
  .object({
    id: z.string(),
    minPlayers: z.number().int(),
    maxPlayers: z.number().int(),
    summary: z.string(),
    rulesUrl: z.string().describe("ルールの詳細（JSON）。Markdown は末尾に .md を付ける"),
  })
  .openapi("GameInfo");

routes.openapi(
  createRoute({
    method: "get",
    path: "/games",
    tags: ["games"],
    operationId: "listGames",
    summary: "利用できるゲームの一覧",
    responses: { 200: { description: "ゲーム一覧", content: { "application/json": { schema: z.array(GameInfo) } } } },
  }),
  (c) =>
    c.json(
      Object.values(games).map((g) => ({
        id: g.id,
        minPlayers: g.minPlayers,
        maxPlayers: g.maxPlayers,
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
    version: z.string().describe("説明の内容のハッシュ。キャッシュした説明が古いか判定できる"),
    minPlayers: z.number().int(),
    maxPlayers: z.number().int(),
    summary: z.string(),
    rules: z.string().describe("Markdown。目的・手番・勝敗・時間切れ"),
    view: z.string().describe("Markdown。view の各フィールドの意味"),
    actionSchema: z.unknown().describe("action の JSON Schema"),
    examples: z.array(z.object({ action: z.unknown(), meaning: z.string() })),
    common: z.string().describe("Markdown。全ゲーム共通の遊び方（turn・legal・エラー）"),
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
    summary: "ゲームの説明（LLM 向け）",
    description:
      "ルール・view の読み方・行動の JSON Schema・全ゲーム共通の遊び方を返す。Bot 上の LLM のプロンプトに入れることを想定。" +
      "プロンプトにそのまま貼れる Markdown 版は `/games/{id}/rules.md`。",
    request: { params: GameIdParam },
    responses: {
      200: { description: "ゲームの説明", content: { "application/json": { schema: GameRulesSchema } } },
      304: { description: "If-None-Match の version から変わっていない" },
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
    summary: "ゲームの説明（Markdown 1枚）",
    request: { params: GameIdParam },
    responses: {
      200: { description: "Markdown", content: { "text/markdown": { schema: z.string() } } },
      304: { description: "If-None-Match の version から変わっていない" },
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
    summary: "ルーム作成",
    description:
      "`options.turnTimeMs`（1000〜86400000）で1手の持ち時間を指定できる。省略時は5分。時間切れは負け扱い。" +
      "`options.practice: true` を付けると、開始時に空席（minPlayers まで）をサーバー側の練習相手が埋める（打ち方はゲームごと。戦績には残らない）。" +
      "`options.autoStart: true` なら満席（maxPlayers）になった時点で自動で開始する（practice とは併用不可）。" +
      "ルームは既定で一覧（`GET /rooms`）に載る。載せたくなければ `options.unlisted: true`（練習ルームは常に載らない）。" +
      "未知のオプションは 400。返ってくる `hostToken` は試合開始（`/rooms/{id}/start`）に必要で、作成者だけが持つ。",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ game: z.string().openapi({ example: "tictactoe" }), options: roomOptions.optional() }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "作成済み",
        content: {
          "application/json": {
            schema: z.object({
              roomId: z.string(),
              hostToken: z.string().describe("試合開始に使う作成者用トークン。プレイヤートークンとは別"),
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
    const r = await c.env.GAME_ROOM.getByName(roomId).init(roomId, body.game, body.options);
    return r.ok ? c.json({ roomId, hostToken: r.data.hostToken }, 201) : respond(c, r);
  },
);

const RoomSummary = z
  .object({
    roomId: z.string(),
    game: z.string(),
    status: z.enum(["waiting", "playing"]),
    players: z.number().int().describe("参加人数"),
    maxPlayers: z.number().int(),
    autoStart: z.boolean().describe("true なら満席になった時点で自動で始まる"),
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
    summary: "公開ルームの一覧（待機中・進行中）",
    description:
      "`status=waiting`（既定）は空席がある待機中のルーム。最後の更新から30分を過ぎたものは出さない。" +
      "`status=playing` は進行中のルーム（観戦用）。終了した試合は `/matches`。" +
      "`options.unlisted` と練習ルームは載らない。一覧は索引なので古いことがある（join が `ROOM_FULL` などで失敗したら次を試す）。",
    request: {
      query: z.object({
        status: z.enum(["waiting", "playing"]).default("waiting").openapi({ param: { name: "status", in: "query" } }),
        game: z.string().optional().openapi({ param: { name: "game", in: "query" } }),
        limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: {
      200: { description: "ルーム一覧（新しく更新された順）", content: { "application/json": { schema: z.array(RoomSummary) } } },
      400: errors[400],
    },
  }),
  async (c) => {
    const { status, game, limit } = c.req.valid("query");
    const rows = await c.env.DB.prepare(
      `SELECT id, game, status, players, max_players, auto_start, turn_time_ms, created_at, updated_at
       FROM rooms
       WHERE status = ?1 AND (?2 IS NULL OR game = ?2)
         AND (?1 <> 'waiting' OR (players < max_players AND updated_at > ?3))
       ORDER BY updated_at DESC, id LIMIT ?4`,
    )
      .bind(status, game ?? null, Date.now() - WAITING_LIST_TTL_MS, limit)
      .all<{
        id: string; game: string; status: "waiting" | "playing"; players: number; max_players: number;
        auto_start: number; turn_time_ms: number; created_at: number; updated_at: number;
      }>();
    return c.json(
      rows.results.map((r) => ({
        roomId: r.id,
        game: r.game,
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
    summary: "クイックマッチ（空いている部屋に入る。無ければ作る）",
    description:
      "同じゲーム・同じ持ち時間の、自動開始（`autoStart`）の公開ルームに空席があれば参加し、無ければ `autoStart: true` のルームを作って参加する。" +
      "満席になった時点で自動で始まるので、返ってきた `token` ですぐ WebSocket に接続して待てばよい（`status: \"waiting\"` の state が届き、揃うと `playing` になる）。" +
      "`created` は新しくルームを作ったかどうか。`hostToken` は返さない（誰も早めに開始できない）。`X-Api-Key` を付けると戦績が紐づく。",
    request: {
      headers: ApiKeyHeader,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              game: z.string().openapi({ example: "tictactoe" }),
              options: z.strictObject({ turnTimeMs: turnTimeMs.optional() }).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "参加済み",
        content: {
          "application/json": {
            schema: z.object({
              roomId: z.string(),
              playerId: z.string(),
              token: z.string(),
              created: z.boolean().describe("true なら新しく作ったルーム（相手が来るまで待つ）"),
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

    // 古い部屋から埋める（同時に2つ作られても、次に来た人が古い方に入る）
    const candidates = await c.env.DB.prepare(
      `SELECT id FROM rooms
       WHERE status = 'waiting' AND game = ? AND auto_start = 1 AND turn_time_ms = ?
         AND players < max_players AND updated_at > ?
       ORDER BY created_at, id LIMIT ?`,
    )
      .bind(game.id, time, Date.now() - WAITING_LIST_TTL_MS, QUICKMATCH_CANDIDATES)
      .all<{ id: string }>();
    for (const { id } of candidates.results) {
      const r = await c.env.GAME_ROOM.getByName(id).join(userId);
      if (r.ok) return c.json({ roomId: id, ...r.data, created: false }, 201);
      // 索引が古い（満席・開始済み・存在しない）ので次の候補へ
    }

    const roomId = newRoomId();
    const stub = c.env.GAME_ROOM.getByName(roomId);
    const init = await stub.init(roomId, game.id, { autoStart: true, turnTimeMs: time });
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
    summary: "ルームに参加",
    description: "プレイヤー ID は参加順に p1, p2, ...。`X-Api-Key` を付けると戦績がそのユーザーに紐づく。",
    request: {
      params: RoomIdParam,
      headers: ApiKeyHeader,
    },
    responses: {
      201: {
        description: "参加済み",
        content: { "application/json": { schema: z.object({ playerId: z.string(), token: z.string() }) } },
      },
      401: errors[401],
      404: errors[404],
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
    summary: "試合開始（作成者のみ）",
    description:
      "`POST /rooms` で受け取った `hostToken` を `Authorization: Bearer` で渡す。プレイヤートークンでは 403。返すのは観戦視点。",
    security: bearerSecurity,
    request: { params: RoomIdParam },
    responses: {
      200: { description: "開始済み", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      403: errors[403],
      404: errors[404],
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
    summary: "状態取得",
    description: "`Authorization: Bearer <token>` があればそのプレイヤー視点、なければ観戦視点。",
    security: [...bearerSecurity, {}],
    request: { params: RoomIdParam },
    responses: {
      200: { description: "現在の状態", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      404: errors[404],
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
    summary: "行動を送る（WS を使わない簡易 Bot 向け）",
    description:
      "補助的な手段。REST には相手の手番が終わるのを待つ仕組みがないので、1試合を通して遊ぶなら WebSocket（`/rooms/{id}/ws`）を使う。" +
      "`/state` のポーリングは前提にしない（無料枠のリクエスト数を消費する）。" +
      "`turn` が現在のターンと一致しなければ `STALE_TURN`（409）。" +
      "持ち時間を過ぎてから届いた行動も、その場で時間切れを確定させたうえで `STALE_TURN` になる。",
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
      200: { description: "行動後の状態", content: { "application/json": { schema: RoomStateSchema } } },
      400: errors[400],
      401: errors[401],
      403: errors[403],
      404: errors[404],
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
    summary: "投了（降参）",
    description:
      "試合中ならいつでも（自分の手番でなくても）投了できる。投了したプレイヤーの負けで、残りのプレイヤー全員が勝者になり、試合はその場で終わる。" +
      "WebSocket では `{\"type\":\"resign\"}` を送る。待機中・終了後は `NOT_PLAYING`（409）。取り消しはできない。",
    security: bearerSecurity,
    request: { params: RoomIdParam },
    responses: {
      200: { description: "投了後の状態（status は finished）", content: { "application/json": { schema: RoomStateSchema } } },
      401: errors[401],
      404: errors[404],
      409: errors[409],
    },
  }),
  async (c) => respond(c, await room(c).resign(extractToken(c.req.raw))),
);

const LogSchema = z
  .object({
    game: z.string(),
    seed: z.string().describe("初期シード（128 ビット、16 進 32 文字）"),
    players: z.array(z.string()),
    actions: z.array(
      z.object({
        turn: z.number().int(),
        player: z.string().nullable(),
        action: z.unknown(),
        at: z.number(),
        timeout: z.array(z.string()).optional().describe("持ち時間切れになったプレイヤー（あれば player / action は null）"),
        resign: z.string().optional().describe("投了したプレイヤー（あれば player / action は null）"),
      }),
    ),
  })
  .openapi("ReplayLog");

routes.openapi(
  createRoute({
    method: "get",
    path: "/rooms/{id}/log",
    tags: ["rooms"],
    operationId: "getLog",
    summary: "行動ログ（リプレイ用）",
    description: "シードから隠し情報が分からないよう、試合終了後のみ取得できる。`seed` + `actions` から試合を完全に再現できる。",
    request: { params: RoomIdParam },
    responses: {
      200: { description: "行動ログ", content: { "application/json": { schema: LogSchema } } },
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
    summary: "ログから再現した各ターンの観戦視点",
    request: { params: RoomIdParam },
    responses: {
      200: {
        description: "リプレイ",
        content: {
          "application/json": {
            schema: z.object({
              game: z.string(),
              seed: z.string(),
              players: z.array(z.string()),
              frames: z.array(z.object({ turn: z.number().int(), view: z.unknown(), action: z.unknown() })),
              result: ResultSchema.nullable(),
            }),
          },
        },
      },
      403: errors[403],
      404: errors[404],
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
  summary: "WebSocket へアップグレード",
  description:
    `プレイヤーとして接続するときは、サブプロトコルで \`["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}<token>"]\` を渡す` +
    `（例: \`new WebSocket(url, ["${WS_PROTOCOL}", "${WS_TOKEN_PROTOCOL_PREFIX}" + token])\`）。` +
    `サーバーは \`${WS_PROTOCOL}\` を選んで応答する。ヘッダーを付けられるクライアントは \`Authorization: Bearer\` でもよい。` +
    "トークンが無ければ観戦。`?token=` は 400。\n\n" +
    "サーバー → クライアントは `state` / `error` / `end` / `pong`、" +
    'クライアント → サーバーは `{"type":"action","turn":N,"action":{...}}`、`{"type":"resign"}`（投了）と `{"type":"ping"}`。',
  request: { params: RoomIdParam },
  responses: {
    101: { description: "Switching Protocols" },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    426: errors[426],
  },
});

routes.get("/rooms/:id/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json(errBody("UPGRADE_REQUIRED", "expected WebSocket upgrade"), 426);
  }
  return await room(c).fetch(c.req.raw);
});
