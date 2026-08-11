/**
 * The admin console's server half — R30.
 *
 * Two jobs, and deliberately no third: serve the boot document for the screens
 * the console owns, and answer the reads that are the console's alone (the
 * bootstrap payload and the event dashboard). Everything else the console does
 * goes through the ordinary `/v1` management surface, which is the whole point
 * of porting onto an API that already exists.
 *
 * ## Which screens
 *
 * `CONSOLE_PATHS` is the list, and it is a subset on purpose: the console is
 * being ported screen by screen and every unported screen stays reachable at
 * its own URL, server-rendered, in the meantime. `public/console/app.js` holds
 * the same list on the client side and the two must agree — a path the server
 * boots and the client cannot match renders an empty shell.
 *
 * ## Why the server-rendered page is still reachable
 *
 * `?nojs=1` falls through to it. R30 puts the console on the far side of
 * INV-08-13 — the applicant side must render with scripts blocked, the console
 * need not — but "need not" is not "must not", and a console that has replaced
 * a working page with a blank one when a script fails to load has removed a
 * capability rather than added one. The `<noscript>` says so and links there.
 */

import { str, type Row } from "@podiumconf/data/db.js";
import type { Capability } from "@podiumconf/domain/shared/authorization.js";
import type { RequestContext } from "../http/context.js";
import { htmlResponse, json } from "../http/responses.js";
import type { Router } from "../http/router.js";
import { escapeHtml } from "../ui/html.js";
import { toEventRef, type EventRef } from "../ui/shell.js";
import { eventDashboard } from "./dashboard.js";

/**
 * Path patterns the console renders, in the same `:name` syntax the server
 * router uses. Each names the capability that gates it, so a person without it
 * gets the server-rendered page (which will refuse them properly) rather than a
 * console that boots and then 403s on its first fetch.
 */
const CONSOLE_PATHS: { segments: string[]; capability: Capability }[] = [
  // Organization-wide: no event in the path, so the shell flies no event bar.
  { segments: ["admin", "events"], capability: "config.manage" },
  { segments: ["admin", "events", ":eventId"], capability: "config.manage" },
  { segments: ["admin", "events", ":eventId", "schedule"], capability: "schedule.place" },
  { segments: ["admin", "events", ":eventId", "proposals"], capability: "proposal.read_any" },
  { segments: ["admin", "events", ":eventId", "setup"], capability: "config.manage" },
  { segments: ["admin", "events", ":eventId", "cfps"], capability: "cfp.configure" },
  { segments: ["admin", "events", ":eventId", "sessions"], capability: "session.manage" },
  { segments: ["admin", "events", ":eventId", "review"], capability: "review.read" },
  { segments: ["admin", "events", ":eventId", "roster"], capability: "session.manage" },
  { segments: ["admin", "events", ":eventId", "onboarding"], capability: "task.define" },
  { segments: ["admin", "events", ":eventId", "publications"], capability: "schedule.read_published" },
  { segments: ["admin", "cfps", ":cfpId", "form"], capability: "cfp.configure" },
];

interface ConsoleMatch {
  params: Record<string, string>;
  capability: Capability;
}

function matchConsolePath(pathname: string): ConsoleMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const route of CONSOLE_PATHS) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { params, capability: route.capability };
  }
  return null;
}

/**
 * The event the console should open in, and whether the path needs one.
 *
 * `/admin/events/:eventId` says it; `/admin/cfps/:cfpId/form` reaches it
 * through the call, because the event bar and the section nav are chrome the
 * screen should not have to fetch before it can be drawn. An organization-wide
 * path names no event and gets none — the shell then flies no event bar, which
 * is what `adminPage` does on the server for the same screens.
 */
async function eventForMatch(
  ctx: RequestContext,
  hit: ConsoleMatch,
): Promise<{ event: EventRef | null; missing: boolean }> {
  const app = ctx.app();
  if (hit.params.eventId) {
    const row = await app.db.byId<Row>("event", hit.params.eventId);
    return { event: row ? toEventRef(row) : null, missing: !row };
  }
  if (hit.params.cfpId) {
    const cfp = await app.db.byId<Row>("call_for_proposals", hit.params.cfpId);
    if (!cfp) return { event: null, missing: true };
    const row = await app.db.byId<Row>("event", str(cfp.event_id));
    return { event: row ? toEventRef(row) : null, missing: !row };
  }
  return { event: null, missing: false };
}

/**
 * The capabilities the console asks about before drawing a control. Held so a
 * read-only organizer is not shown buttons that will 403 — never so a write is
 * decided here. Permissions are recomputed per request on every `/v1` call,
 * which is what makes a long-lived client safe (R30).
 */
