/**
 * Derived read models for 05 — `CriterionScore.effective_score`,
 * `Review.overall_score`, `ProposalScore` and `ReviewerProgress`.
 *
 * Every field here is marked `D` in the model. None of it has a column and
 * none of it is writable through any API (INV-11-6); stored counters drift,
 * and a drifted count here means a proposal is reviewed the wrong number of
 * times.
 */

import type {
  AssignmentStatus,
  Confidence,
  CriterionView,
  Recommendation,
  ReviewFlag,
  ReviewView,
  ScoreView,
} from "./types.js";
import type { Instant } from "../shared/time.js";

/* -------------------------------------------------------------------------- */
/* effective_score                                                             */
/* -------------------------------------------------------------------------- */

/**
 * INV-05-14 — `effective_score` is `value_number` for `numeric`, the selected
 * option's `score` for `select`, 0 or `scale_max` for `boolean`, and null for
 * `text` and for any option without a `score`. Criteria contributing null are
 * excluded from means, never counted as zero.
 */
export function effectiveScore(criterion: CriterionView, score: ScoreView | null | undefined): number | null {
  if (!score) return null;
  switch (criterion.type) {
    case "numeric":
      return typeof score.value_number === "number" ? score.value_number : null;
    case "select": {
      if (!score.value_option) return null;
      const option = criterion.options.find((o) => o.value === score.value_option);
      // An option with no `score` is a verdict, not a number: histogram only.
      if (!option || option.score === null || option.score === undefined) return null;
      return Number(option.score);
    }
    case "boolean": {
      if (score.value_bool === null || score.value_bool === undefined) return null;
      return score.value_bool ? (criterion.scale_max ?? 1) : 0;
    }
    case "text":
      // Free text carries the reasoning, never a number. `weight` is ignored.
      return null;
  }
}

