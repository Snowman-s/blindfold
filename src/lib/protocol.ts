import { z } from "zod";

export const ROOM_STATUSES = ["waiting", "playing", "finished"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** 行動の本体（WS の action メッセージと REST の POST /rooms/:id/action で共有）。 */
export const actionBody = z.object({ turn: z.number().int().min(0), action: z.unknown() });

/** クライアント → サーバー */
export const clientMessage = z.discriminatedUnion("type", [
  actionBody.extend({ type: z.literal("action") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("resign") }),
]);

/** 試合が終わった理由。normal = ゲームのルールによる決着。 */
export const END_REASONS = ["normal", "timeout", "resign"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** REST / DO 共通のエラーレスポンスの本体。 */
export const errBody = (code: string, message: string) => ({ error: { code, message } });

export const WS_ERROR_CODES = ["ILLEGAL_ACTION", "NOT_YOUR_TURN", "STALE_TURN", "BAD_REQUEST", "INTERNAL"] as const;
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
      status: RoomStatus;
      players: string[];
    }
  | { type: "error"; code: WsErrorCode; message: string }
  | { type: "end"; winners: string[]; scores?: Record<string, number>; reason: EndReason }
  | { type: "pong" };

/** REST 側のエラーコードを WS の閉じたコード集合に写す（対応はガイドの 1.6 にも書いてある）。 */
export function toWsErrorCode(code: string): WsErrorCode {
  if ((WS_ERROR_CODES as readonly string[]).includes(code)) return code as WsErrorCode;
  if (code === "UNAUTHORIZED") return "NOT_YOUR_TURN"; // 観戦者の行動など
  if (code === "NOT_PLAYING") return "ILLEGAL_ACTION";
  return "BAD_REQUEST";
}
