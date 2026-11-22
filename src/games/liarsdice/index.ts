import { z } from "zod";
import { GameError, type GameDefinition } from "../types";
import { createRng, type Rng } from "../../lib/rng";
import { docs } from "./docs";

/**
 * ライアーズダイス（Dudo 系のブラフダイス。2〜6人、手番制）。
 * 各自がダイスを振って自分の目だけを見る。手番の人は「全員のダイスの中に face の目が quantity 個以上ある」という
 * 宣言を前より大きくするか、直前の宣言にダウト（challenge）をかける。外れた側がダイスを1個失い、最後に残った1人が勝ち。
 * 乱数はラウンドの始め（ダイスを振るとき）だけ引く。ルールの説明（英語）は docs.ts。
 */

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const FACES = 6;

export interface Bid {
  player: string;
  quantity: number;
  face: number;
}
export type OutReason = "eliminated" | "resigned" | "timedOut";

/** ラウンドを終わらせたコール（challenge / exact）の公開結果。 */
export interface Reveal {
  /** そのラウンドの番号。 */
  round: number;
  /** 全員のダイス（昇順）。 */
  dice: Record<string, number[]>;
  bids: Bid[];
  call: "challenge" | "exact";
  caller: string;
  /** 宣言の face に数えられたダイスの数（ワイルドを含む）。 */
  count: number;
  /** ダイスを1個失ったプレイヤー。exact が当たったときは null。 */
  loser: string | null;
  /** exact が当たってダイスを1個取り戻したプレイヤー（上限で増えなかったときも caller）。 */
  gainer: string | null;
}

export interface LiarsDiceOptions {
  startDice: number;
  wildOnes: boolean;
  spotOn: boolean;
}

export interface LiarsDiceState {
  players: string[];
  /** まだダイスを持っているプレイヤー（席順）。 */
  alive: string[];
  out: Record<string, OutReason>;
  /** 抜けたときに、すでに抜けていた人数（順位の点数になる）。 */
  outRank: Record<string, number>;
  /** 各自の今ラウンドの目（昇順）。抜けた人は []。 */
  dice: Record<string, number[]>;
  /** 今のラウンドの番号（1 から。ダイスを振るたびに増える）。 */
  round: number;
  /** 今ラウンドの宣言（古い順）。 */
  bids: Bid[];
  /** 手番のプレイヤー。決着後は null。 */
  turnPlayer: string | null;
  lastRound: Reveal | null;
  options: LiarsDiceOptions;
}

export type LiarsDiceAction =
  | { type: "bid"; quantity: number; face: number }
  | { type: "challenge" }
  | { type: "exact" };

const optionsSchema = z.strictObject({
  startDice: z.number().int().min(1).max(10).default(5).describe("Dice each player starts with (default 5)"),
  wildOnes: z
    .boolean()
    .default(true)
    .describe("Ones are wild: they count toward every other face, and bids on ones follow the special rules (default true)"),
  spotOn: z
    .boolean()
    .default(false)
    .describe('Allow the "exact" call: claim the current bid is exactly right to win back a die (default false)'),
});

const face = z.number().int().min(1).max(FACES);
const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("bid"),
    quantity: z.number().int().min(1).max(1000).describe("How many dice (among everyone's) you claim show `face`"),
    face: face.describe("The face value, 1-6"),
  }),
  z.strictObject({ type: z.literal("challenge").describe("Call the previous bid a lie: all dice are revealed") }),
  z.strictObject({
    type: z.literal("exact").describe("Claim the previous bid is exactly right (only with the spotOn option)"),
  }),
]);

