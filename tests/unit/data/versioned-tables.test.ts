import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isVersioned } from "@podiumconf/data/db.js";

/**
 * `VERSIONED_TABLES` in `packages/data/src/db.ts` decides which writes bump
 * `row_version` (11-cross-cutting.md, "Concurrency"). It is a hand-maintained
 * list of what the schema actually has, and a hand-maintained list rots: add a
 * table with `row_version` and forget the set, and every write to it leaves the
 * counter at 1 — so compare-and-set on that table silently never fails, which
 * is worse than not having it at all.
 *
 * This reads the migrations and fails on the disagreement.
 */

const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;

/** Tables the schema gives a `row_version` column, whether at create or by ALTER. */
function versionedInSchema(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      if (/\brow_version\b/.test(m[2])) found.add(m[1]);
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+row_version\b/g)) {
      found.add(m[1]);
    }
  }
  return found;
}

describe("row_version (11-cross-cutting.md, \"Concurrency\")", () => {
  const schema = versionedInSchema();

  it("finds the versioned tables in the migrations at all", () => {
    // A regex that silently matches nothing would make every assertion below
    // pass for the wrong reason.
    expect(schema.size).toBeGreaterThan(20);
  });

  it("marks every table the schema versions", () => {
    const missing = [...schema].filter((t) => !isVersioned(t)).sort();
    expect(missing, `carry row_version but are absent from VERSIONED_TABLES: ${missing.join(", ")}`).toEqual([]);
  });

  it("marks no table the schema does not version", () => {
    // The other direction matters just as much: a name in the set that no table
    // has produces `UPDATE ... SET row_version = row_version + 1` against a
    // column that does not exist, and every write to it throws.
    const tables = new Set<string>();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/g)) tables.add(m[1]);
    }
    const spurious = [...tables].filter((t) => isVersioned(t) && !schema.has(t)).sort();
    expect(spurious, `in VERSIONED_TABLES without a row_version column: ${spurious.join(", ")}`).toEqual([]);
  });
});
