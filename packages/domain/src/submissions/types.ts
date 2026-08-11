/**
 * 04 — Submissions. Enums, the `Proposal` state machine, the derived
 * `content_hash`, and the plain-language next action the portal shows.
 *
 * Pure. The aggregate root is `Proposal`; `ProposalAnswer`, `ProposalSpeaker`,
 * `ProposalRevision` and `DraftProgress` live inside it and only change through
 * it, which is why the guards below are functions of the proposal's own state.
 */

import { contentHash } from "../identity/credentials.js";
import type { AudienceLevel, Origin, RecordingConsent } from "../event-config/types.js";
import { relativeDays } from "../shared/time.js";

export const PROPOSAL_STATUS = [
  "draft",
  "submitted",
  "in_review",
  "changes_requested",
  "accepted",
  "waitlisted",
  "rejected",
  "withdrawn",
  "expired",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number];

export const SPEAKER_ROLE = ["primary", "co_speaker", "moderator", "panelist"] as const;
export type SpeakerRole = (typeof SPEAKER_ROLE)[number];

export const PARTICIPATION_STATUS = ["pending", "accepted", "declined", "removed"] as const;
export type ParticipationStatus = (typeof PARTICIPATION_STATUS)[number];

export const CHANGE_KIND = ["draft_edit", "resubmission", "organizer_edit", "speaker_change"] as const;
export type ChangeKind = (typeof CHANGE_KIND)[number];

/**
 * Exactly the edges drawn in 04's state diagram. A transition that is not drawn
 * does not exist — `changes_requested --> withdrawn`, for instance, is absent
 * from the diagram and is therefore rejected here.
 */
export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  // draft --> submitted (submit) · draft --> withdrawn (discard)
  draft: ["submitted", "withdrawn"],
  // submitted --> draft (unsubmit) · in_review · accepted (review waived)
  // · rejected (desk reject) · withdrawn
  submitted: ["draft", "in_review", "accepted", "rejected", "withdrawn"],
  // in_review --> changes_requested · accepted · waitlisted · rejected · withdrawn
  in_review: ["changes_requested", "accepted", "waitlisted", "rejected", "withdrawn"],
  // changes_requested --> in_review (resubmit)
  changes_requested: ["in_review"],
  // accepted --> expired (deadline) · withdrawn (speaker declines)
  accepted: ["expired", "withdrawn"],
  // waitlisted --> accepted (promoted) · rejected (waitlist closed)
  waitlisted: ["accepted", "rejected"],
  rejected: [],
  withdrawn: [],
  // expired --> accepted (chair reinstates)
  expired: ["accepted"],
};

export function canTransitionProposal(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses that still consume `max_proposals_per_person` and hold an entitlement. */
export const ALIVE_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "submitted",
  "in_review",
  "changes_requested",
  "accepted",
  "waitlisted",
];

/**
 * 04, "`withdrawn` releases the entitlement hold … and frees a
 * `max_proposals_per_person` slot" (INV-04-10); `expired` and `rejected` do the
 * same, per the entitlement diagram in 03.
 */
export const RELEASED_STATUSES: readonly ProposalStatus[] = ["withdrawn", "rejected", "expired"];

