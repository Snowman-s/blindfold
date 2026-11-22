import { z } from "zod";
import type { AnyGame } from "../games/types";

export const DEFAULT_TURN_TIME_MS = 5 * 60 * 1000;

/** 1手あたりの持ち時間（ミリ秒）。クイックマッチでも使う。 */
export const turnTimeMs = z.number().int().min(1000).max(24 * 60 * 60 * 1000);

/** ルーム作成時のオプション。DO に保存するので、未知のキーは受け付けない（400）。 */
export const roomOptions = z
  .strictObject({
    /** 1手あたりの持ち時間（ミリ秒） */
    turnTimeMs: turnTimeMs.optional().describe(`Time limit per turn in ms (default ${DEFAULT_TURN_TIME_MS} = ${DEFAULT_TURN_TIME_MS / 60000} minutes)`),
    /**
     * 練習相手。true なら開始時に、参加者の後ろの空席（minPlayers まで）をサーバー側の Bot で埋める。
     * 打ち方はゲームごとに決まる（GameDefinition.practiceAction。未定義ならランダム）。練習試合は D1 に記録しない。
     */
    practice: z.boolean().optional().describe("Fill empty seats (up to minPlayers) with server-side practice bots at start. Not recorded in results"),
    /** true なら参加者が maxPlayers に達した時点で（ホストの start を待たずに）開始する。practice とは併用できない。 */
    autoStart: z.boolean().optional().describe("Start automatically once maxPlayers have joined. Cannot be combined with practice"),
    /** true ならルーム一覧（GET /rooms）とクイックマッチの対象にしない。roomId を知っている人だけが参加できる。 */
    unlisted: z.boolean().optional().describe("Hide from GET /rooms and quick match; only people who know roomId can join"),
  })
  .refine((o) => !(o.practice && o.autoStart), {
    message: "practice and autoStart cannot be combined",
    path: ["autoStart"],
  });
export type RoomOptions = z.infer<typeof roomOptions>;

/** 待機中のルームを一覧・クイックマッチに出す期間（最後の更新から）。放置された部屋に人を集めないため。 */
export const WAITING_LIST_TTL_MS = 30 * 60 * 1000;

/**
 * 試合中のルームの索引（D1 の rooms）を書き直す間隔。索引は1手ごとには書かないが、試合中も最後の書き込みから
 * この時間が経っていれば、次の手の確定時に書き直す（一覧の鮮度の絞り込みで、長い試合が消えないように）。
 */
export const PLAYING_INDEX_REFRESH_MS = 60 * 60 * 1000;

/**
 * 試合中のルームを一覧（GET /rooms?status=playing）に出す期間の余裕。最後の索引の書き込みから
 * 「そのルームの持ち時間 + これ」を過ぎた行は出さない。生きている試合は持ち時間以内に必ず手が確定し
 * （時間切れも含む）、PLAYING_INDEX_REFRESH_MS ごとに書き直すので、これより短くしないこと。
 * エンジンが無くなった・D1 への書き込みを諦めた・掃除で行を消せなかったルームが、観戦一覧に残り続けないようにする。
 */
export const PLAYING_LIST_GRACE_MS = 2 * PLAYING_INDEX_REFRESH_MS;

/** 待機中のルームを消すまでの期間（最後の作成・join・退出から）。DO のストレージごと消す。 */
export const WAITING_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 終了したルームを消すまでの期間（終了から）。state・/log・/replay はこの間だけ取れる（D1 の matches・results は残る）。
 * D1 への結果の書き込みの再試行（終了から 26 時間）より長くすること。
 */
export const FINISHED_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ゲーム固有のオプション（POST /rooms の gameOptions）を検証し、既定値を補った値にする。
 * optionsSchema の無いゲームは null（gameOptions を渡したら拒否）。省略したときは {} を parse する。
 * 返した値をそのまま meta に保存し、init とリプレイに渡す（JSON 往復で変わらないこと）。
 */
export function parseGameOptions(
  game: AnyGame,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!game.optionsSchema) {
    return raw === undefined || raw === null
      ? { ok: true, value: null }
      : { ok: false, message: `${game.id} has no game options` };
  }
  const r = game.optionsSchema.safeParse(raw ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, message: `invalid gameOptions${i ? ` (${i.path.join(".") || "(root)"}: ${i.message})` : ""}` };
  }
  return { ok: true, value: r.data ?? null };
}

/** 既定のゲームオプション（gameOptions を省略したときの値）。例・クイックマッチの照合に使う。 */
export function defaultGameOptions(game: AnyGame): unknown {
  const r = parseGameOptions(game, undefined);
  if (!r.ok) throw new Error(`${game.id}: optionsSchema must accept {}`);
  return r.value;
}

/** ゲームオプションの照合用の文字列（D1 の rooms.game_options・matches.game_options）。 */
export const gameOptionsKey = (value: unknown): string => JSON.stringify(value ?? null);
