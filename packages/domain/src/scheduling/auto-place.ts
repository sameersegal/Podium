/**
 * Assisted placement — 08, "Assisted placement", and R26.
 *
 * A **constraint solver produces the schedule**; a language model would refine
 * one. This is the solver: hard constraints filter the candidate set, soft
 * preferences score what survives, and every proposal carries a `rationale`
 * because an organizer accepting 120 moves needs to spot the four that are
 * wrong.
 *
 * Two rules from the model shape the whole function:
 *   * INV-08-15 — it never mutates an existing placement. Existing placements
 *     are read-only obstacles, `locked` or not.
 *   * `unplaceable` is said out loud, never silently dropped.
 */

import { addMinutes, diffMinutes, overlaps, zonedDateTimeToInstant, type Instant } from "../shared/time.js";
import { occupancy, type PlacementFact } from "./placement.js";
import type { ConflictInputs, DayFact, RoomFact, SeriesFact, SessionFact, SlotFact } from "./conflicts.js";
import { SCHEDULING_DEFAULTS, type AutoPlaceStrategy } from "./types.js";

export interface AutoPlaceScope {
  session_ids?: string[];
  track_ids?: string[];
  event_day_ids?: string[];
  room_ids?: string[];
}

export interface AutoPlaceInputs {
  event_id: string;
  timezone: string;
  min_transit_minutes: number;
  strategy: AutoPlaceStrategy;
  scope?: AutoPlaceScope | null;
  /** Sessions with no placement, in reference order. */
  candidates: SessionFact[];
  /** Everything already on the board. Never moved (INV-08-15). */
  existing: PlacementFact[];
  sessions: Record<string, SessionFact>;
  rooms: RoomFact[];
  days: DayFact[];
  slots: SlotFact[];
  series: SeriesFact[];
}

export interface ProposedPlacement {
  session_id: string;
  room_id: string;
  event_day_id: string;
  starts_at: Instant;
  ends_at: Instant;
  /** Required either way — a solver's output has to be explainable. */
  rationale: string;
}

export interface UnplaceableSession {
  session_id: string;
  reason: string;
}

export interface AutoPlaceResult {
  proposed: ProposedPlacement[];
  unplaceable: UnplaceableSession[];
}

interface Candidate {
  room: RoomFact;
  day: DayFact;
  starts_at: Instant;
  ends_at: Instant;
  slot?: SlotFact;
}

export function autoPlace(inputs: AutoPlaceInputs): AutoPlaceResult {
  const scope = inputs.scope ?? {};
  const rooms = inputs.rooms.filter((r) => !scope.room_ids?.length || scope.room_ids.includes(r.id));
  const days = inputs.days.filter((d) => !scope.event_day_ids?.length || scope.event_day_ids.includes(d.id));

  const candidates = inputs.candidates.filter((s) => {
    if (scope.session_ids?.length && !scope.session_ids.includes(s.id)) return false;
    if (scope.track_ids?.length && (!s.track_id || !scope.track_ids.includes(s.track_id))) return false;
    return true;
  });

  const proposed: ProposedPlacement[] = [];
  const unplaceable: UnplaceableSession[] = [];

  if (rooms.length === 0 || days.length === 0) {
    for (const s of candidates) {
      unplaceable.push({ session_id: s.id, reason: rooms.length === 0 ? "No rooms are available for this event." : "No event days are available." });
    }
    return { proposed, unplaceable };
  }

  // Placements the solver must work around: everything already on the board,
  // plus what it has proposed so far in this run.
  const obstacles: PlacementFact[] = [...inputs.existing];
  const proposedBySession = new Map<string, ProposedPlacement>();

  for (const session of orderCandidates(candidates, inputs)) {
    if (session.duration_minutes <= 0) {
      unplaceable.push({ session_id: session.id, reason: "The session has no duration, so there is no slot to fit it into." });
      continue;
    }

    const reasons = new Set<string>();
    let best: { candidate: Candidate; score: number; notes: string[] } | null = null;

    for (const day of days) {
      for (const room of rooms) {
        for (const candidate of candidateSlots(session, room, day, inputs)) {
          const verdict = feasible(session, candidate, obstacles, proposedBySession, inputs);
          if (!verdict.ok) {
            reasons.add(verdict.reason);
            continue;
          }
          const scored = score(session, candidate, obstacles, inputs);
          if (!best || scored.score > best.score) best = { candidate, score: scored.score, notes: scored.notes };
        }
      }
    }

    if (!best) {
      unplaceable.push({
        session_id: session.id,
        reason: reasons.size ? [...reasons].slice(0, 3).join(" ") : "No free room and time could satisfy this session's constraints.",
      });
      continue;
    }

    const placement: ProposedPlacement = {
      session_id: session.id,
      room_id: best.candidate.room.id,
      event_day_id: best.candidate.day.id,
      starts_at: best.candidate.starts_at,
      ends_at: best.candidate.ends_at,
      rationale: best.notes.join(" "),
    };
    proposed.push(placement);
    proposedBySession.set(session.id, placement);
    obstacles.push({
      id: `proposed:${session.id}`,
      session_id: session.id,
      room_id: placement.room_id,
      event_day_id: placement.event_day_id,
      starts_at: placement.starts_at,
      ends_at: placement.ends_at,
      setup_minutes: 0,
      teardown_minutes: 0,
      status: "tentative",
      is_public: true,
    });
  }

  proposed.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : a.room_id < b.room_id ? -1 : 1));
  return { proposed, unplaceable };
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

