import { z } from "zod";
import type { GameResult } from "../games/types";
import { roomOptions, type RoomOptions } from "../lib/options";
import type { EndReason, LastEvent, RematchInfo, RoomStatus } from "../lib/protocol";
import type { LogEntry } from "../lib/replay";
import type { Seed } from "../lib/rng";
import type { Settlement, Snapshot } from "./logic";
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

/** meta の値の符号化（meta.value は TEXT）。 */
interface Codec<T> {
  enc(v: T): string;
  dec(s: string): T;
}
const text = <T extends string = string>(): Codec<T> => ({ enc: (v) => v, dec: (s) => s as T });
const num: Codec<number> = { enc: String, dec: Number };
/** 立っているときだけ "1" を書くフラグ。 */
const flag: Codec<true> = { enc: () => "1", dec: () => true };
const json = <T>(): Codec<T> => ({ enc: (v) => JSON.stringify(v), dec: (s) => JSON.parse(s) as T });

/**
 * meta のキーと値の型。新しいキーはここに足す（GameRoom から文字列のキーを直接書かない）。
 * schemaVersion は schema.ts が読み書きする。
 */
const META = {
  roomId: text(),
  gameId: text(),
  /** ルームの作成時（init）に記録したルールの版 */
  rulesVersion: num,
  options: json<unknown>(),
  gameOptions: json<unknown>(),
  hostTokenHash: text(),
  status: text<RoomStatus>(),
  createdAt: num,
  startedAt: num,
  finishedAt: num,
  /** このルームを消す時刻。待機中は最後の変更から、終了後は終了から数える。試合中は無い */
  cleanupAt: num,
  /** 現在の手番の締め切り */
  deadline: num,
  /** 今の同時手番が始まったターン（これ以降の turn で送られた行動は、送った人がまだ行動できれば受け付ける。acceptsTurn） */
  phaseTurn: num,
  /** 次に払い出す席の番号（allocateSeat） */
  nextSeat: num,
  /** 再戦ルームの予約席：元のルームのプレイヤー ID → このルームの席 ID */
  reserved: json<Record<string, string>>(),
  seed: text<Seed>(),
  /** 練習相手の席 */
  bots: json<string[]>(),
  /** 時間切れ・投了による決着 */
  forfeit: json<GameResult>(),
  /** 終了時に確定した結果 */
  result: json<GameResult>(),
  endReason: text<EndReason>(),
  /** 一覧の索引（D1 の rooms）に書いた回数。書いたことのないルームは無い */
  indexRev: num,
  indexedAt: num,
  /** エンジンが無くなって畳んだ（retire） */
  retired: flag,
  /** D1 に結果を書き終えた */
  persisted: flag,
  persistAttempts: num,
  /** D1 への書き込みを諦めた */
  persistGaveUp: flag,
  /** 再戦ルームの ID（最初の rematch で決める） */
  rematchRoomId: text(),
  /** 再戦ルームを作り終えた */
  rematchReady: flag,
  /** 再戦を申し込んだプレイヤー */
  rematchRequested: json<string[]>(),
} as const;
export type MetaKey = keyof typeof META;
export type MetaValue<K extends MetaKey> = (typeof META)[K] extends Codec<infer T> ? T : never;

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

  /** meta の値（無ければ null）。キーと型は META。 */
  getMeta<K extends MetaKey>(key: K): MetaValue<K> | null {
    if (!this.ready) return null;
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (META[key].dec(rows[0]!.value as string) as MetaValue<K>) : null;
  }

  setMeta<K extends MetaKey>(key: K, value: MetaValue<K>): void {
    const codec = META[key] as Codec<MetaValue<K>>;
    this.sql.exec("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, codec.enc(value));
  }

  deleteMeta(key: MetaKey): void {
    this.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  /** 新しいルームの meta を書く（init のトランザクションの中で、createTables の後に呼ぶ）。 */
  initMeta(m: {
    roomId: string;
    gameId: string;
    rulesVersion: number;
    options: RoomOptions;
    gameOptions: unknown;
    hostTokenHash: string;
    createdAt: number;
    cleanupAt: number;
    reserved: Record<string, string> | null;
  }): void {
    this.setMeta("roomId", m.roomId);
    this.setMeta("gameId", m.gameId);
    this.setMeta("rulesVersion", m.rulesVersion);
    this.setMeta("options", m.options);
    this.setMeta("gameOptions", m.gameOptions);
    this.setMeta("hostTokenHash", m.hostTokenHash);
    this.setMeta("status", "waiting");
    this.setMeta("createdAt", m.createdAt);
    this.setMeta("cleanupAt", m.cleanupAt);
    // 再戦ルームでは、練習相手などの追加の席は予約席の後ろから
    this.setMeta("nextSeat", m.reserved ? Object.keys(m.reserved).length + 1 : 1);
    if (m.reserved) this.setMeta("reserved", m.reserved);
  }

  /** commit で確定した状態（logic.ts の settle）を書く。 */
  recordSettlement(s: Settlement): void {
    switch (s.kind) {
      case "waiting":
        this.setMeta("cleanupAt", s.cleanupAt);
        return;
      case "playing":
        this.setMeta("deadline", s.deadline);
        this.setMeta("phaseTurn", s.phaseTurn);
        return;
      case "finished":
        this.setMeta("status", "finished");
        this.setMeta("result", s.result);
        this.setMeta("finishedAt", s.finishedAt);
        this.setMeta("cleanupAt", s.cleanupAt);
        return;
    }
  }

  roomId(): string | null {
    return this.getMeta("roomId");
  }

  gameId(): string | null {
    return this.getMeta("gameId");
  }

  /** init 済みのルームか。 */
  exists(): boolean {
    return this.gameId() !== null;
  }

  status(): RoomStatus {
    return this.getMeta("status")!;
  }

  seed(): Seed {
    return this.getMeta("seed")!;
  }

  /** ルームの作成時（init）に記録したルールの版。 */
  rulesVersion(): number {
    return this.getMeta("rulesVersion")!;
  }

  /** ゲーム固有のオプション（init で既定値を補って保存した値。オプションの無いゲームは null）。 */
  gameOptions(): unknown {
    return this.getMeta("gameOptions") ?? null;
  }

  /** ルームのオプション。保存時に検証済みだが、読めなければ既定値（{}）として扱う。 */
  options(): RoomOptions {
    const parsed = roomOptions.safeParse(this.getMeta("options") ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** 現在の手番の締め切り（epoch ms）。status は見ない。 */
  deadline(): number | null {
    return this.getMeta("deadline");
  }

  /** このルームを消す時刻（epoch ms）。待機中は最後の変更から、終了後は終了から数える。 */
  cleanupAt(): number | null {
    return this.getMeta("cleanupAt");
  }

  /** 一覧の索引（D1 の rooms）を最後に書いた（書こうとした）時刻。索引に載せないルームは null。 */
  indexedAt(): number | null {
    return this.getMeta("indexedAt");
  }

  /** 一覧の索引に書いたことがあるか（掃除のときに D1 の行を消すかどうか）。 */
  indexed(): boolean {
    return this.getMeta("indexRev") !== null;
  }

  /**
   * 索引に書く rev を払い出し、書いた時刻を残す。rev は呼ぶたびに増える
   * （同期処理の中で状態と一緒に読むので、後の rev ほど新しい状態）。
   */
  nextIndexRev(now: number): number {
    const rev = (this.getMeta("indexRev") ?? 0) + 1;
    this.setMeta("indexRev", rev);
    this.setMeta("indexedAt", now);
    return rev;
  }

  /** 練習相手（サーバー側の Bot）のプレイヤー ID。 */
  bots(): string[] {
    return this.getMeta("bots") ?? [];
  }

  /** 時間切れ・投了による決着（ゲーム自身の結果より優先度は低い）。 */
  forfeit(): GameResult | null {
    return this.getMeta("forfeit");
  }

  /**
   * 終了時に確定した結果（finished のときだけある）。D1 への書き込みの再試行と、終了後に配る state はこれを使う
   * （エンジンが無くなっても D1 に書けるように、また後から計算し直した結果とずれないように）。
   */
  result(): GameResult | null {
    return this.getMeta("result");
  }

  /** 試合が終わった理由。時間切れ・投了で終わったときだけ書く。無ければ通常の決着。 */
  endReason(): EndReason {
    const r = this.getMeta("endReason");
    return r === "timeout" || r === "resign" ? r : "normal";
  }

  /** エンジンが無くなって畳んだルームか（retire）。 */
  retired(): boolean {
    return this.getMeta("retired") === true;
  }

  /** 終了済みで、D1 への書き込みが済んでおらず、諦めてもいないか。 */
  persistPending(): boolean {
    return this.status() === "finished" && !this.getMeta("persisted") && !this.getMeta("persistGaveUp");
  }

  /** 再戦用に席を予約したルームなら、元のルームのプレイヤー ID → このルームの席 ID。 */
  reservedSeats(): Record<string, string> | null {
    return this.getMeta("reserved");
  }

  rematchInfo(): RematchInfo | null {
    const roomId = this.getMeta("rematchRoomId");
    const requestedBy = this.getMeta("rematchRequested");
    return roomId && requestedBy ? { roomId, requestedBy } : null;
  }

  /** 再戦の申し込みを記録する。新しく申し込んだなら true（もう申し込んでいれば false）。 */
  requestRematch(pid: string): boolean {
    const requested = this.getMeta("rematchRequested") ?? [];
    if (requested.includes(pid)) return false;
    this.setMeta("rematchRequested", [...requested, pid]);
    return true;
  }

  /**
   * 新しい席の ID を払い出す（p1, p2, ... の連番。退出しても番号は再利用しない）。
   * 再利用すると、閉じ損ねた退出者の WS（attachment に playerId を持つ）が新しい参加者の view を受け取れてしまう。
   * seq は番号と揃える（手番の順 = ORDER BY seq）。nextSeat は init で書く。
   */
  allocateSeat(): { id: string; seq: number } {
    const n = this.getMeta("nextSeat")!;
    this.setMeta("nextSeat", n + 1);
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

  /** このユーザーがすでに席にいるか。 */
  hasUser(userId: string): boolean {
    return this.sql.exec("SELECT 1 FROM players WHERE user_id = ?", userId).toArray().length > 0;
  }

  userOf(pid: string): string | null {
    const row = this.sql.exec("SELECT user_id FROM players WHERE id = ?", pid).toArray()[0];
    return (row?.user_id as string | null | undefined) ?? null;
  }

  // players.token にはトークンのハッシュ（hashToken）を入れる。トークンそのものは保存しない。

  /** トークンのハッシュから席を引く。 */
  playerByTokenHash(hash: string | null): string | null {
    if (!hash) return null;
    const rows = this.sql.exec("SELECT id FROM players WHERE token = ?", hash).toArray();
    return rows.length ? (rows[0]!.id as string) : null;
  }

  tokenHashOf(pid: string): string | null {
    const row = this.sql.exec("SELECT token FROM players WHERE id = ?", pid).toArray()[0];
    return (row?.token as string | undefined) ?? null;
  }

  /** 席 ID → 今のトークンのハッシュ。 */
  seatTokenHashes(): Map<string, string> {
    return new Map(
      this.sql
        .exec("SELECT id, token FROM players")
        .toArray()
        .map((r) => [r.id as string, r.token as string]),
    );
  }

  addPlayer(id: string, tokenHash: string, seq: number, userId: string | null): void {
    this.sql.exec("INSERT INTO players(id, token, seq, user_id) VALUES (?, ?, ?, ?)", id, tokenHash, seq, userId);
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
      .map(decodeRow);
  }

  /**
   * 最後の行（この状態を作った出来事）から action を除いたもの。行が無ければ null。
   * 状態を作るたびに呼ぶので、索引の無い turn ではなく rowid で引く（行はターン順に追記するだけなので最大の rowid が最後のターン）。
   */
  lastEvent(): LastEvent | null {
    const r = this.sql.exec("SELECT turn, player, action, at FROM actions ORDER BY rowid DESC LIMIT 1").toArray()[0];
    if (!r) return null;
    const { action: _, ...rest } = decodeRow(r);
    return rest;
  }
}

/** actions の1行を LogEntry に戻す（appendAction / appendSystem と対）。 */
function decodeRow(r: Record<string, SqlStorageValue>): LogEntry {
  const action = JSON.parse(r.action as string) as unknown;
  const turn = r.turn as number;
  const at = r.at as number;
  if (r.player === SYSTEM_PLAYER) {
    const base = { turn, player: null, action: null, at };
    const ev = systemEvent.safeParse(action);
    if (!ev.success) throw new Error(`corrupt system log row at turn ${turn}`);
    return "$resign" in ev.data ? { ...base, resign: ev.data.$resign } : { ...base, timeout: ev.data.$timeout };
  }
  return { turn, player: r.player as string, action, at };
}
