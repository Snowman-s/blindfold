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
D1 … users, matches, results, rooms（一覧用の索引）
```

## ディレクトリ構成（予定）

```
src/
  index.ts            # Worker エントリ（Hono app + DO の export）
  routes/             # REST ルート
  room/GameRoom.ts    # Durable Object（RPC の入口・トランザクション・alarm・配信・D1 の実行・練習相手）
  room/logic.ts       # ルームの状態遷移と配る状態の組み立て（純粋関数。Node でテストできる）
  room/store.ts       # DO 内 SQLite の読み書き（RoomStore。GameRoom からは SQL を書かない）
  room/d1.ts          # D1 に書く文（matches / results / rooms 索引）の組み立て
  room/schema.ts      # DO 内 SQLite のスキーマと移行（MIGRATIONS。列やテーブルを足すときはここ）
  games/
    types.ts          # GameDefinition インターフェース
    registry.ts       # gameId -> GameDefinition（今の版だけ）。getGame(id, rulesVersion?) は版が一致するときだけ返す
    tictactoe/        # 最初のサンプルゲーム（index.ts = GameDefinition、docs.ts = LLM 向けの説明）
    highcard/         # 隠し情報 + 同時手番のカードゲーム
  lib/
    rng.ts            # シード付き疑似乱数（文字列シード → cyrb128 → sfc32。状態 128 ビット）
    auth.ts           # プレイヤートークン発行・検証
    protocol.ts       # WS メッセージの zod スキーマ
    replay.ts         # 行動ログからの再現・時間切れ解決（純粋関数）
    options.ts        # ルームオプション（turnTimeMs、practice）とゲーム固有オプションの検証（parseGameOptions）
    rules.ts          # ゲームの説明（/games/:id/rules）の組み立て
    guide.ts          # クライアント開発者向けガイド（/guide.md）の生成
    changelog.ts      # API の変更履歴（/changelog.md）。API_VERSION を上げたら先頭に足す
    deprecation.ts    # Deprecation / Sunset ヘッダーのヘルパー（deprecated() ミドルウェア、markDeprecated()）
    examples.ts       # ガイド・rules に載せる state / end / ログの例（実エンジン + 固定シードから作る）
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
export interface GameDefinition<S, A, O = null> {    // O = ゲーム固有のオプション（optionsSchema の出力）。無ければ null
  id: string;                                  // "tictactoe" など
  rulesVersion: number;                        // ルールの版（1 から）。シード + ログの再現が崩れる変更（rng の引き方も含む）で上げる。古い版は残さない（旧版のルームは GAME_REMOVED）
  viewVersion: number;                         // view の形の版（1 から）。view の破壊的変更（削除・改名・型や意味の変更、enum への値の追加）で上げる。フィールドの追加では上げない
  minPlayers: number;
  maxPlayers: number;
  actionSchema: z.ZodType<A>;                  // 受信した行動の検証用
  viewSchema: z.ZodType;                       // view の返り値の形（全視点の和集合。strictObject）。JSON Schema にして /rules で配る
  docs: GameDocs;                              // { summary, rules, view, examples, options? }。Bot 上の LLM が読む説明
  optionsSchema?: z.ZodType<O>;                // 任意。ゲーム固有のオプション（POST /rooms の gameOptions）。strictObject で、{} を受け付けること（既定値は .default()）
  init(players: string[], seed: Seed, options: O): S; // Seed = string（128 ビットの乱数を 16 進 32 文字で発行）。options は既定値を補った値（optionsSchema が無ければ null）
  currentPlayers(s: S): string[];              // 今行動できるプレイヤー（同時手番も可）
  legalActions?(s: S, pid: string): A[];       // 任意。state の legal として配る。合法手を列挙できないゲームは定義せず、apply だけで検証する
  apply(s: S, pid: string, a: A, rng: Rng): S; // 不正な手は GameError を throw
  view(s: S, pid: string | null): unknown;     // 隠し情報を除去。null は観戦者
  result(s: S): null | { winners: string[]; scores?: Record<string, number> };
  onTimeout?(s: S, pids: string[], rng: Rng): S; // 任意。未定義なら時間切れのプレイヤーの負け
  onResign?(s: S, pid: string, rng: Rng): S;   // 任意。未定義なら投了者の負け（残り全員の勝ち）。3人以上で投了者だけ抜けて続けるときなどに定義
  practiceAction?(s: S, pid: string, rng: Rng): A; // 練習相手の打ち方。未定義なら合法手からランダム。legalActions が無いゲームでは必須
}
```

- 乱数は必ず渡された `seed` / `rng` から作る（`createRng(seed)`）。シードは 128 ビット。32 ビットだと観測した乱数から総当たりでシードを特定され、隠し情報が漏れる。**「初期シード + ゲームオプション + 行動ログ」だけで試合を完全に再現できること**を保証する（リプレイ・デバッグ・不正検証のため）。
- ゲーム固有のオプションは、ルーム作成時に `optionsSchema` で検証して既定値を補った値を meta（`gameOptions`）に保存し、`init`・`/log`（`ReplayLog.gameOptions`）・D1 の `matches.game_options` に同じ値を使う。オプションの意味や既定値を変えるのはルールの変更（`rulesVersion` を上げる）。
- 状態 `S` は JSON シリアライズ可能に保つ（Map、Set、クラスインスタンスは使わない）。
- 隠し情報（手札など）は `view` の中だけで除去する。サーバーが送るのは常に `view` の結果だけ。

## API 仕様

### REST

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/`（`Accept: text/markdown` ならガイド本文）、`/guide.md`、`/llms.txt` | クライアント開発者（コーディングエージェント）向けのガイド。URL を渡すだけでクライアントが書けることが目標。コードから生成し、`version` を ETag にする |
| GET | `/changelog.md` | API の変更履歴（`src/lib/changelog.ts` から生成。内容のハッシュを ETag にする） |
| GET | `/games` | 利用できるゲームの一覧（`summary`、`rulesVersion`、`viewVersion`、`listsLegalActions`、`hasOptions`、`rulesUrl` 付き） |
| GET | `/games/:id/rules` | ゲームの説明（LLM 向け）。ルール・view の読み方・view / action / ゲームオプションの JSON Schema（`optionsSchema`・`defaultGameOptions`）・state の例（実エンジンから生成）・共通の遊び方。`version` を ETag にする |
| GET | `/games/:id/rules.md` | 同じ内容を Markdown 1枚で。プロンプトにそのまま貼れる |
| POST | `/rooms` | `{ game: string, options?: {...}, gameOptions?: {...} }` → `{ roomId, hostToken }`。未知のオプションは 400。`gameOptions` はゲーム固有のオプション（ゲームの `optionsSchema` で検証。持たないゲームに渡すと 400）。`options.practice: true` で開始時に空席をサーバー側の練習相手が埋める（打ち方は `practiceAction`、未定義ならランダム。D1 には記録しない）。`options.autoStart: true` で満席になったら自動開始（practice と併用不可）。`options.unlisted: true` で一覧・クイックマッチから外す |
| GET | `/rooms` | 公開ルームの一覧（`gameOptions` 付き）。`?status=` は `waiting`（既定。空席あり・最終更新から30分以内）か `playing`。`&game=&limit=` で絞り込み。D1 の `rooms` 索引から返す（best-effort。DO が正） |
| POST | `/quickmatch` | `{ game, options?: { turnTimeMs }, gameOptions? }` → `{ roomId, playerId, token, created }`。同じゲーム・ゲームオプション（既定値を補った値）・持ち時間の autoStart の公開ルームに古い順で入り、無ければ作る |
| POST | `/rooms/:id/join` | → `{ playerId, token }` |
| POST | `/rooms/:id/start` | 試合開始（作成者のみ。`hostToken` を Bearer で渡す） |
| POST | `/rooms/:id/leave` | 待機中ルームからの退出（join の取り消し。Bearer）。トークンは無効になり、その席の WS は close コード 4000 で閉じる。席番号は再利用しない（`nextSeat` の連番） |
| POST | `/rooms/:id/rematch` | 終了後の再戦（Bearer）→ `{ roomId, playerId, token }`。最初の呼び出しで同じゲーム・オプション・ゲームオプションの新ルームを作り、人間の席を1つずらして予約する（予約は `init` の引数で meta に持ち、`roomOptions` には入れない）。予約席は `join` 不可（`ROOM_RESERVED`）・一覧に載らない。全員が呼んだら自動開始。同じ人は何度呼んでも同じ席。旧ルームの state に `rematch: { roomId, requestedBy }` が付く |
| GET | `/rooms/:id/state` | `Authorization: Bearer <token>` があればそのプレイヤー視点、なければ観戦視点 |
| POST | `/rooms/:id/resign` | 投了。試合中ならいつでも（手番でなくても）。既定は投了者の負けで残り全員が勝ち、その場で終了（`onResign` があればそれに従う）。WS では `{ "type": "resign" }` |
| POST | `/rooms/:id/action` | WS を使わない簡易 Bot 向け。`{ turn, action }`。相手の手を待つ手段はないので、単発の行動・デバッグ用（対戦は WS） |
| GET | `/rooms/:id/log` | 行動ログ（リプレイ用。終了後のみ）。開始時に記録した `rulesVersion` と `gameOptions` 付き |
| GET | `/rooms/:id/replay` | ログから再現した各ターンの観戦視点（終了後のみ）。記録した `rulesVersion` が今の版と違えば 410 `GAME_REMOVED`（`/log` は返す） |
| POST | `/users` | `{ name }` → `{ userId, name, apiKey }`。join 時に `X-Api-Key` を付けると戦績が紐づく |
| GET | `/users/:id` | ユーザーと戦績 |
| GET | `/matches` | 終了した試合の一覧（`?game=&limit=`） |
| GET | `/openapi.json` | 生成された OpenAPI 仕様 |
| GET | `/rooms/:id/ws` | WebSocket へのアップグレード（サブプロトコル `["apigames.v1", "apigames.token.<token>"]`。トークンは Bearer でもよい。トークンが無ければ観戦。`apigames.v1` は観戦でも必須） |

