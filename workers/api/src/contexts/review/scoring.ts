/**
 * Review read models — the loaders behind `ProposalScore`, `ReviewerProgress`
 * and the results table (05, "Aggregation — ProposalScore").
 *
 * Nothing here writes. Every figure it returns is derived and recomputed at
 * read time (INV-11-6): there is no `proposal_score` table and there never
 * will be, because a drifted review count means a proposal is reviewed the
 * wrong number of times.
 *
 * The review tables carry no `org_id` of their own, so INV-11-1 is enforced by
 * resolving the owning `event` through the org-scoped repository first —
 * `requireRound` and `requireRubric` are the only doors in.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import {
  aggregateProposalScore,
  allReviewerProgress,
  effectiveScore,
  reviewOverallScore,
  reviewerProgress,
  type AssignmentProgressView,
  type ProposalScore,
  type ReviewerProgress,
} from "@podiumconf/domain/review/scoring.js";
import type { ConflictRecord, ProposalConflictSubject } from "@podiumconf/domain/review/coi.js";
import type {
  ProposalAnswerView,
  ProposalSpeakerView,
  ReviewableProposal,
} from "@podiumconf/domain/review/anonymity.js";
import type {
  AssignmentStatus,
  AuthorKind,
  Confidence,
  CriterionOption,
  CriterionType,
  CriterionView,
  Recommendation,
  ReviewFlag,
  ReviewStatus,
  ReviewView,
  RoundAnonymity,
  RoundScope,
  RoundStatus,
  RubricView,
  ScoreView,
} from "@podiumconf/domain/review/types.js";
import { notFound } from "@podiumconf/domain/shared/errors.js";
import type { FieldType } from "@podiumconf/domain/event-config/types.js";
import { referenceLabels } from "../submissions/answer-labels.js";

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                  */
/* -------------------------------------------------------------------------- */

export interface RoundRow extends Row {
  id: string;
  event_id: string;
  name: string;
  sequence: number;
  rubric_id: string;
  scope: string | null;
  anonymity: string;
  opens_at: string;
  closes_at: string;
  target_reviews_per_proposal: number;
  max_assignments_per_reviewer: number | null;
  allow_self_assignment: number;
  show_other_reviews_before_submit: number;
  discussion_enabled: number;
  status: string;
  row_version: number;
}

export interface RoundView {
  id: string;
  event_id: string;
  name: string;
  sequence: number;
  rubric_id: string;
  scope: RoundScope;
  anonymity: RoundAnonymity;
  opens_at: string;
  closes_at: string;
  target_reviews_per_proposal: number;
  max_assignments_per_reviewer: number | null;
  allow_self_assignment: boolean;
  show_other_reviews_before_submit: boolean;
  discussion_enabled: boolean;
  status: RoundStatus;
  row_version: number;
}

export function toRoundView(row: Row): RoundView {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    name: str(row.name),
    sequence: num(row.sequence, 1),
    rubric_id: str(row.rubric_id),
    scope: parseJson<RoundScope>(row.scope, {}),
    anonymity: str(row.anonymity, "double_blind") as RoundAnonymity,
    opens_at: str(row.opens_at),
    closes_at: str(row.closes_at),
    target_reviews_per_proposal: num(row.target_reviews_per_proposal, 2),
    max_assignments_per_reviewer:
      row.max_assignments_per_reviewer === null || row.max_assignments_per_reviewer === undefined
        ? null
        : num(row.max_assignments_per_reviewer),
    allow_self_assignment: bool(row.allow_self_assignment),
    show_other_reviews_before_submit: bool(row.show_other_reviews_before_submit),
    discussion_enabled: bool(row.discussion_enabled),
    status: str(row.status, "draft") as RoundStatus,
    row_version: num(row.row_version, 1),
  };
}

export function toRubricView(row: Row): RubricView {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    name: str(row.name),
    description: strOrNull(row.description),
    version: num(row.version, 1),
    overall_scale: str(row.overall_scale, "recommendation") as RubricView["overall_scale"],
    requires_comment: bool(row.requires_comment),
  };
}

