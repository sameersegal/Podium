import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@podiumconf\/domain(\/.*)?$/, replacement: r("./packages/domain/src$1") },
      { find: /^@podiumconf\/data(\/.*)?$/, replacement: r("./packages/data/src$1") },
      { find: /^@podiumconf\/plugins(\/.*)?$/, replacement: r("./packages/plugins/src$1") },
      { find: /^@podiumconf\/web(\/.*)?$/, replacement: r("./workers/api/src$1") },
    ],
  },
  test: {
    name: "unit",
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
