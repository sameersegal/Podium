/**
 * 08 — Scheduling & Publication on the management surface.
 *
 * The gap R30 (13-open-questions.md) named as the one blocker for a
 * client-rendered admin console: `scheduling` had 812 lines of HTML form posts
 * and no `/v1` routes at all, and a grid that drags a card cannot post a form.
 * The endpoint list is in 09, "Scheduling on the management surface".
 *
 * This file is glue, deliberately. Every placement write goes through
 * `runSerialised` — the same schedule Durable Object the HTML surface uses, so
 * one writer per event holds however the write arrived (11, "Concurrency") —
 * and answers with the conflicts that write caused (INV-08-14), which is what
 * lets the console re-render the cell it just moved instead of re-fetching the
 * grid to find out what it broke.
 */

import { num, str, type Row } from "@podiumstack/data/db.js";
import type { AutoPlaceStrategy } from "@podiumstack/domain/scheduling/types.js";
import { notFound, validationError } from "@podiumstack/domain/shared/errors.js";
import { addMinutes, zonedDateTimeToInstant } from "@podiumstack/domain/shared/time.js";
import { runSerialised } from "../../durable/schedule.js";
import type { RequestContext } from "../../http/context.js";
import { readInput } from "../../http/input.js";
import { json } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { acknowledgeConflict, listConflicts } from "./conflicts.js";
import { pendingChanges, publishSchedule, rollbackPublication } from "./publication.js";
import { loadAgendaBuilder, loadAutoPlaceRun, loadPublications, proposeAutoPlace } from "./views.js";

/**
 * Placement rows carry no `event_id` of their own — they reach it through the
 * session — so authorization resolves the event before it can be checked.
 */
async function eventOfPlacement(ctx: RequestContext, placementId: string): Promise<string> {
  const row = await ctx.app().db.byId<Row>("placement", placementId);
  if (!row) throw notFound("Placement", placementId);
  const day = await ctx.app().db.byId<Row>("event_day", str(row.event_day_id));
  if (!day) throw notFound("Event day", str(row.event_day_id));
  return str(day.event_id);
}

async function eventOfConflict(ctx: RequestContext, conflictId: string): Promise<string> {
  const row = await ctx.app().db.byId<Row>("schedule_conflict", conflictId);
  if (!row) throw notFound("Conflict", conflictId);
  return str(row.event_id);
}

/**
 * A grid drops a card on a room and a time, and the time it means is the wall
 * clock of the event's own zone. Converting that to an instant is this side's
 * job, not the client's: the browser would have to reimplement
 * `zonedDateTimeToInstant` — including the DST edges — against a zone that is
 * not its own, and a placement an hour out is a speaker in the wrong room.
 *
 * So `starts_at` may be sent directly by an integration, or a caller may send
 * `start_time` ("09:30") and let the day and the event's timezone resolve it.
 * `duration_minutes` closes the same gap at the other end.
 */
async function resolveWindow(
  ctx: RequestContext,
  eventId: string,
  eventDayId: string,
  input: { starts_at: string | null; ends_at: string | null; start_time: string | null; duration_minutes: number | null },
  fallbackDuration: number,
): Promise<{ starts_at: string; ends_at: string }> {
  if (input.starts_at && input.ends_at) return { starts_at: input.starts_at, ends_at: input.ends_at };

  const app = ctx.app(eventId);
  const day = await app.db.byId<Row>("event_day", eventDayId);
  if (!day) throw notFound("Event day", eventDayId);
  const event = await app.db.byId<Row>("event", eventId);
  const timezone = event ? str(event.timezone, "UTC") : "UTC";

  const startsAt = input.starts_at ?? (input.start_time ? zonedDateTimeToInstant(str(day.date), input.start_time, timezone) : null);
  if (!startsAt) {
    throw validationError("A placement needs a start.", [{ field_key: "start_time", message: "Give either starts_at or start_time." }]);
  }
  const minutes = input.duration_minutes ?? fallbackDuration;
  return { starts_at: startsAt, ends_at: input.ends_at ?? addMinutes(startsAt, minutes > 0 ? minutes : 30) };
}

