import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Card, cardSchema, RESOURCES } from "../../src/games/draftcards/catalog";
import { cards } from "../../src/games/draftcards/cards";
import { FIELD_LIMIT, MAX_PLAYERS, PACK_SIZE } from "../../src/games/draftcards/constants";
import { catalogDocs, docs } from "../../src/games/draftcards/docs";
import { actionSchema, viewSchema } from "../../src/games/draftcards/schemas";

// カード（catalog）と資料の検査。エンジンの規則は draftcards-engine.test.ts、共通の検査は all-games.test.ts。

describe("draftcards catalog", () => {
  it("every card satisfies the card schema", () => {
    for (const c of cards) expect(cardSchema.safeParse(c).error?.issues, `#${c.id}`).toBeUndefined();
  });

  it("a full game uses at most half of the catalog", () => {
    // 最大人数でも catalog の半分以下しか配らない（毎試合ほぼ同じ札が出ないように）
    expect(cards.length).toBeGreaterThanOrEqual(2 * MAX_PLAYERS * PACK_SIZE);
  });

  it("cards that choose a player mainly help their owner", () => {
    // 選んだ人から減らす量が大きいと、多人数では 1 人を袋叩きにする道具になり、2 人戦では振れ幅が広がる。
    // 選んだ人が失うのは合計 1 まで、持ち主が得るのは 2 以上
    for (const c of cards.filter((c) => c.chooses === "player")) {
      const loss = c.now.reduce((s, e) => s + (e.op === "move" || (e.op === "sub" && e.who === "chosen") ? e.n : 0), 0);
      // per: field は場が 0 枚だと何も得ないので数えない
      const gain = c.now.reduce((s, e) => s + (e.op === "move" || (e.op === "add" && e.who === "self" && !e.per) ? e.n : 0), 0);
      expect(loss, `#${c.id} loss`).toBeLessThanOrEqual(1);
      expect(gain, `#${c.id} gain`).toBeGreaterThanOrEqual(2);
    }
  });

  // 以下はスケルトンの構造の規則。カードを足し引きしても崩さないためのもの。
  const effectsOf = (c: Card) => [...c.now, ...(c.stay?.each ?? [])];

  it("every resource is gained, paid and taken away by at least 3 cards", () => {
    for (const r of RESOURCES) {
      const gains = cards.filter((c) => effectsOf(c).some((e) => (e.op === "add" && e.who === "self" && e.res === r) || (e.op === "move" && e.res === r)));
      const pays = cards.filter((c) => (c.cost[r] ?? 0) > 0);
      const takes = cards.filter((c) => effectsOf(c).some((e) => (e.op === "sub" && e.who !== "self" && e.res === r) || (e.op === "move" && e.res === r)));
      expect(gains.length, `${r} gained`).toBeGreaterThanOrEqual(3);
      expect(pays.length, `${r} paid`).toBeGreaterThanOrEqual(3);
      expect(takes.length, `${r} taken away`).toBeGreaterThanOrEqual(3);
    }
  });

  it("only cards used once cost C", () => {
    // C は少ない（1 から始まる）。場に残る札は早く出したいので、C を払わせると出せない
    for (const c of cards.filter((c) => (c.cost.C ?? 0) > 0)) expect(c.stay, `#${c.id}`).toBeNull();
  });

  it("every cost band has both cards that stay and cards used once", () => {
    const total = (c: Card) => RESOURCES.reduce((s, r) => s + (c.cost[r] ?? 0), 0);
    for (const band of [0, 1, 2, 3]) {
      const inBand = cards.filter((c) => Math.min(total(c), 3) === band);
      expect(inBand.some((c) => c.stay), `cost ${band} stays`).toBe(true);
      expect(inBand.some((c) => !c.stay), `cost ${band} once`).toBe(true);
    }
  });

  it("a full field can be built", () => {
    // 1 ラウンドに 1 枚なので、解決時（now）に場が上限の枚数になるには、最初に出す札が上限 + 1 ラウンド以上残る必要がある。
    // そういう札が安いものも含めて十分ないと、上限と now の per: field が飾りになる
    const long = cards.filter((c) => (c.stay?.times ?? 0) >= FIELD_LIMIT + 1);
    expect(long.length).toBeGreaterThanOrEqual(6);
    // ラウンド 1 の B は START.B + ROUND_B なので、費用 2 までなら最初の手に出せる
    expect(long.filter((c) => RESOURCES.reduce((s, r) => s + (c.cost[r] ?? 0), 0) <= 2).length).toBeGreaterThanOrEqual(3);
  });

  it("has enough cards of each named mechanic", () => {
    const perField = cards.filter((c) => effectsOf(c).some((e) => e.op === "add" && e.per === "field"));
    const least = cards.filter((c) => effectsOf(c).some((e) => e.op === "add" && e.res === "least"));
    expect(perField.length).toBeGreaterThanOrEqual(8);
    expect(least.length).toBeGreaterThanOrEqual(4);
  });

  it("orders follow the bands", () => {
    for (const c of cards) {
      if (c.now.some((e) => e.op === "cancel")) expect(c.order, `#${c.id}`).toBeLessThan(10);
      else if (c.chooses !== "none") expect(c.order, `#${c.id}`).toSatisfy((o: number) => o >= 10 && o < 50);
      else if (c.stay) expect(c.order, `#${c.id}`).toSatisfy((o: number) => o >= 50 && o < 100);
    }
  });

  it("ids and orders are unique", () => {
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
    expect(new Set(cards.map((c) => c.order)).size).toBe(cards.length);
  });
});

describe("draftcards docs", () => {
  it("examples satisfy the action schema", () => {
    for (const e of docs.examples) expect(actionSchema.safeParse(e.action).success, e.meaning).toBe(true);
  });

  it("examples refer to cards that exist and fit how they choose", () => {
    for (const { action } of docs.examples) {
      const a = actionSchema.parse(action);
      const card = cards.find((c) => c.id === a.card);
      expect(card, `#${a.card}`).toBeDefined();
      if (a.type === "play") {
        expect(a.chosen !== undefined).toBe(card!.chooses === "player");
        expect(a.target !== undefined).toBe(card!.chooses === "card");
      }
    }
  });

  it("served text has no Japanese", () => {
    const text = [
      docs.summary,
      docs.rules,
      docs.view,
      ...docs.examples.map((e) => e.meaning),
      catalogDocs,
      JSON.stringify(z.toJSONSchema(actionSchema)),
      JSON.stringify(z.toJSONSchema(viewSchema)),
      JSON.stringify(z.toJSONSchema(cardSchema)),
    ].join("\n");
    expect(text).not.toMatch(/[぀-ヿ㐀-鿿＀-￯]/);
  });
});
