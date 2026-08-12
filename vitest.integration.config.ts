import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Read at config time so the same SQL that `wrangler d1 migrations apply` runs
// is what the tests apply, from scratch, before every suite.
const migrations = await readD1Migrations(path.join(here, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "test",
          PUBLIC_BASE_URL: "http://localhost:8787",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  resolve: {
    alias: [
      { find: /^@podiumstack\/domain(\/.*)?$/, replacement: r("./packages/domain/src$1") },
      { find: /^@podiumstack\/data(\/.*)?$/, replacement: r("./packages/data/src$1") },
      { find: /^@podiumstack\/plugins(\/.*)?$/, replacement: r("./packages/plugins/src$1") },
      { find: /^@podiumstack\/web(\/.*)?$/, replacement: r("./workers/api/src$1") },
    ],
  },
  test: {
    name: "integration",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
