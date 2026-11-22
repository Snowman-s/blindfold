import { z } from "zod";
import type { AnyGame } from "../games/types";
import { sha256Hex } from "./auth";
import { compactJson, gameExamples, type EndMessage, type ExampleState } from "./examples";

/**
 * ゲームの説明（GET /games/:id/rules）を組み立てる。Bot 上の LLM がプロンプトに入れて読むことを想定する。
 * 全ゲームに共通の遊び方（ターン・合法手・エラー）は COMMON に書き、各ゲームの docs には書かない。
 */

// LLM 向けの文面は英語で書く（Bot 側で必要なら翻訳される）。
const COMMON = [
  "## How to play (all games)",
  "- State arrives as a WebSocket `state` message (or from `GET /rooms/{id}/state`). `view` is the board as you see it; `currentPlayers` lists who may act now.",
  "- **Legal moves are listed in `legal`. Pick one and send it unchanged as `action`; it is always accepted.** `legal` is present only when you may act now.",
  '- To act, send `{ "type": "action", "turn": <turn from the latest state>, "action": <one of legal> }` over the WebSocket (`GET /rooms/{id}/ws`).',
  "- REST alternative: `POST /rooms/{id}/action` with `{ turn, action }`. REST has no way to wait for the other players, so to play a full game use the WebSocket: it pushes a new `state` whenever the turn changes. Use REST for single actions or debugging, not polling.",
  "- If `turn` does not match the current turn, the action is rejected with `STALE_TURN`. Wait for the next `state` and retry.",
  "- Each turn has a `deadline` (epoch ms, server clock). Missing it is a timeout. Every `state` also has `now` (server clock), so the time left is `deadline - now`; do not compare `deadline` with your own clock.",
  "- Disconnecting is not a loss: reconnect with the same token and act before `deadline`. The first message after connecting is the current `state`.",
  "- Error codes: `ILLEGAL_ACTION` (illegal move), `NOT_YOUR_TURN` (you may not act now), `STALE_TURN` (outdated turn), `BAD_REQUEST` (malformed message), `INTERNAL` (server failure; resend if the turn is still current).",
  '- To give up, send `{ "type": "resign" }` (or `POST /rooms/{id}/resign`). Allowed at any time during play, even when it is not your turn. Unless this game\'s rules say otherwise, you lose, all other players win, and the game ends.',
  "- When the game ends you receive an `end` message with `winners` (empty for a draw), `scores` and `reason` (`normal`, `timeout` or `resign`).",
].join("\n");

export interface GameRules {
  id: string;
  version: string;
  minPlayers: number;
  maxPlayers: number;
  summary: string;
  rules: string;
  view: string;
  viewSchema: unknown;
  actionSchema: unknown;
  examples: { action: unknown; meaning: string }[];
  stateExamples: ExampleState[];
  endExample: EndMessage;
  common: string;
}

const cache = new Map<string, Promise<GameRules>>();

/** 説明は静的なので、ゲームごとに1回だけ組み立てて使い回す。version は内容のハッシュ。 */
export function gameRules(game: AnyGame): Promise<GameRules> {
  let p = cache.get(game.id);
  if (!p) {
    p = (async () => {
      const ex = gameExamples(game);
      const body = {
        id: game.id,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        summary: game.docs.summary,
        rules: game.docs.rules,
        view: game.docs.view,
        viewSchema: z.toJSONSchema(game.viewSchema),
        actionSchema: z.toJSONSchema(game.actionSchema),
        examples: game.docs.examples,
        stateExamples: ex.states,
        endExample: ex.end,
        common: COMMON,
      };
      return { ...body, version: (await sha256Hex(JSON.stringify(body))).slice(0, 12) };
    })();
    cache.set(game.id, p);
  }
  return p;
}

/** プロンプトにそのまま貼れる Markdown 1枚。 */
export function rulesMarkdown(r: GameRules): string {
  const examples = r.examples.map((e) => `- \`${JSON.stringify(e.action)}\` : ${e.meaning}`).join("\n");
  const json = (v: unknown) => ["```json", compactJson(v), "```"].join("\n");
  const states = r.stateExamples.map((e) => `${e.title}:\n${json(e.message)}`).join("\n\n");
  return [
    `# ${r.id} (${r.minPlayers === r.maxPlayers ? r.minPlayers : `${r.minPlayers}-${r.maxPlayers}`} players, version ${r.version})`,
    "",
    r.summary,
    "",
    "## Rules",
    r.rules,
    "",
    "## Reading `view`",
    r.view,
    "",
    "JSON Schema of `view` (a union of all viewers: fields that only some viewers receive are optional):",
    json(r.viewSchema),
    "",
    "## Action format",
    "`action` is an object matching this JSON Schema:",
    json(r.actionSchema),
    "",
    "Examples:",
    examples,
    "",
    "## Example messages",
    "Generated from the real game engine with a fixed seed. `deadline` and `now` are placeholder timestamps.",
    "",
    states,
    "",
    "Then everyone receives the `end` message:",
    json(r.endExample),
    "",
    r.common,
    "",
  ].join("\n");
}
