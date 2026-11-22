import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { games, getGame } from "../../src/games/registry";
import type { AnyGame } from "../../src/games/types";
import { WS_PROTOCOL } from "../../src/lib/auth";
import { FINISHED_ROOM_TTL_MS, PLAYING_INDEX_REFRESH_MS, PLAYING_LIST_GRACE_MS } from "../../src/lib/options";
import { CLOSE_GAME_REMOVED } from "../../src/lib/protocol";
import { migrateSchema, SCHEMA_VERSION } from "../../src/room/schema";
import { BASE, call, connect, newRoom } from "./helpers";

const stub = (id: string) => env.GAME_ROOM.getByName(id);
const meta = (id: string, key: string) =>
  runInDurableObject(stub(id), (_i, state) => {
    const rows = state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (rows[0]!.value as string) : null;
  });
const indexRow = (id: string) =>
  env.DB.prepare("SELECT status, updated_at FROM rooms WHERE id = ?").bind(id).first<{ status: string; updated_at: number }>();

// 互換性の土台：ゲームの版の固定・消えたゲーム・スキーマ移行・出力の enum。

describe("rulesVersion / viewVersion", () => {
  it("/games と /games/:id/rules に載る", async () => {
    const list = (await call("GET", "/games")).json as { id: string; rulesVersion: number; viewVersion: number }[];
    for (const g of list) {
      expect(g.rulesVersion).toBe(games[g.id]!.rulesVersion);
      expect(g.viewVersion).toBe(games[g.id]!.viewVersion);
      const r = (await call("GET", `/games/${g.id}/rules`)).json;
      expect(r.rulesVersion).toBe(g.rulesVersion);
      expect(r.viewVersion).toBe(g.viewVersion);
      const md = await (await SELF.fetch(`${BASE}/games/${g.id}/rules.md`)).text();
      expect(md.split("\n")[0]).toContain(`rulesVersion ${g.rulesVersion}, viewVersion ${g.viewVersion}`);
    }
  });

  it("getGame は版を指定すると、今の版と一致するときだけ返す", () => {
    expect(getGame("tictactoe")).toBe(games.tictactoe);
    expect(getGame("tictactoe", games.tictactoe!.rulesVersion)).toBe(games.tictactoe);
    expect(getGame("tictactoe", games.tictactoe!.rulesVersion + 1)).toBeUndefined();
    expect(getGame("nope")).toBeUndefined();
  });

  it("ルールの版が上がると、前の版のルームは待機中・進行中・終了済みとも GAME_REMOVED。ログは返し、新しいルームは新しい版", async () => {
    // 共有の games.tictactoe は書き換えない（他のテストや gameRules のキャッシュに漏れないように）。
    const id = "test-rules-version";
    const v1: AnyGame = { ...(games.tictactoe as AnyGame), id, rulesVersion: 1 };
    games[id] = v1;
    try {
      const playing = await newRoom(id);
      await call("POST", `/rooms/${playing.roomId}/start`, { token: playing.host });
      expect((await call("GET", `/rooms/${playing.roomId}/state`)).json.rulesVersion).toBe(1);
      const finished = await newRoom(id);
      await call("POST", `/rooms/${finished.roomId}/start`, { token: finished.host });
      await call("POST", `/rooms/${finished.roomId}/resign`, { token: finished.a.token });
      expect((await call("GET", `/rooms/${finished.roomId}/replay`)).status).toBe(200);
      const waiting = await newRoom(id);
      // 版はルームの作成時に記録する（待機中から返る）
      expect((await call("GET", `/rooms/${waiting.roomId}/state`)).json.rulesVersion).toBe(1);

      games[id] = { ...v1, rulesVersion: 2 };

      // 前の版のルームは、古い state を新しいエンジンで動かさずに断る
      const cases: [string, string, string | undefined][] = [
        [`/rooms/${playing.roomId}/state`, "GET", undefined],
        [`/rooms/${playing.roomId}/action`, "POST", playing.a.token],
        [`/rooms/${finished.roomId}/state`, "GET", undefined],
        [`/rooms/${finished.roomId}/replay`, "GET", undefined],
        // 待機中のルームも、古い版で検証した gameOptions のまま新しい init で始めない
        [`/rooms/${waiting.roomId}/state`, "GET", undefined],
        [`/rooms/${waiting.roomId}/join`, "POST", undefined],
        [`/rooms/${waiting.roomId}/start`, "POST", waiting.host],
      ];
      for (const [path, method, token] of cases) {
        const body = method === "POST" ? { turn: 0, action: { cell: 0 } } : undefined;
        const r = await call(method, path, { token, body });
        expect(r.status, path).toBe(410);
        expect(r.json.error.code).toBe("GAME_REMOVED");
      }
      const log = await call("GET", `/rooms/${finished.roomId}/log`);
      expect(log.status).toBe(200);
      expect(log.json.rulesVersion).toBe(1);
      const matches = (await call("GET", `/matches?game=${id}&limit=100`)).json;
      expect(matches.find((m: { id: string }) => m.id === finished.roomId)?.rulesVersion).toBe(1);

      // 新しいルームは新しい版（待機中から）
      const fresh = await newRoom(id);
      expect((await call("GET", `/rooms/${fresh.roomId}/state`)).json.rulesVersion).toBe(2);
      await call("POST", `/rooms/${fresh.roomId}/start`, { token: fresh.host });
      expect((await call("GET", `/rooms/${fresh.roomId}/state`)).json.rulesVersion).toBe(2);
    } finally {
      delete games[id];
    }
  });

  it("レジストリから消えたゲームのルームは、REST・WS・alarm のどれでも落ちずに GAME_REMOVED", async () => {
    const id = "test-removed-game";
    games[id] = { ...(games.tictactoe as AnyGame), id };
    const playing = await newRoom(id);
    await call("POST", `/rooms/${playing.roomId}/start`, { token: playing.host });
    const waiting = await newRoom(id);
    delete games[id];

    const cases: [string, string, string | undefined][] = [
      [`/rooms/${playing.roomId}/state`, "GET", undefined],
      [`/rooms/${playing.roomId}/action`, "POST", playing.a.token],
      [`/rooms/${playing.roomId}/resign`, "POST", playing.a.token],
      [`/rooms/${waiting.roomId}/join`, "POST", undefined],
      [`/rooms/${waiting.roomId}/start`, "POST", waiting.host],
      [`/rooms/${waiting.roomId}/leave`, "POST", waiting.a.token],
    ];
    for (const [path, method, token] of cases) {
      const body = method === "POST" ? { turn: 0, action: { cell: 0 } } : undefined;
      const r = await call(method, path, { token, body });
      expect(r.status, path).toBe(410);
      expect(r.json.error.code).toBe("GAME_REMOVED");
    }
    const ws = await SELF.fetch(`${BASE}/rooms/${playing.roomId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": WS_PROTOCOL },
    });
    expect(ws.status).toBe(410);

    // 締め切りの alarm が残っていても、例外にせず（再試行を繰り返さず）抜け、締め切りは張り直さない。
    // 代わりに掃除の alarm を1つだけ張る（終了したルームと同じ期間の後に消す）
    const stub = env.GAME_ROOM.getByName(playing.roomId);
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await call("GET", `/rooms/${playing.roomId}/state`); // ensureAlarm を通す
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + FINISHED_ROOM_TTL_MS - 60_000);
    // 期限が来たら消える
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'cleanupAt'", String(Date.now() - 1));
      return state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await call("GET", `/rooms/${playing.roomId}/log`)).status).toBe(404);
  });
});

describe("エンジンが無いと分かったルームを畳む", () => {
  it("REST で見つけたら、全接続を 4002 で閉じ、索引の行を消し、進行中なら終了と同じ期間の後に掃除する。2回目は何もしない", async () => {
    const id = "test-retire-rest";
    games[id] = { ...(games.tictactoe as AnyGame), id };
    const playing = await newRoom(id);
    await call("POST", `/rooms/${playing.roomId}/start`, { token: playing.host });
    const waiting = await newRoom(id);
    // 消す前に接続しておく（消した後は 410 で繋がらない）
    const player = await connect(playing.roomId, playing.a.token);
    const spectator = await connect(playing.roomId);
    const waiter = await connect(waiting.roomId, waiting.a.token);
    expect((await indexRow(playing.roomId))?.status).toBe("playing");
    expect((await indexRow(waiting.roomId))?.status).toBe("waiting");
    delete games[id];

    expect((await call("GET", `/rooms/${playing.roomId}/state`)).status).toBe(410);
    expect(await player.closed).toBe(CLOSE_GAME_REMOVED);
    expect(await spectator.closed).toBe(CLOSE_GAME_REMOVED);
    expect(await indexRow(playing.roomId)).toBeNull();
    const cleanupAt = Number(await meta(playing.roomId, "cleanupAt"));
    expect(cleanupAt).toBeGreaterThan(Date.now() + FINISHED_ROOM_TTL_MS - 60_000);
    expect(await runInDurableObject(stub(playing.roomId), (_i, s) => s.storage.getAlarm())).toBe(cleanupAt);

    // 2回目は畳み直さない（掃除の時刻も延びない）
    await call("GET", `/rooms/${playing.roomId}/state`);
    expect(Number(await meta(playing.roomId, "cleanupAt"))).toBe(cleanupAt);

    // 待機中のルームも同じ（掃除は待機中の期限のまま）
    const waitingCleanup = await meta(waiting.roomId, "cleanupAt");
    expect((await call("POST", `/rooms/${waiting.roomId}/join`)).status).toBe(410);
    expect(await waiter.closed).toBe(CLOSE_GAME_REMOVED);
    expect(await indexRow(waiting.roomId)).toBeNull();
    expect(await meta(waiting.roomId, "cleanupAt")).toBe(waitingCleanup);
  });

  it("WS のメッセージで見つけたら、GAME_REMOVED を送ってから閉じる", async () => {
    const id = "test-retire-ws";
    games[id] = { ...(games.tictactoe as AnyGame), id };
    const r = await newRoom(id);
    await call("POST", `/rooms/${r.roomId}/start`, { token: r.host });
    const conn = await connect(r.roomId, r.a.token);
    const errors: string[] = [];
    conn.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as { type: string; code?: string };
      if (m.type === "error") errors.push(m.code!);
    });
    delete games[id];
    conn.ws.send(JSON.stringify({ type: "action", turn: 0, action: { cell: 0 } }));
    expect(await conn.closed).toBe(CLOSE_GAME_REMOVED);
    expect(errors).toEqual(["GAME_REMOVED"]);
    expect(await indexRow(r.roomId)).toBeNull();
  });

  it("alarm で見つけても畳む", async () => {
    const id = "test-retire-alarm";
    games[id] = { ...(games.tictactoe as AnyGame), id };
    const r = await newRoom(id);
    await call("POST", `/rooms/${r.roomId}/start`, { token: r.host });
    const conn = await connect(r.roomId);
    delete games[id];
    await runInDurableObject(stub(r.roomId), (_i, s) => s.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub(r.roomId))).toBe(true);
    expect(await conn.closed).toBe(CLOSE_GAME_REMOVED);
    expect(await indexRow(r.roomId)).toBeNull();
    expect(await meta(r.roomId, "retired")).toBe("1");
  });

  it("D1 への書き込みを再試行している間にエンジンが消えても、終了時に保存した結果で書き、その後で掃除を張る", async () => {
    const id = "test-retire-persist";
    games[id] = { ...(games.tictactoe as AnyGame), id };
    const r = await newRoom(id);
    await call("POST", `/rooms/${r.roomId}/start`, { token: r.host });
    await call("POST", `/rooms/${r.roomId}/resign`, { token: r.a.token });
    expect(JSON.parse((await meta(r.roomId, "result"))!).winners).toEqual(["p2"]);
    // D1 への書き込みが失敗して再試行を待っている状態にする
    await env.DB.batch([
      env.DB.prepare("DELETE FROM results WHERE match_id = ?").bind(r.roomId),
      env.DB.prepare("DELETE FROM matches WHERE id = ?").bind(r.roomId),
    ]);
    await runInDurableObject(stub(r.roomId), (_i, s) => {
      s.storage.sql.exec("DELETE FROM meta WHERE key = 'persisted'");
      return s.storage.setAlarm(Date.now() + 60_000);
    });
    delete games[id];
    // 入口で畳んでも、再試行の alarm を掃除で上書きしない
    expect((await call("GET", `/rooms/${r.roomId}/state`)).status).toBe(410);
    expect(await runInDurableObject(stub(r.roomId), (_i, s) => s.storage.getAlarm())).not.toBe(
      Number(await meta(r.roomId, "cleanupAt")),
    );
    await runInDurableObject(stub(r.roomId), (_i, s) => s.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub(r.roomId))).toBe(true);

    expect(await meta(r.roomId, "persisted")).toBe("1");
    const m = await env.DB.prepare("SELECT reason FROM matches WHERE id = ?").bind(r.roomId).first<{ reason: string }>();
    expect(m?.reason).toBe("resign");
    const rs = await env.DB.prepare("SELECT player_id, outcome FROM results WHERE match_id = ? ORDER BY player_id")
      .bind(r.roomId)
      .all<{ player_id: string; outcome: string }>();
    expect(rs.results.map((x) => x.outcome)).toEqual(["loss", "win"]);
    // 畳んだルームの索引の行は書き直さない
    expect(await indexRow(r.roomId)).toBeNull();
    expect(await runInDurableObject(stub(r.roomId), (_i, s) => s.storage.getAlarm())).toBe(
      Number(await meta(r.roomId, "cleanupAt")),
    );
  });
});

describe("進行中の一覧の鮮度", () => {
  const listedPlaying = async (roomId: string) =>
    ((await call("GET", "/rooms?status=playing&limit=100")).json as { roomId: string }[]).some((r) => r.roomId === roomId);

  it("索引の最後の書き込みから「持ち時間 + 余裕」を過ぎた行は出さない", async () => {
    const r = await newRoom("tictactoe");
    await call("POST", `/rooms/${r.roomId}/start`, { token: r.host });
    expect(await listedPlaying(r.roomId)).toBe(true);
    const turnTimeMs = (await env.DB.prepare("SELECT turn_time_ms AS t FROM rooms WHERE id = ?").bind(r.roomId).first<{ t: number }>())!.t;
    const age = (ms: number) => env.DB.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(Date.now() - ms, r.roomId).run();
    await age(turnTimeMs + PLAYING_LIST_GRACE_MS - 60_000);
    expect(await listedPlaying(r.roomId)).toBe(true);
    await age(turnTimeMs + PLAYING_LIST_GRACE_MS + 60_000);
    expect(await listedPlaying(r.roomId)).toBe(false);
  });

  it("試合中も、最後の書き込みから PLAYING_INDEX_REFRESH_MS 経っていれば手の確定時に書き直す（それより前は書かない）", async () => {
    const r = await newRoom("tictactoe");
    await call("POST", `/rooms/${r.roomId}/start`, { token: r.host });
    const before = (await indexRow(r.roomId))!.updated_at;
    await call("POST", `/rooms/${r.roomId}/action`, { token: r.a.token, body: { turn: 0, action: { cell: 0 } } });
    expect((await indexRow(r.roomId))!.updated_at).toBe(before);

    // 古く見せる（D1 の行と meta の両方）
    const old = Date.now() - PLAYING_INDEX_REFRESH_MS - 1000;
    await env.DB.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(old, r.roomId).run();
    await runInDurableObject(stub(r.roomId), (_i, s) => {
      s.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'indexedAt'", String(old));
    });
    await call("POST", `/rooms/${r.roomId}/action`, { token: r.b.token, body: { turn: 1, action: { cell: 3 } } });
    const row = (await indexRow(r.roomId))!;
    expect(row.status).toBe("playing");
    expect(row.updated_at).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("DO 内 SQLite のスキーマ移行", () => {
  const version = (sql: SqlStorage) =>
    Number(sql.exec("SELECT value FROM meta WHERE key = 'schemaVersion'").one().value);

  it("新しいルームは今の版（SCHEMA_VERSION）で作られる", async () => {
    const { roomId } = await newRoom("tictactoe");
    await runInDurableObject(env.GAME_ROOM.getByName(roomId), (_i, state) => {
      expect(version(state.storage.sql)).toBe(SCHEMA_VERSION);
    });
  });

  it("古い版のルームは1段ずつ移行し、2回目は何もせず、新しすぎる版には触らない", async () => {
    const { roomId } = await newRoom("tictactoe");
    await runInDurableObject(env.GAME_ROOM.getByName(roomId), (_i, state) => {
      const sql = state.storage.sql;
      const migrations = [
        ...Array.from({ length: SCHEMA_VERSION - 1 }, () => () => {}),
        (s: SqlStorage) => void s.exec("ALTER TABLE players ADD COLUMN extra TEXT"),
        (s: SqlStorage) => void s.exec("CREATE TABLE extra_table(x INTEGER)"),
      ];
      migrateSchema(state.storage, migrations);
      expect(version(sql)).toBe(SCHEMA_VERSION + 2);
      expect(sql.exec("SELECT extra FROM players").toArray().length).toBe(2);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'extra_table'").toArray().length).toBe(1);
      // 2回目は何もしない（ALTER をもう一度流すと例外になる）
      migrateSchema(state.storage, migrations);
      expect(version(sql)).toBe(SCHEMA_VERSION + 2);
      // コードを戻した（保存された版の方が新しい）ときは触らない
      migrateSchema(state.storage);
      expect(version(sql)).toBe(SCHEMA_VERSION + 2);
    });
  });
});

describe("出力の enum は値が増えうる", () => {
  it("OpenAPI のレスポンスの status・reason・outcome は enum ではなく string で、今の値を説明に書く", async () => {
    const s = (await call("GET", "/openapi.json")).json.components.schemas;
    const cases: [{ type?: string; enum?: unknown; description?: string }, string][] = [
      [s.RoomState.properties.status, "playing"],
      [s.RoomSummary.properties.status, "waiting"],
      [s.Match.properties.reason, "timeout"],
      [s.Match.properties.results.items.properties.outcome, "draw"],
    ];
    for (const [schema, value] of cases) {
      expect(schema.type).toBe("string");
      expect(schema.enum).toBeUndefined();
      expect(schema.description).toContain(`\`${value}\``);
      expect(schema.description).toContain("more values may be added");
    }
  });
});
