/**
 * Time rules — 11-cross-cutting.md, "Time".
 *
 * All instants stored UTC. `Event.timezone` is the display authority
 * (INV-02-1). Durations are always integer minutes. Dates without times are
 * calendar dates in the event timezone and are never converted.
 */

export type Instant = string; // ISO-8601 UTC, e.g. 2026-03-14T09:12:44.113Z
export type CalendarDate = string; // YYYY-MM-DD

export function nowIso(at: number = Date.now()): Instant {
  return new Date(at).toISOString();
}

export function toIso(value: Date | number | string): Instant {
  return new Date(value).toISOString();
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return new Date(new Date(instant).getTime() + minutes * 60_000).toISOString();
}

export function addDays(instant: Instant, days: number): Instant {
  return addMinutes(instant, days * 24 * 60);
}

export function diffMinutes(a: Instant, b: Instant): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60_000);
}

export function diffDays(a: Instant, b: Instant): number {
  return Math.floor(diffMinutes(a, b) / (24 * 60));
}

export function isBefore(a: Instant, b: Instant): boolean {
  return new Date(a).getTime() < new Date(b).getTime();
}

export function isAfter(a: Instant, b: Instant): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

/** Overlap test used by ROOM_DOUBLE_BOOKED and SPEAKER_DOUBLE_BOOKED. */
export function overlaps(aStart: Instant, aEnd: Instant, bStart: Instant, bEnd: Instant): boolean {
  return isBefore(aStart, bEnd) && isBefore(bStart, aEnd);
}

/**
 * `Event.timezone` is free text elsewhere in the model (validated for
 * presence only), but `Organization.default_timezone` is set once, at
 * first-run setup, with nobody around afterwards to notice a typo — every
 * event created from then on inherits it. Worth the one extra check here.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Render an instant in an IANA timezone. Event time is the default everywhere
 * a human reads a schedule (INV-02-1).
 */
export function formatInZone(
  instant: Instant,
  timezone: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timezone }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(instant));
  }
}

export function formatTimeInZone(instant: Instant, timezone: string): string {
  return formatInZone(instant, timezone, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatDateInZone(instant: Instant, timezone: string): string {
  return formatInZone(instant, timezone, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** The calendar date an instant falls on, in the given zone. */
export function calendarDateInZone(instant: Instant, timezone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The wall-clock time an instant reads as in the given zone, `HH:MM:SS`.
 *
 * The inverse of `zonedDateTimeToInstant`, and only useful with it: rebasing a
 * cloned deadline (INV-02-16) means keeping the time an organizer wrote — "the
 * call closes at 23:59" — while moving the date, which no amount of millisecond
 * arithmetic gets right across a daylight-saving boundary.
 */
export function wallClockTimeInZone(instant: Instant, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // `en-GB` renders midnight as 24 in some runtimes; the day has already been
  // taken from `calendarDateInZone`, so it is hour zero of that day.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${hour}:${get("minute")}:${get("second")}`;
}

/**
 * The UTC instant for a wall-clock time on a calendar date in a timezone.
 * Authoring a placement at "09:00 on day 1" means 09:00 in `Event.timezone`.
 * Seconds are optional: `09:00` and `23:59:59` both parse.
 */
export function zonedDateTimeToInstant(date: CalendarDate, time: string, timezone: string): Instant {
  const [h, m, s] = time.split(":").map((n) => parseInt(n, 10));
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
  const naive = Date.parse(`${date}T${pad(h)}:${pad(m)}:${pad(s)}Z`);
  // Two passes converge for every real zone offset, including half-hour ones.
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const offset = zoneOffsetMs(guess, timezone);
    guess = naive - offset;
  }
  return new Date(guess).toISOString();
}

function zoneOffsetMs(at: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(at));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - at;
}

/** Human "in 3 days" / "2 days overdue" phrasing for portal next-actions. */
export function relativeDays(target: Instant, from: Instant = nowIso()): string {
  const days = Math.round(diffMinutes(target, from) / (24 * 60));
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}