export function toCriterionView(row: Row): CriterionView {
  return {
    id: str(row.id),
    rubric_id: str(row.rubric_id),
    key: str(row.key),
    label: str(row.label),
    description: strOrNull(row.description),
    type: str(row.type, "numeric") as CriterionType,
    scale_min: row.scale_min === null || row.scale_min === undefined ? null : num(row.scale_min),
    scale_max: row.scale_max === null || row.scale_max === undefined ? null : num(row.scale_max),
    options: parseJson<CriterionOption[]>(row.options, []),
    max_length: row.max_length === null || row.max_length === undefined ? null : num(row.max_length),
    weight: num(row.weight, 1),
    is_required: bool(row.is_required),
    allows_na: bool(row.allows_na),
    sort_order: num(row.sort_order, 0),
  };
}

export function toScoreView(row: Row): ScoreView {
  return {
    criterion_id: str(row.criterion_id),
    value_number: row.value_number === null || row.value_number === undefined ? null : num(row.value_number),
    value_option: strOrNull(row.value_option),
    value_text: strOrNull(row.value_text),
    value_bool: row.value_bool === null || row.value_bool === undefined ? null : bool(row.value_bool),
    note: strOrNull(row.note),
  };
}

export function toReviewView(row: Row, scores: ScoreView[]): ReviewView {
  return {
    id: str(row.id),
    assignment_id: strOrNull(row.assignment_id),
    proposal_id: str(row.proposal_id),
    round_id: str(row.round_id),
    reviewer_person_id: strOrNull(row.reviewer_person_id),
    author_kind: str(row.author_kind, "human") as AuthorKind,
    ai_evaluator_key: strOrNull(row.ai_evaluator_key),
    ai_model: strOrNull(row.ai_model),
    ai_rationale: strOrNull(row.ai_rationale),
    overridden_by_person_id: strOrNull(row.overridden_by_person_id),
    recommendation: strOrNull(row.recommendation) as Recommendation | null,
    confidence: strOrNull(row.confidence) as Confidence | null,
    comments_for_committee: strOrNull(row.comments_for_committee),
    comments_for_speaker: strOrNull(row.comments_for_speaker),
    flags: parseJson<ReviewFlag[]>(row.flags, []),
    status: str(row.status, "draft") as ReviewStatus,
    reviewed_content_hash: str(row.reviewed_content_hash),
    submitted_at: strOrNull(row.submitted_at),
    scores,
  };
}

/* -------------------------------------------------------------------------- */
/* Doors in — org scoping (INV-11-1)                                           */
/* -------------------------------------------------------------------------- */

/** The round, having proved its `Event` is readable in this org. */
export async function requireRound(app: AppContext, roundId: string): Promise<RoundView> {
  const row = await app.db.byId<RoundRow>("review_round", roundId);
  if (!row) throw notFound("Review round", roundId);
  const event = await app.db.byId<Row>("event", str(row.event_id)); // INV-11-1
  if (!event) throw notFound("Review round", roundId);
  return toRoundView(row);
}

export async function requireEvent(app: AppContext, eventId: string): Promise<Row> {
  const event = await app.db.byId<Row>("event", eventId); // INV-11-1 + INV-11-2
  if (!event) throw notFound("Event", eventId);
  return event;
}

export async function requireRubric(
  app: AppContext,
  rubricId: string,
): Promise<{ rubric: RubricView; criteria: CriterionView[] }> {
  const row = await app.db.byId<Row>("rubric", rubricId);
  if (!row) throw notFound("Rubric", rubricId);
  const event = await app.db.byId<Row>("event", str(row.event_id)); // INV-11-1
  if (!event) throw notFound("Rubric", rubricId);
  return { rubric: toRubricView(row), criteria: await loadCriteria(app, rubricId) };
}

export async function loadCriteria(app: AppContext, rubricId: string): Promise<CriterionView[]> {
  const rows = await app.db.select<Row>("rubric_criterion", { rubric_id: rubricId }, { orderBy: "sort_order, key" });
  return rows.map(toCriterionView);
}

