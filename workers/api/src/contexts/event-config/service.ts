/**
 * 02 — Event Configuration.
 *
 * Aggregate roots: `Event`, `CallForProposals`, `SubmissionForm`, `Venue`.
 *
 * The rule that shapes this context: configuration a submitter has already
 * started interacting with is versioned, not edited in place. Renaming a track
 * is fine; deleting a required field out from under fourteen half-finished
 * drafts is not.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import {
  activationBlockers,
  canTransitionEvent,
  cfpWindowProblems,
  changedFieldKeys,
  DEFAULT_FORM_TEMPLATE,
  durationProblems,
  isCosmeticFieldPatch,
  isCosmeticStepPatch,
  mappingTypeProblems,
  publishBlockers,
  COSMETIC_FIELD_ATTRS,
  COSMETIC_STEP_ATTRS,
  type FormTemplateStep,
  type SelectOption,
} from "@podiumconf/domain/event-config/rules.js";
import {
  cfpStatus,
  validateConditionOrdering,
  type CapacityPolicy,
  type CfpAudience,
  type ConditionRule,
  type EventMode,
  type EventStatus,
  type EventVisibility,
  type FieldAudience,
  type FieldType,
  type FormSpec,
  type LateSubmissionPolicy,
  type MapsTo,
  type Origin,
  type WithdrawAllowedUntil,
} from "@podiumconf/domain/event-config/types.js";
import { DomainError, illegalTransition, invariantError, notFound } from "@podiumconf/domain/shared/errors.js";
import { newId, slugify } from "@podiumconf/domain/shared/ids.js";
import { builderForm, cfpFormatOptions, cfpRow, derivedCfpStatus, eventRow, loadFormSpec, loadPublishedForm, proposalCount } from "./views.js";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function fail(code: string, message: string, status = 422, details?: Record<string, unknown>): never {
  throw new DomainError({ code, message, status, details });
}

function requireProblemsEmpty(problems: string[], code: string, invariant?: string): void {
  if (problems.length === 0) return;
  throw new DomainError({
    code,
    message: problems.join(" "),
    status: 422,
    invariant,
    details: { problems },
  });
}

/**
 * INV-11-8 — public slugs are immutable once published; a slug is
 * `[a-z0-9-]+` and unique within its stated scope.
 */
async function uniqueSlug(app: AppContext, table: string, scope: Row, desired: string, exceptId?: string): Promise<string> {
  const base = slugify(desired);
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    const existing = await app.db.first<Row>(table, { ...scope, slug: candidate });
    if (!existing || str(existing.id) === exceptId) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Cursor pagination over ULID order. `raw` is the documented escape hatch for
 * reads the generic helpers cannot express; org scoping (INV-11-1) and soft
 * delete (INV-11-2) are applied here explicitly because of it.
 */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export async function cursorPage(
  app: AppContext,
  table: string,
  opts: {
    where?: Record<string, string>;
    orgScoped: boolean;
    softDelete: boolean;
    cursor?: string | null;
    limit?: number;
  },
): Promise<Page<Row>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.orgScoped) {
    clauses.push("org_id = ?"); // INV-11-1
    params.push(app.orgId);
  }
  if (opts.softDelete) clauses.push("deleted_at IS NULL"); // INV-11-2
  for (const [k, v] of Object.entries(opts.where ?? {})) {
    clauses.push(`${k} = ?`);
    params.push(v);
  }
  if (opts.cursor) {
    clauses.push("id > ?");
    params.push(opts.cursor);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = await app.db.raw<Row>(`SELECT * FROM ${table}${where} ORDER BY id LIMIT ${limit + 1}`, params);
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? str(items[items.length - 1]?.id) : null };
}

/* -------------------------------------------------------------------------- */
/* Event                                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateEventInput {
  name: string;
  slug?: string | null;
  edition?: string | null;
  tagline?: string | null;
  description?: string | null;
  timezone: string;
  starts_on: string;
  ends_on: string;
  mode?: EventMode;
  website_url?: string | null;
  visibility?: EventVisibility;
  settings?: Record<string, unknown>;
}

export async function createEvent(app: AppContext, input: CreateEventInput): Promise<Row> {
  if (!input.name.trim()) fail("invalid_event", "An event needs a name.");
  // INV-02-1
  if (!input.timezone.trim()) fail("invalid_event", "An event needs a timezone — every time on its schedule and deadlines is shown in it.");
  if (!input.starts_on || !input.ends_on) fail("invalid_event", "An event needs a start and an end date.");
  if (input.ends_on < input.starts_on) fail("invalid_event", "The event cannot end before it starts.");

  const id = newId("Event");
  const now = app.now();
  const row: Row = {
    id,
    org_id: app.orgId,
    name: input.name.trim(),
    slug: await uniqueSlug(app, "event", {}, input.slug || input.name),
    edition: input.edition ?? null,
    tagline: input.tagline ?? null,
    description: input.description ?? null,
    timezone: input.timezone.trim(),
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    venue_id: null,
    mode: input.mode ?? "in_person",
    website_url: input.website_url ?? null,
    logo_asset_id: null,
    status: "draft", // the state diagram starts every event here
    visibility: input.visibility ?? "private",
    settings: JSON.stringify(input.settings ?? {}),
    created_at: now,
    updated_at: now,
    archived_at: null,
    row_version: 1,
  };
  await app.db.insert("event", row);
  app.eventId = id;
  app.events.emit({
    type: "event.created",
    subject: { type: "event", id },
    event_id: id,
    data: {
      event_id: id,
      name: row.name,
      slug: row.slug,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      timezone: row.timezone,
    },
  });
  app.audit.record({ action: "event.create", entity_type: "event", entity_id: id, after: { name: row.name, slug: row.slug } });
  return row;
}

export const EVENT_EDITABLE_FIELDS = [
  "name",
  "edition",
  "tagline",
  "description",
  "timezone",
  "starts_on",
  "ends_on",
  "mode",
  "website_url",
  "logo_asset_id",
  "visibility",
  "venue_id",
] as const;

export async function updateEvent(
  app: AppContext,
  eventId: string,
  patch: Record<string, unknown>,
  expectedVersion?: number | null,
): Promise<Row> {
  const event = await eventRow(app, eventId);
  const update: Row = {};
  const before: Row = {};
  for (const f of EVENT_EDITABLE_FIELDS) {
    if (!(f in patch)) continue;
    const value = patch[f] === "" ? null : patch[f];
    if (String(value ?? "") === String(event[f] ?? "")) continue;
    update[f] = value ?? null;
    before[f] = event[f] ?? null;
  }
  // INV-11-6: `status` is a transition, never a field write; slug is immutable
  // once public (INV-11-8).
  if ("status" in patch) fail("status_is_a_transition", "Move an event between states with activate / archive, not by writing `status`.");
  if ("settings" in patch) update.settings = JSON.stringify(patch.settings ?? {});
  if (Object.keys(update).length === 0) return event;
  if (update.ends_on || update.starts_on) {
    const startsOn = str(update.starts_on ?? event.starts_on);
    const endsOn = str(update.ends_on ?? event.ends_on);
    if (endsOn < startsOn) fail("invalid_event", "The event cannot end before it starts.");
  }
  update.updated_at = app.now();

  if (expectedVersion != null) {
    await app.db.updateVersioned("event", str(event.id), expectedVersion, update);
  } else {
    await app.db.update("event", str(event.id), update);
  }
  app.audit.record({ action: "event.update", entity_type: "event", entity_id: str(event.id), before, after: update });
  return { ...event, ...update };
}

export interface ActivationCheck {
  ready: boolean;
  blockers: string[];
  day_count: number;
  session_format_count: number;
  room_count: number;
}

/** INV-02-11, evaluated so the setup screen can show it before it is refused. */
export async function activationCheck(app: AppContext, eventId: string): Promise<ActivationCheck> {
  const event = await eventRow(app, eventId);
  const [dayCount, formatCount, roomCount] = await Promise.all([
    app.db.count("event_day", { event_id: eventId }),
    app.db.count("session_format", { event_id: eventId }),
    app.db.count("room", { event_id: eventId }),
  ]);
  const blockers = activationBlockers({
    day_count: dayCount,
    session_format_count: formatCount,
    room_count: roomCount,
    mode: str(event.mode, "in_person") as EventMode,
  });
  return { ready: blockers.length === 0, blockers, day_count: dayCount, session_format_count: formatCount, room_count: roomCount };
}

