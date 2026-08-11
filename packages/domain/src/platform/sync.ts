/**
 * Two-way sync rules — 09, "Two-way sync"; R31.
 *
 * Everything here is pure. The worker supplies rows and derived values; this
 * file decides what may be pushed, what may be accepted back, what an inbound
 * record means in Podium's own value space, and whether that inbound record is
 * merely this system hearing its own echo.
 *
 * Three rules live here because they cannot safely live anywhere else:
 *
 *   INV-09-17  a field map may only name declared fields, and may only mark
 *              `both` where the subject declares the field writable. Checked at
 *              save time, so a mapping pointed at a derived column fails while
 *              the organizer is looking at it rather than at 3am.
 *   INV-09-19  an inbound record hashing to the last push is an echo. This is
 *              the only thing stopping push and pull driving each other
 *              forever, so it is exact rather than heuristic.
 *   INV-09-23  `decision`, `entitlement` and `placement` are push-only whatever
 *              the field map says. `review` is not a subject at all.
 */

import { derivedFieldWrite, illegalTransition, invariantError } from "../shared/errors.js";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `SyncMapping.subject` — 09. `review` is deliberately absent: its visibility
 * differs per reader (INV-11-7, and reviewer identity under the round's
 * `anonymity`), and an external table has one visibility for everyone who can
 * open it.
 */
export const SYNC_SUBJECTS = [
  "proposal",
  "session",
  "person",
  "speaker_profile",
  "event_participant",
  "sponsor",
  "sponsorship",
  "entitlement",
  "placement",
  "decision",
  "prospect_card",
] as const;
export type SyncSubject = (typeof SYNC_SUBJECTS)[number];

/**
 * There is no `pull`. Podium is the system of record (R31), so every synced
 * field is pushed and some are *also* accepted back — a field the external tool
 * owned outright would be a field this model could not state the value of.
 */
