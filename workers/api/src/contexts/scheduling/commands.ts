/**
 * Placement commands executed inside the schedule Durable Object — one writer
 * per event (11-cross-cutting.md, "Concurrency").
 *
 * Every `Placement` mutation in the product arrives here, and arrives already
 * serialised: the DO wraps the call in `blockConcurrencyWhile`, so two
 * organizers dragging the same slot queue rather than interleave. Conflicts are
 * recomputed in the same critical section and returned in the response
 * (INV-08-14).
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import {
  assertPlaceable,
  assertPlacementTimes,
  assertRemovable,
  sessionStatusOnPlace,
  sessionStatusOnRemove,
} from "@podiumstack/domain/scheduling/placement.js";
import type { ProposedPlacement } from "@podiumstack/domain/scheduling/auto-place.js";
import type { SerialisedCall } from "../../durable/schedule.js";
import { recomputeConflicts } from "./conflicts.js";
import { loadScheduleFacts } from "./facts.js";

export type PlacementCommand =
  | { kind: "place"; session_id: string; room_id: string; event_day_id: string; starts_at: string; ends_at: string; time_slot_id?: string | null; setup_minutes?: number; teardown_minutes?: number; notes?: string | null; status?: "tentative" | "locked" }
  | { kind: "move"; placement_id: string; room_id?: string; event_day_id?: string; starts_at?: string; ends_at?: string }
  | { kind: "remove"; placement_id: string; reason?: "organizer_action" | "session_cancelled" }
  | { kind: "apply_auto_place"; run_id: string; session_ids?: string[] };

export interface ConflictView {
  id: string;
  code: string;
  severity: "error" | "warning";
  placement_ids: string[];
  detail: Record<string, unknown>;
  acknowledged_by_person_id?: string | null;
  acknowledged_reason?: string | null;
}

export interface PlacementResult {
  placement_id: string | null;
  /** INV-08-14: conflicts are returned in the write's response. */
  conflicts: ConflictView[];
  applied_session_ids?: string[];
  skipped_session_ids?: string[];
}