function orderCandidates(candidates: SessionFact[], inputs: AutoPlaceInputs): SessionFact[] {
  // Series predecessors always come first, whatever the strategy: a part 2
  // placed before part 1 exists has nothing to be sticky to.
  const successors = new Set(inputs.series.map((r) => r.related_session_id));
  const list = [...candidates];

  if (inputs.strategy === "balance_tracks") {
    // Round-robin across tracks so no track is packed into one corner of the day.
    const byTrack = new Map<string, SessionFact[]>();
    for (const s of list) {
      const key = s.track_id ?? "";
      byTrack.set(key, [...(byTrack.get(key) ?? []), s]);
    }
    const queues = [...byTrack.values()].map((q) => q.sort((a, b) => b.duration_minutes - a.duration_minutes));
    const out: SessionFact[] = [];
    let more = true;
    while (more) {
      more = false;
      for (const q of queues) {
        const next = q.shift();
        if (next) {
          out.push(next);
          more = true;
        }
      }
    }
    return out.sort((a, b) => Number(successors.has(a.id)) - Number(successors.has(b.id)));
  }

  if (inputs.strategy === "respect_preferences") {
    // Hardest-to-satisfy first: AV requirements, then capacity, then length.
    list.sort(
      (a, b) =>
        b.av_requirements.length - a.av_requirements.length ||
        (b.capacity_override ?? 0) - (a.capacity_override ?? 0) ||
        b.duration_minutes - a.duration_minutes,
    );
    return list.sort((a, b) => Number(successors.has(a.id)) - Number(successors.has(b.id)));
  }

  // greedy_fill: longest first, which wastes the least room-time.
  list.sort((a, b) => b.duration_minutes - a.duration_minutes || (a.id < b.id ? -1 : 1));
  return list.sort((a, b) => Number(successors.has(a.id)) - Number(successors.has(b.id)));
}

/* -------------------------------------------------------------------------- */
/* Candidate generation                                                        */
/* -------------------------------------------------------------------------- */

