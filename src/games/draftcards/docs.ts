import type { GameDocs } from "../types";
import { DISCARD_B, FIELD_LIMIT, MAX_PLAYERS, MIN_PLAYERS, PACK_SIZE, ROUND_B, ROUNDS, START } from "./constants";

/**
 * GET /games/draftcards/rules で配る説明。エンジンはまだ無く、registry にも載せていない。
 * カードとリソースに意味を持たせないため、意味が漏れる語（体力・通貨・得点・戦い・魔法など）を使わないこと。
 * フィールド名・enum 値・GameError のメッセージも同じ。
 */

const NAMING = [
  "### Name everything before you play",
  "This game deliberately gives its cards and resources no names: cards are only `#1`, `#2`, ..., resources are only `A`, `B` and `C`, and these rules say what they do, never what they are. Before building a client, we very strongly recommend choosing a theme of your own, giving every card in the catalog a meaningful name (and ideally an illustration) within that theme, and giving each resource a name, so that players can follow the game. Different clients will come up with different names; that is intended.",
  "",
  "Generate the names once and keep them, keyed by card `id` and resource letter, and reuse them in every match. Card ids are permanent: a published card never changes under the same `id`, and a retired `id` is never reused, so your names stay valid across `rulesVersion` changes. New cards get new ids; name those when they appear. Store each card's JSON next to its name if you want to double-check this.",
];

/**
 * カードの読み方。プラットフォームに GameDefinition.catalog（カードの schema・一覧・読み方を /games/:id/rules で配る）を
 * 足したら、その docs に入れる予定。
 */
export const catalogDocs = [
  "Each card is a JSON object. The catalog lists every card that can appear; a game uses a random part of it.",
  "",
  "- `id`: the card's number, used in actions and in the view. Permanent: a published card never changes under the same `id`, and a retired `id` is never reused. It has no rule meaning: it never decides the order of anything.",
  "- `order`: when the card resolves within a round, and when its `each` effects apply. Lower goes first. No two cards in the catalog share an `order`, so there are never ties.",
  "- `cost`: resources the owner pays when the card resolves, for example `{ \"B\": 2 }`. Missing keys cost nothing; `{}` is free. If the owner does not have all of it at that moment, nothing is paid and the card does nothing at all.",
  "- `chooses`: what you name when you play the card. `none`: nothing. `player`: one of your neighbors (`chosen` in the action). `card`: a card in one of your neighbors' fields (`target` in the action).",
  "- `now`: effects applied once, in the listed order, when the card resolves.",
  "- `stay`: `null` for a card that is used once (it is discarded after resolving). Otherwise `{ times, each }`: after resolving, the card goes to its owner's field, and at the start of each later round its `each` effects apply; after `times` applications it leaves the field. A card in a field is public.",
  "",
  "#### Effects",
  "Effects are applied one at a time. A resource never goes below 0 (each effect stops at 0) and has no upper limit. Reaching 0 has no other consequence.",
  '- `{ "op": "add", "who", "res", "n" }`: `res` of every player in `who` goes up by `n`.',
  '- `{ "op": "sub", "who", "res", "n" }`: `res` of every player in `who` goes down by `n` (not below 0).',
  '- `{ "op": "move", "res", "n" }`: takes up to `n` of the chosen player\'s `res` (as much as they have, at most `n`) and gives it to the owner.',
  '- `{ "op": "remove" }`: the targeted card leaves its field. If it is no longer in a field when this applies, nothing happens.',
  "- `{ \"op\": \"cancel\" }`: for the rest of this round (from when this card resolves), effects of **other players' cards** do nothing to the owner or to the owner's field cards, whether they would help or hurt. Cards that resolved earlier in the round are not undone. The owner's own cards, discards and the B every player gets at the start of a round are not affected, and neither are `each` effects (they apply before any card is played). Other players still affected by the same effect are affected as usual.",
  "",
  "`who` is seen from the card's owner, and counts only players still in the game:",
  "- `self`: the owner. `chosen`: the neighbor named when the card was played (only on cards with `chooses: \"player\"`; if that player has left by then, the effect does nothing).",
  "- `neighbors`: both of the owner's neighbors; in a 2-player game the only other player, affected once.",
  "- `others`: every remaining player except the owner. `all`: every remaining player, the owner included.",
  "",
  "`each` effects are only `add` and `sub`, and never use `chosen`.",
].join("\n");

