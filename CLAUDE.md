# CLAUDE.md

## プロジェクト概要

自作の**ターン制ゲーム**を、画面なし（ヘッドレス）で **API だけで遊べる／観戦できる**ようにする配信基盤。

- ゲームロジックはすべてサーバー側で動かす。クライアントは状態を受け取って描画するか、Bot として行動を送るだけ。
- 複数のゲームを共通インターフェースで追加できるようにする（プラグイン的に）。
- **無料枠（Cloudflare Workers Free プラン）の範囲で運用する**ことが前提。

## 技術スタック

| 役割 | 技術 |
|---|---|
| 言語 | TypeScript（strict） |
| ランタイム / ホスティング | Cloudflare Workers |
| HTTP ルーティング | Hono |
| 試合ルーム（1試合 = 1インスタンス） | Durable Objects（**SQLite バックエンド**。Free プランは KV バックエンド不可） |
| リアルタイム通信 | WebSocket（**Hibernation API** を必ず使う：`ctx.acceptWebSocket()`） |
| 持ち時間・タイムアウト | Durable Object Alarms |
| 永続データ（ユーザー・戦績・試合一覧） | D1 |
| 観戦ビューア / API ドキュメント | Cloudflare Pages（後回しでよい） |
| バリデーション / スキーマ | zod（+ `@hono/zod-openapi` で OpenAPI 生成） |
| テスト | Vitest（`@cloudflare/vitest-pool-workers`） |
| ツール | wrangler、pnpm |

## アーキテクチャ

```
クライアント（Bot / 自作UI / 観戦ビューア）
   │  REST: ルーム作成・参加・状態取得
   │  WebSocket: 行動送信・状態配信
   ▼
Worker（Hono）… 認証、ルーティング、DO への転送
   ▼
Durable Object「GameRoom」… 1試合 = 1インスタンス（idFromName(roomId)）
   ├ ゲームエンジン（games/ 配下の純粋関数）
   ├ SQLite … メタ情報・状態スナップショット・行動ログ
   └ Alarm … 手番の持ち時間切れ処理
   ▼
D1 … users, matches, results
```

## ディレクトリ構成（予定）

```
src/
  index.ts            # Worker エントリ（Hono app + DO の export）
  routes/             # REST ルート
  room/GameRoom.ts    # Durable Object
  games/
    types.ts          # GameDefinition インターフェース
    registry.ts       # gameId -> GameDefinition
    tictactoe/        # 最初のサンプルゲーム
    highcard/         # 隠し情報 + 同時手番のカードゲーム
  lib/
    rng.ts            # シード付き疑似乱数（mulberry32 等）
    auth.ts           # プレイヤートークン発行・検証
    protocol.ts       # WS メッセージの zod スキーマ
    replay.ts         # 行動ログからの再現・時間切れ解決（純粋関数）
    options.ts        # ルームオプション（turnTimeMs）
bots/
  random-bot.ts       # 合法手からランダムに選ぶ Bot（Node で実行）
  bot-core.ts         # WS ループ（CLI とテストで共有）
migrations/           # D1 マイグレーション
test/
wrangler.jsonc
```

## ゲーム共通インターフェース（最重要）

すべてのゲームはこれを実装する。**副作用なしの純粋関数**にすること（`Math.random()`、`Date.now()`、I/O は禁止）。

```ts
export interface GameDefinition<S, A> {
  id: string;                                  // "tictactoe" など
  minPlayers: number;
  maxPlayers: number;
  actionSchema: z.ZodType<A>;                  // 受信した行動の検証用
  init(players: string[], seed: number): S;
  currentPlayers(s: S): string[];              // 今行動できるプレイヤー（同時手番も可）
  legalActions(s: S, pid: string): A[];        // Bot 向けに API で返す
  apply(s: S, pid: string, a: A, rng: Rng): S; // 不正な手は GameError を throw
  view(s: S, pid: string | null): unknown;     // 隠し情報を除去。null は観戦者
  result(s: S): null | { winners: string[]; scores?: Record<string, number> };
  onTimeout?(s: S, pids: string[], rng: Rng): S; // 任意。未定義なら時間切れのプレイヤーの負け
}
```

- 乱数は必ず渡された `seed` / `rng` から作る。**「初期シード + 行動ログ」だけで試合を完全に再現できること**を保証する（リプレイ・デバッグ・不正検証のため）。
- 状態 `S` は JSON シリアライズ可能に保つ（Map、Set、クラスインスタンスは使わない）。
- 隠し情報（手札など）は `view` の中だけで除去する。サーバーが送るのは常に `view` の結果だけ。

## API 仕様

