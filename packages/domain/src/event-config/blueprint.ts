/**
 * 02 — "Starting an event: the starter blueprint and cloning".
 *
 * An event created empty owes its organizer a dozen forms before it shows a
 * single sign of life, and the second edition owes them the same dozen again.
 * This file is the pure half of the answer: the shipped starter configuration
 * as data, and the date arithmetic a clone is rebased with (INV-02-16).
 *
 * The rule the blueprint follows, and the reason it is short: **default what is
 * universal, and create exactly one placeholder for what is not, so that
 * nothing downstream is blocked.** A thirty-minute conference talk is
 * universal. The tracks a conference runs are not, and inventing five of them
 * means five things to delete before the real ones can be typed.
 *
 * Everything here is a total function over plain data;
 * `workers/api/src/contexts/event-config/provisioning.ts` turns it into rows.
 */

import {
  calendarDateInZone,
  wallClockTimeInZone,
  zonedDateTimeToInstant,
  type CalendarDate,
  type Instant,
} from "../shared/time.js";
import type { AvCapability, CapacityPolicy, Origin } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Calendar arithmetic                                                         */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` + n days, in no timezone at all — a date is not an instant. */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function calendarDaysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * INV-02-16 — shift a copied instant by whole days while keeping the
 * wall-clock time it reads as in the event timezone. A call that closed at
 * 23:59 last year closes at 23:59 this year, daylight saving or not.
 */
export function rebaseInstant(instant: Instant, timezone: string, days: number): Instant {
  const date = calendarDateInZone(instant, timezone);
  const time = wallClockTimeInZone(instant, timezone);
  return zonedDateTimeToInstant(addCalendarDays(date, days), time, timezone);
}

/* -------------------------------------------------------------------------- */
/* Days                                                                        */
/* -------------------------------------------------------------------------- */

export interface BlueprintDay {
  date: CalendarDate;
  label: string;
  sort_order: number;
}

/**
 * A conference is days long, not months. The cap is a guard against a typo in
 * the end date quietly writing four hundred `EventDay` rows, not a rule about
 * how long an event may run — the organizer can add more by hand.
 */
export const MAX_BLUEPRINT_DAYS = 21;

/**
 * One `EventDay` per date across the event's own range. Days are always
 * generated rather than copied, even by a clone: last year's Friday is not this
 * year's, and the dates belong to the new event's `starts_on`…`ends_on`.
 *
 * `labels` carry over positionally when a clone supplies them, so "Day 1 —
 * Workshops" survives the copy.
 */
export function blueprintDays(startsOn: CalendarDate, endsOn: CalendarDate, labels: (string | null)[] = []): BlueprintDay[] {
  const span = calendarDaysBetween(startsOn, endsOn);
  if (span < 0) return [];
  const count = Math.min(span + 1, MAX_BLUEPRINT_DAYS);
  const days: BlueprintDay[] = [];
  for (let i = 0; i < count; i++) {
    days.push({
      date: addCalendarDays(startsOn, i),
      label: labels[i] || `Day ${i + 1}`,
      sort_order: i,
    });
  }
  return days;
}

/* -------------------------------------------------------------------------- */
/* The starter blueprint                                                       */
/* -------------------------------------------------------------------------- */

export interface BlueprintTrack {
  name: string;
  slug: string;
  description: string;
  color: string;
}

export interface BlueprintFormat {
  name: string;
  slug: string;
  description: string;
  default_duration_minutes: number;
  min_duration_minutes?: number;
  max_duration_minutes?: number;
  max_speakers: number;
  eligible_origins: Origin[];
  requires_review: boolean;
  requires_recording_consent: boolean;
  capacity_policy: CapacityPolicy;
}

export interface BlueprintRoom {
  name: string;
  capacity: number;
  av_capabilities: AvCapability[];
}

export interface BlueprintVenue {
  name: string;
  rooms: BlueprintRoom[];
}

export interface BlueprintCfp {
  name: string;
  slug: string;
  intro_markdown: string;
  /** Days before the event starts that the call closes, when there is room. */
  closes_days_before_event: number;
  /** The shortest call worth opening, when the event is already close. */
  min_open_days: number;
  /** Wall-clock closing time in the event timezone. */
  closes_at_time: string;
}

export interface StarterBlueprint {
  track: BlueprintTrack;
  formats: BlueprintFormat[];
  venue: BlueprintVenue;
  cfp: BlueprintCfp;
}

export const STARTER_BLUEPRINT: StarterBlueprint = {
  // Exactly one, and it says so: a track is the one piece of configuration the
  // platform cannot guess, and five invented ones are five things to delete.
  track: {
    name: "General",
    slug: "general",
    description: "A placeholder track so the call has something to offer. Rename it, or add the lanes your event actually runs.",
    color: "#6366F1",
  },
  // The five whose durations, speaker counts and origins are the same at every
  // conference. Anything past these is programme design, not a default.
  formats: [
    {
      name: "Keynote",
      slug: "keynote",
      description: "Invited, on the main stage, opening or closing a day.",
      default_duration_minutes: 45,
      max_speakers: 2,
      eligible_origins: ["invited"],
      requires_review: false, // invited keynotes are not selected (02)
      requires_recording_consent: true,
      capacity_policy: "open",
    },
    {
      name: "Conference talk",
      slug: "talk",
      description: "The default programme slot.",
      default_duration_minutes: 30,
      min_duration_minutes: 20,
      max_duration_minutes: 45,
      max_speakers: 2,
      eligible_origins: ["cfp", "invited"],
      requires_review: true,
      requires_recording_consent: true,
      capacity_policy: "open",
    },
    {
      name: "Lightning talk",
      slug: "lightning-talk",
      description: "One idea, one speaker, no slides required.",
      default_duration_minutes: 10,
      max_speakers: 1,
      eligible_origins: ["cfp"],
      requires_review: true,
      requires_recording_consent: true,
      capacity_policy: "open",
    },
    {
      name: "Workshop",
      slug: "workshop",
      description: "Hands-on and seat-limited; attendees bring laptops.",
      default_duration_minutes: 120,
      min_duration_minutes: 60,
      max_duration_minutes: 240,
      max_speakers: 3,
      eligible_origins: ["cfp", "invited"],
      requires_review: true,
      requires_recording_consent: false,
      capacity_policy: "ticketed",
    },
    {
      name: "Sponsor session",
      slug: "sponsor-session",
      description: "A slot a sponsor holds by entitlement. Checked for compliance, not selected (R17).",
      default_duration_minutes: 20,
      max_speakers: 2,
      eligible_origins: ["sponsor"],
      requires_review: false,
      requires_recording_consent: true,
      capacity_policy: "open",
    },
  ],
  venue: {
    name: "Main venue",
    rooms: [
      {
        name: "Main Stage",
        capacity: 500,
        av_capabilities: ["projector", "confidence_monitor", "stage_mics", "handheld_mics", "recording", "livestream"],
      },
      { name: "Breakout Room", capacity: 150, av_capabilities: ["projector", "stage_mics", "recording"] },
      { name: "Workshop Room", capacity: 40, av_capabilities: ["projector", "hands_on_power", "wifi_dedicated"] },
    ],
  },
  cfp: {
    name: "Main call for proposals",
    slug: "main",
    intro_markdown:
      "We are looking for talks from people who have built something and can say what actually happened.\n\n" +
      "Tell us what you did, what broke, and what you would do differently. First-time speakers are welcome — " +
      "say so in your submission and we will pair you with someone from the programme committee.",
    closes_days_before_event: 90,
    min_open_days: 21,
    closes_at_time: "23:59",
  },
};

/* -------------------------------------------------------------------------- */
/* The starter CFP window                                                      */
/* -------------------------------------------------------------------------- */

export interface CfpWindowInput {
  now: Instant;
  starts_on: CalendarDate;
  timezone: string;
}

/**
 * Opens now, closes far enough before the doors to review what it collects —
 * unless the doors are already close, in which case it stays open for the
 * shortest window worth announcing. Either way it satisfies INV-02-4, which is
 * the point: a blueprint that produces a call the organizer cannot publish has
 * saved nobody anything.
 */
export function starterCfpWindow(input: CfpWindowInput, cfp: BlueprintCfp = STARTER_BLUEPRINT.cfp): { opens_at: Instant; closes_at: Instant } {
  const today = calendarDateInZone(input.now, input.timezone);
  const preferred = addCalendarDays(input.starts_on, -cfp.closes_days_before_event);
  const floor = addCalendarDays(today, cfp.min_open_days);
  const closesOn = calendarDaysBetween(floor, preferred) > 0 ? preferred : floor;
  return {
    opens_at: input.now,
    closes_at: zonedDateTimeToInstant(closesOn, cfp.closes_at_time, input.timezone),
  };
}