export async function listRubrics(app: AppContext, eventId: string): Promise<RubricView[]> {
  const rows = await app.db.select<Row>("rubric", { event_id: eventId }, { orderBy: "name, version DESC" });
  return rows.map(toRubricView);
}

export async function listRounds(app: AppContext, eventId: string): Promise<RoundView[]> {
  const rows = await app.db.select<Row>("review_round", { event_id: eventId }, { orderBy: "sequence, created_at" });
  return rows.map(toRoundView);
}

/* -------------------------------------------------------------------------- */
/* Round scope                                                                 */
/* -------------------------------------------------------------------------- */

export interface ScopedProposal extends Row {
  id: string;
  reference: string;
  title: string;
  track_id: string | null;
  session_format_id: string | null;
  cfp_id: string;
  status: string;
  sponsor_id: string | null;
  submitter_person_id: string;
  origin: string;
}

/**
 * The proposals in play for a round — `ReviewRound.scope`
 * (`{track_ids, format_ids, cfp_ids, min_prior_score}`).
 *
 * Sponsor sessions are excluded from `double_blind` rounds **by scope** rather
 * than by pretending they can be anonymised: the sponsor is the point (05,
 * "Fairness rules made explicit").
 */
export async function roundScopeProposals(app: AppContext, round: RoundView): Promise<ScopedProposal[]> {
  const where: Row = { event_id: round.event_id };
  if (round.scope.cfp_ids?.length) where.cfp_id = round.scope.cfp_ids;
  if (round.scope.track_ids?.length) where.track_id = round.scope.track_ids;
  if (round.scope.format_ids?.length) where.session_format_id = round.scope.format_ids;
  const rows = await app.db.select<ScopedProposal>("proposal", where, { orderBy: "reference" });

  const reviewable = rows.filter((p) => {
    const status = str(p.status);
    if (status === "draft" || status === "withdrawn" || status === "expired") return false;
    if (round.anonymity === "double_blind" && (str(p.origin) === "sponsor" || p.sponsor_id)) return false;
    return true;
  });

  if (round.scope.min_prior_score === null || round.scope.min_prior_score === undefined) return reviewable;

  // `min_prior_score` narrows a deep round to what survived the screening pass.
  const priorRounds = await app.db.select<Row>("review_round", { event_id: round.event_id });
  const earlier = priorRounds.filter((r) => num(r.sequence) < round.sequence).map((r) => str(r.id));
  if (earlier.length === 0) return reviewable;

  const kept: ScopedProposal[] = [];
  for (const proposal of reviewable) {
    let best: number | null = null;
    for (const roundId of earlier) {
      const prior = await proposalScoreFor(app, roundId, proposal.id);
      if (prior.mean !== null && (best === null || prior.mean > best)) best = prior.mean;
    }
    if (best !== null && best >= round.scope.min_prior_score) kept.push(proposal);
  }
  return kept;
}

/* -------------------------------------------------------------------------- */
/* Reviews and aggregation                                                     */
/* -------------------------------------------------------------------------- */

export async function loadReviews(app: AppContext, where: Row): Promise<ReviewView[]> {
  const rows = await app.db.select<Row>("review", where, { orderBy: "created_at" });
  if (rows.length === 0) return [];
  const scoreRows = await app.db.raw<Row>(
    `SELECT * FROM criterion_score WHERE review_id IN (${rows.map(() => "?").join(",")})`,
    rows.map((r) => str(r.id)),
  );
  const byReview = new Map<string, ScoreView[]>();
  for (const s of scoreRows) {
    const list = byReview.get(str(s.review_id)) ?? [];
    list.push(toScoreView(s));
    byReview.set(str(s.review_id), list);
  }
  return rows.map((r) => toReviewView(r, byReview.get(str(r.id)) ?? []));
}

