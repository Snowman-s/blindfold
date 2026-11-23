import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cardSchema } from "../../src/games/draftcards/catalog";
import { cards } from "../../src/games/draftcards/cards";
import { MAX_PLAYERS, PACK_SIZE } from "../../src/games/draftcards/constants";
import { catalogDocs, docs } from "../../src/games/draftcards/docs";
import { actionSchema, viewSchema } from "../../src/games/draftcards/schemas";

// エンジンはまだ無く registry にも載せていないので、all-games テストの代わりに資料とカードだけ確かめる。

describe("draftcards catalog", () => {
  it("every card satisfies the card schema", () => {
    for (const c of cards) expect(cardSchema.safeParse(c).error?.issues, `#${c.id}`).toBeUndefined();
  });

  it("a full game uses at most half of the catalog", () => {
    // 最大人数でも catalog の半分以下しか配らない（毎試合ほぼ同じ札が出ないように）
    expect(cards.length).toBeGreaterThanOrEqual(2 * MAX_PLAYERS * PACK_SIZE);
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
