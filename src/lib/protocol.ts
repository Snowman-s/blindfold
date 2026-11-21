import { z } from "zod";

/** クライアント → サーバー */
export const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("action"), turn: z.number().int().min(0), action: z.unknown() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export const WS_ERROR_CODES = ["ILLEGAL_ACTION", "NOT_YOUR_TURN", "STALE_TURN", "BAD_REQUEST"] as const;
export type WsErrorCode = (typeof WS_ERROR_CODES)[number];

/** サーバー → クライアント */
export type ServerMessage =
  | {
      type: "state";
      turn: number;
      view: unknown;
      /** 受け取るプレイヤーが今行動できるときだけ付く */
      legal?: unknown[];
      currentPlayers: string[];
      deadline: number | null;
      status: "waiting" | "playing" | "finished";
      players: string[];
    }
  | { type: "error"; code: WsErrorCode; message: string }
  | { type: "end"; winners: string[]; scores?: Record<string, number> }
  | { type: "pong" };

/** REST 側のエラーコードを WS の閉じたコード集合に写す。 */
export function toWsErrorCode(code: string): WsErrorCode {
  if ((WS_ERROR_CODES as readonly string[]).includes(code)) return code as WsErrorCode;
  if (code === "UNAUTHORIZED") return "NOT_YOUR_TURN"; // 観戦者の行動など
  if (code === "NOT_PLAYING") return "ILLEGAL_ACTION";
  return "BAD_REQUEST";
}