/** `ProposalScore` for one proposal in one round. Derived, never stored. */
export async function proposalScoreFor(
  app: AppContext,
  roundId: string,
  proposalId: string,
  preloaded?: { criteria: CriterionView[]; reviews: ReviewView[]; target: number },
): Promise<ProposalScore> {
  if (preloaded) {
    return aggregateProposalScore({
      proposal_id: proposalId,
      round_id: roundId,
      criteria: preloaded.criteria,
      reviews: preloaded.reviews,
      target_reviews_per_proposal: preloaded.target,
    });
  }
  const round = await requireRound(app, roundId);
  const criteria = await loadCriteria(app, round.rubric_id);
  const reviews = await loadReviews(app, { round_id: roundId, proposal_id: proposalId });
  return aggregateProposalScore({
    proposal_id: proposalId,
    round_id: roundId,
    criteria,
    reviews,
    target_reviews_per_proposal: round.target_reviews_per_proposal,
  });
}

export interface ResultRow {
  proposal: ScopedProposal;
  score: ProposalScore;
  reviews: ReviewView[];
  decision: Row | null;
}

export interface ResultsView {
  round: RoundView;
  criteria: CriterionView[];
  rows: ResultRow[];
}

/**
 * The results table — the chair's working surface over `ProposalScore`: one row
 * per proposal with its aggregate, per-criterion means, recommendation
 * histogram, review count, quorum, staleness and decision state.
 */
export async function roundResults(app: AppContext, round: RoundView): Promise<ResultsView> {
  const criteria = await loadCriteria(app, round.rubric_id);
  const proposals = await roundScopeProposals(app, round);
  const reviews = await loadReviews(app, { round_id: round.id });
  const decisions = await app.db.select<Row>("decision", { round_id: round.id });

  const reviewsByProposal = new Map<string, ReviewView[]>();
  for (const r of reviews) {
    const list = reviewsByProposal.get(r.proposal_id) ?? [];
    list.push(r);
    reviewsByProposal.set(r.proposal_id, list);
  }
  const decisionByProposal = new Map<string, Row>();
  for (const d of decisions) {
    if (str(d.status) === "superseded") continue;
    decisionByProposal.set(str(d.proposal_id), d);
  }

  const rows: ResultRow[] = proposals.map((proposal) => {
    const proposalReviews = reviewsByProposal.get(proposal.id) ?? [];
    return {
      proposal,
      reviews: proposalReviews,
      score: aggregateProposalScore({
        proposal_id: proposal.id,
        round_id: round.id,
        criteria,
        reviews: proposalReviews,
        target_reviews_per_proposal: round.target_reviews_per_proposal,
      }),
      decision: decisionByProposal.get(proposal.id) ?? null,
    };
  });

  return { round, criteria, rows };
}

export const RESULT_SORTS = [
  "reference",
  "title",
  "mean",
  "weighted_mean",
  "median",
  "disagreement",
  "review_count",
  "quorum",
  "stale",
  "decision",
] as const;
export type ResultSort = (typeof RESULT_SORTS)[number];

export interface ResultFilters {
  track_id?: string | null;
  format_id?: string | null;
  flag?: string | null;
  decision_state?: string | null;
  quorum?: "yes" | "no" | null;
  sort?: ResultSort;
  direction?: "asc" | "desc";
}

/** Sortable on any column and filterable by track, format, flag and decision state. */
export function applyResultFilters(rows: ResultRow[], filters: ResultFilters): ResultRow[] {
  let out = rows;
  if (filters.track_id) out = out.filter((r) => str(r.proposal.track_id) === filters.track_id);
  if (filters.format_id) out = out.filter((r) => str(r.proposal.session_format_id) === filters.format_id);
  if (filters.flag) out = out.filter((r) => (r.score.flag_counts[filters.flag as string] ?? 0) > 0);
  if (filters.quorum === "yes") out = out.filter((r) => r.score.has_quorum);
  if (filters.quorum === "no") out = out.filter((r) => !r.score.has_quorum);
  if (filters.decision_state) {
    out = out.filter((r) =>
      filters.decision_state === "none"
        ? !r.decision
        : r.decision && (str(r.decision.outcome) === filters.decision_state || str(r.decision.status) === filters.decision_state),
    );
  }

  const sort = filters.sort ?? "reference";
  const direction = filters.direction === "desc" ? -1 : 1;
  const key = (r: ResultRow): number | string => {
    switch (sort) {
      case "title":
        return str(r.proposal.title).toLowerCase();
      case "mean":
        return r.score.mean ?? -1;
      case "weighted_mean":
        return r.score.weighted_mean ?? -1;
      case "median":
        return r.score.median ?? -1;
      case "disagreement":
        return r.score.disagreement ?? -1;
      case "review_count":
        return r.score.human_review_count;
      case "quorum":
        return r.score.has_quorum ? 1 : 0;
      case "stale":
        return r.score.stale_count;
      case "decision":
        return r.decision ? str(r.decision.outcome) : "";
      default:
        return str(r.proposal.reference);
    }
  };
  return [...out].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return str(a.proposal.reference).localeCompare(str(b.proposal.reference));
    return (ka < kb ? -1 : 1) * direction;
  });
}