async function transitionEvent(app: AppContext, eventId: string, to: EventStatus): Promise<Row> {
  const event = await eventRow(app, eventId);
  const from = str(event.status, "draft") as EventStatus;
  if (from === to) return event;
  // A transition that is not drawn in the state diagram does not exist.
  if (!canTransitionEvent(from, to)) throw illegalTransition("Event", from, to);
  return event;
}

export async function activateEvent(app: AppContext, eventId: string): Promise<Row> {
  const event = await transitionEvent(app, eventId, "active");
  if (str(event.status) === "active") return event;
  const check = await activationCheck(app, eventId);
  if (!check.ready) {
    // INV-02-11: an Event cannot become `active` without at least one
    // EventDay, one SessionFormat, and — if mode != online — one Room.
    throw invariantError(
      "INV-02-11",
      "event_not_ready_to_activate",
      `This event still needs ${check.blockers.join(", ")} before it can go active.`,
      { blockers: check.blockers, mode: str(event.mode) },
    );
  }
  const now = app.now();
  await app.db.update("event", eventId, { status: "active", archived_at: null, updated_at: now });
  app.eventId = eventId;
  app.events.emit({ type: "event.activated", subject: { type: "event", id: eventId }, event_id: eventId, data: { event_id: eventId } });
  app.audit.record({
    action: "event.activate",
    entity_type: "event",
    entity_id: eventId,
    before: { status: str(event.status) },
    after: { status: "active" },
  });
  return { ...event, status: "active" };
}

export async function archiveEvent(app: AppContext, eventId: string): Promise<Row> {
  const event = await transitionEvent(app, eventId, "archived");
  if (str(event.status) === "archived") return event;
  const now = app.now();
  await app.db.update("event", eventId, { status: "archived", archived_at: now, updated_at: now });
  app.eventId = eventId;
  app.events.emit({ type: "event.archived", subject: { type: "event", id: eventId }, event_id: eventId, data: { event_id: eventId } });
  app.audit.record({
    action: "event.archive",
    entity_type: "event",
    entity_id: eventId,
    before: { status: str(event.status) },
    after: { status: "archived" },
  });
  return { ...event, status: "archived" };
}

/**
 * `archived --> active: unarchive (admin, rare)` — drawn, so it exists. It
 * re-checks INV-02-11 because configuration may have been archived meanwhile.
 */
export async function unarchiveEvent(app: AppContext, eventId: string, reason: string): Promise<Row> {
  await transitionEvent(app, eventId, "active");
  const restored = await activateEvent(app, eventId);
  app.audit.record({ action: "event.unarchive", entity_type: "event", entity_id: eventId, reason });
  return restored;
}

/* -------------------------------------------------------------------------- */
/* EventDay                                                                    */
/* -------------------------------------------------------------------------- */