const BOOT_CAPABILITIES: Capability[] = [
  "event.configure",
  "cfp.configure",
  "proposal.read_any",
  "proposal.edit",
  "review.read",
  "decision.manage",
  "session.manage",
  "schedule.place",
  "schedule.publish",
  "task.define",
  "sponsor.manage",
];

async function bootPayload(ctx: RequestContext, ev: EventRef | null): Promise<Record<string, unknown>> {
  const app = ctx.app();
  const org = await app.db.byId<Row>("organization", ctx.orgId);
  const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC", limit: 50 });
  // Two maps, because several capabilities are read-only for some roles and a
  // single "can" would either hide a screen from someone allowed to look at it
  // or offer a button to someone who cannot press it. `canRead` decides whether
  // a section is shown, `canWrite` whether its controls are.
  const target = ev ? { event_id: ev.id } : undefined;
  const can: Record<string, boolean> = {};
  const canWrite: Record<string, boolean> = {};
  for (const capability of BOOT_CAPABILITIES) {
    can[capability] = ctx.canRead(capability, target);
    canWrite[capability] = ctx.canWrite(capability, target);
  }
  return {
    person: ctx.person
      ? { id: ctx.person.id, full_name: ctx.person.full_name, display_name: ctx.person.display_name }
      : null,
    org: org ? { id: str(org.id), name: str(org.name) } : null,
    event: ev,
    events: events.map((e) => {
      const ref = toEventRef(e);
      return { id: ref.id, name: ref.name, slug: ref.slug, status: ref.status };
    }),
    can,
    can_write: canWrite,
    now: ctx.now,
  };
}

/**
 * The boot document. Returns `null` when this request is not the console's, so
 * the caller falls through to the ordinary router and the server-rendered page
 * answers.
 */
export async function consoleDocument(req: Request, ctx: RequestContext): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.searchParams.has("nojs")) return null;
  if (!ctx.person) return null; // sign-in is server-rendered; so is the redirect to it
  const accept = req.headers.get("accept") ?? "";
  if (accept && !accept.includes("text/html") && accept !== "*/*") return null;

  const hit = matchConsolePath(url.pathname);
  if (!hit) return null;

  const { event: ev, missing } = await eventForMatch(ctx, hit);
  if (missing) return null; // no such event or call — let the server page 404 properly
  if (ev) ctx.eventId = ev.id;
  if (!ctx.canRead(hit.capability, ev ? { event_id: ev.id } : undefined)) return null;

  const boot = await bootPayload(ctx, ev);
  return htmlResponse(shell(ev, boot, url));
}

function shell(ev: EventRef | null, boot: Record<string, unknown>, url: URL): string {
  // `</script>` inside a JSON string would close this block early. The payload
  // is org data, not user-authored markup, but the escape costs one replace and
  // removes the question.
  const payload = JSON.stringify(boot).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(ev ? ev.name : "Admin")} · Podium</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="stylesheet" href="/app.css">
  <link rel="stylesheet" href="/console.css">
  <link rel="modulepreload" href="/console/app.js">
</head>
<body class="console">
  <div id="console"><div class="console-booting" role="status">Loading the console…</div></div>
  <script type="application/json" id="console-boot">${payload}</script>
  <script type="module" src="/console/app.js"></script>
  <noscript>
    <div class="card">
      <h1>The admin console needs JavaScript</h1>
      <p class="lede">This screen is the client-rendered console. The server-rendered version of it is still here.</p>
      <p><a href="${escapeHtml(url.pathname)}?nojs=1">Open the server-rendered page</a></p>
    </div>
  </noscript>
</body>
</html>`;
}

export function registerConsoleRoutes(router: Router<RequestContext>): void {
  /** Re-read the shell's payload without a reload — after switching event, or on a 401 recovery. */
  router.get("/v1/console/bootstrap", async (_req, ctx) => {
    ctx.requirePerson();
    const url = new URL(ctx.req.url);
    const eventId = url.searchParams.get("event");
    const row = eventId ? await ctx.app().db.byId<Row>("event", eventId) : null;
    const ev = row ? toEventRef(row) : null;
    if (ev) ctx.eventId = ev.id;
    return json({ data: await bootPayload(ctx, ev) });
  });

  router.get("/v1/events/:eventId/dashboard", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    ctx.eventId = params.eventId;
    return json({ data: await eventDashboard(ctx.app(params.eventId), params.eventId, ctx.now) });
  });
}
