/**
 * `/admin` — the organizer's landing page.
 *
 * It answers one question: what needs me today. Every number on it is a link
 * into the screen where the thing can actually be done, because a dashboard
 * you have to translate into an action by hand is a dashboard people stop
 * opening.
 */

import { num, str, type Row } from "@podiumconf/data/db.js";
import { formatDateInZone } from "@podiumconf/domain/shared/time.js";
import type { RequestContext } from "../http/context.js";
import { htmlResponse, redirect } from "../http/responses.js";
import type { Router } from "../http/router.js";
import { html, raw } from "../ui/html.js";
import { badge, card, empty, pageHead, stat, table } from "../ui/layout.js";
import { adminPage, toEventRef } from "../ui/shell.js";

/** `starts_on`/`ends_on` are calendar dates and are never converted (11, "Time"). */
const eventDay = (d: string) => (d ? formatDateInZone(`${d}T00:00:00Z`, "UTC") : "—");

export function registerAdminHomeRoutes(router: Router<RequestContext>): void {
  router.get("/admin", async (_req, ctx) => {
    if (!ctx.person && !ctx.apiKeyId) return redirect("/login?next=/admin");
    const app = ctx.app();

    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    const live = events.filter((e) => str(e.status) === "active");
    const focus = live[0] ?? events[0] ?? null;
    const ev = focus ? toEventRef(focus) : null;

    if (!ctx.isStaff({ event_id: ev?.id })) {
      // Not staff anywhere — the portal is where their work lives.
      return redirect("/portal");
    }

    let tiles = raw("");
    let attention = raw("");

    if (ev) {
      ctx.eventId = ev.id;
      const [proposals, submitted, sessions, unconfirmed, unplaced, overdueTasks, blockingOutstanding, pendingDecisions, publication] =
        await Promise.all([
          app.db.count("proposal", { event_id: ev.id }),
          app.db.raw<{ n: number }>(
            "SELECT COUNT(*) AS n FROM proposal WHERE event_id = ? AND deleted_at IS NULL AND status IN ('submitted','in_review','changes_requested')",
            [ev.id],
          ),
          app.db.raw<{ n: number }>(
            "SELECT COUNT(*) AS n FROM session WHERE event_id = ? AND deleted_at IS NULL AND status != 'cancelled'",
            [ev.id],
          ),
          app.db.raw<{ n: number }>(
            `SELECT COUNT(DISTINCT s.id) AS n FROM session s
               JOIN session_speaker ss ON ss.session_id = s.id
              WHERE s.event_id = ? AND s.status = 'pending_confirmation'
                AND ss.speaker_role = 'primary' AND ss.confirmation_status = 'pending'`,
            [ev.id],
          ),
          app.db.raw<{ n: number }>(
            `SELECT COUNT(*) AS n FROM session s
              WHERE s.event_id = ? AND s.status = 'confirmed' AND s.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM placement p WHERE p.session_id = s.id)`,
            [ev.id],
          ),
          app.db.raw<{ n: number }>(
            `SELECT COUNT(*) AS n FROM task_instance
              WHERE event_id = ? AND due_at IS NOT NULL AND due_at < ?
                AND status NOT IN ('completed','waived','cancelled')`,
            [ev.id, ctx.now],
          ),
          app.db.raw<{ n: number }>(
            `SELECT COUNT(*) AS n FROM task_instance
              WHERE event_id = ? AND is_blocking = 1
                AND status NOT IN ('completed','waived','cancelled')`,
            [ev.id],
          ),
          app.db.raw<{ n: number }>(
            `SELECT COUNT(*) AS n FROM decision d
               JOIN proposal p ON p.id = d.proposal_id
              WHERE p.event_id = ? AND d.status = 'provisional'`,
            [ev.id],
          ),
          app.db.raw<Row>("SELECT * FROM schedule_publication WHERE event_id = ? AND status = 'live'", [ev.id]),
        ]);

      const e = `/admin/events/${ev.id}`;
      tiles = html`<div class="grid four" style="margin-bottom:1rem">
        ${stat("Proposals", proposals, `${e}/proposals`)}
        ${stat("Awaiting a decision", num(submitted[0]?.n), `${e}/decisions`)}
        ${stat("Sessions", num(sessions[0]?.n), `${e}/sessions`)}
        ${stat("Overdue tasks", num(overdueTasks[0]?.n), `${e}/onboarding`)}
      </div>`;

      const rows = ([
        { label: "Provisional decisions not yet published — nobody has been told", count: num(pendingDecisions[0]?.n), href: `${e}/decisions`, kind: "warn" },
        { label: "Accepted sessions whose primary speaker has not confirmed", count: num(unconfirmed[0]?.n), href: `${e}/sessions?status=pending_confirmation`, kind: "warn" },
        { label: "Confirmed sessions with no room and time", count: num(unplaced[0]?.n), href: `${e}/schedule`, kind: "info" },
        { label: "Blocking onboarding tasks still outstanding", count: num(blockingOutstanding[0]?.n), href: `${e}/onboarding`, kind: "warn" },
        { label: "Tasks past their due date", count: num(overdueTasks[0]?.n), href: `${e}/onboarding?overdue=1`, kind: "err" },
      ] as { label: string; count: number; href: string; kind: "err" | "warn" | "info" }[]).filter((r) => r.count > 0);

      attention = card(
        rows.length === 0
          ? empty("Nothing is waiting on you. That is either very good news or the event has not started yet.")
          : html`<ul class="timeline">
              ${rows.map(
                (r) => html`<li>
                  <a href="${r.href}"><strong>${r.count}</strong> — ${r.label}</a>
                </li>`,
              )}
            </ul>`,
        "Needs attention",
      );

      if (publication.length === 0) {
        attention = html`${attention}
          <p class="notice info">
            The public schedule has not been published yet. Nothing on <a href="/e/${ev.slug}/schedule">the public page</a>
            changes until you publish — <a href="${e}/publications">publish it here</a>.
          </p>`;
      }
    }

    const eventRows = events.map(
      (row) => html`<tr>
        <td><a href="/admin/events/${str(row.id)}"><strong>${str(row.name)}</strong></a><br><span class="small muted mono">${str(row.slug)}</span></td>
        <td class="nowrap">${eventDay(str(row.starts_on))} – ${eventDay(str(row.ends_on))}</td>
        <td>${badge(str(row.status))} ${badge(str(row.visibility), str(row.visibility) === "public" ? "ok" : "")}</td>
        <td class="small"><a href="/e/${str(row.slug)}">Public page</a></td>
      </tr>`,
    );

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Admin", event: ev, active: "overview", width: "wide" },
        html`${pageHead(
          "Podium admin",
          ev ? `You are looking at ${ev.name}. Everything below is scoped to it.` : "No events yet — create one to get started.",
          html`<a class="btn" href="/admin/events/new">New event</a>`,
        )}
        ${tiles}
        <div class="grid two">
          <div>${attention}</div>
          <div>
            ${card(table(["Event", "Dates", "Status", ""], eventRows, "No events yet."), "Events")}
            ${card(
              html`<ul>
                <li><a href="/admin/contacts">Speaker directory</a> — everyone the organization knows, across every event</li>
                <li><a href="/admin/sponsors">Sponsors</a> — packages, entitlements and their sessions</li>
                <li><a href="/admin/team">Team and reviewers</a> — role grants and invitations</li>
                <li><a href="/admin/outbox">Communications history</a> — every message the platform has sent</li>
                <li><a href="/admin/audit">Audit log</a></li>
                <li><a href="/admin/settings">Organization settings</a></li>
              </ul>`,
              "Across events",
            )}
          </div>
        </div>`,
      ),
    );
  });
}
