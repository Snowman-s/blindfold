import { GameError, type GameDefinition } from "../types";
import { createRng, type Rng } from "../../lib/rng";
import { cards } from "./cards";
import { cardSchema, RESOURCES, type Card, type EachEffect, type Effect, type Resource } from "./catalog";
import { DISCARD_B, FIELD_LIMIT, MAX_PLAYERS, MIN_PLAYERS, PACK_SIZE, ROUND_B, ROUNDS, START } from "./constants";
import { catalogDocs, docs } from "./docs";
import { actionSchema, viewSchema, type DraftCardsAction } from "./schemas";

/**
 * draftcards（名前の無いカードのドラフト。2〜4 人、同時手番）。ルールの説明（英語）は docs.ts、カードは cards.ts。
 * ドラフト（PACK_SIZE - 1 回のピック）→ ROUNDS ラウンドのプレイ。どのピック・ラウンドも全員の同時手番で、
 * 最後の 1 人が送った apply（または抜けた人を除くと全員が送り終えた onTimeout / onResign）で解決する。
 * 解決の順番は scripts/draftcards-sim.ts と同じ（バランスの数字はそれで測った）。
 * 乱数は init（パックを配る）と、ドラフト中に抜けた席の自動ピックだけで引く。
 */

type Res = Record<Resource, number>;
type OutReason = "resigned" | "timedOut";
interface FieldCard {
  card: number;
  /** あと何回 each が効くか。 */
  times: number;
}
interface Change {
  player: string;
  res: Resource;
  delta: number;
}
interface EffectResult {
  index: number;
  canceled: string[];
  changes: Change[];
}
/** lastRound の 1 手。discard の card は本当の札（view で本人以外には null にする）。 */
type Step =
  | { kind: "discard"; round: number; player: string; card: number; changes: Change[] }
  | {
      kind: "play";
      round: number;
      player: string;
      card: number;
      chosen: string | null;
      target: number | null;
      paid: boolean;
      effects: EffectResult[];
      placed: boolean;
      changes: Change[];
    }
  | { kind: "each"; round: number; player: string; card: number; times: number; effects: EffectResult[] }
  | { kind: "everyone"; round: number; changes: Change[] }
  | { kind: "leave"; round: number; player: string; card: number; why: "expired" | "removed" | "full" };
/** 送られたが、まだ解決していない行動（隠し情報。view には出さない）。 */
type Pending = { type: "play"; card: number; chosen: string | null; target: number | null } | { type: "discard"; card: number };

export interface DraftCardsState {
  players: string[];
  out: Record<string, OutReason>;
  phase: "pick" | "play" | "over";
  /** ドラフト中のピックの番号（1 から）。 */
  pick: number;
  /** プレイ中のラウンド（1 から）。ドラフト中は 0、終わったら最後のラウンドのまま。 */
  round: number;
  /** 席ごとの、今その席にあるパック。 */
  packs: number[][];
  hands: Record<string, number[]>;
  /** このピックで選んだ札（隠し情報）。 */
  picks: Record<string, number>;
  /** このラウンドに送った行動（隠し情報）。 */
  acts: Record<string, Pending>;
  resources: Record<string, Res>;
  /** 場の札（古い順）。 */
  fields: Record<string, FieldCard[]>;
  lastRound: { round: number; steps: Step[] } | null;
}

const CARDS = new Map(cards.map((c) => [c.id, c]));
function card(id: number): Card {
  const c = CARDS.get(id);
  if (!c) throw new Error(`unknown card #${id}`);
  return c;
}

// ---- 補助 ----

const clone = (s: DraftCardsState): DraftCardsState => JSON.parse(JSON.stringify(s)) as DraftCardsState;
const remaining = (s: DraftCardsState): string[] => s.players.filter((p) => s.out[p] === undefined);
const score = (r: Res): number => Math.min(r.A, r.B, r.C);
const total = (r: Res): number => r.A + r.B + r.C;
const canPay = (r: Res, c: Card): boolean => RESOURCES.every((k) => (c.cost[k] ?? 0) <= r[k]);
const isM1 = (c: Card): boolean => [...c.now, ...(c.stay?.each ?? [])].some((e) => e.op === "add" && e.per === "field");

