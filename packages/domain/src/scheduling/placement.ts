/**
 * Placement rules — 08, "Placement".
 *
 * Times live on the placement, not the session. A session has a *duration*; a
 * placement gives it a *when* and a *where*. Pure: no I/O, no bindings.
 */

import { illegalTransition, invariantError } from "../shared/errors.js";
import { calendarDateInZone, diffMinutes, isAfter, type CalendarDate, type Instant } from "../shared/time.js";
import { PLACEABLE_SESSION_STATUS, type PlaceableSessionStatus, type PlacementStatus } from "./types.js";

export interface PlacementFact {
  id: string;
  session_id: string;
  room_id: string;
  event_day_id: string;
  time_slot_id?: string | null;
  starts_at: Instant;
  ends_at: Instant;
  setup_minutes: number;
  teardown_minutes: number;
  status: PlacementStatus;
  is_public: boolean;
}

/** The occupied interval of a room, counting setup and teardown. */
export function occupancy(p: Pick<PlacementFact, "starts_at" | "ends_at" | "setup_minutes" | "teardown_minutes">): {
  from: Instant;
  to: Instant;
} {
  return {
    from: new Date(new Date(p.starts_at).getTime() - (p.setup_minutes || 0) * 60_000).toISOString(),
    to: new Date(new Date(p.ends_at).getTime() + (p.teardown_minutes || 0) * 60_000).toISOString(),
  };
}

export function durationMinutes(p: Pick<PlacementFact, "starts_at" | "ends_at">): number {
  return diffMinutes(p.ends_at, p.starts_at);
}

/**
 * INV-08-2 — `ends_at > starts_at`, and a placement lies within its
 * `event_day`'s date in the event timezone.
 */
export function assertPlacementTimes(input: {
  starts_at: Instant;
  ends_at: Instant;
  event_day_date: CalendarDate;
  timezone: string;
}): void {
  if (!input.starts_at || !input.ends_at || Number.isNaN(Date.parse(input.starts_at)) || Number.isNaN(Date.parse(input.ends_at))) {
    throw invariantError("INV-08-2", "invalid_placement_time", "A placement needs a valid start and end time.", {
      starts_at: input.starts_at,
      ends_at: input.ends_at,
    });
  }
  if (!isAfter(input.ends_at, input.starts_at)) {
    throw invariantError("INV-08-2", "placement_ends_before_start", "A placement must end after it starts.", {
      starts_at: input.starts_at,
      ends_at: input.ends_at,
    });
  }
  const startDay = calendarDateInZone(input.starts_at, input.timezone);
  // The end instant is exclusive: a session ending at midnight still belongs to
  // the day it started on, so the last minute is tested rather than the boundary.
  const lastMinute = new Date(new Date(input.ends_at).getTime() - 60_000).toISOString();
  const endDay = calendarDateInZone(lastMinute, input.timezone);
  if (startDay !== input.event_day_date || endDay !== input.event_day_date) {
    throw invariantError(
      "INV-08-2",
      "placement_outside_event_day",
      `That time is ${startDay === endDay ? startDay : `${startDay}–${endDay}`} in ${input.timezone}, but the day is ${input.event_day_date}.`,
      { event_day_date: input.event_day_date, starts_on: startDay, ends_on: endDay, timezone: input.timezone },
    );
  }
}

export function isPlaceableStatus(status: string): status is PlaceableSessionStatus {
  return (PLACEABLE_SESSION_STATUS as readonly string[]).includes(status);
}

/**
 * INV-08-3 — only sessions with `status in (confirmed, scheduled, published)`
 * may be placed.
 */
export function assertPlaceable(session: { id: string; status: string; title?: string }): void {
  if (!isPlaceableStatus(session.status)) {
    throw invariantError(
      "INV-08-3",
      "session_not_placeable",
      `"${session.title ?? session.id}" is ${session.status.replace(/_/g, " ")}; only confirmed sessions can be placed.`,
      { session_id: session.id, status: session.status, placeable: [...PLACEABLE_SESSION_STATUS] },
    );
  }
}

/**
 * INV-08-3 — placing sets `scheduled`; removing the placement returns it to
 * `confirmed`. Returns the session status to write, or null to leave it alone.
 *
 * `published` is deliberately left alone in both directions: the program state
 * machine (06) draws no `published → confirmed` edge, and INV-08-10 says a
 * published session stays in the snapshot it was published into.
 */
export function sessionStatusOnPlace(current: string): "scheduled" | null {
  return current === "confirmed" ? "scheduled" : null;
}

export function sessionStatusOnRemove(current: string): "confirmed" | null {
  return current === "scheduled" ? "confirmed" : null;
}

/**
 * A guard for the one transition callers can get wrong by hand: unplacing a
 * cancelled session is meaningless as an organizer action, because there is no
 * `cancelled → confirmed` edge to return it along.
 *
 * `reason = "session_cancelled"` is the exception, and it is not a loophole:
 * INV-06-7 says cancelling a session *releases its placement*, so that path
 * must be able to remove one. It removes the placement and leaves the session
 * `cancelled`, which `sessionStatusOnRemove` already does by returning null.
 */
export function assertRemovable(
  session: { id: string; status: string },
  reason: "organizer_action" | "session_cancelled" = "organizer_action",
): void {
  if (reason === "session_cancelled") return;
  if (session.status === "cancelled") {
    throw illegalTransition("Session", session.status, "confirmed", "INV-08-3");
  }
}
