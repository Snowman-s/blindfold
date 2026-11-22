import type { GameResult } from "../games/types";
import { gameOptionsKey } from "../lib/options";
import type { EndReason, RoomStatus } from "../lib/protocol";
import type { Seed } from "../lib/rng";
import { outcomeOf } from "./logic";

/**
 * GameRoom が D1 に書く文（試合結果と、一覧用の rooms 索引）。テーブルの形は migrations/。
 * 文を組み立てるだけで実行はしない（実行・再試行は GameRoom）。
 */

export interface FinishedMatch {
  id: string;
  game: string;
  rulesVersion: number;
  seed: Seed;
  gameOptions: unknown;
  /** 席順 */
  players: { id: string; userId: string | null }[];
  startedAt: number;
  finishedAt: number;
  reason: EndReason;
  result: GameResult;
  /** 時間切れ・投了による決着か（引き分けにしない） */
  byForfeit: boolean;
}

/** matches と results への書き込み。roomId をキーに冪等（INSERT OR IGNORE）なので何度再試行してもよい。 */
export function matchStatements(db: D1Database, m: FinishedMatch): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "INSERT OR IGNORE INTO matches(id, game, rules_version, seed, game_options, players, started_at, finished_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        m.id,
        m.game,
        m.rulesVersion,
        m.seed,
        gameOptionsKey(m.gameOptions),
        JSON.stringify(m.players.map((p) => p.id)),
        m.startedAt,
        m.finishedAt,
        m.reason,
      ),
    ...m.players.map((p) =>
      db
        .prepare("INSERT OR IGNORE INTO results(match_id, player_id, user_id, outcome, score) VALUES (?, ?, ?, ?, ?)")
        .bind(m.id, p.id, p.userId, outcomeOf(m.result, m.byForfeit, p.id), m.result.scores?.[p.id] ?? null),
    ),
  ];
}

export interface RoomIndexRow {
  id: string;
  game: string;
  gameOptions: unknown;
  status: RoomStatus;
  players: number;
  maxPlayers: number;
  autoStart: boolean;
  turnTimeMs: number;
  createdAt: number;
  updatedAt: number;
  /** DO 内の単調増加カウンタ */
  rev: number;
}

/**
 * 一覧用の索引（rooms）を上書きする文。D1 側は rev が大きいときだけ上書きするので、
 * await の間に追い越した古い書き込みが新しい状態を戻すことはない。
 */
export function roomIndexStatement(db: D1Database, r: RoomIndexRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rooms(id, game, game_options, status, players, max_players, auto_start, turn_time_ms, created_at, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, players = excluded.players, updated_at = excluded.updated_at, rev = excluded.rev
       WHERE excluded.rev > rooms.rev`,
    )
    .bind(
      r.id,
      r.game,
      gameOptionsKey(r.gameOptions),
      r.status,
      r.players,
      r.maxPlayers,
      r.autoStart ? 1 : 0,
      r.turnTimeMs,
      r.createdAt,
      r.updatedAt,
      r.rev,
    );
}