- トークンは URL に載せない（アクセスログ・ブラウザ履歴に残るため）。`?token=` は 400 で拒否する。
- CORS は全オリジン許可（Cookie を使わず Bearer なので安全）。WS のアップグレードは対象外。
- REST は `Authorization: Bearer`。WS はブラウザがヘッダーを付けられないのでサブプロトコルで渡し、サーバーはトークンを含まない版のサブプロトコル（`apigames.v1`）を選んで応答する。
- WS のサブプロトコルは WS メッセージの版（`src/lib/auth.ts` の `WS_PROTOCOLS`。新しい順）。提示された中で最も新しいものを選ぶ。未指定を v1 とみなすフォールバックは置かない。1.0 以降の WS の破壊的変更は `apigames.v2` を足して交渉し、古い版はしばらく並べて残す。
- エンジン（ゲーム、または開始時の `rulesVersion`）がレジストリに無いルームは、`/log` 以外が 410 `GAME_REMOVED`。alarm は例外にせず止める（再試行のたびにリクエストを消費しないように）。

### WebSocket メッセージ（JSON）

クライアント → サーバー：
```json
{ "type": "action", "turn": 12, "action": { ... } }
{ "type": "resign" }
{ "type": "ping" }
```

サーバー → クライアント：
```json
{ "type": "state", "game": "tictactoe", "rulesVersion": 1, "gameOptions": null, "status": "playing", "turn": 13, "players": ["p1", "p2"], "currentPlayers": ["p1"], "view": { ... }, "legal": [ ... ], "deadline": 1732190000000, "now": 1732189710000, "result": null }
{ "type": "error", "code": "ILLEGAL_ACTION" | "NOT_YOUR_TURN" | "STALE_TURN" | "NOT_PLAYING" | "UNAUTHORIZED" | "BAD_REQUEST" | ..., "message": "..." }
{ "type": "end", "winners": ["p1"], "scores": { ... }, "reason": "normal" | "timeout" | "resign" }
```

