import { z } from "zod";
import { GameError, type GameDefinition } from "../types";
import { docs } from "./docs";

type Mark = "X" | "O";
type Cell = Mark | null;

export interface TicTacToeState {
  players: [string, string]; // players[0] = X（先手）, players[1] = O
  board: Cell[]; // 長さ9、行優先
  turn: 0 | 1; // 次に打つ players のインデックス
  winner: string | null;
  draw: boolean;
}

export type TicTacToeAction = { cell: number };

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

function findWinnerMark(board: Cell[]): Mark | null {
  for (const [a, b, c] of LINES) {
    const m = board[a];
    if (m && m === board[b] && m === board[c]) return m;
  }
  return null;
}

const actionSchema = z.object({ cell: z.number().int().min(0).max(8) });

const viewSchema = z.strictObject({
  players: z.array(z.string()).length(2).describe("[X player, O player]"),
  board: z
    .array(z.enum(["X", "O"]).nullable())
    .length(9)
    .describe("Cells 0-8 in row-major order. null = empty"),
  next: z.string().nullable().describe("Player ID to move next, or null once the game is over"),
});

export const tictactoe: GameDefinition<TicTacToeState, TicTacToeAction> = {
  id: "tictactoe",
  minPlayers: 2,
  maxPlayers: 2,
  actionSchema,
  viewSchema,
  docs,

  init(players) {
    if (players.length !== 2 || players[0] === players[1]) {
      throw new GameError("BAD_REQUEST", "tictactoe requires 2 distinct players");
    }
    return {
      players: [players[0]!, players[1]!],
      board: Array<Cell>(9).fill(null),
      turn: 0,
      winner: null,
      draw: false,
    };
  },

  currentPlayers(s) {
    return s.winner !== null || s.draw ? [] : [s.players[s.turn]];
  },

  legalActions(s, pid) {
    if (!this.currentPlayers(s).includes(pid)) return [];
    const out: TicTacToeAction[] = [];
    s.board.forEach((c, i) => {
      if (c === null) out.push({ cell: i });
    });
    return out;
  },

  apply(s, pid, a) {
    if (s.winner !== null || s.draw) throw new GameError("ILLEGAL_ACTION", "game is over");
    if (s.players[s.turn] !== pid) throw new GameError("NOT_YOUR_TURN", "not your turn");
    if (s.board[a.cell] !== null) throw new GameError("ILLEGAL_ACTION", "cell is occupied");

    const mark: Mark = s.turn === 0 ? "X" : "O";
    const board = s.board.slice();
    board[a.cell] = mark;
    const won = findWinnerMark(board) !== null;
    return {
      players: s.players,
      board,
      turn: s.turn === 0 ? 1 : 0,
      winner: won ? pid : null,
      draw: !won && board.every((c) => c !== null),
    };
  },

  // 隠し情報なし。観戦者もプレイヤーも同じ view。
  view(s) {
    return {
      players: s.players,
      board: s.board,
      next: s.winner !== null || s.draw ? null : s.players[s.turn],
    };
  },

  result(s) {
    if (s.winner !== null) {
      const loser = s.players.find((p) => p !== s.winner)!;
      return { winners: [s.winner], scores: { [s.winner]: 1, [loser]: 0 } };
    }
    if (s.draw) return { winners: [], scores: { [s.players[0]]: 0.5, [s.players[1]]: 0.5 } };
    return null;
  },
};
