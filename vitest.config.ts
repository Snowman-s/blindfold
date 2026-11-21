import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    projects: [
      {
        // ゲームロジックは Cloudflare 非依存。Node で単体テストする。
        test: { name: "games", environment: "node", include: ["test/games/**/*.test.ts"] },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
            },
          })),
        ],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/worker/setup.ts"] },
      },
    ],
  },
});