- `turn` が現在のターンと一致しない行動は `STALE_TURN` で拒否する（二重送信・古い手の防止）。
- 締め切りを過ぎてから届いた行動も、Alarm を待たずにその場で時間切れを確定させてから `STALE_TURN` で拒否する。
- `state` は REST の `GET /rooms/:id/state` と同じオブジェクトに `type` を付けたもの（`RoomState` が唯一の定義。`src/lib/protocol.ts`）。
- `error` の `code` は REST と同じコードをそのまま返す（読み替えない）。
- `legal` は、受け取るプレイヤーが今行動でき、ゲームが `legalActions` を定義している場合にだけ付ける。手番かどうかの判定は `currentPlayers` で行うようクライアントに案内している。
- `now` はメッセージを作った時点のサーバー時刻（epoch ms）。クライアントは `deadline - now` で残り時間を出す（クライアントの時計ずれ対策）。
- 投了・時間切れはサーバーが書くログの行（`player = ""`、`action = {"$resign":"p1"}` / `{"$timeout":[...]}`）として1ターン進める。既定（`onTimeout` / `onResign` 未定義）は状態を変えず、決着は meta の `forfeit`。それで試合が終わったときだけ理由を `endReason`（D1 の `matches.reason`）に残す。

### 互換性方針

版を表す値は5種類ある。混同しない。

