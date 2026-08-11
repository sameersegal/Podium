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
  // 08, "Every type is also a page on the first-party site" — all five widget
  // types, reachable without an embed key.
  `/e/${ctx.event_slug}/schedule`,
  `/e/${ctx.event_slug}/sessions`,
  `/e/${ctx.event_slug}/speakers`,
  `/e/${ctx.event_slug}/gallery`,
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
  // Every create form and every row-level edit page. These are the screens a
  // list links to and nothing else does, so a walk that only opens lists would
  // not notice one of them 500ing.
  ...ADMIN_FORM_PATHS(ctx),
];

/**
 * The rule these all follow: a list's "Add …" button is a link to `…/new`, and
 * every editable row links to that entity's own page. Both are ordinary GETs,
 * so both belong in the walk.
 */
const ADMIN_FORM_PATHS = (ctx) =>
  [
    "/admin/events/new",
    `/admin/events/${ctx.event_id}/days/new`,
    ctx.day_id && `/admin/events/${ctx.event_id}/days/${ctx.day_id}`,
    `/admin/events/${ctx.event_id}/tracks/new`,
    ctx.track_id && `/admin/events/${ctx.event_id}/tracks/${ctx.track_id}`,
    `/admin/events/${ctx.event_id}/formats/new`,
    ctx.format_id && `/admin/events/${ctx.event_id}/formats/${ctx.format_id}`,
    `/admin/events/${ctx.event_id}/venue`,
    `/admin/events/${ctx.event_id}/rooms/new`,
    ctx.room_id && `/admin/events/${ctx.event_id}/rooms/${ctx.room_id}`,
    `/admin/events/${ctx.event_id}/cfps/new`,
    ctx.cfp_id && `/admin/cfps/${ctx.cfp_id}/form/steps/new`,
    ctx.cfp_id && ctx.form_step_id && `/admin/cfps/${ctx.cfp_id}/form/steps/${ctx.form_step_id}/fields/new`,
    ctx.cfp_id && ctx.form_field_id && `/admin/cfps/${ctx.cfp_id}/form/fields/${ctx.form_field_id}`,
    `/admin/events/${ctx.event_id}/sessions/new`,
    `/admin/events/${ctx.event_id}/roster/new`,
    `/admin/events/${ctx.event_id}/tasks/new`,
    `/admin/events/${ctx.event_id}/tasks/adhoc`,
    ctx.task_definition_id && `/admin/events/${ctx.event_id}/tasks/${ctx.task_definition_id}/reminder-rules/new`,
    `/admin/events/${ctx.event_id}/files/new`,
    `/admin/events/${ctx.event_id}/schedule/slots/new`,
    `/admin/events/${ctx.event_id}/embeds/new`,
    `/admin/events/${ctx.event_id}/review/rounds/new`,
    ctx.round_id && `/admin/rounds/${ctx.round_id}/pool/new`,
    `/admin/rubrics/new?event_id=${ctx.event_id}`,
    ctx.rubric_id && `/admin/rubrics/${ctx.rubric_id}`,
    `/admin/events/${ctx.event_id}/tiers/new`,
    ctx.tier_id && `/admin/events/${ctx.event_id}/tiers/${ctx.tier_id}`,
    ctx.tier_id && `/admin/events/${ctx.event_id}/tiers/${ctx.tier_id}/templates/new`,
    `/admin/events/${ctx.event_id}/sponsorships/new`,
    "/admin/sponsors/new",
    ctx.sponsor_id && `/admin/sponsors/${ctx.sponsor_id}/contacts/new`,
    `/admin/events/${ctx.event_id}/campaigns/new`,
    "/admin/segments/new",
    "/admin/pipelines/new",
    "/admin/team/grants/new",
    "/admin/team/invitations/new",
    "/admin/api-keys/new",
    "/admin/webhooks/new",
    "/admin/templates/new",
    "/admin/integrations/new",
    "/admin/custom-fields/new",
    "/admin/imports/new",
    "/admin/exports/new",
  ].filter(Boolean);

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