/** The lowest and highest `effective_score` a criterion can contribute, or null. */
export function criterionRange(criterion: CriterionView): { min: number; max: number } | null {
  switch (criterion.type) {
    case "numeric":
      if (criterion.scale_min === null || criterion.scale_max === null) return null;
      return { min: criterion.scale_min, max: criterion.scale_max };
    case "select": {
      const scores = criterion.options
        .map((o) => o.score)
        .filter((s): s is number => s !== null && s !== undefined)
        .map(Number);
      if (scores.length === 0) return null;
      return { min: Math.min(...scores), max: Math.max(...scores) };
    }
    case "boolean":
      return { min: 0, max: criterion.scale_max ?? 1 };
    case "text":
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Review.overall_score                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `Review.overall_score` (`D`) — the weighted mean of the criterion scores.
 * Criteria whose `effective_score` is null are excluded from the denominator
 * as well as the numerator (INV-05-14), so a text criterion neither drags the
 * mean down nor inflates it.
 */
export function reviewOverallScore(criteria: CriterionView[], scores: ScoreView[]): number | null {
  const byCriterion = new Map(scores.map((s) => [s.criterion_id, s]));
  let weighted = 0;
  let totalWeight = 0;
  for (const criterion of criteria) {
    const value = effectiveScore(criterion, byCriterion.get(criterion.id));
    if (value === null) continue;
    const weight = Number.isFinite(criterion.weight) ? criterion.weight : 1;
    if (weight <= 0) continue;
    weighted += value * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return round2(weighted / totalWeight);
}

/** The theoretical bounds of `overall_score` under a rubric, for normalisation. */
export function overallScoreRange(criteria: CriterionView[]): { min: number; max: number } | null {
  let minWeighted = 0;
  let maxWeighted = 0;
  let totalWeight = 0;
  for (const criterion of criteria) {
    const range = criterionRange(criterion);
    if (!range) continue;
    const weight = Number.isFinite(criterion.weight) ? criterion.weight : 1;
    if (weight <= 0) continue;
    minWeighted += range.min * weight;
    maxWeighted += range.max * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return { min: minWeighted / totalWeight, max: maxWeighted / totalWeight };
}

/* -------------------------------------------------------------------------- */
/* ProposalScore                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `confidence` weights for `ProposalScore.weighted_mean`. The model says the
 * mean is "weighted by `confidence`" without fixing the numbers; these are the
 * implementation's choice and are deliberately linear rather than exponential,
 * so one self-declared expert cannot outvote three reviewers.
 */
export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
  expert: 4,
};

export interface ProposalScore {
  proposal_id: string;
  round_id: string;
  review_count: number;
  submitted_count: number;
  stale_count: number;
  /** AI reviews are counted and reported separately, never pooled. */
  human_review_count: number;
  ai_review_count: number;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  weighted_mean: number | null;
  per_criterion_mean: Record<string, number>;
  per_criterion_histogram: Record<string, Record<string, number>>;
  recommendation_histogram: Record<string, number>;
  disagreement: number | null;
  has_quorum: boolean;
  flag_counts: Record<string, number>;
  /** Convenience for the results table; not a model field. */
  target_reviews_per_proposal: number;
}

export interface AggregateInput {
  proposal_id: string;
  round_id: string;
  criteria: CriterionView[];
  reviews: ReviewView[];
  target_reviews_per_proposal: number;
}

/**
 * `ProposalScore` — recomputed when a review is submitted, superseded or goes
 * stale, and never stored.
 *
 * Every score-derived figure (mean, median, stddev, weighted mean, per-criterion
 * means and histograms, recommendation histogram, disagreement) is computed over
 * **human** reviews only; `ai_review_count` reports the machine's opinions
 * beside them rather than inside them (05, "AI first-pass evaluation").
 * `flag_counts` is the exception and spans both, because a flag is a routing
 * signal (R21) rather than a score.
 */
export function aggregateProposalScore(input: AggregateInput): ProposalScore {
  const { criteria, reviews } = input;

  const live = reviews.filter((r) => r.status !== "superseded" && r.status !== "draft");
  const stale = live.filter((r) => r.status === "stale");
  const submitted = live.filter((r) => r.status === "submitted");

  // INV-05-17: quorum counts submitted, non-stale, non-superseded human reviews.
  const human = submitted.filter((r) => r.author_kind === "human");
  const ai = submitted.filter((r) => r.author_kind === "ai");

  const overall = human
    .map((r) => reviewOverallScore(criteria, r.scores))
    .filter((n): n is number => n !== null);

  const mean = overall.length ? round2(overall.reduce((a, b) => a + b, 0) / overall.length) : null;
  const median = overall.length ? round2(medianOf(overall)) : null;
  const stddev = overall.length > 1 ? round2(stddevOf(overall)) : overall.length === 1 ? 0 : null;

  let weightedNumerator = 0;
  let weightedDenominator = 0;
  for (const review of human) {
    const value = reviewOverallScore(criteria, review.scores);
    if (value === null) continue;
    const weight = review.confidence ? CONFIDENCE_WEIGHT[review.confidence] : CONFIDENCE_WEIGHT.medium;
    weightedNumerator += value * weight;
    weightedDenominator += weight;
  }
  const weighted_mean = weightedDenominator > 0 ? round2(weightedNumerator / weightedDenominator) : null;

  const per_criterion_mean: Record<string, number> = {};
  const per_criterion_histogram: Record<string, Record<string, number>> = {};
  for (const criterion of criteria) {
    const values: number[] = [];
    for (const review of human) {
      const score = review.scores.find((s) => s.criterion_id === criterion.id);
      const value = effectiveScore(criterion, score);
      if (value !== null) values.push(value);
      if (criterion.type === "select" && score?.value_option) {
        const bucket = (per_criterion_histogram[criterion.key] ??= {});
        bucket[score.value_option] = (bucket[score.value_option] ?? 0) + 1;
      }
    }
    if (values.length > 0) {
      per_criterion_mean[criterion.key] = round2(values.reduce((a, b) => a + b, 0) / values.length);
    }
  }

  const recommendation_histogram: Record<string, number> = {};
  for (const review of human) {
    if (!review.recommendation) continue;
    recommendation_histogram[review.recommendation] = (recommendation_histogram[review.recommendation] ?? 0) + 1;
  }

  const flag_counts: Record<string, number> = {};
  for (const review of live) {
    for (const flag of review.flags ?? []) {
      flag_counts[flag] = (flag_counts[flag] ?? 0) + 1;
    }
  }

  return {
    proposal_id: input.proposal_id,
    round_id: input.round_id,
    review_count: live.length,
    submitted_count: submitted.length,
    stale_count: stale.length,
    human_review_count: human.length,
    ai_review_count: ai.length,
    mean,
    median,
    stddev,
    weighted_mean,
    per_criterion_mean,
    per_criterion_histogram,
    recommendation_histogram,
    disagreement: disagreementOf(stddev, overallScoreRange(criteria)),
    // INV-05-17: an AI review never satisfies quorum.
    has_quorum: human.length >= input.target_reviews_per_proposal,
    flag_counts,
    target_reviews_per_proposal: input.target_reviews_per_proposal,
  };
}

/**
 * `disagreement` — normalised stddev, the chair's triage signal. Normalised by
 * half the rubric's possible range, so the maximum disagreement a rubric can
 * express (half the reviewers at the floor, half at the ceiling) reads as 1.0
 * whatever the scale. Without a computable range there is nothing to normalise
 * against and the signal is null rather than a misleading zero.
 */
export function disagreementOf(stddev: number | null, range: { min: number; max: number } | null): number | null {
  if (stddev === null || !range) return null;
  const half = (range.max - range.min) / 2;
  if (half <= 0) return null;
  return round2(Math.min(1, stddev / half));
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddevOf(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* ReviewerProgress                                                            */
/* -------------------------------------------------------------------------- */

export interface AssignmentProgressView {
  id: string;
  reviewer_person_id: string;
  status: AssignmentStatus;
  due_at: Instant | null;
  reminder_count: number;
  last_reminded_at: Instant | null;
  assigned_at: Instant;
  submitted_at: Instant | null;
}

export interface ReviewerProgress {
  round_id: string;
  reviewer_person_id: string;
  assigned: number;
  accepted: number;
  declined: number;
  submitted: number;
  outstanding: number;
  overdue: number;
  completion_pct: number;
  last_activity_at: Instant | null;
  reminder_count: number;
  last_reminded_at: Instant | null;
}

const OUTSTANDING: AssignmentStatus[] = ["assigned", "accepted", "in_progress"];

/**
 * `ReviewerProgress` (derived, per round per reviewer) — 05, "Progress and
 * chasing". It must be **live**: a dashboard that says 0 of 2 complete ten
 * minutes after the reviewer finished is a dashboard nobody trusts twice.
 */
export function reviewerProgress(
  roundId: string,
  reviewerPersonId: string,
  assignments: AssignmentProgressView[],
  now: Instant,
): ReviewerProgress {
  const mine = assignments.filter((a) => a.reviewer_person_id === reviewerPersonId);
  const outstanding = mine.filter((a) => OUTSTANDING.includes(a.status));
  const submitted = mine.filter((a) => a.status === "submitted");
  const assigned = mine.length;

  let lastActivity: Instant | null = null;
  for (const a of mine) {
    for (const candidate of [a.submitted_at, a.assigned_at]) {
      if (candidate && (lastActivity === null || candidate > lastActivity)) lastActivity = candidate;
    }
  }

  let lastReminded: Instant | null = null;
  let reminders = 0;
  for (const a of mine) {
    reminders += a.reminder_count ?? 0;
    if (a.last_reminded_at && (lastReminded === null || a.last_reminded_at > lastReminded)) {
      lastReminded = a.last_reminded_at;
    }
  }

  return {
    round_id: roundId,
    reviewer_person_id: reviewerPersonId,
    assigned,
    accepted: mine.filter((a) => a.status === "accepted").length,
    declined: mine.filter((a) => a.status === "declined").length,
    submitted: submitted.length,
    outstanding: outstanding.length,
    overdue: outstanding.filter((a) => a.due_at !== null && a.due_at < now).length,
    completion_pct: assigned === 0 ? 0 : Math.round((submitted.length / assigned) * 100),
    last_activity_at: lastActivity,
    reminder_count: reminders,
    last_reminded_at: lastReminded,
  };
}

export function allReviewerProgress(
  roundId: string,
  assignments: AssignmentProgressView[],
  poolPersonIds: string[],
  now: Instant,
): ReviewerProgress[] {
  const ids = [...new Set([...poolPersonIds, ...assignments.map((a) => a.reviewer_person_id)])];
  return ids.map((id) => reviewerProgress(roundId, id, assignments, now));
}

export type { Recommendation, ReviewFlag };
