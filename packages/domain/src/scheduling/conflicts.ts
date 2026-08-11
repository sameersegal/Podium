/**
 * Conflict detection — 08, "Conflict detection".
 *
 * "Conflicts are computed, surfaced, and (mostly) not enforced. The scheduler's
 * job is to tell the truth loudly; organizers knowingly break these rules under
 * deadline, and a system that refuses gets worked around in a spreadsheet."
 *
 * Pure. The caller loads the facts and persists the findings; nothing here
 * touches a binding, so every one of the eleven codes is unit-testable on a
 * constructed case.
 */

import { diffMinutes, overlaps, type CalendarDate, type Instant } from "../shared/time.js";
import { occupancy, durationMinutes, type PlacementFact } from "./placement.js";
import { CONFLICT_SEVERITIES, type ConflictCode, type ConflictSeverity } from "./types.js";

export interface SessionFact {
  id: string;
  title: string;
  duration_minutes: number;
  track_id?: string | null;
  track_name?: string | null;
  sponsor_id?: string | null;
  sponsor_name?: string | null;
  av_requirements: string[];
  capacity_override?: number | null;
  visibility: "internal" | "public" | string;
  status: string;
  /** INV-06-5, from the Onboarding read model. */
  blocking_tasks_outstanding: number;
  /** INV-06-5 / INV-06-11 — a chair knowingly publishing past a gate. */
  publication_override_reason?: string | null;
  /** Public `SessionSpeaker` person ids, in billing order. */
  speaker_person_ids: string[];
}

export interface RoomFact {
  id: string;
  name: string;
  capacity?: number | null;
  av_capabilities: string[];
  is_public: boolean;
}

export interface SlotFact {
  id: string;
  event_day_id: string;
  starts_at: Instant;
  ends_at: Instant;
  kind: string;
  room_ids: string[];
}

export interface DayFact {
  id: string;
  date: CalendarDate;
  label?: string | null;
}

/** `SessionRelation` with `relation = continues_in`: `session_id` continues in `related_session_id`. */
export interface SeriesFact {
  session_id: string;
  related_session_id: string;
}

export interface ConflictInputs {
  event_id: string;
  timezone: string;
  min_transit_minutes: number;
  placements: PlacementFact[];
  sessions: Record<string, SessionFact>;
  rooms: Record<string, RoomFact>;
  days: Record<string, DayFact>;
  slots: SlotFact[];
  series: SeriesFact[];
  people?: Record<string, string>;
}

export interface ConflictFinding {
  /**
   * Deterministic in `(event_id, code, sorted placement ids)` so that an
   * acknowledgement survives recomputation (INV-08-14).
   */
  id: string;
  event_id: string;
  code: ConflictCode;
  severity: ConflictSeverity;
  placement_ids: string[];
  session_ids: string[];
  detail: Record<string, unknown>;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Deterministic ids                                                           */
/* -------------------------------------------------------------------------- */

function fnv1a(input: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A stable, synchronous 128-bit digest. Not a security primitive — its only job
 * is that the same conflict computes the same id every time, so an
 * acknowledgement written on Tuesday is still attached on Wednesday.
 */
export function conflictId(eventId: string, code: string, placementIds: string[]): string {
  const key = `${eventId}|${code}|${[...placementIds].sort().join(",")}`;
  return (
    "scf_" +
    fnv1a(key, 0x811c9dc5) +
    fnv1a(key, 0x1000193) +
    fnv1a(key, 0x27d4eb2f) +
    fnv1a(key, 0x9e3779b9)
  );
}

function finding(
  inputs: ConflictInputs,
  code: ConflictCode,
  placements: PlacementFact[],
  detail: Record<string, unknown>,
  message: string,
): ConflictFinding {
  const placement_ids = placements.map((p) => p.id);
  return {
    id: conflictId(inputs.event_id, code, placement_ids),
    event_id: inputs.event_id,
    code,
    severity: CONFLICT_SEVERITIES[code],
    placement_ids,
    session_ids: placements.map((p) => p.session_id),
    detail,
    message,
  };
}

const title = (inputs: ConflictInputs, p: PlacementFact) => inputs.sessions[p.session_id]?.title ?? p.session_id;
const roomName = (inputs: ConflictInputs, p: PlacementFact) => inputs.rooms[p.room_id]?.name ?? p.room_id;

/* -------------------------------------------------------------------------- */
/* The detector                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every conflict in the table, computed over one event's placements. The result
 * is sorted so that two runs over the same facts produce the same list.
 */
export function detectConflicts(inputs: ConflictInputs): ConflictFinding[] {
  const out: ConflictFinding[] = [];
  const placements = [...inputs.placements].sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : a.id < b.id ? -1 : 1));

