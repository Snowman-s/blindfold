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

/** REST / DO 共通のエラーレスポンスの本体。 */
export const errBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * ルームの状態（REST の GET /rooms/:id/state などの本体）。WS の state メッセージはこれに type: "state" を付けただけ。
 * 2つを別々に定義するとフィールドがずれるので、ここを唯一の定義にする。
 */
export interface RoomState {
  game: string;
  /** 試合の開始時に記録したルールの版。waiting の間は null */
  rulesVersion: number | null;
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