/** 残っている人のうち、席順で p のすぐ前とすぐ後の人（2 人なら 1 人、1 人なら空）。 */
function neighborsOf(s: DraftCardsState, p: string): string[] {
  const rem = remaining(s);
  const i = rem.indexOf(p);
  if (i < 0 || rem.length < 2) return [];
  const prev = rem[(i - 1 + rem.length) % rem.length]!;
  const next = rem[(i + 1) % rem.length]!;
  return prev === next ? [prev] : [prev, next];
}

/** 効果の向き先（持ち主から見て。残っている人だけ）。 */
function targets(s: DraftCardsState, owner: string, who: string, chosen: string | null): string[] {
  const rem = remaining(s);
  switch (who) {
    case "self":
      return [owner];
    case "chosen":
      return chosen !== null && rem.includes(chosen) ? [chosen] : [];
    case "neighbors":
      return neighborsOf(s, owner);
    case "others":
      return rem.filter((p) => p !== owner);
    case "all":
      return rem;
    default:
      throw new Error(`unknown who: ${who}`);
  }
}

/** リソースを delta だけ変える（0 で止まる）。実際に変わった分を changes に足す。 */
function bump(s: DraftCardsState, p: string, k: Resource, delta: number, changes: Change[]) {
  const r = s.resources[p]!;
  const after = Math.max(0, r[k] + delta);
  if (after !== r[k]) changes.push({ player: p, res: k, delta: after - r[k] });
  r[k] = after;
}

/** add / sub を 1 つ適用する。per: field は持ち主の場の今の枚数を掛け、least は一番少ないもの（同点はすべて）に足す。 */
function applyAddSub(
  s: DraftCardsState,
  owner: string,
  e: Extract<Effect, { op: "add" | "sub" }> | EachEffect,
  index: number,
  chosen: string | null,
  canceled: ReadonlySet<string> | null,
): EffectResult {
  const out: EffectResult = { index, canceled: [], changes: [] };
  const n = e.op === "add" && e.per === "field" ? e.n * s.fields[owner]!.length : e.n;
  for (const t of targets(s, owner, e.who, chosen)) {
    if (canceled && t !== owner && canceled.has(t)) {
      out.canceled.push(t);
      continue;
    }
    if (n === 0) continue;
    const r = s.resources[t]!;
    const keys: readonly Resource[] = e.res === "least" ? RESOURCES.filter((k) => r[k] === score(r)) : [e.res];
    for (const k of keys) bump(s, t, k, e.op === "add" ? n : -n, out.changes);
  }
  return out;
}

/** 場の札を持っている人（残っている人だけ）。 */
function fieldOwner(s: DraftCardsState, id: number): string | null {
  return remaining(s).find((p) => s.fields[p]!.some((f) => f.card === id)) ?? null;
}

// ---- 解決 ----

