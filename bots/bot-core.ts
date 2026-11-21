/** Node のグローバル WebSocket / workerd の WebSocket の両方が満たす最小インターフェース。 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: () => void): void;
}

export interface BotEnd {
  winners: string[];
  scores?: Record<string, number>;
}

export interface BotOptions {
  /** 合法手から1つ選ぶ */
  pick(legal: unknown[]): unknown;
  /** 自分が作成者（hostToken を持つ）とき、プレイヤーがこの人数以上になったら呼ばれる（1回だけ） */
  startWhen?: { players: number; start(): Promise<void> };
}

/**
 * WebSocket で状態を受け取り、行動できるときだけ合法手を送る Bot。
 * error（STALE_TURN など）は無視して次の state を待つ。end を受け取ると解決する。
 */
export function runBot(ws: SocketLike, opts: BotOptions): Promise<BotEnd> {
  return new Promise((resolve, reject) => {
    let started = false;
    let answeredTurn = -1;

    ws.addEventListener("message", (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "end") {
        resolve({ winners: msg.winners as string[], scores: msg.scores as Record<string, number> | undefined });
        return;
      }
      if (msg.type !== "state") return;

      const players = msg.players as string[];
      if (msg.status === "waiting" && opts.startWhen && !started && players.length >= opts.startWhen.players) {
        started = true;
        opts.startWhen.start().catch(reject);
      }
      const legal = msg.legal as unknown[] | undefined;
      const turn = msg.turn as number;
      if (msg.status === "playing" && legal && legal.length > 0 && answeredTurn !== turn) {
        answeredTurn = turn;
        ws.send(JSON.stringify({ type: "action", turn, action: opts.pick(legal) }));
      }
    });
    ws.addEventListener("close", () => reject(new Error("socket closed before the game ended")));
  });
}

export const randomPick = (legal: unknown[]): unknown => legal[Math.floor(Math.random() * legal.length)];
