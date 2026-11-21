import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { errBody, ROOM_STATUSES } from "../lib/protocol";

export { errBody };

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

const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

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
    status: z.enum(ROOM_STATUSES),
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

export const bearerSecurity = [{ bearerAuth: [] }];
