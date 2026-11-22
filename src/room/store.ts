import { z } from "zod";
import type { GameResult } from "../games/types";
import { roomOptions, type RoomOptions } from "../lib/options";
import type { EndReason, RematchInfo, RoomStatus } from "../lib/protocol";
import type { LogEntry } from "../lib/replay";
import type { Seed } from "../lib/rng";
import type { Snapshot } from "./logic";
import { createTables } from "./schema";

/**
 * GameRoom（DO）内の SQLite の読み書き。テーブルの形は schema.ts。
 * 値の意味づけ（JSON の符号化・既定値）はここに閉じ込め、GameRoom からは SQL を書かない。
 * 書き込みはすべて GameRoom の transactionSync の中で呼ぶ。
 */

/**
 * サーバーが書くログの行は player = "" で表す（プレイヤー ID と衝突しない）。
 * 持ち時間切れは action = {"$timeout":[...]}、投了は action = {"$resign":"p1"}。
 */
const SYSTEM_PLAYER = "";
const systemEvent = z.union([
  z.strictObject({ $timeout: z.array(z.string()) }),
  z.strictObject({ $resign: z.string() }),
]);
export type SystemEvent = z.infer<typeof systemEvent>;

export class RoomStore {
  /** テーブルが作成済み（= init 済みのルーム）か。 */
  ready: boolean;

