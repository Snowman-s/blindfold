# CLAUDE.md

## Project overview

A hosting platform that makes my own **turn-based games** **playable and watchable through an API alone**, with no screen (headless).

- All game logic runs on the server. A client only receives state and draws it, or acts as a bot and sends moves.
- Multiple games can be added through a common interface (plugin-style).
- **It must run within the free tier (Cloudflare Workers Free plan).**
- Deployed at https://blindfold.snowesamosc.workers.dev.

## Tech stack

| Role | Technology |
|---|---|
| Language | TypeScript (strict) |
| Runtime / hosting | Cloudflare Workers |
| HTTP routing | Hono |
| Match rooms (1 match = 1 instance) | Durable Objects (**SQLite backend**; the Free plan does not allow the KV backend) |
| Real-time | WebSocket (**always use the Hibernation API**: `ctx.acceptWebSocket()`) |
| Turn time / timeouts | Durable Object Alarms |
| Persistent data (users, results, match list) | D1 |
| API docs | Served by the Worker itself (`/guide.md`, `/games/:id/rules`, `/openapi.json`). No spectator viewer is provided (users build their own clients) |
| Validation / schemas | zod (+ `@hono/zod-openapi` for OpenAPI generation) |
| Tests | Vitest (`@cloudflare/vitest-pool-workers`) |
| Tooling | wrangler, pnpm |

## Architecture

```
Client (bot / own UI / own spectator viewer)
   │  REST: create / join rooms, get state
   │  WebSocket: send moves, receive state
   ▼
Worker (Hono) … auth, routing, forwarding to the DO
   ▼
Durable Object "GameRoom" … 1 match = 1 instance (idFromName(roomId))
   ├ Game engine (pure functions under games/)
   ├ SQLite … metadata, state snapshot, action log
   └ Alarm … turn time-outs
   ▼
D1 … users, matches, results, rooms (index for listing)
```

## Directory layout

```
src/
  index.ts            # Worker entry (Hono app + DO export)
  routes/             # REST routes (rooms.ts, users.ts, shared response schemas in schemas.ts)
  room/GameRoom.ts    # Durable Object (RPC entry points, transactions, alarm, broadcast, running D1 writes, practice opponents)
  room/logic.ts       # Room state transitions (settle: the state committed; alarm decisions planAlarm / wantedAlarm; D1 retry intervals) and building the state sent to clients (pure functions, testable in Node)
  room/store.ts       # Reads/writes of the DO's SQLite (RoomStore; GameRoom writes no SQL). meta keys and types are defined once in META
  room/d1.ts          # Builds the D1 statements (matches / results / rooms index)
  room/schema.ts      # DO SQLite schema and migrations (MIGRATIONS; add columns or tables here)
  games/
    types.ts          # GameDefinition interface
    registry.ts       # gameId -> GameDefinition (current version only). getGame(id, rulesVersion?) returns only when the version matches
    tictactoe/        # First sample game (index.ts = GameDefinition, docs.ts = description for clients)
    highcard/         # Card game with hidden information + simultaneous turns
    frontier/         # 2-4 player territory game on a generated graph (simultaneous orders, game options, no legalActions, onTimeout / onResign; map.ts = symmetric map generation)
  lib/
    rng.ts            # Seeded PRNG (string seed → cyrb128 → sfc32; 128-bit state)
    auth.ts           # Issuing and verifying player tokens
    protocol.ts       # zod schemas for WS messages
    replay.ts         # Reproduction from the action log, timeout resolution (pure functions)
    practice.ts       # How the practice opponent picks a move (practiceAction, otherwise a random legal move)
    version.ts        # API_VERSION and output JSON Schemas (outputJsonSchema)
    options.ts        # Validation of room options (turnTimeMs, practice) and game-specific options (parseGameOptions)
    rules.ts          # Builds the game description (/games/:id/rules)
    guide.ts          # Generates the client developer guide (/guide.md)
    changelog.ts      # API changelog (/changelog.md). Add an entry at the top when bumping API_VERSION
    deprecation.ts    # Deprecation / Sunset header helpers (deprecated() middleware, markDeprecated())
    ratelimit.ts      # Per-IP rate limiting (Rate Limiting bindings; 429 RATE_LIMITED + Retry-After)
    examples.ts       # state / end / log examples for the guide and rules (built from the real engines + fixed seeds)
bots/
  random-bot.ts       # Bot that picks a random legal move (runs in Node)
  bot-core.ts         # WS loop (shared by the CLI and tests)
migrations/           # D1 migrations
test/
doc/openapi.json      # Snapshot of the OpenAPI spec
wrangler.jsonc
README.md             # Repository introduction (English)
```

