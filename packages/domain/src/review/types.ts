/**
 * 05 — Review & Selection. Enums, entity shapes and state machines.
 *
 * Enum members are written out because the model writes them out; adding one
 * is additive, removing or renaming one is breaking (docs/domain/README.md).
 */

import { illegalTransition } from "../shared/errors.js";
import type { Instant } from "../shared/time.js";

/* -------------------------------------------------------------------------- */
/* ReviewRound                                                                 */
/* -------------------------------------------------------------------------- */

export const ROUND_ANONYMITY = ["open", "single_blind", "double_blind"] as const;
export type RoundAnonymity = (typeof ROUND_ANONYMITY)[number];

export const ROUND_STATUS = ["draft", "open", "closed", "finalised"] as const;
export type RoundStatus = (typeof ROUND_STATUS)[number];

/**
 * The state diagram in 05. A transition that is not drawn does not exist:
 * `finalised` is terminal and nothing re-enters `draft`.
 */
export const ROUND_TRANSITIONS: Record<RoundStatus, RoundStatus[]> = {
  draft: ["open"],
  open: ["closed"],
  closed: ["open", "finalised"],
  finalised: [],
};

export function canTransitionRound(from: RoundStatus, to: RoundStatus): boolean {
  return ROUND_TRANSITIONS[from].includes(to);
}

export function assertRoundTransition(from: RoundStatus, to: RoundStatus): void {
  if (!canTransitionRound(from, to)) throw illegalTransition("Review round", from, to);
}

export const POOL_ROLE = ["reviewer", "meta_reviewer", "observer"] as const;
export type PoolRole = (typeof POOL_ROLE)[number];

export const POOL_STATUS = ["active", "removed"] as const;
export type PoolStatus = (typeof POOL_STATUS)[number];

