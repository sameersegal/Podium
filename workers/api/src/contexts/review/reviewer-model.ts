/**
 * The reviewer's two screens, as data.
 *
 * `/review` and `/review/:assignmentId` are rendered twice — once as HTML by
 * `reviewer-views.ts`, once as JSON for the console that owns the same two URLs
 * (R30). Both halves load from here, so the two surfaces cannot answer a
 * reviewer's "what do I still owe" differently. Where they ever disagree, this
 * file is the definition and the disagreement is the defect.
 *
 * It is a read model and nothing else: no writes, no transitions. The three
 * things a reviewer does — save a draft, submit, decline — stay in `service.ts`
 * behind the same functions both surfaces already call.
 *
 * ## What the JSON half may say
 *
 * The screen's own withholding rules are enforced here rather than in the view,
 * because a rule enforced in a view is a rule the other surface does not have:
 *
 * - **Reviewer identity** is stripped from other people's reviews unless the
 *   round is fully `open` (05, "Fairness rules made explicit") — the same rule
 *   `GET /v1/reviews` applies, applied at the same depth.
 * - **Other reviews, the aggregate and the discussion** are absent, not merely
 *   unrendered, until `canSeeOtherReviews` says otherwise (INV-05-6). A client
 *   that receives them and hides them has already been told.
 * - **Conflicts are counted, never listed** (INV-05-18): the subject of a
 *   conflict is a person, and naming the withheld proposals leaks exactly what
 *   withholding them was for.
 * - **The proposal arrives already blinded** by `reviewableFor`, so
 *   `double_blind` withholds the speakers from the payload rather than from the
 *   markup.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { reviewerIdentityVisible, type ReviewableProjection } from "@podiumstack/domain/review/anonymity.js";
import type { ProposalScore, ReviewerProgress } from "@podiumstack/domain/review/scoring.js";
import {
  CONFIDENCE,
  DECLINE_REASON,
  RECOMMENDATION,
  REVIEW_FLAG,
  type AssignmentStatus,
  type CriterionView,
  type ReviewView,
  type RubricView,
  type ScoreView,
} from "@podiumstack/domain/review/types.js";
import { humanise } from "../../ui/layout.js";
import { loadReviews, progressForReviewer, proposalScoreFor, requireRound, requireRubric, type RoundView } from "./scoring.js";
import { canSeeOtherReviews, currentReviewFor, listComments, requireOwnAssignment, reviewableFor } from "./service.js";

/* ========================================================================== */
/* The queue — /review                                                        */
/* ========================================================================== */

export interface ReviewerAssignmentRow {
  assignment: Row;
  round_name: string;
  /**
   * Track, format and duration, already blinded — never a speaker name, which
   * `double_blind` withholds (R10). It is on the card so a reviewer picking
   * their next one is not choosing between eleven identical titles.
   */
  proposal: { reference: string; title: string } | null;
  meta: string[];
}

/** The round a reviewer is working in, as much of it as the queue needs. */
export interface ReviewerRound {
  id: string;
  name: string;
  anonymity: string;
  closes_at: string | null;
}

export interface ReviewerQueueModel {
  rows: ReviewerAssignmentRow[];
  progressByRound: Record<string, ReviewerProgress>;
  rounds: ReviewerRound[];
  /** Declared conflicts, counted — never listed (INV-05-18). */
  conflicts: number;
  now: string;
}

/**
 * Every assignment this person holds, in the order they should work them.
 *
 * Track, format and duration come along so the queue can say what each proposal
 * *is*. None of the three is blinded under any anonymity setting — R10 hides
 * speaker names, co-speaker names and employers, not the shape of the talk — so
 * joining them here is safe for every round at once.
 */
