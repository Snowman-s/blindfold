import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ROOM_ID_RE } from "../lib/auth";
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
  404: errorResponse("Not found (ROOM_NOT_FOUND: unknown, deleted or malformed room ID; NOT_FOUND)"),
  409: errorResponse("Not possible in the current state (ALREADY_STARTED, ROOM_FULL, ALREADY_JOINED, NOT_ENOUGH_PLAYERS, NOT_PLAYING, STALE_TURN)"),
  410: errorResponse("The game this room was created with, or the rules version it was started with, is no longer available on this server (GAME_REMOVED)"),
  426: errorResponse("A WebSocket upgrade is required (UPGRADE_REQUIRED)"),
  429: errorResponse(
    "Too many requests from your IP address (RATE_LIMITED). Wait for the number of seconds in the Retry-After header before retrying",
  ),
  503: errorResponse("The room already has the most spectator WebSockets it accepts (TOO_MANY_CONNECTIONS)"),
} as const;

/**
 * 出力の enum。互換性方針で値は増えうるので、JSON Schema では閉じた enum にせず string にし、今ある値は説明に書く
 * （型生成したクライアントが新しい値で落ちないように）。入力の enum は z.enum のままにする。
 */
export const openEnum = (values: readonly string[], description: string) =>
  z
    .string()
    .describe(`${description} Currently one of ${values.map((v) => `\`${v}\``).join(", ")}; more values may be added.`);

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
      .describe("Rules version of this room, recorded when the room was created. If the game's rulesVersion goes up, the room fails with GAME_REMOVED"),
    gameOptions: z
      .unknown()
      .describe("Game-specific options of this room (defaults filled in; see optionsSchema in /games/{id}/rules). null for games without options"),
    status: openEnum(ROOM_STATUSES, "Room lifecycle. Treat an unknown value as neither waiting nor finished: keep listening for the next state."),
    turn: z.number().int().describe("Number of actions applied so far. Send this value with your action"),
    players: z.array(z.string()),
    currentPlayers: z.array(z.string()),
    view: z.unknown().describe("Game-specific board as seen by the caller (hidden information removed). Its JSON Schema is viewSchema in /games/{id}/rules. null while waiting"),
    legal: z
      .array(z.unknown())
      .optional()
      .describe("Present only if the caller may act now and the game lists legal moves (listsLegalActions in /games). Whether you may act is decided by currentPlayers, not by legal"),
    deadline: z.number().nullable().describe("Deadline of the current turn (epoch ms, server clock). null unless playing"),
    phaseTurn: z
      .number()
      .int()
      .nullable()
      .describe(
        "The turn at which the current turn began. On a simultaneous turn, turn goes up each time someone acts but phaseTurn stays the same; " +
          "otherwise it equals turn. If you sent an action with a turn >= phaseTurn and you are still in currentPlayers, this state was built " +
          "before your action was processed: wait for the next state instead of acting again. null unless playing",
      ),
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
  id: z
    .string()
    .regex(ROOM_ID_RE)
    .describe("Room ID (12 lowercase hex characters). Any other value gets ROOM_NOT_FOUND (404)")
    .openapi({ param: { name: "id", in: "path" }, example: "a1b2c3d4e5f6" }),
});

export const bearerSecurity = [{ bearerAuth: [] }];
