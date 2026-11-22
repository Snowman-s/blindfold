import { z } from "zod";
import type { AnyGame } from "../games/types";
import { sha256Hex } from "./auth";
import { compactJson, gameExamples, type EndMessage, type ExampleState } from "./examples";
import { defaultGameOptions } from "./options";
import { API_VERSION, outputJsonSchema } from "./version";

/**
 * ゲームの説明（GET /games/:id/rules）を組み立てる。Bot 上の LLM がプロンプトに入れて読むことを想定する。
 * 全ゲームに共通の遊び方（ターン・合法手・エラー）は COMMON に書き、各ゲームの docs には書かない。
 */

// LLM 向けの文面は英語で書く（Bot 側で必要なら翻訳される）。
const COMMON = [
  "## How to play (all games)",
  "- State arrives as a WebSocket `state` message (or from `GET /rooms/{id}/state`). `view` is the board as you see it; `currentPlayers` lists who may act now. **You may act when your player ID is in `currentPlayers`.**",
  "- If the game lists legal moves (`listsLegalActions: true`, the usual case), they are in `legal` whenever you may act. **Pick one and send it unchanged as `action`; it is always accepted.** If the game does not list them (`listsLegalActions: false`), `legal` is never sent: build the action from the action schema and the rules below.",
  '- To act, send `{ "type": "action", "turn": <turn from the latest state>, "action": <your action> }` over the WebSocket (`GET /rooms/{id}/ws`).',
  "- REST alternative: `POST /rooms/{id}/action` with `{ turn, action }`. REST has no way to wait for the other players, so to play a full game use the WebSocket: it pushes a new `state` whenever the turn changes. Use REST for single actions or debugging, not polling.",
  "- If `turn` does not match the current turn, the action is rejected with `STALE_TURN`. Wait for the next `state` and retry. Exception: on a simultaneous turn (several players in `currentPlayers`), `turn` goes up each time someone acts; an action with an older `turn` from the same simultaneous turn is accepted as long as you are still in `currentPlayers`.",
  "- A `state` built before your action was processed may arrive after you sent it. `phaseTurn` is the turn at which the current turn began (it stays the same through a simultaneous turn; otherwise it equals `turn`). If the `turn` you sent is `>= phaseTurn` and you are still in `currentPlayers`, your action has not been processed yet: wait instead of sending again.",
  "- Each turn has a `deadline` (epoch ms, server clock). Missing it is a timeout. Every `state` also has `now` (server clock), so the time left is `deadline - now`; do not compare `deadline` with your own clock.",
  "- Disconnecting is not a loss: reconnect with the same token and act before `deadline`. The first message after connecting is the current `state`.",
  "- Error codes (the same over the WebSocket and REST): `ILLEGAL_ACTION` (illegal move), `NOT_YOUR_TURN` (you may not act now), `STALE_TURN` (outdated turn), `NOT_PLAYING` (the game has not started or is over), `UNAUTHORIZED` (no valid player token, e.g. a spectator), `BAD_REQUEST` (malformed message or action), `INTERNAL` (server failure; resend if the turn is still current).",
  '- To give up, send `{ "type": "resign" }` (or `POST /rooms/{id}/resign`). Allowed at any time during play, even when it is not your turn. Unless this game\'s rules say otherwise, you lose, all other players win, and the game ends.',
  "- When the game ends you receive an `end` message with `winners` (empty for a draw), `scores` and `reason` (`normal`, `timeout` or `resign`).",
  "- New fields, message `type`s and error codes may be added at any time. Ignore fields you do not know (the `view` schema does not forbid extra fields), skip unknown message types, and treat an unknown error code like `BAD_REQUEST`.",
  "- Enum-like fields outside `view` may get new values: treat an unknown `reason` like `normal`, and an unknown `status` as neither `waiting` nor `finished` (wait for the next `state`).",
  "- When the rules below change, `rulesVersion` goes up and rooms created with an older version (even ones still waiting) can no longer be played or replayed (`GAME_REMOVED`; the `/log` of a finished one stays available). Breaking changes to `view` bump `viewVersion`.",
].join("\n");

export interface GameRules {
  id: string;
  version: string;
  apiVersion: string;
  rulesVersion: number;
  viewVersion: number;
  minPlayers: number;
  maxPlayers: number;
  listsLegalActions: boolean;
  summary: string;
  rules: string;
  view: string;
  viewSchema: unknown;
  actionSchema: unknown;
  optionsSchema: unknown;
  defaultGameOptions: unknown;
  options: string | null;
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
        apiVersion: API_VERSION,
        rulesVersion: game.rulesVersion,
        viewVersion: game.viewVersion,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        listsLegalActions: game.legalActions !== undefined,
        summary: game.docs.summary,
        rules: game.docs.rules,
        view: game.docs.view,
        viewSchema: outputJsonSchema(game.viewSchema),
        actionSchema: z.toJSONSchema(game.actionSchema),
        // 入力なので余計なキーを拒否する Schema のまま配る
        optionsSchema: game.optionsSchema ? z.toJSONSchema(game.optionsSchema) : null,
        defaultGameOptions: defaultGameOptions(game),
        options: game.docs.options ?? null,
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
    `# ${r.id} (${r.minPlayers === r.maxPlayers ? r.minPlayers : `${r.minPlayers}-${r.maxPlayers}`} players, rulesVersion ${r.rulesVersion}, viewVersion ${r.viewVersion}, apiVersion ${r.apiVersion}, version ${r.version})`,
    "",
    r.summary,
    "",
    "## Rules",
    r.rules,
    "",
    "## Reading `view`",
    r.view,
    "",
    "JSON Schema of `view` (a union of all viewers: fields that only some viewers receive are optional; fields may be added later, so ignore unknown ones):",
    json(r.viewSchema),
    "",
    "## Action format",
    "`action` is an object matching this JSON Schema:",
    json(r.actionSchema),
    "",
    r.listsLegalActions
      ? "When you may act, `legal` lists every legal action; sending one of them unchanged is always accepted."
      : "This game does **not** list legal moves: `legal` is never sent. Build the action yourself from the schema and the rules; an illegal one is rejected with `ILLEGAL_ACTION` and you may try again before the deadline.",
    "",
    "Examples:",
    examples,
    "",
    ...(r.optionsSchema === null
      ? []
      : [
          "## Game options",
          "Pass these as `gameOptions` in `POST /rooms` (or `POST /quickmatch`). Omitted fields take their defaults; unknown keys are rejected. The options of a room are in `gameOptions` of every `state`.",
          "",
          ...(r.options ? [r.options, ""] : []),
          "JSON Schema:",
          json(r.optionsSchema),
          "",
          "Defaults:",
          json(r.defaultGameOptions),
          "",
        ]),
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
