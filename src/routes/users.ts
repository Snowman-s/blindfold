import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { newApiKey, newUserId, sha256Hex } from "../lib/auth";
import { validationHook } from "./rooms";
import { errBody, errors } from "./schemas";

export const userRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook: validationHook });

userRoutes.openapi(
  createRoute({
    method: "post",
    path: "/users",
    tags: ["users"],
    operationId: "createUser",
    summary: "ユーザー登録",
    description:
      "`apiKey` はこのレスポンスでしか返らない（サーバーにはハッシュだけ保存）。" +
      "`POST /rooms/{id}/join` に `X-Api-Key` として渡すと戦績が紐づく。",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: z.object({ name: z.string().min(1).max(32) }) } },
      },
    },
    responses: {
      201: {
        description: "登録済み",
        content: { "application/json": { schema: z.object({ userId: z.string(), name: z.string(), apiKey: z.string() }) } },
      },
      400: errors[400],
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
    method: "get",
    path: "/users/{id}",
    tags: ["users"],
    operationId: "getUser",
    summary: "ユーザーと戦績",
    request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: {
      200: {
        description: "ユーザー",
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              name: z.string(),
              stats: z.object({ played: z.number(), wins: z.number(), losses: z.number(), draws: z.number() }),
            }),
          },
        },
      },
      404: errors[404],
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

const MatchSchema = z.object({
  id: z.string(),
  game: z.string(),
  players: z.array(z.string()),
  startedAt: z.number(),
  finishedAt: z.number(),
  reason: z.enum(["normal", "timeout"]),
  results: z.array(
    z.object({ playerId: z.string(), userId: z.string().nullable(), outcome: z.string(), score: z.number().nullable() }),
  ),
});

userRoutes.openapi(
  createRoute({
    method: "get",
    path: "/matches",
    tags: ["matches"],
    operationId: "listMatches",
    summary: "終了した試合の一覧（新しい順）",
    request: {
      query: z.object({
        game: z.string().optional().openapi({ param: { name: "game", in: "query" } }),
        limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: {
      200: { description: "試合一覧", content: { "application/json": { schema: z.array(MatchSchema) } } },
      400: errors[400],
    },
  }),
  async (c) => {
    const { game, limit } = c.req.valid("query");
    // 1クエリで取得する（Free プランは1回の呼び出しあたりの D1 クエリ数に上限がある）
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.game, m.players, m.started_at, m.finished_at, m.reason,
              r.player_id, r.user_id, r.outcome, r.score
       FROM (SELECT * FROM matches WHERE (?1 IS NULL OR game = ?1) ORDER BY finished_at DESC, id LIMIT ?2) m
       JOIN results r ON r.match_id = m.id
       ORDER BY m.finished_at DESC, m.id, r.player_id`,
    )
      .bind(game ?? null, limit)
      .all<{
        id: string; game: string; players: string; started_at: number; finished_at: number; reason: "normal" | "timeout";
        player_id: string; user_id: string | null; outcome: string; score: number | null;
      }>();
    const byId = new Map<string, z.infer<typeof MatchSchema>>();
    for (const r of rows.results) {
      let m = byId.get(r.id);
      if (!m) {
        m = {
          id: r.id, game: r.game, players: JSON.parse(r.players) as string[],
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
