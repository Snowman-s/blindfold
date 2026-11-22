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
  400: errorResponse("Bad request (BAD_REQUEST, UNKNOWN_GAME, ILLEGAL_ACTION)"),
  401: errorResponse("Invalid token or API key (UNAUTHORIZED)"),
  403: errorResponse("Not allowed, or not available yet (NOT_HOST, NOT_YOUR_TURN, NOT_FINISHED, ROOM_RESERVED)"),
  404: errorResponse("Not found (ROOM_NOT_FOUND, NOT_FOUND)"),
  409: errorResponse("Not possible in the current state (ALREADY_STARTED, ROOM_FULL, NOT_ENOUGH_PLAYERS, NOT_PLAYING, STALE_TURN, RULES_CHANGED)"),
  426: errorResponse("A WebSocket upgrade is required (UPGRADE_REQUIRED)"),
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
    rulesVersion: z
      .number()
      .int()
      .nullable()
      .describe("Rules version this game is played with (recorded at start). null while waiting"),
    status: z.enum(ROOM_STATUSES),
    turn: z.number().int().describe("Number of actions applied so far. Send this value with your action"),
    players: z.array(z.string()),
    currentPlayers: z.array(z.string()),
    view: z.unknown().describe("Game-specific board as seen by the caller (hidden information removed). Its JSON Schema is viewSchema in /games/{id}/rules. null while waiting"),
    legal: z.array(z.unknown()).optional().describe("Present only if the caller may act now"),
    deadline: z.number().nullable().describe("Deadline of the current turn (epoch ms, server clock). null unless playing"),
    now: z.number().describe("Server clock (epoch ms) when this response was built. Time left = deadline - now (do not use the client's clock)"),
    result: ResultSchema.nullable(),
    rematch: z
      .object({
        roomId: z.string().describe("The new room. Call POST /rooms/{id}/rematch on this (finished) room to take your seat there"),
        requestedBy: z.array(z.string()).describe("Players of this room who have asked for the rematch"),
      })
      .optional()
      .describe("Present only after the game has finished and someone asked for a rematch"),
  })
  .openapi("RoomState");

export const RoomIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "a1b2c3d4e5f6" }),
});

export const bearerSecurity = [{ bearerAuth: [] }];
