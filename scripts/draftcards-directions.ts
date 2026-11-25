// draftcards のドラフトの方向（アーキタイプ）。設計とシミュレーターのためのデータで、ルールは参照しない。
// カードに持たせない理由: カードの中身は id ごとに変えられないが、どの札がどの方向かはセットを直すたびに変わる。
// また、配るとクライアントや bot がそれに従うだけになり、ドラフトで相性を見抜く腕の差が消える。
//
// 載せるのは「その方向のために作った札」だけ。費用やリソースの流れで結果として役に立つ札（B を出す場の札が重い O の費用になる、など）は載せない。
// 2 つ以上の方向に載っている札が、方向どうしの "つなぎ"。

export const DIRECTIONS = ["field", "convert", "disrupt", "guard"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const directionCards: Record<Direction, readonly number[]> = {
  // 場を組む: 最初に出す長い S、M1 の S、場の枚数の見返り
  field: [2, 6, 7, 8, 9, 10, 14, 16, 18, 19, 24, 27, 39, 40, 47, 55],
  // 変換: B を使う重い O と、その仕上げの M2
  convert: [29, 30, 31, 32, 33, 34, 35, 36, 37, 38],
  // 妨害: P、隣を減らす S、F
  disrupt: [11, 12, 13, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56],
  // 守り: X と M2
  guard: [9, 10, 23, 38, 40, 54, 57, 58, 59, 60],
};

export const directionsOf = (id: number): Direction[] => DIRECTIONS.filter((d) => directionCards[d].includes(id));

/** 手札（id の並び）のうち、min 枚以上がその方向の札である方向。 */
export const leaning = (ids: readonly number[], min: number): Direction[] =>
  DIRECTIONS.filter((d) => ids.filter((id) => directionCards[d].includes(id)).length >= min);
