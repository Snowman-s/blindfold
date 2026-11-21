import { z } from "zod";

export const DEFAULT_TURN_TIME_MS = 5 * 60 * 1000;

/** 1手あたりの持ち時間（ミリ秒）。クイックマッチでも使う。 */
export const turnTimeMs = z.number().int().min(1000).max(24 * 60 * 60 * 1000);

/** ルーム作成時のオプション。DO に保存するので、未知のキーは受け付けない（400）。 */
export const roomOptions = z
  .strictObject({
    /** 1手あたりの持ち時間（ミリ秒） */
    turnTimeMs: turnTimeMs.optional(),
    /**
     * 練習相手。true なら開始時に、参加者の後ろの空席（minPlayers まで）をサーバー側の Bot で埋める。
     * 打ち方はゲームごとに決まる（GameDefinition.practiceAction。未定義ならランダム）。練習試合は D1 に記録しない。
     */
    practice: z.boolean().optional(),
    /** true なら参加者が maxPlayers に達した時点で（ホストの start を待たずに）開始する。practice とは併用できない。 */
    autoStart: z.boolean().optional(),
    /** true ならルーム一覧（GET /rooms）とクイックマッチの対象にしない。roomId を知っている人だけが参加できる。 */
    unlisted: z.boolean().optional(),
  })
  .refine((o) => !(o.practice && o.autoStart), {
    message: "practice and autoStart cannot be combined",
    path: ["autoStart"],
  });
export type RoomOptions = z.infer<typeof roomOptions>;

/** 待機中のルームを一覧・クイックマッチに出す期間（最後の更新から）。放置された部屋に人を集めないため。 */
export const WAITING_LIST_TTL_MS = 30 * 60 * 1000;