/** 出した札を 1 枚解決する。play の手と、それが起こした leave の手を steps に足す。 */
function resolvePlay(s: DraftCardsState, owner: string, a: Extract<Pending, { type: "play" }>, canceled: Set<string>, steps: Step[]) {
  const c = card(a.card);
  const step: Extract<Step, { kind: "play" }> = {
    kind: "play",
    round: s.round,
    player: owner,
    card: c.id,
    chosen: a.chosen,
    target: a.target,
    paid: false,
    effects: [],
    placed: false,
    changes: [],
  };
  const leaves: Step[] = [];
  if (canPay(s.resources[owner]!, c)) {
    step.paid = true;
    for (const k of RESOURCES) if (c.cost[k]) bump(s, owner, k, -c.cost[k], step.changes);
    c.now.forEach((e, index) => {
      if (e.op === "add" || e.op === "sub") {
        step.effects.push(applyAddSub(s, owner, e, index, a.chosen, canceled));
      } else if (e.op === "move") {
        const r: EffectResult = { index, canceled: [], changes: [] };
        const t = a.chosen;
        if (t !== null && remaining(s).includes(t)) {
          if (t !== owner && canceled.has(t)) r.canceled.push(t);
          else {
            const amount = Math.min(e.n, s.resources[t]![e.res]);
            if (amount > 0) {
              bump(s, t, e.res, -amount, r.changes);
              bump(s, owner, e.res, amount, r.changes);
            }
          }
        }
        step.effects.push(r);
      } else if (e.op === "remove") {
        const r: EffectResult = { index, canceled: [], changes: [] };
        const holder = a.target === null ? null : fieldOwner(s, a.target);
        if (holder !== null && a.target !== null) {
          if (holder !== owner && canceled.has(holder)) r.canceled.push(holder);
          else {
            s.fields[holder] = s.fields[holder]!.filter((f) => f.card !== a.target);
            leaves.push({ kind: "leave", round: s.round, player: holder, card: a.target, why: "removed" });
          }
        }
        step.effects.push(r);
      } else {
        canceled.add(owner);
        step.effects.push({ index, canceled: [], changes: [] });
      }
    });
    if (c.stay) {
      const f = s.fields[owner]!;
      f.push({ card: c.id, times: c.stay.times });
      step.placed = true;
      if (f.length > FIELD_LIMIT) {
        const gone = f.shift()!;
        leaves.push({ kind: "leave", round: s.round, player: owner, card: gone.card, why: "full" });
      }
    }
  }
  steps.push(step, ...leaves);
}

/** ラウンドの初め: 場の札の each（order 順）→ times が尽きた札が去る → 残っている全員の B が増える。 */
function startRound(s: DraftCardsState, steps: Step[] | null) {
  const rem = remaining(s);
  const list = rem.flatMap((owner) => s.fields[owner]!.map((f) => ({ owner, f })));
  list.sort((x, y) => card(x.f.card).order - card(y.f.card).order);
  for (const { owner, f } of list) {
    const c = card(f.card);
    const effects = (c.stay?.each ?? []).map((e, index) => applyAddSub(s, owner, e, index, null, null));
    f.times--;
    steps?.push({ kind: "each", round: s.round, player: owner, card: f.card, times: f.times, effects });
  }
  for (const p of rem) {
    for (const f of s.fields[p]!) if (f.times <= 0) steps?.push({ kind: "leave", round: s.round, player: p, card: f.card, why: "expired" });
    s.fields[p] = s.fields[p]!.filter((f) => f.times > 0);
  }
  const changes: Change[] = [];
  for (const p of rem) bump(s, p, "B", ROUND_B, changes);
  steps?.push({ kind: "everyone", round: s.round, changes });
}

/** 全員が行動したラウンドを解決し、次のラウンドの初めまで進める（最後のラウンドなら終わる）。 */
function resolveRound(s: DraftCardsState) {
  const steps: Step[] = [];
  const round = s.round;
  const acting = remaining(s).filter((p) => s.acts[p] !== undefined);
  for (const p of acting) s.hands[p] = s.hands[p]!.filter((id) => id !== s.acts[p]!.card);
  for (const p of acting) {
    const a = s.acts[p]!;
    if (a.type !== "discard") continue;
    const changes: Change[] = [];
    bump(s, p, "B", DISCARD_B, changes);
    steps.push({ kind: "discard", round, player: p, card: a.card, changes });
  }
  const plays = acting
    .flatMap((p) => {
      const a = s.acts[p]!;
      return a.type === "play" ? [{ p, a }] : [];
    })
    .sort((x, y) => card(x.a.card).order - card(y.a.card).order);
  const canceled = new Set<string>();
  for (const { p, a } of plays) resolvePlay(s, p, a, canceled, steps);
  s.acts = {};
  if (round >= ROUNDS) s.phase = "over";
  else {
    s.round = round + 1;
    startRound(s, steps);
  }
  s.lastRound = { round, steps };
}