const pidMap = <T extends z.ZodType>(v: T) => z.record(z.string(), v);
const bidSchema = z.strictObject({
  player: z.string().describe("Who made the bid"),
  quantity: z.number().int(),
  face: z.number().int(),
});
const viewSchema = z.strictObject({
  startDice: z.number().int().describe("Dice each player started with (game option; also the most dice anyone can hold)"),
  wildOnes: z.boolean().describe("Whether ones are wild (game option)"),
  spotOn: z.boolean().describe('Whether the "exact" call is allowed (game option)'),
  round: z.number().int().min(1).describe("Current round number, from 1. Goes up each time the dice are rolled"),
  players: z.array(z.string()).describe("All player IDs in seat order"),
  alive: z.array(z.string()).describe("Players who still have dice, in seat order"),
  out: pidMap(z.enum(["eliminated", "resigned", "timedOut"])).describe("Player ID -> why that player left the game"),
  diceCounts: pidMap(z.number().int().min(0)).describe("Player ID -> number of dice they hold"),
  totalDice: z.number().int().min(0).describe("Total dice in play (the sum of diceCounts). No bid may exceed it"),
  bids: z.array(bidSchema).describe("Bids made this round, oldest first"),
  currentBid: bidSchema.nullable().describe("The bid to beat (the last of `bids`), or null at the start of a round"),
  minBids: z
    .array(z.number().int().nullable())
    .length(FACES)
    .describe("minBids[face - 1] = the smallest quantity you may bid on that face now, or null if no bid on it is allowed"),
  lastRound: z
    .strictObject({
      round: z.number().int(),
      dice: pidMap(z.array(z.number().int())).describe("Player ID -> that player's dice in that round, ascending"),
      bids: z.array(bidSchema),
      call: z.enum(["challenge", "exact"]),
      caller: z.string(),
      count: z.number().int().describe("How many dice counted for the called bid's face (wild ones included)"),
      loser: z.string().nullable().describe("Who lost a die, or null when an exact call was right"),
      gainer: z.string().nullable().describe("Who won back a die with a right exact call, or null"),
    })
    .nullable()
    .describe("How the last finished round was settled, with every die revealed. null before the first call"),
  myDice: z
    .array(z.number().int().min(1).max(FACES))
    .optional()
    .describe("Players only (absent for spectators): your dice this round, ascending. Empty once you are out"),
});

// ---- 補助 ----

const isOver = (s: LiarsDiceState): boolean => s.alive.length <= 1;
const totalDice = (s: LiarsDiceState): number => s.alive.reduce((t, p) => t + s.dice[p]!.length, 0);
const counts = (d: number, f: number, wild: boolean) => d === f || (wild && f !== 1 && d === 1);
const countFace = (s: LiarsDiceState, f: number): number =>
  s.alive.reduce((t, p) => t + s.dice[p]!.filter((d) => counts(d, f, s.options.wildOnes)).length, 0);

/** 席順で p の次にいる、まだ遊んでいるプレイヤー（p 自身が抜けていても、その席の次から探す）。 */
function nextAlive(s: LiarsDiceState, p: string): string {
  const i = s.players.indexOf(p);
  for (let k = 1; k <= s.players.length; k++) {
    const q = s.players[(i + k) % s.players.length]!;
    if (s.alive.includes(q)) return q;
  }
  return s.alive[0]!;
}

/**
 * face に今出せる最小の数。出せなければ null。
 * ワイルドありのとき：1 以外 → 1 は半分（切り上げ）以上、1 → 1 以外は 2 倍 + 1 以上、ラウンドの最初に 1 は宣言できない。
 */
function minQuantity(s: LiarsDiceState, f: number): number | null {
  const cur = s.bids.at(-1);
  const wild = s.options.wildOnes;
  let q: number;
  if (!cur) {
    if (wild && f === 1) return null;
    q = 1;
  } else if (!wild || ((cur.face === 1) === (f === 1))) {
    q = f > cur.face ? cur.quantity : cur.quantity + 1;
  } else if (f === 1) {
    q = Math.ceil(cur.quantity / 2);
  } else {
    q = cur.quantity * 2 + 1;
  }
  return q <= totalDice(s) ? q : null;
}

const minBids = (s: LiarsDiceState): (number | null)[] =>
  Array.from({ length: FACES }, (_, i) => (isOver(s) ? null : minQuantity(s, i + 1)));

function roll(n: number, rng: Rng): number[] {
  return Array.from({ length: n }, () => 1 + rng.int(FACES)).sort((a, b) => a - b);
}

/** 新しいラウンド：残っている全員が振り直し、starter から始める。決着していれば手番なし。 */
function newRound(s: LiarsDiceState, starter: string, rng: Rng): LiarsDiceState {
  if (isOver(s)) return { ...s, bids: [], turnPlayer: null };
  const dice = { ...s.dice };
  for (const p of s.alive) dice[p] = roll(dice[p]!.length, rng); // 席順に振る（再現のため順番は固定）
  return { ...s, dice, round: s.round + 1, bids: [], turnPlayer: s.alive.includes(starter) ? starter : nextAlive(s, starter) };
}

