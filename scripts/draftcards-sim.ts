// draftcards のバランス用シミュレーター（bot どうしを速く大量に回す。解決の順番は src/games/draftcards/index.ts と同じにすること）。
// 使い方: pnpm tsx scripts/draftcards-sim.ts [試合数=2000] [seed=sim] [人数=2,3,4] [--json] [--draft-bot[=alone|rating|all]] [--play=field] [--flat-field=X]
//
// - bot: 他の人の手を 1 手読みの bot で予想し、それと同時に解決したときの見込みが最大の手を選ぶ
// - ドラフトは既定でランダム（カードの有無を腕前と独立にするため。カードごとの勝率はこのときだけ意味がある）
// - --draft-bot: 1 席（試合ごとに回す）だけドラフト bot にする。候補ごとに「今の手札＋その札」で自分 1 人のプレイを
//   最後まで流し、終わったときの評価が最大の札を取る。その席の勝率が 1/人数をどれだけ上回るかが「ドラフトの腕の差」
// - --draft-bot=alone: 手札を見ずに、候補 1 枚だけで同じ評価をして取る（1 枚だけだと場に残る札を高く見すぎるので、基準には向かない）
// - --play=field: 場を組める手札（ラウンド 1〜上限、場と手札の場に残る札で上限に届き、手札に M1 の札がある）の人は、
//   今払える場に残る札のうち一番長く残るものを出す（1 手読みの bot は場を続けて組む計画を立てないので、その代わり）
// - --draft-bot=all: 全席を（手札を見る）ドラフト bot にする。組んだデッキどうしでの札の強さと、場がどこまで育つかを見る
// - --draft-bot=rating --ratings=<file>: カードごとの評価が最大の札を取る。評価は <file>（ランダムなドラフトで回した --json の出力）の、
//   その人数での heldWin。手札を見るドラフト bot との差が「手札の組み立て」の分
// - --flat-field=X: per: "field" を、場の枚数の代わりに定数 X を掛けるものとして扱う。M1 の組み合わせの効果を消す比較のつもりだったが、
//   プレイの bot が M1 の札を出す時期が変わって比較が崩れ、X が小数だとリソースが小数になって min と同点の起き方まで変わった。
//   使うなら整数で、結果は割り引いて読む
// - 1 手読みなので、cancel・remove・order のタイミングは低く見積もられる。これらの札の数字だけで強弱を決めない
import { readFileSync } from "node:fs";
import { cards } from "../src/games/draftcards/cards";
import type { Card, EachEffect, Effect } from "../src/games/draftcards/catalog";
import { DISCARD_B, FIELD_LIMIT, PACK_SIZE, ROUND_B, ROUNDS, START } from "../src/games/draftcards/constants";
import { createRng, type Rng } from "../src/lib/rng";

type R = "A" | "B" | "C";
type Res = Record<R, number>;
interface FieldCard {
  card: Card;
  times: number;
}
interface Player {
  res: Res;
  hand: Card[];
  field: FieldCard[];
}
interface Game {
  n: number;
  ps: Player[];
  round: number;
}
type Play = { type: "play"; card: Card; chosen?: number; target?: { owner: number; id: number } };
type Act = Play | { type: "discard"; card: Card };

