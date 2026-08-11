#!/usr/bin/env node
/**
 * Drop the local D1 state so `db:migrate` runs every migration from scratch.
 * Local development only — this never touches a remote database.
 */
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const targets = [".wrangler/state/v3/d1", ".wrangler/state/v3/kv", ".wrangler/state/v3/r2"];

for (const dir of targets) {
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
    console.log(`removed ${dir}`);
  }
}
console.log("local state reset");
