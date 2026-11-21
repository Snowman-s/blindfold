-- ユーザー（任意）。API キーはハッシュだけ保存する。
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 終了した試合。id はルーム ID。
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  seed TEXT NOT NULL, -- 128 ビット（16 進 32 文字）。INTEGER だと数字だけのシードが数値に変換される
  players TEXT NOT NULL, -- JSON 配列
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  reason TEXT NOT NULL -- 'normal' | 'timeout'
);
CREATE INDEX idx_matches_finished ON matches(finished_at DESC);

-- 試合ごと・プレイヤーごとの結果。
CREATE TABLE results (
  match_id TEXT NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  outcome TEXT NOT NULL, -- 'win' | 'loss' | 'draw'
  score REAL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX idx_results_user ON results(user_id);
