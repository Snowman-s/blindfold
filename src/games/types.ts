import type { z } from "zod";
import type { Rng, Seed } from "../lib/rng";

export type GameErrorCode = "ILLEGAL_ACTION" | "NOT_YOUR_TURN" | "BAD_REQUEST";

export class GameError extends Error {
  constructor(
    public readonly code: GameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}

export interface GameResult {
  winners: string[];
  scores?: Record<string, number>;
}

/** すべてのゲームが実装する。副作用なしの純粋関数にすること。 */
export interface GameDefinition<S, A> {
  id: string;
  minPlayers: number;
  maxPlayers: number;
  actionSchema: z.ZodType<A>;
  /** seed は文字列（サーバーは 128 ビットの乱数を発行する）。乱数は createRng(seed) で作る。 */
  init(players: string[], seed: Seed): S;
  currentPlayers(s: S): string[];
  legalActions(s: S, pid: string): A[];
  /** 不正な手は GameError を throw。s は変更せず新しい状態を返す。 */
  apply(s: S, pid: string, a: A, rng: Rng): S;
  /** 隠し情報を除去。null は観戦者。 */
  view(s: S, pid: string | null): unknown;
  result(s: S): GameResult | null;
  /**
   * 持ち時間切れ時の処理（任意）。pids は時間切れになったプレイヤー。
   * 未定義のゲームは「時間切れのプレイヤーの負け」（残りが勝者）で終了する。
   */
  onTimeout?(s: S, pids: string[], rng: Rng): S;
}
