#!/usr/bin/env node
/**
 * Restore the demonstration deployment to its fixture state — R32 in
 * `docs/domain/13-open-questions.md`.
 *
 * `app.podiumstack.com` is a demonstration: anybody may sign in and change
 * anything, and every hour this puts it back. What it does is delete every row
 * in every table of the remote D1 database, replay a freshly generated seed
 * over it, and empty the KV cache the published schedule is served from.
 *
 * ## Why this is not a Cron Trigger
 *
 * Two reasons, and the second is the one that matters beyond this deployment.
 *
 * The seed is ~615 statements and four Argon2id hashes. The Workers free plan
 * enforces 10ms of CPU per invocation and a single one of those hashes has been
 * measured at 345ms (see `docs/implementation.md`), so this does not fit inside
 * a Worker at any plan we are on and would have to be chunked across ticks —
 * leaving the demonstration half-restored for the length of the sweep.
 *
 * And a "delete every row in every table" code path shipped inside an
 * open-source application is one misconfiguration away from running on
 * somebody's real conference. Here it is a job in this repository's CI that
 * happens to hold production credentials; there is nothing to reach in the
 * deployed Worker, whatever a visitor does to it.
 *
 * ## Why the seed is regenerated rather than checked in
 *
 * `scripts/seed.mjs` computes every date relative to now — the CFP closes in
 * eleven days, the event is next spring, a review round is open. A `seed.sql`
 * generated once and replayed would demonstrate a conference whose CFP closed
 * last year, which is a worse demonstration than no data at all.
 *
 * ## The interlock
 *
 * Before anything is deleted, the deployment is asked whether it is a
 * demonstration (`GET /demo/status`, `surfaces/demo.ts`). A real deployment
 * answers `demo: false` and this stops. That is the check that survives the
 * failure actually worth defending against — not a wrong flag in this file, but
 * a stale `wrangler.production.jsonc`, an exported `CF_D1_DATABASE_ID` from
 * another instance, or somebody running this by hand in the wrong terminal.
 *
 * Usage:
 *   set -a; . ~/.cloudflare/podium.env; set +a
 *   node scripts/demo-reset.mjs              # restore
 *   node scripts/demo-reset.mjs --dry-run    # say what it would do, touch nothing
 *   node scripts/demo-reset.mjs --local      # rehearse against the local D1
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DRY_RUN = process.argv.includes("--dry-run");
const LOCAL = process.argv.includes("--local");
const TARGET = LOCAL ? "--local" : "--remote";
const DB_NAME = "podium";

/**
 * Tables the wipe must not touch.
 *
 * `d1_migrations` is wrangler's own ledger of which migrations have run:
 * deleting it makes the next `d1 migrations apply` replay every migration
 * against a schema that already has them, which fails halfway and leaves the
 * database in a state this script cannot fix. `sqlite_*` and `_cf_*` belong to
 * the engine and the platform.
 */
const KEEP = new Set(["d1_migrations"]);
const KEEP_PREFIX = ["sqlite_", "_cf_"];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: opts.capture ? "pipe" : "inherit", ...opts });
}

function wrangler(args, opts = {}) {
  const base = LOCAL ? args : [...args, "-c", "wrangler.production.jsonc"];
  return run("npx", ["wrangler", ...base], opts);
}

function fail(message) {
  console.error(`\n✘ ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 1. the interlock                                                            */
/* -------------------------------------------------------------------------- */

async function assertDemoDeployment() {
  if (LOCAL) {
    console.log("• local rehearsal — skipping the deployment check");
    return "http://localhost:8787";
  }
  const baseUrl = (process.env.PODIUM_HOSTNAME || "").split(",")[0].trim();
  if (!baseUrl) fail("PODIUM_HOSTNAME is not set. `set -a; . ~/.cloudflare/podium.env; set +a`");
  const url = `https://${baseUrl}/demo/status`;

  let body;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    body = await res.json();
  } catch (err) {
    fail(`Could not reach ${url} (${err}). Refusing to delete anything without an answer from the deployment.`);
  }
  if (body?.demo !== true) {
    fail(
      `${url} says this is not a demonstration deployment.\n\n` +
        `  This script deletes every row in every table of the '${DB_NAME}' database.\n` +
        `  Deploy with PODIUM_DEMO=true first, or point PODIUM_HOSTNAME somewhere else.`,
    );
  }
  console.log(`• ${baseUrl} confirms it is a demonstration deployment (${body.personas?.length ?? 0} fixture people)`);
  return `https://${baseUrl}`;
}

/* -------------------------------------------------------------------------- */
/* 2. the wipe                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read the table list from the database rather than from `migrations/`.
 *
 * A list written down here would be a second place the schema is recorded and
 * the first thing to go stale — a table added in a migration and forgotten here
 * would survive every restore, which is the one failure this script exists to
 * prevent.
 */
function tableNames() {
  const out = wrangler(
    ["d1", "execute", DB_NAME, TARGET, "--json", "--command", "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"],
    { capture: true },
  );
  // `--json` prints a wrangler result envelope; the rows are the same shape in
  // every version we have run, but the wrapper has moved, so find it rather
  // than index into it.
  const parsed = JSON.parse(out);
  const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.result?.[0]?.results ?? parsed?.results;
  if (!Array.isArray(results)) fail(`Could not read the table list from wrangler's output:\n${out.slice(0, 400)}`);
  return results
    .map((r) => r.name)
    .filter((name) => !KEEP.has(name) && !KEEP_PREFIX.some((p) => name.startsWith(p)));
}

