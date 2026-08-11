/**
 * 06 — Program. Enums, the two state machines, and the pure rules that decide
 * whether a session may move.
 *
 * No I/O here: the aggregate root enforces its invariants against plain data so
 * the rules can be tested without a database.
 */

import { illegalTransition, invariantError } from "../shared/errors.js";

export const SESSION_ORIGIN = ["cfp", "sponsor", "invited", "organizer"] as const;
export type SessionOrigin = (typeof SESSION_ORIGIN)[number];

export const SESSION_STATUS = [
  "pending_confirmation",
  "confirmed",
  "scheduled",
  "published",
  "cancelled",
  "delivered",
] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export const CONTENT_STATUS = ["draft", "in_review", "approved", "changes_requested"] as const;
export type ContentStatus = (typeof CONTENT_STATUS)[number];

export const SESSION_VISIBILITY = ["internal", "public"] as const;
export type SessionVisibility = (typeof SESSION_VISIBILITY)[number];

export const SPEAKER_ROLE = ["primary", "co_speaker", "moderator", "panelist", "host"] as const;
export type SpeakerRole = (typeof SPEAKER_ROLE)[number];

export const SPEAKER_CONFIRMATION_STATUS = ["pending", "confirmed", "declined", "withdrawn", "replaced"] as const;
export type SpeakerConfirmationStatus = (typeof SPEAKER_CONFIRMATION_STATUS)[number];

export const TRAVEL_STATUS = ["not_required", "pending", "booked", "self_arranged", "declined"] as const;
export type TravelStatus = (typeof TRAVEL_STATUS)[number];

export const ATTENDANCE_MODE = ["in_person", "remote"] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODE)[number];

export const SESSION_RELATION = [
  "part_of_series",
  "continues_in",
  "prerequisite_for",
  "merged_from",
  "alternative_to",
] as const;
export type SessionRelationKind = (typeof SESSION_RELATION)[number];

export const SESSION_ASSET_KIND = [
  "slides",
  "cover_image",
  "handout",
  "code_repo_link",
  "recording",
  "transcript",
  "other",
] as const;
export type SessionAssetKind = (typeof SESSION_ASSET_KIND)[number];

export const REVISION_CHANGE_KIND = [
  "organizer_edit",
  "speaker_edit",
  "decision_import",
  "restore",
  "approval_change",
] as const;
export type RevisionChangeKind = (typeof REVISION_CHANGE_KIND)[number];

/* -------------------------------------------------------------------------- */
/* Content fields                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The full content snapshot a `SessionRevision` carries (INV-06-13) — the
 * "Program content" block of the `Session` table, so a restore never has to
 * replay diffs.
 */
export const REVISION_CONTENT_FIELDS = [
  "title",
  "subtitle",
  "abstract",
  "description",
  "session_format_id",
  "track_id",
  "duration_minutes",
  "audience_level",
  "keywords",
  "language",
] as const;
export type RevisionContentField = (typeof REVISION_CONTENT_FIELDS)[number];

/**
 * INV-06-12 names exactly these as the *published* content fields: editing one
 * of them on an `approved` session returns it to `draft`.
 */
export const APPROVAL_GATED_FIELDS = [
  "title",
  "subtitle",
  "abstract",
  "description",
  "track_id",
  "session_format_id",
  "duration_minutes",
] as const;
export type ApprovalGatedField = (typeof APPROVAL_GATED_FIELDS)[number];

/** The fields R14 / INV-06-9 compare against the decision snapshot. */
export const DIVERGENCE_FIELDS = [
  "title",
  "abstract",
  "description",
  "session_format_id",
  "duration_minutes",
  "track_id",
] as const;

export type ContentSnapshot = Record<string, unknown>;

export function contentSnapshot(row: Record<string, unknown>): ContentSnapshot {
  const out: ContentSnapshot = {};
  for (const f of REVISION_CONTENT_FIELDS) out[f] = row[f] ?? null;
  return out;
}

export interface FieldDiff {
  from: unknown;
  to: unknown;
}