## Common game interface (most important)

Every game implements this. They must be **pure functions with no side effects** (`Math.random()`, `Date.now()` and I/O are forbidden).

```ts
export interface GameDefinition<S, A, O = null> {    // O = game-specific options (output of optionsSchema); null if none
  id: string;                                  // e.g. "tictactoe"
  rulesVersion: number;                        // Rules version (from 1). Bump on any change that breaks reproduction from seed + log (including how rng is drawn). Old versions are not kept (old-version rooms are GAME_REMOVED)
  viewVersion: number;                         // View shape version (from 1). Bump on breaking view changes (removal, rename, type or meaning change, adding a value to an enum). Adding a field does not bump it
  minPlayers: number;
  maxPlayers: number;
  actionSchema: z.ZodType<A>;                  // Validates incoming actions
  viewSchema: z.ZodType;                       // Shape of view's return value (union over all viewpoints; strictObject). Served as JSON Schema from /rules
  docs: GameDocs;                              // { summary, rules, view, examples, options? }. The description read by LLMs running bots
  optionsSchema?: z.ZodType<O>;                // Optional. Game-specific options (gameOptions of POST /rooms). Must be a strictObject that accepts {} (defaults via .default())
  init(players: string[], seed: Seed, options: O): S; // Seed = string (128 random bits as 32 hex chars). options has defaults filled in (null without optionsSchema)
  currentPlayers(s: S): string[];              // Players who may act now (simultaneous turns allowed)
  legalActions?(s: S, pid: string): A[];       // Optional. Sent as legal in the state. Games whose legal moves can't be enumerated leave it out and validate in apply only
  apply(s: S, pid: string, a: A, rng: Rng): S; // Throws GameError on an illegal move
  view(s: S, pid: string | null): unknown;     // Strips hidden information. null is a spectator
  result(s: S): null | { winners: string[]; scores?: Record<string, number> };
  onTimeout?(s: S, pids: string[], rng: Rng): S; // Optional. If undefined, the timed-out players lose
  onResign?(s: S, pid: string, rng: Rng): S;   // Optional. If undefined, the resigning player loses (everyone else wins). Define it e.g. for 3+ players where only the resigner drops out
  practiceAction?(s: S, pid: string, rng: Rng): A; // How the practice opponent plays. If undefined, a random legal move. Required when legalActions is missing. The returned move is validated like a human's (decideAction); if rejected, it times out
}
```

- Randomness always comes from the given `seed` / `rng` (`createRng(seed)`). Seeds are 128-bit; with 32 bits the seed could be brute-forced from observed random values, leaking hidden information. Guarantee that **a match can be fully reproduced from "initial seed + game options + action log" alone** (for replays, debugging and cheat checks).
- Game-specific options are validated with `optionsSchema` at room creation, defaults are filled in, and the result is stored in meta (`gameOptions`); the same value is used for `init`, `/log` (`ReplayLog.gameOptions`) and D1's `matches.game_options`. Changing the meaning or defaults of an option is a rules change (bump `rulesVersion`).
- Keep the state `S` JSON-serializable (no Map, Set or class instances).
- Hidden information (hands etc.) is stripped only inside `view`. The server only ever sends the output of `view`.

## API spec

### REST

