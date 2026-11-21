import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { routes, validationHook } from "./routes/rooms";
import { errBody } from "./routes/schemas";
import { userRoutes } from "./routes/users";

const app = new OpenAPIHono<{ Bindings: Env }>({ defaultHook: validationHook });

app.get("/", (c) => c.json({ name: "apigames", ok: true }));
app.route("/", routes);
app.route("/", userRoutes);

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "`POST /rooms/{id}/join` が返す token。`?token=` でも可。",
});

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "apigames API",
    version: "0.2.0",
    description:
      "ターン制ゲームを画面なしで遊べる／観戦できる API。ゲームロジックはすべてサーバー側で動く。\n\n" +
      "`turn` は適用済みの行動数。行動は現在の `turn` を付けて送り、一致しなければ `STALE_TURN` で拒否される。\n" +
      "ルームは `waiting` → `playing` → `finished` と進む。",
  },
});

// API ドキュメント（Swagger UI を CDN から読み込む。Worker からは HTML を返すだけ）
const DOCS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>apigames API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" });</script></body></html>`;
app.get("/docs", (c) => c.html(DOCS_HTML));

app.notFound((c) => c.json(errBody("NOT_FOUND", "not found"), 404));
app.onError((e, c) => {
  // 壊れた JSON ボディなどは Hono が 400 の HTTPException を投げる
  if (e instanceof HTTPException && e.status < 500) return c.json(errBody("BAD_REQUEST", e.message), e.status);
  console.error(e);
  return c.json(errBody("INTERNAL", "internal error"), 500);
});

export default app;
export { GameRoom } from "./room/GameRoom";
