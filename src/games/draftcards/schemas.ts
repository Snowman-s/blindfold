import { z } from "zod";
import { FIELD_LIMIT, PACK_SIZE, ROUNDS } from "./constants";
import { RESOURCES } from "./catalog";

/** draftcards の action と view の形（/games/draftcards/rules で JSON Schema として配る）。 */

const cardId = z.number().int().min(1);

export const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("pick"),
    card: cardId.describe("A card in `pack` to keep"),
  }),
  z.strictObject({
    type: z.literal("play"),
    card: cardId.describe("A card in `hand` to play"),
    chosen: z
      .string()
      .optional()
      .describe('Required when the card has `chooses: "player"` (and not allowed otherwise): a neighbor\'s player ID'),
    target: cardId
      .optional()
      .describe('Required when the card has `chooses: "card"` (and not allowed otherwise): a card in a neighbor\'s field'),
  }),
  z.strictObject({
    type: z.literal("discard"),
    card: cardId.describe("A card in `hand` to give up for B"),
  }),
]);
export type DraftCardsAction = z.infer<typeof actionSchema>;

const pidMap = <T extends z.ZodType>(v: T) => z.record(z.string(), v);
const resources = z.strictObject({
  A: z.number().int().min(0),
  B: z.number().int().min(0),
  C: z.number().int().min(0),
});
const change = z.strictObject({
  player: z.string(),
  res: z.enum(RESOURCES),
  delta: z.number().int().describe("How much it actually changed (after stopping at 0). Never 0"),
});
const changes = z.array(change).describe("Every resource change this step made, in the order it happened");
const effectResult = z.strictObject({
  index: z.number().int().min(0).describe("Position of the effect in the card's `now` (or `each` for kind `each`)"),
  canceled: z.array(z.string()).describe("Players for whom this effect did nothing because of their `cancel`"),
  changes,
});
const round = z.number().int().min(1).max(ROUNDS).describe("The round this step belongs to");

const step = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("discard"),
    round,
    player: z.string(),
    card: cardId.nullable().describe("The discarded card; shown only to the player who discarded it (null for everyone else)"),
    changes,
  }),
  z.strictObject({
    kind: z.literal("play"),
    round,
    player: z.string(),
    card: cardId,
    chosen: z.string().nullable().describe("The neighbor chosen with the card, or null"),
    target: cardId.nullable().describe("The field card targeted with the card, or null"),
    paid: z
      .boolean()
      .describe("false if the owner could not pay the cost: then nothing else happened and the card was discarded"),
    effects: z.array(effectResult).describe("Results of the card's `now` effects, in order (empty when not paid)"),
    placed: z.boolean().describe("Whether the card went to the owner's field"),
    changes: changes.describe("The cost paid (empty when not paid or free)"),
  }),
  z.strictObject({
    kind: z.literal("each"),
    round,
    player: z.string().describe("The card's owner"),
    card: cardId,
    times: z.number().int().min(0).describe("Times left after this application (the card leaves at 0)"),
    effects: z.array(effectResult),
  }),
  z.strictObject({
    kind: z.literal("everyone"),
    round,
    changes: changes.describe("Every remaining player's B going up at the start of the round"),
  }),
  z.strictObject({
    kind: z.literal("leave"),
    round,
    player: z.string().describe("The owner of the field the card left"),
    card: cardId,
    why: z
      .enum(["expired", "removed", "full"])
      .describe("expired: `times` ran out; removed: by a `remove` effect; full: pushed out as the oldest card when the field went over the limit"),
  }),
]);

export const viewSchema = z.strictObject({
  phase: z.enum(["pick", "play", "over"]).describe("pick: the draft; play: the rounds; over: the game has ended"),
  pick: z
    .number()
    .int()
    .min(1)
    .max(PACK_SIZE - 1)
    .nullable()
    .describe("During the draft, the current pick number from 1; null otherwise"),
  round: z.number().int().min(0).max(ROUNDS).describe(`Current round, 1-${ROUNDS}. 0 during the draft`),
  players: z.array(z.string()).describe("All player IDs in seat order"),
  out: pidMap(z.enum(["resigned", "timedOut"])).describe("Player ID -> why that player left the game"),
  neighbors: pidMap(z.array(z.string()).min(1).max(2)).describe(
    "Remaining player ID -> that player's neighbors: the remaining players just before and after them in seat order (one in a 2-player game)",
  ),
  resources: pidMap(resources).describe("Player ID -> that player's A, B and C (public). Frozen when a player leaves"),
  handCounts: pidMap(z.number().int().min(0)).describe("Player ID -> number of cards in that player's hand"),
  fields: pidMap(
    z
      .array(
        z.strictObject({
          card: cardId,
          times: z.number().int().min(1).describe("How many more times its `each` effects will apply"),
        }),
      )
      .max(FIELD_LIMIT),
  ).describe("Player ID -> the cards in that player's field, oldest first (public). Empty for players who left"),
  lastRound: z
    .strictObject({
      round: z.number().int().min(1).max(ROUNDS).describe("The round whose played cards were resolved"),
      steps: z.array(step).describe("Everything that happened from that round's resolution up to now, in order"),
    })
    .nullable()
    .describe("What happened when the last round was resolved, step by step. null until the first round is resolved"),
  pack: z
    .array(cardId)
    .optional()
    .describe("Players only: during the draft, the cards in the pack you hold now (ascending); empty otherwise"),
  hand: z.array(cardId).optional().describe("Players only: the cards you hold (ascending). During the draft, the cards picked so far"),
});
