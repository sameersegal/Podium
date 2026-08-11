/**
 * 11 — Cross-cutting content: enum members for `Asset`, `AssetComment`,
 * `CustomFieldDefinition`, `BulkImport` and `Export`.
 */

export const SCAN_STATUSES = ["pending", "clean", "infected", "failed"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ASSET_VISIBILITIES = ["private", "public"] as const;
export type AssetVisibility = (typeof ASSET_VISIBILITIES)[number];

export const ASSET_PURPOSES = [
  "headshot",
  "slides",
  "logo",
  "document",
  "task_attachment",
  "cover_image",
  "other",
] as const;
export type AssetPurpose = (typeof ASSET_PURPOSES)[number];

export const CUSTOM_FIELD_SUBJECTS = ["person", "event_participant", "session", "sponsor"] as const;
export type CustomFieldSubject = (typeof CUSTOM_FIELD_SUBJECTS)[number];

export const CUSTOM_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_select",
  "multi_select",
  "checkbox",
  "url",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_AUDIENCES = ["public", "committee_only", "organizer_only"] as const;
export type CustomFieldAudience = (typeof CUSTOM_FIELD_AUDIENCES)[number];

export const CUSTOM_FIELD_STATUSES = ["active", "archived"] as const;
export type CustomFieldStatus = (typeof CUSTOM_FIELD_STATUSES)[number];

/** R27: no hard cap, a soft warning past roughly 25 per subject type. */
export const CUSTOM_FIELD_SOFT_LIMIT = 25;

export const IMPORT_SUBJECTS = ["person", "event_participant", "session", "sponsor"] as const;
export type ImportSubject = (typeof IMPORT_SUBJECTS)[number];

export const IMPORT_STATUSES = [
  "uploaded",
  "mapping",
  "validating",
  "previewing",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const DEDUPE_KEYS = ["email", "reference", "none"] as const;
export type DedupeKey = (typeof DEDUPE_KEYS)[number];

export const ON_DUPLICATE = ["skip", "update", "create_anyway"] as const;
export type OnDuplicate = (typeof ON_DUPLICATE)[number];

/** Per-row outcome. `errors` and every count on `BulkImport` derive from these. */
export const IMPORT_ROW_OUTCOMES = ["pending", "create", "update", "skip", "error", "created", "updated", "skipped"] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

export const EXPORT_SUBJECTS = [
  "review_results",
  "proposals",
  "sessions",
  "speakers",
  "participants",
  "tasks",
  "files",
  "contacts",
  "communications",
] as const;
export type ExportSubject = (typeof EXPORT_SUBJECTS)[number];

export const EXPORT_FORMATS = ["csv", "xlsx", "json", "zip", "ics"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = ["queued", "running", "ready", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** 11: "default 7 days; generated exports are not kept forever". */
export const EXPORT_TTL_DAYS = 7;
