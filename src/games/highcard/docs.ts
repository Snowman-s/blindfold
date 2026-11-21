import type { GameDocs } from "../types";
import { DECK_SIZE, ROUNDS } from "./constants";

/** LLM-facing description, served by GET /games/highcard/rules. */
export const docs: GameDocs = {
  summary:
    `A 2-player card game with hidden hands. Each player is dealt ${ROUNDS} cards numbered 1-${DECK_SIZE}; ` +
    "every round both players secretly play one card at the same time, and the higher card wins the round.",
  rules: [
    `- The deck has one card of each number from 1 to ${DECK_SIZE} (${DECK_SIZE} cards). It is shuffled and each player is dealt ${ROUNDS} cards. The remaining cards are not used.`,
    "- You cannot see your opponent's hand.",
    `- The game lasts ${ROUNDS} rounds. In each round both players play one card from their hand face down (**simultaneous turn**). Either player may play first; you do not learn your opponent's card until both have played.`,
    "- When both cards are down they are revealed, and the higher number wins the round. All card numbers are distinct, so a round never ties.",
    "- A played card leaves your hand. You can play only one card per round.",
    `- After ${ROUNDS} rounds, the player who won more rounds wins the game (if equal, it is a draw and \`winners\` is empty). Each player's score is the number of rounds they won.`,
    "- A player who runs out of time loses.",
    "",
    "Strategy hint: from the revealed cards (`history`) and your own hand, you can narrow down which cards your opponent may still hold.",
  ].join("\n"),
  view: [
    "The view depends on who receives it.",
    "- `players`: the two player IDs",
    `- \`round\`: number of finished rounds (0-${ROUNDS}). ${ROUNDS} means the game is over.`,
    "- `wins`: player ID -> rounds won",
    "- `history`: finished rounds, oldest first. Each entry is `{ cards: { <playerId>: <card played> }, winner: <playerId> | null }`.",
    "- `handSizes`: player ID -> number of cards left in hand",
    "- `hasPlayed`: player ID -> whether that player has already played a card this round. The number of an unrevealed card is never included.",
    "- `hand` (only when you are a player): your remaining cards, ascending",
    "- `myPlayed` (only when you are a player): the card you played this round, or `null` if you have not played yet",
    "",
    "Spectators do not receive `hand` or `myPlayed`, so they cannot see anyone's hand.",
  ].join("\n"),
  examples: [{ action: { card: 13 }, meaning: "Play the 13 from your hand (legal only if 13 is in your hand)" }],
};
