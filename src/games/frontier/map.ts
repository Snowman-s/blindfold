import type { Rng } from "../../lib/rng";

/**
 * マップの生成（init からだけ呼ぶ。乱数は init の rng だけを使う）。
 * 1人分の区画（セクター）を1つ作り、人数分だけ複製して輪につなぐ（人数分の回転対称なので、どの席も同じ条件になる）。
 * 全員の区画につながる中央のノードを1つ置く。ノード ID は最後に並べ替えて、区画の構造が ID から分からないようにする。
 */

export const HOME_PRODUCTION = 3;
export const HOME_TROOPS = 6;
export const CENTER_PRODUCTION = 4;
export const CENTER_GARRISON = 12;

export interface GeneratedMap {
  /** production と、中立のときの守備兵（本拠地は所有者の初期兵力）。 */
  nodes: { production: number; troops: number }[];
  /** 無向エッジ。[小さい ID, 大きい ID]、昇順。 */
  edges: [number, number][];
  /** 席 i の本拠地のノード ID。 */
  homes: number[];
}

/** 区画のテンプレート。ノード 0 が本拠地。 */
function sector(k: number, rng: Rng): { production: number[]; garrison: number[]; edges: [number, number][] } {
  const edges: [number, number][] = [];
  const has = (a: number, b: number) => edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  // 木：半分は直前のノードにつなぎ、残りはそれより前のどれかにつなぐ（細長くなりすぎず、奥行きもできる）
  for (let j = 1; j < k; j++) edges.push([rng.next() < 0.5 ? j - 1 : rng.int(j), j]);
  // 余分なエッジで環を作る（迂回路）
  const extra = Math.floor(k / 3);
  for (let t = 0, added = 0; t < 20 && added < extra; t++) {
    const a = rng.int(k);
    const b = rng.int(k);
    if (a === b || has(a, b)) continue;
    edges.push([a, b]);
    added++;
  }
  const production = Array.from({ length: k }, (_, j) => (j === 0 ? HOME_PRODUCTION : 1 + rng.int(3)));
  const garrison = production.map((p, j) => (j === 0 ? HOME_TROOPS : p * 2 + rng.int(3)));
  return { production, garrison, edges };
}

/** 本拠地からの距離（テンプレートの中で）。 */
function depths(k: number, edges: [number, number][]): number[] {
  const d = Array<number>(k).fill(-1);
  d[0] = 0;
  const queue = [0];
  while (queue.length) {
    const v = queue.shift()!;
    for (const [a, b] of edges) {
      const w = a === v ? b : b === v ? a : -1;
      if (w >= 0 && d[w] === -1) {
        d[w] = d[v]! + 1;
        queue.push(w);
      }
    }
  }
  return d;
}

const pick = <T>(xs: T[], rng: Rng): T => xs[rng.int(xs.length)]!;

export function generateMap(players: number, k: number, rng: Rng): GeneratedMap {
  const t = sector(k, rng);
  const d = depths(k, t.edges);
  const maxDepth = Math.max(...d);
  const nodesAt = (min: number) => d.map((x, j) => (x >= min ? j : -1)).filter((j) => j > 0);
  // 隣の区画とつなぐノード（a は次の区画へ、b は前の区画から）と、中央につなぐノード c。本拠地から遠いものを選ぶ
  const a = pick(nodesAt(maxDepth), rng);
  const b = pick(nodesAt(Math.max(1, maxDepth - 1)), rng);
  const c = pick(nodesAt(Math.min(2, maxDepth)), rng);

  const total = players * k + 1;
  const center = players * k;
  const at = (i: number, j: number) => i * k + j;
  const raw: [number, number][] = [];
  for (let i = 0; i < players; i++) {
    for (const [x, y] of t.edges) raw.push([at(i, x), at(i, y)]);
    raw.push([at(i, a), at((i + 1) % players, b)]);
    raw.push([at(i, c), center]);
  }

  // ID を並べ替える（Fisher-Yates）
  const perm = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }

  const nodes = Array.from({ length: total }, () => ({ production: 0, troops: 0 }));
  for (let i = 0; i < players; i++) {
    for (let j = 0; j < k; j++) nodes[perm[at(i, j)]!] = { production: t.production[j]!, troops: t.garrison[j]! };
  }
  nodes[perm[center]!] = { production: CENTER_PRODUCTION, troops: CENTER_GARRISON };

  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const [x, y] of raw) {
    const [p, q] = [perm[x]!, perm[y]!].sort((m, n) => m - n) as [number, number];
    const key = `${p}-${q}`;
    if (p === q || seen.has(key)) continue;
    seen.add(key);
    edges.push([p, q]);
  }
  edges.sort((m, n) => m[0] - n[0] || m[1] - n[1]);
  return { nodes, edges, homes: Array.from({ length: players }, (_, i) => perm[at(i, 0)]!) };
}