/* -------------------------------------------------------------------------- */
/* ReviewerProgress                                                            */
/* -------------------------------------------------------------------------- */

export function toProgressView(row: Row): AssignmentProgressView {
  return {
    id: str(row.id),
    reviewer_person_id: str(row.reviewer_person_id),
    status: str(row.status, "assigned") as AssignmentStatus,
    due_at: strOrNull(row.due_at),
    reminder_count: num(row.reminder_count, 0),
    last_reminded_at: strOrNull(row.last_reminded_at),
    assigned_at: str(row.assigned_at),
    submitted_at: strOrNull(row.submitted_at),
  };
}

export async function progressForRound(app: AppContext, roundId: string): Promise<ReviewerProgress[]> {
  const assignments = await app.db.select<Row>("review_assignment", { round_id: roundId });
  const pool = await app.db.select<Row>("review_round_reviewer", { round_id: roundId, status: "active" });
  return allReviewerProgress(
    roundId,
    assignments.map(toProgressView),
    pool.filter((p) => str(p.pool_role) === "reviewer").map((p) => str(p.person_id)),
    app.now(),
  );
}

export async function progressForReviewer(
  app: AppContext,
  roundId: string,
  personId: string,
): Promise<ReviewerProgress> {
  const assignments = await app.db.select<Row>("review_assignment", { round_id: roundId, reviewer_person_id: personId });
  return reviewerProgress(roundId, personId, assignments.map(toProgressView), app.now());
}

/* -------------------------------------------------------------------------- */
/* Conflicts                                                                   */
/* -------------------------------------------------------------------------- */

export function toConflictRecord(row: Row): ConflictRecord {
  return {
    id: str(row.id),
    reviewer_person_id: str(row.reviewer_person_id),
    subject_type: str(row.subject_type) as ConflictRecord["subject_type"],
    subject_id: strOrNull(row.subject_id),
    subject_value: strOrNull(row.subject_value),
    reason: str(row.reason) as ConflictRecord["reason"],
    source: str(row.source) as ConflictRecord["source"],
  };
}

export async function loadConflicts(app: AppContext, eventId: string, reviewerPersonId?: string): Promise<ConflictRecord[]> {
  const where: Row = { event_id: eventId };
  if (reviewerPersonId) where.reviewer_person_id = reviewerPersonId;
  const rows = await app.db.select<Row>("conflict_of_interest", where);
  return rows.map(toConflictRecord);
}

/** Everything a `ConflictOfInterest` can attach to for one proposal. */
export async function conflictSubject(app: AppContext, proposalId: string): Promise<ProposalConflictSubject> {
  const proposal = await app.db.byId<Row>("proposal", proposalId);
  if (!proposal) throw notFound("Proposal", proposalId);
  const speakers = await app.db.select<Row>("proposal_speaker", { proposal_id: proposalId });
  const credited = speakers
    .filter((s) => str(s.participation_status) !== "removed")
    .map((s) => str(s.person_id));
  const personIds = [...new Set([str(proposal.submitter_person_id), ...credited])];
  const people = personIds.length
    ? await app.db.raw<Row>(
        `SELECT id, email FROM person WHERE id IN (${personIds.map(() => "?").join(",")})`,
        personIds,
      )
    : [];
  return {
    proposal_id: proposalId,
    submitter_person_id: str(proposal.submitter_person_id),
    credited_person_ids: credited,
    sponsor_id: strOrNull(proposal.sponsor_id),
    speaker_email_domains: people
      .map((p) => str(p.email).toLowerCase().split("@")[1] ?? "")
      .filter(Boolean),
  };
}