export const SYNC_DIRECTIONS = ["push", "both"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_LINK_STATUSES = ["pending_push", "in_sync", "conflict", "error", "unlinked"] as const;
export type SyncLinkStatus = (typeof SYNC_LINK_STATUSES)[number];

/** Exactly the arrows drawn in the state diagram in 09. An undrawn transition does not exist. */
const LINK_TRANSITIONS: Record<SyncLinkStatus, readonly SyncLinkStatus[]> = {
  pending_push: ["in_sync", "error", "unlinked"],
  in_sync: ["pending_push", "conflict", "unlinked"],
  conflict: ["pending_push", "unlinked"],
  error: ["pending_push", "unlinked"],
  unlinked: [],
};

export function canTransitionSyncLink(from: SyncLinkStatus, to: SyncLinkStatus): boolean {
  return from === to || (LINK_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertSyncLinkTransition(from: SyncLinkStatus, to: SyncLinkStatus): void {
  if (!canTransitionSyncLink(from, to)) throw illegalTransition("ExternalRecordLink", from, to);
}

export const SYNC_RUN_DIRECTIONS = ["push", "pull"] as const;
export type SyncRunDirection = (typeof SYNC_RUN_DIRECTIONS)[number];

export const SYNC_RUN_TRIGGERS = ["event", "cron", "inbound", "manual"] as const;
export type SyncRunTrigger = (typeof SYNC_RUN_TRIGGERS)[number];

export const SYNC_RUN_STATUSES = ["running", "completed", "completed_with_errors", "failed"] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export interface SyncCounts {
  pushed: number;
  pulled: number;
  echoed: number;
  conflicted: number;
  skipped: number;
  failed: number;
}

export const EMPTY_COUNTS: SyncCounts = { pushed: 0, pulled: 0, echoed: 0, conflicted: 0, skipped: 0, failed: 0 };

/* -------------------------------------------------------------------------- */
/* Field and subject specifications                                            */
/* -------------------------------------------------------------------------- */

export type SyncFieldKind = "text" | "long_text" | "number" | "boolean" | "date" | "select" | "list";

export interface SyncFieldSpec {
  field: string;
  label: string;
  kind: SyncFieldKind;
  /** Accepted back from the external tool. Absent means push-only. */
  writable?: boolean;
  /** PII per 11. Pushed only where the mapping sets `include_pii`, never writable (INV-09-21). */
  pii?: boolean;
  /** Computed at projection time rather than read from a column — never writable (INV-11-6). */
  derived?: boolean;
  /**
   * Accepting this back revokes the session's content approval and writes a
   * `SessionRevision`, in the same write (INV-06-12). True of every content
   * field on `session`. Surfaced where the field is chosen, because the first
   * time somebody fixes a typo in the spreadsheet is a bad time to find out.
   */
  revokesApproval?: boolean;
  help?: string;
}

export interface SyncSubjectSpec {
  subject: SyncSubject;
  table: string;
  label: string;
  /** Org-scoped subjects have no `event_id`; event-scoped ones require one. */
  scope: "org" | "event";
  /** The column holding the owning event, where the table has one. */
  eventColumn?: string;
  /**
   * INV-09-23. No field is writable regardless of the field map, and the reason
   * is stated because "push-only" without one reads like an oversight.
   */
  pushOnly?: string;
  /** The `Person` this record is about, for erasure propagation (INV-09-22). */
  personColumn?: string;
  fields: SyncFieldSpec[];
}

const text = (field: string, label: string, extra: Partial<SyncFieldSpec> = {}): SyncFieldSpec => ({
  field,
  label,
  kind: "text",
  ...extra,
});

/**
 * What each subject offers, in each direction.
 *
 * The general rule the lists encode: **sync what a human types, never what the
 * system computes or what fires.** Every `derived` field is push-only by
 * construction, and so is every field whose write has a consequence a
 * spreadsheet cannot express — a decision that emails four hundred people, a
 * placement that has to serialise through one writer.
 */
export const SUBJECT_SPECS: Record<SyncSubject, SyncSubjectSpec> = {
  proposal: {
    subject: "proposal",
    table: "proposal",
    label: "Proposals",
    scope: "event",
    eventColumn: "event_id",
    fields: [
      text("reference", "Reference"),
      { field: "title", label: "Title", kind: "long_text" },
      { field: "abstract", label: "Abstract", kind: "long_text" },
      { field: "description", label: "Description", kind: "long_text" },
      { field: "status", label: "Status", kind: "select" },
      { field: "origin", label: "Origin", kind: "select" },
      { field: "is_late", label: "Late submission", kind: "boolean" },
      { field: "submitted_at", label: "Submitted at", kind: "date" },
      { field: "confirmation_deadline", label: "Confirmation deadline", kind: "date" },
      { field: "requested_duration_minutes", label: "Requested duration (min)", kind: "number" },
      text("session_format_id", "Format id"),
      text("track_id", "Requested track id"),
      // The chair-side triage fields. Sorting four hundred proposals into
      // tracks is a grid job, and this is the row that makes it one.
      text("assigned_track_id", "Assigned track id", { writable: true }),
      { field: "audience_level", label: "Audience level", kind: "select", writable: true },
      { field: "keywords", label: "Keywords", kind: "list", writable: true },
      text("language", "Language", { writable: true }),
      text("speaker_names", "Speakers", { derived: true }),
      text("submitter_name", "Submitter", { derived: true }),
      text("submitter_email", "Submitter email", { derived: true, pii: true }),
      text("track_name", "Requested track", { derived: true }),
      text("format_name", "Format", { derived: true }),
      { field: "decision_outcome", label: "Decision", kind: "select", derived: true },
    ],
  },

  session: {
    subject: "session",
    table: "session",
    label: "Sessions",
    scope: "event",
    eventColumn: "event_id",
    fields: [
      text("reference", "Reference"),
      { field: "title", label: "Title", kind: "long_text", writable: true, revokesApproval: true },
      { field: "subtitle", label: "Subtitle", kind: "text", writable: true, revokesApproval: true },
      { field: "abstract", label: "Abstract", kind: "long_text", writable: true, revokesApproval: true },
      { field: "description", label: "Description", kind: "long_text", writable: true, revokesApproval: true },
      { field: "duration_minutes", label: "Duration (min)", kind: "number" },
      { field: "audience_level", label: "Audience level", kind: "select", writable: true },
      { field: "keywords", label: "Keywords", kind: "list", writable: true },
      text("language", "Language", { writable: true }),
      text("recording_url", "Recording URL", { writable: true }),
      text("registration_url", "Registration URL", { writable: true }),
      { field: "capacity_override", label: "Capacity override", kind: "number", writable: true },
      text("track_id", "Track id", { writable: true }),
      text("session_format_id", "Format id"),
      { field: "status", label: "Status", kind: "select" },
      { field: "content_status", label: "Content status", kind: "select" },
      { field: "visibility", label: "Visibility", kind: "select" },
      { field: "recording_consent", label: "Recording consent", kind: "select" },
      { field: "published_at", label: "Published at", kind: "date" },
      // The read-only half of a programme grid: names rather than ids, and the
      // scheduled time, which lives on `Placement` and not here (08).
      text("speaker_names", "Speakers", { derived: true }),
      text("track_name", "Track", { derived: true }),
      text("format_name", "Format", { derived: true }),
      text("room_name", "Room", { derived: true }),
      { field: "starts_at", label: "Starts at", kind: "date", derived: true },
      { field: "ends_at", label: "Ends at", kind: "date", derived: true },
    ],
  },

  person: {
    subject: "person",
    table: "person",
    label: "People",
    scope: "org",
    personColumn: "id",
    fields: [
      text("full_name", "Full name", { writable: true }),
      text("display_name", "Display name", { writable: true }),
      text("pronouns", "Pronouns", { writable: true }),
      text("timezone", "Timezone", { writable: true }),
      text("locale", "Locale", { writable: true }),
      { field: "tags", label: "Tags", kind: "list", writable: true },
      { field: "status", label: "Status", kind: "select" },
      // Push-only on purpose. `Person.email` is unique per org (INV-01-1) and
      // is what authentication resolves against; a typo in a spreadsheet cell
      // should not be able to take somebody's login away.
      text("email", "Email", { pii: true }),
    ],
  },

  speaker_profile: {
    subject: "speaker_profile",
    table: "speaker_profile",
    label: "Speaker profiles",
    scope: "org",
    personColumn: "person_id",
    fields: [
      text("headline", "Headline", { writable: true }),
      text("job_title", "Job title", { writable: true }),
      text("company", "Company", { writable: true }),
      { field: "bio", label: "Bio", kind: "long_text", writable: true },
      { field: "short_bio", label: "Short bio", kind: "long_text", writable: true },
      text("location", "Location", { writable: true }),
      // INV-01-13: only the profile's own person may change these two, so no
      // integration may. Pushed so the grid can show who is listed, never read.
      { field: "is_listed", label: "Listed publicly", kind: "boolean" },
      text("phone", "Phone", { pii: true }),
      { field: "dietary_notes", label: "Dietary notes", kind: "long_text", pii: true },
      { field: "accessibility_notes", label: "Accessibility notes", kind: "long_text", pii: true },
      text("full_name", "Full name", { derived: true }),
      text("person_id", "Person id", { derived: true }),
    ],
  },

  event_participant: {
    subject: "event_participant",
    table: "event_participant",
    label: "Roster",
    scope: "event",
    eventColumn: "event_id",
    personColumn: "person_id",
    fields: [
      { field: "kind", label: "Kind", kind: "select" },
      { field: "status", label: "Status", kind: "select", writable: true },
      { field: "source", label: "Source", kind: "select" },
      { field: "portal_access", label: "Portal access", kind: "select" },
      text("full_name", "Full name", { derived: true }),
      text("email", "Email", { derived: true, pii: true }),
    ],
  },

  sponsor: {
    subject: "sponsor",
    table: "sponsor",
    label: "Sponsors",
    scope: "org",
    fields: [
      text("name", "Name", { writable: true }),
      text("display_name", "Display name", { writable: true }),
      text("website_url", "Website", { writable: true }),
      { field: "description", label: "Description", kind: "long_text", writable: true },
      { field: "industry_tags", label: "Industry tags", kind: "list", writable: true },
      { field: "internal_notes", label: "Internal notes", kind: "long_text", writable: true },
      { field: "status", label: "Status", kind: "select", writable: true },
      text("slug", "Slug"),
    ],
  },

  sponsorship: {
    subject: "sponsorship",
    table: "sponsorship",
    label: "Sponsorships",
    scope: "event",
    eventColumn: "event_id",
    fields: [
      // The documented seam to whatever the sales side actually runs on (03).
      text("contract_reference", "Contract reference", { writable: true }),
      { field: "internal_notes", label: "Internal notes", kind: "long_text", writable: true },
      { field: "public_from", label: "Public from", kind: "date", writable: true },
      { field: "sort_order_override", label: "Sort order", kind: "number", writable: true },
      // Push-only: confirming and cancelling grant and revoke entitlements (03),
      // which is a transition, not a cell.
      { field: "status", label: "Status", kind: "select" },
      { field: "confirmed_at", label: "Confirmed at", kind: "date" },
      text("sponsor_name", "Sponsor", { derived: true }),
      text("tier_name", "Tier", { derived: true }),
    ],
  },

  entitlement: {
    subject: "entitlement",
    table: "entitlement",
    label: "Entitlements",
    scope: "event",
    pushOnly: "consumed_count and remaining are derived from the proposals pointing at the entitlement (03). There is nothing to write.",
    fields: [
      { field: "entitlement_type", label: "Type", kind: "select" },
      { field: "quantity", label: "Quantity", kind: "number" },
      { field: "submission_deadline", label: "Submission deadline", kind: "date" },
      { field: "expires_at", label: "Expires at", kind: "date" },
      { field: "notes", label: "Notes", kind: "long_text" },
      { field: "consumed_count", label: "Used", kind: "number", derived: true },
      { field: "remaining", label: "Remaining", kind: "number", derived: true },
      text("sponsor_name", "Sponsor", { derived: true }),
    ],
  },

  placement: {
    subject: "placement",
    table: "placement",
    label: "Schedule",
    scope: "event",
    eventColumn: "event_id",
    pushOnly:
      "Placement writes serialise through one writer per event (08) because concurrent edits produce conflicts no retry untangles. A spreadsheet row is the opposite of that discipline.",
    fields: [
      { field: "starts_at", label: "Starts at", kind: "date" },
      { field: "ends_at", label: "Ends at", kind: "date" },
      { field: "status", label: "Status", kind: "select" },
      { field: "is_public", label: "Public", kind: "boolean" },
      { field: "notes", label: "Notes", kind: "long_text" },
      text("session_title", "Session", { derived: true }),
      text("room_name", "Room", { derived: true }),
      text("day", "Day", { derived: true }),
    ],
  },

  decision: {
    subject: "decision",
    table: "decision",
    label: "Decisions",
    scope: "event",
    pushOnly:
      "Publishing a decision emails every speaker (INV-05-10). A dropdown in a spreadsheet must not be able to send four hundred rejections at 2am.",
    fields: [
      // `feedback_for_speaker` and `rationale` are absent on purpose: one is a
      // letter to a person, the other is the committee's private reasoning.
      { field: "outcome", label: "Outcome", kind: "select" },
      { field: "status", label: "Status", kind: "select" },
      { field: "decided_at", label: "Decided at", kind: "date" },
      { field: "published_at", label: "Published at", kind: "date" },
      { field: "confirmation_deadline", label: "Confirmation deadline", kind: "date" },
      { field: "assigned_duration_minutes", label: "Assigned duration (min)", kind: "number" },
      text("proposal_reference", "Proposal", { derived: true }),
      text("proposal_title", "Title", { derived: true }),
    ],
  },

  prospect_card: {
    subject: "prospect_card",
    table: "prospect_card",
    label: "Speaker pipeline",
    scope: "org",
    personColumn: "person_id",
    fields: [
      // `rationale` is absent: the card's private judgement about a person does
      // not leave the organization (INV-14-6), and a shared grid is leaving.
      text("topic", "Topic", { writable: true }),
      { field: "score", label: "Score", kind: "number", writable: true },
      { field: "next_action_at", label: "Next action", kind: "date", writable: true },
      // Push-only: a stage move runs a state machine and records how long the
      // card sat in the previous stage (14). Dragging a card is the board's
      // job, and a cell edit cannot express the same fact.
      text("stage_id", "Stage id"),
      text("full_name", "Name", { derived: true }),
      text("stage_name", "Stage", { derived: true }),
      text("pipeline_name", "Pipeline", { derived: true }),
    ],
  },
};

export function subjectSpec(subject: string): SyncSubjectSpec {
  const spec = SUBJECT_SPECS[subject as SyncSubject];
  if (!spec) {
    throw invariantError("INV-09-17", "unknown_sync_subject", `${subject} is not a syncable subject.`, { subject });
  }
  return spec;
}

export function fieldSpec(subject: string, field: string): SyncFieldSpec | null {
  return subjectSpec(subject).fields.find((f) => f.field === field) ?? null;
}

/** Every field the subject may push, minus PII where the mapping is not allowed it. */
export function pushableFields(subject: string, includePii = true): SyncFieldSpec[] {
  return subjectSpec(subject).fields.filter((f) => includePii || !f.pii);
}

/**
 * Every field the subject may accept back. Empty for a push-only subject
 * (INV-09-23), and never containing a derived or PII field.
 */
export function writableFields(subject: string): SyncFieldSpec[] {
  const spec = subjectSpec(subject);
  if (spec.pushOnly) return [];
  return spec.fields.filter((f) => f.writable && !f.derived && !f.pii);
}

/** The derived fields the worker must compute before a push can be projected. */
export function derivedFields(subject: string): string[] {
  return subjectSpec(subject).fields.filter((f) => f.derived).map((f) => f.field);
}

/* -------------------------------------------------------------------------- */
/* Field maps                                                                  */
/* -------------------------------------------------------------------------- */

export interface SyncFieldMap {
  field: string;
  external_field: string;
  direction: SyncDirection;
}

/**
 * INV-09-17, and the place INV-11-6 finally gets teeth.
 *
 * Every other service builds its patch from a named field set, so a derived
 * column has never had a route that could write it — the rule held because
 * nothing asked. A field map is the first surface that accepts a field bag from
 * outside, so it is checked here, at save time, and a bad entry is refused
 * rather than dropped: silently ignoring a mapping an organizer configured is
 * how a column quietly stops syncing for a month.
 */
export function validateFieldMap(subject: string, fieldMap: SyncFieldMap[], includePii: boolean): void {
  const spec = subjectSpec(subject);
  const seenFields = new Set<string>();
  const seenExternal = new Set<string>();

  for (const entry of fieldMap) {
    const f = spec.fields.find((x) => x.field === entry.field);
    if (!f) {
      throw invariantError(
        "INV-09-17",
        "field_not_syncable",
        `${subject}.${entry.field} is not a field this subject can sync.`,
        { subject, field: entry.field, allowed: spec.fields.map((x) => x.field) },
      );
    }
    if (!SYNC_DIRECTIONS.includes(entry.direction)) {
      throw invariantError("INV-09-17", "bad_sync_direction", `${entry.direction} is not a sync direction.`, {
        field: entry.field,
        direction: entry.direction,
      });
    }
    if (!entry.external_field?.trim()) {
      throw invariantError("INV-09-17", "missing_external_field", `${entry.field} has no external column.`, {
        field: entry.field,
      });
    }
    if (seenFields.has(entry.field)) {
      throw invariantError("INV-09-17", "duplicate_field", `${entry.field} is mapped twice.`, { field: entry.field });
    }
    if (seenExternal.has(entry.external_field)) {
      // Two Podium fields into one column would make the inbound projection
      // ambiguous, and the hash unstable.
      throw invariantError("INV-09-17", "duplicate_external_field", `${entry.external_field} is mapped twice.`, {
        external_field: entry.external_field,
      });
    }
    seenFields.add(entry.field);
    seenExternal.add(entry.external_field);

    if (f.pii && !includePii) {
      throw invariantError(
        "INV-09-21",
        "pii_without_consent",
        `${subject}.${entry.field} is personal data; the mapping must set include_pii to carry it.`,
        { subject, field: entry.field },
      );
    }

    if (entry.direction !== "both") continue;

    if (f.derived) throw derivedFieldWrite(`${subject}.${entry.field}`);
    if (spec.pushOnly) {
      throw invariantError(
        "INV-09-23",
        "subject_is_push_only",
        `${spec.label} can be pushed but never written back. ${spec.pushOnly}`,
        { subject, field: entry.field },
      );
    }
    if (f.pii) {
      throw invariantError(
        "INV-09-21",
        "pii_not_writable",
        `${subject}.${entry.field} is personal data and is never accepted back from an external tool.`,
        { subject, field: entry.field },
      );
    }
    if (!f.writable) {
      throw invariantError(
        "INV-09-17",
        "field_not_writable",
        `${subject}.${entry.field} can be pushed but never written back.`,
        { subject, field: entry.field, writable: writableFields(subject).map((x) => x.field) },
      );
    }
  }
}

/** The entries that may be written back, after INV-09-17 has already passed. */
export function writableEntries(subject: string, fieldMap: SyncFieldMap[]): SyncFieldMap[] {
  const allowed = new Set(writableFields(subject).map((f) => f.field));
  return fieldMap.filter((e) => e.direction === "both" && allowed.has(e.field));
}

/** True where accepting this map back can revoke a session's content approval (INV-06-12). */
export function revokesApproval(subject: string, fieldMap: SyncFieldMap[]): boolean {
  return writableEntries(subject, fieldMap).some((e) => fieldSpec(subject, e.field)?.revokesApproval);
}

/* -------------------------------------------------------------------------- */
/* Value space                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Podium's value space, per field kind.
 *
 * The hash that suppresses echoes (INV-09-19) is computed over *these* values,
 * on both the push and the pull side, so that a provider trimming whitespace,
 * reordering a multi-select or rendering a date differently cannot make an
 * unchanged record look changed. Formatting differences belong to the provider;
 * this is the only place they are allowed to be resolved.
 */
export function canonical(kind: SyncFieldKind, raw: unknown): string | number | boolean | string[] | null {
  if (raw === undefined || raw === null || raw === "") return kind === "list" ? [] : null;
  switch (kind) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      const s = String(raw).trim().toLowerCase();
      return ["1", "true", "yes", "y", "checked"].includes(s);
    }
    case "date": {
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case "list": {
      const items = Array.isArray(raw)
        ? raw
        : typeof raw === "string" && raw.trim().startsWith("[")
          ? safeArray(raw)
          : String(raw).split(",");
      return items.map((x) => String(x).trim()).filter(Boolean);
    }
    default:
      return String(raw).trim();
  }
}

function safeArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** How a canonical value crosses to the provider. Lists go as text: a multi-select
 *  needs its options to exist first, and a sync that fails on an unknown option is
 *  worse than one that writes "ai, agents" into a text cell. */
export function toExternal(kind: SyncFieldKind, value: ReturnType<typeof canonical>): unknown {
  if (value === null) return null;
  if (kind === "list") return (value as string[]).join(", ");
  return value;
}

/** And how it comes back, so that `canonical(fromExternal(x)) === canonical(x)`. */
export function fromExternal(kind: SyncFieldKind, raw: unknown): ReturnType<typeof canonical> {
  return canonical(kind, raw);
}

/** The stored form, for the columns the writeback patches. Lists are JSON in TEXT. */
export function toStored(kind: SyncFieldKind, value: ReturnType<typeof canonical>): unknown {
  if (kind === "list") return JSON.stringify(value ?? []);
  if (kind === "boolean") return value ? 1 : 0;
  return value;
}

/* -------------------------------------------------------------------------- */
/* Projection and hashing                                                      */
/* -------------------------------------------------------------------------- */

export interface ProjectOptions {
  includePii: boolean;
  /** Values the worker computed — every `derived` field the map names. */
  derived?: Record<string, unknown>;
}

/** The canonical Podium-space values of every mapped field. The hash input. */
export function projectCanonical(
  subject: string,
  row: Record<string, unknown>,
  fieldMap: SyncFieldMap[],
  opts: ProjectOptions,
): Record<string, ReturnType<typeof canonical>> {
  const out: Record<string, ReturnType<typeof canonical>> = {};
  for (const entry of fieldMap) {
    const spec = fieldSpec(subject, entry.field);
    if (!spec) continue;
    if (spec.pii && !opts.includePii) continue;
    const raw = spec.derived ? opts.derived?.[entry.field] : row[entry.field];
    out[entry.field] = canonical(spec.kind, raw);
  }
  return out;
}

/** The record handed to the provider: external column names, provider-shaped values. */
export function projectForPush(
  subject: string,
  row: Record<string, unknown>,
  fieldMap: SyncFieldMap[],
  opts: ProjectOptions,
): Record<string, unknown> {
  const values = projectCanonical(subject, row, fieldMap, opts);
  const out: Record<string, unknown> = {};
  for (const entry of fieldMap) {
    if (!(entry.field in values)) continue;
    const spec = fieldSpec(subject, entry.field);
    if (!spec) continue;
    out[entry.external_field] = toExternal(spec.kind, values[entry.field]);
  }
  return out;
}

/**
 * The inbound half: an external record, in Podium's value space.
 *
 * Returns every mapped field, not only the writable ones, because the hash that
 * detects an echo (INV-09-19) has to cover exactly what the push covered.
 * `patch` is separately the subset that may actually be written.
 */
export interface InboundProjection {
  /** Canonical values for every mapped field the record carried. */
  values: Record<string, ReturnType<typeof canonical>>;
  /** The writable subset, in stored form, ready for a service call. */
  patch: Record<string, unknown>;
  /** Mapped fields the record did not carry at all — absent, not blank. */
  absent: string[];
}

export function projectInbound(
  subject: string,
  external: Record<string, unknown>,
  fieldMap: SyncFieldMap[],
  opts: ProjectOptions,
): InboundProjection {
  const values: Record<string, ReturnType<typeof canonical>> = {};
  const patch: Record<string, unknown> = {};
  const absent: string[] = [];
  const writable = new Set(writableEntries(subject, fieldMap).map((e) => e.field));

  for (const entry of fieldMap) {
    const spec = fieldSpec(subject, entry.field);
    if (!spec) continue;
    if (spec.pii && !opts.includePii) continue;
    if (!(entry.external_field in external)) {
      absent.push(entry.field);
      continue;
    }
    const value = fromExternal(spec.kind, external[entry.external_field]);
    values[entry.field] = value;
    if (writable.has(entry.field)) patch[entry.field] = toStored(spec.kind, value);
  }
  return { values, patch, absent };
}

/**
 * SHA-256 over the canonical values, with object keys sorted.
 *
 * `JSON.stringify` preserves insertion order, so two projections of the same
 * record could hash differently purely because the field map was reordered.
 * Sorting is what makes the comparison in INV-09-19 mean what it says.
 */
export async function syncHash(values: Record<string, unknown>): Promise<string> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key];
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * INV-09-19 — the mechanism the whole design rests on.
 *
 * A push changes the external record; the provider reports a change; the pull
 * writes it back; the write raises a domain event; the event schedules a push.
 * Every naive two-way sync contains that loop and no timer fixes it. An inbound
 * record matching either hash we already know about is this system hearing
 * itself, and is dropped without a write, an event, or a run counter.
 */
export function isEcho(hash: string, link: { last_pushed_hash?: unknown; last_pulled_hash?: unknown }): boolean {
  return hash === link.last_pushed_hash || hash === link.last_pulled_hash;
}

/* -------------------------------------------------------------------------- */
/* Event types that make a record dirty                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where the dirtied record's id comes from.
 *
 * `subject` — `DomainEvent.subject.id` is already the record.
 * `person`   — the event is about a person; find the row by its `personColumn`.
 *              `speaker_profile.updated` carries the *person* id, not the
 *              profile id, because the subject of that fact is the person (10,
 *              naming rule 3).
 * `data`     — the id is a field of the payload, which is how one fact dirties
 *              a different record than the one it is about.
 */
export type SyncDirtySource = { kind: "subject" } | { kind: "person" } | { kind: "data"; key: string };

export interface SyncDirtyRule {
  pattern: string;
  subject: SyncSubject;
  from: SyncDirtySource;
  /** Why this rule exists, where it is not the obvious one. */
  why?: string;
}

/**
 * The reaction map row in 10, as data.
 *
 * Wildcards rather than `*`: the dispatcher writes an `event_reaction_log` row
 * for every event a reaction *matches*, so a `*` subscription costs a D1 insert
 * per event forever — the same reason `platform.room_broadcast` lists its types.
 *
 * The non-obvious rows are the ones that dirty a record the event is not about.
 * A derived column is still a column somebody is looking at: if a speaker
 * changes their name and only the `person` table updates, the sessions grid
 * keeps showing the old one until something unrelated happens to touch it.
 */
export const SYNC_DIRTY_RULES: SyncDirtyRule[] = [
  { pattern: "proposal.*", subject: "proposal", from: { kind: "subject" } },
  { pattern: "session.*", subject: "session", from: { kind: "subject" } },
  { pattern: "session_speaker.*", subject: "session", from: { kind: "subject" }, why: "speaker_names is derived" },
  { pattern: "event_participant.*", subject: "event_participant", from: { kind: "subject" } },
  { pattern: "sponsor.*", subject: "sponsor", from: { kind: "subject" } },
  { pattern: "sponsorship.*", subject: "sponsorship", from: { kind: "subject" } },
  { pattern: "entitlement.*", subject: "entitlement", from: { kind: "subject" } },
  { pattern: "placement.*", subject: "placement", from: { kind: "subject" } },
  { pattern: "prospect.*", subject: "prospect_card", from: { kind: "subject" } },
  { pattern: "decision.*", subject: "decision", from: { kind: "subject" } },
  { pattern: "person.*", subject: "person", from: { kind: "subject" } },

  {
    pattern: "placement.*",
    subject: "session",
    from: { kind: "data", key: "session_id" },
    why: "the schedule columns on a session — room_name, starts_at, ends_at — live on Placement (08)",
  },
  {
    pattern: "decision.*",
    subject: "proposal",
    from: { kind: "data", key: "proposal_id" },
    why: "decision_outcome is derived onto the proposal row",
  },
  {
    pattern: "speaker_profile.*",
    subject: "speaker_profile",
    from: { kind: "person" },
    why: "the event carries the person id, not the profile id",
  },
  { pattern: "person.*", subject: "speaker_profile", from: { kind: "person" }, why: "full_name is derived" },
  { pattern: "person.*", subject: "event_participant", from: { kind: "person" }, why: "full_name and email are derived" },
  { pattern: "person.*", subject: "prospect_card", from: { kind: "person" }, why: "full_name is derived" },
];

/** Every event type pattern the sync reaction subscribes to, deduplicated. */
export const SYNC_DIRTY_EVENT_TYPES: string[] = [...new Set(SYNC_DIRTY_RULES.map((r) => r.pattern))];
