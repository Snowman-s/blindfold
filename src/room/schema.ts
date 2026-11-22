/**
 * GameRoom（DO）内の SQLite のスキーマと移行。
 *
 * テーブルは BASE_SCHEMA（版 1）を作ってから MIGRATIONS を順に流して作る。新しいルームも既存のルームも
 * 同じ手順を通るので、「新規作成の形」と「移行後の形」がずれることはない。
 *
 * 列やテーブルを足すとき：MIGRATIONS の末尾に関数を1つ足すだけ（BASE_SCHEMA は書き換えない）。
 * MIGRATIONS[i] は版 i+1 → i+2。既存のルームはコンストラクタ（blockConcurrencyWhile）で移行される。
 * 移行は1段ずつ「変更 + schemaVersion の更新」を1トランザクションで行うので、途中で落ちても次に起きたとき続きから流れる。
 */

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, token TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT);
  CREATE TABLE IF NOT EXISTS actions(turn INTEGER, player TEXT, action TEXT, at INTEGER);
  CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), turn INTEGER, state TEXT);
`;

export type Migration = (sql: SqlStorage) => void;

/** 版 2 以降への移行。末尾に足していく（並べ替え・削除はしない）。 */
export const MIGRATIONS: Migration[] = [];

/** 今のコードが期待するスキーマの版。 */
export const SCHEMA_VERSION = MIGRATIONS.length + 1;

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

function readVersion(sql: SqlStorage): number | null {
  const rows = sql.exec("SELECT value FROM meta WHERE key = 'schemaVersion'").toArray();
  return rows.length ? Number(rows[0]!.value) : null;
}

function writeVersion(sql: SqlStorage, v: number): void {
  sql.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('schemaVersion', ?)", String(v));
}

/** 新しいルームのテーブルを作る（init のトランザクションの中で呼ぶので、ここではトランザクションを張らない）。 */
export function createTables(sql: SqlStorage, migrations: Migration[] = MIGRATIONS): void {
  sql.exec(BASE_SCHEMA);
  for (const m of migrations) m(sql);
  writeVersion(sql, migrations.length + 1);
}

/**
 * 既存のルームを今の版まで移行する。テーブルが作成済みのルームでだけ呼ぶこと。
 * 保存されている版がコードより新しい（古いコードに戻した）ときは何もしない。
 */
export function migrateSchema(storage: Storage, migrations: Migration[] = MIGRATIONS): void {
  const target = migrations.length + 1;
  const current = readVersion(storage.sql);
  if (current === null) {
    console.error("room storage has no schemaVersion; skipping migration");
    return;
  }
  if (current > target) {
    console.error(`room schema version ${current} is newer than this code (${target}); skipping migration`);
    return;
  }
  for (let v = current; v < target; v++) {
    storage.transactionSync(() => {
      migrations[v - 1]!(storage.sql);
      writeVersion(storage.sql, v + 1);
    });
  }
}