/** `{field: {from, to}}` — the `SessionRevision.diff` shape. */
export function diffContent(
  before: ContentSnapshot,
  after: ContentSnapshot,
  fields: readonly string[] = REVISION_CONTENT_FIELDS,
): Record<string, FieldDiff> {
  const diff: Record<string, FieldDiff> = {};
  for (const f of fields) {
    if (!sameValue(before[f], after[f])) diff[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return diff;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined || b === "";
  if (b === null || b === undefined) return a === "";
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return String(a) === String(b);
}

/** Did an edit touch a field INV-06-12 gates approval on? */
export function touchesApprovedContent(diff: Record<string, FieldDiff>): string[] {
  return APPROVAL_GATED_FIELDS.filter((f) => f in diff);
}

/**
 * R14 / INV-06-9 — `content_diverged` is derived: the session's content differs
 * from the decision snapshot it was created from. A filter on the programme
 * board, never a notification.
 */
export function contentDiverged(session: ContentSnapshot, decisionBaseline: ContentSnapshot | null): boolean {
  if (!decisionBaseline) return false;
  return DIVERGENCE_FIELDS.some((f) => !sameValue(session[f], decisionBaseline[f]));
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the arrows drawn in 06, "Lifecycle". An undrawn transition does not
 * exist.
 */
export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  pending_confirmation: ["confirmed", "cancelled"],
  confirmed: ["scheduled", "cancelled"],
  scheduled: ["confirmed", "published", "cancelled"],
  published: ["scheduled", "cancelled", "delivered"],
  cancelled: [],
  delivered: [],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return (SESSION_TRANSITIONS[from] ?? []).includes(to);
}

export function assertSessionTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransitionSession(from, to)) throw illegalTransition("Session", from, to);
}

export function isTerminalSession(status: SessionStatus): boolean {
  return status === "cancelled" || status === "delivered";
}

/** The two states creation may start in (06, "Creation"). */
export const SESSION_INITIAL_STATUSES: SessionStatus[] = ["pending_confirmation", "confirmed"];

/* -------------------------------------------------------------------------- */
/* Content approval                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the arrows drawn in 06, "Content approval". Note that
 * `draft → approved` is **not** drawn: content is submitted for editorial
 * review first, and approving is a decision on a submission rather than a
 * shortcut past one.
 */
export const CONTENT_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["in_review"],
  in_review: ["approved", "changes_requested"],
  changes_requested: ["in_review"],
  approved: ["draft", "in_review"],
};

export function canTransitionContent(from: ContentStatus, to: ContentStatus): boolean {
  return (CONTENT_TRANSITIONS[from] ?? []).includes(to);
}

export function assertContentTransition(from: ContentStatus, to: ContentStatus): void {
  if (!canTransitionContent(from, to)) throw illegalTransition("Session content", from, to);
}

/* -------------------------------------------------------------------------- */
/* Confirmation                                                                */
/* -------------------------------------------------------------------------- */

export interface SpeakerView {
  person_id: string;
  speaker_role: SpeakerRole;
  confirmation_status: SpeakerConfirmationStatus;
}

export interface ConfirmationCheck {
  confirmable: boolean;
  reasons: string[];
}

/**
 * INV-06-4 — a session may not reach `confirmed` while any `primary` speaker is
 * `pending` or `declined`, except `origin = sponsor` sessions with zero
 * speakers: the contract is confirmed even though the human is not.
 *
 * A declining co-speaker does not block the talk; a declining primary does.
 */
export function confirmationCheck(origin: SessionOrigin, speakers: SpeakerView[]): ConfirmationCheck {
  const live = speakers.filter((s) => s.confirmation_status !== "replaced" && s.confirmation_status !== "withdrawn");
  if (live.length === 0) {
    // INV-06-4, the carve-out.
    if (origin === "sponsor") return { confirmable: true, reasons: [] };
    return { confirmable: false, reasons: ["No speakers are credited on this session yet."] };
  }
  const reasons: string[] = [];
  const primaries = live.filter((s) => s.speaker_role === "primary");
  if (primaries.length === 0) reasons.push("No primary speaker is credited on this session.");
  for (const p of primaries) {
    if (p.confirmation_status === "pending") reasons.push(`Primary speaker ${p.person_id} has not confirmed.`);
    if (p.confirmation_status === "declined") reasons.push(`Primary speaker ${p.person_id} declined.`);
  }
  for (const c of live.filter((s) => s.speaker_role !== "primary")) {
    if (c.confirmation_status === "pending") reasons.push(`Co-speaker ${c.person_id} has not answered.`);
  }
  return { confirmable: reasons.length === 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Format rules                                                                */
/* -------------------------------------------------------------------------- */

export interface FormatLimits {
  min_duration_minutes?: number | null;
  max_duration_minutes?: number | null;
  max_speakers?: number | null;
  name?: string;
}

/** INV-06-6 — `duration_minutes` must be within the format's min/max when set. */
export function assertDurationWithinFormat(duration: number, limits: FormatLimits): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw invariantError("INV-06-6", "invalid_duration", "A session's duration must be a positive number of minutes.", {
      duration_minutes: duration,
    });
  }
  const min = limits.min_duration_minutes ?? null;
  const max = limits.max_duration_minutes ?? null;
  if (min !== null && duration < min) {
    throw invariantError(
      "INV-06-6",
      "duration_out_of_range",
      `${limits.name ?? "This format"} runs for at least ${min} minutes; ${duration} is too short.`,
      { duration_minutes: duration, min_duration_minutes: min, max_duration_minutes: max },
    );
  }
  if (max !== null && duration > max) {
    throw invariantError(
      "INV-06-6",
      "duration_out_of_range",
      `${limits.name ?? "This format"} runs for at most ${max} minutes; ${duration} is too long.`,
      { duration_minutes: duration, min_duration_minutes: min, max_duration_minutes: max },
    );
  }
}