async function eventOfRun(ctx: RequestContext, runId: string): Promise<string> {
  const row = await ctx.app().db.byId<Row>("auto_place_run", runId);
  if (!row) throw notFound("Auto-place run", runId);
  return str(row.event_id);
}

export function registerSchedulingApiRoutes(router: Router<RequestContext>): void {
  /* the grid ---------------------------------------------------------------- */

  /**
   * The whole grid in one read. A console that fetched days, then rooms, then
   * placements could not lay anything out until the last response landed, and
   * the payload is bounded by one event's agenda.
   */
  router.get("/v1/events/:eventId/schedule", async (_req, ctx, params) => {
    ctx.requireRead("schedule.place", { event_id: params.eventId });
    ctx.eventId = params.eventId;
    const data = await loadAgendaBuilder(ctx.app(params.eventId), params.eventId);
    return json({
      data: {
        event: data.event,
        days: data.days,
        rooms: data.rooms,
        time_slots: data.timeSlots,
        placements: [...data.placementsByDay.entries()].flatMap(([, list]) => list),
        unplaced: data.unplaced,
        conflicts: data.conflicts,
        pending_count: data.pendingCount,
      },
    });
  });

  router.post("/v1/events/:eventId/placements", async (req, ctx, params) => {
    ctx.requireWrite("schedule.place", { event_id: params.eventId });
    const input = await readInput(req);
    const sessionId = input.str("session_id");
    const dayId = input.str("event_day_id");
    // The session's own duration is the default length, so a drop only has to
    // say where and when.
    const session = await ctx.app(params.eventId).db.byId<Row>("session", sessionId);
    const window = await resolveWindow(
      ctx,
      params.eventId,
      dayId,
      {
        starts_at: input.optional("starts_at"),
        ends_at: input.optional("ends_at"),
        start_time: input.optional("start_time"),
        duration_minutes: input.int("duration_minutes"),
      },
      session ? num(session.duration_minutes, 30) : 30,
    );
    const result = await runSerialised(ctx.env, {
      command: {
        kind: "place",
        session_id: sessionId,
        room_id: input.str("room_id"),
        event_day_id: dayId,
        starts_at: window.starts_at,
        ends_at: window.ends_at,
        time_slot_id: input.optional("time_slot_id"),
        notes: input.optional("notes"),
      },
      orgId: ctx.orgId,
      eventId: params.eventId,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    // INV-08-14 — the conflicts this write caused, in this write's response.
    return json({ data: result }, { status: 201 });
  });

  router.patch("/v1/placements/:placementId", async (req, ctx, params) => {
    const eventId = await eventOfPlacement(ctx, params.placementId);
    ctx.requireWrite("schedule.place", { event_id: eventId });
    const input = await readInput(req);
    const existing = await ctx.app(eventId).db.byId<Row>("placement", params.placementId);
    const dayId = input.has("event_day_id") ? input.str("event_day_id") : str(existing?.event_day_id);
    let window: { starts_at: string; ends_at: string } | null = null;
    if (input.has("starts_at") || input.has("start_time")) {
      const current = existing ? Math.max(1, Math.round((Date.parse(str(existing.ends_at)) - Date.parse(str(existing.starts_at))) / 60000)) : 30;
      window = await resolveWindow(
        ctx,
        eventId,
        dayId,
        {
          starts_at: input.optional("starts_at"),
          ends_at: input.optional("ends_at"),
          start_time: input.optional("start_time"),
          duration_minutes: input.int("duration_minutes"),
        },
        current,
      );
    }
    const result = await runSerialised(ctx.env, {
      command: {
        kind: "move",
        placement_id: params.placementId,
        ...(input.has("room_id") ? { room_id: input.str("room_id") } : {}),
        ...(input.has("event_day_id") ? { event_day_id: input.str("event_day_id") } : {}),
        ...(window ? { starts_at: window.starts_at, ends_at: window.ends_at } : {}),
      },
      orgId: ctx.orgId,
      eventId,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    return json({ data: result });
  });

  router.delete("/v1/placements/:placementId", async (_req, ctx, params) => {
    const eventId = await eventOfPlacement(ctx, params.placementId);
    ctx.requireWrite("schedule.place", { event_id: eventId });
    const result = await runSerialised(ctx.env, {
      command: { kind: "remove", placement_id: params.placementId },
      orgId: ctx.orgId,
      eventId,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    return json({ data: result });
  });

  /* conflicts --------------------------------------------------------------- */

  router.get("/v1/events/:eventId/conflicts", async (_req, ctx, params) => {
    ctx.requireRead("schedule.place", { event_id: params.eventId });
    ctx.eventId = params.eventId;
    return json({ data: await listConflicts(ctx.app(params.eventId), params.eventId) });
  });

  router.post("/v1/conflicts/:conflictId/acknowledge", async (req, ctx, params) => {
    const eventId = await eventOfConflict(ctx, params.conflictId);
    ctx.requireWrite("schedule.place", { event_id: eventId });
    const input = await readInput(req);
    // No pre-check on `reason`: `acknowledgeConflict` refuses a blank one with
    // `invariantError("INV-11-5", …)`, and a `validationError` in front of it
    // shadowed that with an untyped 422 — the one thing 09 says an error here
    // must not be ("Errors are typed, naming the invariant where one was
    // violated"). The deleted HTML form reached the service directly and got
    // the named error; this route now does too.
    const app = ctx.app(eventId);
    const view = await acknowledgeConflict(app, params.conflictId, input.str("reason"));
    await app.flush();
    return json({ data: view });
  });

  /* assisted placement ------------------------------------------------------ */

  router.post("/v1/events/:eventId/auto-place", async (req, ctx, params) => {
    ctx.requireWrite("schedule.place", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const trackIds = input.list("track_ids");
    const dayIds = input.list("event_day_ids");
    const runId = await proposeAutoPlace(app, params.eventId, {
      strategy: (input.str("strategy", "greedy_fill") || "greedy_fill") as AutoPlaceStrategy,
      scope: { track_ids: trackIds.length ? trackIds : undefined, event_day_ids: dayIds.length ? dayIds : undefined },
    });
    await app.flush();
    // INV-08-15 — a run proposes; nothing is placed until it is applied.
    return json({ data: await loadAutoPlaceRun(app, runId) }, { status: 201 });
  });

  router.get("/v1/auto-place-runs/:runId", async (_req, ctx, params) => {
    const eventId = await eventOfRun(ctx, params.runId);
    ctx.requireRead("schedule.place", { event_id: eventId });
    return json({ data: await loadAutoPlaceRun(ctx.app(eventId), params.runId) });
  });

  router.post("/v1/auto-place-runs/:runId/apply", async (req, ctx, params) => {
    const eventId = await eventOfRun(ctx, params.runId);
    ctx.requireWrite("schedule.place", { event_id: eventId });
    const input = await readInput(req);
    const sessionIds = input.list("session_ids");
    const result = await runSerialised(ctx.env, {
      command: { kind: "apply_auto_place", run_id: params.runId, session_ids: sessionIds.length ? sessionIds : undefined },
      orgId: ctx.orgId,
      eventId,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    return json({ data: result });
  });

  /* publication ------------------------------------------------------------- */

  router.get("/v1/events/:eventId/publications", async (_req, ctx, params) => {
    ctx.requireRead("schedule.read_published", { event_id: params.eventId });
    ctx.eventId = params.eventId;
    const app = ctx.app(params.eventId);
    const [rows, pending] = await Promise.all([loadPublications(app, params.eventId), pendingChanges(app, params.eventId)]);
    return json({ data: rows, pending_changes: pending });
  });

  router.post("/v1/events/:eventId/publications", async (req, ctx, params) => {
    ctx.requireWrite("schedule.publish", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const outcome = await publishSchedule(app, params.eventId, { note: input.optional("note") });
    await app.flush();
    return json({ data: outcome }, { status: 201 });
  });

  router.post("/v1/publications/:publicationId/rollback", async (req, ctx, params) => {
    const row = await ctx.app().db.byId<Row>("schedule_publication", params.publicationId);
    if (!row) throw notFound("Publication", params.publicationId);
    const eventId = str(row.event_id);
    ctx.requireWrite("schedule.publish", { event_id: eventId });
    const input = await readInput(req);
    const app = ctx.app(eventId);
    const outcome = await rollbackPublication(app, eventId, params.publicationId, input.optional("reason"));
    await app.flush();
    return json({ data: outcome });
  });
}