/** 全員がピックしたら、抜けた席の分を自動で取り、パックを次の席へ回す。残り 1 枚になったら自動で取ってプレイへ。 */
function resolvePick(s: DraftCardsState, rng: Rng) {
  const n = s.players.length;
  s.players.forEach((p, i) => {
    const pack = s.packs[i]!;
    const id = s.out[p] === undefined ? s.picks[p]! : pack[rng.int(pack.length)]!; // 抜けた席は席順に乱数を引く
    s.hands[p]!.push(id);
    s.packs[i] = pack.filter((x) => x !== id);
  });
  s.picks = {};
  const packs = s.packs;
  s.packs = packs.map((_, i) => packs[(i - 1 + n) % n]!);
  s.pick++;
  if (s.packs[0]!.length === 1) {
    s.players.forEach((p, i) => s.hands[p]!.push(...s.packs[i]!));
    s.packs = s.packs.map(() => []);
    s.phase = "play";
    s.round = 1;
    startRound(s, null); // ラウンド 1 は場が空なので、B が増えるだけ（lastRound には載せない）
  }
}

/** 残っている全員が送り終えていれば解決する。残りが 1 人以下なら終わる。 */
function settle(s: DraftCardsState, rng: Rng) {
  const rem = remaining(s);
  if (rem.length <= 1) {
    s.phase = "over";
    s.picks = {};
    s.acts = {};
    return;
  }
  if (s.phase === "pick" && rem.every((p) => s.picks[p] !== undefined)) resolvePick(s, rng);
  else if (s.phase === "play" && rem.every((p) => s.acts[p] !== undefined)) resolveRound(s);
}

/** 抜けさせる。場の札は効果なしで去り、送った行動は無視され、リソースはそのまま止まる。 */
function drop(s: DraftCardsState, pids: string[], why: OutReason) {
  for (const p of pids) {
    if (s.out[p] !== undefined) continue;
    s.out[p] = why;
    s.fields[p] = [];
    delete s.picks[p];
    delete s.acts[p];
  }
}

// ---- 合法手 ----

function legal(s: DraftCardsState, pid: string): DraftCardsAction[] {
  if (!current(s).includes(pid)) return [];
  if (s.phase === "pick") {
    const pack = s.packs[s.players.indexOf(pid)]!;
    return [...pack].sort((a, b) => a - b).map((id) => ({ type: "pick", card: id }));
  }
  const nbs = neighborsOf(s, pid);
  const out: DraftCardsAction[] = [];
  for (const id of [...s.hands[pid]!].sort((a, b) => a - b)) {
    const c = card(id);
    if (c.chooses === "none") out.push({ type: "play", card: id });
    else if (c.chooses === "player") for (const q of nbs) out.push({ type: "play", card: id, chosen: q });
    else for (const q of nbs) for (const f of s.fields[q]!) out.push({ type: "play", card: id, target: f.card });
    out.push({ type: "discard", card: id });
  }
  return out;
}

function current(s: DraftCardsState): string[] {
  if (s.phase === "pick") return remaining(s).filter((p) => s.picks[p] === undefined);
  if (s.phase === "play") return remaining(s).filter((p) => s.acts[p] === undefined);
  return [];
}

// ---- 練習相手 ----
// 無料枠の CPU 時間に収まるよう、局面を複製して解決し直すことはしない（自分のリソースだけの見積もり）。

const value = (r: Res): number => score(r) + 0.2 * total(r);

/** 自分のリソースに効く分だけを足す（per: field は fieldCount、least は一番少ないものへ）。 */
function addSelf(r: Res, e: Effect | EachEffect, fieldCount: number, times = 1) {
  if ((e.op !== "add" && e.op !== "sub") || e.who === "chosen") return;
  if (e.who !== "self" && e.who !== "all") return;
  const n = (e.op === "add" ? 1 : -1) * e.n * (e.op === "add" && e.per === "field" ? fieldCount : 1);
  for (let t = 0; t < times; t++) {
    const keys: readonly Resource[] = e.res === "least" ? [RESOURCES.reduce((m, k) => (r[k] < r[m] ? k : m))] : [e.res];
    for (const k of keys) r[k] = Math.max(0, r[k] + n);
  }
}