export const docs: GameDocs = {
  summary:
    `A ${MIN_PLAYERS}-${MAX_PLAYERS} player card game where nothing has a name. Draft a hand of numbered cards from packs passed around the table, ` +
    `then play them over ${ROUNDS} rounds: some act once, some stay in your field and act every round, and some reach into your neighbors' fields. ` +
    "The resources are just A, B and C.",
  rules: [
    ...NAMING,
    "",
    "### The cards",
    "Every card that can appear is in the catalog (`catalog` in `GET /games/draftcards/rules`, with a guide to reading a card). A card is referred to only by its number (`card: 12` is card #12). Within one game no card appears twice, so a number always means one card.",
    "",
    "### Seats and neighbors",
    "- `players` is the seat order, and it goes around (after the last seat comes the first). Your **neighbors** are the remaining players just before and just after you. Players who left the game are skipped, so neighbors can change during the game. The view has them in `neighbors`.",
    "- With 3 players both neighbors are the other two players. With 4 players you cannot reach the player across from you. With 2 players your only neighbor is your opponent.",
    "",
    "### Draft",
    `- Every player gets a pack of ${PACK_SIZE} cards drawn at random from the catalog (\`pack\` in the view; only you see your pack).`,
    '- Everyone picks one card from the pack they hold at the same time: `{ "type": "pick", "card": 12 }`. When everyone has picked, every pack passes to the next seat in `players` order (around all seats, including the seats of players who left).',
    `- When a pack holds only one card, it is taken automatically. So there are ${PACK_SIZE - 1} picks, and everyone ends with ${PACK_SIZE} cards in \`hand\`.`,
    "- Nobody sees what the others picked (you can only guess from the packs that reach you).",
    "",
    "### Rounds",
    `Everyone starts with A = ${START.A}, B = ${START.B} and C = ${START.C}, and an empty field. Then ${ROUNDS} rounds are played, each like this:`,
    "1. **Field cards act.** The `each` effects of every card in every field apply, one card at a time, lowest `order` first. Each card's `times` goes down by 1; at 0 it leaves the field. (Nothing happens in round 1: the fields are still empty.)",
    `2. Every remaining player's B goes up by ${ROUND_B}.`,
    "3. **Everyone acts at the same time**, without seeing the others' choice. Send one of:",
    '   - `{ "type": "play", "card": 12 }`: play a card from your hand. If the card has `chooses: "player"`, add `"chosen": "p3"` (one of your neighbors). If it has `chooses: "card"`, add `"target": 31` (a card that is in one of your neighbors\' fields in the state you act on; cards played this round are not there yet).',
    `   - \`{ "type": "discard", "card": 12 }\`: give up a card from your hand for B +${DISCARD_B}. Other players see that you discarded, but not which card.`,
    "4. **Resolve.** When everyone has acted:",
    `   - First, everyone who discarded gets B +${DISCARD_B}.`,
    "   - Then the played cards resolve one at a time, lowest `order` first. For each: the owner pays its `cost` (if they cannot pay all of it, nothing is paid, nothing else happens and the card is discarded); its `now` effects apply in order; then, if it has `stay`, it goes to the owner's field as the newest card.",
    `   - A field holds at most ${FIELD_LIMIT} cards: when a ${FIELD_LIMIT + 1}th arrives, the oldest one leaves.`,
    "   - If the chosen player has left the game, or the targeted card has left its field, by the time the card resolves, the effects that use them do nothing (the cost is still paid).",
    "",
    "Costs are paid when the card resolves, not when you send it. A card resolving earlier (lower `order`) can change what you have, so a card you could afford when you played it may go unpaid, and the other way round.",
    "",
    "How to read a card, and exactly what each effect does (including `cancel`), is explained with the catalog.",
    "",
    "### End and ranking",
    `- The game ends after round ${ROUNDS} is resolved (there are no field effects after that). With ${PACK_SIZE} cards and ${ROUNDS} rounds, one card is never used.`,
    "- Remaining players are ranked by **min(A, B, C)**, the smallest of their three resources, highest first; ties are broken by A + B + C; players still tied share the place. The best-ranked players are the winners.",
    "- `scores` is min(A, B, C) for every player. For players who left, it is taken from their resources when they left, but they always rank below every remaining player (a player who left later ranks above one who left earlier), whatever their score.",
    "",
    "### Leaving the game",
    "- **Timeout:** a player who does not act before the deadline is out at once (`timedOut`). The others' actions for that pick or round still count.",
    "- **Resign:** the player is out at once (`resigned`). You may resign at any time, even after you have acted in the current round.",
    "- A player who leaves keeps nothing in play: their field cards leave (without effect), the action they sent for the current round is ignored, their resources stop changing and no effect reaches them any more.",
    "- If a player leaves during the draft, their seat keeps picking automatically (a random card from the pack) so that the packs keep moving. These automatic picks never make anyone wait.",
    "- When only one player is left, that player wins at once, even during the draft. If all remaining players leave at the same moment, there is no winner.",
    "",
    "### Notes",
    "- Every pick and every round is one simultaneous turn: all remaining players are in `currentPlayers`, and nothing is revealed until all of them have acted.",
    `- Quick match and \`options.autoStart\` wait until the room is full, which is ${MAX_PLAYERS} players by default. For a smaller game pass \`options.seats\` (for example \`{"game":"draftcards","options":{"seats":2}}\`).`,
    '- `legal` lists every pick, every discard, and every play with every allowed `chosen` / `target`. Plays are listed whether or not you can pay the cost now (it is paid later). A card with `chooses: "card"` cannot be played when no neighbor has a card in their field; you can still discard it.',
    "- A card in the catalog never changes; only new cards are added (with new numbers) and old ones retired.",
  ].join("\n"),
  view: [
    "- `phase`: `pick` (the draft), `play` (the rounds) or `over`.",
    "- `pick`: during the draft, the current pick number from 1; `null` otherwise. `round`: the current round from 1 (0 during the draft; it stays at the last round when the game is over).",
    "- `players`: all player IDs in seat order. `out`: player ID -> `resigned` | `timedOut` for players who left.",
    "- `neighbors`: remaining player ID -> that player's neighbors (two players, or one in a 2-player game). Players who left do not appear.",
    "- `resources`: player ID -> `{ A, B, C }`. Public. Frozen for players who left.",
    "- `handCounts`: player ID -> number of cards in that player's hand.",
    "- `fields`: player ID -> the cards in that player's field, oldest first, each `{ card, times }` (`times`: how many more times its `each` effects will apply). Public. Empty for players who left.",
    "- `lastRound`: what happened when the last round was resolved, or `null` until the first round is resolved. It stays the same until the next round is resolved, so several `state` messages carry the same one; if you animate it, do it when `lastRound.round` changes.",
    "  `round` is the round whose cards were resolved. `steps` lists everything that happened since, in order. Every step has `kind` and `round`:",
    "  - `discard` `{ player, card, changes }`: a discard. `card` is shown only to the player who discarded it (`null` for everyone else).",
    "  - `play` `{ player, card, chosen, target, paid, effects, placed, changes }`: a played card resolving. `changes` is the cost paid. `paid: false` means the owner could not pay: nothing else happened and the card was discarded. `placed` tells whether it went to the owner's field.",
    "  - `leave` `{ player, card, why }`: a card left `player`'s field. `why` is `expired` (its `times` ran out), `removed` (by a `remove` effect) or `full` (the oldest card, pushed out by a new one).",
    "  - `each` `{ player, card, times, effects }`: at the start of the next round, a field card's `each` effects applied. `times` is what is left after this.",
    "  - `everyone` `{ changes }`: at the start of the next round, every remaining player's B went up.",
    "  So unless the game ended, `steps` ends with the start of the current round: steps with `round` equal to `lastRound.round` come from resolving the cards, those with the next round number from the start of the current round.",
    "  `effects` lists one result per effect of the card, in the card's order: `{ index, canceled, changes }`. `index` is the effect's position in the card's `now` (or `each`), `canceled` the players for whom it did nothing because of their `cancel`.",
    "  Every `changes` is a list of `{ player, res, delta }`: the actual change (after stopping at 0; never 0) to that player's resource.",
    "- `pack` (players only): during the draft, the cards in the pack you hold now, ascending; empty otherwise.",
    "- `hand` (players only): your cards, ascending. During the draft, the cards you have picked so far.",
    "",
    "Viewpoints: a player sees their own `pack` and `hand` and the number of each card they discarded. Spectators get no `pack` or `hand` and never see picks or discarded cards; they see everything else, like the players.",
  ].join("\n"),
  examples: [
    { action: { type: "pick", card: 12 }, meaning: "Keep card #12 from the pack you hold; the rest of the pack passes to the next seat" },
    { action: { type: "play", card: 5 }, meaning: 'Play card #5 (a card with `chooses: "none"`)' },
    { action: { type: "play", card: 6, chosen: "p2" }, meaning: 'Play card #6 (`chooses: "player"`), naming your neighbor p2' },
    { action: { type: "play", card: 3, target: 2 }, meaning: 'Play card #3 (`chooses: "card"`) on card #2 in a neighbor\'s field' },
    { action: { type: "discard", card: 10 }, meaning: `Give up card #10 for B +${DISCARD_B}` },
  ],
};
