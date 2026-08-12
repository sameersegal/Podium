/**
 * Loading one event's schedule into the pure domain's fact shapes.
 *
 * Everything the conflict detector and the solver need arrives here, in a
 * bounded number of queries, so the pure layer stays free of I/O and the
 * Durable Object's critical section stays short.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import type { ConflictInputs, DayFact, RoomFact, SeriesFact, SessionFact, SlotFact } from "@podiumstack/domain/scheduling/conflicts.js";
import type { PlacementFact } from "@podiumstack/domain/scheduling/placement.js";
import { SCHEDULING_DEFAULTS, type PlacementStatus } from "@podiumstack/domain/scheduling/types.js";

export interface EventFact {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  timezone: string;
  starts_on: string;
  ends_on: string;
  status: string;
  visibility: string;
  website_url: string | null;
  venue_id: string | null;
  logo_asset_id: string | null;
  settings: Record<string, unknown>;
}

export function toEventFact(row: Row): EventFact {
  return {
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    tagline: strOrNull(row.tagline),
    description: strOrNull(row.description),
    timezone: str(row.timezone, "UTC"),
    starts_on: str(row.starts_on),
    ends_on: str(row.ends_on),
    status: str(row.status),
    visibility: str(row.visibility),
    website_url: strOrNull(row.website_url),
    venue_id: strOrNull(row.venue_id),
    logo_asset_id: strOrNull(row.logo_asset_id),
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
  };
}

function section(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = settings[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** `Event.settings.scheduling.min_transit_minutes` — 08, SPEAKER_NO_TRANSIT. */
export function minTransitMinutes(ev: EventFact): number {
  const v = section(ev.settings, "scheduling").min_transit_minutes;
  return typeof v === "number" && v >= 0 ? v : SCHEDULING_DEFAULTS.min_transit_minutes;
}

/** `Event.settings.publication.auto_publish` — R25, default off. */
export function autoPublishEnabled(ev: EventFact): boolean {
  return section(ev.settings, "publication").auto_publish === true;
}

export function toPlacementFact(row: Row): PlacementFact {
  return {
    id: str(row.id),
    session_id: str(row.session_id),
    room_id: str(row.room_id),
    event_day_id: str(row.event_day_id),
    time_slot_id: strOrNull(row.time_slot_id),
    starts_at: str(row.starts_at),
    ends_at: str(row.ends_at),
    setup_minutes: num(row.setup_minutes),
    teardown_minutes: num(row.teardown_minutes),
    status: str(row.status, "tentative") as PlacementStatus,
    is_public: bool(row.is_public),
  };
}

export function toRoomFact(row: Row): RoomFact {
  return {
    id: str(row.id),
    name: str(row.name),
    capacity: row.capacity === null || row.capacity === undefined ? null : num(row.capacity),
    av_capabilities: parseJson<string[]>(row.av_capabilities, []),
    is_public: bool(row.is_public),
  };
}

export function toSlotFact(row: Row): SlotFact {
  return {
    id: str(row.id),
    event_day_id: str(row.event_day_id),
    starts_at: str(row.starts_at),
    ends_at: str(row.ends_at),
    kind: str(row.kind, "session"),
    room_ids: parseJson<string[]>(row.room_ids, []),
  };
}

export function toDayFact(row: Row): DayFact {
  return { id: str(row.id), date: str(row.date), label: strOrNull(row.label) };
}

export interface ScheduleFacts extends ConflictInputs {
  event: EventFact;
  roomRows: Row[];
  dayRows: Row[];
  sessionRows: Row[];
  placementRows: Row[];
  slotRows: Row[];
}

/**
 * One event's whole schedule. Reads are org-scoped and soft-delete filtered in
 * the repository layer (INV-11-1, INV-11-2).
 */