/** 隣・ほかの人から減らす量（大まかな妨害の価値）。 */
function harm(c: Card, roundsLeft: number): number {
  const now = c.now.reduce((t, e) => t + (e.op === "move" ? e.n : e.op === "sub" && e.who !== "self" ? e.n * 0.5 : e.op === "remove" ? 1.5 : 0), 0);
  const each = (c.stay?.each ?? []).reduce((t, e) => t + (e.op === "sub" ? e.n * 0.5 : 0), 0);
  return now + each * Math.min(c.stay?.times ?? 0, roundsLeft);
}

/** その手を打ったあとの、自分のリソースの見積もり（今の場と残りラウンドの each、残りラウンドの B を含む）。 */
function estimate(s: DraftCardsState, pid: string, a: DraftCardsAction): number {
  const r = { ...s.resources[pid]! };
  const field = s.fields[pid]!.map((f) => ({ c: card(f.card), times: f.times }));
  const roundsLeft = ROUNDS - s.round;
  let extra = 0;
  if (a.type === "discard") r.B += DISCARD_B;
  else if (a.type === "play") {
    const c = card(a.card);
    if (!canPay(r, c)) return -Infinity;
    for (const k of RESOURCES) r[k] -= c.cost[k] ?? 0;
    for (const e of c.now) {
      if (e.op === "move") {
        const from = a.chosen === undefined ? 0 : s.resources[a.chosen]![e.res];
        r[e.res] += Math.min(e.n, from);
      } else addSelf(r, e, field.length);
    }
    if (c.stay) field.push({ c, times: c.stay.times });
    while (field.length > FIELD_LIMIT) field.shift();
    extra = 0.3 * harm(c, roundsLeft);
    if (a.chosen !== undefined) extra += 0.01 * score(s.resources[a.chosen]!); // 先を行く隣を選ぶ
    if (a.target !== undefined) {
      const holder = fieldOwner(s, a.target);
      extra += 0.1 * (s.fields[holder ?? ""]?.find((f) => f.card === a.target)?.times ?? 0);
    }
  }
  for (const f of field) for (const e of f.c.stay?.each ?? []) addSelf(r, e, field.length, Math.min(f.times, roundsLeft));
  r.B += roundsLeft * ROUND_B;
  return value(r) + extra;
}

/** ピックの見積もり: 自分が得る量 − 費用（B は余りやすいので軽く）。場を組める手札なら場に残る札と M1 を少し高く。 */
function pickValue(s: DraftCardsState, pid: string, id: number): number {
  const c = card(id);
  const r: Res = { A: 0, B: 0, C: 0 };
  for (const e of c.now) addSelf(r, e, 1);
  for (const e of c.stay?.each ?? []) addSelf(r, e, 2, Math.round(Math.min(c.stay?.times ?? 0, ROUNDS - 1) * 0.8));
  const gain = r.A + 0.7 * r.B + 1.2 * r.C + c.now.reduce((t, e) => t + (e.op === "move" ? e.n * 1.5 : 0), 0);
  const cost = (c.cost.A ?? 0) + 0.6 * (c.cost.B ?? 0) + 1.2 * (c.cost.C ?? 0);
  const stays = s.hands[pid]!.filter((x) => card(x).stay).length;
  const plan = stays >= 2 && (c.stay !== null || isM1(c)) ? 0.8 : 0;
  return gain - cost + 0.3 * harm(c, ROUNDS - 1) + plan;
}

