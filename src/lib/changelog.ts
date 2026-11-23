import { sha256Hex } from "./auth";
import { API_VERSION } from "./version";

/**
 * API の変更履歴（GET /changelog.md）。新しい版を先頭に足す。先頭の version は API_VERSION と一致させる（テストで確認する）。
 * 0.x の間は事後に書いてよい。クライアント（主にコーディングエージェント）が読むので英語で書く。
 */
export interface ChangelogEntry {
  /** API の版（semver）。 */
  version: string;
  /** 公開した日（YYYY-MM-DD、UTC）。 */
  date: string;
  /** 互換性を壊す変更。クライアントの修正が要るもの。 */
  breaking?: string[];
  /** 追加・非破壊の変更。 */
  added?: string[];
  /** 廃止予定（Deprecation / Sunset ヘッダーを付け始めたものなど）。 */
  deprecated?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.11.0",
    date: "2026-11-23",
    breaking: [
      "`frontier` rules version 2 (the state now records the round's battles). Rooms created with version 1 answer 410 `GAME_REMOVED`.",
    ],
    added: [
      "`last` in the room state (REST and WebSocket `state`): the event that produced this state, the last action-log entry " +
        "without its action (`{ turn, player, at, timeout?, resign? }`; null before the first action). Animate a `state` only " +
        "when `last.turn` changes, and draw the first `state` of a connection without animation (guide section 1.5).",
      "`endReason` in the room state: why the game ended (`normal`, `timeout`, `resign`, the same as `reason` in `end`); null " +
        "unless finished. `GET /rooms/{id}/state` now shows it too.",
      "`tictactoe` view: `lastCell` (the cell of the latest mark) and `winLine` (the three winning cells).",
      "`frontier` view: `lastBattles`, the clashes on edges and battles at nodes of the previous round in the order they were " +
        "resolved. With fog on, `lastMoves` and `lastBattles` now also include those you took part in even if you no longer " +
        "see the node (for example a node you lost, or the battle that eliminated you).",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-11-23",
    added: [
      "New game `liarsdice`: 2-6 players, each with hidden dice, take turns raising a bid on how many dice on the table " +
        "show a face, or challenge the last bid. It has game options (`startDice`, `wildOnes`, `spotOn`), does not list " +
        "legal moves (the view's `minBids` gives the smallest allowed bid per face), and keeps playing when one player " +
        "resigns or times out. Its action schema is a union of objects keyed by `type`. See `/games/liarsdice/rules.md`.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-11-22",
    added: [
      "`phaseTurn` in the room state (REST and WebSocket `state`): the turn at which the current turn began. It stays the same " +
        "through a simultaneous turn and equals `turn` otherwise (null unless playing). A `state` built before your action was " +
        "processed can arrive after you sent it; if the `turn` you sent is `>= phaseTurn` and you are still in `currentPlayers`, " +
        "wait instead of acting again.",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-11-22",
    added: [
      "New game `frontier`: 2-4 players on a generated graph. Every round all players send troop orders at the same " +
        "time and they resolve together. It has game options (`maxRounds`, `nodesPerPlayer`, `fog`), does not list " +
        "legal moves, and keeps playing when one player resigns or times out. See `/games/frontier/rules.md`.",
      "On a simultaneous turn, an action whose `turn` is older than the current one but from the same simultaneous turn " +
        "(other players acted in between) is accepted while the sender may still act, instead of failing with `STALE_TURN`. " +
        "Duplicates and turns from before the simultaneous turn still get `STALE_TURN`.",
      "A resign that does not change who may act now (for example by a player who already acted on a simultaneous turn) " +
        "keeps the current deadline and simultaneous turn, so in-flight actions are still accepted and nobody gets extra time.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-11-22",
    added: [
      "`options.seats` in `POST /rooms` and `POST /quickmatch`: the number of seats in the room, between the game's " +
        "`minPlayers` and `maxPlayers` (default `maxPlayers`; outside the range is 400). The room is full, and " +
        "`autoStart` starts it, at that many players; `practice` fills the empty seats up to it (without `seats`, " +
        "still up to `minPlayers`). `maxPlayers` in `GET /rooms` is the room's seats. Quick match only pairs rooms " +
        "with the same seats. Rematches keep it.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-11-22",
    breaking: [
      "The service is renamed from apigames to blindfold, and its base URL changes with it. The WebSocket subprotocols " +
        "are now `blindfold.v1` and `blindfold.token.<token>`; the `apigames.*` names are no longer accepted. " +
        "Rooms, users and API keys from the old URL are not carried over.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-11-22",
    breaking: [
      "Rooms are deleted: a waiting room 24 hours after its last change, a finished room 7 days after the end " +
        "(its `state`, `/log` and `/replay` then answer 404 `ROOM_NOT_FOUND`; `GET /matches` keeps the result). " +
        "Open sockets are closed with code 4001.",
      "A room ID that is not 12 lowercase hex characters gets 404 `ROOM_NOT_FOUND` on every `/rooms/{id}/...` path.",
      "A user can take only one seat per room: a second join with the same `X-Api-Key` gets 409 `ALREADY_JOINED` " +
        "(quick match skips rooms where you already sit).",
      "Rematch: calling it again after leaving the new room returns the same token as before (was a new one).",
      "WebSocket `error` messages now carry the same `code` as the REST API instead of a reduced set. A spectator's " +
        "action or resignation gets `UNAUTHORIZED` (was `NOT_YOUR_TURN`), an action or resignation before the start or " +
        "after the end gets `NOT_PLAYING` (was `ILLEGAL_ACTION`), and other REST codes such as `GAME_REMOVED` are no " +
        "longer turned into `BAD_REQUEST`.",
      "Whether you may act is decided by `currentPlayers`, not by the presence of `legal`. Games may now leave out " +
        "`legal` entirely (`listsLegalActions: false` in `GET /games` and `/games/{id}/rules`); every current game still lists it.",
      "A room records its game's `rulesVersion` when it is created, not when it starts: `rulesVersion` in the room state " +
        "is never `null` (also while waiting), and when the rules version goes up, rooms still waiting fail with " +
        "410 `GAME_REMOVED` as well.",
      "When the server finds that a room's game or rules version is gone, it closes the room's open sockets with " +
        "close code 4002 and removes the room from `GET /rooms`. Do not reconnect.",
      "`GET /rooms?status=playing` leaves out rooms with no activity for longer than their time per turn plus 2 hours.",
      "WebSocket connections are limited: at most 4 per token (opening a fifth closes the oldest with close code 4004; " +
        "do not reconnect it) and 50 spectators per room (more fail with 503 `TOO_MANY_CONNECTIONS`).",
      "A WebSocket that gets more than 20 `error` messages in a burst (one is forgiven every 10 seconds) is closed with " +
        "close code 4003. Applied actions and resignations do not count. Only the exact string `{\"type\":\"ping\"}` is " +
        "answered without counting; other pings are still answered but count like an error.",
    ],
    added: [
      "Game-specific options: `gameOptions` in `POST /rooms` and `POST /quickmatch`, described by `optionsSchema`, " +
        "`defaultGameOptions` and `options` in `/games/{id}/rules` (and `hasOptions` in `GET /games`). The value with " +
        "defaults filled in is returned as `gameOptions` in the room state, `GET /rooms`, `/log`, `/replay` and " +
        "`GET /matches`, and kept by rematches. Quick match only pairs rooms with the same game options. No current game has options yet.",
      "The WebSocket `state` message has the same fields as `GET /rooms/{id}/state`: `game`, `rulesVersion`, " +
        "`gameOptions` and `result` were added to it (and `gameOptions` to the REST state).",
      "`listsLegalActions` in `GET /games` and `/games/{id}/rules`.",
      "Per-IP rate limits on `POST /users`, `POST /rooms`, `POST /quickmatch`, `POST /rooms/{id}/join` and " +
        "`POST /rooms/{id}/rematch`, on WebSocket upgrades, and on the other room endpoints, `GET /rooms`, " +
        "`GET /matches` and `GET /users/{id}`: over the limit they fail with 429 `RATE_LIMITED` and a `Retry-After` header.",
      "`POST /users/{id}/key` issues a new API key; the old one stops working.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-11-22",
    breaking: [
      "The WebSocket subprotocol is now versioned and required: offer `apigames.v1` (instead of `apigames`), also when " +
        "spectating or when sending the token with `Authorization: Bearer`. The server answers with `apigames.v1`. " +
        "The token subprotocol `apigames.token.<token>` is unchanged.",
      "In `/openapi.json`, `status`, `reason` and `outcome` in responses are typed as strings instead of closed enums; " +
        "their descriptions list today's values. New values may be added (guide, section 9).",
      "`RULES_CHANGED` is replaced by `GAME_REMOVED` (410). When a game's `rulesVersion` goes up, rooms started with an " +
        "older version (in progress or finished) fail with `GAME_REMOVED` everywhere except `/rooms/{id}/log`.",
    ],
    added: [
      "`GAME_REMOVED` (410): the game, or the rules version a room was started with, is no longer available on the " +
        "server. `/rooms/{id}/log` keeps working.",
      "`viewVersion` in `GET /games` and `/games/{id}/rules`: bumped on breaking changes to a game's `view`.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-11-22",
    added: [
      "`rulesVersion`: the version of each game's rules (an integer). Listed in `GET /games` and `/games/{id}/rules`, " +
        "recorded when a room starts and returned in `GET /rooms/{id}/state`, `/log`, `/replay` and `GET /matches`.",
      "`GET /rooms/{id}/replay` fails with `RULES_CHANGED` (409) when the game was played with different rules than the " +
        "server runs now. `/log` keeps working.",
      "`GET /changelog.md`: this page.",
      "`Deprecation`, `Sunset` and `Link` response headers may mark features that are being phased out, and are exposed through CORS.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-11-22",
    added: [
      "First version with a published compatibility policy (guide, section 9). `apiVersion` appears in the guide, " +
        "in `/games/{id}/rules` and as `info.version` in `/openapi.json`.",
      "The `viewSchema` in `/games/{id}/rules` no longer forbids extra fields: new `view` fields may be added at any time.",
    ],
  },
];

function renderEntry(e: ChangelogEntry): string {
  const section = (title: string, items: string[] | undefined) =>
    items?.length ? [`### ${title}`, "", ...items.map((i) => `- ${i}`), ""] : [];
  return [
    `## ${e.version} (${e.date})`,
    "",
    ...section("Breaking", e.breaking),
    ...section("Added", e.added),
    ...section("Deprecated", e.deprecated),
  ].join("\n");
}

function buildChangelog(): string {
  return [
    "# blindfold — Changelog",
    "",
    `Current API version: ${API_VERSION}. Newest first. While the API version is 0.x, breaking changes may be released`,
    "without notice and are recorded here afterwards. See section 9 of `/guide.md` for what counts as breaking.",
    "History starts at 0.2.0; earlier changes are not listed.",
    "",
    ...CHANGELOG.map(renderEntry),
  ].join("\n");
}

let cached: Promise<{ version: string; body: string }> | null = null;

/** 変更履歴の Markdown と、その内容のハッシュ（ETag）。 */
export function changelog(): Promise<{ version: string; body: string }> {
  return (cached ??= (async () => {
    const body = buildChangelog();
    return { version: (await sha256Hex(body)).slice(0, 12), body };
  })());
}
