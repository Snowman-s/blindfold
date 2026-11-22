import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { games, getGame } from "../../src/games/registry";
import type { AnyGame } from "../../src/games/types";
import { WS_PROTOCOL } from "../../src/lib/auth";
import { FINISHED_ROOM_TTL_MS } from "../../src/lib/options";
import { migrateSchema, SCHEMA_VERSION } from "../../src/room/schema";
import { BASE, call, newRoom } from "./helpers";

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

  it("ルールの版が上がると、前の版のルームは進行中・終了済みとも GAME_REMOVED。ログは返し、新しいルームは新しい版", async () => {
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

      games[id] = { ...v1, rulesVersion: 2 };

      // 前の版のルームは、古い state を新しいエンジンで動かさずに断る
      const cases: [string, string, string | undefined][] = [
        [`/rooms/${playing.roomId}/state`, "GET", undefined],
        [`/rooms/${playing.roomId}/action`, "POST", playing.a.token],
        [`/rooms/${finished.roomId}/state`, "GET", undefined],
        [`/rooms/${finished.roomId}/replay`, "GET", undefined],
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

      // 開始前のルームは版を記録していないので、新しい版で始まる
      await call("POST", `/rooms/${waiting.roomId}/start`, { token: waiting.host });
      expect((await call("GET", `/rooms/${waiting.roomId}/state`)).json.rulesVersion).toBe(2);
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
