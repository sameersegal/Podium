/**
 * Podium — the Worker entry.
 *
 * `fetch`     the four API surfaces (09-api-and-integrations.md) plus the
 *             server-rendered admin, portal and public UIs.
 * `queue`     domain event consumers — the reaction map in 10-domain-events.md.
 *             Every reaction is idempotent on `DomainEvent.id`.
 * `scheduled` Cron Triggers that produce Queue messages: reminders, draft
 *             abandonment, confirmation-deadline expiry, `delivered`.
 */

import { str, type Row } from "@podiumstack/data/db.js";
import type { Env } from "@podiumstack/data/context.js";
import { DomainError } from "@podiumstack/domain/shared/errors.js";
import { STALE_WRITE_MESSAGE } from "./http/concurrency.js";
import { buildContext, FLASH_COOKIE, clearCookie, flashCookie, type RequestContext } from "./http/context.js";
import { withSecurityHeaders } from "./http/headers.js";
import { isMutating, remember, replayIfSeen } from "./http/idempotency.js";
import { errorResponse, htmlResponse, json, redirect, wantsJson } from "./http/responses.js";
import { Router } from "./http/router.js";
import { registerRoutes } from "./routes.js";
import { consoleDocument } from "./surfaces/console.js";
import { runQueueBatch } from "./consumers/dispatch.js";
import { runScheduled } from "./consumers/cron.js";
import { page } from "./ui/layout.js";
import { loadRailCounts } from "./ui/rail-counts.js";
import { toEventRef } from "./ui/shell.js";
import { escapeHtml, html, raw } from "./ui/html.js";

export { ScheduleDurableObject } from "./durable/schedule.js";
export { RoomDurableObject } from "./durable/room.js";

const router = new Router<RequestContext>();
registerRoutes(router);

export default {
  async fetch(req: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      const ctx = await buildContext(req, env, (p) => execCtx.waitUntil(p));

      // 01, "First-run setup": nothing seeds the one Organization a
      // deployment needs, so `resolveOrg` (inside `buildContext`, fresh
      // every request — never cached) resolving to "" means there is nowhere
      // for any other route to scope its reads or writes. Send everything but
      // the setup screen itself there, rather than letting every surface fail
      // as "not found", which is the production defect this fixes.
      if (!ctx.orgId && url.pathname !== "/setup") {
        if (wantsJson(req)) {
          return await withSecurityHeaders(
            req,
            json(
              { error: "not_configured", message: "This deployment has not been set up yet. Visit /setup to create the first organization." },
              { status: 503 },
            ),
          );
        }
        return await withSecurityHeaders(req, redirect("/setup", 303));
      }

      if (isMutating(req.method)) {
        const replay = await replayIfSeen(env, req);
        if (replay) return await withSecurityHeaders(req, replay);
      }

      // R30's admin console. It answers before the router because it shares
      // its URLs with the server-rendered screens it is replacing: the console
      // takes the request, and `?nojs=1` — or a person without the capability,
      // or an event that does not exist — declines it and falls through to the
      // page that has always answered.
      const consoleRes = await consoleDocument(req, ctx);
      if (consoleRes) return await withSecurityHeaders(req, withQueryCount(consoleRes, ctx));

      // The console rail's counts, for the server-rendered admin screens that
      // fall through to here. One query, and only for a signed-in person asking
      // for an admin page — see `ui/rail-counts.ts` for why it is loaded in this
      // seam rather than by the shell that draws it. The console SPA does not
      // reach this line: it returned above with its own dashboard payload.
      await attachRailCounts(req, ctx, url);

      const match = router.match(req.method, url.pathname);
      if (!match) return await withSecurityHeaders(req, withQueryCount(notFound(req, ctx), ctx));

      let res = await match.handler(req, ctx, match.params);

      // A 101 carries its socket on the response object, not in the body.
      // `new Response(res.body, res)` below drops `webSocket` silently — no
      // throw, no log, just a handshake the browser waits on forever. Nothing
      // downstream applies to an upgrade anyway: there is no flash to clear on
      // a connection that renders nothing, and `remember` only sees mutating
      // methods, which an upgrade GET is not.
      if (res.status === 101) return res;

      // A flash survives exactly one render.
      if (ctx.flash && !res.headers.has("set-cookie")) {
        res = new Response(res.body, res);
        res.headers.append("set-cookie", clearCookie(FLASH_COOKIE));
      }

      if (isMutating(req.method)) res = await remember(env, req, res);
      return await withSecurityHeaders(req, withQueryCount(res, ctx));
    } catch (err) {
      // The error paths need the headers too — an error page is still a page,
      // and `errorResponse` is what an injected payload would most like to
      // reach unhardened.
      if (err instanceof DomainError && !wantsJson(req)) {
        return await withSecurityHeaders(req, recoverableRedirect(req, err) ?? errorPage(err));
      }
      return await withSecurityHeaders(req, errorResponse(err));
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env, execCtx: ExecutionContext): Promise<void> {
    await runQueueBatch(batch, env, execCtx);
  },

  async scheduled(event: ScheduledController, env: Env, execCtx: ExecutionContext): Promise<void> {
    execCtx.waitUntil(runScheduled(env, event.scheduledTime));
  },
};