  for (const p of placements) {
    const session = inputs.sessions[p.session_id];
    if (!session) continue;

    // DURATION_MISMATCH (error): `ends_at - starts_at != Session.duration_minutes`.
    const actual = durationMinutes(p);
    if (session.duration_minutes > 0 && actual !== session.duration_minutes) {
      out.push(
        finding(inputs, "DURATION_MISMATCH", [p], { expected_minutes: session.duration_minutes, actual_minutes: actual }, `"${session.title}" is a ${session.duration_minutes}-minute session in a ${actual}-minute slot.`),
      );
    }

    const room = inputs.rooms[p.room_id];

    // AV_UNSUPPORTED (warning): `Session.av_requirements` not covered by `Room.av_capabilities`.
    if (room && session.av_requirements.length > 0) {
      const missing = session.av_requirements.filter((r) => !room.av_capabilities.includes(r));
      if (missing.length > 0) {
        out.push(
          finding(inputs, "AV_UNSUPPORTED", [p], { missing, room_id: room.id, room_name: room.name }, `${room.name} has no ${missing.join(", ").replace(/_/g, " ")} for "${session.title}".`),
        );
      }
    }

    // OVER_CAPACITY (warning): expected demand exceeds `Room.capacity`.
    const expected = session.capacity_override ?? null;
    if (room && room.capacity != null && expected != null && expected > room.capacity) {
      out.push(
        finding(inputs, "OVER_CAPACITY", [p], { expected, capacity: room.capacity, room_id: room.id }, `"${session.title}" expects ${expected} people in ${room.name}, which holds ${room.capacity}.`),
      );
    }

    // UNPUBLISHABLE (error): outstanding blocking onboarding tasks (INV-06-5).
    if (session.blocking_tasks_outstanding > 0 && !session.publication_override_reason) {
      out.push(
        finding(inputs, "UNPUBLISHABLE", [p], { blocking_tasks_outstanding: session.blocking_tasks_outstanding }, `"${session.title}" has ${session.blocking_tasks_outstanding} blocking onboarding task${session.blocking_tasks_outstanding === 1 ? "" : "s"} outstanding.`),
      );
    }

    // OUTSIDE_EVENT_HOURS (warning): the placement falls outside its event
    // day's slots. Skipped entirely when the day has no grid — the grid is a
    // convenience, not a requirement (08, "TimeSlot").
    const daySlots = inputs.slots.filter(
      (s) => s.event_day_id === p.event_day_id && (s.room_ids.length === 0 || s.room_ids.includes(p.room_id)),
    );
    if (daySlots.length > 0 && !coveredBySlots(p, daySlots)) {
      out.push(
        finding(inputs, "OUTSIDE_EVENT_HOURS", [p], { event_day_id: p.event_day_id, slot_count: daySlots.length }, `"${session.title}" runs outside the published hours for ${inputs.days[p.event_day_id]?.label ?? inputs.days[p.event_day_id]?.date ?? "that day"}.`),
      );
    }
  }

