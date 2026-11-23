/** draftcards の数値。docs はここから文面を組み立てる（数値を変えても説明がずれないように）。 */

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
/** パック 1 つの枚数。ドラフト後の手札の枚数でもある。 */
export const PACK_SIZE = 7;
/** プレイのラウンド数。手札より 1 少ないので、1 枚は使わずに終わる。 */
export const ROUNDS = 6;
/** 場に置ける札の上限。超えたらいちばん古い札が去る。 */
export const FIELD_LIMIT = 3;
export const START = { A: 3, B: 2, C: 0 } as const;
/** ラウンドの初めに全員の B が増える量。 */
export const ROUND_B = 1;
/** 札を捨てたときに B が増える量。 */
export const DISCARD_B = 2;
