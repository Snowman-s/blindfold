import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { newApiKey, newUserId, sha256Hex } from "../lib/auth";
import { FINISHED_ROOM_TTL_MS } from "../lib/options";
import { END_REASONS, type EndReason } from "../lib/protocol";
import { errBody, errors, openEnum, validationHook } from "./schemas";

export const UserSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    stats: z
      .object({ played: z.number(), wins: z.number(), losses: z.number(), draws: z.number() })
      .describe("Counts over recorded (non-practice) games joined with this user's X-Api-Key"),
  })
  .openapi("User");

export const userRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook: validationHook });

userRoutes.openapi(
  createRoute({
    method: "post",
    path: "/users",
    tags: ["users"],
    operationId: "createUser",
    summary: "Register a user",
    description:
      "`apiKey` is returned only in this response (the server stores only its hash). " +
      "Send it as `X-Api-Key` to `POST /rooms/{id}/join` or `POST /quickmatch` to record results on this user.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: z.object({ name: z.string().min(1).max(32) }) } },
      },
    },
    responses: {
      201: {
        description: "Registered",
        content: { "application/json": { schema: z.object({ userId: z.string(), name: z.string(), apiKey: z.string() }) } },
      },
      400: errors[400],
      429: errors[429],
    },
  }),
  async (c) => {
    const { name } = c.req.valid("json");
    const id = newUserId();
    const apiKey = newApiKey();
    await c.env.DB.prepare("INSERT INTO users(id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, name, await sha256Hex(apiKey), Date.now())
      .run();
    return c.json({ userId: id, name, apiKey }, 201);
  },
);

userRoutes.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/key",
    tags: ["users"],
    operationId: "rotateApiKey",
    summary: "Issue a new API key (the current one stops working)",
    description:
      "Send the current key as `X-Api-Key`. The response has a new `apiKey` (returned only once) and the old key is " +
      "rejected from then on. Use it when a key may have leaked; to revoke a key, rotate it and keep the new one secret. " +
      "Seats already taken with the old key keep recording their results. If the key is lost, the user cannot be recovered: register a new one.",
    request: {
      params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
      headers: z.object({ "x-api-key": z.string().optional() }),
    },
    responses: {
      200: {
        description: "New key",
        content: { "application/json": { schema: z.object({ userId: z.string(), apiKey: z.string() }) } },
      },
      401: errors[401],
      429: errors[429],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const key = c.req.header("x-api-key");
    if (!key) return c.json(errBody("UNAUTHORIZED", "X-Api-Key required"), 401);
    const apiKey = newApiKey();
    // 古いキーの照合と差し替えを1文で行う（同時に2回呼ばれても、古いキーで成功するのは1回だけ）。
    // キーが別のユーザーのものでも 401 にする（他人のユーザー ID とキーの組み合わせを探らせない）
    const r = await c.env.DB.prepare("UPDATE users SET key_hash = ? WHERE id = ? AND key_hash = ?")
      .bind(await sha256Hex(apiKey), id, await sha256Hex(key))
      .run();
    if (r.meta.changes !== 1) return c.json(errBody("UNAUTHORIZED", "invalid api key for this user"), 401);
    return c.json({ userId: id, apiKey }, 200);
  },
);

userRoutes.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}",
    tags: ["users"],
    operationId: "getUser",
    summary: "A user and their results",
    request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: {
      200: {
        description: "User",
        content: {
          "application/json": {
            schema: UserSchema,
          },
        },
      },
      404: errors[404],
      429: errors[429],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const user = await c.env.DB.prepare("SELECT id, name FROM users WHERE id = ?").bind(id).first<{ id: string; name: string }>();
    if (!user) return c.json(errBody("NOT_FOUND", "user not found"), 404);
    const s = await c.env.DB.prepare(
      `SELECT COUNT(*) AS played,
              COALESCE(SUM(outcome = 'win'), 0) AS wins,
              COALESCE(SUM(outcome = 'loss'), 0) AS losses,
              COALESCE(SUM(outcome = 'draw'), 0) AS draws
       FROM results WHERE user_id = ?`,
    )
      .bind(id)
      .first<{ played: number; wins: number; losses: number; draws: number }>();
    return c.json({ ...user, stats: s! }, 200);
  },
);

export const OUTCOMES = ["win", "loss", "draw"] as const;

export const MatchSchema = z
  .object({
    id: z
      .string()
      .describe(
        `Same as the roomId of the game (so /rooms/{id}/log and /replay work with it until the finished room is deleted, ${FINISHED_ROOM_TTL_MS / 86400000} days after the end)`,
      ),
    game: z.string(),
    rulesVersion: z.number().int().describe("Rules version the game was played with"),
    gameOptions: z.unknown().describe("Game-specific options the game was played with (defaults filled in). null for games without options"),
    players: z.array(z.string()),
    startedAt: z.number().describe("epoch ms"),
    finishedAt: z.number().describe("epoch ms"),
    reason: openEnum(END_REASONS, "Why the game ended. normal = decided by the game's rules. Treat an unknown value like normal."),
    results: z.array(
      z.object({
        playerId: z.string(),
        userId: z.string().nullable().describe("The user who joined with X-Api-Key, or null"),
        outcome: openEnum(
          OUTCOMES,
          "draw only for a game decided as a draw by its rules. If everyone timed out, everyone gets loss. Treat an unknown value as neither a win nor a loss.",
        ),
        score: z.number().nullable().describe("scores[playerId] of the result, or null if the game has no scores"),
      }),
    ),
  })
  .openapi("Match");

userRoutes.openapi(
  createRoute({
    method: "get",
    path: "/matches",
    tags: ["matches"],
    operationId: "listMatches",
    summary: "Finished matches, newest first",
    request: {
      query: z.object({
        game: z.string().optional().openapi({ param: { name: "game", in: "query" } }),
        limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: {
      200: { description: "Matches", content: { "application/json": { schema: z.array(MatchSchema) } } },
      400: errors[400],
      429: errors[429],
    },
  }),
  async (c) => {
    const { game, limit } = c.req.valid("query");
    // 1クエリで取得する（Free プランは1回の呼び出しあたりの D1 クエリ数に上限がある）
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.game, m.rules_version, m.game_options, m.players, m.started_at, m.finished_at, m.reason,
              r.player_id, r.user_id, r.outcome, r.score
       FROM (SELECT * FROM matches WHERE (?1 IS NULL OR game = ?1) ORDER BY finished_at DESC, id LIMIT ?2) m
       JOIN results r ON r.match_id = m.id
       ORDER BY m.finished_at DESC, m.id, r.player_id`,
    )
      .bind(game ?? null, limit)
      .all<{
        id: string; game: string; rules_version: number; game_options: string; players: string; started_at: number; finished_at: number; reason: EndReason;
        player_id: string; user_id: string | null; outcome: (typeof OUTCOMES)[number]; score: number | null;
      }>();
    const byId = new Map<string, z.infer<typeof MatchSchema>>();
    for (const r of rows.results) {
      let m = byId.get(r.id);
      if (!m) {
        m = {
          id: r.id, game: r.game, rulesVersion: r.rules_version,
          gameOptions: JSON.parse(r.game_options) as unknown, players: JSON.parse(r.players) as string[],
          startedAt: r.started_at, finishedAt: r.finished_at, reason: r.reason, results: [],
        };
        byId.set(r.id, m);
      }
      m.results.push({ playerId: r.player_id, userId: r.user_id, outcome: r.outcome, score: r.score });
    }
    const out = [...byId.values()];
    return c.json(out, 200);
  },
);
