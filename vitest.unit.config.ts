import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@podiumstack\/domain(\/.*)?$/, replacement: r("./packages/domain/src$1") },
      { find: /^@podiumstack\/data(\/.*)?$/, replacement: r("./packages/data/src$1") },
      { find: /^@podiumstack\/plugins(\/.*)?$/, replacement: r("./packages/plugins/src$1") },
      { find: /^@podiumstack\/web(\/.*)?$/, replacement: r("./workers/api/src$1") },
    ],
  },
  test: {
    name: "unit",
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