export async function loadScheduleFacts(app: AppContext, eventId: string): Promise<ScheduleFacts> {
  const eventRow = await app.db.byId<Row>("event", eventId);
  if (!eventRow) throw new Error(`event ${eventId} not found`);
  const event = toEventFact(eventRow);

  const [dayRows, roomRows, slotRows, placementRows, sessionRows, trackRows] = await Promise.all([
    app.db.select<Row>("event_day", { event_id: eventId }, { orderBy: "sort_order, date" }),
    app.db.select<Row>("room", { event_id: eventId }, { orderBy: "sort_order, name" }),
    app.db.select<Row>("time_slot", { event_id: eventId }, { orderBy: "sort_order, starts_at" }),
    app.db.select<Row>("placement", { event_id: eventId }, { orderBy: "starts_at" }),
    app.db.select<Row>("session", { event_id: eventId }),
    app.db.select<Row>("track", { event_id: eventId }),
  ]);

  const sessionIds = sessionRows.map((s) => str(s.id));
  const [speakerRows, relationRows, blockingRows, sponsorRows] = await Promise.all([
    sessionIds.length
      ? app.db.select<Row>("session_speaker", { session_id: sessionIds })
      : Promise.resolve([] as Row[]),
    sessionIds.length ? app.db.select<Row>("session_relation", { session_id: sessionIds }) : Promise.resolve([] as Row[]),
    // The blocking-task count is Onboarding's fact (INV-06-5); read as one
    // aggregate rather than per session so a placement write stays one round of
    // queries. The authoritative readiness check at publish time goes through
    // the Program context's `publicationReadiness`.
    app.db.raw<{ session_id: string; n: number }>(
      `SELECT session_id, COUNT(*) AS n FROM task_instance
        WHERE event_id = ? AND is_blocking = 1 AND session_id IS NOT NULL
          AND status NOT IN ('completed','waived','cancelled')
        GROUP BY session_id`,
      [eventId],
    ),
    app.db.select<Row>("sponsor", {}),
  ]);

  const trackById = new Map(trackRows.map((t) => [str(t.id), t]));
  const sponsorById = new Map(sponsorRows.map((s) => [str(s.id), s]));
  const blockingBySession = new Map(blockingRows.map((r) => [str(r.session_id), num(r.n)]));

  const speakersBySession = new Map<string, string[]>();
  for (const sp of speakerRows) {
    // Only *public* speakers count for SPEAKER_DOUBLE_BOOKED — a person on the
    // run sheet but not the website is still a person who cannot be in two
    // rooms, so `replaced` is the only status excluded.
    if (str(sp.confirmation_status) === "replaced") continue;
    const sid = str(sp.session_id);
    speakersBySession.set(sid, [...(speakersBySession.get(sid) ?? []), str(sp.person_id)]);
  }

  const sessions: Record<string, SessionFact> = {};
  for (const row of sessionRows) {
    const id = str(row.id);
    const track = row.track_id ? trackById.get(str(row.track_id)) : null;
    const sponsor = row.sponsor_id ? sponsorById.get(str(row.sponsor_id)) : null;
    sessions[id] = {
      id,
      title: str(row.title),
      duration_minutes: num(row.duration_minutes),
      track_id: strOrNull(row.track_id),
      track_name: track ? str(track.name) : null,
      sponsor_id: strOrNull(row.sponsor_id),
      sponsor_name: sponsor ? str(sponsor.display_name) || str(sponsor.name) : null,
      av_requirements: parseJson<string[]>(row.av_requirements, []),
      capacity_override: row.capacity_override === null || row.capacity_override === undefined ? null : num(row.capacity_override),
      visibility: str(row.visibility, "public"),
      status: str(row.status),
      blocking_tasks_outstanding: blockingBySession.get(id) ?? 0,
      publication_override_reason: strOrNull(row.publication_override_reason),
      speaker_person_ids: speakersBySession.get(id) ?? [],
    };
  }

  const personIds = [...new Set(speakerRows.map((s) => str(s.person_id)))];
  const personRows = personIds.length ? await app.db.select<Row>("person", { id: personIds }) : [];
  const people: Record<string, string> = {};
  for (const p of personRows) people[str(p.id)] = str(p.display_name) || str(p.full_name);

  const days: Record<string, DayFact> = {};
  for (const d of dayRows) days[str(d.id)] = toDayFact(d);

  const rooms: Record<string, RoomFact> = {};
  for (const r of roomRows) rooms[str(r.id)] = toRoomFact(r);

  const series: SeriesFact[] = relationRows
    .filter((r) => str(r.relation) === "continues_in")
    .map((r) => ({ session_id: str(r.session_id), related_session_id: str(r.related_session_id) }));

  return {
    event,
    event_id: eventId,
    timezone: event.timezone,
    min_transit_minutes: minTransitMinutes(event),
    placements: placementRows.map(toPlacementFact),
    sessions,
    rooms,
    days,
    slots: slotRows.map(toSlotFact),
    series,
    people,
    roomRows,
    dayRows,
    sessionRows,
    placementRows,
    slotRows,
  };
}