export async function executePlacementCommand(env: Env, call: SerialisedCall): Promise<PlacementResult> {
  const app = new AppContext({
    env,
    orgId: call.orgId,
    eventId: call.eventId,
    actor: call.actor,
    correlationId: call.correlationId,
  });

  let placementId: string | null = null;
  let applied: string[] | undefined;
  let skipped: string[] | undefined;

  switch (call.command.kind) {
    case "place":
      placementId = await place(app, call.eventId, call.command);
      break;
    case "move":
      placementId = await move(app, call.eventId, call.command);
      break;
    case "remove":
      await remove(app, call.eventId, call.command.placement_id, call.command.reason ?? "organizer_action");
      break;
    case "apply_auto_place": {
      const outcome = await applyAutoPlace(app, call.eventId, call.command.run_id, call.command.session_ids);
      applied = outcome.applied;
      skipped = outcome.skipped;
      break;
    }
  }

  // INV-08-14 — synchronously, in the same critical section as the write.
  const conflicts = await recomputeConflicts(app, call.eventId);
  await app.flush();

  return {
    placement_id: placementId,
    conflicts: conflicts.map((c) => ({
      id: c.id,
      code: c.code,
      severity: c.severity,
      placement_ids: c.placement_ids,
      detail: c.detail,
      acknowledged_by_person_id: c.acknowledged_by_person_id,
      acknowledged_reason: c.acknowledged_reason,
    })),
    ...(applied ? { applied_session_ids: applied } : {}),
    ...(skipped ? { skipped_session_ids: skipped } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* place                                                                       */
/* -------------------------------------------------------------------------- */

interface PlaceInput {
  session_id: string;
  room_id: string;
  event_day_id: string;
  starts_at: string;
  ends_at: string;
  time_slot_id?: string | null;
  setup_minutes?: number;
  teardown_minutes?: number;
  notes?: string | null;
  status?: "tentative" | "locked";
}

async function place(app: AppContext, eventId: string, input: PlaceInput): Promise<string> {
  const session = await app.db.byId<Row>("session", input.session_id);
  if (!session || str(session.event_id) !== eventId) throw notFound("Session", input.session_id);

  // INV-08-3: only confirmed / scheduled / published sessions may be placed.
  assertPlaceable({ id: str(session.id), status: str(session.status), title: str(session.title) });

  // INV-08-1: a non-cancelled session has at most one placement.
  const existing = await app.db.first<Row>("placement", { session_id: input.session_id });
  if (existing) {
    throw invariantError(
      "INV-08-1",
      "session_already_placed",
      `"${str(session.title)}" is already on the schedule. Move it rather than placing it twice.`,
      { session_id: input.session_id, placement_id: str(existing.id) },
    );
  }

  const { day, room, event } = await placementContext(app, eventId, input.event_day_id, input.room_id);

  // INV-08-2: ends_at > starts_at, within the event day's date in the event timezone.
  assertPlacementTimes({
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    event_day_date: str(day.date),
    timezone: event.timezone,
  });

  const now = app.now();
  const id = newId("Placement");
  await app.db.insert("placement", {
    id,
    event_id: eventId,
    session_id: input.session_id,
    room_id: room.id,
    event_day_id: str(day.id),
    time_slot_id: input.time_slot_id ?? null,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    setup_minutes: input.setup_minutes ?? 0,
    teardown_minutes: input.teardown_minutes ?? 0,
    status: input.status ?? "tentative",
    // A placement of an internal session is not public; INV-06-8 keeps it out
    // of every snapshot either way.
    is_public: str(session.visibility, "public") === "public" ? 1 : 0,
    placed_by_person_id: app.actor.id ?? "system",
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  });

  // INV-08-3: placing sets `scheduled`.
  const nextStatus = sessionStatusOnPlace(str(session.status));
  if (nextStatus) await app.db.update("session", input.session_id, { status: nextStatus, updated_at: now });

  app.events.emit({
    type: "placement.created",
    subject: { type: "placement", id },
    event_id: eventId,
    data: {
      placement_id: id,
      session_id: input.session_id,
      room_id: room.id,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
    },
  });
  app.audit.record({
    action: "placement.create",
    entity_type: "placement",
    entity_id: id,
    after: { session_id: input.session_id, room_id: room.id, starts_at: input.starts_at, ends_at: input.ends_at },
  });
  return id;
}

/* -------------------------------------------------------------------------- */
/* move                                                                        */
/* -------------------------------------------------------------------------- */

async function move(
  app: AppContext,
  eventId: string,
  input: { placement_id: string; room_id?: string; event_day_id?: string; starts_at?: string; ends_at?: string },
): Promise<string> {
  const placement = await app.db.byId<Row>("placement", input.placement_id);
  if (!placement || str(placement.event_id) !== eventId) throw notFound("Placement", input.placement_id);

  const roomId = input.room_id ?? str(placement.room_id);
  const dayId = input.event_day_id ?? str(placement.event_day_id);
  const startsAt = input.starts_at ?? str(placement.starts_at);
  const endsAt = input.ends_at ?? str(placement.ends_at);

  const { day, room, event } = await placementContext(app, eventId, dayId, roomId);
  assertPlacementTimes({ starts_at: startsAt, ends_at: endsAt, event_day_date: str(day.date), timezone: event.timezone });

  const from = { room_id: str(placement.room_id), starts_at: str(placement.starts_at), ends_at: str(placement.ends_at) };
  const to = { room_id: room.id, starts_at: startsAt, ends_at: endsAt };
  if (from.room_id === to.room_id && from.starts_at === to.starts_at && from.ends_at === to.ends_at && dayId === str(placement.event_day_id)) {
    return input.placement_id; // nothing moved; no event, no audit row
  }

  await app.db.update("placement", input.placement_id, {
    room_id: room.id,
    event_day_id: str(day.id),
    starts_at: startsAt,
    ends_at: endsAt,
    // A slot alignment does not survive a free move to a different time.
    time_slot_id: input.starts_at && input.starts_at !== str(placement.starts_at) ? null : strOrNull(placement.time_slot_id),
    updated_at: app.now(),
  });

  app.events.emit({
    type: "placement.moved",
    subject: { type: "placement", id: input.placement_id },
    event_id: eventId,
    data: { placement_id: input.placement_id, session_id: str(placement.session_id), from, to },
  });
  app.audit.record({
    action: "placement.move",
    entity_type: "placement",
    entity_id: input.placement_id,
    before: from,
    after: to,
  });
  return input.placement_id;
}

/* -------------------------------------------------------------------------- */
/* remove                                                                      */
/* -------------------------------------------------------------------------- */

async function remove(
  app: AppContext,
  eventId: string,
  placementId: string,
  reason: "organizer_action" | "session_cancelled" = "organizer_action",
): Promise<void> {
  const placement = await app.db.byId<Row>("placement", placementId);
  if (!placement || str(placement.event_id) !== eventId) throw notFound("Placement", placementId);
  const sessionId = str(placement.session_id);
  const session = await app.db.byId<Row>("session", sessionId);

  // Guard first. Each D1 statement commits on its own, so throwing after the
  // delete would refuse the command and destroy the placement anyway.
  if (session) assertRemovable({ id: sessionId, status: str(session.status) }, reason);

  await app.db.hardDelete("placement", { id: placementId });

  if (session) {
    // INV-08-3: removing the placement returns the session to `confirmed`.
    // A cancelled session stays cancelled — `sessionStatusOnRemove` returns null.
    const next = sessionStatusOnRemove(str(session.status));
    if (next) await app.db.update("session", sessionId, { status: next, updated_at: app.now() });
  }

  app.events.emit({
    type: "placement.removed",
    subject: { type: "placement", id: placementId },
    event_id: eventId,
    data: { placement_id: placementId, session_id: sessionId },
  });
  app.audit.record({
    action: "placement.remove",
    entity_type: "placement",
    entity_id: placementId,
    before: { session_id: sessionId, room_id: str(placement.room_id), starts_at: str(placement.starts_at) },
  });
}

/* -------------------------------------------------------------------------- */
/* apply an AutoPlaceRun                                                       */
/* -------------------------------------------------------------------------- */

/**
 * INV-08-15 — `AutoPlaceRun` never mutates an existing placement. Applying a
 * run creates placements only for sessions that were unplaced *when it was
 * applied*; anything placed in the interim is reported as skipped.
 */
async function applyAutoPlace(
  app: AppContext,
  eventId: string,
  runId: string,
  onlySessionIds?: string[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const run = await app.db.byId<Row>("auto_place_run", runId);
  if (!run || str(run.event_id) !== eventId) throw notFound("Auto-place run", runId);
  if (str(run.status) === "discarded") {
    throw invariantError("INV-08-15", "run_discarded", "That suggestion has been discarded; run a new one.");
  }

  const proposed = JSON.parse(str(run.proposed, "[]")) as ProposedPlacement[];
  const wanted = onlySessionIds?.length ? proposed.filter((p) => onlySessionIds.includes(p.session_id)) : proposed;

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const p of wanted) {
    const existing = await app.db.first<Row>("placement", { session_id: p.session_id });
    if (existing) {
      skipped.push(p.session_id);
      continue;
    }
    try {
      await place(app, eventId, {
        session_id: p.session_id,
        room_id: p.room_id,
        event_day_id: p.event_day_id,
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        notes: p.rationale,
      });
      applied.push(p.session_id);
    } catch {
      // A session that became unplaceable between proposal and apply is
      // reported, never silently dropped.
      skipped.push(p.session_id);
    }
  }

  const previouslyApplied = JSON.parse(str(run.applied_session_ids, "[]")) as string[];
  const allApplied = [...new Set([...previouslyApplied, ...applied])];
  const status = allApplied.length === 0 ? "discarded" : allApplied.length === proposed.length ? "applied" : "partially_applied";
  await app.db.update("auto_place_run", runId, {
    status,
    applied_session_ids: JSON.stringify(allApplied),
    applied_at: app.now(),
  });

  app.events.emit({
    type: "schedule.auto_place_applied",
    subject: { type: "event", id: eventId },
    event_id: eventId,
    data: { run_id: runId, applied_session_ids: applied, skipped_session_ids: skipped },
  });
  app.audit.record({
    action: "schedule.auto_place_apply",
    entity_type: "auto_place_run",
    entity_id: runId,
    after: { applied: applied.length, skipped: skipped.length, status },
  });
  return { applied, skipped };
}

/* -------------------------------------------------------------------------- */
/* shared lookups                                                              */
/* -------------------------------------------------------------------------- */

async function placementContext(
  app: AppContext,
  eventId: string,
  dayId: string,
  roomId: string,
): Promise<{ day: Row; room: { id: string; name: string }; event: { timezone: string } }> {
  const [day, room, event] = await Promise.all([
    app.db.byId<Row>("event_day", dayId),
    app.db.byId<Row>("room", roomId),
    app.db.byId<Row>("event", eventId),
  ]);
  if (!day || str(day.event_id) !== eventId) throw notFound("Event day", dayId);
  if (!room || str(room.event_id) !== eventId) throw notFound("Room", roomId);
  if (!event) throw notFound("Event", eventId);
  return { day, room: { id: str(room.id), name: str(room.name) }, event: { timezone: str(event.timezone, "UTC") } };
}

/** Re-exported so the routes need one import for the command and its facts. */
export { loadScheduleFacts };