### REST

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/games` | 利用できるゲームの一覧 |
| POST | `/rooms` | `{ game: string, options?: {...} }` → `{ roomId, hostToken }`。未知のオプションは 400 |
| POST | `/rooms/:id/join` | → `{ playerId, token }` |
| POST | `/rooms/:id/start` | 試合開始（作成者のみ。`hostToken` を Bearer で渡す） |
| GET | `/rooms/:id/state` | `?token=` があればそのプレイヤー視点、なければ観戦視点 |
| POST | `/rooms/:id/action` | WS を使わない簡易 Bot 向け。`{ turn, action }` |
| GET | `/rooms/:id/log` | 行動ログ（リプレイ用。終了後のみ） |
| GET | `/rooms/:id/replay` | ログから再現した各ターンの観戦視点（終了後のみ） |
| POST | `/users` | `{ name }` → `{ userId, apiKey }`。join 時に `X-Api-Key` を付けると戦績が紐づく |
| GET | `/users/:id` | ユーザーと戦績 |
| GET | `/matches` | 終了した試合の一覧（`?game=&limit=`） |
| GET | `/openapi.json` | 生成された OpenAPI 仕様 |
| GET | `/rooms/:id/ws` | WebSocket へのアップグレード（`?token=`。無ければ観戦） |

### WebSocket メッセージ（JSON）

クライアント → サーバー：
```json
{ "type": "action", "turn": 12, "action": { ... } }
{ "type": "ping" }
```

サーバー → クライアント：
```json
{ "type": "state", "turn": 13, "view": { ... }, "legal": [ ... ], "currentPlayers": ["p1"], "deadline": 1732190000000 }
{ "type": "error", "code": "ILLEGAL_ACTION" | "NOT_YOUR_TURN" | "STALE_TURN" | "BAD_REQUEST", "message": "..." }
{ "type": "end", "winners": ["p1"], "scores": { ... } }
```

- `turn` が現在のターンと一致しない行動は `STALE_TURN` で拒否する（二重送信・古い手の防止）。
- `legal` は、受け取るプレイヤーが今行動できる場合にだけ付ける。

## 無料枠の制約（設計時に必ず守る）

- Workers Free：**1日10万リクエスト**（UTC 0時にリセット）。超えるとエラーになる（課金はされない）。
- DO に**受信した** WebSocket メッセージは **20通で1リクエスト**として数える。**送信は無料**。
- WebSocket 接続の確立と Alarm の発火は、それぞれ1リクエストとして数える。
- DO ストレージ（SQLite）：無料枠はアカウントあたり 5GB。

設計方針：
- 行動の送信は WebSocket を基本にする。REST の `/action` は補助。
- **必ず Hibernation API を使う**（`state.acceptWebSocket()` + `webSocketMessage()` ハンドラ）。`ws.accept()` は使わない（稼働時間が課金対象になる）。
- ポーリングを前提にした設計にしない。状態は WS のプッシュで配る。
- Alarm は「その時点の手番の締め切り」1つだけを設定する（ターンが進むたびに上書きする）。
- 状態の配信は当面フルの `view` でよい。サイズが問題になったら差分配信（JSON Patch）を検討する。

## GameRoom（Durable Object）の責務

1. ルームのライフサイクル：`waiting` → `playing` → `finished`
2. プレイヤーの参加とトークン検証。WS には `serializeAttachment({ playerId })` でプレイヤー情報を持たせる
3. 行動の受信 → `actionSchema` で検証 → 手番とターンを確認 → `apply` → ログに追記 → 状態を保存 → 全接続に `view` を配信
4. 持ち時間切れ（Alarm）時の処理：ゲームごとに定義する（自動パス／負け扱いなど）。デフォルトは負け扱い
5. 終了時に D1 へ結果を書き込む

SQLite テーブル（DO 内）：
- `meta(key TEXT PRIMARY KEY, value TEXT)` … gameId、seed、players、status
- `actions(turn INTEGER, player TEXT, action TEXT, at INTEGER)`
- `snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), turn INTEGER, state TEXT)`

## 実装の順番

1. [x] プロジェクトの雛形（wrangler + Hono + TypeScript + Vitest）
2. [x] `GameDefinition` 型 + 三目並べ + エンジン単体のテスト
3. [x] GameRoom DO（作成・参加・開始・行動・状態取得）を REST だけで動かす
4. [x] WebSocket（Hibernation）による配信
5. [x] `bots/random-bot.ts` で Bot 同士の対戦が最後まで終わることを確認
6. [x] 行動ログとリプレイ API（シードとログから再現できることをテストする）
7. [x] Alarm による持ち時間処理
8. [x] D1（users、matches、results）+ マイグレーション
9. [x] OpenAPI ドキュメントの生成
10. [x] 2つ目のゲーム（隠し情報のあるもの。例：簡単なカードゲーム）で `view` の除去を検証する

## コマンド

```bash
pnpm install
pnpm dev                       # wrangler dev
pnpm test                      # vitest
pnpm typecheck                 # tsc --noEmit
pnpm deploy                    # wrangler deploy
pnpm wrangler d1 migrations apply <DB名> --local
pnpm tsx bots/random-bot.ts --url http://localhost:8787 --room <roomId> [--host-token <hostToken>]
```

## コーディング規約

- TypeScript strict。`any` は使わない（外部入力は zod で `unknown` から検証する）。
- ゲームロジック（`src/games/`）は Cloudflare の API に依存させない。Node 単体でテストできる状態に保つ。
- エラーは `GameError(code, message)` で投げ、ルーム側で `error` メッセージに変換する。
- 新しいゲームを追加するときは、次の3つを必ず用意する：(1) `GameDefinition` の実装、(2) `registry.ts` への登録、(3) ランダム Bot で 100 試合が例外なく終わるテスト。
- 秘密情報（トークンの署名鍵など）は `wrangler secret` で管理し、コミットしない。ローカルでは `.dev.vars` を使う（gitignore 済みにする）。