/**
 * INV-06-3 — speaker count must not exceed `SessionFormat.max_speakers` unless
 * an organizer records an override reason (the reason lands on the audit row,
 * per INV-11-5).
 */
export function assertSpeakerLimit(currentCount: number, limits: FormatLimits, overrideReason?: string | null): void {
  const max = limits.max_speakers ?? null;
  if (max === null || currentCount <= max) return;
  if (overrideReason && overrideReason.trim().length > 0) return;
  throw invariantError(
    "INV-06-3",
    "speaker_limit_exceeded",
    `${limits.name ?? "This format"} allows at most ${max} speaker${max === 1 ? "" : "s"}. Record an override reason to add another.`,
    { max_speakers: max, speaker_count: currentCount },
  );
}

/* -------------------------------------------------------------------------- */
/* Publication readiness                                                       */
/* -------------------------------------------------------------------------- */

export interface PublicationReadiness {
  publishable: boolean;
  reasons: { code: string; invariant: string; message: string }[];
}

/**
 * The two gates 08 asks Program about before a session may enter a snapshot:
 * INV-06-5 (blocking onboarding tasks) and INV-06-11 (editorial approval).
 * Either may be overridden only by a chair recording an explicit reason.
 */
export function publicationReadinessOf(input: {
  status: SessionStatus;
  visibility: SessionVisibility;
  content_status: ContentStatus;
  blocking_tasks_outstanding: number;
  publication_override_reason?: string | null;
}): PublicationReadiness {
  const reasons: PublicationReadiness["reasons"] = [];
  const override = (input.publication_override_reason ?? "").trim().length > 0;

  if (input.visibility === "internal") {
    // INV-06-8: internal sessions never appear in a snapshot — and no override
    // exists for this one, because it is the speaker's own confidentiality.
    reasons.push({
      code: "internal_session",
      invariant: "INV-06-8",
      message: "Internal sessions never appear in a publication snapshot.",
    });
  }
  if (input.status === "cancelled") {
    reasons.push({ code: "session_cancelled", invariant: "INV-06-7", message: "This session has been cancelled." });
  }
  if (input.blocking_tasks_outstanding > 0 && !override) {
    // INV-06-5
    reasons.push({
      code: "blocking_tasks_outstanding",
      invariant: "INV-06-5",
      message: `${input.blocking_tasks_outstanding} blocking onboarding task${
        input.blocking_tasks_outstanding === 1 ? "" : "s"
      } outstanding.`,
    });
  }
  if (input.content_status !== "approved" && !override) {
    // INV-06-11 — independent of INV-06-5; both must pass.
    reasons.push({
      code: "content_not_approved",
      invariant: "INV-06-11",
      message: `Content is ${input.content_status.replace(/_/g, " ")}, not approved.`,
    });
  }
  return { publishable: reasons.length === 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Sponsor rules                                                               */
/* -------------------------------------------------------------------------- */

/**
 * INV-06-2 — `origin = sponsor` requires `sponsor_id` (and a confirmed
 * sponsorship, checked against the repository); `origin = cfp` requires
 * `sponsor_id` to be null.
 */
export function assertSponsorShape(origin: SessionOrigin, sponsorId: string | null): void {
  if (origin === "sponsor" && !sponsorId) {
    throw invariantError("INV-06-2", "sponsor_required", "A sponsor session must name its sponsor.");
  }
  if (origin === "cfp" && sponsorId) {
    throw invariantError("INV-06-2", "sponsor_not_allowed", "A CFP session may not carry a sponsor.");
  }
}

/** `is_sponsored_content` is derived: `sponsor_id is not null` (INV-11-6). */
export function isSponsoredContent(session: { sponsor_id?: unknown }): boolean {
  return session.sponsor_id !== null && session.sponsor_id !== undefined && session.sponsor_id !== "";
}