| 名前 | 場所 | 意味 |
|---|---|---|
| `version` | ガイド・rules の見出し、`/games/:id/rules` の `version`、ETag | 内容のハッシュ。誤字1つ直しても変わる。**キャッシュの鍵でしかなく、互換性の合図ではない** |
| `apiVersion` | `src/lib/version.ts` の `API_VERSION`。OpenAPI の `info.version`・ガイドの TL;DR・rules の `apiVersion` が同じ値を参照する | API の版（semver） |
| `rulesVersion` | `GameDefinition.rulesVersion`（整数）。`/games`・rules・state・`/log`・`/replay`・`/matches` で返す | ゲームのルール・action の形の版。「シード + ログで再現できる」保証に関わる。ルームは開始時（`init` と同じトランザクション）に meta へ記録する。今の版と違うルームは動かさない（`GAME_REMOVED`）。D1 の `matches.rules_version` にも残す |
| `viewVersion` | `GameDefinition.viewVersion`（整数）。`/games`・rules で返す | ゲームの view の形の版。破壊的変更で上げる。リプレイに関わらないので古い版を残す必要はなく、進行中の試合も新しい形になる |
| WS サブプロトコル | `apigames.v1`（`WS_PROTOCOLS`） | WS メッセージの版。接続ごとに交渉し、attachment に `protocol` として持つ |

- **0.x の間は実験段階**。破壊的変更は予告なしで出してよい（マイナーを上げる）。changelog は事後に書く。1.0.0 からは破壊的変更でメジャーを上げる。
- **非破壊（いつでもやる。クライアントは許容する義務がある）**：REST レスポンス・WS メッセージ・`view` へのフィールド追加、新しい WS メッセージ `type`、新しいエラー `code`、新しいゲーム・エンドポイント・省略可能な入力やルームオプション、ガイド・rules・エラーメッセージの文言変更。クライアントの義務（未知のフィールド・`type`・`code` を無視する）はガイドの 9 節・チェックリスト・rules の `COMMON` に書いてある。
- **破壊的**：フィールドの削除・改名・型や意味の変更、入力を必須にすること、認証方式の変更、ゲームのルール・action の形の変更。
- **出力の enum（`status`・`reason`・`outcome` など）は値が増えうる**（非破壊）。OpenAPI のレスポンスでは `openEnum()`（`src/routes/schemas.ts`）で string + 説明（今の値）にする。入力の enum は `z.enum` のまま。`view` の中の enum は対象外（`viewVersion` に従う）。クライアントの扱い方（未知の `reason` は `normal` 扱いなど）はガイド 9 節・チェックリスト・`COMMON` に書いてある。
- **出力の JSON Schema は未知のフィールドを禁止しない**。`viewSchema` は内部では `strictObject`（all-games テストで余計なフィールドが無いことを確かめる用）だが、`/rules` で配るときは `outputJsonSchema()` で `additionalProperties: false` を外す。入力（action・ルームオプション）の Schema は余計なフィールドを拒否するので `z.toJSONSchema` のまま。
- **告知**：`apiVersion` と `/changelog.md`（`src/lib/changelog.ts`。先頭の版が `API_VERSION` と一致することをテストで確かめる）。廃止を段階的に進めるときに限り、該当するレスポンスに `Deprecation` / `Sunset` ヘッダー（RFC 9745 / 8594）をベストエフォートで付ける（0.x では付かないまま壊すこともある）。ルート全体なら `deprecated(info)` ミドルウェア、フィールドなど使ったときだけなら `markDeprecated(c, info)`（`src/lib/deprecation.ts`）。CORS の `exposeHeaders` に入れてある。
- **ルールを変えるとき**は `rulesVersion` を上げる。古い版のエンジンは残さない仕様で、前の版で始めたルームは進行中・終了済みとも `GAME_REMOVED`（410）になり、リプレイできなくなる（`/log` は返す）。古い state を新しいエンジンで黙って動かすことはない。旧版のルームのデータそのものは、終了済みルームの掃除（TODO）で消す。
- **view の形を壊すとき**は `viewVersion` を上げる（エンジンは差し替えるだけ）。

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
- ルーム一覧は D1 の `rooms`（索引）で持つ。書くのは作成・join・退出・開始・終了のときだけで、1手ごとには書かない。`rev` で古い書き込みの上書きを防ぐ。
- 状態の配信は当面フルの `view` でよい。サイズが問題になったら差分配信（JSON Patch）を検討する。

