#!/usr/bin/env node
/**
 * Regenerate the endpoint catalogue the `podium-api` skill ships.
 *
 * A hand-written API reference for 190 endpoints is a document that is wrong
 * within a month, and an agent that trusts a wrong reference spends its turn
 * on a 404. So the catalogue is derived from the routes themselves: the path,
 * the capability the handler demands, the API scopes that capability maps to,
 * the query parameters it reads and the body fields it accepts.
 *
 * This runs inside the repository only — the plugin ships the generated file.
 *
 *   node claude-plugin/scripts/build-endpoints.mjs           # write
 *   node claude-plugin/scripts/build-endpoints.mjs --check   # exit 1 if stale
 *
 * `--check` is the CI gate, in the same spirit as `npm run drift`: a route
 * added without regenerating the catalogue is drift between the product and
 * the thing we told agents about the product.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const REPO = join(import.meta.dirname, "..", "..");
const ROUTES_DIR = join(REPO, "workers", "api", "src");
const OUT = join(REPO, "claude-plugin", "skills", "podium-api", "reference", "endpoints.md");

/* -------------------------------------------------------------------------- */

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** capability -> {read: [scope], write: [scope]}, read out of the auth layer. */
function capabilityScopes() {
  const source = readFileSync(join(ROUTES_DIR, "http", "context.ts"), "utf8");
  const block = source.slice(source.indexOf("const CAPABILITY_SCOPES"), source.indexOf("function hasScopeFor"));
  const map = {};
  const re = /"([\w.]+)":\s*\{\s*read:\s*\[([^\]]*)\],\s*write:\s*\[([^\]]*)\]\s*\}/g;
  let m;
  while ((m = re.exec(block))) {
    const list = (s) => s.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    map[m[1]] = { read: list(m[2]), write: list(m[3]) };
  }
  return map;
}

/**
 * Split a routes file into one slice per registration. Brace-matching would
 * have to understand template literals full of HTML, so instead each handler
 * runs from its own `router.<method>(` to the next one — which is exactly the
 * text that belongs to it.
 */
function handlerSlices(source) {
  const re = /router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g;
  const hits = [];
  let m;
  while ((m = re.exec(source))) hits.push({ method: m[1].toUpperCase(), path: m[2], start: m.index });
  return hits.map((hit, i) => ({
    ...hit,
    line: source.slice(0, hit.start).split("\n").length,
    body: source.slice(hit.start, i + 1 < hits.length ? hits[i + 1].start : source.length),
  }));
}

const uniq = (xs) => [...new Set(xs)];

/**
 * Several handlers read their body through a shared helper —
 * `readOrganizerEditInput(input)` is the whole field list for
 * `PATCH /v1/proposals/:id`. Following one level of that call is the
 * difference between a catalogue that lists one field and one that lists
 * twenty. One level only: deeper and this becomes a type checker.
 */
function inlineHelpers(body, source, corpus) {
  const called = uniq([
    ...[...body.matchAll(/\b([a-z]\w+)\(\s*input\s*[,)]/g)].map((m) => m[1]),
    // Query parsing hides the same way: `queueFiltersFrom(ctx.url)` is where
    // `/v1/proposals` learns about `status`, `track_id`, `q` and `sort`.
    ...[...body.matchAll(/\b([a-z]\w+)\(\s*(?:ctx\.)?url\s*[,)]/g)].map((m) => m[1]),
  ]);
  let extra = "";
  for (const name of called) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    // Own file first, then any sibling module — `queueFiltersFrom` lives in
    // `admin-views.ts`, not in the routes file that calls it.
    for (const text of [source, ...corpus]) {
      const at = text.search(re);
      if (at < 0) continue;
      const rest = text.slice(at + 1);
      const stop = rest.search(/\n(?:export )?(?:function |const \w+ = |router\.)/);
      extra += rest.slice(0, stop < 0 ? rest.length : stop);
      break;
    }
  }
  return body + extra;
}