export async function loadReviewerQueue(app: AppContext, personId: string, now: string): Promise<ReviewerQueueModel> {
  const assignmentRows = await app.db.raw<Row>(
    `SELECT ra.*, rr.name AS round_name,
            p.reference AS proposal_reference, p.title AS proposal_title,
            p.requested_duration_minutes, p.audience_level,
            t.name AS track_name, f.name AS format_name
       FROM review_assignment ra
       JOIN review_round rr ON rr.id = ra.round_id
       LEFT JOIN proposal p ON p.id = ra.proposal_id
       LEFT JOIN track t ON t.id = COALESCE(p.assigned_track_id, p.track_id)
       LEFT JOIN session_format f ON f.id = p.session_format_id
      WHERE ra.reviewer_person_id = ?
      ORDER BY (ra.due_at IS NULL), ra.due_at, ra.assigned_at`,
    [personId],
  );
  const rows: ReviewerAssignmentRow[] = assignmentRows.map((r) => ({
    assignment: r,
    round_name: str(r.round_name),
    proposal: r.proposal_reference ? { reference: str(r.proposal_reference), title: str(r.proposal_title) } : null,
    meta: [
      strOrNull(r.track_name),
      strOrNull(r.format_name),
      r.requested_duration_minutes ? `${num(r.requested_duration_minutes)} min` : null,
      strOrNull(r.audience_level) ? humanise(str(r.audience_level)) : null,
    ].filter((x): x is string => Boolean(x)),
  }));

  const roundIds = [...new Set(assignmentRows.map((r) => str(r.round_id)))];
  const progressByRound: Record<string, ReviewerProgress> = {};
  for (const roundId of roundIds) progressByRound[roundId] = await progressForReviewer(app, roundId, personId);

  // The rounds themselves, for the rail's context card and the pace sentence: a
  // reviewer budgets against the date the round shuts, not against a percentage.
  // Anonymity comes with them because it decides what the queue is allowed to
  // promise the reader they will not see (R10).
  const rounds: ReviewerRound[] = [];
  for (const roundId of roundIds) {
    const row = await app.db.byId<Row>("review_round", roundId);
    if (row) {
      rounds.push({
        id: roundId,
        name: str(row.name),
        anonymity: str(row.anonymity),
        closes_at: strOrNull(row.closes_at),
      });
    }
  }

  const conflicts = rows.length ? (await app.db.select<Row>("conflict_of_interest", { reviewer_person_id: personId })).length : 0;

  return { rows, progressByRound, rounds, conflicts, now };
}

/**
 * The queue as `/v1/me/assignments` answers it.
 *
 * A tighter shape than the row the SQL above produces: `/v1` is a published
 * contract and `SELECT ra.*` is not one — a column added to `review_assignment`
 * for the chair's benefit would silently become part of what a reviewer's
 * browser receives.
 */
export function toQueueView(model: ReviewerQueueModel): Record<string, unknown> {
  return {
    rows: model.rows.map((r) => ({
      id: str(r.assignment.id),
      round_id: str(r.assignment.round_id),
      round_name: r.round_name,
      status: str(r.assignment.status) as AssignmentStatus,
      due_at: strOrNull(r.assignment.due_at),
      assigned_at: strOrNull(r.assignment.assigned_at),
      submitted_at: strOrNull(r.assignment.submitted_at),
      proposal_id: strOrNull(r.assignment.proposal_id),
      proposal: r.proposal,
      meta: r.meta,
    })),
    rounds: model.rounds,
    progress: model.progressByRound,
    conflicts: model.conflicts,
    now: model.now,
  };
}

/* ========================================================================== */
/* The rail                                                                   */
/* ========================================================================== */

export interface ReviewerRail {
  counts: { queue: number; submitted: number; declined: number };
  /** Every round this person holds an assignment in — the rail's context card. */
  rounds: ReviewerRound[];
}

/**
 * What the reviewer's rail says, loaded in the boot document rather than after
 * it — `ui/rail-counts.ts` for the other console rail, and here for this one,
 * for the same reason: a rail whose numbers arrive one round trip late is a
 * rail that visibly renumbers itself while being read.
 *
 * Two statements, not one: the counts are an aggregate over the assignments and
 * the rounds are a join out of them, and D1 charges for round trips rather than
 * for subselects, so folding the second into the first would mean a row per
 * assignment carrying the same three totals.
 */
