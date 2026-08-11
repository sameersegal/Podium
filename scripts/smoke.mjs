#!/usr/bin/env node
/**
 * Walk the app as each persona and report the status of every screen.
 *
 * This is the cheapest possible answer to "does the thing actually work" — a
 * unit test cannot tell you that a nav link points at a route nobody wrote.
 *
 * Usage:  node scripts/smoke.mjs [--base http://localhost:8787] [--verbose]
 */

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:8787";
const verbose = args.includes("--verbose");

const PERSONAS = {
  anonymous: null,
  organizer: { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" },
  speaker: { email: "sbek-speaker@example.com", password: "SbekTest!2027-spk" },
  reviewer: { email: "sbek-reviewer@example.com", password: "SbekTest!2027-rev" },
};

async function signIn(creds) {
  if (!creds) return null;
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: creds.email, password: creds.password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`sign-in failed for ${creds.email} (${res.status})`);
  return cookie.split(";")[0];
}

async function ids(cookie) {
  const res = await fetch(`${base}/dev/ids`, { headers: cookie ? { cookie } : {} });
  if (!res.ok) return {};
  return res.json();
}

async function check(path, cookie) {
  try {
    const res = await fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: "manual" });
    return { path, status: res.status, location: res.headers.get("location") };
  } catch (err) {
    return { path, status: 0, error: String(err) };
  }
}

const PUBLIC_PATHS = (ctx) => [
  "/",
  `/e/${ctx.event_slug}`,
  `/e/${ctx.event_slug}/cfp/main`,
  `/e/${ctx.event_slug}/schedule`,
  `/e/${ctx.event_slug}/speakers`,
  `/e/${ctx.event_slug}/schedule.ics`,
  "/login",
  "/signup",
  "/app.css",
  // `/live/*` is worker-first so the WebSocket upgrade is never answered by
  // the asset router; `/live.js` deliberately is not, so it serves from the
  // edge. A slip that widened that prefix to `/live*` would swallow the
  // script, and nothing but a real server can show it.
  "/live.js",
];

const ORGANIZER_PATHS = (ctx) => [
  "/admin",
  "/admin/events",
  `/admin/events/${ctx.event_id}`,
  `/admin/events/${ctx.event_id}/setup`,
  `/admin/events/${ctx.event_id}/cfps`,
  `/admin/cfps/${ctx.cfp_id}`,
  `/admin/cfps/${ctx.cfp_id}/form`,
  `/admin/events/${ctx.event_id}/proposals`,
  `/admin/proposals/${ctx.proposal_id}`,
  `/admin/events/${ctx.event_id}/review`,
  `/admin/events/${ctx.event_id}/decisions`,
  `/admin/events/${ctx.event_id}/sessions`,
  `/admin/sessions/${ctx.session_id}`,
  `/admin/events/${ctx.event_id}/roster`,
  `/admin/events/${ctx.event_id}/tasks`,
  `/admin/events/${ctx.event_id}/onboarding`,
  `/admin/events/${ctx.event_id}/files`,
  `/admin/events/${ctx.event_id}/schedule`,
  `/admin/events/${ctx.event_id}/publications`,
  `/admin/events/${ctx.event_id}/embeds`,
  `/admin/events/${ctx.event_id}/sponsorships`,
  `/admin/events/${ctx.event_id}/tiers`,
  `/admin/events/${ctx.event_id}/campaigns`,
  "/admin/sponsors",
  "/admin/contacts",
  "/admin/contacts/dashboard",
  "/admin/segments",
  "/admin/pipelines",
  "/admin/team",
  "/admin/settings",
  "/admin/api-keys",
  "/admin/webhooks",
  "/admin/templates",
  "/admin/outbox",
  "/admin/custom-fields",
  "/admin/imports",
  "/admin/exports",
  "/admin/audit",
  "/admin/event-log",
  "/portal",
];

const SPEAKER_PATHS = () => ["/portal", "/portal/proposals", "/portal/sessions", "/portal/tasks", "/portal/profile"];
const REVIEWER_PATHS = () => ["/review", "/portal"];

const results = [];
let failures = 0;

const organizerCookie = await signIn(PERSONAS.organizer);
const ctx = await ids(organizerCookie);
if (!ctx.event_id) {
  console.error("could not read /dev/ids — is the dev server running and seeded?");
  process.exit(1);
}

for (const [persona, paths] of [
  ["anonymous", PUBLIC_PATHS(ctx)],
  ["organizer", ORGANIZER_PATHS(ctx)],
  ["speaker", SPEAKER_PATHS(ctx)],
  ["reviewer", REVIEWER_PATHS(ctx)],
]) {
  const cookie = persona === "anonymous" ? null : await signIn(PERSONAS[persona]);
  for (const path of paths) {
    const r = await check(path, cookie);
    const ok = r.status >= 200 && r.status < 400;
    if (!ok) failures++;
    results.push({ persona, ...r, ok });
    if (verbose || !ok) {
      console.log(`${ok ? "  ok" : "FAIL"}  ${persona.padEnd(10)} ${String(r.status).padEnd(4)} ${path}${r.location ? ` → ${r.location}` : ""}`);
    }
  }
}

const byPersona = {};
for (const r of results) {
  byPersona[r.persona] ??= { ok: 0, total: 0 };
  byPersona[r.persona].total++;
  if (r.ok) byPersona[r.persona].ok++;
}
console.log("\nsummary");
for (const [persona, s] of Object.entries(byPersona)) {
  console.log(`  ${persona.padEnd(10)} ${s.ok}/${s.total}`);
}
process.exit(failures > 0 ? 1 : 0);
