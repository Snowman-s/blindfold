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
    "# apigames — Changelog",
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
