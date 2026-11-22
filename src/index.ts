import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { changelog } from "./lib/changelog";
import { guide, renderGuide } from "./lib/guide";
import { API_VERSION } from "./lib/version";
import { routes } from "./routes/rooms";
import { errBody, validationHook } from "./routes/schemas";
import { userRoutes } from "./routes/users";

const app = new OpenAPIHono<{ Bindings: Env }>({ defaultHook: validationHook });

// ブラウザで動くクライアントを別オリジンからも作れるようにする。認証は Bearer / サブプロトコルで Cookie を使わないので、
// どのオリジンを許可しても他人の資格情報が勝手に使われることはない。
// WebSocket のアップグレードには CORS は効かず、DO が返す 101 のヘッダーは書き換えられないので対象外にする。
const corsMw = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "X-Api-Key", "If-None-Match"],
  // Deprecation / Sunset / Link は廃止予定の告知（src/lib/deprecation.ts）。ブラウザのクライアントにも読めるようにする
  exposeHeaders: ["ETag", "Deprecation", "Sunset", "Link"],
  maxAge: 86400,
});
app.use("*", async (c, next) => {
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") return next();
  return corsMw(c, next);
});

/** クライアント開発者（主にコーディングエージェント）向けのガイド。version を ETag にする。 */
async function serveGuide(c: Context<{ Bindings: Env }>): Promise<Response> {
  const g = await guide();
  const etag = `"${g.version}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "Accept");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(renderGuide(g, new URL(c.req.url).origin));
}

app.get("/guide.md", serveGuide);
app.get("/llms.txt", serveGuide);

/** API の変更履歴。内容のハッシュを ETag にする。 */
app.get("/changelog.md", async (c) => {
  const g = await changelog();
  const etag = `"${g.version}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "public, max-age=3600");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(g.body);
});

// ユーザーが最初に貼るのはルート URL なので、ここから迷わずガイドに辿り着けるようにする。
// Markdown を求めるクライアントにはガイド本文をそのまま返す。
app.get("/", async (c) => {
  if ((c.req.header("Accept") ?? "").includes("text/markdown")) return serveGuide(c);
  c.header("Vary", "Accept");
  // 取得ツールは JSON を要約してから渡すことがあるので、相対パスより辿りやすい絶対 URL にする。
  const origin = new URL(c.req.url).origin;
  return c.json({
    name: "apigames",
    ok: true,
    description: "Turn-based games playable over HTTP + WebSocket. To build a client, read the guide.",
    guide: `${origin}/guide.md`,
    games: `${origin}/games`,
    openapi: `${origin}/openapi.json`,
    changelog: `${origin}/changelog.md`,
  });
});
app.route("/", routes);
app.route("/", userRoutes);

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "The player `token` from `POST /rooms/{id}/join` or `POST /quickmatch` (`hostToken` for `start`). `?token=` in the URL is rejected.",
});

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "apigames API",
    version: API_VERSION,
    description:
      "An API for playing and watching turn-based games without a screen. All game logic runs on the server. " +
      "Client developer guide: `/guide.md`.\n\n" +
      "`turn` is the number of actions applied so far. Send the current `turn` with each action; otherwise it is rejected with `STALE_TURN`.\n" +
      "A room goes `waiting` -> `playing` -> `finished`.",
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