/** `ReviewRound.scope` — which proposals are in play. */
export interface RoundScope {
  track_ids?: string[];
  format_ids?: string[];
  cfp_ids?: string[];
  min_prior_score?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Rubric                                                                      */
/* -------------------------------------------------------------------------- */

export const OVERALL_SCALE = ["none", "recommendation", "numeric"] as const;
export type OverallScale = (typeof OVERALL_SCALE)[number];

export const CRITERION_TYPE = ["numeric", "select", "text", "boolean"] as const;
export type CriterionType = (typeof CRITERION_TYPE)[number];

export interface CriterionOption {
  value: string;
  label: string;
  description?: string | null;
  /**
   * Optional. Where omitted the criterion is reported as a histogram and
   * excluded from the mean (INV-05-14) — some verdicts genuinely are not
   * numbers and averaging them invents precision.
   */
  score?: number | null;
}

export interface RubricView {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  version: number;
  overall_scale: OverallScale;
  requires_comment: boolean;
}

export interface CriterionView {
  id: string;
  rubric_id: string;
  key: string;
  label: string;
  description: string | null;
  type: CriterionType;
  scale_min: number | null;
  scale_max: number | null;
  options: CriterionOption[];
  max_length: number | null;
  weight: number;
  is_required: boolean;
  allows_na: boolean;
  sort_order: number;
}

/* -------------------------------------------------------------------------- */
/* ReviewAssignment                                                            */
/* -------------------------------------------------------------------------- */

export const ASSIGNED_BY = ["chair", "algorithm", "self"] as const;
export type AssignedBy = (typeof ASSIGNED_BY)[number];

export const ASSIGNMENT_STATUS = [
  "assigned",
  "accepted",
  "declined",
  "in_progress",
  "submitted",
  "revoked",
  "expired",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUS)[number];

/** Statuses no reminder is ever sent on — 05, "Progress and chasing". */
export const TERMINAL_ASSIGNMENT_STATUS: AssignmentStatus[] = ["declined", "submitted", "revoked", "expired"];

export function isTerminalAssignment(status: AssignmentStatus): boolean {
  return TERMINAL_ASSIGNMENT_STATUS.includes(status);
}

export const DECLINE_REASON = ["conflict_of_interest", "no_expertise", "no_capacity", "other"] as const;
export type DeclineReason = (typeof DECLINE_REASON)[number];

/* -------------------------------------------------------------------------- */
/* Review                                                                      */
/* -------------------------------------------------------------------------- */

export const AUTHOR_KIND = ["human", "ai"] as const;
export type AuthorKind = (typeof AUTHOR_KIND)[number];

export const RECOMMENDATION = [
  "strong_accept",
  "accept",
  "weak_accept",
  "neutral",
  "weak_reject",
  "reject",
  "strong_reject",
] as const;
export type Recommendation = (typeof RECOMMENDATION)[number];

export const CONFIDENCE = ["low", "medium", "high", "expert"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const REVIEW_FLAG = [
  "off_topic",
  "product_pitch",
  "duplicate",
  "needs_coi_check",
  "exceptional",
  "code_of_conduct_concern",
] as const;
export type ReviewFlag = (typeof REVIEW_FLAG)[number];

export const REVIEW_STATUS = ["draft", "submitted", "stale", "superseded"] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

export interface ScoreView {
  criterion_id: string;
  value_number: number | null;
  value_option: string | null;
  value_text: string | null;
  value_bool: boolean | null;
  note?: string | null;
}

export interface ReviewView {
  id: string;
  assignment_id: string | null;
  proposal_id: string;
  round_id: string;
  reviewer_person_id: string | null;
  author_kind: AuthorKind;
  ai_evaluator_key: string | null;
  ai_model: string | null;
  ai_rationale: string | null;
  overridden_by_person_id: string | null;
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  comments_for_committee: string | null;
  comments_for_speaker: string | null;
  flags: ReviewFlag[];
  status: ReviewStatus;
  reviewed_content_hash: string;
  submitted_at: Instant | null;
  scores: ScoreView[];
}

/* -------------------------------------------------------------------------- */
/* ConflictOfInterest                                                          */
/* -------------------------------------------------------------------------- */

export const COI_SUBJECT_TYPE = ["proposal", "person", "sponsor", "company_domain"] as const;
export type CoiSubjectType = (typeof COI_SUBJECT_TYPE)[number];

export const COI_REASON = [
  "same_employer",
  "co_author",
  "personal",
  "financial",
  "advisor",
  "undisclosed_other",
] as const;
export type CoiReason = (typeof COI_REASON)[number];

export const COI_SOURCE = ["declared_by_reviewer", "declared_by_chair", "auto_detected"] as const;
export type CoiSource = (typeof COI_SOURCE)[number];

/* -------------------------------------------------------------------------- */
/* ReviewComment                                                               */
/* -------------------------------------------------------------------------- */

/** Never speaker-visible (INV-05-7). There is no `public` member, by design. */
export const COMMENT_VISIBILITY = ["committee_only", "chairs_only"] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITY)[number];

/* -------------------------------------------------------------------------- */
/* Decision                                                                    */
/* -------------------------------------------------------------------------- */

export const DECISION_OUTCOME = ["accept", "waitlist", "reject", "request_changes"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOME)[number];

export const DECISION_STATUS = ["provisional", "published", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUS)[number];

/**
 * The state diagram in 05. `provisional → provisional` is drawn on purpose:
 * chairs change their minds for days before anything reaches a speaker.
 */
export const DECISION_TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
  provisional: ["provisional", "published"],
  published: ["superseded"],
  superseded: [],
};

export function canTransitionDecision(from: DecisionStatus, to: DecisionStatus): boolean {
  return DECISION_TRANSITIONS[from].includes(to);
}

export function assertDecisionTransition(from: DecisionStatus, to: DecisionStatus): void {
  if (!canTransitionDecision(from, to)) throw illegalTransition("Decision", from, to, "INV-05-9");
}

/* -------------------------------------------------------------------------- */
/* ReviewRoundReminderRule                                                     */
/* -------------------------------------------------------------------------- */

export const REMINDER_CHANNEL = ["email", "chat"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNEL)[number];

export const ESCALATE_TO = ["none", "program_chair", "track_lead"] as const;
export type EscalateTo = (typeof ESCALATE_TO)[number];

/** `review_assignment.reminded.trigger` — 05, "Reminders come in both flavours". */
export const REMINDER_TRIGGER = ["scheduled", "manual"] as const;
export type ReminderTrigger = (typeof REMINDER_TRIGGER)[number];

export function isEnumMember<T extends readonly string[]>(members: T, value: unknown): value is T[number] {
  return typeof value === "string" && (members as readonly string[]).includes(value);
}
