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
  /** Markdown。ゲーム固有のオプション（optionsSchema）の各項目の意味と既定値。optionsSchema を定義したゲームは必須（テストで検証する）。 */
  options?: string;
}

/**
 * すべてのゲームが実装する。副作用なしの純粋関数にすること。
 * O はゲーム固有のオプション（optionsSchema の出力）。オプションを持たないゲームは null。
 */
export interface GameDefinition<S, A, O = null> {
  id: string;
  /**
   * ルールの版（1 から始める整数）。「シード + 行動ログで試合を再現できる」ことが崩れる変更をしたら必ず上げる：
   * ルール・action の形・勝敗の決め方・init / apply / onTimeout / onResign の結果が変わる変更、
   * rng を引く順番や回数が変わる変更（見た目のルールが同じでも、過去のログから別の試合が再現されてしまう）。
   * docs の文言・view の形・practiceAction だけの変更では上げない（view の破壊的変更は viewVersion）。
   * ルームは作成時（init）の値を記録する。サーバーは古い版のエンジンを残さないので、上げると前の版で作ったルームは
   * 待機中・進行中・終了済みとも GAME_REMOVED になる（リプレイできなくなる。終了済みなら /log は返す）。
   */
  rulesVersion: number;
  /**
   * view の形の版（1 から始める整数）。view の破壊的変更（フィールドの削除・改名・型や意味の変更、
   * enum への値の追加。配る viewSchema の enum は閉じているので）をしたら上げる。フィールドの追加では上げない。/games と /rules で配り、
   * クライアントは自分が書かれた版と比べて作り直しが要るかを判断する。リプレイには関わらないので、
   * 上げても古い版のエンジンを残す必要はない（進行中の試合は新しい形の view を受け取る）。
   */
  viewVersion: number;
  minPlayers: number;
  maxPlayers: number;
  actionSchema: z.ZodType<A>;
  /**
   * view の返り値の形（全視点の和集合。視点によって無いフィールドは optional にし、describe に誰に付くかを書く）。
   * JSON Schema にして /games/:id/rules で配り、型付きクライアントが推測なしで書けるようにする。
   * 実際の view がこれを満たすことは all-games テストで検証する（strictObject にして余計なフィールドも検出する）。
   */
  viewSchema: z.ZodType;
  docs: GameDocs;
  /**
   * ゲーム固有のオプション（任意）。ルーム作成時の gameOptions をこれで検証し（未知のキーは拒否したいので strictObject にする）、
   * 既定値を補った値を init に渡す。その値はルームの meta・/log・D1 の matches に記録され、「シード + オプション + ログ」で試合を再現する。
   * 未定義のゲームに gameOptions を渡すと 400。オプションの意味を変える変更（既定値の変更も）は rulesVersion を上げる。
   * 空のオブジェクト {} を受け付けること（gameOptions を省略したときは {} を parse する）。
   */
  optionsSchema?: z.ZodType<O>;
  /**
   * seed は文字列（サーバーは 128 ビットの乱数を発行する）。乱数は createRng(seed) で作る。
   * options は optionsSchema で parse した値（optionsSchema が無ければ null）。
   */
  init(players: string[], seed: Seed, options: O): S;
  currentPlayers(s: S): string[];
  /**
   * pid が今打てる合法手の一覧（任意）。定義すると state の legal として配る。
   * 合法手を列挙できない・しきれないゲームでは定義しない。そのときは legal を送らず、行動は apply だけで検証する
   * （その場合 practiceAction は必須。all-games テストで検証する）。
   */
  legalActions?(s: S, pid: string): A[];
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
   * 練習相手（options.practice）の打ち方。pid が今行動できるときだけ呼ばれ、合法手を返すこと。
   * 未定義のゲームは合法手（legalActions）からランダムに選ぶ。legalActions を定義しないゲームでは必須。
   * ランダムでは決着しにくいゲームは、決着に向かう簡単な打ち方を定義する。
   */
  practiceAction?(s: S, pid: string, rng: Rng): A;
}

// メソッド記法のパラメータは双変なので、個別のゲームを unknown 版として登録できる。
export type AnyGame = GameDefinition<unknown, unknown, unknown>;
