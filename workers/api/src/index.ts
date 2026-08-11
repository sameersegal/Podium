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

import type { Env } from "@podiumconf/data/context.js";
import { DomainError } from "@podiumconf/domain/shared/errors.js";
import { buildContext, FLASH_COOKIE, clearCookie, type RequestContext } from "./http/context.js";
import { isMutating, remember, replayIfSeen } from "./http/idempotency.js";
import { errorResponse, htmlResponse, json, redirect, wantsJson } from "./http/responses.js";
import { Router } from "./http/router.js";
import { registerRoutes } from "./routes.js";
import { runQueueBatch } from "./consumers/dispatch.js";
import { runScheduled } from "./consumers/cron.js";
import { page } from "./ui/layout.js";
import { escapeHtml, html, raw } from "./ui/html.js";

export { ScheduleDurableObject } from "./durable/schedule.js";

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
          return json(
            { error: "not_configured", message: "This deployment has not been set up yet. Visit /setup to create the first organization." },
            { status: 503 },
          );
        }
        return redirect("/setup", 303);
      }

      if (isMutating(req.method)) {
        const replay = await replayIfSeen(env, ctx.orgId, req);
        if (replay) return replay;
      }

      const match = router.match(req.method, url.pathname);
      if (!match) return notFound(req, ctx);

      let res = await match.handler(req, ctx, match.params);

      // A flash survives exactly one render.
      if (ctx.flash && !res.headers.has("set-cookie")) {
        res = new Response(res.body, res);
        res.headers.append("set-cookie", clearCookie(FLASH_COOKIE));
      }

      if (isMutating(req.method)) res = await remember(env, ctx.orgId, req, res);
      return res;
    } catch (err) {
      if (err instanceof DomainError && !wantsJson(req)) return errorPage(err);
      return errorResponse(err);
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

function errorPage(err: DomainError): Response {
  return htmlResponse(
    page(
      { title: "Something went wrong", surface: "public", width: "narrow" },
      // The invariant stays on the element, not in the copy: a reader who has never seen
      // `docs/domain/` gains nothing from "INV-05-9", and a bug report can still recover it
      // from the markup. The JSON surface keeps carrying it as a documented field.
      html`<div class="card"${err.invariant ? raw(` data-rule="${escapeHtml(err.invariant)}"`) : raw("")}>
        <h1>${err.status === 403 ? "Not permitted" : err.status === 401 ? "Sign in required" : "That did not work"}</h1>
        <p class="flash err">${err.message}</p>
        ${err.fieldErrors?.length
          ? html`<ul>${err.fieldErrors.map((f) => html`<li><strong>${f.field_key}</strong>: ${f.message}</li>`)}</ul>`
          : html``}
        <p><a href="javascript:history.back()">Go back</a> · <a href="/">Home</a>${err.status === 401 ? html` · <a href="/login">Sign in</a>` : html``}</p>
      </div>`,
    ),
    { status: err.status },
  );
}
