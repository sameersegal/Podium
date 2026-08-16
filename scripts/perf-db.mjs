#!/usr/bin/env node
/**
 * Profile the D1 cost of every action, against a running seeded instance.
 *
 * `implementer.md`, G sets the contract: "D1 queries per request — single
 * digits; an N+1 is a defect, not a slow path". Two things already exist to
 * hold it — the `x-podium-d1-queries` header on every non-production response,
 * and `tests/integration/foundation/query-budget.test.ts`, which pins a dozen
 * screens to a ceiling. Neither answers the question this script exists for:
 * *across the whole product*, which actions are expensive, and what did they
 * spend it on.
 *
 * So this walks every route in the app — the inventory comes from the same
 * `attack_surface.py` the security skill uses, not a hand-written list, so a
 * route added without being profiled is impossible — as each persona, asking
 * for `x-podium-profile: 1`, and then drains `/dev/profile` for the statement
 * text behind each count.
 *
 * The report separates three things a single number cannot:
 *
 *   baseline   what `buildContext` spends before any route runs. Every
 *              authenticated request pays it, so it is the floor, and a
 *              screen's real cost is its total minus this.
 *   repeats    the same statement text prepared more than once in one request.
 *              This is the N+1 detector: identical parameterised SQL run k
 *              times is a loop over rows, whatever the code looks like.
 *   tables     which tables the budget went to, so "expensive" becomes
 *              "expensive because it reads `person` forty times".
 *
 * And because a report is a snapshot while a *loop* needs a difference, it
 * keeps a baseline: `--update-baseline` accepts the current numbers,
 * `--check` compares against them and exits non-zero on a regression. That is
 * what makes "measure, fix, repeat" a thing a schedule can run rather than a
 * thing someone has to remember what the numbers used to be.
 *
 * Usage:
 *   node scripts/perf-db.mjs [--base http://127.0.0.1:8787] [--json out.json]
 *                            [--only <substring>] [--top 40] [--mutations]
 *                            [--check] [--update-baseline] [--quiet]
 *
 * `--mutations` additionally profiles a curated set of write actions. It is
 * off by default because a POST that succeeds changes what every later GET
 * costs, so a mutation pass wants a freshly seeded instance to be comparable —
 * and for the same reason it is excluded from the baseline.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                    */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = flag("base", process.env.PODIUM_BASE ?? "http://127.0.0.1:8787");
const ONLY = flag("only", null);
const TOP = Number(flag("top", "40"));
const JSON_OUT = flag("json", null);
const WITH_MUTATIONS = argv.includes("--mutations");
const QUIET = argv.includes("--quiet");
/** Compare against the accepted baseline and exit non-zero on a regression. */
const CHECK = argv.includes("--check");
/** Accept the current numbers as the new baseline. */
const UPDATE_BASELINE = argv.includes("--update-baseline");

/**
 * Where the accepted numbers live.
 *
 * In the skill's directory rather than beside this script, for the same reason
 * `security-audit/baseline.json` is: the numbers are the *skill's* record of
 * what has been reviewed and accepted, and reviewing them is the part a person
 * does. The script only measures.
 */
const BASELINE_PATH = ".claude/skills/db-performance/baseline.json";

/**
 * How much a route may grow before `--check` calls it a regression.
 *
 * Absolute *and* relative, because neither alone is right: +2 on a 4-statement
 * public page is a 50% regression worth catching, and +2 on a 37-statement
 * dashboard is noise. A route has to exceed both to fail.
 */
const TOLERANCE_ABSOLUTE = 2;
const TOLERANCE_RELATIVE = 0.15;

const PERSONAS = {
  anonymous: null,
  organizer: { email: "organizer@devflowconf.example", password: "PodiumDemo2027!" },
  speaker: { email: "speaker@devflowconf.example", password: "PodiumDemo2027!" },
  reviewer: { email: "reviewer@devflowconf.example", password: "PodiumDemo2027!" },
};

/* -------------------------------------------------------------------------- */
/* The route inventory                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every route, from the security skill's inventory rather than a list kept
 * here. Two lists of routes drift; one does not.
 */