export async function createEventDay(
  app: AppContext,
  eventId: string,
  input: { date: string; label?: string | null; sort_order?: number | null; is_public?: boolean },
): Promise<Row> {
  await eventRow(app, eventId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fail("invalid_day", "A day needs a calendar date (YYYY-MM-DD) in the event timezone.");
  const existing = await app.db.first<Row>("event_day", { event_id: eventId, date: input.date });
  if (existing) fail("duplicate_day", `${input.date} is already a day of this event.`, 409);
  const count = await app.db.count("event_day", { event_id: eventId });
  const row: Row = {
    id: newId("EventDay"),
    event_id: eventId,
    date: input.date,
    label: input.label ?? null,
    sort_order: input.sort_order ?? count,
    is_public: input.is_public === false ? 0 : 1,
  };
  await app.db.insert("event_day", row);
  app.audit.record({ action: "event_day.create", entity_type: "event_day", entity_id: str(row.id), after: { date: input.date } });
  return row;
}

export async function updateEventDay(
  app: AppContext,
  dayId: string,
  patch: { date?: string; label?: string | null; sort_order?: number | null; is_public?: boolean },
): Promise<Row> {
  const day = await app.db.byId<Row>("event_day", dayId);
  if (!day) throw notFound("Event day", dayId);
  const update: Row = {};
  if (patch.date && patch.date !== str(day.date)) update.date = patch.date;
  if (patch.label !== undefined) update.label = patch.label || null;
  if (patch.sort_order !== undefined && patch.sort_order !== null) update.sort_order = patch.sort_order;
  if (patch.is_public !== undefined) update.is_public = patch.is_public ? 1 : 0;
  if (Object.keys(update).length === 0) return day;
  await app.db.update("event_day", dayId, update);
  app.audit.record({ action: "event_day.update", entity_type: "event_day", entity_id: dayId, before: day, after: update });
  return { ...day, ...update };
}

/**
 * A day carrying time slots is load-bearing for the schedule; removing it
 * would orphan them. Configuration is archived or refused, never quietly
 * cascaded (11, "Soft delete rules").
 */
export async function deleteEventDay(app: AppContext, dayId: string): Promise<void> {
  const day = await app.db.byId<Row>("event_day", dayId);
  if (!day) throw notFound("Event day", dayId);
  const slots = await app.db.count("time_slot", { event_day_id: dayId });
  if (slots > 0) {
    fail("day_in_use", `This day has ${slots} time slot(s) on the schedule. Clear them first.`, 409, { time_slot_count: slots });
  }
  await app.db.hardDelete("event_day", { id: dayId });
  app.audit.record({ action: "event_day.delete", entity_type: "event_day", entity_id: dayId, before: day });
}

/* -------------------------------------------------------------------------- */
/* Track                                                                       */
/* -------------------------------------------------------------------------- */

export interface TrackInput {
  name: string;
  slug?: string | null;
  description?: string | null;
  color?: string | null;
  sort_order?: number | null;
  target_session_count?: number | null;
  is_public?: boolean;
}

export async function createTrack(app: AppContext, eventId: string, input: TrackInput): Promise<Row> {
  await eventRow(app, eventId);
  if (!input.name.trim()) fail("invalid_track", "A track needs a name.");
  const count = await app.db.count("track", { event_id: eventId });
  const row: Row = {
    id: newId("Track"),
    event_id: eventId,
    name: input.name.trim(),
    slug: await uniqueSlug(app, "track", { event_id: eventId }, input.slug || input.name),
    description: input.description ?? null,
    color: input.color ?? null,
    sort_order: input.sort_order ?? count,
    target_session_count: input.target_session_count ?? null,
    is_public: input.is_public === false ? 0 : 1,
    deleted_at: null,
  };
  await app.db.insert("track", row);
  app.events.emit({
    type: "track.created",
    subject: { type: "track", id: str(row.id) },
    event_id: eventId,
    data: { track_id: str(row.id), name: row.name, slug: row.slug },
  });
  app.audit.record({ action: "track.create", entity_type: "track", entity_id: str(row.id), after: { name: row.name, slug: row.slug } });
  return row;
}

export async function updateTrack(app: AppContext, trackId: string, patch: Partial<TrackInput>): Promise<Row> {
  const track = await app.db.byId<Row>("track", trackId);
  if (!track) throw notFound("Track", trackId);
  const update: Row = {};
  if (patch.name !== undefined && patch.name.trim()) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description || null;
  if (patch.color !== undefined) update.color = patch.color || null;
  if (patch.sort_order !== undefined && patch.sort_order !== null) update.sort_order = patch.sort_order;
  if (patch.target_session_count !== undefined) update.target_session_count = patch.target_session_count ?? null;
  if (patch.is_public !== undefined) update.is_public = patch.is_public ? 1 : 0;
  if (patch.slug) update.slug = await uniqueSlug(app, "track", { event_id: str(track.event_id) }, patch.slug, trackId);
  if (Object.keys(update).length === 0) return track;
  await app.db.update("track", trackId, update);
  app.audit.record({ action: "track.update", entity_type: "track", entity_id: trackId, before: track, after: update });
  return { ...track, ...update };
}

/* -------------------------------------------------------------------------- */
/* SessionFormat                                                               */
/* -------------------------------------------------------------------------- */

export interface SessionFormatInput {
  name: string;
  slug?: string | null;
  description?: string | null;
  default_duration_minutes: number;
  min_duration_minutes?: number | null;
  max_duration_minutes?: number | null;
  max_speakers?: number | null;
  eligible_origins?: Origin[];
  requires_review?: boolean;
  requires_recording_consent?: boolean;
  capacity_policy?: CapacityPolicy;
  sort_order?: number | null;
  is_public?: boolean;
}

export async function createSessionFormat(app: AppContext, eventId: string, input: SessionFormatInput): Promise<Row> {
  await eventRow(app, eventId);
  if (!input.name.trim()) fail("invalid_format", "A session format needs a name.");
  requireProblemsEmpty(durationProblems(input), "invalid_format");
  const origins = input.eligible_origins?.length ? input.eligible_origins : (["cfp"] as Origin[]);
  const count = await app.db.count("session_format", { event_id: eventId });
  const row: Row = {
    id: newId("SessionFormat"),
    event_id: eventId,
    name: input.name.trim(),
    slug: await uniqueSlug(app, "session_format", { event_id: eventId }, input.slug || input.name),
    description: input.description ?? null,
    default_duration_minutes: input.default_duration_minutes,
    min_duration_minutes: input.min_duration_minutes ?? null,
    max_duration_minutes: input.max_duration_minutes ?? null,
    max_speakers: input.max_speakers ?? 1,
    // INV-02-2: a proposal's origin must be in its format's eligible_origins.
    eligible_origins: JSON.stringify(origins),
    requires_review: input.requires_review === false ? 0 : 1,
    requires_recording_consent: input.requires_recording_consent ? 1 : 0,
    capacity_policy: input.capacity_policy ?? "open",
    sort_order: input.sort_order ?? count,
    is_public: input.is_public === false ? 0 : 1,
    deleted_at: null,
  };
  await app.db.insert("session_format", row);
  app.events.emit({
    type: "session_format.created",
    subject: { type: "format", id: str(row.id) },
    event_id: eventId,
    data: {
      format_id: str(row.id),
      name: row.name,
      slug: row.slug,
      default_duration_minutes: row.default_duration_minutes,
    },
  });
  app.audit.record({ action: "session_format.create", entity_type: "session_format", entity_id: str(row.id), after: { name: row.name } });
  return row;
}

export async function updateSessionFormat(app: AppContext, formatId: string, patch: Partial<SessionFormatInput>): Promise<Row> {
  const fmt = await app.db.byId<Row>("session_format", formatId);
  if (!fmt) throw notFound("Session format", formatId);
  const merged = {
    default_duration_minutes: patch.default_duration_minutes ?? num(fmt.default_duration_minutes),
    min_duration_minutes: patch.min_duration_minutes !== undefined ? patch.min_duration_minutes : (fmt.min_duration_minutes as number | null),
    max_duration_minutes: patch.max_duration_minutes !== undefined ? patch.max_duration_minutes : (fmt.max_duration_minutes as number | null),
    max_speakers: patch.max_speakers ?? num(fmt.max_speakers, 1),
  };
  requireProblemsEmpty(durationProblems(merged), "invalid_format");

  const update: Row = {};
  if (patch.name !== undefined && patch.name.trim()) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description || null;
  update.default_duration_minutes = merged.default_duration_minutes;
  update.min_duration_minutes = merged.min_duration_minutes ?? null;
  update.max_duration_minutes = merged.max_duration_minutes ?? null;
  update.max_speakers = merged.max_speakers;
  if (patch.eligible_origins) update.eligible_origins = JSON.stringify(patch.eligible_origins);
  if (patch.requires_review !== undefined) update.requires_review = patch.requires_review ? 1 : 0;
  if (patch.requires_recording_consent !== undefined) update.requires_recording_consent = patch.requires_recording_consent ? 1 : 0;
  if (patch.capacity_policy) update.capacity_policy = patch.capacity_policy;
  if (patch.sort_order !== undefined && patch.sort_order !== null) update.sort_order = patch.sort_order;
  if (patch.is_public !== undefined) update.is_public = patch.is_public ? 1 : 0;
  if (patch.slug) update.slug = await uniqueSlug(app, "session_format", { event_id: str(fmt.event_id) }, patch.slug, formatId);
  await app.db.update("session_format", formatId, update);
  app.audit.record({ action: "session_format.update", entity_type: "session_format", entity_id: formatId, before: fmt, after: update });
  return { ...fmt, ...update };
}

/* -------------------------------------------------------------------------- */
/* Venue and Room                                                              */
/* -------------------------------------------------------------------------- */

export interface VenueInput {
  name: string;
  address?: string | null;
  map_url?: string | null;
  timezone?: string | null;
}

/** A venue is scoped to its event; venues are not shared across years (02). */
export async function upsertVenue(app: AppContext, eventId: string, input: VenueInput, venueId?: string | null): Promise<Row> {
  const event = await eventRow(app, eventId);
  if (!input.name.trim()) fail("invalid_venue", "A venue needs a name.");
  const existing = venueId
    ? await app.db.byId<Row>("venue", venueId)
    : await app.db.first<Row>("venue", { event_id: eventId });
  const values: Row = {
    name: input.name.trim(),
    address: input.address ?? null,
    map_url: input.map_url ?? null,
    timezone: input.timezone || null, // defaults to the event timezone
  };
  if (existing) {
    await app.db.update("venue", str(existing.id), values);
    app.audit.record({ action: "venue.update", entity_type: "venue", entity_id: str(existing.id), before: existing, after: values });
    return { ...existing, ...values };
  }
  const row: Row = { id: newId("Venue"), event_id: eventId, ...values };
  await app.db.insert("venue", row);
  if (!event.venue_id) await app.db.update("event", eventId, { venue_id: str(row.id), updated_at: app.now() });
  app.audit.record({ action: "venue.create", entity_type: "venue", entity_id: str(row.id), after: values });
  return row;
}

export interface RoomInput {
  name: string;
  slug?: string | null;
  capacity?: number | null;
  floor?: string | null;
  av_capabilities?: string[];
  default_track_id?: string | null;
  sort_order?: number | null;
  is_public?: boolean;
}

export async function createRoom(app: AppContext, venueId: string, input: RoomInput): Promise<Row> {
  const venue = await app.db.byId<Row>("venue", venueId);
  if (!venue) throw notFound("Venue", venueId);
  if (!input.name.trim()) fail("invalid_room", "A room needs a name.");
  const eventId = str(venue.event_id);
  const count = await app.db.count("room", { venue_id: venueId });
  const row: Row = {
    id: newId("Room"),
    venue_id: venueId,
    event_id: eventId,
    name: input.name.trim(),
    slug: await uniqueSlug(app, "room", { venue_id: venueId }, input.slug || input.name),
    capacity: input.capacity ?? null,
    floor: input.floor ?? null,
    av_capabilities: JSON.stringify(input.av_capabilities ?? []),
    default_track_id: input.default_track_id || null,
    sort_order: input.sort_order ?? count,
    is_public: input.is_public === false ? 0 : 1,
    deleted_at: null,
  };
  await app.db.insert("room", row);
  app.events.emit({
    type: "room.created",
    subject: { type: "room", id: str(row.id) },
    event_id: eventId,
    data: { room_id: str(row.id), venue_id: venueId, name: row.name, slug: row.slug, capacity: row.capacity },
  });
  app.audit.record({ action: "room.create", entity_type: "room", entity_id: str(row.id), after: { name: row.name } });
  return row;
}

export async function updateRoom(app: AppContext, roomId: string, patch: Partial<RoomInput>): Promise<Row> {
  const room = await app.db.byId<Row>("room", roomId);
  if (!room) throw notFound("Room", roomId);
  const update: Row = {};
  if (patch.name !== undefined && patch.name.trim()) update.name = patch.name.trim();
  if (patch.capacity !== undefined) update.capacity = patch.capacity ?? null;
  if (patch.floor !== undefined) update.floor = patch.floor || null;
  if (patch.av_capabilities) update.av_capabilities = JSON.stringify(patch.av_capabilities);
  if (patch.default_track_id !== undefined) update.default_track_id = patch.default_track_id || null;
  if (patch.sort_order !== undefined && patch.sort_order !== null) update.sort_order = patch.sort_order;
  if (patch.is_public !== undefined) update.is_public = patch.is_public ? 1 : 0;
  if (patch.slug) update.slug = await uniqueSlug(app, "room", { venue_id: str(room.venue_id) }, patch.slug, roomId);
  if (Object.keys(update).length === 0) return room;
  await app.db.update("room", roomId, update);
  app.audit.record({ action: "room.update", entity_type: "room", entity_id: roomId, before: room, after: update });
  return { ...room, ...update };
}

/* -------------------------------------------------------------------------- */
/* Archiving configuration (INV-02-10)                                         */
/* -------------------------------------------------------------------------- */

const ARCHIVABLE = {
  track: { label: "Track", references: [["proposal", "track_id"], ["proposal", "assigned_track_id"], ["session", "track_id"]] },
  session_format: { label: "Session format", references: [["proposal", "session_format_id"], ["session", "session_format_id"]] },
  room: { label: "Room", references: [["placement", "room_id"]] },
} as const;

export type ArchivableTable = keyof typeof ARCHIVABLE;

export async function referenceCount(app: AppContext, table: ArchivableTable, id: string): Promise<number> {
  let total = 0;
  for (const [refTable, column] of ARCHIVABLE[table].references) {
    const rows = await app.db.raw<{ n: number }>(`SELECT COUNT(*) AS n FROM ${refTable} WHERE ${column} = ?`, [id]);
    total += num(rows[0]?.n);
  }
  return total;
}

/**
 * INV-02-10 — tracks, formats and rooms may not be hard-deleted once
 * referenced by a proposal or session; they are archived (`is_public=false`
 * plus `deleted_at`) instead. We archive unconditionally: a configuration row
 * that has never been referenced is still cheaper to keep than to explain.
 */
export async function archiveConfiguration(app: AppContext, table: ArchivableTable, id: string): Promise<Row> {
  const row = await app.db.byId<Row>(table, id);
  if (!row) throw notFound(ARCHIVABLE[table].label, id);
  const now = app.now();
  await app.db.update(table, id, { is_public: 0, deleted_at: now });
  const refs = await referenceCount(app, table, id);
  app.audit.record({
    action: `${table}.archive`,
    entity_type: table,
    entity_id: id,
    before: { is_public: bool(row.is_public), deleted_at: null },
    after: { is_public: false, deleted_at: now, referenced_by: refs },
  });
  return { ...row, is_public: 0, deleted_at: now };
}

export async function restoreConfiguration(app: AppContext, table: ArchivableTable, id: string): Promise<Row> {
  const row = await app.db.byId<Row>(table, id, { includeDeleted: true });
  if (!row) throw notFound(ARCHIVABLE[table].label, id);
  await app.db.update(table, id, { is_public: 1, deleted_at: null });
  app.audit.record({ action: `${table}.restore`, entity_type: table, entity_id: id, after: { is_public: true, deleted_at: null } });
  return { ...row, is_public: 1, deleted_at: null };
}

/* -------------------------------------------------------------------------- */
/* CallForProposals                                                            */
/* -------------------------------------------------------------------------- */

export interface CfpInput {
  name: string;
  slug?: string | null;
  audience?: CfpAudience;
  intro_markdown?: string | null;
  guidelines_url?: string | null;
  opens_at: string;
  closes_at: string;
  grace_period_minutes?: number | null;
  late_submission_policy?: LateSubmissionPolicy;
  max_proposals_per_person?: number | null;
  allow_edit_after_submit?: boolean;
  withdraw_allowed_until?: WithdrawAllowedUntil;
  notify_on_submit?: boolean;
}

/**
 * Creating a CFP creates its first `SubmissionForm` draft in the same unit of
 * work, because `active_form_id` is required (02) and a call with nowhere to
 * put an answer is not a call.
 */
export async function createCfp(
  app: AppContext,
  eventId: string,
  input: CfpInput,
  formTemplate: FormTemplateStep[] = DEFAULT_FORM_TEMPLATE,
): Promise<Row> {
  await eventRow(app, eventId);
  if (!input.name.trim()) fail("invalid_cfp", "A call for proposals needs a name.");
  // INV-02-4: closes_at > opens_at.
  requireProblemsEmpty(cfpWindowProblems({ opens_at: input.opens_at, closes_at: input.closes_at }), "invalid_cfp_window", "INV-02-4");

  const id = newId("CallForProposals");
  const now = app.now();
  const row: Row = {
    id,
    event_id: eventId,
    name: input.name.trim(),
    slug: await uniqueSlug(app, "call_for_proposals", { event_id: eventId }, input.slug || input.name),
    audience: input.audience ?? "public",
    intro_markdown: input.intro_markdown ?? null,
    guidelines_url: input.guidelines_url ?? null,
    opens_at: input.opens_at,
    closes_at: input.closes_at,
    grace_period_minutes: input.grace_period_minutes ?? 0,
    late_submission_policy: input.late_submission_policy ?? "reject",
    max_proposals_per_person: input.max_proposals_per_person ?? null,
    allow_edit_after_submit: input.allow_edit_after_submit === false ? 0 : 1,
    withdraw_allowed_until: input.withdraw_allowed_until ?? "always",
    active_form_id: null,
    notify_on_submit: input.notify_on_submit === false ? 0 : 1,
    closed_early_at: null,
    published_at: null, // the manual `publish` transition sets this
    created_at: now,
    updated_at: now,
    deleted_at: null,
    row_version: 1,
  };
  await app.db.insert("call_for_proposals", row);

  const form = await seedDefaultForm(app, id, formTemplate);
  await app.db.update("call_for_proposals", id, { active_form_id: form.id, updated_at: now });
  row.active_form_id = form.id;

  // Every track and format of the event is offered by default; the CFP
  // settings screen narrows it.
  await syncOptionsToEvent(app, id, eventId);

  app.audit.record({ action: "cfp.create", entity_type: "call_for_proposals", entity_id: id, after: { name: row.name, slug: row.slug } });
  return row;
}

async function syncOptionsToEvent(app: AppContext, cfpId: string, eventId: string): Promise<void> {
  const [tracks, formats] = await Promise.all([
    app.db.select<Row>("track", { event_id: eventId }, { orderBy: "sort_order, id" }),
    app.db.select<Row>("session_format", { event_id: eventId }, { orderBy: "sort_order, id" }),
  ]);
  for (const [i, t] of tracks.entries()) {
    const existing = await app.db.first<Row>("cfp_track_option", { cfp_id: cfpId, track_id: str(t.id) });
    if (existing) continue;
    await app.db.insert("cfp_track_option", {
      id: newId("CfpTrackOption"),
      cfp_id: cfpId,
      track_id: str(t.id),
      is_available: 1,
      max_proposals_per_person: null,
      closes_at_override: null,
      sort_order: i,
    });
  }
  for (const [i, f] of formats.entries()) {
    const existing = await app.db.first<Row>("cfp_format_option", { cfp_id: cfpId, session_format_id: str(f.id) });
    if (existing) continue;
    await app.db.insert("cfp_format_option", {
      id: newId("CfpFormatOption"),
      cfp_id: cfpId,
      session_format_id: str(f.id),
      is_available: 1,
      max_proposals_per_person: null,
      closes_at_override: null,
      sort_order: i,
    });
  }
}

export const CFP_EDITABLE_FIELDS = [
  "name",
  "audience",
  "intro_markdown",
  "guidelines_url",
  "opens_at",
  "closes_at",
  "grace_period_minutes",
  "late_submission_policy",
  "max_proposals_per_person",
  "allow_edit_after_submit",
  "withdraw_allowed_until",
  "notify_on_submit",
] as const;

export async function updateCfp(app: AppContext, cfpId: string, patch: Record<string, unknown>, expectedVersion?: number | null): Promise<Row> {
  const cfp = await cfpRow(app, cfpId);
  if ("status" in patch) {
    // `status` is derived from opens_at/closes_at/closed_early_at (INV-11-6).
    throw invariantError("INV-11-6", "derived_field_not_writable", "A call's status is derived from its window; publish, close or reopen it instead.");
  }
  const update: Row = {};
  const before: Row = {};
  for (const f of CFP_EDITABLE_FIELDS) {
    if (!(f in patch)) continue;
    let value: unknown = patch[f];
    if (f === "allow_edit_after_submit" || f === "notify_on_submit") value = value ? 1 : 0;
    if (value === "") value = null;
    if (String(value ?? "") === String(cfp[f] ?? "")) continue;
    update[f] = value ?? null;
    before[f] = cfp[f] ?? null;
  }
  if (Object.keys(update).length === 0) return cfp;

  const opensAt = str(update.opens_at ?? cfp.opens_at);
  const closesAt = str(update.closes_at ?? cfp.closes_at);

  // INV-02-4 says an override may only bring a deadline *forward*. Moving the
  // call's own close date earlier can therefore strand overrides behind it —
  // but a per-track deadline later than the call it belongs to has no meaning
  // once the call is shut, so pulling the call in pulls them in with it rather
  // than refusing the chair's edit over data they did not touch.
  if (update.closes_at !== undefined && new Date(closesAt).getTime() < new Date(str(cfp.closes_at)).getTime()) {
    await clampOverrideDeadlines(app, cfpId, closesAt);
  }

  const overrides = await overrideDeadlines(app, cfpId);
  requireProblemsEmpty(cfpWindowProblems({ opens_at: opensAt, closes_at: closesAt, overrides }), "invalid_cfp_window", "INV-02-4");

  update.updated_at = app.now();
  if (expectedVersion != null) {
    await app.db.updateVersioned("call_for_proposals", cfpId, expectedVersion, update);
  } else {
    await app.db.update("call_for_proposals", cfpId, update);
  }
  app.audit.record({ action: "cfp.update", entity_type: "call_for_proposals", entity_id: cfpId, before, after: update });
  return { ...cfp, ...update };
}

/** Pull every format/track override back to `closesAt` if it now sits after it. */
async function clampOverrideDeadlines(app: AppContext, cfpId: string, closesAt: string): Promise<void> {
  const limit = new Date(closesAt).getTime();
  for (const table of ["cfp_format_option", "cfp_track_option"] as const) {
    for (const row of await app.db.select<Row>(table, { cfp_id: cfpId })) {
      const override = strOrNull(row.closes_at_override);
      if (!override || new Date(override).getTime() <= limit) continue;
      await app.db.update(table, str(row.id), { closes_at_override: closesAt });
    }
  }
}

async function overrideDeadlines(app: AppContext, cfpId: string): Promise<(string | null)[]> {
  const [formats, tracks] = await Promise.all([
    app.db.select<Row>("cfp_format_option", { cfp_id: cfpId }),
    app.db.select<Row>("cfp_track_option", { cfp_id: cfpId }),
  ]);
  return [...formats, ...tracks].map((o) => strOrNull(o.closes_at_override));
}

export interface OptionPatch {
  id: string;
  is_available?: boolean;
  max_proposals_per_person?: number | null;
  closes_at_override?: string | null;
  sort_order?: number | null;
}

export async function updateCfpOptions(
  app: AppContext,
  cfpId: string,
  table: "cfp_format_option" | "cfp_track_option",
  patches: OptionPatch[],
): Promise<void> {
  const cfp = await cfpRow(app, cfpId);
  const closesAt = str(cfp.closes_at);
  for (const p of patches) {
    const row = await app.db.byId<Row>(table, p.id);
    if (!row || str(row.cfp_id) !== cfpId) continue;
    const update: Row = {};
    if (p.is_available !== undefined) update.is_available = p.is_available ? 1 : 0;
    if (p.max_proposals_per_person !== undefined) update.max_proposals_per_person = p.max_proposals_per_person ?? null;
    if (p.closes_at_override !== undefined) {
      // INV-02-4: an override may only bring a deadline forward.
      if (p.closes_at_override && new Date(p.closes_at_override).getTime() > new Date(closesAt).getTime()) {
        throw invariantError(
          "INV-02-4",
          "override_after_close",
          "An earlier deadline must be on or before the call's closing time.",
          { closes_at: closesAt, closes_at_override: p.closes_at_override },
        );
      }
      update.closes_at_override = p.closes_at_override || null;
    }
    if (p.sort_order !== undefined && p.sort_order !== null) update.sort_order = p.sort_order;
    if (Object.keys(update).length === 0) continue;
    await app.db.update(table, p.id, update);
  }
  app.audit.record({ action: `${table}.update`, entity_type: table, entity_id: cfpId, after: { patches } });
}

/** `draft --> scheduled | open: publish` — the only way out of `draft`. */
export async function publishCfp(app: AppContext, cfpId: string): Promise<Row> {
  const cfp = await cfpRow(app, cfpId);
  const event = await app.db.byId<Row>("event", str(cfp.event_id));
  if (!event) throw notFound("Event", str(cfp.event_id));
  if (str(event.status) !== "active") {
    // Draft events are invisible to submitters and to the public API; CFPs
    // cannot open (02, the Event state diagram's note).
    fail("event_not_active", "Activate the event before publishing a call for proposals.", 409, { event_status: str(event.status) });
  }
  if (str(cfp.published_at ?? "")) return cfp;

  // INV-02-5: a CFP cannot move to `open` without a published SubmissionForm.
  const published = await loadPublishedForm(app, cfpId);
  if (!published) {
    throw invariantError(
      "INV-02-5",
      "no_published_form",
      "Publish a submission form for this call before opening it — there is nowhere to put an answer.",
      { cfp_id: cfpId },
    );
  }
  requireProblemsEmpty(
    cfpWindowProblems({ opens_at: str(cfp.opens_at), closes_at: str(cfp.closes_at), overrides: await overrideDeadlines(app, cfpId) }),
    "invalid_cfp_window",
    "INV-02-4",
  );

  const now = app.now();
  await app.db.update("call_for_proposals", cfpId, { published_at: now, closed_early_at: null, updated_at: now });
  const status = cfpStatus(
    { opens_at: str(cfp.opens_at), closes_at: str(cfp.closes_at), published_at: now },
    str(event.status) as EventStatus,
    now,
  );
  if (status === "open") {
    app.events.emit({
      type: "cfp.opened",
      subject: { type: "cfp", id: cfpId },
      event_id: str(cfp.event_id),
      data: {
        cfp_id: cfpId,
        name: str(cfp.name),
        audience: str(cfp.audience),
        opens_at: str(cfp.opens_at),
        closes_at: str(cfp.closes_at),
      },
    });
  }
  app.audit.record({
    action: "cfp.publish",
    entity_type: "call_for_proposals",
    entity_id: cfpId,
    after: { published_at: now, derived_status: status },
  });
  return { ...cfp, published_at: now };
}

/** `open --> closed: closes_at reached / closed early`. */
export async function closeCfp(app: AppContext, cfpId: string, reason?: string | null): Promise<Row> {
  const cfp = await cfpRow(app, cfpId);
  const status = await derivedCfpStatus(app, cfp);
  if (status === "draft" || status === "scheduled") {
    throw illegalTransition("CallForProposals", status, "closed");
  }
  if (status === "closed") return cfp;
  const now = app.now();
  await app.db.update("call_for_proposals", cfpId, { closed_early_at: now, updated_at: now });
  app.events.emit({
    type: "cfp.closed",
    subject: { type: "cfp", id: cfpId },
    event_id: str(cfp.event_id),
    data: { cfp_id: cfpId, closed_early: true, proposal_count: await proposalCount(app, cfpId) },
  });
  app.audit.record({
    action: "cfp.close",
    entity_type: "call_for_proposals",
    entity_id: cfpId,
    after: { closed_early_at: now },
    reason: reason ?? null,
  });
  return { ...cfp, closed_early_at: now };
}

/**
 * `closed --> open: reopen (chair, logged)`. Logged is the point: reopening a
 * call after the bell is an override, so it carries a reason (INV-11-5).
 *
 * No `cfp.opened` is emitted — the model's event catalogue has no reopen
 * event, and re-emitting `cfp.opened` would re-run every announcement
 * reaction that fired the first time.
 */
export async function reopenCfp(app: AppContext, cfpId: string, reason: string, newClosesAt?: string | null): Promise<Row> {
  const cfp = await cfpRow(app, cfpId);
  const status = await derivedCfpStatus(app, cfp);
  if (status !== "closed") throw illegalTransition("CallForProposals", status, "open");
  if (!reason.trim()) {
    throw invariantError("INV-11-5", "reason_required", "Reopening a closed call is an override; say why.");
  }
  const now = app.now();
  const update: Row = { closed_early_at: null, updated_at: now };
  const closesAt = newClosesAt || str(cfp.closes_at);
  if (new Date(closesAt).getTime() <= new Date(now).getTime()) {
    fail(
      "reopen_needs_a_deadline",
      "This call's closing time has already passed. Give it a new closing time in the future to reopen it.",
      422,
      { closes_at: str(cfp.closes_at) },
    );
  }
  if (newClosesAt) {
    requireProblemsEmpty(
      cfpWindowProblems({ opens_at: str(cfp.opens_at), closes_at: newClosesAt, overrides: await overrideDeadlines(app, cfpId) }),
      "invalid_cfp_window",
      "INV-02-4",
    );
    update.closes_at = newClosesAt;
  }
  await app.db.update("call_for_proposals", cfpId, update);
  app.audit.record({
    action: "cfp.reopen",
    entity_type: "call_for_proposals",
    entity_id: cfpId,
    before: { closed_early_at: strOrNull(cfp.closed_early_at), closes_at: str(cfp.closes_at) },
    after: update,
    reason, // INV-11-5: overrides carry a reason.
  });
  return { ...cfp, ...update };
}

/* -------------------------------------------------------------------------- */
/* SubmissionForm                                                              */
/* -------------------------------------------------------------------------- */

async function nextVersion(app: AppContext, cfpId: string): Promise<number> {
  const rows = await app.db.raw<{ n: number }>("SELECT COALESCE(MAX(version), 0) AS n FROM submission_form WHERE cfp_id = ?", [cfpId]);
  return num(rows[0]?.n) + 1;
}

async function insertForm(app: AppContext, cfpId: string, notes: string | null): Promise<Row> {
  const row: Row = {
    id: newId("SubmissionForm"),
    cfp_id: cfpId,
    version: await nextVersion(app, cfpId),
    status: "draft",
    published_at: null,
    notes,
    created_at: app.now(),
    row_version: 1,
  };
  await app.db.insert("submission_form", row);
  return row;
}

/**
 * The conventional four-step shape (02) — every new CFP starts from it, unless
 * it is a clone, which starts from the form it was cloned from
 * (`formSpecAsTemplate`).
 */
export async function seedDefaultForm(app: AppContext, cfpId: string, template: FormTemplateStep[] = DEFAULT_FORM_TEMPLATE): Promise<Row> {
  const form = await insertForm(app, cfpId, "Created with the call.");
  const formId = str(form.id);
  for (const [si, step] of template.entries()) {
    const stepId = newId("FormStep");
    await app.db.insert("form_step", {
      id: stepId,
      form_id: formId,
      key: step.key,
      title: step.title,
      description: step.description ?? null,
      sort_order: si,
      visible_when: step.visible_when ? JSON.stringify(step.visible_when) : null,
      is_optional: step.is_optional ? 1 : 0,
    });
    for (const [fi, field] of step.fields.entries()) {
      await app.db.insert("form_field", {
        id: newId("FormField"),
        step_id: stepId,
        form_id: formId,
        key: field.key,
        label: field.label,
        help_text: field.help_text ?? null,
        placeholder: field.placeholder ?? null,
        type: field.type,
        options: field.options ? JSON.stringify(field.options) : null,
        is_required: field.is_required ? 1 : 0,
        validation: field.validation ? JSON.stringify(field.validation) : null,
        visible_when: field.visible_when ? JSON.stringify(field.visible_when) : null,
        maps_to: field.maps_to,
        audience: field.audience,
        pii: field.pii ? 1 : 0,
        sort_order: fi,
      });
    }
  }
  return form;
}

/**
 * INV-02-9 — editing a published form clones it to a new `draft` version.
 * Keys are stable across versions: reusing a key means "the same question"
 * (INV-02-6).
 */
export async function createDraftVersion(app: AppContext, cfpId: string, notes?: string | null): Promise<Row> {
  const existingDraft = await app.db.first<Row>("submission_form", { cfp_id: cfpId, status: "draft" });
  if (existingDraft) return existingDraft;
  const source = await loadPublishedForm(app, cfpId);
  const form = await insertForm(app, cfpId, notes ?? (source ? `Draft from version ${source.version}.` : "New draft."));
  const formId = str(form.id);
  if (!source) return form;

  for (const step of source.steps) {
    const stepId = newId("FormStep");
    await app.db.insert("form_step", {
      id: stepId,
      form_id: formId,
      key: step.key,
      title: step.title,
      description: step.description ?? null,
      sort_order: step.sort_order,
      visible_when: step.visible_when ? JSON.stringify(step.visible_when) : null,
      is_optional: step.is_optional ? 1 : 0,
    });
    for (const f of step.fields) {
      await app.db.insert("form_field", {
        id: newId("FormField"),
        step_id: stepId,
        form_id: formId,
        key: f.key,
        label: f.label,
        help_text: f.help_text ?? null,
        placeholder: f.placeholder ?? null,
        type: f.type,
        options: f.options ? JSON.stringify(f.options) : null,
        is_required: f.is_required ? 1 : 0,
        validation: f.validation ? JSON.stringify(f.validation) : null,
        visible_when: f.visible_when ? JSON.stringify(f.visible_when) : null,
        maps_to: f.maps_to,
        audience: f.audience,
        pii: f.pii ? 1 : 0,
        sort_order: f.sort_order,
      });
    }
  }
  app.audit.record({
    action: "submission_form.new_version",
    entity_type: "submission_form",
    entity_id: formId,
    after: { cfp_id: cfpId, version: form.version, cloned_from: source.id },
  });
  return form;
}

/**
 * The version the builder may write to. A published form is never edited in
 * place beyond cosmetics; anything structural clones (INV-02-9).
 */
async function writableForm(app: AppContext, formId: string): Promise<FormSpec> {
  const spec = await loadFormSpec(app, formId);
  if (spec.status === "draft") return spec;
  if (spec.status === "retired") {
    throw invariantError("INV-02-9", "form_retired", "This version has been retired. Edit the current draft instead.");
  }
  const draft = await createDraftVersion(app, spec.cfp_id);
  return loadFormSpec(app, str(draft.id));
}

/** Map a key from the published version onto the same key in the draft clone. */
function findByKey(spec: FormSpec, key: string): { step: FormSpec["steps"][number]; field: FormSpec["steps"][number]["fields"][number] } | null {
  for (const step of spec.steps) {
    for (const field of step.fields) if (field.key === key) return { step, field };
  }
  return null;
}

export interface StepInput {
  key?: string | null;
  title: string;
  description?: string | null;
  sort_order?: number | null;
  is_optional?: boolean;
  visible_when?: ConditionRule | null;
}

export async function addStep(app: AppContext, formId: string, input: StepInput): Promise<Row> {
  const spec = await writableForm(app, formId);
  if (!input.title.trim()) fail("invalid_step", "A step needs a title.");
  const key = slugify(input.key || input.title);
  if (spec.steps.some((s) => s.key === key)) fail("duplicate_step_key", `This form already has a step called "${key}".`, 409);
  const row: Row = {
    id: newId("FormStep"),
    form_id: spec.id,
    key,
    title: input.title.trim(),
    description: input.description ?? null,
    sort_order: input.sort_order ?? spec.steps.length,
    visible_when: input.visible_when ? JSON.stringify(input.visible_when) : null,
    is_optional: input.is_optional ? 1 : 0,
  };
  await app.db.insert("form_step", row);
  app.audit.record({ action: "form_step.create", entity_type: "form_step", entity_id: str(row.id), after: { form_id: spec.id, key } });
  return row;
}

export async function updateStep(app: AppContext, stepId: string, patch: Record<string, unknown>): Promise<Row> {
  const step = await app.db.byId<Row>("form_step", stepId);
  if (!step) throw notFound("Form step", stepId);
  const form = await loadFormSpec(app, str(step.form_id));
  let targetStepId = stepId;
  let targetFormId = form.id;

  if (form.status !== "draft") {
    if (!isCosmeticStepPatch(patch)) {
      // INV-02-9: anything beyond `title`, `description` and `sort_order`
      // clones a new version rather than mutating a published one.
      const draft = await createDraftVersion(app, form.cfp_id);
      const cloned = await loadFormSpec(app, str(draft.id));
      const match = cloned.steps.find((s) => s.key === str(step.key));
      if (!match) throw notFound("Form step", stepId);
      targetStepId = match.id;
      targetFormId = cloned.id;
    }
  }

  const update: Row = {};
  if (patch.title !== undefined && String(patch.title).trim()) update.title = String(patch.title).trim();
  if (patch.description !== undefined) update.description = patch.description || null;
  if (patch.sort_order !== undefined && patch.sort_order !== null) update.sort_order = Number(patch.sort_order);
  if (patch.is_optional !== undefined) update.is_optional = patch.is_optional ? 1 : 0;
  if (patch.visible_when !== undefined) update.visible_when = patch.visible_when ? JSON.stringify(patch.visible_when) : null;
  if (Object.keys(update).length === 0) return step;
  await app.db.update("form_step", targetStepId, update);
  app.audit.record({
    action: "form_step.update",
    entity_type: "form_step",
    entity_id: targetStepId,
    before: step,
    after: { ...update, form_id: targetFormId },
  });
  return { ...step, ...update, id: targetStepId, form_id: targetFormId };
}

export async function deleteStep(app: AppContext, stepId: string): Promise<void> {
  const step = await app.db.byId<Row>("form_step", stepId);
  if (!step) throw notFound("Form step", stepId);
  const form = await loadFormSpec(app, str(step.form_id));
  if (form.status !== "draft") {
    throw invariantError("INV-02-9", "published_form_immutable", "A published form is immutable. Create a new draft version first.");
  }
  await app.db.hardDelete("form_field", { step_id: stepId });
  await app.db.hardDelete("form_step", { id: stepId });
  app.audit.record({ action: "form_step.delete", entity_type: "form_step", entity_id: stepId, before: step });
}

export interface FieldInput {
  step_id: string;
  key?: string | null;
  label: string;
  help_text?: string | null;
  placeholder?: string | null;
  type: FieldType;
  options?: SelectOption[] | null;
  is_required?: boolean;
  validation?: Record<string, unknown> | null;
  visible_when?: ConditionRule | null;
  maps_to?: MapsTo;
  audience?: FieldAudience;
  pii?: boolean;
  identifies_speaker?: boolean;
  sort_order?: number | null;
}

export async function addField(app: AppContext, formId: string, input: FieldInput): Promise<Row> {
  const spec = await writableForm(app, formId);
  if (!input.label.trim()) fail("invalid_field", "A field needs a label.");
  const key = slugify(input.key || input.label);
  // INV-02-6: FormField.key is unique within a form.
  if (spec.steps.some((s) => s.fields.some((f) => f.key === key))) {
    throw invariantError("INV-02-6", "duplicate_field_key", `This form already has a field with the key "${key}".`, { key });
  }
  let step = spec.steps.find((s) => s.id === input.step_id);
  if (!step) {
    // The caller may hold a step id from the published version we just cloned.
    const source = await app.db.byId<Row>("form_step", input.step_id);
    step = source ? spec.steps.find((s) => s.key === str(source.key)) : undefined;
  }
  if (!step) throw notFound("Form step", input.step_id);

  const mapsTo = input.maps_to ?? "none";
  if (mapsTo !== "none") {
    const clash = spec.steps.flatMap((s) => s.fields).find((f) => f.maps_to === mapsTo);
    if (clash) {
      // INV-02-7: at most one field per form may claim a given non-`none`
      // `maps_to` value.
      throw invariantError(
        "INV-02-7",
        "duplicate_mapping",
        `"${clash.label}" already maps to ${mapsTo}. Only one field per form may.`,
        { maps_to: mapsTo, existing_field_key: clash.key },
      );
    }
  }

  const row: Row = {
    id: newId("FormField"),
    step_id: step.id,
    form_id: spec.id,
    key,
    label: input.label.trim(),
    help_text: input.help_text ?? null,
    placeholder: input.placeholder ?? null,
    type: input.type,
    options: input.options?.length ? JSON.stringify(input.options) : null,
    is_required: input.is_required ? 1 : 0,
    validation: input.validation ? JSON.stringify(input.validation) : null,
    visible_when: input.visible_when ? JSON.stringify(input.visible_when) : null,
    maps_to: mapsTo,
    audience: input.audience ?? "public",
    pii: input.pii ? 1 : 0,
    identifies_speaker: input.identifies_speaker ? 1 : 0,
    sort_order: input.sort_order ?? step.fields.length,
  };
  await app.db.insert("form_field", row);

  // INV-02-7 (type compatibility) and INV-02-8 (ordering) are checked against
  // the whole form, because both are properties of the form, not the field.
  const after = await loadFormSpec(app, spec.id);
  const problems = [...mappingProblemsFor(after, key), ...orderingProblemsFor(after, key)];
  if (problems.length > 0) {
    await app.db.hardDelete("form_field", { id: str(row.id) });
    throw new DomainError({
      code: "invalid_field",
      message: problems.join(" "),
      status: 422,
      invariant: invariantForProblems(problems),
      details: { problems },
    });
  }
  app.audit.record({ action: "form_field.create", entity_type: "form_field", entity_id: str(row.id), after: { form_id: spec.id, key } });
  return row;
}

function mappingProblemsFor(form: FormSpec, key: string): string[] {
  return mappingTypeProblems(form).filter((p) => p.startsWith(`Field "${key}"`));
}

function orderingProblemsFor(form: FormSpec, key: string): string[] {
  return validateConditionOrdering(form).filter((p) => p.startsWith(`Field "${key}"`));
}

/** Ordering failures are INV-02-8; everything else here is INV-02-7. */
function invariantForProblems(problems: string[]): string {
  return problems.some((p) => p.includes("come before")) ? "INV-02-8" : "INV-02-7";
}

export async function updateField(app: AppContext, fieldId: string, patch: Record<string, unknown>): Promise<Row> {
  const field = await app.db.byId<Row>("form_field", fieldId);
  if (!field) throw notFound("Form field", fieldId);
  const form = await loadFormSpec(app, str(field.form_id));

  if ("key" in patch && String(patch.key) !== str(field.key)) {
    if (form.status !== "draft") {
      // INV-02-6: a key is immutable once the form is published — reusing a
      // key across versions means "the same question".
      throw invariantError("INV-02-6", "field_key_immutable", "A field's key is fixed once its form is published.");
    }
  }

  let targetId = fieldId;
  let targetFormId = form.id;
  if (form.status !== "draft" && !isCosmeticFieldPatch(patch)) {
    // INV-02-9: a published FormField is immutable except for sort_order and
    // cosmetic text. Anything else clones a new version.
    const draft = await createDraftVersion(app, form.cfp_id);
    const cloned = await loadFormSpec(app, str(draft.id));
    const match = findByKey(cloned, str(field.key));
    if (!match) throw notFound("Form field", fieldId);
    targetId = match.field.id;
    targetFormId = cloned.id;
  }
  if (form.status === "retired") {
    throw invariantError("INV-02-9", "form_retired", "This version has been retired. Edit the current draft instead.");
  }

  const update: Row = {};
  if (patch.label !== undefined && String(patch.label).trim()) update.label = String(patch.label).trim();
  if (patch.help_text !== undefined) update.help_text = patch.help_text || null;
  if (patch.placeholder !== undefined) update.placeholder = patch.placeholder || null;
  if (patch.sort_order !== undefined && patch.sort_order !== null) update.sort_order = Number(patch.sort_order);
  if (patch.type !== undefined) update.type = patch.type;
  if (patch.options !== undefined) update.options = Array.isArray(patch.options) && patch.options.length ? JSON.stringify(patch.options) : null;
  if (patch.is_required !== undefined) update.is_required = patch.is_required ? 1 : 0;
  if (patch.validation !== undefined) update.validation = patch.validation ? JSON.stringify(patch.validation) : null;
  if (patch.visible_when !== undefined) update.visible_when = patch.visible_when ? JSON.stringify(patch.visible_when) : null;
  if (patch.maps_to !== undefined) update.maps_to = patch.maps_to;
  if (patch.audience !== undefined) update.audience = patch.audience;
  if (patch.pii !== undefined) update.pii = patch.pii ? 1 : 0;
  if (patch.identifies_speaker !== undefined) update.identifies_speaker = patch.identifies_speaker ? 1 : 0;
  if (patch.key !== undefined && String(patch.key).trim()) update.key = slugify(String(patch.key));
  if (Object.keys(update).length === 0) return field;

  const target = await app.db.byId<Row>("form_field", targetId);
  if (!target) throw notFound("Form field", targetId);

  if (update.maps_to && update.maps_to !== "none") {
    const spec = await loadFormSpec(app, targetFormId);
    const clash = spec.steps.flatMap((s) => s.fields).find((f) => f.maps_to === update.maps_to && f.id !== targetId);
    if (clash) {
      // INV-02-7
      throw invariantError("INV-02-7", "duplicate_mapping", `"${clash.label}" already maps to ${String(update.maps_to)}.`, {
        maps_to: update.maps_to,
      });
    }
  }
  if (update.key) {
    const spec = await loadFormSpec(app, targetFormId);
    if (spec.steps.some((s) => s.fields.some((f) => f.key === update.key && f.id !== targetId))) {
      throw invariantError("INV-02-6", "duplicate_field_key", `This form already has a field with the key "${String(update.key)}".`);
    }
  }

  await app.db.update("form_field", targetId, update);

  const after = await loadFormSpec(app, targetFormId);
  const key = str(update.key ?? target.key);
  const problems = [...mappingProblemsFor(after, key), ...orderingProblemsFor(after, key)];
  if (problems.length > 0) {
    await app.db.update("form_field", targetId, {
      type: target.type,
      options: target.options ?? null,
      maps_to: target.maps_to,
      visible_when: target.visible_when ?? null,
      key: target.key,
    });
    throw new DomainError({
      code: "invalid_field",
      message: problems.join(" "),
      status: 422,
      invariant: invariantForProblems(problems),
      details: { problems },
    });
  }

  app.audit.record({ action: "form_field.update", entity_type: "form_field", entity_id: targetId, before: target, after: update });
  return { ...target, ...update };
}

export async function deleteField(app: AppContext, fieldId: string): Promise<void> {
  const field = await app.db.byId<Row>("form_field", fieldId);
  if (!field) throw notFound("Form field", fieldId);
  const form = await loadFormSpec(app, str(field.form_id));
  if (form.status !== "draft") {
    // INV-02-9: deleting a question is structural. Clone a version first, so
    // drafts bound to the published version keep the question they answered.
    throw invariantError(
      "INV-02-9",
      "published_form_immutable",
      "A published form is immutable. Create a new draft version, then remove the field there.",
      { form_id: form.id, form_status: form.status },
    );
  }
  // A rule that referenced this field would dangle (INV-02-8).
  const dependents = form.steps
    .flatMap((s) => s.fields)
    .filter((f) => (f.visible_when?.all ?? []).some((c) => c.field === str(field.key)));
  if (dependents.length > 0) {
    throw invariantError(
      "INV-02-8",
      "field_referenced_by_condition",
      `${dependents.map((d) => `"${d.label}"`).join(", ")} is shown only when "${str(field.label)}" has a particular answer. Change that first.`,
      { dependent_field_keys: dependents.map((d) => d.key) },
    );
  }
  await app.db.hardDelete("form_field", { id: fieldId });
  app.audit.record({ action: "form_field.delete", entity_type: "form_field", entity_id: fieldId, before: field });
}

/** Reorder within a step. `sort_order` is editable even on a published form. */
export async function moveField(app: AppContext, fieldId: string, direction: "up" | "down"): Promise<void> {
  const field = await app.db.byId<Row>("form_field", fieldId);
  if (!field) throw notFound("Form field", fieldId);
  const siblings = await app.db.select<Row>("form_field", { step_id: str(field.step_id) }, { orderBy: "sort_order, id" });
  const index = siblings.findIndex((s) => str(s.id) === fieldId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= siblings.length) return;
  const a = siblings[index];
  const b = siblings[swapWith];
  await app.db.update("form_field", str(a.id), { sort_order: num(b.sort_order) });
  await app.db.update("form_field", str(b.id), { sort_order: num(a.sort_order) });

  const form = await loadFormSpec(app, str(field.form_id));
  const problems = validateConditionOrdering(form);
  if (problems.length > 0) {
    await app.db.update("form_field", str(a.id), { sort_order: num(a.sort_order) });
    await app.db.update("form_field", str(b.id), { sort_order: num(b.sort_order) });
    throw invariantError("INV-02-8", "condition_order_broken", problems.join(" "), { problems });
  }
  app.audit.record({ action: "form_field.reorder", entity_type: "form_field", entity_id: fieldId, after: { direction } });
}

export async function moveStep(app: AppContext, stepId: string, direction: "up" | "down"): Promise<void> {
  const step = await app.db.byId<Row>("form_step", stepId);
  if (!step) throw notFound("Form step", stepId);
  const siblings = await app.db.select<Row>("form_step", { form_id: str(step.form_id) }, { orderBy: "sort_order, id" });
  const index = siblings.findIndex((s) => str(s.id) === stepId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= siblings.length) return;
  const a = siblings[index];
  const b = siblings[swapWith];
  await app.db.update("form_step", str(a.id), { sort_order: num(b.sort_order) });
  await app.db.update("form_step", str(b.id), { sort_order: num(a.sort_order) });

  const form = await loadFormSpec(app, str(step.form_id));
  const problems = validateConditionOrdering(form);
  if (problems.length > 0) {
    await app.db.update("form_step", str(a.id), { sort_order: num(a.sort_order) });
    await app.db.update("form_step", str(b.id), { sort_order: num(b.sort_order) });
    throw invariantError("INV-02-8", "condition_order_broken", problems.join(" "), { problems });
  }
  app.audit.record({ action: "form_step.reorder", entity_type: "form_step", entity_id: stepId, after: { direction } });
}

/**
 * Publishing a version retires the one it replaces (INV-02-5: exactly one
 * `published` form per CFP). Existing proposal drafts keep their bound version
 * until the submitter opts into the new one.
 */
export async function publishForm(app: AppContext, formId: string): Promise<Row> {
  const spec = await loadFormSpec(app, formId);
  if (spec.status === "published") return (await app.db.byId<Row>("submission_form", formId))!;
  if (spec.status === "retired") {
    throw illegalTransition("SubmissionForm", "retired", "published", "INV-02-9");
  }
  const blockers = publishBlockers(spec);
  if (blockers.length > 0) {
    throw new DomainError({
      code: "form_not_publishable",
      message: blockers.join(" "),
      status: 422,
      // The five required mappings are INV-02-7; ordering failures are INV-02-8.
      invariant: invariantForProblems(blockers),
      details: { blockers },
    });
  }

  const previous = await loadPublishedForm(app, spec.cfp_id);
  const now = app.now();
  if (previous) {
    await app.db.update("submission_form", previous.id, { status: "retired" });
  }
  await app.db.update("submission_form", formId, { status: "published", published_at: now });
  await app.db.update("call_for_proposals", spec.cfp_id, { active_form_id: formId, updated_at: now });

  const cfp = await cfpRow(app, spec.cfp_id);
  app.events.emit({
    type: "submission_form.published",
    subject: { type: "form", id: formId },
    event_id: str(cfp.event_id),
    data: {
      form_id: formId,
      cfp_id: spec.cfp_id,
      version: spec.version,
      changed_field_keys: changedFieldKeys(previous, spec),
    },
  });
  app.audit.record({
    action: "submission_form.publish",
    entity_type: "submission_form",
    entity_id: formId,
    before: previous ? { retired_form_id: previous.id, version: previous.version } : null,
    after: { version: spec.version, published_at: now },
  });
  return (await app.db.byId<Row>("submission_form", formId))!;
}

/* -------------------------------------------------------------------------- */

export {
  builderForm,
  cfpFormatOptions,
  cfpRow,
  derivedCfpStatus,
  eventRow,
  loadFormSpec,
  loadPublishedForm,
  proposalCount,
  COSMETIC_FIELD_ATTRS,
  COSMETIC_STEP_ATTRS,
};