/** プレイヤーを抜けさせる（ダイスを失う）。ラウンドはまだ振り直さない。 */
function drop(s: LiarsDiceState, pids: string[], reason: OutReason): LiarsDiceState {
  const rank = s.players.length - s.alive.length;
  const out = { ...s.out };
  const outRank = { ...s.outRank };
  const dice = { ...s.dice };
  for (const p of pids) {
    out[p] = reason;
    outRank[p] = rank;
    dice[p] = [];
  }
  return { ...s, alive: s.alive.filter((p) => !pids.includes(p)), out, outRank, dice };
}

/** p のダイスを delta 個増減する（上限 startDice）。0 個になったら脱落。目は次のラウンドで振り直すので、個数だけが意味を持つ。 */
function changeDice(s: LiarsDiceState, p: string, delta: number): LiarsDiceState {
  const cur = s.dice[p]!;
  const n = Math.min(s.options.startDice, cur.length + delta);
  if (n <= 0) return drop(s, [p], "eliminated");
  const dice = n <= cur.length ? cur.slice(0, n) : [...cur, ...Array<number>(n - cur.length).fill(1)];
  return { ...s, dice: { ...s.dice, [p]: dice } };
}

/** ラウンドの途中で誰かが抜けたとき：そのラウンドは無効にして振り直す（抜けた人のダイスも数に入っていたため）。 */
function leave(s: LiarsDiceState, pids: string[], reason: OutReason, rng: Rng): LiarsDiceState {
  // 手番の人が残っていればその人から、抜けたなら席順でその次の人からやり直す（newRound が次の人を探す）
  return newRound(drop(s, pids, reason), s.turnPlayer ?? pids[0]!, rng);
}

// ---- 練習相手 ----

/** 自分の目と、他人のダイスの期待値だけで決める。宣言が期待値を大きく超えたらダウト、そうでなければ一番有望な目を最小の数で上げる。 */
function practice(s: LiarsDiceState, pid: string, rng: Rng): LiarsDiceAction {
  const wild = s.options.wildOnes;
  const mine = s.dice[pid]!;
  const unknown = totalDice(s) - mine.length;
  const expected = (f: number) => mine.filter((d) => counts(d, f, wild)).length + unknown * (wild && f !== 1 ? 1 / 3 : 1 / 6);
  const cur = s.bids.at(-1);
  if (cur) {
    const e = expected(cur.face);
    if (s.options.spotOn && Math.abs(cur.quantity - e) < 0.3 && rng.next() < 0.3) return { type: "exact" };
    if (cur.quantity > e + 0.5 + rng.next()) return { type: "challenge" };
  }
  let best: { quantity: number; face: number; score: number } | null = null;
  minBids(s).forEach((q, i) => {
    if (q === null) return;
    const f = i + 1;
    // 最初の宣言は、自分の目から見て無理のない数まで上げてよい
    const quantity = cur ? q : Math.max(q, Math.floor(expected(f) - rng.next()));
    const score = expected(f) - quantity + rng.next() * 0.8;
    if (!best || score > best.score) best = { quantity, face: f, score };
  });
  const pick = best as { quantity: number; face: number; score: number } | null;
  if (!pick || (cur && pick.score < -1)) return { type: "challenge" };
  return { type: "bid", quantity: pick.quantity, face: pick.face };
}

// ---- 本体 ----