function candidateSlots(session: SessionFact, room: RoomFact, day: DayFact, inputs: AutoPlaceInputs): Candidate[] {
  const daySlots = inputs.slots
    .filter((s) => s.event_day_id === day.id && (s.room_ids.length === 0 || s.room_ids.includes(room.id)))
    .filter((s) => s.kind === "session" || s.kind === "keynote")
    .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));

  // Gridded: the slots are the candidates (08, "TimeSlot" — a convenience for
  // placement and validation).
  if (daySlots.length > 0) {
    return daySlots
      .filter((s) => diffMinutes(s.ends_at, s.starts_at) >= session.duration_minutes)
      .map((s) => ({ room, day, slot: s, starts_at: s.starts_at, ends_at: addMinutes(s.starts_at, session.duration_minutes) }));
  }

  // Free placement: pack against the day window and whatever already sits in
  // this room, at the top of each half hour.
  const windowStart = zonedDateTimeToInstant(day.date, SCHEDULING_DEFAULTS.day_start_time, inputs.timezone);
  const windowEnd = zonedDateTimeToInstant(day.date, SCHEDULING_DEFAULTS.day_end_time, inputs.timezone);
  const out: Candidate[] = [];
  for (let t = new Date(windowStart).getTime(); ; t += 30 * 60_000) {
    const starts_at = new Date(t).toISOString();
    const ends_at = addMinutes(starts_at, session.duration_minutes);
    if (new Date(ends_at).getTime() > new Date(windowEnd).getTime()) break;
    out.push({ room, day, starts_at, ends_at });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Hard constraints                                                            */
/* -------------------------------------------------------------------------- */

function feasible(
  session: SessionFact,
  candidate: Candidate,
  obstacles: PlacementFact[],
  proposedBySession: Map<string, ProposedPlacement>,
  inputs: AutoPlaceInputs,
): { ok: true } | { ok: false; reason: string } {
  const span = { from: candidate.starts_at, to: candidate.ends_at };

  // Room availability, counting every existing placement's setup/teardown.
  for (const o of obstacles) {
    if (o.room_id !== candidate.room.id) continue;
    const oc = occupancy(o);
    if (overlaps(span.from, span.to, oc.from, oc.to)) {
      return { ok: false, reason: `${candidate.room.name} is already booked at that time.` };
    }
  }

  // Speaker availability across overlapping slots.
  if (session.speaker_person_ids.length > 0) {
    for (const o of obstacles) {
      if (!overlaps(span.from, span.to, o.starts_at, o.ends_at)) continue;
      const other = inputs.sessions[o.session_id];
      if (!other) continue;
      if (other.speaker_person_ids.some((p) => session.speaker_person_ids.includes(p))) {
        return { ok: false, reason: "Its speaker is already on stage at every remaining time." };
      }
    }
  }

  // Room AV against `Session.av_requirements`.
  const missing = session.av_requirements.filter((r) => !candidate.room.av_capabilities.includes(r));
  if (missing.length > 0) {
    return { ok: false, reason: `No available room has ${missing.join(", ").replace(/_/g, " ")}.` };
  }

  // Room capacity.
  if (session.capacity_override != null && candidate.room.capacity != null && session.capacity_override > candidate.room.capacity) {
    return { ok: false, reason: `No available room is large enough for ${session.capacity_override} people.` };
  }

  // `SessionRelation.continues_in` ordering and room stickiness.
  for (const rel of inputs.series) {
    if (rel.related_session_id === session.id) {
      const predecessor = placementOf(rel.session_id, obstacles, proposedBySession);
      if (!predecessor) return { ok: false, reason: "The earlier part of this series is not placed yet." };
      if (predecessor.room_id !== candidate.room.id) {
        return { ok: false, reason: "It must stay in the same room as the earlier part of its series." };
      }
      if (new Date(candidate.starts_at).getTime() < new Date(predecessor.ends_at).getTime()) {
        return { ok: false, reason: "It must start after the earlier part of its series finishes." };
      }
    }
    if (rel.session_id === session.id) {
      const successor = placementOf(rel.related_session_id, obstacles, proposedBySession);
      if (successor && new Date(successor.starts_at).getTime() < new Date(candidate.ends_at).getTime()) {
        return { ok: false, reason: "Its continuation is already placed earlier." };
      }
    }
  }

  return { ok: true };
}

function placementOf(
  sessionId: string,
  obstacles: PlacementFact[],
  proposedBySession: Map<string, ProposedPlacement>,
): { room_id: string; starts_at: Instant; ends_at: Instant } | null {
  const proposed = proposedBySession.get(sessionId);
  if (proposed) return proposed;
  const existing = obstacles.find((o) => o.session_id === sessionId);
  return existing ?? null;
}

/* -------------------------------------------------------------------------- */
/* Soft preferences                                                            */
/* -------------------------------------------------------------------------- */

function score(
  session: SessionFact,
  candidate: Candidate,
  obstacles: PlacementFact[],
  inputs: AutoPlaceInputs,
): { score: number; notes: string[] } {
  const notes: string[] = [];
  let value = 1000;

  // Earlier is better, so the day fills front to back rather than scattering.
  value -= new Date(candidate.starts_at).getTime() / 1_000_000_000;

  // Track spread: penalise a same-track session running concurrently.
  let concurrentSameTrack = 0;
  for (const o of obstacles) {
    if (!overlaps(candidate.starts_at, candidate.ends_at, o.starts_at, o.ends_at)) continue;
    const other = inputs.sessions[o.session_id];
    if (other?.track_id && other.track_id === session.track_id) concurrentSameTrack++;
  }
  value -= concurrentSameTrack * 50;
  if (concurrentSameTrack === 0 && session.track_id) notes.push(`No other ${session.track_name ?? "same-track"} session runs at this time.`);

  // Right-sized room: prefer the smallest room that still fits.
  if (candidate.room.capacity != null) {
    const need = session.capacity_override ?? 0;
    value -= Math.max(0, candidate.room.capacity - need) / 100;
    notes.push(need ? `${candidate.room.name} seats ${candidate.room.capacity}, enough for the expected ${need}.` : `${candidate.room.name} seats ${candidate.room.capacity}.`);
  } else {
    notes.push(`${candidate.room.name} is free at this time.`);
  }

  if (candidate.slot) {
    value += 25; // aligning to the grid is preferred where a grid exists
    notes.unshift(`Fits the ${candidate.slot.kind} slot starting ${candidate.slot.starts_at}.`);
  }

  if (session.av_requirements.length > 0) {
    notes.push(`AV needed (${session.av_requirements.join(", ").replace(/_/g, " ")}) is available there.`);
  }

  const series = inputs.series.find((r) => r.related_session_id === session.id);
  if (series) notes.push("Kept in the same room and after the earlier part of its series.");

  if (session.speaker_person_ids.length > 0) notes.push("No speaker clash and enough transit time.");

  return { score: value, notes };
}

/**
 * `AutoPlaceRun.conflicts_introduced` is derived (`D`): the conflicts the
 * proposal *would* create, recomputed against the current board rather than
 * frozen at proposal time.
 */
export function proposalAsPlacements(proposed: ProposedPlacement[]): PlacementFact[] {
  return proposed.map((p, i) => ({
    id: `proposed_${i}_${p.session_id}`,
    session_id: p.session_id,
    room_id: p.room_id,
    event_day_id: p.event_day_id,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    setup_minutes: 0,
    teardown_minutes: 0,
    status: "tentative" as const,
    is_public: true,
  }));
}

export type { ConflictInputs };
