import type { GameDefinition } from "./types";
import { tictactoe } from "./tictactoe";
import { highcard } from "./highcard";

// メソッド記法のパラメータは双変なので、個別のゲームを unknown 版として登録できる。
export type AnyGame = GameDefinition<unknown, unknown>;

export const games: Record<string, AnyGame> = {
  [tictactoe.id]: tictactoe,
  [highcard.id]: highcard,
};

export function getGame(id: string): AnyGame | undefined {
  return Object.hasOwn(games, id) ? games[id] : undefined;
}
