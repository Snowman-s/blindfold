import { z } from "zod";
import { GameError, type GameDefinition } from "../types";
import { createRng, type Rng } from "../../lib/rng";
import { MAX_MISSED } from "./constants";
import { generateMap } from "./map";

export { MAX_MISSED };
import { docs } from "./docs";

/**
 * フロンティア：座標のないグラフ上の陣取り（2〜4人、同時手番）。
 * 毎ラウンド全員が自分のノードから隣接ノードへ兵を送る命令を伏せて出し、全員が出したら同時に解決する。
 * 解決は乱数を使わない（rng を引くのはマップを作る init だけ）。ルールの説明（英語）は docs.ts。
 */

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
const MAX_ORDERS = 200;
const MAX_COUNT = 1_000_000;

export interface Order {
  from: number;
  to: number;
  count: number;
}
export interface Move extends Order {
  player: string;
}
/** 解決した命令と、解決前の行き先の持ち主（霧のとき、自分のノードへの攻撃を見せるため。view には出さない）。 */
export interface ResolvedMove extends Move {
  toOwner: string | null;
}
/** エッジ上の衝突：同じエッジを逆向きに進んだ、違うプレイヤーの2つの部隊。どちらも lost だけ減る。 */
export interface Clash {
  type: "clash";
  /** groups[0].from < groups[0].to */
  groups: [Move, Move];
  lost: number;
}
/** ノードでの戦闘：持ち主の側（残った兵 + 自分の援軍。中立なら守備隊）と、到着した他のプレイヤーの側。 */
export interface Battle {
  type: "battle";
  node: number;
  /** 戦闘前の持ち主（null は中立） */
  owner: string | null;
  /** 勢力ごとの兵数（多い順。player が null なのは中立の守備隊） */
  sides: { player: string | null; troops: number }[];
  /** 戦闘後の持ち主（最大が同数なら owner のまま） */
  winner: string | null;
  /** 戦闘後に残った兵（産出の前） */
  troops: number;
}
export type RoundEvent = Clash | Battle;
export interface FrontierNode {
  production: number;
  /** null は中立。 */
  owner: string | null;
  troops: number;
}
export type OutReason = "eliminated" | "resigned" | "timedOut";

export interface FrontierState {
  players: string[];
  /** まだ遊んでいるプレイヤー（席順）。 */
  alive: string[];
  /** 抜けたプレイヤー → 理由。 */
  out: Record<string, OutReason>;
  nodes: FrontierNode[];
  edges: [number, number][];
  /** 解決済みのラウンド数。 */
  round: number;
  maxRounds: number;
  fog: boolean;
  /** 今ラウンドの命令（alive のみ。null はまだ出していない）。 */
  orders: Record<string, Order[] | null>;
  /** 連続で時間切れになった回数（alive のみ）。 */
  missed: Record<string, number>;
  /** 直前のラウンドで実行された命令。 */
  lastMoves: ResolvedMove[];
  /** 直前のラウンドの衝突と戦闘（解決した順：エッジ上の衝突、ノードでの戦闘はノード番号順）。 */
  lastBattles: RoundEvent[];
}

export type FrontierAction = { orders: Order[] };

export interface FrontierOptions {
  maxRounds: number;
  nodesPerPlayer: number;
  fog: boolean;
}

const optionsSchema = z.strictObject({
  maxRounds: z.number().int().min(5).max(100).default(20).describe("Number of rounds (default 20)"),
  nodesPerPlayer: z
    .number()
    .int()
    .min(3)
    .max(12)
    .default(6)
    .describe("Nodes in each player's sector, home included (default 6). The map has players x nodesPerPlayer + 1 nodes"),
  fog: z.boolean().default(false).describe("Fog of war: hide troop counts of nodes you are not next to (default false)"),
});

const nodeId = z.number().int().min(0).max(10_000);
const orderSchema = z.strictObject({
  from: nodeId.describe("Your node to send troops from"),
  to: nodeId.describe("A node adjacent to `from`"),
  count: z.number().int().min(1).max(MAX_COUNT).describe("Number of troops to send"),
});
const actionSchema = z.strictObject({
  orders: z.array(orderSchema).max(MAX_ORDERS).describe("Your orders for this round. An empty array holds every node"),
});

