/**
 * 04, "Submission-time validation".
 *
 * "Submit runs the full ruleset; autosave runs none of it beyond type coercion.
 * Failing rules are returned as a list keyed by `field_key` so the UI can route
 * each error back to the step that owns it."
 *
 * All eight rules live here, in the order the model states them, and each says
 * which rule it is. Pure: everything it needs is passed in.
 */

import { visibleSteps, type FormSpec } from "../event-config/types.js";
import type { Origin, RecordingConsent } from "../event-config/types.js";
import type { FieldError } from "../shared/errors.js";
import {
  checkFormatAndDeadline,
  checkQuantityAvailable,
  checkSponsorNotBlocked,
  checkSponsorshipUsable,
  consumedCount,
  type EntitlementCheckSubject,
  type EntitlementCounts,
  type RuleFailure,
} from "../sponsorship/types.js";
import { assetIdsIn, isBlank, stepKeyIndex, type AnswerMap } from "./answers.js";
import { checkSpeakers, type SpeakerView } from "./types.js";

export interface FormatView {
  id: string;
  name: string;
  default_duration_minutes: number;
  min_duration_minutes: number | null;
  max_duration_minutes: number | null;
  max_speakers: number;
  eligible_origins: string[];
  requires_recording_consent: boolean;
  /** Whether the CFP offers this format at all (`CfpFormatOption.is_available`). */
  available_in_cfp: boolean;
}

export interface SubmitValidationInput {
  form: FormSpec;
  answers: AnswerMap;
  origin: Origin;
  /** Promoted content as it stands, i.e. after `promoteAnswers`. */
  content: {
    session_format_id: string | null;
    track_id: string | null;
    requested_duration_minutes: number | null;
    recording_consent: RecordingConsent;
  };
  /** Rule 1 — the result of `acceptsSubmission` for this CFP. */
  cfp: { allowed: boolean; late: boolean; reason?: string };
  format: FormatView | null;
  /** Whether the chosen track is offered by this CFP (`CfpTrackOption.is_available`). */
  track_available: boolean;
  speakers: SpeakerView[];
  /** Rule 5 — `max_proposals_per_person` and the caller's live count under this CFP. */
  proposal_cap: { limit: number | null; current: number };
  /** Rule 6 — present only for `origin = sponsor`. */
  sponsor?: {
    sponsor: { name: string; status: string };
    sponsorship: { status: string };
    entitlement: EntitlementCheckSubject;
    counts: EntitlementCounts;
    event_name: string;
  } | null;
  /** Rule 8 — every asset referenced by an answer, with its scan status. */
  assets: { id: string; scan_status: string; field_key: string }[];
  now: string;
}

export interface SubmitValidation {
  field_errors: FieldError[];
  /** Rule failures that name an invariant rather than a field. */
  failures: RuleFailure[];
}

/**
 * Rule 2, scoped to a single step — what "Save and continue" checks before it
 * lets the submitter move on. The full ruleset still runs at submit; this is
 * the same required-answer rule applied early so a missing answer is named on
 * the step that owns it rather than discovered three steps later. "Save draft"
 * deliberately runs none of it: a draft may be as empty as a title.
 */
export function validateStep(form: FormSpec, answers: AnswerMap, stepKey: string): FieldError[] {
  const step = visibleSteps(form, answers).find((s) => s.key === stepKey);
  if (!step) return [];
  const errors: FieldError[] = [];
  for (const f of step.fields) {
    if (!f.is_required) continue;
    // The roster is managed by its own controls, not by an answer value.
    if (f.type === "speaker_list") continue;
    if (isBlank(answers[f.key])) errors.push({ field_key: f.key, message: `${f.label} is required.`, step_key: step.key });
  }
  return errors;
}

