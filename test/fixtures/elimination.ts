import { z } from "zod";
import { GameError, type GameDefinition } from "../../src/games/types";

/**
 * テスト専用のゲーム（registry には載せない）。3人まで。手番の人は pass するだけ。
 * 投了・時間切れになった人は脱落し、残りが1人になったらその人の勝ち。onResign / onTimeout の検証に使う。
 */
export interface ElimState {
  alive: string[];
  turn: number; // alive の中の手番のインデックス
}

const remove = (s: ElimState, out: string[]): ElimState => {
  const current = s.alive[s.turn]!;
  const alive = s.alive.filter((p) => !out.includes(p));
  // 手番の人が抜けたら次の人へ（alive の並びの中で、元の手番の位置にいる人）
  const turn = out.includes(current) ? s.turn % Math.max(alive.length, 1) : alive.indexOf(current);
  return { alive, turn };
};

export const elimination: GameDefinition<ElimState, { pass: true }> = {
  id: "test-elimination",
  minPlayers: 2,
  maxPlayers: 3,
  actionSchema: z.object({ pass: z.literal(true) }),
  docs: { summary: "test", rules: "test", view: "test", examples: [{ action: { pass: true }, meaning: "pass" }] },
  init: (players) => ({ alive: [...players], turn: 0 }),
  currentPlayers: (s) => (s.alive.length > 1 ? [s.alive[s.turn]!] : []),
  legalActions(s, pid) {
    return this.currentPlayers(s).includes(pid) ? [{ pass: true }] : [];
  },
  apply(s, pid) {
    if (!this.currentPlayers(s).includes(pid)) throw new GameError("NOT_YOUR_TURN", "not your turn");
    return { ...s, turn: (s.turn + 1) % s.alive.length };
  },
  view: (s) => s,
  result: (s) => (s.alive.length === 1 ? { winners: [s.alive[0]!] } : null),
  onResign(s, pid) {
    if (!s.alive.includes(pid)) throw new GameError("ILLEGAL_ACTION", "already out");
    return remove(s, [pid]);
  },
  onTimeout: (s, pids) => remove(s, pids),
};