const moveSchema = z.strictObject({ player: z.string(), from: z.number().int(), to: z.number().int(), count: z.number().int() });
const pidMap = <T extends z.ZodType>(v: T) => z.record(z.string(), v);
const viewSchema = z.strictObject({
  round: z.number().int().min(0).describe("Number of finished rounds"),
  maxRounds: z.number().int().describe("The game ends after this many rounds"),
  fog: z.boolean().describe("Whether fog of war is on (game option)"),
  players: z.array(z.string()).describe("All player IDs in seat order"),
  alive: z.array(z.string()).describe("Players still in the game, in seat order"),
  out: pidMap(z.enum(["eliminated", "resigned", "timedOut"])).describe("Player ID -> why that player left the game"),
  nodes: z
    .array(
      z.strictObject({
        id: z.number().int().describe("Node ID (= index in this array)"),
        production: z.number().int().describe("Troops added to this node at the end of each round while someone owns it"),
        owner: z.string().nullable().describe("Owning player ID, or null for neutral"),
        troops: z.number().int().nullable().describe("Troops on the node, or null when hidden by fog"),
      }),
    )
    .describe("All nodes"),
  edges: z.array(z.tuple([z.number().int(), z.number().int()])).describe("Undirected edges [a, b] with a < b"),
  territory: pidMap(z.number().int()).describe("Player ID -> total production of the nodes they own (the score)"),
  submitted: pidMap(z.boolean()).describe("Player ID (alive players) -> whether they have sent orders this round"),
  lastMoves: z.array(moveSchema).describe("Orders carried out in the previous round that you can see (counts as sent)"),
  lastBattles: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("clash"),
          groups: z.tuple([moveSchema, moveSchema]).describe("The two groups that met on the edge (groups[0].from < groups[0].to)"),
          lost: z.number().int().describe("Troops each group lost (the smaller group's count)"),
        }),
        z.strictObject({
          type: z.literal("battle"),
          node: z.number().int(),
          owner: z.string().nullable().describe("Owner before the battle (null = neutral)"),
          sides: z
            .array(z.strictObject({ player: z.string().nullable().describe("null = the neutral garrison"), troops: z.number().int() }))
            .describe("Troops per side, largest first. The owner's side is its remaining troops plus its own arrivals"),
          winner: z.string().nullable().describe("Owner after the battle (unchanged on a tie for the largest side)"),
          troops: z.number().int().describe("Troops left on the node after the battle, before production"),
        }),
      ]),
    )
    .describe("Clashes on edges and battles at nodes in the previous round that you can see, in the order they were resolved"),
  myOrders: z
    .array(z.strictObject({ from: z.number().int(), to: z.number().int(), count: z.number().int() }))
    .nullable()
    .optional()
    .describe("Players only: your orders for this round, or null if you have not sent them"),
});

// ---- 補助 ----

