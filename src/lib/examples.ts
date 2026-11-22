import type { AnyGame } from "../games/types";
import { defaultGameOptions } from "./options";
import { practiceAction } from "./practice";
import type { LogEntry, ReplayLog } from "./replay";
import { createRng, rngForTurn } from "./rng";
import type { ServerMessage } from "./protocol";

/**
 * ガイド・ルール説明に載せる例を実際のエンジンから作る（view の形が変わっても例が古くならない）。
 * version（ETag）が安定するよう、シード・時刻はすべて固定値にする（Date.now() は使わない）。
 */

/** 例の state に入れる締め切り（固定値。実際は epoch ms の現在時刻 + 持ち時間）。 */
export const EXAMPLE_DEADLINE = 1767225600000;
/** 例の state に入れるサーバー時刻（締め切りの 4 分 50 秒前）。 */
export const EXAMPLE_NOW = EXAMPLE_DEADLINE - 290_000;
/** 例のプレイヤー（そのゲームの最少人数だけ座らせる）。 */
export const examplePlayers = (game: AnyGame): string[] =>
  Array.from({ length: game.minPlayers }, (_, i) => `p${i + 1}`);
const EXAMPLE_SEED = "9f2c4e1a7b3d5f60a1c3e5f7092b4d6e";
/** 例のログの時刻（試合開始から1手ごとに 7 秒ずつ進める）。 */
const EXAMPLE_STARTED_AT = EXAMPLE_NOW - 60_000;

export type StateMessage = Extract<ServerMessage, { type: "state" }>;
export type EndMessage = Extract<ServerMessage, { type: "end" }>;

export interface ExampleState {
  /** 英語の見出し（例: "Start of the game, as p1 (may act now)"）。 */
  title: string;
  message: StateMessage;
}

export interface GameExamples {
  /** 1手進めた局面で、今行動できるプレイヤー。 */
  actor: string;
  /** 1手進めた局面・行動できるプレイヤーの視点（legal 付き）。 */
  player: StateMessage;
  /** 1手進めた局面・観戦視点。 */
  spectator: StateMessage;
  /** 開始直後・1手後（全視点）・決着後を並べたもの。/games/:id/rules に載せる。 */
  states: ExampleState[];
  /** 決着後に届く end メッセージ。 */
  end: EndMessage;
  /** 決着までの行動ログ（/rooms/:id/log の形）。 */
  log: ReplayLog;
}

function stateMessage(
  game: AnyGame,
  state: unknown,
  turn: number,
  pid: string | null,
  status: "playing" | "finished",
): StateMessage {
  const current = status === "playing" ? game.currentPlayers(state) : [];
  const legal = pid && current.includes(pid) ? game.legalActions?.(state, pid) : undefined;
  return {
    type: "state",
    game: game.id,
    rulesVersion: game.rulesVersion,
    gameOptions: defaultGameOptions(game),
    status,
    turn,
    players: examplePlayers(game),
    currentPlayers: current,
    view: game.view(state, pid),
    ...(legal ? { legal } : {}),
    deadline: status === "playing" ? EXAMPLE_DEADLINE : null,
    now: EXAMPLE_NOW,
    result: game.result(state),
  };
}

/** 例の最初の手。合法手を列挙するゲームはその先頭、しないゲームは練習相手の打ち方（固定シード）。 */
function firstActionOf(game: AnyGame, s: unknown, pid: string, seed: string): unknown {
  if (game.legalActions) return game.legalActions(s, pid)[0];
  const pick = practiceAction(game, s, pid, createRng(`${seed}:first`));
  if (!pick) throw new Error(`${game.id}: no first action for the example`);
  return pick.action;
}

const cache = new Map<string, GameExamples>();

/** 固定シードで、開始直後・1手後・決着後の例を作る。決着までは練習相手の打ち方で進める（必ず終わる）。 */
export function gameExamples(game: AnyGame): GameExamples {
  const hit = cache.get(game.id);
  if (hit) return hit;

  const seed = EXAMPLE_SEED;
  const players = examplePlayers(game);
  const gameOptions = defaultGameOptions(game);
  const s0 = game.init(players, seed, gameOptions);
  const first = game.currentPlayers(s0)[0]!;
  const firstAction = firstActionOf(game, s0, first, seed);
  const s1 = game.apply(s0, first, firstAction, rngForTurn(seed, 0));
  const actor = game.currentPlayers(s1)[0] ?? first;
  const player = stateMessage(game, s1, 1, actor, "playing");
  const spectator = stateMessage(game, s1, 1, null, "playing");

  const states: ExampleState[] = [
    { title: `Start of the game (turn 0), as **${first}** (may act now)`, message: stateMessage(game, s0, 0, first, "playing") },
    {
      title: `After ${first} played \`${JSON.stringify(firstAction)}\` (turn 1), as **${actor}** (may act now)`,
      message: player,
    },
  ];
  // 今打った人の視点が観戦視点と違う（同時手番で伏せた札が見えるなど）ときだけ載せる
  if (actor !== first) {
    const mover = stateMessage(game, s1, 1, first, "playing");
    if (JSON.stringify(mover.view) !== JSON.stringify(spectator.view) || mover.legal) {
      states.push({ title: `The same moment as **${first}**, who has just acted`, message: mover });
    }
  }
  states.push({ title: "The same moment as a **spectator** (no token)", message: spectator });

  // 決着まで進める
  const actions: LogEntry[] = [{ turn: 0, player: first, action: firstAction, at: EXAMPLE_STARTED_AT }];
  const rng = createRng(`${seed}:practice`);
  let s = s1;
  let turn = 1;
  while (game.result(s) === null) {
    const pid = game.currentPlayers(s)[0];
    const pick = pid === undefined ? undefined : practiceAction(game, s, pid, rng);
    if (pid === undefined || !pick) throw new Error(`${game.id}: example game got stuck at turn ${turn}`);
    actions.push({ turn, player: pid, action: pick.action, at: EXAMPLE_STARTED_AT + turn * 7000 });
    s = game.apply(s, pid, pick.action, rngForTurn(seed, turn));
    if (++turn > 1000) throw new Error(`${game.id}: example game did not end`);
  }
  const result = game.result(s)!;
  states.push({
    title: `After the last action (turn ${turn}), as **${first}**. \`status\` is \`finished\`; an \`end\` message follows`,
    message: stateMessage(game, s, turn, first, "finished"),
  });
  const end: EndMessage = {
    type: "end",
    winners: result.winners,
    ...(result.scores ? { scores: result.scores } : {}),
    reason: "normal",
  };

  const out: GameExamples = {
    actor,
    player,
    spectator,
    states,
    end,
    log: { game: game.id, rulesVersion: game.rulesVersion, seed, gameOptions, players, actions },
  };
  cache.set(game.id, out);
  return out;
}

/**
 * 読みやすさを保ったまま短くした JSON。収まる値は1行にし、収まらないものだけ展開する。
 * rules.md はプロンプトにそのまま入るので、2スペースの全展開よりトークンを節約する。
 */
export function compactJson(v: unknown, width = 100, indent = ""): string {
  const flat = JSON.stringify(v);
  if (flat === undefined) return "null";
  if (indent.length + flat.length <= width || v === null || typeof v !== "object") return flat;
  const inner = indent + "  ";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => inner + compactJson(x, width, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return "{}";
  const body = entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${compactJson(x, width, inner)}`).join(",\n");
  return `{\n${body}\n${indent}}`;
}
