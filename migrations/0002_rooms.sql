-- ルーム一覧（GET /rooms、POST /quickmatch）用の索引。本物の状態は GameRoom DO が持ち、ここは best-effort。
-- 書き込むのは作成・join・開始・終了のときだけ（1手ごとには書かない）。unlisted / practice のルームは載せない。
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
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