/** 場を組める手札か: ラウンドが上限の数まで、場と手札の場に残る札で上限に届き、手札に M1 の札がある。 */
function wantsField(s: DraftCardsState, pid: string): boolean {
  const hand = s.hands[pid]!.map(card);
  return s.round <= FIELD_LIMIT && s.fields[pid]!.length + hand.filter((c) => c.stay).length >= FIELD_LIMIT && hand.some(isM1);
}

function bestOf<T>(xs: T[], score: (x: T) => number, rng: Rng): T {
  let top: T[] = [];
  let bv = -Infinity;
  for (const x of xs) {
    const v = score(x);
    if (v > bv + 1e-9) {
      bv = v;
      top = [x];
    } else if (Math.abs(v - bv) <= 1e-9) top.push(x);
  }
  return top[rng.int(top.length)] ?? xs[0]!;
}

function practice(s: DraftCardsState, pid: string, rng: Rng): DraftCardsAction {
  const moves = legal(s, pid);
  if (s.phase === "pick") return bestOf(moves, (a) => pickValue(s, pid, a.card) + rng.next() * 0.3, rng);
  if (wantsField(s, pid)) {
    // 場を組む方針: 今払える場に残る札のうち、いちばん長く残るもの
    const r = s.resources[pid]!;
    const stays = moves.filter((a) => a.type === "play" && card(a.card).stay !== null && canPay(r, card(a.card)));
    if (stays.length > 0) {
      const longest = Math.max(...stays.map((a) => card(a.card).stay!.times));
      return bestOf(
        stays.filter((a) => card(a.card).stay!.times === longest),
        (a) => estimate(s, pid, a),
        rng,
      );
    }
  }
  return bestOf(moves, (a) => estimate(s, pid, a), rng);
}

// ---- 本体 ----

