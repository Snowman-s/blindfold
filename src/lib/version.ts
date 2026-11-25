import { z } from "zod";

/**
 * API の版（semver）。OpenAPI の info.version・ガイド・rules で共有する。
 * 0.x の間は実験段階で、マイナーを上げるだけで破壊的変更をしてよい（予告なし、changelog は事後）。
 * ガイド・rules の `version`（内容のハッシュ = ETag）とは別物。あちらは誤字1つ直しても変わる。
 * 上げたら src/lib/changelog.ts の先頭に同じ版のエントリを足す（テストで確認する）。
 */
export const API_VERSION = "0.12.0";

/**
 * サーバーが返す値（view など）の JSON Schema を配布用に作る。
 * 内部の strictObject（all-games テストで余計なフィールドが無いことを確かめる用）が出す
 * `additionalProperties: false` は取り除く。フィールドの追加は非破壊な変更として予告なしで行うので、
 * 配布した Schema で未知のフィールドを拒否するクライアントを作らせないため。
 * 入力（action・オプション）の Schema は余計なフィールドを拒否するので、そのまま z.toJSONSchema を使う。
 */
export function outputJsonSchema(schema: z.ZodType): unknown {
  return stripClosed(z.toJSONSchema(schema));
}

function stripClosed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripClosed);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "additionalProperties" && x === false) continue;
    out[k] = stripClosed(x);
  }
  return out;
}
