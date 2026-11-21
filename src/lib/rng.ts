/**
 * シード付き疑似乱数。シードは文字列（サーバーは 128 ビットの乱数を 16 進 32 文字で発行する）。
 *
 * 32 ビットのシードだと、プレイヤーが観測できる乱数の結果から 2^32 通りを総当たりして
 * シードを特定し、隠し情報や今後の引きを知ることができてしまう。そのため内部状態を 128 ビットにする。
 * - シード文字列 → cyrb128 で 128 ビットに展開 → sfc32（状態 128 ビット）
 * - 暗号論的な乱数ではない。1つの rng の出力を大量に観測されると状態を推定されうるので、
 *   乱数の出力をそのまま大量に公開するゲームでは注意すること。
 */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [0, n) の整数 */
  int(n: number): number;
}

export type Seed = string;

/** 文字列を 128 ビット（32 ビット × 4）に展開する。 */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRng(seed: Seed): Rng {
  let [a, b, c, d] = cyrb128(seed);
  const next = () => {
    // sfc32
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next(); // 初期状態の偏りを捨てる
  return { next, int: (n) => Math.floor(next() * n) };
}

/**
 * 手番ごとの rng。初期シードとターン番号から決まるので、
 * 行動ログだけで各手の乱数を完全に再現できる。
 */
export function rngForTurn(seed: Seed, turn: number): Rng {
  return createRng(`${seed}#turn:${turn}`);
}