export function validateSubmission(input: SubmitValidationInput): SubmitValidation {
  const stepOf = stepKeyIndex(input.form);
  const fieldErrors: FieldError[] = [];
  const failures: RuleFailure[] = [];
  const add = (field_key: string, message: string) =>
    fieldErrors.push({ field_key, message, step_key: stepOf[field_key] });

  /* 1. The CFP is `open` (or within `grace_period_minutes`, or `allow_with_flag`). */
  if (!input.cfp.allowed) {
    failures.push({
      invariant: "INV-02-13",
      code: "cfp_not_accepting",
      message: input.cfp.reason ?? "This call for proposals is not accepting submissions.",
    });
  }

  /* 2. Every visible required field on every visible step has an answer. */
  for (const step of visibleSteps(input.form, input.answers)) {
    for (const f of step.fields) {
      if (!f.is_required) continue;
      if (isBlank(input.answers[f.key])) add(f.key, `${f.label} is required.`);
    }
  }

  /* 3. `maps_to` fields satisfy their domain constraints. */
  const mapped = mappedKeyFor(input.form);
  const formatKey = mapped.format;
  const trackKey = mapped.track;
  const durationKey = mapped.duration;

  if (!input.content.session_format_id) {
    if (formatKey) add(formatKey, "Choose a session format.");
  } else if (!input.format) {
    if (formatKey) add(formatKey, "That session format no longer exists.");
  } else {
    const fmt = input.format;
    if (!fmt.available_in_cfp && formatKey) {
      add(formatKey, `${fmt.name} is not open for submissions in this call for proposals.`);
    }
    // INV-02-2: a proposal's `origin` must be in its format's `eligible_origins`.
    if (!fmt.eligible_origins.includes(input.origin)) {
      failures.push({
        invariant: "INV-02-2",
        code: "origin_not_eligible_for_format",
        message: `${fmt.name} does not accept ${input.origin} submissions.`,
        details: { format_id: fmt.id, origin: input.origin, eligible_origins: fmt.eligible_origins },
      });
    }
    const duration = input.content.requested_duration_minutes ?? fmt.default_duration_minutes;
    if (fmt.min_duration_minutes !== null && duration < fmt.min_duration_minutes && durationKey) {
      add(durationKey, `${fmt.name} runs for at least ${fmt.min_duration_minutes} minutes.`);
    }
    if (fmt.max_duration_minutes !== null && duration > fmt.max_duration_minutes && durationKey) {
      add(durationKey, `${fmt.name} runs for at most ${fmt.max_duration_minutes} minutes.`);
    }
  }
  if (input.content.track_id && !input.track_available && trackKey) {
    add(trackKey, "That track is not open for submissions in this call for proposals.");
  }

  /* 4. Speaker count within `max_speakers`; a `primary` exists — unless sponsor. */
  const speakerProblem = checkSpeakers(input.origin, input.speakers, input.format?.max_speakers ?? 1);
  if (speakerProblem) {
    const key = mapped.speakers;
    if (key) add(key, speakerProblem.message);
    else failures.push({ invariant: "INV-04-5", code: speakerProblem.code, message: speakerProblem.message });
  }

  /* 5. `max_proposals_per_person` not exceeded, counting only non-withdrawn,
        non-rejected proposals by the same submitter under this CFP. */
  const cap = input.proposal_cap;
  if (cap.limit !== null && cap.current >= cap.limit) {
    failures.push({
      invariant: "INV-02-13",
      code: "proposal_limit_reached",
      // Drafts hold a slot too (INV-04-10), so "submitted" would be a lie to
      // anyone who got here with two drafts and one submission.
      message: `You already have ${cap.current} proposal${cap.current === 1 ? "" : "s"} in this call, counting drafts, and it allows ${cap.limit}. Withdraw one to free a slot.`,
      details: { limit: cap.limit, current: cap.current },
    });
  }

  /* 6. For `origin = sponsor`: INV-03-5 and INV-03-3 hold. */
  if (input.origin === "sponsor") {
    const s = input.sponsor;
    if (!s) {
      failures.push({
        invariant: "INV-04-3",
        code: "sponsor_entitlement_missing",
        message: "A sponsor session must be submitted against a sponsor entitlement.",
      });
    } else {
      const blocked = checkSponsorNotBlocked(s.sponsor); // INV-03-7
      if (blocked) failures.push(blocked);
      const usable = checkSponsorshipUsable(s.sponsorship, s.entitlement, input.now); // INV-03-2
      if (usable) failures.push(usable);
      const fmtRule = checkFormatAndDeadline(s.entitlement, input.content.session_format_id, input.now); // INV-03-5
      if (fmtRule) failures.push(fmtRule);
      // INV-03-3 — the error names the entitlement, not a generic 400.
      const quantity = checkQuantityAvailable(s.entitlement, s.counts, s.sponsor.name, s.event_name);
      if (quantity) failures.push(quantity);
    }
  }

  /* 7. `recording_consent != unanswered` when the format requires it. */
  if (input.format?.requires_recording_consent && input.content.recording_consent === "unanswered") {
    const key = mapped.recording_consent;
    const message = "Answer the recording consent question before submitting.";
    if (key) add(key, message);
    else failures.push({ invariant: "INV-04-12", code: "recording_consent_required", message });
  }

  /* 8. All referenced assets have `scan_status = clean` (INV-11-3). */
  const referenced = new Set<string>();
  for (const [key, value] of Object.entries(input.answers)) {
    for (const id of assetIdsIn(value)) referenced.add(`${key}:${id}`);
  }
  for (const asset of input.assets) {
    if (!referenced.has(`${asset.field_key}:${asset.id}`)) continue;
    if (asset.scan_status === "clean") continue;
    add(
      asset.field_key,
      asset.scan_status === "pending"
        ? "This file is still being scanned. Try again in a moment."
        : "This file failed the virus scan and cannot be submitted.",
    );
  }

  return { field_errors: fieldErrors, failures };
}

function mappedKeyFor(form: FormSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const step of form.steps) for (const f of step.fields) if (f.maps_to !== "none") out[f.maps_to] = f.key;
  return out;
}

/** Convenience for callers that only need "would this pass?". */
export function isSubmittable(v: SubmitValidation): boolean {
  return v.field_errors.length === 0 && v.failures.length === 0;
}

export { consumedCount };