/* -------------------------------------------------------------------------- */
/* The reviewable proposal                                                     */
/* -------------------------------------------------------------------------- */

export async function loadReviewableProposal(app: AppContext, proposalId: string): Promise<ReviewableProposal> {
  const proposal = await app.db.byId<Row>("proposal", proposalId);
  if (!proposal) throw notFound("Proposal", proposalId);

  const answerRows = await app.db.select<Row>("proposal_answer", { proposal_id: proposalId });
  const fieldIds = [...new Set(answerRows.map((a) => str(a.form_field_id)).filter(Boolean))];
  const fields = fieldIds.length
    ? await app.db.raw<Row>(
        `SELECT id, key, label, type, options, pii, audience FROM form_field WHERE id IN (${fieldIds.map(() => "?").join(",")})`,
        fieldIds,
      )
    : [];
  const fieldById = new Map(fields.map((f) => [str(f.id), f]));
  const answers: ProposalAnswerView[] = answerRows.map((a) => {
    const field = fieldById.get(str(a.form_field_id));
    return {
      field_key: str(a.field_key),
      label: field ? str(field.label) : str(a.field_key),
      // A `short_text` fallback keeps an answer whose field version was hard
      // deleted readable as itself, rather than resolving as a reference.
      type: field ? (str(field.type) as FieldType) : ("short_text" as FieldType),
      options: field ? parseJson<{ value: string; label: string }[] | null>(field.options, null) : null,
      value: parseJson<unknown>(a.value, str(a.value)),
      pii: field ? bool(field.pii) : false,
    };
  });

  const speakerRows = await app.db.select<Row>("proposal_speaker", { proposal_id: proposalId }, { orderBy: "sort_order" });
  const speakers: ProposalSpeakerView[] = [];
  for (const s of speakerRows) {
    if (str(s.participation_status) === "removed") continue;
    const person = await app.db.byId<Row>("person", str(s.person_id));
    if (!person) continue;
    const profile = await app.db.first<Row>("speaker_profile", { person_id: str(s.person_id) });
    const links = profile
      ? await app.db.select<Row>("profile_link", { speaker_profile_id: str(profile.id) })
      : [];
    speakers.push({
      person_id: str(s.person_id),
      full_name: str(person.display_name) || str(person.full_name),
      company: profile ? strOrNull(profile.company) : null,
      headline: profile ? strOrNull(profile.headline) : null,
      bio: profile ? strOrNull(profile.bio) : null,
      links: links.map((l) => str(l.url)),
      email: str(person.email),
    });
  }

  const sponsor = proposal.sponsor_id ? await app.db.byId<Row>("sponsor", str(proposal.sponsor_id)) : null;

  return {
    id: proposalId,
    reference: str(proposal.reference),
    title: str(proposal.title),
    abstract: str(proposal.abstract),
    description: strOrNull(proposal.description),
    session_format_id: strOrNull(proposal.session_format_id),
    track_id: strOrNull(proposal.assigned_track_id) ?? strOrNull(proposal.track_id),
    requested_duration_minutes:
      proposal.requested_duration_minutes === null || proposal.requested_duration_minutes === undefined
        ? null
        : num(proposal.requested_duration_minutes),
    audience_level: strOrNull(proposal.audience_level),
    keywords: parseJson<string[]>(proposal.keywords, []),
    language: strOrNull(proposal.language),
    coi_disclosure: strOrNull(proposal.coi_disclosure),
    sponsor_id: strOrNull(proposal.sponsor_id),
    sponsor_name: sponsor ? str(sponsor.name) : null,
    answers,
    // Resolved here, blinded in `reviewableProjection`: what a reviewer may read
    // is the projection's decision, not this loader's.
    reference_labels: await referenceLabels(app, answers),
    speakers,
  };
}

/** `Review.overall_score`, re-exported so views do not reach into the domain package twice. */
export { effectiveScore, reviewOverallScore };