  constructor(private readonly sql: SqlStorage) {
    // テーブルは init で初めて作る。存在しないルーム ID へのアクセスでストレージを書かないよう、ここでは読むだけ。
    this.ready = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  /** 新しいルームのテーブルを作る（列やテーブルを足すときは schema.ts の MIGRATIONS に書く）。 */
  createTables(): void {
    createTables(this.sql);
    this.ready = true;
  }

  // ---- meta ----

  getMeta(key: string): string | null {
    if (!this.ready) return null;
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (rows[0]!.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, value);
  }

  private getJson<T>(key: string, fallback: T): T {
    const v = this.getMeta(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  }

  private getNumber(key: string): number | null {
    const v = this.getMeta(key);
    return v === null ? null : Number(v);
  }

  gameId(): string | null {
    return this.getMeta("gameId");
  }

  /** init 済みのルームか。 */
  exists(): boolean {
    return this.gameId() !== null;
  }

  status(): RoomStatus {
    return this.getMeta("status") as RoomStatus;
  }

  seed(): Seed {
    return this.getMeta("seed")!;
  }

  /** 試合の開始時に記録したルールの版（waiting の間は null）。 */
  rulesVersion(): number | null {
    return this.getNumber("rulesVersion");
  }

  /** ゲーム固有のオプション（init で既定値を補って保存した値。オプションの無いゲームは null）。 */
  gameOptions(): unknown {
    return this.getJson<unknown>("gameOptions", null);
  }

  /** ルームのオプション。保存時に検証済みだが、読めなければ既定値（{}）として扱う。 */
  options(): RoomOptions {
    const parsed = roomOptions.safeParse(this.getJson<unknown>("options", {}));
    return parsed.success ? parsed.data : {};
  }

  /** 現在の手番の締め切り（epoch ms）。status は見ない。 */
  deadline(): number | null {
    return this.getNumber("deadline");
  }

  /** 練習相手（サーバー側の Bot）のプレイヤー ID。 */
  bots(): string[] {
    return this.getJson<string[]>("bots", []);
  }

  /** 時間切れ・投了による決着（ゲーム自身の結果より優先度は低い）。 */
  forfeit(): GameResult | null {
    return this.getJson<GameResult | null>("forfeit", null);
  }

  /** 試合が終わった理由。時間切れ・投了で終わったときだけ書く。無ければ通常の決着。 */
  endReason(): EndReason {
    const r = this.getMeta("endReason");
    return r === "timeout" || r === "resign" ? r : "normal";
  }

  /** 再戦用に席を予約したルームなら、元のルームのプレイヤー ID → このルームの席 ID。 */
  reservedSeats(): Record<string, string> | null {
    return this.getJson<Record<string, string> | null>("reserved", null);
  }

  rematchInfo(): RematchInfo | null {
    const roomId = this.getMeta("rematchRoomId");
    const by = this.getMeta("rematchRequested");
    return roomId && by ? { roomId, requestedBy: JSON.parse(by) as string[] } : null;
  }

  /**
   * 新しい席の ID を払い出す（p1, p2, ... の連番。退出しても番号は再利用しない）。
   * 再利用すると、閉じ損ねた退出者の WS（attachment に playerId を持つ）が新しい参加者の view を受け取れてしまう。
   * seq は番号と揃える（手番の順 = ORDER BY seq）。nextSeat は init で書く。
   */
  allocateSeat(): { id: string; seq: number } {
    const n = Number(this.getMeta("nextSeat")!);
    this.setMeta("nextSeat", String(n + 1));
    return { id: `p${n}`, seq: n - 1 };
  }

  // ---- players ----

  playerIds(): string[] {
    return this.sql
      .exec("SELECT id FROM players ORDER BY seq")
      .toArray()
      .map((r) => r.id as string);
  }

  /** 席順の (プレイヤー ID, ユーザー ID)。D1 への結果の書き込み用。 */
  playerUsers(): { id: string; userId: string | null }[] {
    return this.sql
      .exec("SELECT id, user_id FROM players ORDER BY seq")
      .toArray()
      .map((r) => ({ id: r.id as string, userId: (r.user_id as string | null) ?? null }));
  }

  userOf(pid: string): string | null {
    const row = this.sql.exec("SELECT user_id FROM players WHERE id = ?", pid).toArray()[0];
    return (row?.user_id as string | null | undefined) ?? null;
  }

  playerByToken(token: string | null): string | null {
    if (!token) return null;
    const rows = this.sql.exec("SELECT id FROM players WHERE token = ?", token).toArray();
    return rows.length ? (rows[0]!.id as string) : null;
  }

  tokenOf(pid: string): string | null {
    const row = this.sql.exec("SELECT token FROM players WHERE id = ?", pid).toArray()[0];
    return (row?.token as string | undefined) ?? null;
  }

  /** 席 ID → 今のトークン。 */
  seatTokens(): Map<string, string> {
    return new Map(
      this.sql
        .exec("SELECT id, token FROM players")
        .toArray()
        .map((r) => [r.id as string, r.token as string]),
    );
  }

  addPlayer(id: string, token: string, seq: number, userId: string | null): void {
    this.sql.exec("INSERT INTO players(id, token, seq, user_id) VALUES (?, ?, ?, ?)", id, token, seq, userId);
  }

  removePlayer(id: string): void {
    this.sql.exec("DELETE FROM players WHERE id = ?", id);
  }

  // ---- snapshot ----

  loadSnapshot(): Snapshot {
    const r = this.sql.exec("SELECT turn, state FROM snapshot WHERE id = 1").toArray()[0]!;
    return { turn: r.turn as number, state: JSON.parse(r.state as string) };
  }

  saveSnapshot(turn: number, state: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO snapshot(id, turn, state) VALUES (1, ?, ?)", turn, JSON.stringify(state));
  }

  // ---- 行動ログ ----

  /** プレイヤーの行動（符号化は readLog と対）。 */
  appendAction(turn: number, player: string, action: unknown): void {
    this.appendRow(turn, player, action);
  }

  /** サーバーが書く行（持ち時間切れ・投了）。 */
  appendSystem(turn: number, event: SystemEvent): void {
    this.appendRow(turn, SYSTEM_PLAYER, event);
  }

  private appendRow(turn: number, player: string, action: unknown): void {
    this.sql.exec(
      "INSERT INTO actions(turn, player, action, at) VALUES (?, ?, ?, ?)",
      turn,
      player,
      JSON.stringify(action),
      Date.now(),
    );
  }

  /** 行動ログ。知らない形のサーバー行があれば throw する（時間切れなどと読み替えるとリプレイが実際の試合とずれる）。 */
  readLog(): LogEntry[] {
    return this.sql
      .exec("SELECT turn, player, action, at FROM actions ORDER BY turn")
      .toArray()
      .map((r) => {
        const action = JSON.parse(r.action as string) as unknown;
        const at = r.at as number;
        if (r.player === SYSTEM_PLAYER) {
          const base = { turn: r.turn as number, player: null, action: null, at };
          const ev = systemEvent.safeParse(action);
          if (!ev.success) throw new Error(`corrupt system log row at turn ${base.turn}`);
          return "$resign" in ev.data ? { ...base, resign: ev.data.$resign } : { ...base, timeout: ev.data.$timeout };
        }
        return { turn: r.turn as number, player: r.player as string, action, at };
      });
  }
}