function allRoutes() {
  const raw = execFileSync("python3", [".claude/skills/security-audit/scripts/attack_surface.py", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const doc = JSON.parse(raw);
  const inventory = doc.checks.find((c) => c.name === "route-inventory");
  const seen = new Set();
  const out = [];
  for (const f of inventory.findings) {
    const [method, pattern] = f.label.split(" ");
    if (!pattern) continue;
    if (seen.has(f.label)) continue;
    seen.add(f.label);
    out.push({ method, pattern, file: f.file, guard: f.detail });
  }
  return out;
}

/**
 * Which table a `:someId` names. Anything not listed is filled from the seeded
 * ids in `/dev/ids`, and a route whose parameter cannot be filled is reported
 * as skipped rather than silently dropped — an unprofiled route should be
 * visible.
 */
const PARAM_TABLE = {
  eventId: "event",
  cfpId: "call_for_proposals",
  proposalId: "proposal",
  sessionId: "session",
  roundId: "review_round",
  personId: "person",
  sponsorId: "sponsor",
  taskId: "task_instance",
  assetId: "asset",
  defId: "task_definition",
  assignmentId: "review_assignment",
  cardId: "prospect_card",
  formId: "submission_form",
  mappingId: "sync_mapping",
  segmentId: "contact_segment",
  pipelineId: "sourcing_pipeline",
  dayId: "event_day",
  trackId: "track",
  formatId: "session_format",
  roomId: "room",
  fieldId: "form_field",
  stepId: "form_step",
  participantId: "event_participant",
  entitlementId: "entitlement",
  grantId: "role_grant",
  deliveryId: "notification_delivery",
  linkId: "external_record_link",
  rubricId: "rubric",
  reviewId: "review",
  placementId: "placement",
  runId: "sync_run",
  publicationId: "schedule_publication",
  embedId: "embed_config",
  commentId: "review_comment",
  invitationId: "invitation",
  revisionId: "proposal_revision",
  memberId: "person",
  coiId: "conflict_of_interest",
  conflictId: "schedule_conflict",
  slotId: "time_slot",
  contactId: "sponsor_contact",
  tierId: "sponsorship_tier",
  templateId: "notification_template",
  otherId: "person",
  id: null, // Ambiguous by design — resolved per route from the file it lives in.
};

/** `:id` means whichever aggregate the route's own file is about. */
function tableForBareId(file) {
  if (file.includes("/identity/")) return "person";
  if (file.includes("/submissions/")) return "proposal";
  if (file.includes("/program/")) return "session";
  if (file.includes("/review/")) return "review_round";
  if (file.includes("/scheduling/")) return "session";
  if (file.includes("/sponsorship/")) return "sponsor";
  if (file.includes("/crm/")) return "person";
  if (file.includes("/content/")) return "asset";
  if (file.includes("/engagement/")) return "campaign";
  if (file.includes("/platform/")) return "webhook";
  return null;
}

function fillParams(route, fixtures, ids) {
  const missing = [];
  const path = route.pattern.replace(/:(\w+)/g, (_m, name) => {
    if (name === "eventSlug") return ids.event_slug ?? missing.push(name);
    if (name === "cfpSlug") return ids.cfp_slug ?? missing.push(name);
    if (name === "stepKey") return "basics";
    if (name === "key" || name === "token") {
      missing.push(name);
      return "-";
    }
    const table = name === "id" ? tableForBareId(route.file) : PARAM_TABLE[name];
    const value = table ? fixtures[table] : null;
    if (!value) {
      missing.push(name);
      return "-";
    }
    return value;
  });
  return { path, missing };
}

/* -------------------------------------------------------------------------- */
/* Driving the instance                                                         */
/* -------------------------------------------------------------------------- */

async function signIn(creds) {
  if (!creds) return null;
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: creds.email, password: creds.password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`sign-in failed for ${creds.email} (${res.status})`);
  return cookie.split(";")[0];
}

async function getJson(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {} });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/** One profiled request. The count comes from the header; the statements from the drain. */
async function hit(method, path, cookie, body) {
  const headers = { "x-podium-profile": "1" };
  if (cookie) headers.cookie = cookie;
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  try {
    const res = await fetch(BASE + path, { method, headers, body, redirect: "manual" });
    return {
      status: res.status,
      count: Number(res.headers.get("x-podium-d1-queries") ?? -1),
      roundTrips: Number(res.headers.get("x-podium-d1-roundtrips") ?? -1),
    };
  } catch (err) {
    return { status: 0, count: -1, error: String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                     */
/* -------------------------------------------------------------------------- */

/** `SELECT * FROM person WHERE org_id = ? AND …` → `person`. */
function tableOf(sql) {
  const m = /\b(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)/i.exec(sql);
  return m ? m[1].toLowerCase() : "?";
}

function operationOf(sql) {
  const head = sql.trimStart().slice(0, 6).toUpperCase();
  if (head.startsWith("SELECT")) return "select";
  if (head.startsWith("INSERT")) return "insert";
  if (head.startsWith("UPDATE")) return "update";
  if (head.startsWith("DELETE")) return "delete";
  return "other";
}

/**
 * The statements a request prepared more than once.
 *
 * Parameterised SQL run k times in one request is a loop over k rows —
 * `db.byId` inside a `.map`, most often. It is the single most reliable signal
 * in this whole report, because it does not depend on knowing what the screen
 * is supposed to cost.
 */
function repeatsIn(statements) {
  const counts = new Map();
  for (const sql of statements) counts.set(sql, (counts.get(sql) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([sql, n]) => ({ sql, n }))
    .sort((a, b) => b.n - a.n);
}

/**
 * The prefix every profiled request shares — `buildContext`'s work, which no
 * route asked for and every route pays. Derived rather than assumed: it is the
 * longest run of statements common to the front of every authenticated
 * request, so if `buildContext` changes, this number changes with it.
 */
function commonPrefix(lists) {
  if (!lists.length) return [];
  let prefix = lists[0];
  for (const list of lists.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < list.length && prefix[i] === list[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix.length) break;
  }
  return prefix;
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                     */
/* -------------------------------------------------------------------------- */

const log = (...a) => {
  if (!QUIET) console.log(...a);
};

const cookies = {};
for (const [name, creds] of Object.entries(PERSONAS)) cookies[name] = await signIn(creds);

const ids = await getJson("/dev/ids", cookies.organizer);
if (!ids.event_id) {
  console.error("could not read /dev/ids — is `npm run dev` running and seeded?");
  process.exit(1);
}

const routes = allRoutes().filter((r) => !r.pattern.startsWith("/dev/"));
const tables = [...new Set(Object.values(PARAM_TABLE).filter(Boolean).concat(["event", "person", "session", "proposal"]))];
const { fixtures } = await getJson(`/dev/fixtures?tables=${tables.join(",")}`, cookies.organizer);

/**
 * Who to walk each route as. A route is profiled as the *weakest* persona that
 * gets a 2xx out of it, because that is the request the product actually
 * serves: profiling `/portal` as an organizer measures a page nobody opens.
 */
const ORDER = ["anonymous", "speaker", "reviewer", "organizer"];

const skipped = [];
const results = [];

// Drain anything the sign-ins left behind, so the walk starts clean.
await getJson("/dev/profile", cookies.organizer);

const gets = routes.filter((r) => r.method === "GET");
log(`walking ${gets.length} GET routes as ${ORDER.length} personas…`);

for (const route of gets) {
  const { path, missing } = fillParams(route, fixtures, ids);
  if (missing.length) {
    skipped.push({ route: `${route.method} ${route.pattern}`, reason: `no fixture for :${missing.join(", :")}` });
    continue;
  }
  if (ONLY && !path.includes(ONLY) && !route.pattern.includes(ONLY)) continue;

  let best = null;
  for (const persona of ORDER) {
    const r = await hit("GET", path, cookies[persona]);
    if (r.status >= 200 && r.status < 300) {
      best = { persona, ...r };
      break;
    }
    if (!best || r.status > 0) best = { persona, ...r };
  }
  // Measure the *second* hit, not the first.
  //
  // Some screens read through a cache that D1 fills on a miss — the public
  // pages serve the publication snapshot from KV (INV-09-6) and fall back to
  // the database when it is cold. A first-run number therefore mixes "what
  // this screen costs" with "what this screen costs once, ever", and a
  // baseline recorded on a cold cache reports a phantom improvement on the
  // next run. The warm number is also the honest one: it is what the
  // hundredth visitor gets.
  if (best && best.status >= 200 && best.status < 300) {
    best = { persona: best.persona, ...(await hit("GET", path, cookies[best.persona])) };
  }
  results.push({ route: `GET ${route.pattern}`, path, file: route.file, ...best });
}

/**
 * A curated write pass. Not generated from the inventory: a POST needs a body
 * that its own validation accepts, and a generated one would measure the
 * 400 handler on 200 routes rather than the action.
 */
const MUTATIONS = [
  ["POST", `/admin/events/${ids.event_id}/tracks`, "name=Perf+probe&colour=%23336699"],
  ["POST", `/admin/proposals/${ids.proposal_id}/tags`, "tag=perf-probe"],
  ["POST", `/admin/sessions/${ids.session_id}`, "title=Perf+probe+title"],
  ["POST", `/admin/events/${ids.event_id}/publications`, "note=perf+probe"],
  ["POST", "/portal/profile", "bio=perf+probe"],
];

if (WITH_MUTATIONS) {
  log(`walking ${MUTATIONS.length} mutations…`);
  for (const [method, path, body] of MUTATIONS) {
    const r = await hit(method, path, cookies.organizer, body);
    results.push({ route: `${method} ${path}`, path, file: "(mutation)", persona: "organizer", ...r });
  }
}

const { records } = await getJson("/dev/profile", cookies.organizer);

/* -------------------------------------------------------------------------- */
/* Join the counts to the statements                                            */
/* -------------------------------------------------------------------------- */

const byPath = new Map();
for (const rec of records) {
  if (rec.path.startsWith("/dev/profile")) continue;
  // The last profile for a path wins: the walk hits a path once per persona
  // until one succeeds, and the successful one is the last.
  byPath.set(`${rec.method} ${rec.path}`, rec);
}

for (const r of results) {
  const rec = byPath.get(`GET ${r.path}`) ?? byPath.get(`${r.route.split(" ")[0]} ${r.path}`);
  r.statements = rec?.statements ?? [];
  r.ms = rec?.ms ?? null;
}

const authed = results.filter((r) => r.persona !== "anonymous" && r.statements.length);
const baseline = commonPrefix(authed.map((r) => r.statements));

/* -------------------------------------------------------------------------- */
/* Report                                                                       */
/* -------------------------------------------------------------------------- */

const ok = results.filter((r) => r.status >= 200 && r.status < 400 && r.count >= 0);
const sorted = [...ok].sort((a, b) => b.count - a.count);

console.log(`\n${"=".repeat(78)}`);
console.log("D1 COST PER ACTION");
console.log("=".repeat(78));
console.log(`  routes profiled     ${ok.length}`);
console.log(`  routes skipped      ${skipped.length} (no fixture for a path parameter)`);
if (ok.length) {
  const counts = ok.map((r) => r.count).sort((a, b) => a - b);
  const at = (q) => counts[Math.min(counts.length - 1, Math.floor(q * counts.length))];
  console.log(`  statements   min ${counts[0]}  median ${at(0.5)}  p90 ${at(0.9)}  max ${counts[counts.length - 1]}`);
  const trips = ok.map((r) => r.roundTrips).filter((n) => n >= 0).sort((a, b) => a - b);
  if (trips.length) {
    const t = (q) => trips[Math.min(trips.length - 1, Math.floor(q * trips.length))];
    console.log(`  round trips  min ${trips[0]}  median ${t(0.5)}  p90 ${t(0.9)}  max ${trips[trips.length - 1]}`);
  }
  console.log(`  total statements across the walk: ${counts.reduce((a, b) => a + b, 0)}`);
  console.log(`  total round trips across the walk: ${trips.reduce((a, b) => a + b, 0)}`);
}

console.log(`\n${"-".repeat(78)}`);
console.log(`REQUEST BASELINE — ${baseline.length} statements every authenticated request pays`);
console.log("-".repeat(78));
baseline.forEach((sql, i) => console.log(`  ${String(i + 1).padStart(2)}. ${sql.replace(/\s+/g, " ").slice(0, 110)}`));

console.log(`\n${"-".repeat(78)}`);
console.log(`TOP ${TOP} MOST EXPENSIVE ACTIONS`);
console.log("-".repeat(78));
// stmt: statements prepared · trip: calls to D1 (a batch is one) ·
// own: statements this route added beyond the shared baseline ·
// rpt: statements that were a repeat of one the same request already sent.
console.log(`  ${"stmt".padStart(4)}  ${"trip".padStart(4)}  ${"own".padStart(4)}  ${"rpt".padStart(4)}  ${"persona".padEnd(9)} route`);
for (const r of sorted.slice(0, TOP)) {
  const reps = repeatsIn(r.statements.slice(baseline.length));
  const repeated = reps.reduce((a, x) => a + x.n - 1, 0);
  console.log(
    `  ${String(r.count).padStart(4)}  ${String(r.roundTrips ?? -1).padStart(4)}  ${String(Math.max(0, r.count - baseline.length)).padStart(4)}  ${String(repeated).padStart(4)}  ${r.persona.padEnd(9)} ${r.route}`,
  );
}

console.log(`\n${"-".repeat(78)}`);
console.log("N+1 SUSPECTS — the same statement prepared k times in one request");
console.log("-".repeat(78));
const suspects = [];
for (const r of ok) {
  for (const rep of repeatsIn(r.statements.slice(baseline.length))) {
    if (rep.n < 3) continue;
    suspects.push({ route: r.route, n: rep.n, sql: rep.sql.replace(/\s+/g, " ") });
  }
}
suspects.sort((a, b) => b.n - a.n);
for (const s of suspects.slice(0, TOP)) {
  console.log(`  ${String(s.n).padStart(3)}×  ${s.route}`);
  console.log(`        ${s.sql.slice(0, 108)}`);
}
if (!suspects.length) console.log("  none — no statement text repeats three times in any one request.");

console.log(`\n${"-".repeat(78)}`);
console.log("WHERE THE BUDGET GOES — statements by table, across the whole walk");
console.log("-".repeat(78));
const byTable = new Map();
for (const r of ok) {
  for (const sql of r.statements) {
    const key = `${tableOf(sql)} (${operationOf(sql)})`;
    byTable.set(key, (byTable.get(key) ?? 0) + 1);
  }
}
for (const [key, n] of [...byTable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(5)}  ${key}`);
}

if (skipped.length && !QUIET) {
  console.log(`\n${"-".repeat(78)}`);
  console.log(`SKIPPED (${skipped.length})`);
  console.log("-".repeat(78));
  for (const s of skipped.slice(0, 30)) console.log(`  ${s.route.padEnd(58)} ${s.reason}`);
  if (skipped.length > 30) console.log(`  … and ${skipped.length - 30} more`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, baseline, results, skipped, suspects }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

/* -------------------------------------------------------------------------- */
/* The baseline — what makes this runnable in a loop                            */
/* -------------------------------------------------------------------------- */

/**
 * A report is a snapshot; a loop needs a *difference*.
 *
 * Absolute numbers say "this screen costs 37", which is only actionable if you
 * already know what it used to cost. The baseline records what was measured and
 * accepted, so a periodic run can answer the question a periodic run is for:
 * what got worse since someone last looked.
 */
function currentBaselineDoc() {
  const counts = ok.map((r) => r.count).sort((a, b) => a - b);
  const at = (q) => counts[Math.min(counts.length - 1, Math.floor(q * counts.length))];
  const routes = {};
  for (const r of ok) {
    const reps = repeatsIn(r.statements.slice(baseline.length));
    routes[r.route] = {
      statements: r.count,
      round_trips: r.roundTrips,
      persona: r.persona,
      // Recorded so a *new* loop is a finding even when the total barely moves:
      // three statements per row on a fixture with two rows costs six, and the
      // same code costs nine hundred on a real conference.
      repeated: reps.reduce((a, x) => a + x.n - 1, 0),
    };
  }
  return {
    note: "Accepted D1 cost per action. Regenerate with: npm run perf:db -- --update-baseline",
    request_baseline: baseline.length,
    totals: {
      routes: ok.length,
      statements: counts.reduce((a, b) => a + b, 0),
      median: at(0.5),
      p90: at(0.9),
      max: counts[counts.length - 1],
    },
    routes,
  };
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

if (UPDATE_BASELINE) {
  const doc = currentBaselineDoc();
  writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nbaseline written: ${Object.keys(doc.routes).length} routes, ${doc.totals.statements} statements, request baseline ${doc.request_baseline}`);
}

if (CHECK) {
  const prev = readBaseline();
  if (!prev) {
    console.error(`\nno baseline at ${BASELINE_PATH} — run with --update-baseline first.`);
    process.exit(2);
  }
  const now = currentBaselineDoc();
  const errors = [];
  const warnings = [];
  const wins = [];

  // The shared prefix is paid by every authenticated request in the product,
  // so it gets no tolerance at all: one more statement here is 162 more across
  // the walk, and it is never the screen's fault.
  if (now.request_baseline > prev.request_baseline) {
    errors.push(`request baseline ${prev.request_baseline} → ${now.request_baseline} — every authenticated request pays this`);
  }

  for (const [route, was] of Object.entries(prev.routes)) {
    const is = now.routes[route];
    if (!is) {
      warnings.push(`${route} — in the baseline but not profiled this run (route gone, or its fixture is)`);
      continue;
    }
    const grew = is.statements - was.statements;
    if (grew > TOLERANCE_ABSOLUTE && grew > was.statements * TOLERANCE_RELATIVE) {
      errors.push(`${route}  ${was.statements} → ${is.statements} statements (+${grew})`);
    } else if (grew > 0) {
      warnings.push(`${route}  ${was.statements} → ${is.statements} (+${grew}, within tolerance)`);
    } else if (grew < 0) {
      wins.push(`${route}  ${was.statements} → ${is.statements} (${grew})`);
    }
    // A loop that appears where there was none is a finding on its own: the
    // fixture may only have two rows today, and a real event has hundreds.
    if (is.repeated >= 3 && was.repeated < 3) {
      errors.push(`${route} — ${is.repeated} repeated statements, up from ${was.repeated}: a new N+1`);
    }
  }

  for (const route of Object.keys(now.routes)) {
    if (!prev.routes[route]) warnings.push(`${route} — new route, not yet in the baseline`);
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("CHECK AGAINST THE ACCEPTED BASELINE");
  console.log("=".repeat(78));
  console.log(`  request baseline  ${prev.request_baseline} → ${now.request_baseline}`);
  console.log(`  total statements  ${prev.totals.statements} → ${now.totals.statements}`);
  console.log(`  median · p90 · max  ${prev.totals.median}·${prev.totals.p90}·${prev.totals.max} → ${now.totals.median}·${now.totals.p90}·${now.totals.max}`);
  for (const e of errors) console.log(`  REGRESSION  ${e}`);
  for (const w of warnings) console.log(`  note        ${w}`);
  if (wins.length) console.log(`  ${wins.length} route(s) improved — accept with --update-baseline`);
  for (const w of wins.slice(0, 10)) console.log(`  better      ${w}`);

  if (errors.length) {
    console.log(`\n${errors.length} regression(s). Profile them above, fix, then re-run.`);
    process.exit(1);
  }
  console.log("\nno regressions.");
}
