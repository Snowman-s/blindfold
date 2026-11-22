import type { GameResult } from "../src/games/types";
import type { ServerMessage } from "../src/lib/protocol";

/** Node のグローバル WebSocket / workerd の WebSocket の両方が満たす最小インターフェース。 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: () => void): void;
}

export interface BotOptions {
  /** 合法手から1つ選ぶ */
  pick(legal: unknown[]): unknown;
  /** 自分が作成者（hostToken を持つ）とき、プレイヤーがこの人数以上になったら呼ばれる（1回だけ） */
  startWhen?: { players: number; start(): Promise<void> };
}

/**
 * WebSocket で状態を受け取り、行動できるときだけ合法手を送る Bot。
 * legal を使うので、合法手を列挙するゲーム（/games の listsLegalActions: true）専用。
 * error（STALE_TURN など）は無視して次の state を待つ。end を受け取ると解決する。
 */
export function runBot(ws: SocketLike, opts: BotOptions): Promise<GameResult> {
  return new Promise((resolve, reject) => {
    let started = false;
    let answeredTurn = -1;

    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "end") {
        resolve({ winners: msg.winners, scores: msg.scores });
        return;
      }
      if (msg.type !== "state") return;

      if (msg.status === "waiting" && opts.startWhen && !started && msg.players.length >= opts.startWhen.players) {
        started = true;
        opts.startWhen.start().catch(reject);
      }
      const { legal, turn } = msg;
      if (msg.status === "playing" && legal && legal.length > 0 && answeredTurn !== turn) {
        answeredTurn = turn;
        ws.send(JSON.stringify({ type: "action", turn, action: opts.pick(legal) }));
      }
    });
    ws.addEventListener("close", () => reject(new Error("socket closed before the game ended")));
  });
}

export const randomPick = (legal: unknown[]): unknown => legal[Math.floor(Math.random() * legal.length)];