function extract(rawBody, source, corpus) {
  const body = inlineHelpers(rawBody, source, corpus);
  const grab = (re, group = 1) => {
    const out = [];
    let m;
    while ((m = re.exec(body))) out.push(m[group]);
    return uniq(out);
  };
  // A handler that loops a field list — `for (const f of ["title", …])
  // patch[f] = input.optional(f)` — names its fields in the array, not in the
  // call. Without this, `PATCH /v1/proposals/:id` documents one field instead
  // of twenty.
  const looped = [];
  for (const m of body.matchAll(/for \(const (\w+) of \[([\s\S]{0,1200}?)\]\)([\s\S]{0,400})/g)) {
    if (!new RegExp(`input\\.\\w+(?:<[^>]*>)?\\(\\s*${m[1]}\\b`).test(m[3])) continue;
    looped.push(...[...m[2].matchAll(/"([\w.-]+)"/g)].map((x) => x[1]));
  }

  // `queueFiltersFrom` reads its repeatable filters through a local alias —
  // `const multi = (name) => url.searchParams.getAll(name)` — so the parameter
  // names sit at the alias's call sites, not at `searchParams`.
  const aliased = [];
  for (const m of body.matchAll(/const (\w+) = \(\s*\w+[^)]*\)\s*(?::[^=]+)?=>[^;]*searchParams\.(?:get|getAll)\(/g)) {
    aliased.push(...[...body.matchAll(new RegExp(`\\b${m[1]}\\(\\s*"([\\w.-]+)"`, "g"))].map((x) => x[1]));
  }

  return {
    reads: grab(/ctx\.requireRead\(\s*"([\w.]+)"/g),
    writes: grab(/ctx\.requireWrite\(\s*"([\w.]+)"/g),
    query: uniq([...grab(/searchParams\.(?:get|getAll)\(\s*"([\w.-]+)"/g), ...aliased]),
    body: uniq([...grab(/input\.(?:str|optional|int|bool|list|json|get|has)(?:<[^>]*>)?\(\s*"([\w.-]+)"/g), ...looped]),
    pii: /includePii|redact/.test(body),
    idempotent: /replayIfSeen|remember/.test(body),
  };
}

/**
 * Group by the URL's *last* literal segment, not its first: the endpoint that
 * places a session is `POST /v1/events/:eventId/placements`, and filing it
 * under "events" puts it where nobody looking for scheduling will find it.
 */
function areaOf(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "v1" && parts[1] === "public") return "public";
  const literals = parts.slice(1).filter((p) => !p.startsWith(":"));
  const AREAS = {
    events: "events & configuration", days: "events & configuration", rooms: "events & configuration",
    tracks: "events & configuration", formats: "events & configuration", venues: "events & configuration",
    "custom-fields": "events & configuration", fields: "cfp forms", forms: "cfp forms", steps: "cfp forms",
    cfps: "cfp forms",
    proposals: "proposals", decisions: "review & decisions", reviews: "review & decisions",
    rounds: "review & decisions", assignments: "review & decisions",
    sessions: "programme", people: "people & roles", "role-grants": "people & roles",
    invitations: "people & roles", participants: "people & roles",
    placements: "scheduling", conflicts: "scheduling", "auto-place-runs": "scheduling",
    publications: "scheduling",
    tasks: "onboarding tasks", "task-definitions": "onboarding tasks",
    sponsors: "sponsorship", sponsorships: "sponsorship", entitlements: "sponsorship",
    prospects: "speaker CRM", segments: "speaker CRM", pipelines: "speaker CRM", campaigns: "speaker CRM",
    "api-keys": "platform", webhooks: "platform", integrations: "platform", notifications: "platform",
    sync: "platform", imports: "content", exports: "content", assets: "content",
    console: "console", me: "portal",
  };
  // Right to left, first segment that is a known noun. Right-to-left so
  // `/events/:id/placements` files under scheduling; "first known" so
  // `/api-keys/:id/revoke` is not filed under the verb.
  for (let i = literals.length - 1; i >= 0; i--) {
    if (AREAS[literals[i]]) return AREAS[literals[i]];
  }
  return "other";
}

/* -------------------------------------------------------------------------- */

const scopeMap = capabilityScopes();
const files = walk(ROUTES_DIR);
/** Every module, so a helper defined next door can still be followed. */
const corpus = files.map((f) => readFileSync(f, "utf8"));
const routes = [];
for (const [index, file] of files.entries()) {
  const source = corpus[index];
  if (!source.includes("router.")) continue;
  for (const slice of handlerSlices(source)) {
    if (!slice.path.startsWith("/v1/")) continue;
    const info = extract(slice.body, source, corpus);
    const caps = uniq([...info.reads, ...info.writes]);
    const scopes = uniq(
      caps.flatMap((c) => {
        const need = scopeMap[c];
        if (!need) return [];
        const writing = info.writes.includes(c);
        return writing ? need.write : need.read;
      }),
    );
    routes.push({
      method: slice.method,
      path: slice.path,
      file: relative(REPO, file),
      line: slice.line,
      capabilities: caps,
      scopes,
      query: info.query,
      fields: info.body,
      pii: info.pii,
      area: areaOf(slice.path),
    });
  }
}

routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const areas = uniq(routes.map((r) => r.area)).sort();
const cell = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(" ") : "—");

let out = `# Endpoint catalogue

Every endpoint on the management surface, generated from the routes themselves by
\`claude-plugin/scripts/build-endpoints.mjs\`. Do not edit by hand — regenerate.

${routes.length} endpoints. Columns:

- **Scope** — the API-key scope that reaches it. Blank means the handler's capability is not
  scope-mapped, so any authenticated key passes the scope check (it still passes the role
  check: a key with no \`:write\` scope authenticates as a viewer).
- **Query** — query-string parameters the handler reads. Every list endpoint also takes
  \`limit\` and \`cursor\`.
- **Body** — fields the handler reads from a JSON body. Presence here is not proof a field is
  required, optional, or even accepted: a handler may read one only to refuse it, as
  \`PATCH /v1/entitlements/:id\` does with \`consumed_count\`. The 422 will tell you, and it
  names the invariant.
- A \`·\` in the PII column means the response is redacted unless the key holds \`pii:read\`.

Paths shown with \`:name\` take an id in that position.

`;

for (const area of areas) {
  const inArea = routes.filter((r) => r.area === area);
  out += `## ${area}\n\n| Endpoint | Scope | Query | Body | PII | Source |\n|---|---|---|---|---|---|\n`;
  for (const r of inArea) {
    out += `| \`${r.method} ${r.path}\` | ${cell(r.scopes)} | ${cell(r.query.filter((q) => q !== "limit" && q !== "cursor"))} | ${cell(r.fields)} | ${r.pii ? "·" : ""} | ${r.file}:${r.line} |\n`;
  }
  out += "\n";
}

const rendered = out;
const check = process.argv.includes("--check");
let current = "";
try {
  current = readFileSync(OUT, "utf8");
} catch {
  /* first run */
}

if (check) {
  if (current !== rendered) {
    process.stderr.write(
      "endpoints.md is stale — routes changed without regenerating the agent-facing catalogue.\n" +
        "Run: node claude-plugin/scripts/build-endpoints.mjs\n",
    );
    process.exit(1);
  }
  process.stdout.write(`endpoints.md is current (${routes.length} endpoints).\n`);
  process.exit(0);
}

writeFileSync(OUT, rendered);
process.stdout.write(`Wrote ${relative(REPO, OUT)} — ${routes.length} endpoints across ${areas.length} areas.\n`);
