import { z } from "zod";

export const DEFAULT_TURN_TIME_MS = 5 * 60 * 1000;

/** ルーム作成時のオプション。DO に保存するので、未知のキーは受け付けない（400）。 */
export const roomOptions = z.strictObject({
  /** 1手あたりの持ち時間（ミリ秒） */
  turnTimeMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
  /**
   * 練習相手。true なら開始時に、参加者の後ろの空席（minPlayers まで）をサーバー側の Bot で埋める。
   * 打ち方はゲームごとに決まる（GameDefinition.practiceAction。未定義ならランダム）。練習試合は D1 に記録しない。
   */
  practice: z.boolean().optional(),
});
export type RoomOptions = z.infer<typeof roomOptions>;
