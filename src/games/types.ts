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

/** ゲームの説明。Bot 上の LLM がプロンプトに入れて読むことを想定する（GET /games/:id/rules）。 */
export interface GameDocs {
  /** 1〜2文の概要。/games の一覧に出す。 */
  summary: string;
  /** Markdown。目的・手番・勝敗の決まり方・時間切れの扱い（onTimeout / onResign を定義したらその扱いも）。 */
  rules: string;
  /** Markdown。view の各フィールドの意味と、視点（プレイヤー／観戦者）による違い。 */
  view: string;
  /** 行動の例。actionSchema を満たすこと（テストで検証する）。 */
  examples: { action: unknown; meaning: string }[];
}

/** すべてのゲームが実装する。副作用なしの純粋関数にすること。 */
export interface GameDefinition<S, A> {
  id: string;
  minPlayers: number;
  maxPlayers: number;
  actionSchema: z.ZodType<A>;
  docs: GameDocs;
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
  /**
   * 投了時の処理（任意）。pid は投了したプレイヤー。試合中ならいつでも（手番でなくても）呼ばれる。
   * 未定義のゲームは「投了したプレイヤーの負け」（残りが勝者）で終了する。3人以上のゲームで
   * 投了者だけを抜けさせて続けたいときなどに定義する（result が null の状態を返せば試合は続く）。
   * 受け付けられない投了（すでに抜けたプレイヤーなど）は GameError を throw する。
   */
  onResign?(s: S, pid: string, rng: Rng): S;
  /**
   * 練習相手（options.practice）の打ち方（任意）。pid が今行動できるときだけ呼ばれ、合法手を返すこと。
   * 未定義のゲームは合法手からランダムに選ぶ。ランダムでは決着しにくいゲームは、決着に向かう簡単な打ち方を定義する。
   */
  practiceAction?(s: S, pid: string, rng: Rng): A;
}

// メソッド記法のパラメータは双変なので、個別のゲームを unknown 版として登録できる。
export type AnyGame = GameDefinition<unknown, unknown>;
