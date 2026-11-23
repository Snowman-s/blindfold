import { sha256Hex } from "./auth";

/**
 * 利用上の約束事（GET /policy.md）。利用規約ほど堅くはしないが、無料枠を共有していること、
 * 公開されるデータと残し方、運営側ができることを明記する。保持期間は約束にしないため数字は書かない（実際の値はガイドに載る）。
 * サイトに出す文なので英語で書き、「LLM 向け」とは書かない。ここに書くことは実装と一致させる。
 */
const REPO = "https://github.com/Snowman-s/blindfold";

function buildPolicy(): string {
  return [
    "# blindfold — Usage Policy",
    "",
    "blindfold is a hobby project run by one person. It is free to use and there is no sign-up. These are not formal",
    "terms of service, just the ground rules that keep it working for everyone. Please follow them when using the API.",
    "",
    "## 1. Bots are welcome",
    "",
    "Clients of any kind are fine: hand-written bots, programs that ask a language model what to play, your own UI or",
    "spectator viewer. You do not need permission to connect, to build on the API, or to publish your client.",
    "",
    "## 2. The budget is shared",
    "",
    "The whole service runs on a free hosting tier with a fixed number of requests per day, shared by everyone. When it",
    "runs out, the service stops for every player until 00:00 UTC. So:",
    "",
    "- Receive state over the WebSocket; do not poll REST endpoints in a loop.",
    "- Reconnect with a delay that grows after each failure, not immediately and forever.",
    "- When you get `429 RATE_LIMITED`, wait for the `Retry-After` seconds before trying again.",
    "- Create rooms and users only when you use them. Do not create them in bulk, and do not keep many idle",
    "  connections open.",
    "- Do not load test or benchmark this server. Run your own copy for that (the source is MIT-licensed, see",
    `  ${REPO}).`,
    "",
    "## 3. Play fair",
    "",
    "- Do not try to see information that your view does not show (other players' hidden cards or dice, the seed of a",
    "  match in progress), and do not attack the server or other clients.",
    "- If you find a bug that lets you cheat or see hidden information, report it instead of using it (section 7).",
    "- Do not create users or sit in several seats of the same match to inflate a user's results.",
    "- Practice against yourself or the server's practice opponents (`options.practice`) as much as you like.",
    "",
    "## 4. What is public",
    "",
    "- Anyone who knows a room's `roomId` can watch it as a spectator. Listed rooms appear in `GET /rooms`; unlisted",
    "  rooms do not, but they are not private.",
    "- After a match ends, its full log (every action, the seed and the options) can be read by anyone via",
    "  `/rooms/{id}/log` and `/replay`.",
    "- A user's `name` and results are public through `GET /users/{id}`, and `GET /matches` shows which `userId` played",
    "  each match.",
    "",
    "Do not put personal information (real names, contact details) or anything offensive in a user name, and do not use",
    "names, rooms or actions to send messages to other people.",
    "",
    "## 5. What is kept",
    "",
    "- Rooms are deleted automatically some time after they are left waiting or after the match ends; a finished",
    "  room's log and replay go with it. Save anything you want to keep.",
    "- Match results (`/matches`, `/users/{id}`) and users are kept with no fixed end date, but nothing is kept for",
    "  certain (section 6).",
    "- Player tokens and API keys are stored only as hashes. Nobody, including the operator, can show you a lost key; keep",
    "  your API key secret, and replace it with `POST /users/{id}/key` if it leaks.",
    "- IP addresses are used for rate limiting and are not stored by blindfold. The hosting provider keeps request logs,",
    "  which can include IP addresses, for a short time.",
    "- There is no endpoint to delete a user or results, and removal on request is not promised. The operator is not",
    "  responsible for what anyone registers or sends (user names included), nor for registrations you later regret.",
    "",
    "## 6. No guarantees",
    "",
    "- The service is provided as is. It may be slow, unavailable, reset, changed or shut down at any time, and data may",
    "  be lost. It may have security flaws, and the operator is not responsible for them or for any damage from using",
    "  it. Results have no value outside the service.",
    "- While the API version is 0.x, the API may change in breaking ways without notice (see section 9 of `/guide.md`",
    "  and `/changelog.md`).",
    "- To protect the service, the operator may delete rooms, users or results, or block clients, without notice.",
    "- This page may change. Its `ETag` changes when it does.",
    "",
    "## 7. Contact",
    "",
    `Bugs (security problems and cheating exploits included) and questions: open an issue at ${REPO}/issues.`,
    "",
  ].join("\n");
}

let cached: Promise<{ version: string; body: string }> | null = null;

/** 約束事の Markdown と、その内容のハッシュ（ETag）。 */
export function policy(): Promise<{ version: string; body: string }> {
  return (cached ??= (async () => {
    const body = buildPolicy();
    return { version: (await sha256Hex(body)).slice(0, 12), body };
  })());
}
