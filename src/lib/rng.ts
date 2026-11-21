/** シード付き疑似乱数（mulberry32）。状態は seed の1つの整数だけ。 */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [0, n) の整数 */
  int(n: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}

/**
 * 手番ごとの rng。初期シードとターン番号から決まるので、
 * 行動ログだけで各手の乱数を完全に再現できる。
 */
export function rngForTurn(seed: number, turn: number): Rng {
  return createRng((Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(turn + 1, 0x85ebca6b)) >>> 0);
}
