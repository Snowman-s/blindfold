import type { AnyGame } from "../games/types";
import type { Rng } from "./rng";

/**
 * 練習相手（options.practice）が打つ手。ゲームが practiceAction を定義していればそれを、なければ合法手からランダムに選ぶ。
 * 打てる手がなければ undefined（持ち時間切れに任せる）。純粋関数（乱数は渡された rng だけを使う）。
 */
export function practiceAction(game: AnyGame, s: unknown, pid: string, rng: Rng): { action: unknown } | undefined {
  if (game.practiceAction) return { action: game.practiceAction(s, pid, rng) };
  const legal = game.legalActions?.(s, pid) ?? [];
  return legal.length ? { action: legal[rng.int(legal.length)] } : undefined;
}
