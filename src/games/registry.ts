import type { AnyGame } from "./types";
import { tictactoe } from "./tictactoe";
import { highcard } from "./highcard";

export type { AnyGame } from "./types";

export const games: Record<string, AnyGame> = {
  [tictactoe.id]: tictactoe,
  [highcard.id]: highcard,
};

export function getGame(id: string): AnyGame | undefined {
  return Object.hasOwn(games, id) ? games[id] : undefined;
}
