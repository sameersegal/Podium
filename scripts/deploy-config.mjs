#!/usr/bin/env node
/**
 * Generate `wrangler.production.jsonc` from the committed `wrangler.jsonc`.
 *
 * Why this exists rather than an `env.production` block in the committed
 * config: this is an open-source project, and account-scoped resource ids in a
 * file everyone clones means a self-hoster's first deploy silently targets
 * somebody else's D1. The committed config stays local-only and honest about
 * it; production values arrive from the environment.
 *
 * Why generated rather than hand-written: a standalone second config is a
 * complete copy, and copies drift. Change `compatibility_date` or add a binding
 * in `wrangler.jsonc` and production picks it up here for free — only the
 * fields that genuinely differ between a laptop and production are overridden
 * below.
 *
 * Required environment:
 *   PODIUM_HOSTNAME      hostname the Worker serves. May be a comma-separated
 *                        list; the first entry is canonical (see below).
 *   CF_D1_DATABASE_ID    `wrangler d1 create podium`
 *   CF_KV_CACHE_ID       `wrangler kv namespace create CACHE`
 *
 * Locally these live in ~/.cloudflare/podium.env; in CI they are repository
 * secrets. Usage: `npm run deploy`, or this script alone to inspect the output.
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const BASE = "wrangler.jsonc";
const OUT = "wrangler.production.jsonc";

/**
 * Strip JSONC comments so `JSON.parse` can read the base config.
 *
 * String-aware on purpose: the base config contains "http://localhost:8787",
 * and a regex that treats every `//` as a comment truncates it to "http:".
 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += text[++i] ?? ""; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }

  // Trailing commas are legal in JSONC and fatal to JSON.parse.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `\n✘ ${name} is not set.\n\n` +
        `  Production config needs PODIUM_HOSTNAME, CF_D1_DATABASE_ID and CF_KV_CACHE_ID.\n` +
        `  Locally:  set -a; . ~/.cloudflare/podium.env; set +a\n` +
        `  In CI:    repository secrets on the deploy job.\n`,
    );
    process.exit(1);
  }
  return v;
}

// A comma-separated list, because a Worker can answer on more than one
// hostname and moving between them needs a window where it answers on both.
// The first entry is canonical: it is what PUBLIC_BASE_URL is built from, and
// therefore what every invitation accept_url, unsubscribe link, ICS URL and
// embed snippet points at. The rest are aliases the Worker also serves.
//
// The app itself never learns any of this. It reads PUBLIC_BASE_URL and
// nothing else, so the hostname is a deployment fact, not a property of the
// code — which is what lets the same artifact serve a self-hoster's domain.
const hostnames = required("PODIUM_HOSTNAME")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
if (hostnames.length === 0) throw new Error("PODIUM_HOSTNAME is set but empty");
const canonicalHostname = hostnames[0];

const config = JSON.parse(stripJsonComments(readFileSync(BASE, "utf8")));

/* -------------------------------------------------------------------------- */
/* What differs between a laptop and production                               */
/* -------------------------------------------------------------------------- */

// A named environment would deploy as `podium-production`; a standalone config
// keeps the Worker called what the project is called.
delete config.env;

config.workers_dev = false;

// Careful: `wrangler deploy` does not merge custom domains, it replaces the
// Worker's whole set (PUT /domains/records with override_scope: true), and in
// CI — where stdout is not a TTY — it also passes override_existing_origin
// without prompting. So whatever is listed here becomes the complete truth,
// and a hostname served by a *different* Worker gets taken from it silently.
//
// Concretely: podiumstack.com belongs to the `podium-www` Worker (see
// www/wrangler.jsonc). Adding it back to PODIUM_HOSTNAME would take the
// marketing site down from a green build, with nothing in the log to say so.
config.routes = hostnames.map((pattern) => ({ pattern, custom_domain: true }));

config.vars = {
  ...config.vars,
  ENVIRONMENT: "production",
  // Invitation accept_urls (INV-01-15), unsubscribe links and the portal links
  // inside email bodies are built from this. It must be one of the routes above.
  PUBLIC_BASE_URL: `https://${canonicalHostname}`,
};

const db = config.d1_databases?.find((d) => d.binding === "DB");
if (!db) throw new Error(`${BASE} has no d1_databases entry bound as DB`);
db.database_id = required("CF_D1_DATABASE_ID");

const cache = config.kv_namespaces?.find((n) => n.binding === "CACHE");
if (!cache) throw new Error(`${BASE} has no kv_namespaces entry bound as CACHE`);
cache.id = required("CF_KV_CACHE_ID");

/* -------------------------------------------------------------------------- */

const banner = [
  "// Generated by scripts/deploy-config.mjs — do not edit, and do not commit.",
  `// Source: ${BASE}. Regenerate with \`npm run deploy:config\`.`,
  "",
].join("\n");

writeFileSync(OUT, banner + JSON.stringify(config, null, 2) + "\n");
console.log(
  `✅ ${OUT} — ${hostnames.join(", ")}, D1 ${db.database_id.slice(0, 8)}…, KV ${cache.id.slice(0, 8)}…`,
);