/**
 * `x-podium-d1-queries`, outside production.
 *
 * The performance contract is "single digits per request; an N+1 is a defect,
 * not a slow path" (`implementer.md`, G). A budget nobody can read is a budget
 * nobody keeps, so the number the request actually spent is on the response
 * where a browser, `curl` and the test harness can all see it.
 *
 * Not in production: it is a number about the shape of our code, and telling
 * every caller how many statements their request cost is a detail they cannot
 * act on and an attacker can. It is skipped on a 101 for the same reason
 * nothing else touches one — an upgrade carries its socket on the response.
 */
function withQueryCount(res: Response, ctx: RequestContext): Response {
  if (str(ctx.env.ENVIRONMENT) === "production") return res;
  const out = new Response(res.body, res);
  out.headers.set("x-podium-d1-queries", String(ctx.queries.count));
  return out;
}

/**
 * Works out which event the rail is counting, and counts it.
 *
 * Deliberately cheap to decline: anything that is not a signed-in person asking
 * for an HTML admin page returns before touching the database. A failure here
 * is swallowed, because a rail that cannot count is a rail without numbers and
 * that is not a reason to fail the page the numbers sit beside.
 */
async function attachRailCounts(req: Request, ctx: RequestContext, url: URL): Promise<void> {
  if (req.method !== "GET" || !ctx.person) return;
  if (!url.pathname.startsWith("/admin")) return;
  const accept = req.headers.get("accept") ?? "";
  if (accept && !accept.includes("text/html") && accept !== "*/*") return;

  const parts = url.pathname.split("/").filter(Boolean);
  let eventId: string | null = parts[1] === "events" && parts[2]?.startsWith("evt_") ? parts[2] : null;
  try {
    const app = ctx.app();
    // Every event the switcher offers, newest first, and the one in context.
    // One query answers both: the rail needs a list to switch between and a
    // row to draw, and reading them separately would ask the same table twice.
    const rows = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC", limit: 50 });
    ctx.railEvents = rows.map(toEventRef);
    // `/admin` and the organization-wide screens — settings included — open on
    // the same event the landing page does, the most recent one, so the rail
    // does not empty itself the moment you step out of an event.
    ctx.railEvent = (eventId ? ctx.railEvents.find((e) => e.id === eventId) : ctx.railEvents[0]) ?? null;
    eventId = ctx.railEvent?.id ?? null;
    if (!eventId) return;
    if (!ctx.isStaff({ event_id: eventId })) return;
    ctx.rail = await loadRailCounts(app, eventId, ctx.now);
  } catch {
    /* a rail without numbers is still a rail */
  }
}

function notFound(req: Request, ctx: RequestContext): Response {
  if (wantsJson(req)) return json({ error: "not_found", message: "No such endpoint." }, { status: 404 });
  return htmlResponse(
    page(
      { title: "Not found", surface: "public", who: ctx.person?.full_name ?? null, width: "narrow" },
      html`<div class="card">
        <h1>Page not found</h1>
        <p class="lede">That page does not exist. Try the <a href="/">home page</a>${ctx.person ? html`, your <a href="/portal">portal</a>, or the <a href="/admin">admin dashboard</a>` : html``}.</p>
      </div>`,
    ),
    { status: 404 },
  );
}

/**
 * A rule refusing a form post is not a crash, and answering it with a
 * full-page "That did not work" throws away the form the person was filling
 * in — every other field, and the place they were standing. So a recoverable
 * refusal of an HTML POST goes back where it came from carrying the message as
 * a flash, which is how every successful post already reports itself.
 *
 * Deliberately narrow: only same-origin form posts with a `Referer`, and never
 * for auth (401/403 must not bounce someone round a loop), a version conflict
 * (which has its own reconciliation page) or a 5xx.
 */
function recoverableRedirect(req: Request, err: DomainError): Response | null {
  if (!isMutating(req.method)) return null;
  if (err.status >= 500 || err.status === 401 || err.status === 403 || err.code === "version_conflict") return null;
  const referer = req.headers.get("referer");
  if (!referer) return null;
  let back: URL;
  try {
    back = new URL(referer);
  } catch {
    return null;
  }
  if (back.origin !== new URL(req.url).origin) return null;
  const detail = err.fieldErrors?.length ? ` ${err.fieldErrors.map((f) => f.message).join(" ")}` : "";
  return redirect(back.pathname + back.search, 303, { "set-cookie": flashCookie("err", `${err.message}${detail}`) });
}

function errorPage(err: DomainError): Response {
  return htmlResponse(
    page(
      { title: "Something went wrong", surface: "public", width: "narrow" },
      // The invariant stays on the element, not in the copy: a reader who has never seen
      // `docs/domain/` gains nothing from "INV-05-9", and a bug report can still recover it
      // from the markup. The JSON surface keeps carrying it as a documented field.
      html`<div class="card"${err.invariant ? raw(` data-rule="${escapeHtml(err.invariant)}"`) : raw("")}>
        <h1>${err.code === "version_conflict" ? "Someone else changed this" : err.status === 403 ? "Not permitted" : err.status === 401 ? "Sign in required" : "That did not work"}</h1>
        <p class="flash err">${err.code === "version_conflict" ? STALE_WRITE_MESSAGE : err.message}</p>
        ${err.fieldErrors?.length
          ? html`<ul>${err.fieldErrors.map((f) => html`<li><strong>${f.field_key}</strong>: ${f.message}</li>`)}</ul>`
          : html``}
        <p><a href="/" data-back>Go back</a> · <a href="/">Home</a>${err.status === 401 ? html` · <a href="/login">Sign in</a>` : html``}</p>
      </div>`,
    ),
    { status: err.status },
  );
}
