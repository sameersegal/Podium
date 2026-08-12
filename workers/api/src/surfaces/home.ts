/**
 * `GET /` — one public event → its landing page; several → a list. Anonymous
 * and complete (INV-08-13): the same event landing content `/e/:slug` renders,
 * reused from `surfaces/public.ts` rather than duplicated.
 */

import { str, type Row } from "@podiumstack/data/db.js";
import type { RequestContext } from "../http/context.js";
import { htmlResponse } from "../http/responses.js";
import type { Router } from "../http/router.js";
import { html, raw } from "../ui/html.js";
import { pageHead } from "../ui/layout.js";
import { publicPage } from "../ui/shell.js";
import { renderEventLanding } from "./public.js";

export function registerHomeRoutes(router: Router<RequestContext>): void {
  router.get("/", async (_req, ctx) => {
    const app = ctx.app();
    const events = await app.db.select<Row>("event", { visibility: "public" }, { orderBy: "starts_on DESC" });
    const visible = events.filter((e) => str(e.status) !== "draft");

    if (visible.length === 1) {
      return htmlResponse(await renderEventLanding(ctx, visible[0]));
    }

    if (visible.length === 0) {
      return htmlResponse(
        publicPage(
          ctx,
          { title: "Podium" },
          html`${pageHead("Podium", "No public events yet.")}
            <div class="card"><p>Nothing is public here yet. <a href="/login">Sign in</a> if you're on the team.</p></div>`,
        ),
      );
    }

    const cards = visible.map(
      (e) => html`<div class="card">
        <h3><a href="/e/${str(e.slug)}">${str(e.name)}</a></h3>
        <p class="muted small">${str(e.starts_on)} → ${str(e.ends_on)}</p>
        ${e.tagline ? html`<p>${str(e.tagline)}</p>` : raw("")}
        <p class="actions">
          <a class="btn secondary small" href="/e/${str(e.slug)}/schedule">Schedule</a>
          <a class="btn secondary small" href="/e/${str(e.slug)}/speakers">Speakers</a>
        </p>
      </div>`,
    );

    return htmlResponse(
      publicPage(
        ctx,
        { title: "Podium" },
        html`${pageHead("Events", "Every public event running on this Podium instance.", html`<a class="btn secondary" href="/login">Sign in</a>`)}
          <div class="grid two">${cards}</div>`,
      ),
    );
  });
}
