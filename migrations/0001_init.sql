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
  rules_version INTEGER NOT NULL, -- 試合を始めたときのルールの版（GameDefinition.rulesVersion）
  seed TEXT NOT NULL, -- 128 ビット（16 進 32 文字）。INTEGER だと数字だけのシードが数値に変換される
  game_options TEXT NOT NULL, -- ゲーム固有のオプション（既定値を補った値の JSON。オプションの無いゲームは 'null'）
  players TEXT NOT NULL, -- JSON 配列
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  reason TEXT NOT NULL -- 'normal' | 'timeout' | 'resign'
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

-- ルーム一覧（GET /rooms、POST /quickmatch）用の索引。本物の状態は GameRoom DO が持ち、ここは best-effort。
-- 書き込むのは作成・join・開始・終了のときだけ（1手ごとには書かない）。unlisted / practice のルームは載せない。
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  game_options TEXT NOT NULL, -- matches.game_options と同じ形。クイックマッチは既定のオプションのルームだけに入る
  status TEXT NOT NULL, -- 'waiting' | 'playing' | 'finished'
  players INTEGER NOT NULL, -- 参加人数
  max_players INTEGER NOT NULL,
  auto_start INTEGER NOT NULL, -- 0 | 1
  turn_time_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL -- DO 内の単調増加カウンタ。遅れて届いた古い書き込みで上書きしない
);
CREATE INDEX idx_rooms_list ON rooms(status, game, updated_at DESC);
