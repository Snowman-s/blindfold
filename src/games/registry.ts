import type { AnyGame } from "./types";
import { tictactoe } from "./tictactoe";
import { highcard } from "./highcard";
import { frontier } from "./frontier";
import { liarsdice } from "./liarsdice";

export type { AnyGame } from "./types";

/**
 * 各ゲームのエンジン。サーバーが持つのは各ゲームの今の版だけ（古い版のエンジンは残さない）。
 * rulesVersion を上げると、それより前の版で始めたルーム（進行中・終了済みのリプレイとも）は GAME_REMOVED になる。
 */
export const games: Record<string, AnyGame> = {
  [tictactoe.id]: tictactoe,
  [highcard.id]: highcard,
  [frontier.id]: frontier,
  [liarsdice.id]: liarsdice,
};

/**
 * ゲームのエンジン。rulesVersion を指定すると、今の版がそれと一致するときだけ返す
 * （古い state やログを今の版のエンジンで動かすと、別の試合が再現されたり例外になったりするため）。
 * 無ければ undefined（未知のゲーム、またはその版がもうサーバーに無い）。
 */
export function getGame(id: string, rulesVersion?: number): AnyGame | undefined {
  const game = Object.hasOwn(games, id) ? games[id] : undefined;
  return rulesVersion === undefined || game?.rulesVersion === rulesVersion ? game : undefined;
}
