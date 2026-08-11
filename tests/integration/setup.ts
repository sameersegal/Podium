/**
 * Integration test setup: apply every migration from scratch against the real
 * local D1 binding before any test runs (implementer.md, C: "Migrations applied
 * from scratch").
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
