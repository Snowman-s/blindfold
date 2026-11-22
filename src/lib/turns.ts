// 手番の判定（ルーム・ガイドの例の両方で使う純粋関数）。

/**
 * 同じ同時手番が続いているか：prev（変更前に行動できたプレイヤー）から、行動できるプレイヤーが減っただけ
 * （同時手番で誰かが出した・抜けた）なら true。手番が移ったとき・新しいラウンドに入ったときは false。
 * unchangedKeeps は「行動できるプレイヤーが変わらなかった」ときも true にするか。投了のときだけ true：
 * 通常の手で同じ顔ぶれになるのは新しいラウンド（全員が出し終えた）だが、もう出した人や手番でない人の投了では
 * 顔ぶれが変わらないまま同じ手番が続く（締め切りを延ばしたり、送信中の手を STALE_TURN にしたりしない）。
 */
export const sameSimultaneousTurn = (
  prev: string[] | null,
  prevDeadline: number | null,
  pending: string[],
  unchangedKeeps = false,
): boolean =>
  prev !== null &&
  prevDeadline !== null &&
  pending.length > 0 &&
  (pending.length < prev.length || (unchangedKeeps && pending.length === prev.length)) &&
  pending.every((p) => prev.includes(p));