| Method | Path | Description |
|---|---|---|
| GET | `/` (guide body if `Accept: text/markdown`), `/guide.md`, `/llms.txt` | Guide for client developers (coding agents). Goal: a client can be written from the URL alone. Generated from code; `version` is the ETag |
| GET | `/changelog.md` | API changelog (generated from `src/lib/changelog.ts`; content hash is the ETag) |
| GET | `/games` | List of available games (with `summary`, `rulesVersion`, `viewVersion`, `listsLegalActions`, `hasOptions`, `rulesUrl`) |
| GET | `/games/:id/rules` | Game description: rules, how to read the view, JSON Schemas for view / action / game options (`optionsSchema`, `defaultGameOptions`), state examples (generated from the real engine), common play instructions. `version` is the ETag |
| GET | `/games/:id/rules.md` | The same content as one Markdown page, ready to paste into a prompt |
| POST | `/rooms` | `{ game: string, options?: {...}, gameOptions?: {...} }` → `{ roomId, hostToken }`. Unknown options are 400. `gameOptions` are game-specific (validated by the game's `optionsSchema`; 400 for games without one). `options.seats` is the room's capacity (between the game's `minPlayers` and `maxPlayers`, default `maxPlayers`; validated in `GameRoom.init` with `checkSeats`; `roomSeats()` reads it; it is the D1 `rooms.max_players`). `options.practice: true` fills empty seats with server-side practice opponents at start, up to `seats` (or `minPlayers` if `seats` is omitted) (they play by `practiceAction`, random if undefined; not recorded in D1). `options.autoStart: true` starts automatically when full (`seats` players; not combinable with practice). `options.unlisted: true` hides it from the list and quickmatch |
| GET | `/rooms` | List of public rooms (with `gameOptions`). `?status=` is `waiting` (default; has free seats, updated within 30 minutes) or `playing` (index last updated within "turn time + `PLAYING_LIST_GRACE_MS` (2 hours)"). Filter with `&game=&limit=`. Served from the D1 `rooms` index (best-effort; the DO is authoritative) |
| POST | `/quickmatch` | `{ game, options?: { turnTimeMs, seats }, gameOptions? }` → `{ roomId, playerId, token, created }`. Joins the oldest public autoStart room with the same game, game options (with defaults filled in), turn time and seats (default `maxPlayers`), or creates one |
| POST | `/rooms/:id/join` | → `{ playerId, token }` |
| POST | `/rooms/:id/start` | Start the match (creator only; `hostToken` as Bearer) |
| POST | `/rooms/:id/leave` | Leave a waiting room (undo join; Bearer). The token is invalidated and that seat's WS is closed with code 4000. Seat numbers are not reused (`nextSeat` counter) |
| POST | `/rooms/:id/rematch` | Rematch after the end (Bearer) → `{ roomId, playerId, token }`. The first call creates a new room with the same game, options and game options and reserves the human seats rotated by one (reservations are passed as an `init` argument and kept in meta, not in `roomOptions`). Reserved seats can't be `join`ed (`ROOM_RESERVED`) and the room is not listed. Starts automatically once everyone has called it. The same person always gets the same seat. The old room's state gets `rematch: { roomId, requestedBy }` |
| GET | `/rooms/:id/state` | That player's view with `Authorization: Bearer <token>`, otherwise the spectator view |
| POST | `/rooms/:id/resign` | Resign. Any time during the match (even when it's not your turn). By default the resigner loses, everyone else wins and the match ends immediately (`onResign` overrides). Over WS: `{ "type": "resign" }` |
| POST | `/rooms/:id/action` | For simple bots not using WS. `{ turn, action }`. There's no way to wait for the opponent, so it's for one-off moves and debugging (play over WS) |
| GET | `/rooms/:id/log` | Action log (for replays; finished rooms only), with the `rulesVersion` and `gameOptions` recorded at creation |
| GET | `/rooms/:id/replay` | Spectator view of each turn reproduced from the log (finished rooms only). 410 `GAME_REMOVED` if the recorded `rulesVersion` differs from the current one (`/log` still works) |
| POST | `/users` | `{ name }` → `{ userId, name, apiKey }`. Sending `X-Api-Key` on join links the result to the user. One seat per user per room (a second is 409 `ALREADY_JOINED`) |
| POST | `/users/:id/key` | Reissue the API key (current key in `X-Api-Key`) → `{ userId, apiKey }`. The old key is revoked immediately (there's no revoke-only API; a lost key can't be recovered) |
| GET | `/users/:id` | User and their results |
| GET | `/matches` | List of finished matches (`?game=&limit=`) |
| GET | `/openapi.json` | Generated OpenAPI spec |
| GET | `/rooms/:id/ws` | WebSocket upgrade (subprotocols `["blindfold.v1", "blindfold.token.<token>"]`; the token may also be Bearer; no token means spectator; `blindfold.v1` is required even for spectators) |

- Tokens never go in URLs (they'd end up in access logs and browser history). `?token=` is rejected with 400.
- Room IDs match `^[0-9a-f]{12}$` (`isRoomId`). Other IDs get 404 `ROOM_NOT_FOUND` in the Worker (including `/ws`, without waking the DO).
- Player tokens and `hostToken` are stored in the DO only as hashes (sha256) (`players.token`, `meta.hostTokenHash`, `tokenHash` in the WS attachment). Each DO entry point hashes before reading state (so there's no await between reading and commit). Rematch seat tokens are derived from the original token (`rematchToken`), so the same one can be returned any number of times without storing it.
- CORS allows all origins (safe because auth is Bearer, not cookies). WS upgrades are excluded.
- Per-IP (`CF-Connecting-IP`) rate limits (`src/index.ts`): `POST /users`, `/users/:id/key` (RL_USERS); `POST /rooms`, `/quickmatch`, `/rooms/:id/join`, `/rooms/:id/rematch` (RL_ROOMS, shared); `GET /rooms/:id/ws` (RL_WS); other routes that read the DO or D1 (`GET /rooms`, `/rooms/:id/state`, `/log`, `/replay`, `/matches`, `/users/:id`; `POST /rooms/:id/action`, `/resign`, `/start`, `/leave`; RL_READS, shared). Limits are `ratelimits` in `wrangler.jsonc` (approximate, per location; period is 10 or 60). No limit when the header is missing (outside Cloudflare, tests).
- Returning 429 still invokes the Worker, so the 100k requests/day Workers limit can't be protected (only DO invocations and D1 reads are). A WAF in front of the Worker can only be attached to a custom domain's zone (not workers.dev), and domains cost money, so we decided **not to use one**. The free plan isn't billed on overage, it just stops until 00:00 UTC, so the only loss under attack is availability.
- WS connection counts: `MAX_SOCKETS_PER_SEAT` (4) per seat (token). Beyond that the oldest connection (attachment `at`) is closed with code 4004 (`CLOSE_REPLACED`). Spectators: `MAX_SPECTATOR_SOCKETS` (50) per room, beyond that 503 `TOO_MANY_CONNECTIONS`. Counted by the `acceptWebSocket` tags (`spectator` / `seat:<pid>`).
- WS error limit: each error sent increments the attachment's `strikes` by 1, and it decays by 1 every `WS_STRIKE_DECAY_MS` (10 s) (leaky bucket, evaluated lazily from `strikeAt`). Above `WS_MAX_STRIKES` (20) the socket is closed with code 4003 (`CLOSE_TOO_MANY_ERRORS`). Successful actions, resigns and `INTERNAL` don't count. Pings whose string differs from the auto-response `{"type":"ping"}` wake the DO, so they count.
- REST uses `Authorization: Bearer`. Browsers can't set WS headers, so WS passes the token as a subprotocol, and the server responds by selecting the version subprotocol without the token (`blindfold.v1`).
- The WS subprotocol is the WS message version (`WS_PROTOCOLS` in `src/lib/auth.ts`, newest first). The newest one offered is chosen. There's no fallback treating "none" as v1. After 1.0, breaking WS changes add `blindfold.v2` to negotiate, keeping the old version alongside for a while.
- Rooms whose engine (the game, or the `rulesVersion` recorded at creation) isn't in the registry return 410 `GAME_REMOVED` for everything except `/log` (finished rooms only), including while waiting. The alarm stops instead of throwing (so retries don't consume requests). When detected (entry `check()` fails → `reject()`, or in the alarm), `retire()` winds the room down once: closes all connections with code 4002 (`CLOSE_GAME_REMOVED`), deletes the D1 `rooms` row, and schedules cleanup after `FINISHED_ROOM_TTL_MS` for rooms that were in progress.

### WebSocket messages (JSON)

Client → server:
```json
{ "type": "action", "turn": 12, "action": { ... } }
{ "type": "resign" }
{ "type": "ping" }
```

Server → client:
```json
{ "type": "state", "game": "tictactoe", "rulesVersion": 1, "gameOptions": null, "status": "playing", "turn": 13, "players": ["p1", "p2"], "currentPlayers": ["p1"], "view": { ... }, "legal": [ ... ], "deadline": 1732190000000, "now": 1732189710000, "result": null }
{ "type": "error", "code": "ILLEGAL_ACTION" | "NOT_YOUR_TURN" | "STALE_TURN" | "NOT_PLAYING" | "UNAUTHORIZED" | "BAD_REQUEST" | ..., "message": "..." }
{ "type": "end", "winners": ["p1"], "scores": { ... }, "reason": "normal" | "timeout" | "resign" }
```

- Actions whose `turn` doesn't match the current turn are rejected with `STALE_TURN` (prevents double sends and stale moves). Exception: within one simultaneous turn (a run of turns where `currentPlayers` only shrinks; the same test as keeping the deadline, `sameSimultaneousTurn` in `room/logic.ts`), an older `turn` is accepted while the sender is still in `currentPlayers` (`acceptsTurn`). The turn where that run began is `meta.phaseTurn`, written by `settle` with the deadline. Otherwise every other player's move would make in-flight actions stale.
- Actions arriving after the deadline also settle the timeout on the spot, without waiting for the Alarm, and are then rejected with `STALE_TURN`.
- `state` is the same object as REST `GET /rooms/:id/state` plus `type` (`RoomState` is the single definition, in `src/lib/protocol.ts`).
- `error` `code`s are the same codes as REST, unchanged (no remapping).
- `legal` is included only when the receiving player can act now and the game defines `legalActions`. Clients are told to decide whose turn it is from `currentPlayers`.
- `now` is the server time when the message was built (epoch ms). Clients compute remaining time as `deadline - now` (guards against client clock skew).
- Resigns and timeouts advance one turn as server-written log rows (`player = ""`, `action = {"$resign":"p1"}` / `{"$timeout":[...]}`). By default (`onTimeout` / `onResign` undefined) the state is unchanged and the outcome is meta's `forfeit`. Only when that ends the match is the reason kept in `endReason` (D1 `matches.reason`).

### Compatibility policy

There are five kinds of version values. Don't mix them up.

| Name | Where | Meaning |
|---|---|---|
| `version` | Guide / rules headings, `version` of `/games/:id/rules`, ETag | Content hash. Changes even for a one-character typo fix. **Only a cache key, not a compatibility signal** |
| `apiVersion` | `API_VERSION` in `src/lib/version.ts`. OpenAPI `info.version`, the guide's TL;DR and rules' `apiVersion` all reference it | API version (semver) |
| `rulesVersion` | `GameDefinition.rulesVersion` (integer). Returned by `/games`, rules, state, `/log`, `/replay`, `/matches` | Version of a game's rules and action shape. Tied to the "reproducible from seed + log" guarantee. Recorded in meta at room creation (`GameRoom.init`, the same version that validated `gameOptions`). Rooms with a different version from the current one don't run (`GAME_REMOVED`). Also kept in D1 `matches.rules_version` |
| `viewVersion` | `GameDefinition.viewVersion` (integer). Returned by `/games` and rules | Version of a game's view shape. Bumped on breaking changes. Not involved in replays, so old versions needn't be kept, and matches in progress switch to the new shape too |
| WS subprotocol | `blindfold.v1` (`WS_PROTOCOLS`) | WS message version. Negotiated per connection and kept in the attachment as `protocol` |

- **0.x is experimental.** Breaking changes may ship without notice (bump the minor). The changelog is written afterwards. From 1.0.0, breaking changes bump the major.
- **Non-breaking (done any time; clients are obliged to tolerate them):** new fields in REST responses, WS messages and `view`; new WS message `type`s; new error `code`s; new games, endpoints, optional inputs and room options; wording changes in the guide, rules and error messages. The client obligations (ignore unknown fields, `type`s and `code`s) are in section 9 of the guide, the checklist and rules' `COMMON`.
- **Breaking:** removing, renaming or changing the type or meaning of a field; making an input required; changing auth; changing a game's rules or action shape.
- **Output enums (`status`, `reason`, `outcome`, etc.) may gain values** (non-breaking). In OpenAPI responses they are string + description (current values) via `openEnum()` (`src/routes/schemas.ts`). Input enums stay `z.enum`. Enums inside `view` are excluded (they follow `viewVersion`). How clients handle them (unknown `reason` treated as `normal`, etc.) is in guide section 9, the checklist and `COMMON`.
- **Output JSON Schemas don't forbid unknown fields.** `viewSchema` is a `strictObject` internally (so the all-games test can check there are no extra fields), but when served from `/rules`, `outputJsonSchema()` removes `additionalProperties: false`. Input schemas (action, room options) reject extra fields, so they stay as `z.toJSONSchema`.
- **Announcements:** `apiVersion` and `/changelog.md` (`src/lib/changelog.ts`; a test checks the top entry matches `API_VERSION`). Only when phasing something out gradually, add `Deprecation` / `Sunset` headers (RFC 9745 / 8594) to the relevant responses on a best-effort basis (in 0.x things may break without them). For a whole route use the `deprecated(info)` middleware; for something like a field, only when used, `markDeprecated(c, info)` (`src/lib/deprecation.ts`). They are in CORS `exposeHeaders`.
- **When changing rules,** bump `rulesVersion`. Old engines aren't kept, so rooms created under the previous version become `GAME_REMOVED` (410) whether waiting, in progress or finished, and can no longer be replayed (`/log` still works for finished ones). Old state, or `gameOptions` validated by an old `optionsSchema`, is never silently run on the new engine. The old rooms' data itself is removed by cleanup (`retire()` → `cleanupAt`).
- **When breaking the view shape,** bump `viewVersion` (just replace the engine).

## Free tier constraints (always respect when designing)

- Workers Free: **100,000 requests per day** (resets at 00:00 UTC). Beyond that requests error (no billing).
- WebSocket messages **received** by a DO count as **1 request per 20 messages**. **Sending is free.**
- Establishing a WebSocket connection and firing an Alarm each count as 1 request.
- DO storage (SQLite): 5 GB per account on the free tier.

Design principles:
- Moves are sent over WebSocket by default. REST `/action` is auxiliary.
- **Always use the Hibernation API** (`state.acceptWebSocket()` + a `webSocketMessage()` handler). Never `ws.accept()` (wall-clock time would be billed).
- Don't design around polling. State is pushed over WS.
- Set only one Alarm: the current turn's deadline (overwritten every time the turn advances).
- The room list lives in D1 `rooms` (an index). It's written only on create, join, leave, start and end, not on every move. Exception: during a match, if `PLAYING_INDEX_REFRESH_MS` (1 hour) has passed since the last write (`meta.indexedAt`), it's rewritten when a move is committed (so long matches don't vanish under `?status=playing`'s freshness filter). `rev` prevents stale writes from overwriting newer ones.
- Broadcasting the full `view` is fine for now. If size becomes a problem, consider diffs (JSON Patch).

## GameRoom (Durable Object) responsibilities

1. Room lifecycle: `waiting` → `playing` → `finished`
2. Player joining and token verification. WS connections carry player info via `serializeAttachment({ playerId })`
3. Receive action → validate with `actionSchema` → check turn and player → `apply` → append to log → save state → broadcast `view` to all connections
   - Decisions about what to write (resolving actions, resigns and timeouts; settling deadlines and outcomes; what the alarm does; the state to send) are pure functions in `room/logic.ts`, SQL is in `room/store.ts`, D1 statements in `room/d1.ts`. GameRoom only calls them in the order "entry (`enter` / `enterPlayer` / `enterViewer`) → decide → `commit` (one transaction) → side effects"
4. Turn time-out handling (Alarm): defined per game (auto-pass, loss, etc.). Default is a loss
5. Write results to D1 at the end
6. Cleanup: `deleteAll()` after `WAITING_ROOM_TTL_MS` (24 hours) since the last change while waiting, or `FINISHED_ROOM_TTL_MS` (7 days) after finishing, and delete the D1 `rooms` row too (`matches` and `results` are kept). The time is `meta.cleanupAt`. There's only one alarm, so it's where the alarm goes when there's no deadline or D1 retry (`wantedAlarm()`). Rooms are never deleted mid-match (except those whose engine is gone). Connections are closed with code 4001

SQLite tables (in the DO):
- `meta(key TEXT PRIMARY KEY, value TEXT)` … gameId, seed, rulesVersion, gameOptions, status, schemaVersion, hostTokenHash, cleanupAt, result (the result settled at the end; used for D1 retries and the post-match state), etc.
- `players(id TEXT PRIMARY KEY, token TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT)` … `token` is the token's hash
- `actions(turn INTEGER, player TEXT, action TEXT, at INTEGER)`
- `snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), turn INTEGER, state TEXT)`
- The schema is in `src/room/schema.ts`. New rooms are built by running BASE_SCHEMA (version 1) + `MIGRATIONS` in order; existing rooms migrate one step at a time from `meta.schemaVersion` in the constructor's `blockConcurrencyWhile`. To add columns or tables, append to the end of `MIGRATIONS` (never edit BASE_SCHEMA).

## Commands

```bash
pnpm install
pnpm dev                       # wrangler dev
pnpm test                      # vitest
pnpm typecheck                 # tsc --noEmit
pnpm deploy                    # wrangler deploy (run `pnpm wrangler d1 migrations apply blindfold --remote` first; otherwise result writes keep failing). Normally not run by hand; CI deploys (see below)
pnpm wrangler d1 migrations apply blindfold --local
pnpm tsx bots/random-bot.ts --url http://localhost:8787 --room <roomId> [--host-token <hostToken>]
pnpm tsx bots/random-bot.ts --url http://localhost:8787 --quickmatch tictactoe
```

## CI / deploy

- Direct pushes to master are blocked. Make a branch and merge through a PR.
- `.github/workflows/ci.yml`: runs `typecheck` and `test` on every PR (the required check's job name is `test`). Warns when a PR changes D1 migrations, the DO `migrations` in wrangler.jsonc, or a `rulesVersion`, because those hit production the moment the PR is merged.
- `.github/workflows/deploy.yml`: on push to master (= merge), runs tests → `d1 migrations apply --remote` → `wrangler deploy`. Skips changes that don't touch the Worker (`*.md`, `doc/`, `bots/`, `test/`, etc.), because every deploy restarts DOs and drops WS connections. Can also be run manually (`workflow_dispatch`). Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Coding conventions

- TypeScript strict. No `any` (validate external input from `unknown` with zod).
- Game logic (`src/games/`) must not depend on Cloudflare APIs. Keep it testable in plain Node.
- Throw errors as `GameError(code, message)`; the room converts them into `error` messages.
- A new game always comes with these three: (1) the `GameDefinition` implementation (including `rulesVersion: 1`, `viewVersion: 1`, `docs` and `viewSchema`; the all-games test checks that view satisfies `viewSchema` in every position and viewpoint. If `legalActions` is not defined, `practiceAction` is required; if `optionsSchema` is defined, write `docs.options` too — also checked by the all-games test), (2) registration in `registry.ts`, (3) a test where the random bot finishes 100 matches without exceptions (100 practice-vs-practice matches also run automatically in the all-games test; define `practiceAction` for games that rarely finish under random play).
- `docs` lives in `docs.ts` in the game's directory and is written in **English** (assumed to be read by LLMs; translation is left to the bot). In particular, don't omit the meaning of each `view` field or how it differs by viewpoint. Play instructions common to all games (turn, legal, errors) live in `COMMON` in `src/lib/rules.ts`; don't repeat them per game.
- The main readers are expected to be LLMs, but **site-facing text (guide, rules, docs, OpenAPI) must not say "for LLMs"**. Deterministic bots use it too, so write it so anyone can follow (code comments may say it).
- OpenAPI `summary`, `description` and `.describe()` are also written in **English** (read by LLMs like the guide and rules; a test checks no Japanese slips in). Code comments may be in Japanese.
- Secrets (token signing keys, etc.) are managed with `wrangler secret` and never committed. Locally use `.dev.vars` (gitignored).