const RS: readonly R[] = ["A", "B", "C"];
const at = <T>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${i} out of range`);
  return x;
};
const cloneGame = (g: Game): Game => ({
  n: g.n,
  round: g.round,
  ps: g.ps.map((p) => ({ res: { ...p.res }, hand: [...p.hand], field: p.field.map((f) => ({ ...f })) })),
});
const neighbors = (n: number, i: number): number[] => (n === 2 ? [1 - i] : [(i + n - 1) % n, (i + 1) % n]);
function targets(g: Game, owner: number, who: string, chosen?: number): number[] {
  const all = g.ps.map((_, i) => i);
  switch (who) {
    case "self":
      return [owner];
    case "chosen":
      return chosen === undefined ? [] : [chosen];
    case "neighbors":
      return neighbors(g.n, owner);
    case "others":
      return all.filter((i) => i !== owner);
    case "all":
      return all;
    default:
      throw new Error(who);
  }
}
const score = (r: Res) => Math.min(r.A, r.B, r.C);
const total = (r: Res) => r.A + r.B + r.C;

export type Role = "stay" | "once" | "player" | "card" | "cancel";
export const roleOf = (c: Card): Role =>
  c.now.some((e) => e.op === "cancel") ? "cancel" : c.chooses === "card" ? "card" : c.chooses === "player" ? "player" : c.stay ? "stay" : "once";

function legal(g: Game, i: number): Act[] {
  const out: Act[] = [];
  const p = at(g.ps, i);
  for (const c of p.hand) {
    out.push({ type: "discard", card: c });
    if (c.chooses === "none") out.push({ type: "play", card: c });
    else if (c.chooses === "player") for (const t of neighbors(g.n, i)) out.push({ type: "play", card: c, chosen: t });
    else for (const t of neighbors(g.n, i)) for (const f of at(g.ps, t).field) out.push({ type: "play", card: c, target: { owner: t, id: f.card.id } });
  }
  return out;
}

interface Stats {
  unpaid: number;
  plays: number;
  discards: number;
}

type AddSub = Extract<Effect, { op: "add" | "sub" }> | EachEffect;
/** --flat-field のとき、場の枚数の代わりに掛ける定数。 */
let flatField: number | null = null;
/** 実際の試合で per: field が効いたときの場の枚数（平均を出すため）。評価用の仮の解決では数えない。 */
const fieldAtM1 = { n: 0, sum: 0 };
/** 同じく、now と each に分けた場の枚数ごとの回数（0〜FIELD_LIMIT）と、上限で押し出された回数。 */
const fieldHist = { now: [0, 0, 0, 0], each: [0, 0, 0, 0] };
let pushedOut = 0;
/** applyTo が now（解決時）と each（ラウンドの初め）のどちらから呼ばれたか。 */
let phase: "now" | "each" = "now";
let recording = false;
/** add / sub を 1 人のリソースに適用する。per: field は持ち主の場の枚数を掛け、res: least は一番少ないもの（同点はすべて）に足す。 */
function applyTo(r: Res, e: AddSub, ownerField: number) {
  const perField = e.op === "add" && e.per === "field";
  if (perField && recording) {
    fieldAtM1.n++;
    fieldAtM1.sum += ownerField;
    const h = fieldHist[phase];
    h[ownerField] = at(h, ownerField) + 1;
  }
  const n = perField ? e.n * (flatField ?? ownerField) : e.n;
  if (n === 0) return;
  const keys: readonly R[] = e.res === "least" ? RS.filter((k) => r[k] === score(r)) : [e.res];
  for (const k of keys) r[k] = Math.max(0, r[k] + (e.op === "add" ? n : -n));
}

/** ラウンドの初め: 場の効果（order 順）→ 全員の B が増える。場の枚数は、去る札を除く前の数で数える。 */
function roundStart(g: Game) {
  const list: { owner: number; fc: FieldCard }[] = [];
  g.ps.forEach((p, owner) => p.field.forEach((fc) => list.push({ owner, fc })));
  list.sort((a, b) => a.fc.card.order - b.fc.card.order);
  phase = "each";
  for (const { owner, fc } of list) {
    for (const e of fc.card.stay?.each ?? []) {
      const nField = at(g.ps, owner).field.length;
      for (const t of targets(g, owner, e.who)) applyTo(at(g.ps, t).res, e, nField);
    }
    fc.times--;
  }
  phase = "now";
  for (const p of g.ps) p.field = p.field.filter((fc) => fc.times > 0);
  for (const p of g.ps) p.res.B += ROUND_B;
}

/** 全員の行動を解決する（acts[i] が null の人は何もしない。評価用）。 */
function resolve(g: Game, acts: (Act | null)[], st: Stats | null, onPaid?: (owner: number, card: Card) => void) {
  acts.forEach((a, i) => {
    if (!a) return;
    const p = at(g.ps, i);
    p.hand = p.hand.filter((c) => c !== a.card);
    if (a.type === "discard") {
      p.res.B += DISCARD_B;
      if (st) st.discards++;
    }
  });
  const plays = acts
    .map((a, i) => ({ a, i }))
    .filter((x): x is { a: Play; i: number } => x.a?.type === "play")
    .sort((x, y) => x.a.card.order - y.a.card.order);
  const canceled = new Set<number>();
  for (const { a, i: o } of plays) {
    const c = a.card;
    const r = at(g.ps, o).res;
    if (st) st.plays++;
    if (!RS.every((k) => (c.cost[k] ?? 0) <= r[k])) {
      if (st) st.unpaid++;
      continue;
    }
    for (const k of RS) r[k] -= c.cost[k] ?? 0;
    onPaid?.(o, c);
    for (const e of c.now) {
      if (e.op === "add" || e.op === "sub") {
        const nField = at(g.ps, o).field.length; // 解決時・この札を置く前
        for (const t of targets(g, o, e.who, a.chosen)) {
          if (t !== o && canceled.has(t)) continue;
          applyTo(at(g.ps, t).res, e, nField);
        }
      } else if (e.op === "move") {
        const t = a.chosen;
        if (t === undefined || (t !== o && canceled.has(t))) continue;
        const tr = at(g.ps, t).res;
        const amt = Math.min(e.n, tr[e.res]);
        tr[e.res] -= amt;
        r[e.res] += amt;
      } else if (e.op === "remove") {
        const tg = a.target;
        if (!tg || (tg.owner !== o && canceled.has(tg.owner))) continue;
        const f = at(g.ps, tg.owner).field;
        const k = f.findIndex((x) => x.card.id === tg.id);
        if (k >= 0) f.splice(k, 1);
      } else {
        canceled.add(o);
      }
    }
    if (c.stay) {
      const f = at(g.ps, o).field;
      f.push({ card: c, times: c.stay.times });
      if (f.length > FIELD_LIMIT) {
        f.shift();
        if (recording) pushedOut++;
      }
    }
  }
}

/** 評価: 場の札の残りの効果と、残りラウンドの B の入りを（0 の床を無視して）足した見込みの資源。 */
function projected(g: Game): Res[] {
  const res = g.ps.map((p) => ({ ...p.res }));
  const least = g.ps.map(() => 0); // res: least の分は最後に、一番少ないものへ 1 ずつ配る
  const left = ROUNDS - g.round;
  g.ps.forEach((p, owner) => {
    for (const fc of p.field) {
      const k = Math.min(fc.times, left);
      for (const e of fc.card.stay?.each ?? []) {
        const n = (e.op === "add" ? 1 : -1) * e.n * k * (e.op === "add" && e.per === "field" ? (flatField ?? p.field.length) : 1);
        for (const t of targets(g, owner, e.who)) {
          if (e.res === "least") least[t] = at(least, t) + n;
          else at(res, t)[e.res] += n;
        }
      }
    }
  });
  res.forEach((r, i) => {
    for (const k of RS) r[k] = Math.max(0, r[k]) + (k === "B" ? left * ROUND_B : 0);
    for (let u = 0; u < at(least, i); u++) {
      const k = RS.reduce((m, x) => (r[x] < r[m] ? x : m));
      r[k]++;
    }
  });
  return res;
}
const value = (r: Res) => score(r) + 0.2 * total(r);
function evalAct(g: Game, i: number, a: Act, preds?: (Act | null)[]): number {
  const h = cloneGame(g);
  const acts: (Act | null)[] = preds ? [...preds] : h.ps.map(() => null);
  acts[i] = a;
  const was = recording;
  recording = false; // 仮の解決なので数えない
  resolve(h, acts, null);
  recording = was;
  const pr = projected(h);
  const others = pr.filter((_, j) => j !== i).map(value);
  return value(at(pr, i)) - (0.5 * others.reduce((s, x) => s + x, 0)) / others.length;
}
function best(g: Game, i: number, rng: Rng, preds?: (Act | null)[]): Act {
  let top: Act[] = [];
  let bv = -Infinity;
  for (const a of legal(g, i)) {
    const v = evalAct(g, i, a, preds);
    if (v > bv + 1e-9) {
      bv = v;
      top = [a];
    } else if (Math.abs(v - bv) <= 1e-9) top.push(a);
  }
  return at(top, rng.int(top.length));
}
/** --play=field のとき、場を組む方針を使う。 */
let fieldPlan = false;
/** 場を組める手札か: ラウンドが上限の数まで、場と手札の場に残る札で上限に届き、手札に M1 の札がある。 */
function wantsField(g: Game, i: number): boolean {
  const p = at(g.ps, i);
  return g.round <= FIELD_LIMIT && p.field.length + p.hand.filter((c) => c.stay).length >= FIELD_LIMIT && p.hand.some(isM1);
}
/**
 * 場を組む方針: 今払える場に残る札のうち、いちばん長く残る（times が大きい）ものを出す。同じ長さなら 1 手読みの評価で選ぶ。
 * 長いものから出すと、上限の数だけ続けて出したときに最初の札が残っている。払える札が無ければ null（いつもの bot に任せる）。
 */
function planField(g: Game, i: number, rng: Rng, preds?: (Act | null)[]): Act | null {
  const p = at(g.ps, i);
  const stays = p.hand.filter((c) => c.stay && RS.every((k) => (c.cost[k] ?? 0) <= p.res[k]));
  if (stays.length === 0) return null;
  const longest = Math.max(...stays.map((c) => c.stay?.times ?? 0));
  const cands = stays.filter((c) => c.stay?.times === longest);
  let top: Act[] = [];
  let bv = -Infinity;
  for (const c of cands) {
    const a: Act = { type: "play", card: c };
    const v = evalAct(g, i, a, preds);
    if (v > bv + 1e-9) {
      bv = v;
      top = [a];
    } else if (Math.abs(v - bv) <= 1e-9) top.push(a);
  }
  return at(top, rng.int(top.length));
}
/** 1 人の手を選ぶ。--play=field で場を組める手札なら場を組む方針、それ以外は 1 手読み。 */
function choose(g: Game, i: number, rng: Rng, preds?: (Act | null)[]): Act {
  if (fieldPlan && wantsField(g, i)) {
    const a = planField(g, i, rng, preds);
    if (a) {
      if (recording) planned.add(i);
      return a;
    }
  }
  return best(g, i, rng, preds);
}
/** この試合で場を組む方針を一度でも使った席。 */
const planned = new Set<number>();
/** 他の人の手を予想し、それと同時に解決して自分の手を選ぶ。 */
const bot = (g: Game, i: number, rng: Rng): Act => {
  const was = recording;
  recording = false; // 予想の分は数えない
  const preds = g.ps.map((_, j) => (j === i ? null : choose(g, j, rng)));
  recording = was;
  return choose(g, i, rng, preds);
};

/** 手札だけを持って自分 1 人でプレイしたときの、終わったときの評価（ドラフト bot の物差し）。 */
function soloValue(n: number, seat: number, hand: readonly Card[], rng: Rng): number {
  const g: Game = { n, round: 0, ps: Array.from({ length: n }, (_, i) => ({ res: { ...START }, hand: i === seat ? [...hand] : [], field: [] })) };
  for (let r = 1; r <= ROUNDS; r++) {
    g.round = r;
    if (r > 1) roundStart(g);
    else for (const p of g.ps) p.res.B += ROUND_B;
    const acts: (Act | null)[] = g.ps.map(() => null);
    if (at(g.ps, seat).hand.length > 0) acts[seat] = choose(g, seat, rng);
    resolve(g, acts, null);
  }
  return value(at(g.ps, seat).res);
}
/** パックから取る札の位置。「今の手札＋候補」の soloValue が最大のもの。 */
function draftPick(n: number, seat: number, hand: readonly Card[], pack: readonly Card[], rng: Rng, alone: boolean): number {
  if (ratings) {
    const r = ratings.get(n);
    if (!r) throw new Error(`no ratings for ${n} players`);
    let ri = 0;
    pack.forEach((c, k) => {
      if ((r.get(c.id) ?? 0) > (r.get(at(pack, ri).id) ?? 0)) ri = k;
    });
    return ri;
  }
  let bi = 0;
  let bv = -Infinity;
  pack.forEach((c, k) => {
    const v = soloValue(n, seat, alone ? [c] : [...hand, c], rng);
    if (v > bv) {
      bv = v;
      bi = k;
    }
  });
  return bi;
}
/** --draft-bot=rating のときの評価（人数 -> id -> heldWin）。 */
let ratings: Map<number, Map<number, number>> | null = null;
const isM1 = (c: Card) => [...c.now, ...(c.stay?.each ?? [])].some((e) => e.op === "add" && e.per === "field");

function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [at(a, j), at(a, i)];
  }
  return a;
}

export interface CardRow {
  id: number;
  role: Role;
  held: number;
  heldWin: number;
  playRate: number;
}
export interface Summary {
  n: number;
  games: number;
  seatWin: number[];
  playRate: number;
  discardRate: number;
  unpaidRate: number;
  topTieOnMin: number;
  /** 終了時に min と等しかった割合（プレイヤーごと。同点は両方に数える）。 */
  binding: Res;
  meanFinal: Res;
  meanScore: number;
  /** 実際の試合で per: field が効いたときの、持ち主の場の平均枚数。 */
  meanFieldAtM1: number;
  /** per: field が効いたときの場の枚数の分布（now / each、0〜FIELD_LIMIT 枚の割合）。 */
  fieldDist: { now: number[]; each: number[] };
  /** 場の上限で押し出された回数（1 試合あたり）。 */
  pushedOut: number;
  /** --play=field のとき、場を組む方針を使った席の割合と、その席の勝率。 */
  plan: { share: number; win: number } | null;
  /** --draft-bot のときだけ。ドラフト bot の席の勝率と、手札の中身（ドラフト bot / ほかの席の平均）。 */
  draftBot: {
    win: number;
    stays: [number, number];
    m1: [number, number];
    /** パックに M1 の札があったとき（2 枚以上のパック）に M1 の札を取った割合。手札の場に残る札が 0〜1 枚 / 2 枚以上で分ける。 */
    m1Take: [number, number];
    m1Offered: [number, number];
  } | null;
  rows: CardRow[];
}
export interface SimOptions {
  draftBot?: boolean | "alone" | "rating" | "all";
  flatField?: number;
  /** "field": 場を組める手札の人は場を組む方針でプレイする。 */
  play?: "field";
}

export function simulate(n: number, games: number, seed: string, opts: SimOptions = {}): Summary {
  const rng = createRng(`${seed}:${n}`);
  flatField = opts.flatField ?? null;
  fieldPlan = opts.play === "field";
  const plan = { seats: 0, win: 0 };
  fieldAtM1.n = 0;
  fieldAtM1.sum = 0;
  fieldHist.now = [0, 0, 0, 0];
  fieldHist.each = [0, 0, 0, 0];
  pushedOut = 0;
  const db = { win: 0, stays: [0, 0], m1: [0, 0], m1Take: [0, 0], m1Offered: [0, 0] };
  const seatWin: number[] = Array.from({ length: n }, () => 0);
  const held = new Map<number, { n: number; w: number }>();
  const played = new Map<number, number>();
  const st: Stats = { unpaid: 0, plays: 0, discards: 0 };
  const binding: Res = { A: 0, B: 0, C: 0 };
  const sumFinal: Res = { A: 0, B: 0, C: 0 };
  let sumScore = 0;
  let topTieOnMin = 0;

  for (let gi = 0; gi < games; gi++) {
    const deck = shuffle(cards, rng);
    let packs = Array.from({ length: n }, (_, i) => deck.slice(i * PACK_SIZE, (i + 1) * PACK_SIZE));
    const g: Game = { n, round: 0, ps: Array.from({ length: n }, () => ({ res: { ...START }, hand: [], field: [] })) };
    // --draft-bot=all は全席がドラフト bot（手札を見る）。勝率の比べる相手がいないので、draftBot の集計はしない
    const allBots = opts.draftBot === "all";
    const botSeat = opts.draftBot && !allBots ? gi % n : -1;
    while (at(packs, 0).length > 0) {
      packs.forEach((pk, i) => {
        const k = pk.length === 1 ? 0 : i === botSeat || allBots ? draftPick(n, i, at(g.ps, i).hand, pk, rng, opts.draftBot === "alone") : rng.int(pk.length);
        if (i === botSeat && pk.length > 1 && pk.some(isM1)) {
          const b = at(g.ps, i).hand.filter((c) => c.stay).length >= 2 ? 1 : 0;
          db.m1Offered[b] = at(db.m1Offered, b) + 1;
          if (isM1(at(pk, k))) db.m1Take[b] = at(db.m1Take, b) + 1;
        }
        at(g.ps, i).hand.push(at(pk, k));
        pk.splice(k, 1);
      });
      packs = packs.map((_, i) => at(packs, (i + n - 1) % n));
    }
    const hands = g.ps.map((p) => p.hand.map((c) => c.id));
    if (botSeat >= 0) {
      g.ps.forEach((p, i) => {
        const k = i === botSeat ? 0 : 1;
        const w = i === botSeat ? 1 : 1 / (n - 1);
        db.stays[k] = at(db.stays, k) + w * p.hand.filter((c) => c.stay).length;
        db.m1[k] = at(db.m1, k) + w * p.hand.filter(isM1).length;
      });
    }
    planned.clear();
    recording = true;
    for (let r = 1; r <= ROUNDS; r++) {
      g.round = r;
      if (r > 1) roundStart(g);
      else for (const p of g.ps) p.res.B += ROUND_B;
      const acts = g.ps.map((_, i) => bot(g, i, rng));
      resolve(g, acts, st, (_o, c) => played.set(c.id, (played.get(c.id) ?? 0) + 1));
    }
    recording = false;
    const sc = g.ps.map((p) => score(p.res));
    for (const p of g.ps) {
      sumScore += score(p.res);
      for (const k of RS) {
        sumFinal[k] += p.res[k];
        if (p.res[k] === score(p.res)) binding[k]++;
      }
    }
    const bestMin = Math.max(...sc);
    if (sc.filter((s) => s === bestMin).length > 1) topTieOnMin++;
    const bestTotal = Math.max(...g.ps.filter((p) => score(p.res) === bestMin).map((p) => total(p.res)));
    const winners = g.ps.flatMap((p, i) => (score(p.res) === bestMin && total(p.res) === bestTotal ? [i] : []));
    const credit = g.ps.map((_, i) => (winners.includes(i) ? 1 / winners.length : 0));
    credit.forEach((c, i) => (seatWin[i] = at(seatWin, i) + c));
    if (botSeat >= 0) db.win += at(credit, botSeat);
    for (const i of planned) {
      plan.seats++;
      plan.win += at(credit, i);
    }
    hands.forEach((h, i) =>
      h.forEach((id) => {
        const x = held.get(id) ?? { n: 0, w: 0 };
        x.n++;
        x.w += at(credit, i);
        held.set(id, x);
      }),
    );
  }

  const players = games * n;
  const turns = players * ROUNDS;
  return {
    n,
    games,
    seatWin: seatWin.map((w) => w / games),
    playRate: st.plays / turns,
    discardRate: st.discards / turns,
    unpaidRate: st.unpaid / Math.max(1, st.plays),
    topTieOnMin: topTieOnMin / games,
    binding: { A: binding.A / players, B: binding.B / players, C: binding.C / players },
    meanFinal: { A: sumFinal.A / players, B: sumFinal.B / players, C: sumFinal.C / players },
    meanScore: sumScore / players,
    meanFieldAtM1: fieldAtM1.sum / Math.max(1, fieldAtM1.n),
    fieldDist: {
      now: fieldHist.now.map((x) => x / Math.max(1, fieldHist.now.reduce((a, b) => a + b, 0))),
      each: fieldHist.each.map((x) => x / Math.max(1, fieldHist.each.reduce((a, b) => a + b, 0))),
    },
    pushedOut: pushedOut / games,
    plan: fieldPlan ? { share: plan.seats / players, win: plan.win / Math.max(1, plan.seats) } : null,
    draftBot: opts.draftBot && opts.draftBot !== "all"
      ? {
          win: db.win / games,
          stays: [at(db.stays, 0) / games, at(db.stays, 1) / games],
          m1: [at(db.m1, 0) / games, at(db.m1, 1) / games],
          m1Take: [at(db.m1Take, 0) / Math.max(1, at(db.m1Offered, 0)), at(db.m1Take, 1) / Math.max(1, at(db.m1Offered, 1))],
          m1Offered: [at(db.m1Offered, 0) / games, at(db.m1Offered, 1) / games],
        }
      : null,
    rows: cards.map((c) => {
      const h = held.get(c.id) ?? { n: 0, w: 0 };
      return { id: c.id, role: roleOf(c), held: h.n, heldWin: h.w / Math.max(1, h.n), playRate: (played.get(c.id) ?? 0) / Math.max(1, h.n) };
    }),
  };
}

// ---- 実行 ----
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/draftcards-sim.ts");
if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const games = Number(args[0] ?? 2000);
  const seed = args[1] ?? "sim";
  const ns = (args[2] ?? "2,3,4").split(",").map(Number);
  const flat = process.argv.find((a) => a.startsWith("--flat-field="));
  const ratingFile = process.argv.find((a) => a.startsWith("--ratings="))?.split("=")[1];
  if (ratingFile) {
    const parsed: unknown = JSON.parse(readFileSync(ratingFile, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("--ratings: not a sim --json output");
    ratings = new Map(
      parsed.map((x: { n: number; rows: { id: number; heldWin: number }[] }) => [x.n, new Map(x.rows.map((r) => [r.id, r.heldWin]))]),
    );
  }
  const opts: SimOptions = {
    draftBot: process.argv.includes("--draft-bot=alone")
      ? "alone"
      : process.argv.includes("--draft-bot=rating")
        ? "rating"
        : process.argv.includes("--draft-bot=all")
          ? "all"
          : process.argv.includes("--draft-bot"),
    ...(flat ? { flatField: Number(flat.split("=")[1]) } : {}),
    ...(process.argv.includes("--play=field") ? { play: "field" as const } : {}),
  };
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const pt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
  const results = ns.map((n) => simulate(n, games, seed, opts));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results));
  } else {
    const roles: Role[] = ["stay", "once", "player", "card", "cancel"];
    for (const s of results) {
      const base = 1 / s.n;
      console.log(`== ${s.n} players, ${s.games} games`);
      console.log(`seat win      ${s.seatWin.map((w) => w.toFixed(3)).join(" ")}`);
      console.log(`play/discard  ${pct(s.playRate)} / ${pct(s.discardRate)}   unpaid ${pct(s.unpaidRate)}   top tie on min ${pct(s.topTieOnMin)}`);
      console.log(`binding       ${RS.map((k) => `${k} ${pct(s.binding[k])}`).join("  ")}`);
      console.log(`final mean    ${RS.map((k) => `${k} ${s.meanFinal[k].toFixed(2)}`).join("  ")}   min ${s.meanScore.toFixed(2)}`);
      console.log(`field at M1   ${s.meanFieldAtM1.toFixed(2)}${flatField !== null ? ` (flat ${flatField})` : ""}   now ${s.fieldDist.now.map(pct).join("/")}   each ${s.fieldDist.each.map(pct).join("/")}   pushed out ${s.pushedOut.toFixed(2)}/game`);
      if (s.plan) console.log(`field plan    used by ${pct(s.plan.share)} of seats, win ${pct(s.plan.win)} (${pt(s.plan.win - base)} vs ${base.toFixed(3)})`);
      if (s.draftBot) {
        const d = s.draftBot;
        console.log(
          `draft bot     win ${pct(d.win)} (${pt(d.win - base)} vs ${base.toFixed(3)})   stays in hand ${d.stays[0].toFixed(2)} vs ${d.stays[1].toFixed(2)}   M1 ${d.m1[0].toFixed(2)} vs ${d.m1[1].toFixed(2)}`,
        );
        console.log(
          `              M1 taken when offered: ${pct(d.m1Take[0])} with 0-1 stays in hand (${d.m1Offered[0].toFixed(2)}/game), ${pct(d.m1Take[1])} with 2+ (${d.m1Offered[1].toFixed(2)}/game)`,
        );
        console.log("              (card rows below are biased by the draft bot's picks)");
      }
      const byRole = roles.map((role) => {
        const rs = s.rows.filter((r) => r.role === role);
        const h = rs.reduce((x, r) => x + r.held, 0);
        const w = rs.reduce((x, r) => x + r.heldWin * r.held, 0);
        return `${role} ${pt(w / Math.max(1, h) - base)}`;
      });
      console.log(`role win diff ${byRole.join("  ")}  (pt vs ${base.toFixed(3)})`);
      const sorted = [...s.rows].sort((a, b) => b.heldWin - a.heldWin);
      const fmt = (r: CardRow) => `#${r.id}(${r.role} ${pt(r.heldWin - base)})`;
      console.log(`top           ${sorted.slice(0, 5).map(fmt).join(" ")}`);
      console.log(`bottom        ${sorted.slice(-5).map(fmt).join(" ")}`);
    }
  }
}
