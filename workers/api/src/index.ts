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
      // deployment needs, so `resolveOrgId` (inside `buildContext`, fresh
      // every request — never cached) resolving to "" means there is nowhere
      // for any other route to scope its reads or writes. Send everything but
      // the setup screen itself there, rather than letting every surface fail
      // as "not found", which is the production defect this fixes.
      if (!ctx.orgId && url.pathname !== "/setup") {
        if (wantsJson(req)) {
          return withSecurityHeaders(
            req,
            json(
              { error: "not_configured", message: "This deployment has not been set up yet. Visit /setup to create the first organization." },
              { status: 503 },
            ),
          );
        }
        return withSecurityHeaders(req, redirect("/setup", 303));
      }

      if (isMutating(req.method)) {
        const replay = await replayIfSeen(env, ctx.orgId, req);
        if (replay) return withSecurityHeaders(req, replay);
      }

      // R30's admin console. It answers before the router because it shares
      // its URLs with the server-rendered screens it is replacing: the console
      // takes the request, and `?nojs=1` — or a person without the capability,
      // or an event that does not exist — declines it and falls through to the
      // page that has always answered.
      const consoleRes = await consoleDocument(req, ctx);
      if (consoleRes) return withSecurityHeaders(req, consoleRes);

      const match = router.match(req.method, url.pathname);
      if (!match) return withSecurityHeaders(req, notFound(req, ctx));

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

      if (isMutating(req.method)) res = await remember(env, ctx.orgId, req, res);
      return withSecurityHeaders(req, res);
    } catch (err) {
      // The error paths need the headers too — an error page is still a page,
      // and `errorResponse` is what an injected payload would most like to
      // reach unhardened.
      if (err instanceof DomainError && !wantsJson(req)) {
        return withSecurityHeaders(req, recoverableRedirect(req, err) ?? errorPage(err));
      }
      return withSecurityHeaders(req, errorResponse(err));
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env, execCtx: ExecutionContext): Promise<void> {
    await runQueueBatch(batch, env, execCtx);
  },

  async scheduled(event: ScheduledController, env: Env, execCtx: ExecutionContext): Promise<void> {
    execCtx.waitUntil(runScheduled(env, event.scheduledTime));
  },
};

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
        <p><a href="javascript:history.back()">Go back</a> · <a href="/">Home</a>${err.status === 401 ? html` · <a href="/login">Sign in</a>` : html``}</p>
      </div>`,
    ),
    { status: err.status },
  );
}
