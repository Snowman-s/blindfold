import { z } from "zod";
import { FIELD_LIMIT } from "./constants";

/**
 * draftcards のカードの形（catalog の schema）。カードはデータで、エンジンはそれを解釈するだけ。
 * 名前・テーマに関わる語はどこにも書かない（名前は各クライアントが付ける。コメントに仮名を書くと docs に漏れる）。
 *
 * 一度公開したカードは、同じ id のまま中身（order を含む）を変えない。調整は廃止して新しい id で足す。
 * order は catalog 全体で重複させない（解決が 1 枚ずつになり、同時解決の規則が要らない）。
 */

export const RESOURCES = ["A", "B", "C"] as const;
export type Resource = (typeof RESOURCES)[number];

const res = z.enum(RESOURCES).describe("Which resource");
const amount = z.number().int().min(1).max(9).describe("How much");

/** 効果の向き先。カードの持ち主から見た相対的な指定。 */
export const WHO = ["self", "chosen", "neighbors", "others", "all"] as const;
const who = z
  .enum(WHO)
  .describe(
    "Who is affected, seen from the card's owner: self, chosen (the neighbor named when playing), neighbors (both neighbors; once in a 2-player game), others (every remaining player but the owner), all (every remaining player)",
  );
const whoEach = z
  .enum(["self", "neighbors", "others", "all"])
  .describe("Who is affected, seen from the card's owner (`chosen` is not allowed in `each`)");

/**
 * add だけが持てる 2 つの拡張（claude_doc/draftcards-set-design.md 4 節の M1・M2）。
 * - per: "field": n に持ち主の場の札の枚数を掛ける（now は解決時・自分を置く前、each はラウンドの初めに数える）。0 枚なら何もしない
 * - res: "least": 持ち主の一番少ないリソース（同点ならそのすべて）。who は self だけ（cardSchema の superRefine で確かめる）
 * sub・move・cost には付けない（減らす量が膨らむ効果は 2 人戦の振れ幅を広げるため）。
 */
const addRes = z
  .enum([...RESOURCES, "least"])
  .describe("Which resource. `least`: the owner's smallest resource at that moment (every one tied for smallest); only with `who: self`");
const per = z
  .literal("field")
  .optional()
  .describe("If `field`, `n` is multiplied by the number of cards in the owner's field (0 cards: nothing happens)");
const add = z
  .strictObject({ op: z.literal("add"), who, res: addRes, n: amount, per })
  .describe("Increase `res` of `who` by `n` (times the owner's field cards if `per` is `field`)");
const sub = z
  .strictObject({ op: z.literal("sub"), who, res, n: amount })
  .describe("Decrease `res` of `who` by `n` (never below 0)");
const move = z
  .strictObject({ op: z.literal("move"), res, n: amount })
  .describe("Take up to `n` of `res` from the chosen player and give it to the owner");
const remove = z.strictObject({ op: z.literal("remove") }).describe("The targeted field card leaves its field");
const cancel = z
  .strictObject({ op: z.literal("cancel") })
  .describe("For the rest of this round, effects of other players' cards do nothing to the owner or the owner's field cards");

export const effectSchema = z.discriminatedUnion("op", [add, sub, move, remove, cancel]);
export const eachEffectSchema = z.discriminatedUnion("op", [
  add.extend({ who: whoEach }),
  sub.extend({ who: whoEach }),
]);
export type Effect = z.infer<typeof effectSchema>;
export type EachEffect = z.infer<typeof eachEffectSchema>;

export const cardSchema = z
  .strictObject({
    id: z.number().int().min(1).describe("The card's number. Permanent: a published id never changes meaning and is never reused"),
    order: z
      .number()
      .int()
      .min(1)
      .describe("Resolution order: lower goes first. Unique across the whole catalog"),
    cost: z
      .strictObject({ A: amount.optional(), B: amount.optional(), C: amount.optional() })
      .describe("Resources the owner pays when the card resolves. Missing keys cost nothing"),
    chooses: z
      .enum(["none", "player", "card"])
      .describe("What the card needs when played: nothing, a neighbor (`chosen`), or a card in a neighbor's field (`target`)"),
    now: z.array(effectSchema).describe("Effects applied once, in this order, when the card resolves"),
    stay: z
      .strictObject({
        times: z.number().int().min(1).max(6).describe("How many rounds `each` applies before the card leaves the field"),
        each: z.array(eachEffectSchema).min(1).describe("Effects applied at the start of every round while the card is in the field"),
      })
      .nullable()
      .describe("null for a card that is used once. Otherwise the card stays in the owner's field after resolving"),
  })
  .superRefine((c, ctx) => {
    const usesChosen = c.now.some((e) => e.op === "move" || ((e.op === "add" || e.op === "sub") && e.who === "chosen"));
    const usesTarget = c.now.some((e) => e.op === "remove");
    if (usesChosen !== (c.chooses === "player")) {
      ctx.addIssue({ code: "custom", message: "`chooses: player` exactly when a `now` effect uses the chosen player (`chosen` or `move`)" });
    }
    if (usesTarget !== (c.chooses === "card")) {
      ctx.addIssue({ code: "custom", message: "`chooses: card` exactly when a `now` effect is `remove`" });
    }
    if (c.now.length === 0 && c.stay === null) {
      ctx.addIssue({ code: "custom", message: "a card needs a `now` effect or `stay`" });
    }
    for (const e of [...c.now, ...(c.stay?.each ?? [])]) {
      if (e.op === "add" && e.res === "least" && e.who !== "self") {
        ctx.addIssue({ code: "custom", message: "`res: least` only with `who: self`" });
      }
      if (e.op === "add" && e.per === "field" && e.n * FIELD_LIMIT > 9) {
        ctx.addIssue({ code: "custom", message: "`per: field` with `n` so large that a full field goes past 9" });
      }
    }
  });
export type Card = z.infer<typeof cardSchema>;