const neighbors = (s: Pick<FrontierState, "nodes" | "edges">): number[][] => {
  const adj = s.nodes.map(() => [] as number[]);
  for (const [a, b] of s.edges) {
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  return adj;
};

export const isOver = (s: FrontierState): boolean => s.round >= s.maxRounds || s.alive.length <= 1;

const territoryOf = (s: FrontierState, pid: string): number =>
  s.nodes.reduce((t, n) => t + (n.owner === pid ? n.production : 0), 0);
const troopsOf = (s: FrontierState, pid: string): number =>
  s.nodes.reduce((t, n) => t + (n.owner === pid ? n.troops : 0), 0);

/** 兵数が見えるノード。霧が無い・決着後は全部。霧のあるときは自分のノードとその隣（観戦者・抜けた人は何も見えない）。 */
function visibleNodes(s: FrontierState, viewer: string | null): boolean[] {
  if (!s.fog || isOver(s)) return s.nodes.map(() => true);
  const vis = s.nodes.map(() => false);
  if (viewer === null || !s.alive.includes(viewer)) return vis;
  const adj = neighbors(s);
  s.nodes.forEach((n, i) => {
    if (n.owner !== viewer) return;
    vis[i] = true;
    for (const j of adj[i]!) vis[j] = true;
  });
  return vis;
}

/** プレイヤーを抜けさせる。ノードは兵ごと中立になり、今ラウンドの命令は捨てる。 */
function drop(s: FrontierState, pid: string, reason: OutReason): FrontierState {
  const orders = { ...s.orders };
  const missed = { ...s.missed };
  delete orders[pid];
  delete missed[pid];
  return {
    ...s,
    alive: s.alive.filter((p) => p !== pid),
    out: { ...s.out, [pid]: reason },
    nodes: s.nodes.map((n) => (n.owner === pid ? { ...n, owner: null } : n)),
    orders,
    missed,
  };
}

/** ラウンドの解決：出発 → エッジ上の衝突 → 到着先での戦闘 → 産出 → 全ノードを失った人の脱落。 */
function resolve(s: FrontierState): FrontierState {
  const troops = s.nodes.map((n) => n.troops);
  const moves: ResolvedMove[] = s.alive.flatMap((p) =>
    (s.orders[p] ?? []).map((o) => ({ player: p, ...o, toOwner: s.nodes[o.to]!.owner })),
  );
  const events: RoundEvent[] = [];
  const plain = ({ player, from, to, count }: Move): Move => ({ player, from, to, count });
  for (const m of moves) troops[m.from]! -= m.count;

  // 同じエッジを逆向きに進む、違うプレイヤーの部隊どうしは、エッジ上で少ない方の数だけ削り合う
  const arriving = new Map<number, Map<string, number>>();
  const arrive = (node: number, player: string, n: number) => {
    if (n <= 0) return;
    const m = arriving.get(node) ?? new Map<string, number>();
    m.set(player, (m.get(player) ?? 0) + n);
    arriving.set(node, m);
  };
  for (const m of moves) {
    const back = moves.find((o) => o.from === m.to && o.to === m.from);
    const loss = back && back.player !== m.player ? Math.min(m.count, back.count) : 0;
    if (back && loss > 0 && m.from < m.to) events.push({ type: "clash", groups: [plain(m), plain(back)], lost: loss });
    arrive(m.to, m.player, m.count - loss);
  }

  const nodes = s.nodes.map((n, i) => ({ ...n, troops: troops[i]! }));
  for (const [i, incoming] of [...arriving].sort((x, y) => x[0] - y[0])) {
    const node = nodes[i]!;
    // 勢力ごとの兵数（キー "" は中立）。持ち主の残った兵と援軍は同じ勢力
    const forces = new Map<string, number>([[node.owner ?? "", node.troops]]);
    for (const [p, n] of incoming) forces.set(p, (forces.get(p) ?? 0) + n);
    const ranked = [...forces].sort((x, y) => y[1] - x[1]);
    const [top, second] = [ranked[0]!, ranked[1]?.[1] ?? 0];
    if (top[1] > second) nodes[i] = { ...node, owner: top[0] === "" ? null : top[0], troops: top[1] - second };
    else nodes[i] = { ...node, troops: 0 }; // 最大が同数：全滅し、持ち主は変わらない
    // 持ち主の援軍だけが着いたノードは戦闘ではない
    if (ranked.length > 1) {
      events.push({
        type: "battle",
        node: i,
        owner: node.owner,
        sides: ranked.map(([p, n]) => ({ player: p === "" ? null : p, troops: n })),
        winner: nodes[i]!.owner,
        troops: nodes[i]!.troops,
      });
    }
  }
  for (const n of nodes) if (n.owner !== null) n.troops += n.production;

  let next: FrontierState = { ...s, nodes, round: s.round + 1, lastMoves: moves, lastBattles: events };
  for (const p of s.alive) if (!nodes.some((n) => n.owner === p)) next = drop(next, p, "eliminated");
  return {
    ...next,
    orders: isOver(next) ? {} : Object.fromEntries(next.alive.map((p) => [p, null])),
  };
}

/** 全員の命令が揃っていれば解決する（apply・onTimeout・onResign のどれで揃っても、ここで必ず解決する）。 */
function settle(s: FrontierState): FrontierState {
  if (isOver(s)) return { ...s, orders: {} };
  return s.alive.every((p) => s.orders[p] !== null && s.orders[p] !== undefined) ? resolve(s) : s;
}

/** 命令の検証。違反していればどの命令が悪いかを書いた ILLEGAL_ACTION。 */
function checkOrders(s: FrontierState, pid: string, orders: Order[]): void {
  const adj = neighbors(s);
  const sent = new Map<number, number>();
  const seen = new Set<string>();
  orders.forEach((o, i) => {
    const bad = (why: string) => {
      throw new GameError("ILLEGAL_ACTION", `orders[${i}] (${o.from} -> ${o.to}): ${why}`);
    };
    const from = s.nodes[o.from];
    if (!from) bad(`node ${o.from} does not exist`);
    if (!s.nodes[o.to]) bad(`node ${o.to} does not exist`);
    if (from!.owner !== pid) bad(`node ${o.from} is not yours`);
    if (!adj[o.from]!.includes(o.to)) bad(`node ${o.to} is not adjacent to ${o.from}`);
    const key = `${o.from}-${o.to}`;
    if (seen.has(key)) bad("duplicate order for the same from and to (combine them into one)");
    seen.add(key);
    const total = (sent.get(o.from) ?? 0) + o.count;
    if (total > from!.troops) bad(`node ${o.from} has only ${from!.troops} troops, but your orders send ${total} from it`);
    sent.set(o.from, total);
  });
}

// ---- 練習相手 ----

/**
 * 貪欲法：隣の取れそうなノード（産出が多く守りが薄い順）に、足りる分だけ送る。敵に接するノードには脅威の半分強を残す。
 * 前線に接していないノードの兵は、前線に近い隣のノードへ回す。見えるもの（自分のノードとその隣）だけを使う。
 */
function practice(s: FrontierState, pid: string, rng: Rng): FrontierAction {
  const adj = neighbors(s);
  const mine = s.nodes.map((n) => n.owner === pid);
  const spare = s.nodes.map((n, i) => {
    if (!mine[i]) return 0;
    const threat = adj[i]!.reduce((t, j) => t + (s.nodes[j]!.owner !== null && !mine[j] ? s.nodes[j]!.troops : 0), 0);
    return Math.max(0, n.troops - Math.ceil(threat * 0.6));
  });
  const orders: Order[] = [];
  const targets = s.nodes
    .map((n, i) => ({ i, score: (n.production * 10) / (n.troops + 1) + rng.next() }))
    .filter(({ i }) => !mine[i] && adj[i]!.some((j) => mine[j]))
    .sort((x, y) => y.score - x.score);
  for (const { i } of targets) {
    const t = s.nodes[i]!;
    let need = t.troops + 1 + (t.owner !== null ? 1 + rng.int(3) : 0);
    const sources = adj[i]!.filter((j) => mine[j] && spare[j]! > 0).sort((x, y) => spare[y]! - spare[x]!);
    if (sources.reduce((t2, j) => t2 + spare[j]!, 0) < need) continue;
    for (const j of sources) {
      if (need <= 0) break;
      const n = Math.min(spare[j]!, need);
      orders.push({ from: j, to: i, count: n });
      spare[j]! -= n;
      need -= n;
    }
  }
  // 前線までの距離（自分のノードの中で）
  const dist = s.nodes.map(() => Infinity);
  const queue: number[] = [];
  s.nodes.forEach((_, i) => {
    if (mine[i] && adj[i]!.some((j) => !mine[j])) {
      dist[i] = 0;
      queue.push(i);
    }
  });
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of adj[v]!) {
      if (mine[w] && dist[w] === Infinity) {
        dist[w] = dist[v]! + 1;
        queue.push(w);
      }
    }
  }
  s.nodes.forEach((_, i) => {
    if (!mine[i] || dist[i] === 0 || dist[i] === Infinity || spare[i]! <= 0) return;
    const closer = adj[i]!.filter((j) => mine[j] && dist[j]! < dist[i]!);
    if (closer.length) orders.push({ from: i, to: closer[rng.int(closer.length)]!, count: spare[i]! });
  });
  return { orders };
}