export const draftcards: GameDefinition<DraftCardsState, DraftCardsAction> = {
  id: "draftcards",
  rulesVersion: 1,
  viewVersion: 1,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  actionSchema,
  viewSchema,
  docs,
  catalog: { schema: cardSchema, items: cards, docs: catalogDocs },

  init(players, seed) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS || new Set(players).size !== players.length) {
      throw new GameError("BAD_REQUEST", `draftcards requires ${MIN_PLAYERS}-${MAX_PLAYERS} distinct players`);
    }
    const rng = createRng(seed);
    const deck = cards.map((c) => c.id);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    const each = <T>(f: () => T) => Object.fromEntries(players.map((p) => [p, f()]));
    return {
      players: [...players],
      out: {},
      phase: "pick",
      pick: 1,
      round: 0,
      packs: players.map((_, i) => deck.slice(i * PACK_SIZE, (i + 1) * PACK_SIZE)),
      hands: each(() => []),
      picks: {},
      acts: {},
      resources: each(() => ({ ...START })),
      fields: each(() => []),
      lastRound: null,
    };
  },

  currentPlayers: current,

  legalActions: legal,

  apply(s0, pid, a, rng) {
    if (s0.phase === "over") throw new GameError("ILLEGAL_ACTION", "the game is over");
    if (!s0.players.includes(pid) || s0.out[pid] !== undefined) throw new GameError("NOT_YOUR_TURN", "you are not in the game");
    const s = clone(s0);
    if (s.phase === "pick") {
      if (a.type !== "pick") throw new GameError("ILLEGAL_ACTION", 'the draft is on: send { "type": "pick", "card": <a card in pack> }');
      if (s.picks[pid] !== undefined) throw new GameError("NOT_YOUR_TURN", "you have already picked this time");
      if (!s.packs[s.players.indexOf(pid)]!.includes(a.card)) throw new GameError("ILLEGAL_ACTION", `card #${a.card} is not in your pack`);
      s.picks[pid] = a.card;
    } else {
      if (a.type === "pick") throw new GameError("ILLEGAL_ACTION", "the draft is over: play or discard a card");
      if (s.acts[pid] !== undefined) throw new GameError("NOT_YOUR_TURN", "you have already acted this round");
      if (!s.hands[pid]!.includes(a.card)) throw new GameError("ILLEGAL_ACTION", `card #${a.card} is not in your hand`);
      if (a.type === "discard") s.acts[pid] = { type: "discard", card: a.card };
      else {
        const c = card(a.card);
        const nbs = neighborsOf(s, pid);
        if (c.chooses === "player") {
          if (a.chosen === undefined || !nbs.includes(a.chosen)) {
            throw new GameError("ILLEGAL_ACTION", `card #${c.id} needs "chosen": one of your neighbors (${nbs.join(", ")})`);
          }
        } else if (a.chosen !== undefined) throw new GameError("ILLEGAL_ACTION", `card #${c.id} does not choose a player`);
        if (c.chooses === "card") {
          const inReach = nbs.flatMap((q) => s.fields[q]!.map((f) => f.card));
          if (inReach.length === 0) throw new GameError("ILLEGAL_ACTION", `card #${c.id} needs a card in a neighbor's field, and there is none`);
          if (a.target === undefined || !inReach.includes(a.target)) {
            throw new GameError("ILLEGAL_ACTION", `card #${c.id} needs "target": a card in a neighbor's field (${inReach.join(", ")})`);
          }
        } else if (a.target !== undefined) throw new GameError("ILLEGAL_ACTION", `card #${c.id} does not target a card`);
        s.acts[pid] = { type: "play", card: a.card, chosen: a.chosen ?? null, target: a.target ?? null };
      }
    }
    settle(s, rng);
    return s;
  },

  view(s, pid) {
    const rem = remaining(s);
    const v: Record<string, unknown> = {
      phase: s.phase,
      pick: s.phase === "pick" ? s.pick : null,
      round: s.round,
      players: [...s.players],
      out: { ...s.out },
      neighbors: Object.fromEntries(rem.flatMap((p) => (neighborsOf(s, p).length > 0 ? [[p, neighborsOf(s, p)]] : []))),
      resources: Object.fromEntries(s.players.map((p) => [p, { ...s.resources[p]! }])),
      handCounts: Object.fromEntries(s.players.map((p) => [p, s.hands[p]!.length])),
      fields: Object.fromEntries(s.players.map((p) => [p, s.fields[p]!.map((f) => ({ ...f }))])),
      lastRound: s.lastRound && {
        round: s.lastRound.round,
        steps: s.lastRound.steps.map((st) => (st.kind === "discard" && st.player !== pid ? { ...st, card: null } : st)),
      },
    };
    if (pid !== null && s.players.includes(pid)) {
      v.pack = s.phase === "pick" ? [...s.packs[s.players.indexOf(pid)]!].sort((a, b) => a - b) : [];
      v.hand = [...s.hands[pid]!].sort((a, b) => a - b);
    }
    return JSON.parse(JSON.stringify(v)) as unknown;
  },

  result(s) {
    if (s.phase !== "over") return null;
    const scores = Object.fromEntries(s.players.map((p) => [p, score(s.resources[p]!)]));
    const rem = remaining(s);
    if (rem.length <= 1) return { winners: rem, scores };
    const best = Math.max(...rem.map((p) => score(s.resources[p]!)));
    const top = rem.filter((p) => score(s.resources[p]!) === best);
    const bestTotal = Math.max(...top.map((p) => total(s.resources[p]!)));
    return { winners: top.filter((p) => total(s.resources[p]!) === bestTotal), scores };
  },

  onTimeout(s0, pids, rng) {
    const s = clone(s0);
    drop(s, pids, "timedOut");
    settle(s, rng);
    return s;
  },

  onResign(s0, pid, rng) {
    if (s0.phase === "over") throw new GameError("ILLEGAL_ACTION", "the game is over");
    if (!s0.players.includes(pid) || s0.out[pid] !== undefined) throw new GameError("ILLEGAL_ACTION", "you have already left the game");
    const s = clone(s0);
    drop(s, [pid], "resigned");
    settle(s, rng);
    return s;
  },

  practiceAction: practice,
};

/** テスト用。 */
export const internals = { neighborsOf };
