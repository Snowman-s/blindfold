import type { GameDocs } from "../types";

/** LLM-facing description, served by GET /games/tictactoe/rules. */
export const docs: GameDocs = {
  summary:
    "A 2-player game on a 3x3 board. Players take turns placing their mark; the first to get three in a row " +
    "(horizontally, vertically or diagonally) wins.",
  rules: [
    "- The board has 9 cells. A cell is identified by `cell` = 0-8 in row-major order (0 is top-left, 8 is bottom-right):",
    "  ```",
    "  0 | 1 | 2",
    "  3 | 4 | 5",
    "  6 | 7 | 8",
    "  ```",
    "- By join order, `players[0]` moves first and plays X; `players[1]` plays O. Players alternate, one move per turn.",
    "- You may only place a mark on an empty cell. Choosing an occupied cell is rejected with `ILLEGAL_ACTION`.",
    "- Getting three of your marks in one row, column or diagonal wins.",
    "- If all 9 cells are filled and nobody has three in a row, the game is a draw (`winners` is empty, both score 0.5).",
    "- A player who runs out of time loses.",
  ].join("\n"),
  view: [
    "There is no hidden information: players and spectators receive the same view.",
    "- `players`: `[X player, O player]`",
    '- `board`: array of length 9, indexed by cell number. Each element is `"X"`, `"O"` or `null` (empty).',
    "- `next`: the player ID to move next, or `null` once the game is over.",
  ].join("\n"),
  examples: [
    { action: { cell: 4 }, meaning: "Place your mark in the center" },
    { action: { cell: 0 }, meaning: "Place your mark in the top-left corner" },
  ],
};