export const liarsdice: GameDefinition<LiarsDiceState, LiarsDiceAction, LiarsDiceOptions> = {
  id: "liarsdice",
  rulesVersion: 1,
  viewVersion: 1,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  actionSchema,
  viewSchema,
  optionsSchema,
  docs,

  init(players, seed, options) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS || new Set(players).size !== players.length) {
      throw new GameError("BAD_REQUEST", `liarsdice requires ${MIN_PLAYERS}-${MAX_PLAYERS} distinct players`);
    }
    const rng = createRng(seed);
    const s: LiarsDiceState = {
      players: [...players],
      alive: [...players],
      out: {},
      outRank: {},
      dice: Object.fromEntries(players.map((p) => [p, Array<number>(options.startDice).fill(1)])),
      round: 0,
      bids: [],
      turnPlayer: null,
      lastRound: null,
      options: { ...options },
    };
    // 最初の手番は席順で決まると先手が固定になるので、シードから選ぶ
    return newRound(s, players[rng.int(players.length)]!, rng);
  },

  currentPlayers(s) {
    return s.turnPlayer === null ? [] : [s.turnPlayer];
  },

  apply(s, pid, a, rng) {
    if (isOver(s)) throw new GameError("ILLEGAL_ACTION", "game is over");
    if (s.turnPlayer !== pid) {
      throw new GameError("NOT_YOUR_TURN", s.alive.includes(pid) ? "not your turn" : "you are out of the game");
    }
    if (a.type === "bid") {
      const min = minQuantity(s, a.face);
      if (min === null) {
        const why =
          s.bids.length === 0 && s.options.wildOnes && a.face === 1
            ? "ones are wild and cannot be bid at the start of a round"
            : `no bid on ${a.face} can beat the current bid with ${totalDice(s)} dice in play`;
        throw new GameError("ILLEGAL_ACTION", why);
      }
      if (a.quantity < min) throw new GameError("ILLEGAL_ACTION", `a bid on ${a.face} must have quantity >= ${min} now`);
      if (a.quantity > totalDice(s)) {
        throw new GameError("ILLEGAL_ACTION", `quantity cannot exceed the ${totalDice(s)} dice in play`);
      }
      return { ...s, bids: [...s.bids, { player: pid, quantity: a.quantity, face: a.face }], turnPlayer: nextAlive(s, pid) };
    }

    const bid = s.bids.at(-1);
    if (!bid) throw new GameError("ILLEGAL_ACTION", `there is no bid to ${a.type === "exact" ? "call exact on" : "challenge"} yet; make a bid`);
    if (a.type === "exact" && !s.options.spotOn) throw new GameError("ILLEGAL_ACTION", "the exact call is off in this game (spotOn option)");
    const count = countFace(s, bid.face);
    let loser: string | null;
    let gainer: string | null = null;
    if (a.type === "challenge") loser = count >= bid.quantity ? pid : bid.player;
    else if (count === bid.quantity) [loser, gainer] = [null, pid];
    else loser = pid;
    const reveal: Reveal = {
      round: s.round,
      dice: Object.fromEntries(s.alive.map((p) => [p, s.dice[p]!])),
      bids: s.bids,
      call: a.type,
      caller: pid,
      count,
      loser,
      gainer,
    };
    let next: LiarsDiceState = { ...s, lastRound: reveal };
    next = loser !== null ? changeDice(next, loser, -1) : changeDice(next, gainer!, +1);
    // 次のラウンドはダイスを失った人（抜けたらその次の人）、exact が当たったら当てた人から
    return newRound(next, loser ?? gainer!, rng);
  },

  view(s, pid) {
    const me = pid !== null && s.players.includes(pid) ? pid : null;
    return {
      startDice: s.options.startDice,
      wildOnes: s.options.wildOnes,
      spotOn: s.options.spotOn,
      round: s.round,
      players: s.players,
      alive: s.alive,
      out: s.out,
      diceCounts: Object.fromEntries(s.players.map((p) => [p, s.dice[p]!.length])),
      totalDice: totalDice(s),
      bids: s.bids,
      currentBid: s.bids.at(-1) ?? null,
      minBids: minBids(s),
      lastRound: s.lastRound,
      ...(me ? { myDice: s.dice[me] } : {}),
    };
  },

  result(s) {
    if (!isOver(s)) return null;
    const n = s.players.length;
    return {
      winners: [...s.alive],
      scores: Object.fromEntries(s.players.map((p) => [p, s.alive.includes(p) ? n - 1 : s.outRank[p]!])),
    };
  },

  onTimeout(s, pids, rng) {
    const gone = pids.filter((p) => s.alive.includes(p));
    return gone.length ? leave(s, gone, "timedOut", rng) : s;
  },

  onResign(s, pid, rng) {
    if (!s.alive.includes(pid)) throw new GameError("ILLEGAL_ACTION", "you are already out of the game");
    return leave(s, [pid], "resigned", rng);
  },

  practiceAction(s, pid, rng) {
    return practice(s, pid, rng);
  },
};