export async function loadReviewerRail(app: AppContext, personId: string): Promise<ReviewerRail> {
  const [totals] = await app.db.raw<Row>(
    `SELECT
       SUM(CASE WHEN status IN ('assigned','accepted','in_progress') THEN 1 ELSE 0 END) AS queue,
       SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
       SUM(CASE WHEN status NOT IN ('assigned','accepted','in_progress','submitted') THEN 1 ELSE 0 END) AS declined
     FROM review_assignment WHERE reviewer_person_id = ?`,
    [personId],
  );
  const rounds = await app.db.raw<Row>(
    `SELECT DISTINCT rr.id, rr.name, rr.anonymity, rr.closes_at
       FROM review_assignment ra JOIN review_round rr ON rr.id = ra.round_id
      WHERE ra.reviewer_person_id = ?
      ORDER BY rr.closes_at`,
    [personId],
  );
  return {
    counts: {
      queue: totals ? num(totals.queue, 0) : 0,
      submitted: totals ? num(totals.submitted, 0) : 0,
      declined: totals ? num(totals.declined, 0) : 0,
    },
    rounds: rounds.map((r) => ({
      id: str(r.id),
      name: str(r.name),
      anonymity: str(r.anonymity),
      closes_at: strOrNull(r.closes_at),
    })),
  };
}

/* ========================================================================== */
/* The scorecard — /review/:assignmentId                                      */
/* ========================================================================== */

export interface ScorecardModel {
  assignment: Row;
  round: RoundView;
  rubric: RubricView;
  criteria: CriterionView[];
  proposal: ReviewableProjection;
  review: Row | null;
  scores: ScoreView[];
  naCriterionIds: string[];
  canSeeOthers: boolean;
  otherReviews: ReviewView[];
  aggregate: ProposalScore | null;
  comments: Row[];
  /** Where this one sits in the reviewer's outstanding queue. */
  position: { index: number; total: number; previous: string | null; next: string | null } | null;
  now: string;
}

/**
 * Whether this assignment is this person's to open, without throwing.
 *
 * The console's boot document asks before it boots, so `/review/:assignmentId`
 * for an assignment that is not the reader's falls through to the
 * server-rendered route and is refused there with the invariant named — rather
 * than booting a console that 403s on its first fetch. INV-05-18 says such a
 * request is *denied*, not merely unlinked, and a 200 carrying an empty shell
 * is neither.
 */
export async function ownsAssignment(app: AppContext, personId: string, assignmentId: string): Promise<boolean> {
  try {
    await requireOwnAssignment(app, personId, assignmentId);
    return true;
  } catch {
    return false;
  }
}

/** The outstanding queue, in the order the reviewer works it. */
export async function outstandingQueue(app: AppContext, personId: string): Promise<string[]> {
  const rows = await app.db.raw<Row>(
    `SELECT id FROM review_assignment
      WHERE reviewer_person_id = ? AND status IN ('assigned','accepted','in_progress')
      ORDER BY (due_at IS NULL), due_at, assigned_at`,
    [personId],
  );
  return rows.map((r) => str(r.id));
}

/**
 * One assignment, everything needed to score it, in one read.
 *
 * `requireOwnAssignment` is the guard, not a capability row: the reviewer
 * surface is scoped by whose assignment it is (INV-05-18 + INV-11-7).
 */
export async function loadScorecard(app: AppContext, personId: string, assignmentId: string, now: string): Promise<ScorecardModel> {
  const assignment = await requireOwnAssignment(app, personId, assignmentId);
  const round = await requireRound(app, str(assignment.round_id));
  const { rubric, criteria } = await requireRubric(app, round.rubric_id);
  const proposal = await reviewableFor(app, str(assignment.proposal_id), round.anonymity);
  const reviewRow = await currentReviewFor(app, assignmentId);
  const scoreRows = reviewRow ? await app.db.select<Row>("criterion_score", { review_id: str(reviewRow.id) }) : [];
  const scores: ScoreView[] = scoreRows.map((s) => ({
    criterion_id: str(s.criterion_id),
    value_number: s.value_number === null || s.value_number === undefined ? null : num(s.value_number),
    value_option: strOrNull(s.value_option),
    value_text: strOrNull(s.value_text),
    value_bool: s.value_bool === null || s.value_bool === undefined ? null : bool(s.value_bool),
  }));
  const naCriterionIds = scoreRows
    .filter((s) => s.value_number === null && !s.value_option && !s.value_text && (s.value_bool === null || s.value_bool === undefined))
    .map((s) => str(s.criterion_id));

  const canSeeOthers = await canSeeOtherReviews(app, round, assignment);
  const otherReviews = canSeeOthers
    ? (await loadReviews(app, { round_id: round.id, proposal_id: str(assignment.proposal_id) })).filter(
        (r) => r.id !== (reviewRow ? str(reviewRow.id) : null) && r.status !== "superseded" && r.status !== "draft",
      )
    : [];
  const aggregate = canSeeOthers ? await proposalScoreFor(app, round.id, str(assignment.proposal_id)) : null;
  const comments = round.discussion_enabled && canSeeOthers ? await listComments(app, str(assignment.proposal_id), false) : [];

  const queue = await outstandingQueue(app, personId);
  const at = queue.indexOf(assignmentId);
  const position = at >= 0 ? { index: at, total: queue.length, previous: queue[at - 1] ?? null, next: queue[at + 1] ?? null } : null;

  return { assignment, round, rubric, criteria, proposal, review: reviewRow, scores, naCriterionIds, canSeeOthers, otherReviews, aggregate, comments, position, now };
}