function wipeSql(tables) {
  return [
    // The tables reference each other in cycles (a person created a proposal
    // that produced a session that credits the person), so no delete order
    // satisfies every constraint. Deferring the checks to the end of the
    // transaction is what makes one flat list of DELETEs legal — the same
    // pragma `scripts/seed.mjs` opens with, for the mirror-image reason.
    "PRAGMA defer_foreign_keys = true;",
    ...tables.map((t) => `DELETE FROM ${t};`),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 3. the cache                                                                */
/* -------------------------------------------------------------------------- */

/**
 * KV holds the published-schedule snapshots (keyed on `content_etag`) and the
 * 24-hour idempotency replay cache. Both are keyed on ids the wipe has just
 * deleted, so a stale entry is not merely old — it is a public schedule for an
 * event that no longer exists, served without touching the database exactly as
 * INV-09-6 intends.
 *
 * R2 is deliberately *not* purged. Objects a visitor uploaded are reachable
 * only through the `asset` rows that name them, and those rows are gone; the
 * bytes are orphaned rather than served. Deleting them would mean listing a
 * bucket, which wrangler cannot do and which would mean growing an S3 client
 * here, to remove something already unreachable.
 *
 * Bucket growth is the bucket's own problem, and R2 has an answer for it. Set
 * it once, out of band:
 *
 *   wrangler r2 bucket lifecycle add podium-assets expire-demo-uploads \
 *     --expire-days 2 -c wrangler.production.jsonc
 *
 * Two days rather than one, so an object uploaded just before a restore is
 * never racing the rule that deletes it. Do NOT set this on a real deployment:
 * there it would delete every headshot and slide deck in the conference.
 */
function purgeCache() {
  const nsId = process.env.CF_KV_CACHE_ID;
  if (LOCAL) {
    console.log("• local rehearsal — leaving KV alone");
    return 0;
  }
  if (!nsId) fail("CF_KV_CACHE_ID is not set.");

  const listed = JSON.parse(run("npx", ["wrangler", "kv", "key", "list", "--namespace-id", nsId, "--remote"], { capture: true }));
  const keys = listed.map((k) => k.name);
  if (keys.length === 0) return 0;
  if (DRY_RUN) return keys.length;

  const dir = mkdtempSync(join(tmpdir(), "podium-demo-"));
  const file = join(dir, "keys.json");
  try {
    writeFileSync(file, JSON.stringify(keys));
    run("npx", ["wrangler", "kv", "bulk", "delete", file, "--namespace-id", nsId, "--remote", "--force"], { capture: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return keys.length;
}

/* -------------------------------------------------------------------------- */
/* 4. does it still work                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A restore that completed and left a broken site is worse than one that
 * failed, because nothing says so. These are the three things a visitor does
 * first, and they are checked from outside over HTTP for the same reason the
 * interlock is: the answer has to come from the deployment.
 */
async function smoke(baseUrl) {
  const checks = [
    ["the sign-in page", "/login"],
    ["the demonstration personas", "/demo/status"],
    ["the public event page", "/"],
  ];
  let bad = 0;
  for (const [what, path] of checks) {
    const res = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    const ok = res.status < 400;
    console.log(`  ${ok ? "✓" : "✘"} ${what} — ${res.status}`);
    if (!ok) bad++;
  }
  if (bad > 0) fail(`${bad} of ${checks.length} checks failed after the restore.`);
}

/* -------------------------------------------------------------------------- */

const baseUrl = await assertDemoDeployment();

const tables = tableNames();
console.log(`• ${tables.length} tables to clear (keeping ${[...KEEP].join(", ")})`);

const dir = mkdtempSync(join(tmpdir(), "podium-demo-"));
const restoreFile = join(dir, "restore.sql");

try {
  // `--print` writes the SQL to stdout and executes nothing, which is what
  // keeps the seed script's only database call the local one it documents.
  const seedSql = run("node", ["scripts/seed.mjs", "--print"], { capture: true });
  const statements = seedSql.split("\n").filter((l) => l.trim().startsWith("INSERT")).length;

  // One file, not two commands. Between the wipe and the seed there is no
  // `Organization` row, and a deployment with no organization sends every
  // visitor to the first-run setup screen, which creates one and an owner with
  // it (INV-01-16). That screen is refused the moment a row exists, so the
  // exposure is exactly the length of the gap — which is why the gap is one
  // round trip rather than two commands and a process spawn.
  writeFileSync(restoreFile, `${wipeSql(tables)}\n${seedSql}`);

  if (DRY_RUN) {
    console.log(`• dry run — would clear ${tables.length} tables, insert ${statements} rows, purge ${purgeCache()} cache keys`);
    console.log(`• restore SQL: ${restoreFile}`);
    process.exit(0);
  }

  console.log(`• clearing ${tables.length} tables and seeding ${statements} rows…`);
  wrangler(["d1", "execute", DB_NAME, TARGET, `--file=${restoreFile}`, "-y"], { capture: true });

  const purged = purgeCache();
  console.log(`• purged ${purged} cache keys`);

  if (!LOCAL) {
    console.log("• checking the site still works:");
    await smoke(baseUrl);
  }

  console.log(`\n✅ ${baseUrl} restored — ${tables.length} tables cleared, ${statements} rows seeded.\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
