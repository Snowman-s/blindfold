import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { games, getGame } from "../games/registry";
import { extractToken, newRoomId, sha256Hex, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from "../lib/auth";
import { roomOptions } from "../lib/options";
import type { RoomResult } from "../room/GameRoom";
import { bearerSecurity, errBody, errors, ResultSchema, RoomIdParam, RoomStateSchema } from "./schemas";

type AppEnv = { Bindings: Env };

/** バリデーション失敗を { error: { code, message } } に揃える。 */
export const validationHook = (
  result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
  c: Context,
) => {
  if (!result.success) {
    const i = result.error?.issues[0];
    const where = i ? `${i.path.join(".") || "(root)"}: ${i.message}` : "invalid request";
    return c.json(errBody("BAD_REQUEST", where), 400);
  }
};

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

const GameInfo = z
  .object({ id: z.string(), minPlayers: z.number().int(), maxPlayers: z.number().int() })
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
  (c) => c.json(Object.values(games).map((g) => ({ id: g.id, minPlayers: g.minPlayers, maxPlayers: g.maxPlayers })), 200),
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
      headers: z.object({ "x-api-key": z.string().optional() }),
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
    let userId: string | null = null;
    const key = c.req.header("x-api-key");
    if (key) {
      const row = await c.env.DB.prepare("SELECT id FROM users WHERE key_hash = ?")
        .bind(await sha256Hex(key))
        .first<{ id: string }>();
      if (!row) return c.json(errBody("UNAUTHORIZED", "invalid api key"), 401);
      userId = row.id;
    }
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
      "`turn` が現在のターンと一致しなければ `STALE_TURN`（409）。" +
      "持ち時間を過ぎてから届いた行動も、その場で時間切れを確定させたうえで `STALE_TURN` になる。",
    security: bearerSecurity,
    request: {
      params: RoomIdParam,
      body: {
        required: true,
        content: {
          "application/json": { schema: z.object({ turn: z.number().int().min(0), action: z.unknown() }) },
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
    'クライアント → サーバーは `{"type":"action","turn":N,"action":{...}}` と `{"type":"ping"}`。',
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