export function isAlive(status: string): boolean {
  return (ALIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * INV-04-7 — content fields are immutable in `submitted`, `in_review`,
 * `accepted`, `waitlisted` and `rejected` except via an organizer edit.
 */
export const CONTENT_IMMUTABLE_STATUSES: readonly ProposalStatus[] = [
  "submitted",
  "in_review",
  "accepted",
  "waitlisted",
  "rejected",
];

export function contentIsImmutable(status: string): boolean {
  return (CONTENT_IMMUTABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * What a submitter may do with their own proposal right now.
 *
 * `submitted` is content-immutable (INV-04-7), so "edit after submit" is the
 * drawn `submitted --> draft: unsubmit (only while CFP open and
 * allow_edit_after_submit)` edge followed by an ordinary draft edit — not an
 * in-place mutation. `changes_requested` is the one state where a submitter can
 * edit after the CFP has closed (04, "Notes on the edges that matter").
 */
export interface EditAffordance {
  editable: boolean;
  /** True when editing must first take the proposal back to `draft`. */
  requires_unsubmit: boolean;
  reason?: string;
}

export function editAffordance(
  status: string,
  cfp: { accepts_edit: boolean; allow_edit_after_submit: boolean },
): EditAffordance {
  if (status === "draft") {
    return cfp.accepts_edit
      ? { editable: true, requires_unsubmit: false }
      : { editable: false, requires_unsubmit: false, reason: "This call for proposals has closed." };
  }
  if (status === "changes_requested") return { editable: true, requires_unsubmit: false };
  if (status === "submitted") {
    if (!cfp.allow_edit_after_submit) {
      return { editable: false, requires_unsubmit: false, reason: "This call for proposals does not allow edits after submitting." };
    }
    if (!cfp.accepts_edit) {
      return { editable: false, requires_unsubmit: false, reason: "This call for proposals has closed." };
    }
    return { editable: true, requires_unsubmit: true };
  }
  return { editable: false, requires_unsubmit: false, reason: `A ${status.replace(/_/g, " ")} proposal cannot be edited.` };
}

/** Whether the submitter may still withdraw, per `CallForProposals.withdraw_allowed_until`. */
export function canWithdraw(status: string, withdrawAllowedUntil: string): boolean {
  if (!canTransitionProposal(status as ProposalStatus, "withdrawn")) return false;
  if (withdrawAllowedUntil === "never") return false;
  if (withdrawAllowedUntil === "decision") return status === "draft" || status === "submitted" || status === "in_review";
  return true;
}

/* -------------------------------------------------------------------------- */
/* content_hash (INV-04-12)                                                    */
/* -------------------------------------------------------------------------- */

export interface ReviewableContent {
  title?: unknown;
  abstract?: unknown;
  description?: unknown;
  session_format_id?: unknown;
  requested_duration_minutes?: unknown;
  track_id?: unknown;
  audience_level?: unknown;
  keywords?: unknown;
}

/**
 * INV-04-12 — `content_hash` covers exactly the fields reviewers score against.
 * Derived (`D`), so there is no column: it is recomputed on read and on write,
 * and a change is what flags a submitted review `stale`.
 */
export const CONTENT_HASH_FIELDS = [
  "title",
  "abstract",
  "description",
  "session_format_id",
  "requested_duration_minutes",
  "track_id",
  "audience_level",
  "keywords",
] as const;

export function proposalContentHash(content: ReviewableContent): string {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === null || v === "") return null;
    if (Array.isArray(v)) return v.map((x) => String(x)).sort();
    return typeof v === "number" ? v : String(v);
  };
  return contentHash(CONTENT_HASH_FIELDS.map((f) => [f, norm(content[f])]));
}

/** The fields whose change is reported in `proposal.updated.changed_fields`. */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    const same = Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : String(a ?? "") === String(b ?? "");
    if (!same) out.push(key);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Speakers (INV-04-5)                                                         */
/* -------------------------------------------------------------------------- */

export interface SpeakerView {
  person_id: string;
  speaker_role: SpeakerRole;
  participation_status: ParticipationStatus;
}

export function activeSpeakers(speakers: SpeakerView[]): SpeakerView[] {
  return speakers.filter((s) => s.participation_status !== "removed");
}

/**
 * INV-04-5 — a non-`sponsor` proposal has exactly one `primary` speaker with
 * `participation_status != removed`; the count never exceeds
 * `SessionFormat.max_speakers`. A sponsor proposal may submit speaker-less:
 * "Forcing a placeholder speaker here is what produces the 'TBD TBD, Acme
 * Corp' rows that end up on printed programs."
 */
export function checkSpeakers(
  origin: Origin,
  speakers: SpeakerView[],
  maxSpeakers: number,
): { code: string; message: string } | null {
  const active = activeSpeakers(speakers);
  if (active.length > maxSpeakers) {
    return {
      code: "too_many_speakers",
      message: `This format allows at most ${maxSpeakers} speaker${maxSpeakers === 1 ? "" : "s"}; you have ${active.length}.`,
    };
  }
  const primaries = active.filter((s) => s.speaker_role === "primary");
  if (origin === "sponsor") {
    if (primaries.length > 1) {
      return { code: "multiple_primary_speakers", message: "Only one speaker can be the primary speaker." };
    }
    return null;
  }
  if (primaries.length === 0) {
    return { code: "no_primary_speaker", message: "Name a primary speaker before submitting." };
  }
  if (primaries.length > 1) {
    return { code: "multiple_primary_speakers", message: "Only one speaker can be the primary speaker." };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The submitter's next action (04, "Submitter portal read model")             */
/* -------------------------------------------------------------------------- */

export interface NextActionInput {
  status: string;
  percent_complete?: number;
  confirmation_deadline?: string | null;
  cfp_closes_at?: string | null;
  changes_requested_count?: number;
  now: string;
  timezone?: string;
}

export interface NextAction {
  label: string;
  urgency: "none" | "info" | "warn" | "err";
  /** The instant the label refers to, so the UI can render it in event time. */
  deadline: string | null;
}

/**
 * "A plain-language next action ('Awaiting decision', 'Confirm by 14 April',
 * '3 changes requested')". Deliberately a sentence a submitter can act on
 * rather than a status name repeated.
 */
export function nextAction(input: NextActionInput): NextAction {
  const { status, now } = input;
  switch (status) {
    case "draft": {
      const pct = input.percent_complete ?? 0;
      const closes = input.cfp_closes_at ?? null;
      const late = closes !== null && closes <= now;
      return {
        label: late
          ? "Draft — the call for proposals has closed"
          : closes
            ? `Finish and submit — closes ${relativeDays(closes, now)}`
            : `Finish and submit — ${pct}% complete`,
        urgency: late ? "err" : closes && new Date(closes).getTime() - new Date(now).getTime() < 3 * 86_400_000 ? "warn" : "info",
        deadline: closes,
      };
    }
    case "submitted":
      return { label: "Submitted — awaiting review", urgency: "none", deadline: null };
    case "in_review":
      return { label: "Awaiting decision", urgency: "none", deadline: null };
    case "changes_requested": {
      const n = input.changes_requested_count ?? 0;
      return {
        label: n > 0 ? `${n} change${n === 1 ? "" : "s"} requested — update and resubmit` : "Changes requested — update and resubmit",
        urgency: "warn",
        deadline: null,
      };
    }
    case "accepted": {
      const by = input.confirmation_deadline ?? null;
      if (!by) return { label: "Accepted — confirm your session", urgency: "warn", deadline: null };
      const overdue = by <= now;
      return {
        label: overdue ? "Accepted — your confirmation is overdue" : `Confirm by ${formatDeadline(by, input.timezone)}`,
        urgency: overdue ? "err" : "warn",
        deadline: by,
      };
    }
    case "waitlisted":
      return { label: "On the waitlist — we will be in touch", urgency: "info", deadline: null };
    case "rejected":
      return { label: "Not selected for this event", urgency: "none", deadline: null };
    case "withdrawn":
      return { label: "Withdrawn", urgency: "none", deadline: null };
    case "expired":
      return { label: "Expired — the confirmation deadline passed", urgency: "err", deadline: input.confirmation_deadline ?? null };
    default:
      return { label: status, urgency: "none", deadline: null };
  }
}

function formatDeadline(instant: string, timezone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: timezone }).format(new Date(instant));
  } catch {
    return instant.slice(0, 10);
  }
}

/* -------------------------------------------------------------------------- */
/* Promoted content                                                            */
/* -------------------------------------------------------------------------- */

export interface PromotedContent {
  title: string;
  abstract: string;
  description: string | null;
  session_format_id: string | null;
  requested_duration_minutes: number | null;
  track_id: string | null;
  audience_level: AudienceLevel | null;
  keywords: string[];
  av_requirements: string[];
  recording_consent: RecordingConsent;
  recording_conditions: string | null;
  coi_disclosure: string | null;
}

export const EMPTY_PROMOTED: PromotedContent = {
  title: "",
  abstract: "",
  description: null,
  session_format_id: null,
  requested_duration_minutes: null,
  track_id: null,
  audience_level: null,
  keywords: [],
  av_requirements: [],
  recording_consent: "unanswered",
  recording_conditions: null,
  coi_disclosure: null,
};
