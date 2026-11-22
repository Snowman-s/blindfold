import { z } from "zod";
import type { GameResult } from "../games/types";

export const ROOM_STATUSES = ["waiting", "playing", "finished"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** 行動の本体（WS の action メッセージと REST の POST /rooms/:id/action で共有）。 */
export const actionBody = z.object({ turn: z.number().int().min(0), action: z.unknown() });

/** クライアント → サーバー */
export const clientMessage = z.discriminatedUnion("type", [
  actionBody.extend({ type: z.literal("action") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("resign") }),
]);

/** 試合が終わった理由。normal = ゲームのルールによる決着。 */
export const END_REASONS = ["normal", "timeout", "resign"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** WS の close コード：退出したプレイヤーの接続をサーバーが閉じるとき（再接続しても無駄なことを伝える）。 */
export const CLOSE_LEFT_ROOM = 4000;

/** WS の close コード：ルームが削除されたとき（放置・終了から一定期間後の掃除。再接続しても ROOM_NOT_FOUND）。 */
export const CLOSE_ROOM_DELETED = 4001;

// 4002 は「エンジンが無くなったルーム（GAME_REMOVED）」用に取ってある（TODO.md）。

/**
 * WS の close コード：エラーになるメッセージを送りすぎた接続を閉じるとき（不正なメッセージ 20 通で1リクエストを消費するため）。
 * クライアントのバグなので、すぐに再接続しても同じことになる。
 */
export const CLOSE_TOO_MANY_ERRORS = 4003;

/** WS の close コード：同じ席の接続が上限を超えたので、いちばん古い接続を閉じるとき（新しい接続が残る。再接続しない）。 */
export const CLOSE_REPLACED = 4004;

/** 1つの席（トークン）で同時に開ける WS の数。超えたらいちばん古い接続を CLOSE_REPLACED で閉じる。 */
export const MAX_SOCKETS_PER_SEAT = 4;

/** 1ルームの観戦者の WS の数の上限。超えた接続は 503 TOO_MANY_CONNECTIONS で拒否する。 */
export const MAX_SPECTATOR_SOCKETS = 50;

/**
 * WS のエラーの上限（リーキーバケット）。エラーを返すたびに1つ溜まり、WS_STRIKE_DECAY_MS ごとに1つ減る。
 * WS_MAX_STRIKES を超えたら CLOSE_TOO_MANY_ERRORS で閉じる。成功した行動・投了、自動応答の ping は数えない。
 */
export const WS_MAX_STRIKES = 20;
export const WS_STRIKE_DECAY_MS = 10_000;

/**
 * WS の close コード：ルームのゲーム（または作成時のルールの版）がサーバーから無くなったとき（GAME_REMOVED。
 * 再接続しても 410）。
 */
export const CLOSE_GAME_REMOVED = 4002;

/** REST / DO 共通のエラーレスポンスの本体。 */
export const errBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * ルームの状態（REST の GET /rooms/:id/state などの本体）。WS の state メッセージはこれに type: "state" を付けただけ。
 * 2つを別々に定義するとフィールドがずれるので、ここを唯一の定義にする。
 */
export interface RoomState {
  game: string;
  /** ルームの作成時に記録したルールの版 */
  rulesVersion: number;
  /** ゲーム固有のオプション（既定値を補った後の値）。オプションを持たないゲームは null */
  gameOptions: unknown;
  status: RoomStatus;
  turn: number;
  players: string[];
  currentPlayers: string[];
  view: unknown;
  /** 呼び出したプレイヤーが今行動でき、ゲームが合法手を列挙するときだけ付く */
  legal?: unknown[];
  /** 現在の手番の締め切り（epoch ms）。playing 以外は null */
  deadline: number | null;
  /**
   * 今の手番が始まったターン。同時手番では誰かが出すたびに turn が進むが、phaseTurn は同時手番の間は変わらない
   * （同時手番でなければ turn と同じ）。自分が送った turn が phaseTurn 以上なのに currentPlayers に自分がいる state は、
   * 自分の手より前に作られて行き違いで届いたもの。playing 以外は null
   */
  phaseTurn: number | null;
  /** サーバーの現在時刻（epoch ms）。クライアントは deadline - now で残り時間を出す（時計ずれ対策） */
  now: number;
  result: GameResult | null;
  /** 終了後に誰かが再戦を申し込んだときだけ付く */
  rematch?: RematchInfo;
}

/** 再戦の案内。roomId は新しいルーム、requestedBy は申し込んだ（このルームでの）プレイヤー ID。 */
export interface RematchInfo {
  roomId: string;
  requestedBy: string[];
}

/**
 * サーバー → クライアント。error の code は REST と同じコード（読み替えない）。値は増えうる。
 */
export type ServerMessage =
  | ({ type: "state" } & RoomState)
  | { type: "error"; code: string; message: string }
  | { type: "end"; winners: string[]; scores?: Record<string, number>; reason: EndReason }
  | { type: "pong" };