## GameRoom（Durable Object）の責務

1. ルームのライフサイクル：`waiting` → `playing` → `finished`
2. プレイヤーの参加とトークン検証。WS には `serializeAttachment({ playerId })` でプレイヤー情報を持たせる
3. 行動の受信 → `actionSchema` で検証 → 手番とターンを確認 → `apply` → ログに追記 → 状態を保存 → 全接続に `view` を配信
   - 何を書くかの判断（行動・投了・時間切れの解決、締め切り、配る状態）は `room/logic.ts` の純粋関数、SQL は `room/store.ts`、D1 の文は `room/d1.ts`。GameRoom は「判断 → `commit`（1トランザクション）→ 副作用」の順に呼ぶだけにする
4. 持ち時間切れ（Alarm）時の処理：ゲームごとに定義する（自動パス／負け扱いなど）。デフォルトは負け扱い
5. 終了時に D1 へ結果を書き込む

SQLite テーブル（DO 内）：
- `meta(key TEXT PRIMARY KEY, value TEXT)` … gameId、seed、rulesVersion、gameOptions、status、schemaVersion など
- `players(id TEXT PRIMARY KEY, token TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT)`
- `actions(turn INTEGER, player TEXT, action TEXT, at INTEGER)`
- `snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), turn INTEGER, state TEXT)`
- スキーマは `src/room/schema.ts`。新しいルームは BASE_SCHEMA（版 1）+ `MIGRATIONS` を順に流して作り、既存のルームはコンストラクタの `blockConcurrencyWhile` で `meta.schemaVersion` から1段ずつ移行する。列やテーブルを足すときは `MIGRATIONS` の末尾に足す（BASE_SCHEMA は書き換えない）。

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
pnpm deploy                    # wrangler deploy（先に `pnpm wrangler d1 migrations apply <DB名> --remote`。未適用だと結果の書き込みが失敗し続ける）
pnpm wrangler d1 migrations apply <DB名> --local
pnpm tsx bots/random-bot.ts --url http://localhost:8787 --room <roomId> [--host-token <hostToken>]
pnpm tsx bots/random-bot.ts --url http://localhost:8787 --quickmatch tictactoe
```

## コーディング規約

- TypeScript strict。`any` は使わない（外部入力は zod で `unknown` から検証する）。
- ゲームロジック（`src/games/`）は Cloudflare の API に依存させない。Node 単体でテストできる状態に保つ。
- エラーは `GameError(code, message)` で投げ、ルーム側で `error` メッセージに変換する。
- 新しいゲームを追加するときは、次の3つを必ず用意する：(1) `GameDefinition` の実装（`rulesVersion: 1`・`viewVersion: 1`・`docs`・`viewSchema` を含む。view が全局面・全視点で `viewSchema` を満たすことは all-games テストで検証される。`legalActions` を定義しないなら `practiceAction` は必須、`optionsSchema` を定義するなら `docs.options` も書く。これも all-games テストで検証される）、(2) `registry.ts` への登録、(3) ランダム Bot で 100 試合が例外なく終わるテスト（練習相手どうしの 100 試合も all-games テストで自動的に走る。ランダムで決着しにくいゲームは `practiceAction` を定義する）。
- `docs` はゲームのディレクトリの `docs.ts` に置き、**英語**で書く（LLM が読む前提。翻訳は Bot 側に任せる）。特に `view` の各フィールドの意味と、視点による違いを省略しない。全ゲーム共通の遊び方（turn・legal・エラー）は `src/lib/rules.ts` の `COMMON` にあるので、各ゲームには書かない。
- 読み手は主に LLM を想定しているが、**サイトに出る文言（ガイド・rules・docs・OpenAPI）には「LLM 向け」と書かない**。決定論的な Bot も使うため、誰が読んでも通じる書き方にする（コードのコメントには書いてよい）。
- OpenAPI の `summary`・`description`・`.describe()` も**英語**で書く（ガイド・rules と同じく LLM が読む。テストで日本語が混ざっていないことを確かめている）。コードのコメントは日本語でよい。
- 秘密情報（トークンの署名鍵など）は `wrangler secret` で管理し、コミットしない。ローカルでは `.dev.vars` を使う（gitignore 済みにする）。
