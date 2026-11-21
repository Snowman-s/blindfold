import { z } from "zod";

export const DEFAULT_TURN_TIME_MS = 5 * 60 * 1000;

/** ルーム作成時のオプション。DO に保存するので、未知のキーは受け付けない（400）。 */
export const roomOptions = z.strictObject({
  /** 1手あたりの持ち時間（ミリ秒） */
  turnTimeMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
});
export type RoomOptions = z.infer<typeof roomOptions>;
