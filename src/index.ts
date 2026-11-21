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
  description: "`POST /rooms/{id}/join` が返す token（開始時は hostToken）。URL の `?token=` は受け付けない。",
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
// CDN 側の改ざんに備えて、バージョンを完全に固定し SRI（integrity）で中身を検証する。
// ハッシュは npm の tarball と照合済み。更新するときはバージョンとハッシュを両方差し替える:
//   curl -sL https://unpkg.com/swagger-ui-dist@<ver>/<file> | openssl dgst -sha384 -binary | openssl base64 -A
const SWAGGER_UI = {
  base: "https://unpkg.com/swagger-ui-dist@5.35.1",
  css: "sha384-WlYgdmXYOOBWL5apwjDEZwN+U3HmXSSu5R6V5aGxEcf7z+KuRNwBhoxKVN1i3D5I",
  js: "sha384-J5eKRXKO1KzUTPkO0GRmGH2WEYUg6SSZlufilxvTwI6nmhLumjNWFMby3QQnyobZ",
} as const;

// validatorUrl: null で外部の validator.swagger.io へのアクセスを止める
const DOCS_INIT_SCRIPT = 'SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui", validatorUrl: null });';

const DOCS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>apigames API</title>
<link rel="stylesheet" href="${SWAGGER_UI.base}/swagger-ui.css" integrity="${SWAGGER_UI.css}" crossorigin="anonymous"></head>
<body><div id="ui"></div>
<script src="${SWAGGER_UI.base}/swagger-ui-bundle.js" integrity="${SWAGGER_UI.js}" crossorigin="anonymous"></script>
<script>${DOCS_INIT_SCRIPT}</script></body></html>`;

/** インラインの初期化スクリプトだけを許可する CSP 用ハッシュ（初回アクセス時に計算して使い回す）。 */
let initScriptHash: Promise<string> | null = null;
const getInitScriptHash = () =>
  (initScriptHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(DOCS_INIT_SCRIPT))
    .then((d) => btoa(String.fromCharCode(...new Uint8Array(d)))));

app.get("/docs", async (c) => {
  const csp = [
    "default-src 'none'",
    `script-src ${SWAGGER_UI.base}/ 'sha256-${await getInitScriptHash()}'`,
    // Swagger UI は一部の表示でインラインスタイルを使う
    `style-src ${SWAGGER_UI.base}/ 'unsafe-inline'`,
    "img-src 'self' data:",
    "connect-src 'self'", // openapi.json の取得と Try it out は同一オリジンだけ
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  c.header("Content-Security-Policy", csp);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(DOCS_HTML);
});

app.notFound((c) => c.json(errBody("NOT_FOUND", "not found"), 404));
app.onError((e, c) => {
  // 壊れた JSON ボディなどは Hono が 400 の HTTPException を投げる
  if (e instanceof HTTPException && e.status < 500) return c.json(errBody("BAD_REQUEST", e.message), e.status);
  console.error(e);
  return c.json(errBody("INTERNAL", "internal error"), 500);
});

export default app;
export { GameRoom } from "./room/GameRoom";