// ---- 本体 ----

export const frontier: GameDefinition<FrontierState, FrontierAction, FrontierOptions> = {
  id: "frontier",
  rulesVersion: 2,
  viewVersion: 1,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  actionSchema,
  viewSchema,
  optionsSchema,
  docs,

  init(players, seed, options) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS || new Set(players).size !== players.length) {
      throw new GameError("BAD_REQUEST", `frontier requires ${MIN_PLAYERS}-${MAX_PLAYERS} distinct players`);
    }
    const map = generateMap(players.length, options.nodesPerPlayer, createRng(seed));
    const owners = new Map(map.homes.map((h, i) => [h, players[i]!]));
    return {
      players: [...players],
      alive: [...players],
      out: {},
      nodes: map.nodes.map((n, i) => ({ ...n, owner: owners.get(i) ?? null })),
      edges: map.edges,
      round: 0,
      maxRounds: options.maxRounds,
      fog: options.fog,
      orders: Object.fromEntries(players.map((p) => [p, null])),
      missed: Object.fromEntries(players.map((p) => [p, 0])),
      lastMoves: [],
      lastBattles: [],
    };
  },

  currentPlayers(s) {
    return isOver(s) ? [] : s.alive.filter((p) => s.orders[p] === null);
  },

  apply(s, pid, a) {
    if (isOver(s)) throw new GameError("ILLEGAL_ACTION", "game is over");
    if (!this.currentPlayers(s).includes(pid)) {
      throw new GameError("NOT_YOUR_TURN", s.alive.includes(pid) ? "you already sent orders this round" : "you are out of the game");
    }
    checkOrders(s, pid, a.orders);
    const orders = a.orders.map(({ from, to, count }) => ({ from, to, count }));
    return settle({ ...s, orders: { ...s.orders, [pid]: orders }, missed: { ...s.missed, [pid]: 0 } });
  },

  view(s, pid) {
    const vis = visibleNodes(s, pid);
    const me = pid !== null && s.players.includes(pid) ? pid : null;
    return {
      round: s.round,
      maxRounds: s.maxRounds,
      fog: s.fog,
      players: s.players,
      alive: s.alive,
      out: s.out,
      nodes: s.nodes.map((n, id) => ({ id, production: n.production, owner: n.owner, troops: vis[id] ? n.troops : null })),
      edges: s.edges,
      territory: Object.fromEntries(s.players.map((p) => [p, territoryOf(s, p)])),
      submitted: Object.fromEntries(s.alive.map((p) => [p, isOver(s) || s.orders[p] !== null])),
      // 霧のときは今見えるノードに関わるものだけ。ただし自分が関わったものは、ノードを失っても・抜けても必ず見せる
      lastMoves: s.lastMoves
        .filter((m) => vis[m.from] || vis[m.to] || (me !== null && (m.player === me || m.toOwner === me)))
        .map(({ player, from, to, count }) => ({ player, from, to, count })),
      lastBattles: s.lastBattles.filter((e) =>
        e.type === "clash"
          ? vis[e.groups[0].from] || vis[e.groups[0].to] || e.groups.some((g) => g.player === me)
          : vis[e.node] || (me !== null && (e.owner === me || e.sides.some((x) => x.player === me))),
      ),
      ...(me ? { myOrders: s.orders[me] ?? null } : {}),
    };
  },

  result(s) {
    if (!isOver(s)) return null;
    const key = (p: string) => [territoryOf(s, p), troopsOf(s, p)] as const;
    let best: readonly [number, number] | null = null;
    let winners: string[] = [];
    for (const p of s.alive) {
      const k = key(p);
      if (!best || k[0] > best[0] || (k[0] === best[0] && k[1] > best[1])) {
        best = k;
        winners = [p];
      } else if (k[0] === best[0] && k[1] === best[1]) winners.push(p);
    }
    return { winners, scores: Object.fromEntries(s.players.map((p) => [p, territoryOf(s, p)])) };
  },

  onTimeout(s, pids) {
    let next = s;
    for (const p of pids) {
      if (!next.alive.includes(p) || next.orders[p] !== null) continue;
      const missed = (next.missed[p] ?? 0) + 1;
      next =
        missed >= MAX_MISSED
          ? drop(next, p, "timedOut")
          : { ...next, orders: { ...next.orders, [p]: [] }, missed: { ...next.missed, [p]: missed } };
    }
    return settle(next);
  },

  onResign(s, pid) {
    if (!s.alive.includes(pid)) throw new GameError("ILLEGAL_ACTION", "you are already out of the game");
    return settle(drop(s, pid, "resigned"));
  },

  practiceAction(s, pid, rng) {
    return practice(s, pid, rng);
  },
};
