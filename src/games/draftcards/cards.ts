import type { Card } from "./catalog";

/**
 * draftcards のカード一覧（catalog）。doc/draftcards-set-design.md 3 節のスケルトンから作った。
 * id は役割ごとにまとめてある: 1〜20 場に残る札（S）、21〜40 一度きりの札（O）、41〜50 隣の人を選ぶ札（P）、
 * 51〜56 隣の場の札を選ぶ札（F）、57〜60 cancel の札（X）。コメントの S01 などはスケルトンのコード。
 * order の帯: X 1〜9、P・F 10〜49、S 50〜99、O 100〜149。
 */
export const cards: Card[] = [
  // ---- S: 場に残る札（order 50〜99。C は払わせない）
  /* S01 */ { id: 1, order: 52, cost: {}, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "self", res: "A", n: 1 }] } },
  /* S02 */ { id: 2, order: 60, cost: { B: 2 }, chooses: "none", now: [], stay: { times: 4, each: [{ op: "add", who: "self", res: "B", n: 1 }] } },
  /* S03 */ { id: 3, order: 64, cost: { B: 1 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "self", res: "A", n: 2 }] } },
  /* S04 */ { id: 4, order: 68, cost: { A: 1, B: 1 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "self", res: "C", n: 1 }, { op: "add", who: "self", res: "B", n: 1 }] } },
  /* S05 */ { id: 5, order: 56, cost: {}, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "self", res: "C", n: 1 }] } },
  // M1: 場の枚数を掛ける（自分も数える）
  /* S06 */ { id: 6, order: 72, cost: { B: 2 }, chooses: "none", now: [], stay: { times: 4, each: [{ op: "add", who: "self", res: "A", n: 1, per: "field" }] } },
  /* S07 */ { id: 7, order: 76, cost: { A: 1, B: 2 }, chooses: "none", now: [], stay: { times: 4, each: [{ op: "add", who: "self", res: "C", n: 1, per: "field" }] } },
  /* S08 */ { id: 8, order: 54, cost: { B: 3 }, chooses: "none", now: [], stay: { times: 3, each: [{ op: "add", who: "self", res: "B", n: 1, per: "field" }] } },
  /* S09 */ { id: 9, order: 96, cost: { A: 1, B: 3 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "self", res: "least", n: 1, per: "field" }] } },
  // M2: 一番少ないリソース
  /* S10 */ { id: 10, order: 92, cost: { B: 3 }, chooses: "none", now: [{ op: "add", who: "self", res: "B", n: 1 }], stay: { times: 3, each: [{ op: "add", who: "self", res: "least", n: 1 }] } },
  // 隣・ほかの人を減らす
  /* S11 */ { id: 11, order: 58, cost: { A: 1 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "sub", who: "neighbors", res: "C", n: 1 }, { op: "add", who: "self", res: "B", n: 1 }] } },
  /* S12 */ { id: 12, order: 62, cost: { A: 1 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "sub", who: "neighbors", res: "B", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }] } },
  /* S13 */ { id: 13, order: 66, cost: { B: 1 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "sub", who: "neighbors", res: "A", n: 1 }, { op: "add", who: "self", res: "B", n: 1 }] } },
  // ほかの人も得る
  /* S14 */ { id: 14, order: 70, cost: { B: 2 }, chooses: "none", now: [], stay: { times: 4, each: [{ op: "add", who: "self", res: "C", n: 1 }] } },
  /* S15 */ { id: 15, order: 74, cost: {}, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "all", res: "C", n: 1 }, { op: "add", who: "self", res: "A", n: 1 }] } },
  // 重い札・長い札・短い札
  /* S16 */ { id: 16, order: 84, cost: { A: 1, B: 3 }, chooses: "none", now: [], stay: { times: 4, each: [{ op: "add", who: "self", res: "A", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }] } },
  /* S17 */ { id: 17, order: 88, cost: { A: 1, B: 1 }, chooses: "none", now: [], stay: { times: 2, each: [{ op: "add", who: "self", res: "C", n: 2 }] } },
  /* S18 */ { id: 18, order: 98, cost: { A: 2, B: 4 }, chooses: "none", now: [], stay: { times: 3, each: [{ op: "add", who: "self", res: "A", n: 1, per: "field" }, { op: "add", who: "self", res: "C", n: 1, per: "field" }] } },
  /* S19 */ { id: 19, order: 80, cost: { B: 2 }, chooses: "none", now: [], stay: { times: 5, each: [{ op: "add", who: "self", res: "A", n: 1 }] } },
  /* S20 */ { id: 20, order: 78, cost: {}, chooses: "none", now: [], stay: { times: 1, each: [{ op: "add", who: "self", res: "C", n: 1 }, { op: "add", who: "self", res: "B", n: 1 }] } },

  // ---- O: 一度きりの札（order 100〜149）
  /* O01 */ { id: 21, order: 102, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 2 }], stay: null },
  /* O02 */ { id: 22, order: 104, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "B", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
  /* O03 */ { id: 23, order: 140, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "least", n: 1 }], stay: null },
  /* O04 */ { id: 24, order: 120, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "C", n: 1, per: "field" }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },
  /* O05 */ { id: 25, order: 106, cost: {}, chooses: "none", now: [{ op: "add", who: "all", res: "A", n: 1 }, { op: "add", who: "self", res: "C", n: 2 }], stay: null },
  /* O06 */ { id: 26, order: 108, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
  /* O07 */ { id: 27, order: 122, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "C", n: 2, per: "field" }], stay: null },
  /* O08 */ { id: 28, order: 100, cost: {}, chooses: "none", now: [{ op: "sub", who: "neighbors", res: "C", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
  /* O09 */ { id: 29, order: 110, cost: { B: 2 }, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 3 }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
  /* O10 */ { id: 30, order: 112, cost: { B: 2 }, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 2 }, { op: "add", who: "self", res: "C", n: 2 }], stay: null },
  /* O11 */ { id: 31, order: 114, cost: { A: 1 }, chooses: "none", now: [{ op: "add", who: "self", res: "C", n: 2 }, { op: "add", who: "self", res: "B", n: 1 }], stay: null },
  /* O12 */ { id: 32, order: 116, cost: { A: 1 }, chooses: "none", now: [{ op: "add", who: "self", res: "C", n: 3 }], stay: null },
  /* O13 */ { id: 33, order: 124, cost: { C: 1 }, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 2 }, { op: "add", who: "self", res: "B", n: 2 }], stay: null },
  /* O14 */ { id: 34, order: 126, cost: { C: 2 }, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 3 }, { op: "add", who: "self", res: "B", n: 2 }], stay: null },
  /* O15 */ { id: 35, order: 128, cost: { C: 1 }, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 4 }], stay: null },
  /* O16 */ { id: 36, order: 118, cost: { A: 1, B: 1 }, chooses: "none", now: [{ op: "add", who: "self", res: "C", n: 4 }], stay: null },
  /* O17 */ { id: 37, order: 130, cost: { A: 1, B: 3 }, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 3 }, { op: "add", who: "self", res: "C", n: 3 }], stay: null },
  /* O18 */ { id: 38, order: 146, cost: { A: 2 }, chooses: "none", now: [{ op: "add", who: "self", res: "least", n: 2 }], stay: null },
  /* O19 */ { id: 39, order: 132, cost: {}, chooses: "none", now: [{ op: "add", who: "self", res: "A", n: 2, per: "field" }, { op: "add", who: "self", res: "C", n: 1, per: "field" }], stay: null },
  /* O20 */ { id: 40, order: 144, cost: { A: 1 }, chooses: "none", now: [{ op: "add", who: "self", res: "least", n: 2, per: "field" }], stay: null },

  // ---- P: 隣の人を選ぶ札（order 10〜49。選んだ人が失うのは合計 1 まで、自分が得るのは 2 以上）
  /* P01 */ { id: 41, order: 30, cost: {}, chooses: "player", now: [{ op: "move", res: "A", n: 1 }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },
  /* P02 */ { id: 42, order: 34, cost: { B: 1 }, chooses: "player", now: [{ op: "move", res: "C", n: 1 }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },
  /* P03 */ { id: 43, order: 38, cost: { B: 1 }, chooses: "player", now: [{ op: "move", res: "C", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
  /* P04 */ { id: 44, order: 12, cost: { B: 1 }, chooses: "player", now: [{ op: "sub", who: "chosen", res: "B", n: 1 }, { op: "add", who: "self", res: "C", n: 2 }], stay: null },
  /* P05 */ { id: 45, order: 22, cost: {}, chooses: "player", now: [{ op: "sub", who: "chosen", res: "C", n: 1 }, { op: "add", who: "self", res: "A", n: 2 }], stay: null },
  /* P06 */ { id: 46, order: 42, cost: { B: 2 }, chooses: "player", now: [{ op: "move", res: "B", n: 1 }, { op: "add", who: "self", res: "A", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
  /* P07 */ { id: 47, order: 26, cost: { B: 1 }, chooses: "player", now: [{ op: "sub", who: "chosen", res: "C", n: 1 }, { op: "add", who: "self", res: "C", n: 2 }, { op: "add", who: "self", res: "A", n: 1, per: "field" }], stay: null },
  /* P08 */ { id: 48, order: 44, cost: { B: 2 }, chooses: "player", now: [{ op: "move", res: "A", n: 1 }, { op: "add", who: "self", res: "A", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }, { op: "add", who: "self", res: "B", n: 1 }], stay: null },
  /* P09 */ { id: 49, order: 46, cost: { B: 2 }, chooses: "player", now: [{ op: "move", res: "C", n: 1 }, { op: "add", who: "self", res: "C", n: 1 }, { op: "add", who: "self", res: "B", n: 1 }], stay: null },
  /* P10 */ { id: 50, order: 48, cost: { B: 1 }, chooses: "player", now: [{ op: "add", who: "chosen", res: "C", n: 1 }, { op: "add", who: "self", res: "A", n: 3 }], stay: null },

  // ---- F: 隣の場の札を選ぶ札（order 10〜49）
  /* F01 */ { id: 51, order: 14, cost: {}, chooses: "card", now: [{ op: "remove" }, { op: "add", who: "self", res: "B", n: 2 }], stay: null },
  /* F02 */ { id: 52, order: 18, cost: { B: 1 }, chooses: "card", now: [{ op: "remove" }, { op: "add", who: "self", res: "C", n: 1 }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },
  /* F03 */ { id: 53, order: 20, cost: { B: 1 }, chooses: "card", now: [{ op: "remove" }, { op: "add", who: "self", res: "C", n: 2 }], stay: null },
  /* F04 */ { id: 54, order: 24, cost: { B: 1 }, chooses: "card", now: [{ op: "remove" }, { op: "add", who: "self", res: "least", n: 1 }], stay: null },
  /* F05 */ { id: 55, order: 28, cost: {}, chooses: "card", now: [{ op: "remove" }, { op: "add", who: "self", res: "C", n: 1, per: "field" }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },
  /* F06 */ { id: 56, order: 36, cost: { B: 2 }, chooses: "card", now: [{ op: "remove" }, { op: "add", who: "self", res: "C", n: 2 }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },

  // ---- X: cancel の札（order 1〜9）
  /* X01 */ { id: 57, order: 2, cost: {}, chooses: "none", now: [{ op: "cancel" }, { op: "add", who: "self", res: "A", n: 1 }], stay: null },
  /* X02 */ { id: 58, order: 4, cost: { B: 1 }, chooses: "none", now: [{ op: "cancel" }, { op: "add", who: "self", res: "C", n: 2 }], stay: null },
  /* X03 */ { id: 59, order: 6, cost: { A: 1 }, chooses: "none", now: [{ op: "cancel" }, { op: "add", who: "self", res: "least", n: 1 }], stay: null },
  /* X04 */ { id: 60, order: 8, cost: {}, chooses: "none", now: [{ op: "cancel" }, { op: "add", who: "self", res: "C", n: 1 }], stay: null },
];