  // Pairwise codes.
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i];
      const b = placements[j];
      const sa = inputs.sessions[a.session_id];
      const sb = inputs.sessions[b.session_id];
      if (!sa || !sb) continue;

      const oa = occupancy(a);
      const ob = occupancy(b);
      const roomsClash = a.room_id === b.room_id && overlaps(oa.from, oa.to, ob.from, ob.to);
      const running = overlaps(a.starts_at, a.ends_at, b.starts_at, b.ends_at);

      // ROOM_DOUBLE_BOOKED (error): two placements overlap in one room,
      // counting setup/teardown.
      if (roomsClash) {
        out.push(
          finding(inputs, "ROOM_DOUBLE_BOOKED", [a, b], { room_id: a.room_id, room_name: roomName(inputs, a), a: oa, b: ob }, `${roomName(inputs, a)} holds both "${sa.title}" and "${sb.title}" at once.`),
        );
      }

      const shared = sa.speaker_person_ids.filter((id) => sb.speaker_person_ids.includes(id));
      if (shared.length > 0) {
        // SPEAKER_DOUBLE_BOOKED (error): a person is a public speaker on two
        // overlapping placements.
        if (running) {
          out.push(
            finding(inputs, "SPEAKER_DOUBLE_BOOKED", [a, b], { person_ids: shared, person_names: shared.map((id) => inputs.people?.[id] ?? id) }, `${shared.map((id) => inputs.people?.[id] ?? id).join(", ")} is on both "${sa.title}" and "${sb.title}" at the same time.`),
          );
        } else if (a.room_id !== b.room_id) {
          // SPEAKER_NO_TRANSIT (warning): back-to-back in different rooms with
          // a gap below the event's `min_transit_minutes`.
          const [first, second] = a.starts_at <= b.starts_at ? [a, b] : [b, a];
          const gap = diffMinutes(second.starts_at, first.ends_at);
          if (gap >= 0 && gap < inputs.min_transit_minutes) {
            out.push(
              finding(inputs, "SPEAKER_NO_TRANSIT", [first, second], { gap_minutes: gap, min_transit_minutes: inputs.min_transit_minutes, person_ids: shared }, `${shared.map((id) => inputs.people?.[id] ?? id).join(", ")} has ${gap} minute${gap === 1 ? "" : "s"} to get from ${roomName(inputs, first)} to ${roomName(inputs, second)}.`),
            );
          }
        }
      }

      // TRACK_COLLISION (warning): two same-track sessions run concurrently.
      if (running && sa.track_id && sa.track_id === sb.track_id) {
        out.push(
          finding(inputs, "TRACK_COLLISION", [a, b], { track_id: sa.track_id, track_name: sa.track_name ?? null }, `"${sa.title}" and "${sb.title}" are both ${sa.track_name ?? "the same track"} and run at once.`),
        );
      }

      // SPONSOR_COLLISION (warning): two sessions from the same sponsor overlap.
      if (running && sa.sponsor_id && sa.sponsor_id === sb.sponsor_id) {
        out.push(
          finding(inputs, "SPONSOR_COLLISION", [a, b], { sponsor_id: sa.sponsor_id, sponsor_name: sa.sponsor_name ?? null }, `${sa.sponsor_name ?? "One sponsor"} has "${sa.title}" and "${sb.title}" overlapping.`),
        );
      }
    }
  }

  // SERIES_OUT_OF_ORDER (error): a `continues_in` relation placed before its
  // predecessor, or in a different room.
  const bySession = new Map(placements.map((p) => [p.session_id, p]));
  for (const rel of inputs.series) {
    const first = bySession.get(rel.session_id);
    const next = bySession.get(rel.related_session_id);
    if (!first || !next) continue;
    const outOfOrder = new Date(next.starts_at).getTime() < new Date(first.ends_at).getTime();
    const wrongRoom = next.room_id !== first.room_id;
    if (outOfOrder || wrongRoom) {
      out.push(
        finding(
          inputs,
          "SERIES_OUT_OF_ORDER",
          [first, next],
          { out_of_order: outOfOrder, different_room: wrongRoom, first_room: first.room_id, next_room: next.room_id },
          wrongRoom && outOfOrder
            ? `"${title(inputs, next)}" continues "${title(inputs, first)}" but starts earlier and in a different room.`
            : wrongRoom
              ? `"${title(inputs, next)}" continues "${title(inputs, first)}" but is in ${roomName(inputs, next)} rather than ${roomName(inputs, first)}.`
              : `"${title(inputs, next)}" continues "${title(inputs, first)}" but is placed before it finishes.`,
        ),
      );
    }
  }

  out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Is the placement's whole span inside the union of the day's slots? */
function coveredBySlots(p: PlacementFact, slots: SlotFact[]): boolean {
  const intervals = slots
    .map((s) => ({ from: new Date(s.starts_at).getTime(), to: new Date(s.ends_at).getTime() }))
    .sort((a, b) => a.from - b.from);
  let cursor = new Date(p.starts_at).getTime();
  const end = new Date(p.ends_at).getTime();
  for (const iv of intervals) {
    if (iv.from > cursor) break; // a gap the placement falls into
    if (iv.to > cursor) cursor = iv.to;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

/** INV-08-4: `error`-severity conflicts block publication. */
export function blockingConflicts(findings: ConflictFinding[]): ConflictFinding[] {
  return findings.filter((f) => f.severity === "error");
}

/** The session ids an unacknowledged, unoverridden error conflict touches. */
export function sessionsBlockedFromPublication(
  findings: ConflictFinding[],
  acknowledged: Set<string> = new Set(),
): Map<string, ConflictFinding[]> {
  const out = new Map<string, ConflictFinding[]>();
  for (const f of blockingConflicts(findings)) {
    if (acknowledged.has(f.id)) continue;
    for (const sid of f.session_ids) {
      out.set(sid, [...(out.get(sid) ?? []), f]);
    }
  }
  return out;
}