/**
 * The four enums a scorecard is answered with, sent with the scorecard.
 *
 * The client-rendered surface needs the members and their labels, and the one
 * thing it must not do is hold its own copy: enums are additive and a member
 * added in `05` would then reach the server-rendered scorecard and not the
 * console, in the same release, silently. `humanise` is the same function the
 * server-rendered `opts()` labels them with.
 */
function scorecardEnums(): Record<string, { value: string; label: string }[]> {
  const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: humanise(v) }));
  return {
    recommendation: opts(RECOMMENDATION),
    confidence: opts(CONFIDENCE),
    flags: opts(REVIEW_FLAG),
    decline_reason: opts(DECLINE_REASON),
  };
}

/** The scorecard as `/v1/me/assignments/:assignmentId` answers it. */
export function toScorecardView(m: ScorecardModel): Record<string, unknown> {
  const identityVisible = reviewerIdentityVisible(m.round.anonymity);
  const review = m.review;
  return {
    assignment: {
      id: str(m.assignment.id),
      round_id: m.round.id,
      proposal_id: strOrNull(m.assignment.proposal_id),
      status: str(m.assignment.status) as AssignmentStatus,
      due_at: strOrNull(m.assignment.due_at),
      submitted_at: strOrNull(m.assignment.submitted_at),
    },
    round: {
      id: m.round.id,
      name: m.round.name,
      anonymity: m.round.anonymity,
      closes_at: m.round.closes_at ?? null,
      discussion_enabled: m.round.discussion_enabled,
    },
    proposal: m.proposal,
    rubric: m.rubric,
    criteria: m.criteria,
    enums: scorecardEnums(),
    review: review
      ? {
          id: str(review.id),
          status: str(review.status),
          recommendation: strOrNull(review.recommendation),
          confidence: strOrNull(review.confidence),
          comments_for_committee: strOrNull(review.comments_for_committee),
          comments_for_speaker: strOrNull(review.comments_for_speaker),
          flags: JSON.parse(str(review.flags, "[]") || "[]") as string[],
          updated_at: strOrNull(review.updated_at),
        }
      : null,
    scores: m.scores,
    na_criterion_ids: m.naCriterionIds,
    can_see_others: m.canSeeOthers,
    // 05, "Fairness rules made explicit" — the same rule `GET /v1/reviews`
    // applies. A reviewer reading the committee's other reviews learns what
    // they said, never who they were, unless the round is fully open.
    other_reviews: m.otherReviews.map((r) => ({
      id: r.id,
      author_kind: r.author_kind,
      reviewer_person_id: identityVisible ? r.reviewer_person_id : null,
      recommendation: r.recommendation,
      confidence: r.confidence,
      comments_for_committee: r.comments_for_committee,
      ai_rationale: r.ai_rationale,
      status: r.status,
    })),
    aggregate: m.aggregate,
    // Body and visibility, which is what the screen shows. The author is not on
    // it: a discussion thread that names its speakers on a blind round is the
    // anonymity leak that the projection above exists to prevent.
    comments: m.comments.map((c) => ({
      id: str(c.id),
      visibility: str(c.visibility),
      body: str(c.body),
      created_at: strOrNull(c.created_at),
    })),
    position: m.position,
    now: m.now,
  };
}
