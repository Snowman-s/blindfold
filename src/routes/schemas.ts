import { z } from "@hono/zod-openapi";

export const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

export const errBody = (code: string, message: string) => ({ error: { code, message } });

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

export const errors = {
  400: errorResponse("不正なリクエスト"),
  401: errorResponse("トークンが無効"),
  403: errorResponse("権限がない／まだ公開できない"),
  404: errorResponse("ルームが存在しない"),
  409: errorResponse("現在の状態では実行できない（STALE_TURN など）"),
  426: errorResponse("WebSocket へのアップグレードが必要（UPGRADE_REQUIRED）"),
} as const;

export const ResultSchema = z
  .object({
    winners: z.array(z.string()),
    scores: z.record(z.string(), z.number()).optional(),
  })
  .openapi("GameResult");

export const RoomStateSchema = z
  .object({
    game: z.string(),
    status: z.enum(["waiting", "playing", "finished"]),
    turn: z.number().int().describe("適用済みの行動数。行動にはこの値を付けて送る"),
    players: z.array(z.string()),
    currentPlayers: z.array(z.string()),
    view: z.unknown().describe("ゲームごとの視点付き盤面（隠し情報は除去済み）"),
    legal: z.array(z.unknown()).optional().describe("呼び出したプレイヤーが今行動できるときだけ付く"),
    deadline: z.number().nullable().describe("現在の手番の締め切り（epoch ms）"),
    result: ResultSchema.nullable(),
  })
  .openapi("RoomState");

export const RoomIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "a1b2c3d4e5f6" }),
});

export const TokenQuery = z.object({
  token: z.string().optional().openapi({ param: { name: "token", in: "query" } }),
});

export const bearerSecurity = [{ bearerAuth: [] }];
