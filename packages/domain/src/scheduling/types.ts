/**
 * 08 — Scheduling & Publication. Enums and the small pure predicates that hang
 * off them.
 *
 * Members are `as const` arrays so the drift checker can compare them with
 * `docs/domain/08-scheduling-and-publication.md`. Enums are additive: removing
 * or renaming a member is breaking.
 */

import { TIME_SLOT_KIND, type TimeSlotKind } from "../event-config/types.js";

export { TIME_SLOT_KIND };
export type { TimeSlotKind };

export const PLACEMENT_STATUS = ["tentative", "locked"] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUS)[number];

/** INV-08-3: only these session statuses may be placed. */
export const PLACEABLE_SESSION_STATUS = ["confirmed", "scheduled", "published"] as const;
export type PlaceableSessionStatus = (typeof PLACEABLE_SESSION_STATUS)[number];

export const CONFLICT_CODE = [
  "ROOM_DOUBLE_BOOKED",
  "SPEAKER_DOUBLE_BOOKED",
  "SPEAKER_NO_TRANSIT",
  "DURATION_MISMATCH",
  "AV_UNSUPPORTED",
  "OVER_CAPACITY",
  "TRACK_COLLISION",
  "SPONSOR_COLLISION",
  "SERIES_OUT_OF_ORDER",
  "OUTSIDE_EVENT_HOURS",
  "UNPUBLISHABLE",
] as const;
export type ConflictCode = (typeof CONFLICT_CODE)[number];

export const CONFLICT_SEVERITY = ["error", "warning"] as const;
export type ConflictSeverity = (typeof CONFLICT_SEVERITY)[number];

/**
 * The severity column of the conflict table. `error` blocks **publication**,
 * not placement: you may build a broken draft schedule, you may not publish one
 * without a recorded override (INV-08-4).
 */
export const CONFLICT_SEVERITIES: Record<ConflictCode, ConflictSeverity> = {
  ROOM_DOUBLE_BOOKED: "error",
  SPEAKER_DOUBLE_BOOKED: "error",
  SPEAKER_NO_TRANSIT: "warning",
  DURATION_MISMATCH: "error",
  AV_UNSUPPORTED: "warning",
  OVER_CAPACITY: "warning",
  TRACK_COLLISION: "warning",
  SPONSOR_COLLISION: "warning",
  SERIES_OUT_OF_ORDER: "error",
  OUTSIDE_EVENT_HOURS: "warning",
  UNPUBLISHABLE: "error",
};

export const CONFLICT_LABELS: Record<ConflictCode, string> = {
  ROOM_DOUBLE_BOOKED: "Room double-booked",
  SPEAKER_DOUBLE_BOOKED: "Speaker double-booked",
  SPEAKER_NO_TRANSIT: "No time to walk between rooms",
  DURATION_MISMATCH: "Slot length does not match the session",
  AV_UNSUPPORTED: "Room lacks the AV this session needs",
  OVER_CAPACITY: "Expected demand exceeds the room",
  TRACK_COLLISION: "Two sessions from one track run at once",
  SPONSOR_COLLISION: "Two sessions from one sponsor overlap",
  SERIES_OUT_OF_ORDER: "A series part is out of order",
  OUTSIDE_EVENT_HOURS: "Outside the day's published hours",
  UNPUBLISHABLE: "Blocked from publication",
};

export const AUTO_PLACE_STRATEGY = ["greedy_fill", "balance_tracks", "respect_preferences"] as const;
export type AutoPlaceStrategy = (typeof AUTO_PLACE_STRATEGY)[number];

export const AUTO_PLACE_STATUS = ["proposed", "applied", "partially_applied", "discarded"] as const;
export type AutoPlaceStatus = (typeof AUTO_PLACE_STATUS)[number];

export const PUBLICATION_STATUS = ["building", "live", "superseded", "rolled_back"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUS)[number];

export const DIFF_CHANGE_TYPE = [
  "session_added",
  "session_removed",
  "session_cancelled",
  "time_changed",
  "room_changed",
  "speaker_changed",
  "content_changed",
] as const;
export type DiffChangeType = (typeof DIFF_CHANGE_TYPE)[number];

export const WIDGET_TYPE = [
  "sessions_list",
  "speakers_list",
  "agenda_grid",
  "schedule_itinerary",
  "speaker_gallery",
  "session_detail",
] as const;
export type WidgetType = (typeof WIDGET_TYPE)[number];

export const EMBED_FORMAT = ["js_widget", "iframe", "html", "json", "xml", "ics", "rss"] as const;
export type EmbedFormat = (typeof EMBED_FORMAT)[number];

export const EMBED_STATUS = ["active", "disabled"] as const;
export type EmbedStatus = (typeof EMBED_STATUS)[number];

export const WIDGET_LABELS: Record<WidgetType, string> = {
  sessions_list: "Sessions list — a searchable card per session",
  speakers_list: "Speakers directory — ordered by surname, with their sessions",
  agenda_grid: "Agenda grid — rooms across, time down",
  schedule_itinerary: "Schedule itinerary — a chronological list under time headings",
  speaker_gallery: "Speaker gallery — a photo grid opening to a detail panel",
  session_detail: "Session detail — one session in full",
};

/**
 * INV-08-12: an `EmbedConfig` renders exactly one `widget_type` in exactly one
 * `format`, and a `format` a type cannot express (`ics` for `speaker_gallery`)
 * is rejected **at configuration time**, not at request time.
 *
 * `ics` and `rss` are time-ordered session feeds, so they exist only for the
 * types that read `PublishedSession`.
 */
export const WIDGET_FORMATS: Record<WidgetType, readonly EmbedFormat[]> = {
  sessions_list: ["js_widget", "iframe", "html", "json", "xml", "ics", "rss"],
  speakers_list: ["js_widget", "iframe", "html", "json", "xml"],
  agenda_grid: ["js_widget", "iframe", "html", "json", "xml", "ics"],
  schedule_itinerary: ["js_widget", "iframe", "html", "json", "xml", "ics", "rss"],
  speaker_gallery: ["js_widget", "iframe", "html", "json", "xml"],
  session_detail: ["js_widget", "iframe", "html", "json", "xml", "ics"],
};

export function widgetSupportsFormat(widget: WidgetType, format: EmbedFormat): boolean {
  return (WIDGET_FORMATS[widget] ?? []).includes(format);
}

/** The widget types that read `PublishedSpeaker` rather than `PublishedSession`. */
export const SPEAKER_WIDGETS: readonly WidgetType[] = ["speakers_list", "speaker_gallery"];

export function isSpeakerWidget(widget: WidgetType): boolean {
  return SPEAKER_WIDGETS.includes(widget);
}

/** Defaults for the `Event.settings` keys this context reads (01: "defaults in code"). */
export const SCHEDULING_DEFAULTS = {
  /** `Event.settings.scheduling.min_transit_minutes` — SPEAKER_NO_TRANSIT. */
  min_transit_minutes: 10,
  /** `Event.settings.publication.auto_publish` — R25, default off. */
  auto_publish: false,
  /** `EmbedConfig.cache_ttl_seconds` default. */
  cache_ttl_seconds: 300,
  /** The window a day is assumed to run when it has no `TimeSlot` grid. */
  day_start_time: "09:00",
  day_end_time: "18:00",
} as const;
