/**
 * Development and test affordances. Never registered behaviour that production
 * depends on — every route here refuses when `ENVIRONMENT` is `production`.
 *
 * These exist because the parts of an event-driven system that are hardest to
 * see are the ones that happen on a timer or a queue. Being able to say "run
 * the reminder sweep now" turns a fifteen-minute wait into a click.
 */

import { runAllCron } from "../consumers/cron.js";
import { replayUnprocessedEvents } from "../consumers/replay.js";
import { str, type Row } from "@podiumconf/data/db.js";
import { forbidden } from "@podiumconf/domain/shared/errors.js";
import type { RequestContext } from "../http/context.js";
import { json } from "../http/responses.js";
import type { Router } from "../http/router.js";

function guard(ctx: RequestContext): void {
  if (ctx.env.ENVIRONMENT === "production") throw forbidden("Development routes are disabled in production.");
}

export function registerDevRoutes(router: Router<RequestContext>): void {
  router.get("/dev/status", async (_req, ctx) => {
    guard(ctx);
    const app = ctx.app();
    const counts: Record<string, number> = {};
    for (const table of ["person", "event", "proposal", "session", "task_instance", "placement", "schedule_publication", "domain_event_record", "notification_delivery"]) {
      counts[table] = await app.db.count(table, {});
    }
    return json({ environment: ctx.env.ENVIRONMENT, org_id: ctx.orgId, counts });
  });

  /**
   * The ids of the seeded fixtures, so a smoke walk can build real URLs
   * instead of guessing them.
   */
  router.get("/dev/ids", async (_req, ctx) => {
    guard(ctx);
    const app = ctx.app();
    const [event] = await app.db.select<Row>("event", { status: "active" }, { orderBy: "starts_on", limit: 1 });
    if (!event) return json({});
    const eventId = str(event.id);
    const [cfp] = await app.db.select<Row>("call_for_proposals", { event_id: eventId }, { orderBy: "created_at", limit: 1 });
    const [proposal] = await app.db.select<Row>("proposal", { event_id: eventId }, { orderBy: "created_at", limit: 1 });
    const [session] = await app.db.select<Row>("session", { event_id: eventId }, { orderBy: "created_at", limit: 1 });
    const [round] = await app.db.select<Row>("review_round", { event_id: eventId }, { orderBy: "sequence", limit: 1 });
    const [sponsor] = await app.db.select<Row>("sponsor", {}, { orderBy: "created_at", limit: 1 });
    const [task] = await app.db.select<Row>("task_instance", { event_id: eventId }, { orderBy: "created_at", limit: 1 });
    const [person] = await app.db.select<Row>("person", {}, { orderBy: "created_at", limit: 1 });
    return json({
      org_id: ctx.orgId,
      event_id: eventId,
      event_slug: str(event.slug),
      cfp_id: cfp ? str(cfp.id) : null,
      cfp_slug: cfp ? str(cfp.slug) : null,
      proposal_id: proposal ? str(proposal.id) : null,
      session_id: session ? str(session.id) : null,
      round_id: round ? str(round.id) : null,
      sponsor_id: sponsor ? str(sponsor.id) : null,
      task_id: task ? str(task.id) : null,
      person_id: person ? str(person.id) : null,
    });
  });

  /** Run every cron sweep now rather than waiting for the next trigger. */
  router.post("/dev/cron", async (_req, ctx) => {
    guard(ctx);
    const results = await runAllCron(ctx.env, ctx.now);
    return json({ ran: results });
  });

  /**
   * Replay every stored domain event with an incomplete reaction map — the
   * same `replayUnprocessedEvents` the `platform.replay_unprocessed_events`
   * cron job runs in production (contexts/platform/cron.ts), on demand and
   * unbounded by recency (no `lookbackHours`), since an operator asking for
   * this manually has decided a full scan is worth it once. Recovery for a
   * queue outage, and how a test drives the reaction map end to end.
   */
  router.post("/dev/drain", async (_req, ctx) => {
    guard(ctx);
    const result = await replayUnprocessedEvents(ctx.env, { now: ctx.now, graceMinutes: 0 });
    return json({ replayed: result.replayed, scanned: result.scanned });
  });
}
