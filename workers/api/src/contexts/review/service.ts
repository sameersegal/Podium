/**
 * Review & Selection — 05-review-and-selection.md.
 *
 * Aggregate roots: `ReviewRound`, `Rubric`, `Review`, `Decision`.
 *
 * The governing constraint is **evidence integrity**: a review must be
 * attributable, tied to the exact content it was written against, and
 * impossible to quietly rewrite after the fact. INV-05-3 (supersede, never
 * mutate) and INV-05-8 (`reviewed_content_hash`) are that constraint in code.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  autoDistribute,
  effectiveCap,
  spreadAcross,
  type AssignableProposal,
  type DistributionResult,
  type PoolCandidate,
  type ProposedAssignment,
} from "@podiumstack/domain/review/assignment.js";
import { matchConflicts, autoDetectConflicts, type ConflictRecord } from "@podiumstack/domain/review/coi.js";
import {
  reviewableContentHash,
  reviewableProjection,
  type ReviewableProjection,
} from "@podiumstack/domain/review/anonymity.js";
import {
  PROGRAMME_SCORECARD_RUBRIC,
  SPONSOR_COMPLIANCE_RUBRIC,
  validateCriterion,
  validateReviewForSubmit,
  type CriterionDraft,
} from "@podiumstack/domain/review/rubric.js";
import { reviewOverallScore } from "@podiumstack/domain/review/scoring.js";
import {
  assertDecisionTransition,
  assertRoundTransition,
  isTerminalAssignment,
  type AssignedBy,
  type AssignmentStatus,
  type CommentVisibility,
  type Confidence,
  type CriterionView,
  type DeclineReason,
  type DecisionOutcome,
  type DecisionStatus,
  type OverallScale,
  type PoolRole,
  type Recommendation,
  type ReminderChannel,
  type ReminderTrigger,
  type ReviewFlag,
  type RoundAnonymity,
  type RoundScope,
  type RoundStatus,
  type RubricView,
  type ScoreView,
} from "@podiumstack/domain/review/types.js";
import { localHeuristicEvaluator, type AiEvaluator } from "@podiumstack/domain/review/ai-evaluator.js";
import { DomainError, forbidden, invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { normaliseEmail } from "@podiumstack/domain/identity/types.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";
import { createInvitation, findOrCreatePerson, type CreatedInvitation } from "../identity/service.js";
import { applyDecisionToProposal, requestChanges, setProposalStatus } from "../submissions/service.js";
import {
  conflictSubject,
  loadConflicts,
  loadCriteria,
  loadReviewableProposal,
  loadReviews,
  proposalScoreFor,
  requireEvent,
  requireRound,
  requireRubric,
  roundScopeProposals,
  toRoundView,
  toRubricView,
  type RoundView,
} from "./scoring.js";

/* ========================================================================== */
/* Rubric + RubricCriterion                                                    */
/* ========================================================================== */

export interface RubricInput {
  event_id: string;
  name: string;
  description?: string | null;
  overall_scale: OverallScale;
  requires_comment: boolean;
  criteria: CriterionDraft[];
}

export async function createRubric(app: AppContext, input: RubricInput, version = 1): Promise<string> {
  await requireEvent(app, input.event_id);
  if (input.criteria.length === 0) {
    throw new DomainError({ code: "rubric_empty", message: "A rubric needs at least one criterion.", status: 422 });
  }
  const keys = new Set<string>();
  for (const criterion of input.criteria) {
    validateCriterion(criterion); // INV-05-13
    if (keys.has(criterion.key)) {
      throw new DomainError({
        code: "criterion_key_duplicate",
        message: `Two criteria share the key "${criterion.key}"; keys are unique per rubric.`,
        status: 422,
      });
    }
    keys.add(criterion.key);
  }

  const id = newId("Rubric");
  const now = app.now();
  await app.db.insert("rubric", {
    id,
    event_id: input.event_id,
    name: input.name,
    description: input.description ?? null,
    version,
    overall_scale: input.overall_scale,
    requires_comment: input.requires_comment ? 1 : 0,
    created_at: now,
    row_version: 1,
  });
  await writeCriteria(app, id, input.criteria);
  app.audit.record({
    action: "rubric.create",
    entity_type: "rubric",
    entity_id: id,
    after: { name: input.name, version, criterion_count: input.criteria.length },
  });
  return id;
}

async function writeCriteria(app: AppContext, rubricId: string, criteria: CriterionDraft[]): Promise<void> {
  await app.db.insertMany(
    "rubric_criterion",
    criteria.map((c, i) => ({
      id: newId("RubricCriterion"),
      rubric_id: rubricId,
      key: c.key,
      label: c.label,
      description: c.description ?? null,
      type: c.type,
      scale_min: c.scale_min ?? null,
      scale_max: c.scale_max ?? null,
      options: c.options ? JSON.stringify(c.options) : null,
      max_length: c.max_length ?? null,
      weight: c.weight ?? 1,
      is_required: c.is_required === false ? 0 : 1,
      allows_na: c.allows_na ? 1 : 0,
      sort_order: c.sort_order ?? i,
    })),
  );
}

/**
 * INV-05-1 — a `Rubric` version referenced by a non-`draft` round is immutable.
 * Changes create a new version, so a review written against version 2 can never
 * be re-read against a version 3 that moved the anchors underneath it.
 *
 * Returns the id that now holds the edit: the same rubric when it was still
 * free to change, a new version when it was not.
 */
export async function updateRubric(
  app: AppContext,
  rubricId: string,
  patch: Partial<Omit<RubricInput, "event_id">> & { criteria?: CriterionDraft[] },
): Promise<{ rubric_id: string; new_version: boolean }> {
  const { rubric, criteria } = await requireRubric(app, rubricId);
  const rounds = await app.db.select<Row>("review_round", { rubric_id: rubricId });
  const locked = rounds.some((r) => str(r.status) !== "draft");

  const next: RubricInput = {
    event_id: rubric.event_id,
    name: patch.name ?? rubric.name,
    description: patch.description === undefined ? rubric.description : patch.description,
    overall_scale: patch.overall_scale ?? rubric.overall_scale,
    requires_comment: patch.requires_comment ?? rubric.requires_comment,
    criteria: patch.criteria ?? criteria.map(toDraft),
  };

  if (locked) {
    const id = await createRubric(app, next, rubric.version + 1);
    app.audit.record({
      action: "rubric.version",
      entity_type: "rubric",
      entity_id: id,
      before: { rubric_id: rubricId, version: rubric.version },
      after: { rubric_id: id, version: rubric.version + 1 },
      // INV-05-1 is not an override; the reason records why a new row appeared.
      // INV-05-1 — the reason lands in the audit log, which organizers read, so it names the
      // behaviour rather than the rule.
      reason: "A round that is no longer a draft references this rubric, so the change became a new version.",
    });
    return { rubric_id: id, new_version: true };
  }

  for (const criterion of next.criteria) validateCriterion(criterion); // INV-05-13
  await app.db.update("rubric", rubricId, {
    name: next.name,
    description: next.description ?? null,
    overall_scale: next.overall_scale,
    requires_comment: next.requires_comment ? 1 : 0,
  });
  if (patch.criteria) {
    await app.db.hardDelete("rubric_criterion", { rubric_id: rubricId });
    await writeCriteria(app, rubricId, patch.criteria);
  }
  app.audit.record({ action: "rubric.update", entity_type: "rubric", entity_id: rubricId, after: { name: next.name } });
  return { rubric_id: rubricId, new_version: false };
}

function toDraft(c: CriterionView): CriterionDraft {
  return {
    key: c.key,
    label: c.label,
    description: c.description,
    type: c.type,
    scale_min: c.scale_min,
    scale_max: c.scale_max,
    options: c.options,
    max_length: c.max_length,
    weight: c.weight,
    is_required: c.is_required,
    allows_na: c.allows_na,
    sort_order: c.sort_order,
  };
}

/** R17 — the one-criterion sponsor compliance rubric, as a creatable preset. */
export async function createSponsorComplianceRubric(app: AppContext, eventId: string): Promise<string> {
  return createRubric(app, { event_id: eventId, ...SPONSOR_COMPLIANCE_RUBRIC });
}

/** 05, "The starter scorecard" — what a blueprinted event's rubric is built as. */
export async function createProgrammeScorecardRubric(app: AppContext, eventId: string): Promise<string> {
  return createRubric(app, { event_id: eventId, ...PROGRAMME_SCORECARD_RUBRIC });
}

/**
 * Copy a rubric and its criteria onto another event (02, "Cloning an edition").
 * Reviews reference criteria by id, so the copy is a new rubric with new
 * criterion ids — the source's scores stay attached to the source's rubric.
 */
export async function copyRubricToEvent(app: AppContext, rubricId: string, targetEventId: string): Promise<string> {
  const { rubric, criteria } = await requireRubric(app, rubricId);
  return createRubric(app, {
    event_id: targetEventId,
    name: rubric.name,
    description: rubric.description,
    overall_scale: rubric.overall_scale,
    requires_comment: rubric.requires_comment,
    criteria: criteria.map(toDraft),
  });
}

/* ========================================================================== */
/* ReviewRound                                                                 */
/* ========================================================================== */

export interface RoundInput {
  event_id: string;
  name: string;
  sequence: number;
  rubric_id: string;
  scope?: RoundScope;
  anonymity: RoundAnonymity;
  opens_at: string;
  closes_at: string;
  target_reviews_per_proposal: number;
  max_assignments_per_reviewer?: number | null;
  allow_self_assignment?: boolean;
  show_other_reviews_before_submit?: boolean;
  discussion_enabled?: boolean;
}

export async function createRound(app: AppContext, input: RoundInput): Promise<string> {
  await requireEvent(app, input.event_id);
  const { rubric } = await requireRubric(app, input.rubric_id);
  if (rubric.event_id !== input.event_id) {
    throw new DomainError({
      code: "rubric_wrong_event",
      message: "That rubric belongs to a different event.",
      status: 422,
    });
  }
  const id = newId("ReviewRound");
  const now = app.now();
  await app.db.insert("review_round", {
    id,
    event_id: input.event_id,
    name: input.name,
    sequence: input.sequence,
    rubric_id: input.rubric_id,
    scope: JSON.stringify(input.scope ?? {}),
    anonymity: input.anonymity,
    opens_at: input.opens_at,
    closes_at: input.closes_at,
    target_reviews_per_proposal: input.target_reviews_per_proposal,
    max_assignments_per_reviewer: input.max_assignments_per_reviewer ?? null,
    allow_self_assignment: input.allow_self_assignment ? 1 : 0,
    // Default **false** — anchoring is real (INV-05-6).
    show_other_reviews_before_submit: input.show_other_reviews_before_submit ? 1 : 0,
    discussion_enabled: input.discussion_enabled === false ? 0 : 1,
    status: "draft",
    created_at: now,
    updated_at: now,
    row_version: 1,
  });
  app.audit.record({ action: "review_round.create", entity_type: "review_round", entity_id: id, after: { name: input.name } });
  return id;
}

export async function updateRound(
  app: AppContext,
  roundId: string,
  patch: Partial<RoundInput>,
  expectedVersion?: number | null,
): Promise<void> {
  const round = await requireRound(app, roundId);
  if (round.status === "finalised") {
    throw new DomainError({
      code: "round_finalised",
      message: "A finalised round cannot be changed.",
      status: 422,
    });
  }
  const values: Row = { updated_at: app.now() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.sequence !== undefined) values.sequence = patch.sequence;
  if (patch.rubric_id !== undefined) values.rubric_id = patch.rubric_id;
  if (patch.scope !== undefined) values.scope = JSON.stringify(patch.scope);
  if (patch.anonymity !== undefined) values.anonymity = patch.anonymity;
  if (patch.opens_at !== undefined) values.opens_at = patch.opens_at;
  if (patch.closes_at !== undefined) values.closes_at = patch.closes_at;
  if (patch.target_reviews_per_proposal !== undefined) {
    values.target_reviews_per_proposal = patch.target_reviews_per_proposal;
  }
  if (patch.max_assignments_per_reviewer !== undefined) {
    values.max_assignments_per_reviewer = patch.max_assignments_per_reviewer;
  }
  if (patch.allow_self_assignment !== undefined) values.allow_self_assignment = patch.allow_self_assignment ? 1 : 0;
  if (patch.show_other_reviews_before_submit !== undefined) {
    values.show_other_reviews_before_submit = patch.show_other_reviews_before_submit ? 1 : 0;
  }
  if (patch.discussion_enabled !== undefined) values.discussion_enabled = patch.discussion_enabled ? 1 : 0;

  // 11, "Concurrency": writes to an aggregate root are compare-and-set
  // (INV-11-14). This used to fall back to the version it had just read a few
  // lines above, which compares a value against itself — the check could not
  // fail, and two chairs editing one round still clobbered each other. A
  // caller with no version to offer gets a plain write, as the other update
  // services do, rather than a check that only looks like one.
  if (expectedVersion != null) {
    await app.db.updateVersioned("review_round", roundId, expectedVersion, values);
  } else {
    await app.db.update("review_round", roundId, values);
  }
  app.audit.record({ action: "review_round.update", entity_type: "review_round", entity_id: roundId, after: values });
}

/**
 * The round state machine drawn in 05: `draft → open → closed ⇄ open`,
 * `closed → finalised`. A transition that is not drawn does not exist.
 */
export async function transitionRound(
  app: AppContext,
  roundId: string,
  to: RoundStatus,
  opts: { reason?: string | null } = {},
): Promise<void> {
  const round = await requireRound(app, roundId);
  assertRoundTransition(round.status, to);

  if (to === "finalised") await assertEveryProposalDecided(app, round);

  await app.db.update("review_round", roundId, { status: to, updated_at: app.now() });
  app.audit.record({
    action: `review_round.${to === "open" && round.status === "closed" ? "reopen" : to}`,
    entity_type: "review_round",
    entity_id: roundId,
    before: { status: round.status },
    after: { status: to },
    // A reopen is an override of a closed round and carries its reason (INV-11-5).
    reason: opts.reason ?? null,
  });

  if (to === "open") await onRoundOpened(app, round);
  if (to === "closed") await onRoundClosed(app, round);
}

async function onRoundOpened(app: AppContext, round: RoundView): Promise<void> {
  const proposals = await roundScopeProposals(app, round);
  const assignments = await app.db.count("review_assignment", { round_id: round.id });

  // 04's state diagram: `submitted → in_review: round opens / assignment made`.
  // The transition belongs to Submissions; we ask for it, we do not perform it.
  for (const proposal of proposals) {
    if (str(proposal.status) !== "submitted") continue;
    await setProposalStatus(app, proposal.id, "in_review", {
      reason: `Review round "${round.name}" opened.`,
    });
  }

  app.events.emit({
    type: "review_round.opened",
    subject: { type: "round", id: round.id },
    event_id: round.event_id,
    data: {
      round_id: round.id,
      name: round.name,
      sequence: round.sequence,
      proposal_count: proposals.length,
      assignment_count: assignments,
    },
  });
}

async function onRoundClosed(app: AppContext, round: RoundView): Promise<void> {
  const proposals = await roundScopeProposals(app, round);
  const reviews = await loadReviews(app, { round_id: round.id, status: "submitted" });
  const submitted = reviews.filter((r) => r.author_kind === "human").length;
  // INV-05-17: what is missing is missing *human* review, whatever the machines did.
  const missing = proposals.reduce((acc, p) => {
    const done = reviews.filter((r) => r.proposal_id === p.id && r.author_kind === "human").length;
    return acc + Math.max(0, round.target_reviews_per_proposal - done);
  }, 0);

  app.events.emit({
    type: "review_round.closed",
    subject: { type: "round", id: round.id },
    event_id: round.event_id,
    data: { round_id: round.id, submitted_review_count: submitted, missing_review_count: missing },
  });
}

/**
 * INV-05-12 — a round cannot be `finalised` while any in-scope proposal lacks a
 * published decision.
 */
async function assertEveryProposalDecided(app: AppContext, round: RoundView): Promise<void> {
  const proposals = await roundScopeProposals(app, round);
  const undecided: string[] = [];
  for (const proposal of proposals) {
    const decisions = await app.db.select<Row>("decision", { proposal_id: proposal.id, status: "published" });
    if (decisions.length === 0) undecided.push(str(proposal.reference));
  }
  if (undecided.length > 0) {
    throw invariantError(
      "INV-05-12",
      "round_has_undecided_proposals",
      `${undecided.length} proposal${undecided.length === 1 ? "" : "s"} in this round still has no published decision.`,
      { undecided_references: undecided.slice(0, 25), undecided_count: undecided.length },
    );
  }
}

/* ========================================================================== */
/* ReviewRoundReviewer — the per-round pool                                    */
/* ========================================================================== */

export interface PoolMemberInput {
  round_id: string;
  person_id?: string | null;
  email?: string | null;
  full_name?: string | null;
  pool_role: PoolRole;
  track_ids?: string[] | null;
  max_assignments?: number | null;
}

/**
 * Membership of one round's pool implies nothing about another's (INV-05-15).
 * Adding somebody to a pool does not assign them anything; bulk-adding a
 * committee and distributing work are separate days.
 *
 * Adding by email creates a placeholder `Person` and an `Invitation` of kind
 * `reviewer`, whose one-time `accept_url` the caller must show on screen
 * (INV-01-15) — provisioning a reviewer must never depend on mail delivery.
 */
export async function addPoolMember(
  app: AppContext,
  input: PoolMemberInput,
  baseUrl?: string,
): Promise<{ id: string; person_id: string; invitation: CreatedInvitation | null }> {
  const round = await requireRound(app, input.round_id);

  let personId = input.person_id ?? null;
  let invitation: CreatedInvitation | null = null;
  if (!personId) {
    const email = normaliseEmail(input.email ?? "");
    if (!email) {
      throw new DomainError({ code: "reviewer_needs_identity", message: "Give a person or an email address.", status: 422 });
    }
    const person = await findOrCreatePerson(app, {
      email,
      full_name: input.full_name || email,
      is_placeholder: !input.full_name,
      source: "reviewer_pool",
    });
    personId = person.id;
    if (baseUrl) {
      invitation = await createInvitation(
        app,
        {
          email,
          kind: "reviewer",
          person_id: person.id,
          intended_role: "reviewer",
          scope_type: "event",
          scope_id: round.event_id,
          context_type: "event",
          context_id: round.event_id,
        },
        baseUrl,
      );
    }
  }

  const existing = await app.db.first<Row>("review_round_reviewer", { round_id: input.round_id, person_id: personId });
  const now = app.now();
  const values: Row = {
    pool_role: input.pool_role,
    track_ids: input.track_ids?.length ? JSON.stringify(input.track_ids) : null,
    max_assignments: input.max_assignments ?? null,
    status: "active",
  };

  let id: string;
  if (existing) {
    id = str(existing.id);
    await app.db.update("review_round_reviewer", id, values);
  } else {
    id = newId("ReviewRoundReviewer");
    await app.db.insert("review_round_reviewer", {
      id,
      round_id: input.round_id,
      person_id: personId,
      added_by_person_id: app.actor.id ?? "system",
      created_at: now,
      ...values,
    });
  }

  app.events.emit({
    type: "review_round_reviewer.added",
    subject: { type: "round", id: input.round_id },
    event_id: round.event_id,
    data: {
      round_id: input.round_id,
      person_id: personId,
      pool_role: input.pool_role,
      track_ids: input.track_ids ?? [],
      max_assignments: input.max_assignments ?? null,
    },
  });
  app.audit.record({
    action: "review_round_reviewer.add",
    entity_type: "review_round_reviewer",
    entity_id: id,
    after: { round_id: input.round_id, person_id: personId, pool_role: input.pool_role },
  });
  return { id, person_id: personId, invitation };
}

export async function removePoolMember(app: AppContext, memberId: string, reason?: string | null): Promise<void> {
  const member = await app.db.byId<Row>("review_round_reviewer", memberId);
  if (!member) throw notFound("Pool member", memberId);
  const round = await requireRound(app, str(member.round_id));

  await app.db.update("review_round_reviewer", memberId, { status: "removed" });
  // Their outstanding assignments go with them; a revoked assignment keeps its
  // row so "who was asked" survives (05, `ReviewAssignment.status = revoked`).
  await app.db.rawRun(
    "UPDATE review_assignment SET status = 'revoked' WHERE round_id = ? AND reviewer_person_id = ? AND status IN ('assigned','accepted','in_progress')",
    [round.id, str(member.person_id)],
  );

  app.events.emit({
    type: "review_round_reviewer.removed",
    subject: { type: "round", id: round.id },
    event_id: round.event_id,
    data: { round_id: round.id, person_id: str(member.person_id), removed_by: app.actor.id ?? null },
  });
  app.audit.record({
    action: "review_round_reviewer.remove",
    entity_type: "review_round_reviewer",
    entity_id: memberId,
    before: { person_id: str(member.person_id) },
    reason: reason ?? null,
  });
}

/* ========================================================================== */
/* ReviewAssignment                                                            */
/* ========================================================================== */

export interface PoolMemberView {
  id: string;
  round_id: string;
  person_id: string;
  pool_role: PoolRole;
  track_ids: string[] | null;
  max_assignments: number | null;
  status: "active" | "removed";
}

export function toPoolMemberView(row: Row): PoolMemberView {
  return {
    id: str(row.id),
    round_id: str(row.round_id),
    person_id: str(row.person_id),
    pool_role: str(row.pool_role, "reviewer") as PoolRole,
    track_ids: row.track_ids ? parseJson<string[]>(row.track_ids, []) : null,
    max_assignments:
      row.max_assignments === null || row.max_assignments === undefined ? null : num(row.max_assignments),
    status: str(row.status, "active") as "active" | "removed",
  };
}

export async function loadPool(app: AppContext, roundId: string): Promise<PoolMemberView[]> {
  const rows = await app.db.select<Row>("review_round_reviewer", { round_id: roundId }, { orderBy: "created_at" });
  return rows.map(toPoolMemberView);
}

/** Live assignments per reviewer in a round — the load the caps are measured against. */
export async function currentLoads(app: AppContext, roundId: string): Promise<Record<string, number>> {
  const rows = await app.db.raw<{ reviewer_person_id: string; n: number }>(
    "SELECT reviewer_person_id, COUNT(*) AS n FROM review_assignment WHERE round_id = ? AND status NOT IN ('revoked','declined','expired') GROUP BY reviewer_person_id",
    [roundId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[str(r.reviewer_person_id)] = num(r.n);
  return out;
}

export async function poolCandidates(app: AppContext, round: RoundView): Promise<PoolCandidate[]> {
  const pool = await loadPool(app, round.id);
  const loads = await currentLoads(app, round.id);
  return pool
    // INV-05-15: only an `active` member with `pool_role = reviewer` may hold
    // an assignment. `meta_reviewer` and `observer` read; they do not score.
    .filter((m) => m.status === "active" && m.pool_role === "reviewer")
    .map((m) => ({
      person_id: m.person_id,
      track_ids: m.track_ids,
      max_assignments: effectiveCap(round.max_assignments_per_reviewer, m.max_assignments),
      current_load: loads[m.person_id] ?? 0,
    }));
}

/**
 * INV-05-4 — an assignment may not be created, and a review may not be
 * submitted, where a `ConflictOfInterest` matches the reviewer and the proposal
 * (directly, via a credited person, via the sponsor, or via `company_domain`
 * against a speaker's email domain).
 */
export async function assertNoConflict(
  app: AppContext,
  eventId: string,
  reviewerPersonId: string,
  proposalId: string,
): Promise<void> {
  const conflicts = await loadConflicts(app, eventId, reviewerPersonId);
  const subject = await conflictSubject(app, proposalId);
  const matches = matchConflicts(conflicts, reviewerPersonId, subject);
  if (matches.length > 0) {
    throw invariantError(
      "INV-05-4",
      "conflict_of_interest",
      `This reviewer has a conflict of interest with this proposal: ${matches[0].detail}.`,
      { proposal_id: proposalId, reviewer_person_id: reviewerPersonId, matches: matches.map((m) => m.kind) },
    );
  }
}

export async function createAssignment(
  app: AppContext,
  input: {
    round_id: string;
    proposal_id: string;
    reviewer_person_id: string;
    assigned_by: AssignedBy;
    due_at?: string | null;
  },
): Promise<string> {
  const round = await requireRound(app, input.round_id);
  const proposal = await app.db.byId<Row>("proposal", input.proposal_id);
  if (!proposal) throw notFound("Proposal", input.proposal_id);

  // INV-05-15 — pool membership, pool role and track narrowing.
  const member = await app.db.first<Row>("review_round_reviewer", {
    round_id: input.round_id,
    person_id: input.reviewer_person_id,
  });
  if (!member || str(member.status) !== "active") {
    throw invariantError(
      "INV-05-15",
      "reviewer_not_in_pool",
      "That person is not an active member of this round's reviewer pool. Membership of one round's pool implies nothing about another's.",
      { round_id: input.round_id, person_id: input.reviewer_person_id },
    );
  }
  if (str(member.pool_role) !== "reviewer") {
    throw invariantError(
      "INV-05-15",
      "pool_role_cannot_review",
      `${str(member.pool_role)} members of a pool do not score proposals.`,
      { pool_role: str(member.pool_role) },
    );
  }
  const tracks = member.track_ids ? parseJson<string[]>(member.track_ids, []) : [];
  const proposalTrack = strOrNull(proposal.assigned_track_id) ?? strOrNull(proposal.track_id);
  if (tracks.length > 0 && (!proposalTrack || !tracks.includes(proposalTrack))) {
    throw invariantError(
      "INV-05-15",
      "reviewer_track_mismatch",
      "This reviewer is limited to particular tracks in this round, and this proposal is not in one of them.",
      { track_ids: tracks, proposal_track_id: proposalTrack },
    );
  }

  await assertNoConflict(app, round.event_id, input.reviewer_person_id, input.proposal_id); // INV-05-4

  // INV-05-2 — one assignment per (round, proposal, reviewer).
  const existing = await app.db.first<Row>("review_assignment", {
    round_id: input.round_id,
    proposal_id: input.proposal_id,
    reviewer_person_id: input.reviewer_person_id,
  });
  if (existing) {
    if (str(existing.status) === "revoked") {
      await app.db.update("review_assignment", str(existing.id), { status: "assigned", assigned_at: app.now() });
      return str(existing.id);
    }
    return str(existing.id);
  }

  // The cap is not advice: assignment stops at it and says so.
  const cap = effectiveCap(
    round.max_assignments_per_reviewer,
    member.max_assignments === null || member.max_assignments === undefined ? null : num(member.max_assignments),
  );
  if (cap !== null) {
    const loads = await currentLoads(app, round.id);
    if ((loads[input.reviewer_person_id] ?? 0) >= cap) {
      throw new DomainError({
        code: "reviewer_at_cap",
        message: `That reviewer is already at their cap of ${cap} assignments in this round.`,
        status: 422,
        details: { cap, current: loads[input.reviewer_person_id] ?? 0 },
      });
    }
  }

  const id = newId("ReviewAssignment");
  const dueAt = input.due_at ?? round.closes_at;
  await app.db.insert("review_assignment", {
    id,
    round_id: input.round_id,
    proposal_id: input.proposal_id,
    reviewer_person_id: input.reviewer_person_id,
    assigned_by: input.assigned_by,
    status: "assigned",
    decline_reason: null,
    due_at: dueAt,
    reminder_count: 0,
    last_reminded_at: null,
    assigned_at: app.now(),
    submitted_at: null,
  });

  if (str(proposal.status) === "submitted") {
    await setProposalStatus(app, input.proposal_id, "in_review", { reason: "A review assignment was made." });
  }

  app.events.emit({
    type: "review_assignment.created",
    subject: { type: "assignment", id },
    event_id: round.event_id,
    data: {
      assignment_id: id,
      round_id: input.round_id,
      proposal_id: input.proposal_id,
      reviewer_person_id: input.reviewer_person_id,
      due_at: dueAt,
      assigned_by: input.assigned_by,
    },
  });
  return id;
}

export async function revokeAssignment(app: AppContext, assignmentId: string, reason?: string | null): Promise<void> {
  const assignment = await requireAssignmentRow(app, assignmentId);
  await app.db.update("review_assignment", assignmentId, { status: "revoked" });
  app.audit.record({
    action: "review_assignment.revoke",
    entity_type: "review_assignment",
    entity_id: assignmentId,
    before: { status: str(assignment.status) },
    reason: reason ?? null,
  });
}

export async function setAssignmentStatus(
  app: AppContext,
  assignmentId: string,
  to: Extract<AssignmentStatus, "accepted" | "in_progress">,
): Promise<void> {
  const assignment = await requireAssignmentRow(app, assignmentId);
  if (isTerminalAssignment(str(assignment.status) as AssignmentStatus)) return;
  await app.db.update("review_assignment", assignmentId, { status: to });
}

/**
 * `decline_reason = conflict_of_interest` **automatically creates a
 * `ConflictOfInterest` record** so the same reviewer is not reassigned in the
 * next round. Making a reviewer declare the same conflict three times is how
 * conflicts stop being declared.
 */
export async function declineAssignment(
  app: AppContext,
  assignmentId: string,
  reason: DeclineReason,
  note?: string | null,
): Promise<void> {
  const assignment = await requireAssignmentRow(app, assignmentId);
  const round = await requireRound(app, str(assignment.round_id));

  await app.db.update("review_assignment", assignmentId, { status: "declined", decline_reason: reason });

  if (reason === "conflict_of_interest") {
    await declareConflict(app, {
      event_id: round.event_id,
      reviewer_person_id: str(assignment.reviewer_person_id),
      subject_type: "proposal",
      subject_id: str(assignment.proposal_id),
      reason: "undisclosed_other",
      source: "declared_by_reviewer",
      note: note ?? "Declared while declining a review assignment.",
    });
  }

  app.events.emit({
    type: "review_assignment.declined",
    subject: { type: "assignment", id: assignmentId },
    event_id: round.event_id,
    data: { assignment_id: assignmentId, reason },
  });
  app.audit.record({
    action: "review_assignment.decline",
    entity_type: "review_assignment",
    entity_id: assignmentId,
    after: { decline_reason: reason },
  });
}

async function requireAssignmentRow(app: AppContext, assignmentId: string): Promise<Row> {
  const row = await app.db.byId<Row>("review_assignment", assignmentId);
  if (!row) throw notFound("Assignment", assignmentId);
  await requireRound(app, str(row.round_id)); // INV-11-1 via the round's event
  return row;
}

export { requireAssignmentRow };

/* -------------------------------------------------------------------------- */
/* Assignment at scale (R12)                                                   */
/* -------------------------------------------------------------------------- */

export interface AssignmentFilter {
  track_ids?: string[];
  format_ids?: string[];
  cfp_ids?: string[];
  keyword?: string | null;
  /** Only proposals still short of quorum. */
  only_under_quorum?: boolean;
}

async function assignableProposals(
  app: AppContext,
  round: RoundView,
  filter: AssignmentFilter = {},
): Promise<AssignableProposal[]> {
  let proposals = await roundScopeProposals(app, round);
  if (filter.track_ids?.length) proposals = proposals.filter((p) => filter.track_ids!.includes(str(p.track_id)));
  if (filter.format_ids?.length) {
    proposals = proposals.filter((p) => filter.format_ids!.includes(str(p.session_format_id)));
  }
  if (filter.cfp_ids?.length) proposals = proposals.filter((p) => filter.cfp_ids!.includes(str(p.cfp_id)));
  if (filter.keyword) {
    const needle = filter.keyword.toLowerCase();
    proposals = proposals.filter((p) => {
      const keywords = parseJson<string[]>(p.keywords, []).join(" ").toLowerCase();
      return (
        str(p.title).toLowerCase().includes(needle) ||
        str(p.abstract).toLowerCase().includes(needle) ||
        keywords.includes(needle)
      );
    });
  }

  const assignments = await app.db.select<Row>("review_assignment", { round_id: round.id });
  const conflicts = await loadConflicts(app, round.event_id);

  const out: AssignableProposal[] = [];
  for (const proposal of proposals) {
    const existing = assignments
      .filter((a) => str(a.proposal_id) === proposal.id && str(a.status) !== "revoked" && str(a.status) !== "declined")
      .map((a) => str(a.reviewer_person_id));
    if (filter.only_under_quorum && existing.length >= round.target_reviews_per_proposal) continue;

    const subject = await conflictSubject(app, proposal.id);
    const reviewers = [...new Set(conflicts.map((c) => c.reviewer_person_id))];
    const conflicted = reviewers.filter((r) => matchConflicts(conflicts, r, subject).length > 0);
    // The structural conflicts — submitter and credited speakers — need no
    // declared record (05, "Fairness rules made explicit").
    conflicted.push(subject.submitter_person_id, ...subject.credited_person_ids);

    out.push({
      proposal_id: proposal.id,
      track_id: strOrNull(proposal.assigned_track_id) ?? strOrNull(proposal.track_id),
      existing_reviewer_ids: existing,
      conflicted_reviewer_ids: [...new Set(conflicted)],
    });
  }
  return out;
}

/**
 * Auto-distribution — `assigned_by = algorithm` over the round's pool, honouring
 * caps, track affinity and every `ConflictOfInterest`, aiming at
 * `target_reviews_per_proposal`. It **proposes**; the chair confirms (R12).
 */
export async function proposeAutoDistribution(
  app: AppContext,
  roundId: string,
  filter: AssignmentFilter = {},
): Promise<DistributionResult> {
  const round = await requireRound(app, roundId);
  return autoDistribute({
    pool: await poolCandidates(app, round),
    proposals: await assignableProposals(app, round, { ...filter, only_under_quorum: true }),
    target_reviews_per_proposal: round.target_reviews_per_proposal,
  });
}

/** Filtered bulk assignment — one reviewer, or spread across a chosen group. */
export async function proposeBulkAssignment(
  app: AppContext,
  roundId: string,
  input: { filter: AssignmentFilter; reviewer_person_ids: string[]; mode: "spread" | "one_each" },
): Promise<DistributionResult> {
  const round = await requireRound(app, roundId);
  return spreadAcross({
    pool: await poolCandidates(app, round),
    proposals: await assignableProposals(app, round, input.filter),
    reviewer_person_ids: input.reviewer_person_ids,
    mode: input.mode,
  });
}

/** Write a confirmed proposal set. Each pair goes through `createAssignment`, so
 *  INV-05-2, INV-05-4 and INV-05-15 are checked again at write time. */
export async function confirmAssignments(
  app: AppContext,
  roundId: string,
  pairs: ProposedAssignment[],
): Promise<{ created: number; refused: { proposal_id: string; reviewer_person_id: string; message: string }[] }> {
  const refused: { proposal_id: string; reviewer_person_id: string; message: string }[] = [];
  let created = 0;
  for (const pair of pairs) {
    try {
      await createAssignment(app, {
        round_id: roundId,
        proposal_id: pair.proposal_id,
        reviewer_person_id: pair.reviewer_person_id,
        assigned_by: pair.assigned_by,
      });
      created++;
    } catch (err) {
      refused.push({
        proposal_id: pair.proposal_id,
        reviewer_person_id: pair.reviewer_person_id,
        message: err instanceof DomainError ? err.message : String(err),
      });
    }
  }
  app.audit.record({
    action: "review_assignment.bulk_create",
    entity_type: "review_round",
    entity_id: roundId,
    after: { created, refused: refused.length },
  });
  return { created, refused };
}

/* ========================================================================== */
/* Review                                                                      */
/* ========================================================================== */

export interface ReviewDraftInput {
  scores: ScoreView[];
  na_criterion_ids?: string[];
  recommendation?: Recommendation | null;
  confidence?: Confidence | null;
  comments_for_committee?: string | null;
  comments_for_speaker?: string | null;
  flags?: ReviewFlag[];
}

/** The current (non-superseded) review for an assignment, if any. */
export async function currentReviewFor(app: AppContext, assignmentId: string): Promise<Row | null> {
  const rows = await app.db.select<Row>("review", { assignment_id: assignmentId }, { orderBy: "created_at DESC" });
  return rows.find((r) => str(r.status) !== "superseded") ?? null;
}

async function writeScores(
  app: AppContext,
  reviewId: string,
  criteria: CriterionView[],
  input: ReviewDraftInput,
): Promise<void> {
  await app.db.hardDelete("criterion_score", { review_id: reviewId });
  const na = new Set(input.na_criterion_ids ?? []);
  const rows: Row[] = [];
  for (const criterion of criteria) {
    const score = input.scores.find((s) => s.criterion_id === criterion.id);
    const isNa = na.has(criterion.id);
    if (!score && !isNa) continue;
    rows.push({
      review_id: reviewId,
      criterion_id: criterion.id,
      // "can't judge this" is more honest than a 3: the row exists with every
      // `value_*` null, which is what `allows_na` means (INV-05-5).
      value_number: isNa ? null : (score?.value_number ?? null),
      value_option: isNa ? null : (score?.value_option ?? null),
      value_text: isNa ? null : (score?.value_text ?? null),
      value_bool: isNa ? null : score?.value_bool === null || score?.value_bool === undefined ? null : score.value_bool,
      note: score?.note ?? null,
    });
  }
  if (rows.length) await app.db.insertMany("criterion_score", rows);
}

export async function saveReviewDraft(
  app: AppContext,
  assignmentId: string,
  input: ReviewDraftInput,
): Promise<string> {
  const assignment = await requireAssignmentRow(app, assignmentId);
  const round = await requireRound(app, str(assignment.round_id));
  const { criteria } = await requireRubric(app, round.rubric_id);
  const now = app.now();

  let review = await currentReviewFor(app, assignmentId);
  if (review && str(review.status) !== "draft") {
    // A submitted review is append-only; editing one creates a new version
    // (INV-05-3). The draft that carries the edit is a fresh row.
    review = null;
  }

  let id: string;
  if (review) {
    id = str(review.id);
    await app.db.update("review", id, {
      recommendation: input.recommendation ?? null,
      confidence: input.confidence ?? null,
      comments_for_committee: input.comments_for_committee ?? null,
      comments_for_speaker: input.comments_for_speaker ?? null,
      flags: JSON.stringify(input.flags ?? []),
      updated_at: now,
    });
  } else {
    id = newId("Review");
    await app.db.insert("review", {
      id,
      assignment_id: assignmentId,
      proposal_id: str(assignment.proposal_id),
      round_id: round.id,
      reviewer_person_id: str(assignment.reviewer_person_id),
      author_kind: "human", // INV-05-16: a human review has both ids.
      recommendation: input.recommendation ?? null,
      confidence: input.confidence ?? null,
      comments_for_committee: input.comments_for_committee ?? null,
      comments_for_speaker: input.comments_for_speaker ?? null,
      flags: JSON.stringify(input.flags ?? []),
      status: "draft",
      reviewed_content_hash: "",
      created_at: now,
      updated_at: now,
      row_version: 1,
    });
  }
  await writeScores(app, id, criteria, input);
  if (str(assignment.status) === "assigned" || str(assignment.status) === "accepted") {
    await app.db.update("review_assignment", assignmentId, { status: "in_progress" });
  }
  return id;
}

/**
 * Submitting a review.
 *
 * INV-05-3 one current review per assignment — an edit supersedes rather than
 * mutates. INV-05-4 no submission where a COI matches. INV-05-5 every required
 * criterion scored. INV-05-8 `reviewed_content_hash` equals the proposal's
 * `content_hash` at submit time.
 */
export async function submitReview(
  app: AppContext,
  assignmentId: string,
  input: ReviewDraftInput,
): Promise<string> {
  const assignment = await requireAssignmentRow(app, assignmentId);
  const round = await requireRound(app, str(assignment.round_id));
  if (round.status !== "open") {
    throw new DomainError({
      code: "round_not_open",
      message: `This round is ${round.status}; reviews can only be submitted while it is open.`,
      status: 422,
    });
  }
  const { rubric, criteria } = await requireRubric(app, round.rubric_id);

  await assertNoConflict(app, round.event_id, str(assignment.reviewer_person_id), str(assignment.proposal_id)); // INV-05-4
  validateReviewForSubmit(rubric, criteria, input); // INV-05-5 + INV-05-13

  const hash = await currentContentHash(app, str(assignment.proposal_id), round.anonymity); // INV-05-8
  const now = app.now();

  // INV-05-3: the prior current review is superseded, never overwritten.
  const prior = await currentReviewFor(app, assignmentId);
  let priorId: string | null = null;
  if (prior && str(prior.status) !== "draft") {
    priorId = str(prior.id);
    await app.db.update("review", priorId, { status: "superseded", updated_at: now });
  }

  let id: string;
  if (prior && str(prior.status) === "draft") {
    id = str(prior.id);
    await app.db.update("review", id, {
      recommendation: input.recommendation ?? null,
      confidence: input.confidence ?? null,
      comments_for_committee: input.comments_for_committee ?? null,
      comments_for_speaker: input.comments_for_speaker ?? null,
      flags: JSON.stringify(input.flags ?? []),
      status: "submitted",
      reviewed_content_hash: hash,
      submitted_at: now,
      updated_at: now,
    });
    await writeScores(app, id, criteria, input);
  } else {
    id = newId("Review");
    await app.db.insert("review", {
      id,
      assignment_id: assignmentId,
      proposal_id: str(assignment.proposal_id),
      round_id: round.id,
      reviewer_person_id: str(assignment.reviewer_person_id),
      author_kind: "human",
      recommendation: input.recommendation ?? null,
      confidence: input.confidence ?? null,
      comments_for_committee: input.comments_for_committee ?? null,
      comments_for_speaker: input.comments_for_speaker ?? null,
      flags: JSON.stringify(input.flags ?? []),
      status: "submitted",
      reviewed_content_hash: hash,
      submitted_at: now,
      created_at: now,
      updated_at: now,
      row_version: 1,
    });
    await writeScores(app, id, criteria, input);
  }

  await app.db.update("review_assignment", assignmentId, { status: "submitted", submitted_at: now });

  const scores = await app.db.select<Row>("criterion_score", { review_id: id });
  const overall = reviewOverallScore(
    criteria,
    scores.map((s) => ({
      criterion_id: str(s.criterion_id),
      value_number: s.value_number === null || s.value_number === undefined ? null : num(s.value_number),
      value_option: strOrNull(s.value_option),
      value_text: strOrNull(s.value_text),
      value_bool: s.value_bool === null || s.value_bool === undefined ? null : bool(s.value_bool),
    })),
  );
  const score = await proposalScoreFor(app, round.id, str(assignment.proposal_id));

  app.events.emit({
    type: "review.submitted",
    subject: { type: "review", id },
    event_id: round.event_id,
    data: {
      review_id: id,
      proposal_id: str(assignment.proposal_id),
      round_id: round.id,
      // INV-05-16: `author_kind` is in every event payload, without exception.
      author_kind: "human",
      recommendation: input.recommendation ?? null,
      overall_score: overall,
      has_quorum: score.has_quorum,
      superseded_review_id: priorId,
    },
  });
  if (priorId) {
    app.audit.record({
      action: "review.edit_after_submit",
      entity_type: "review",
      entity_id: id,
      before: { review_id: priorId },
      after: { review_id: id },
      // INV-05-3
      reason: "A submitted review was edited; the prior version is superseded, not overwritten.",
    });
  }
  return id;
}

/** The proposal's `content_hash` (`D`) as this round's anonymity exposes it. */
export async function currentContentHash(
  app: AppContext,
  proposalId: string,
  anonymity: RoundAnonymity,
): Promise<string> {
  const proposal = await loadReviewableProposal(app, proposalId);
  return reviewableContentHash(reviewableProjection(proposal, anonymity));
}

export async function reviewableFor(
  app: AppContext,
  proposalId: string,
  anonymity: RoundAnonymity,
): Promise<ReviewableProjection> {
  return reviewableProjection(await loadReviewableProposal(app, proposalId), anonymity);
}

/**
 * INV-05-8 — divergence between a submitted review's `reviewed_content_hash`
 * and the proposal's current `content_hash` sets `status = stale`. The reviewer
 * is prompted to re-confirm and the chair sees the staleness in the queue
 * rather than discovering it in the decision meeting.
 *
 * Driven by `review.mark_stale_on_proposal_change` (`reactions.ts`), reacting
 * to `proposal.resubmitted` and `proposal.updated` — the two facts that can
 * move `content_hash`. Narrowed to `opts.proposalId` there, which is what
 * keeps a single organizer edit from re-hashing every submitted review in the
 * event: only the rounds that actually hold a submitted review of *this*
 * proposal are visited, not every open round. `opts.roundId` / no options at
 * all remain for an operator running the check by hand over a whole round or
 * event — the reaction is the only caller in production, but the sweep
 * itself does not assume that.
 */
export async function sweepStaleReviews(app: AppContext, opts: { roundId?: string; proposalId?: string } = {}): Promise<number> {
  let rounds: RoundView[];
  if (opts.roundId) {
    rounds = [await requireRound(app, opts.roundId)];
  } else if (opts.proposalId) {
    const roundIds = await app.db.raw<Row>(
      "SELECT DISTINCT round_id FROM review WHERE proposal_id = ? AND status = 'submitted'",
      [opts.proposalId],
    );
    rounds = [];
    for (const r of roundIds) {
      const row = await app.db.byId<Row>("review_round", str(r.round_id));
      if (row && (str(row.status) === "open" || str(row.status) === "closed")) rounds.push(toRoundView(row));
    }
  } else {
    rounds = (await app.db.select<Row>("review_round", { status: ["open", "closed"] })).map(toRoundView);
  }

  let marked = 0;
  for (const round of rounds) {
    const where: Row = { round_id: round.id, status: "submitted" };
    if (opts.proposalId) where.proposal_id = opts.proposalId;
    const reviews = await app.db.select<Row>("review", where);
    const hashes = new Map<string, string>();
    for (const review of reviews) {
      const proposalId = str(review.proposal_id);
      let current = hashes.get(proposalId);
      if (current === undefined) {
        try {
          current = await currentContentHash(app, proposalId, round.anonymity);
        } catch {
          continue; // a deleted proposal is not a stale review
        }
        hashes.set(proposalId, current);
      }
      const previous = str(review.reviewed_content_hash);
      if (!previous || previous === current) continue;
      await app.db.update("review", str(review.id), { status: "stale", updated_at: app.now() });
      app.events.emit({
        type: "review.stale",
        subject: { type: "review", id: str(review.id) },
        event_id: round.event_id,
        data: {
          review_id: str(review.id),
          proposal_id: proposalId,
          previous_hash: previous,
          current_hash: current,
        },
      });
      marked++;
    }
  }
  return marked;
}

/* -------------------------------------------------------------------------- */
/* AI first-pass review (R24)                                                  */
/* -------------------------------------------------------------------------- */

/** `Organization.settings.review.ai_evaluation_enabled` — default off (R24). */
export async function aiEvaluationEnabled(app: AppContext): Promise<boolean> {
  const org = await app.db.byId<Row>("organization", app.orgId);
  const settings = parseJson<Record<string, unknown>>(org?.settings, {});
  const review = (settings.review ?? {}) as Record<string, unknown>;
  return review.ai_evaluation_enabled === true;
}

/**
 * Resolve the configured evaluator. `AiEvaluator` configuration is an
 * `Integration` with `capability = analytics`; the core calls the contract and
 * never imports a vendor SDK. With no integration configured the shipped
 * deterministic stub runs, so the flow is exercisable end to end.
 */
export async function resolveEvaluator(app: AppContext): Promise<AiEvaluator> {
  const integration = await app.db.first<Row>("integration", { capability: "analytics", status: "active" });
  if (!integration) return localHeuristicEvaluator();
  const config = parseJson<Record<string, unknown>>(integration.config, {}); // never secrets (INV-09-3)
  return localHeuristicEvaluator({
    key: str(integration.plugin_key, "analytics.local_heuristic"),
    model: typeof config.model === "string" ? config.model : undefined,
  });
}

/**
 * INV-05-16 — `author_kind = ai` requires `ai_evaluator_key`, `ai_model` and
 * `ai_rationale`, and has no `assignment_id` or `reviewer_person_id`.
 * INV-05-17 — it never counts toward quorum.
 */
export async function generateAiReview(
  app: AppContext,
  roundId: string,
  proposalId: string,
  evaluator?: AiEvaluator,
): Promise<string> {
  if (!(await aiEvaluationEnabled(app))) {
    throw forbidden("AI first-pass evaluation is switched off for this organization.", {
      setting: "review.ai_evaluation_enabled",
    });
  }
  const round = await requireRound(app, roundId);
  const { rubric, criteria } = await requireRubric(app, round.rubric_id);
  const proposal = await loadReviewableProposal(app, proposalId);
  const engine = evaluator ?? (await resolveEvaluator(app));

  const result = await engine.evaluate({
    rubric,
    criteria,
    proposal: {
      proposal_id: proposal.id,
      reference: proposal.reference,
      title: proposal.title,
      abstract: proposal.abstract,
      description: proposal.description,
      keywords: proposal.keywords,
      track_id: proposal.track_id,
      session_format_id: proposal.session_format_id,
    },
  });

  if (!result.evaluator_key || !result.model || !result.rationale?.trim()) {
    throw invariantError(
      "INV-05-16",
      "ai_review_incomplete",
      "An AI review must carry its evaluator key, its model identifier and a written rationale.",
    );
  }

  // One current AI review per (round, proposal): a re-run supersedes.
  const existing = await app.db.select<Row>("review", { round_id: roundId, proposal_id: proposalId, author_kind: "ai" });
  for (const prior of existing) {
    if (str(prior.status) === "superseded") continue;
    await app.db.update("review", str(prior.id), { status: "superseded", updated_at: app.now() });
  }

  const id = newId("Review");
  const now = app.now();
  await app.db.insert("review", {
    id,
    assignment_id: null, // INV-05-16
    proposal_id: proposalId,
    round_id: roundId,
    reviewer_person_id: null, // INV-05-16
    author_kind: "ai",
    ai_evaluator_key: result.evaluator_key,
    ai_model: result.model,
    ai_rationale: result.rationale,
    recommendation: result.recommendation ?? null,
    confidence: result.confidence ?? "low",
    comments_for_committee: null,
    comments_for_speaker: null,
    flags: JSON.stringify(result.flags ?? []),
    status: "submitted",
    reviewed_content_hash: await currentContentHash(app, proposalId, round.anonymity),
    submitted_at: now,
    created_at: now,
    updated_at: now,
    row_version: 1,
  });
  await writeScores(app, id, criteria, {
    scores: result.scores.map((s) => ({
      criterion_id: s.criterion_id,
      value_number: s.value_number ?? null,
      value_option: s.value_option ?? null,
      value_text: s.value_text ?? null,
      value_bool: s.value_bool ?? null,
      note: s.note ?? null,
    })),
  });

  const scored = await loadReviews(app, { id });
  app.events.emit({
    type: "review.ai_generated",
    subject: { type: "review", id },
    event_id: round.event_id,
    data: {
      review_id: id,
      proposal_id: proposalId,
      round_id: roundId,
      // INV-05-16: labelled in every event payload.
      author_kind: "ai",
      ai_evaluator_key: result.evaluator_key,
      ai_model: result.model,
      overall_score: scored[0] ? reviewOverallScore(criteria, scored[0].scores) : null,
    },
  });
  app.audit.record({
    action: "review.ai_generated",
    entity_type: "review",
    entity_id: id,
    after: { proposal_id: proposalId, evaluator: result.evaluator_key, model: result.model },
  });
  return id;
}

/**
 * "Run AI first-pass" — the chair's trigger for the whole point of R24:
 * "committees will mostly use it to triage a first cut of 900 submissions."
 * `generateAiReview` and `overrideAiReview` were both fully built to spec but
 * reachable from nothing — no route, cron or reaction — which left
 * `Organization.settings.review.ai_evaluation_enabled` a toggle that changed
 * nothing when switched on. This is that trigger: every in-scope proposal
 * (`roundScopeProposals`, the same set the round is reviewed against) that
 * does not already have a current AI review gets one. Idempotent the way
 * materialisation is (07): running it twice costs a query per
 * already-covered proposal, not a duplicate.
 */
export async function generateAiReviewsForRound(app: AppContext, roundId: string): Promise<{ generated: number; skipped: number }> {
  if (!(await aiEvaluationEnabled(app))) {
    throw forbidden("AI first-pass evaluation is switched off for this organization.", {
      setting: "review.ai_evaluation_enabled",
    });
  }
  const round = await requireRound(app, roundId);
  const proposals = await roundScopeProposals(app, round);
  const evaluator = await resolveEvaluator(app);
  let generated = 0;
  let skipped = 0;
  for (const proposal of proposals) {
    const existing = await app.db.select<Row>("review", { round_id: roundId, proposal_id: proposal.id, author_kind: "ai" });
    if (existing.some((r) => str(r.status) !== "superseded")) {
      skipped++;
      continue;
    }
    try {
      await generateAiReview(app, roundId, proposal.id, evaluator);
      generated++;
    } catch (err) {
      // One bad proposal (a missing field the evaluator chokes on) does not
      // stop the batch — logged loudly, per the implementer brief on failure
      // isolation, and counted as skipped rather than silently dropped.
      console.error("ai first-pass review failed", { round_id: roundId, proposal_id: proposal.id, error: String(err) });
      skipped++;
    }
  }
  return { generated, skipped };
}

/**
 * "A human can override it. Overriding writes the human's scores onto a new
 * review with `author_kind = human`, marks the AI review superseded, and records
 * `overridden_by_person_id` — so the disagreement is preserved rather than
 * erased."
 */
export async function overrideAiReview(
  app: AppContext,
  aiReviewId: string,
  input: ReviewDraftInput & { assignment_id?: string | null },
  reason: string,
): Promise<string> {
  const ai = await app.db.byId<Row>("review", aiReviewId);
  if (!ai) throw notFound("Review", aiReviewId);
  if (str(ai.author_kind) !== "ai") {
    throw new DomainError({ code: "not_an_ai_review", message: "That review was not written by a machine.", status: 422 });
  }
  const round = await requireRound(app, str(ai.round_id));
  const { rubric, criteria } = await requireRubric(app, round.rubric_id);
  const personId = app.actor.id;
  if (!personId) throw forbidden("An override must be attributable to a person.");

  // A chair override on a proposal where the chair has a COI is refused
  // outright, not merely logged (05, "Fairness rules made explicit").
  await assertNoConflict(app, round.event_id, personId, str(ai.proposal_id));
  validateReviewForSubmit(rubric, criteria, input); // INV-05-5

  const now = app.now();
  await app.db.update("review", aiReviewId, {
    status: "superseded",
    overridden_by_person_id: personId,
    overridden_at: now,
    updated_at: now,
  });

  const id = newId("Review");
  await app.db.insert("review", {
    id,
    assignment_id: input.assignment_id ?? null,
    proposal_id: str(ai.proposal_id),
    round_id: round.id,
    reviewer_person_id: personId,
    author_kind: "human",
    recommendation: input.recommendation ?? null,
    confidence: input.confidence ?? null,
    comments_for_committee: input.comments_for_committee ?? null,
    comments_for_speaker: input.comments_for_speaker ?? null,
    flags: JSON.stringify(input.flags ?? []),
    status: "submitted",
    reviewed_content_hash: await currentContentHash(app, str(ai.proposal_id), round.anonymity),
    submitted_at: now,
    created_at: now,
    updated_at: now,
    row_version: 1,
  });
  await writeScores(app, id, criteria, input);

  app.events.emit({
    type: "review.overridden",
    subject: { type: "review", id },
    event_id: round.event_id,
    data: {
      review_id: id,
      superseded_review_id: aiReviewId,
      proposal_id: str(ai.proposal_id),
      overridden_by_person_id: personId,
      author_kind: "human",
    },
  });
  app.audit.record({
    action: "review.override",
    entity_type: "review",
    entity_id: id,
    before: { review_id: aiReviewId, author_kind: "ai" },
    after: { review_id: id, author_kind: "human" },
    reason, // INV-11-5: an override carries a reason.
  });
  return id;
}

/* ========================================================================== */
/* ConflictOfInterest                                                          */
/* ========================================================================== */

export async function declareConflict(
  app: AppContext,
  input: {
    event_id: string;
    reviewer_person_id: string;
    subject_type: ConflictRecord["subject_type"];
    subject_id?: string | null;
    subject_value?: string | null;
    reason: ConflictRecord["reason"];
    source: ConflictRecord["source"];
    note?: string | null;
  },
): Promise<string> {
  await requireEvent(app, input.event_id);
  if (input.subject_type === "company_domain" && !input.subject_value) {
    throw new DomainError({
      code: "coi_needs_domain",
      message: "A company_domain conflict needs the domain itself.",
      status: 422,
    });
  }
  if (input.subject_type !== "company_domain" && !input.subject_id) {
    throw new DomainError({
      code: "coi_needs_subject",
      message: `A ${input.subject_type} conflict needs the ${input.subject_type} it is against.`,
      status: 422,
    });
  }

  const existing = await app.db.first<Row>("conflict_of_interest", {
    event_id: input.event_id,
    reviewer_person_id: input.reviewer_person_id,
    subject_type: input.subject_type,
    subject_id: input.subject_id ?? null,
    subject_value: input.subject_value ? input.subject_value.toLowerCase() : null,
  });
  if (existing) return str(existing.id);

  const id = newId("ConflictOfInterest");
  await app.db.insert("conflict_of_interest", {
    id,
    event_id: input.event_id,
    reviewer_person_id: input.reviewer_person_id,
    subject_type: input.subject_type,
    subject_id: input.subject_id ?? null,
    subject_value: input.subject_value ? input.subject_value.toLowerCase() : null,
    reason: input.reason,
    source: input.source,
    note: input.note ?? null,
    created_at: app.now(),
  });
  app.events.emit({
    type: "conflict_of_interest.declared",
    subject: { type: "coi", id },
    event_id: input.event_id,
    data: {
      coi_id: id,
      reviewer_person_id: input.reviewer_person_id,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      reason: input.reason,
      source: input.source,
    },
  });
  app.audit.record({
    action: "conflict_of_interest.declare",
    entity_type: "conflict_of_interest",
    entity_id: id,
    after: { reviewer_person_id: input.reviewer_person_id, subject_type: input.subject_type },
  });
  return id;
}

/** Advisory auto-detection over a round's pool. Shallow by design. */
export async function detectConflictsForProposal(
  app: AppContext,
  eventId: string,
  proposalId: string,
  reviewerPersonIds: string[],
): Promise<number> {
  const subject = await conflictSubject(app, proposalId);
  let created = 0;
  for (const personId of reviewerPersonIds) {
    const person = await app.db.byId<Row>("person", personId);
    if (!person) continue;
    const sponsorContacts = await app.db.select<Row>("sponsor_contact", { person_id: personId, status: "active" });
    const detected = autoDetectConflicts({
      reviewer_person_id: personId,
      reviewer_email: str(person.email),
      reviewer_sponsor_ids: sponsorContacts.map((s) => str(s.sponsor_id)),
      subject,
    });
    for (const d of detected) {
      await declareConflict(app, {
        event_id: eventId,
        reviewer_person_id: personId,
        subject_type: d.subject_type,
        subject_id: d.subject_id,
        subject_value: d.subject_value,
        reason: d.reason,
        source: "auto_detected",
        note: d.note,
      });
      created++;
    }
  }
  return created;
}

export async function deleteConflict(app: AppContext, coiId: string, reason: string): Promise<void> {
  const row = await app.db.byId<Row>("conflict_of_interest", coiId);
  if (!row) throw notFound("Conflict of interest", coiId);
  await requireEvent(app, str(row.event_id));
  await app.db.hardDelete("conflict_of_interest", { id: coiId });
  app.audit.record({
    action: "conflict_of_interest.override",
    entity_type: "conflict_of_interest",
    entity_id: coiId,
    before: row,
    reason, // INV-11-5: a COI override carries a reason and is audited.
  });
}

/* ========================================================================== */
/* Discussion                                                                  */
/* ========================================================================== */

/**
 * INV-05-7 — `ReviewComment` bodies are never exposed to submitters or in any
 * read model available to them. There is no `public` visibility member; the
 * one channel to the speaker is `Decision.feedback_for_speaker`, and a human
 * writes it.
 */
export async function addComment(
  app: AppContext,
  input: {
    proposal_id: string;
    round_id?: string | null;
    parent_id?: string | null;
    body: string;
    visibility: CommentVisibility;
  },
): Promise<string> {
  const proposal = await app.db.byId<Row>("proposal", input.proposal_id);
  if (!proposal) throw notFound("Proposal", input.proposal_id);
  if (input.parent_id) {
    const parent = await app.db.byId<Row>("review_comment", input.parent_id);
    if (!parent) throw notFound("Comment", input.parent_id);
    if (parent.parent_id) {
      throw new DomainError({
        code: "comment_nesting",
        message: "Discussion threads are one level deep.",
        status: 422,
      });
    }
  }
  const id = newId("ReviewComment");
  await app.db.insert("review_comment", {
    id,
    proposal_id: input.proposal_id,
    round_id: input.round_id ?? null,
    author_person_id: app.actor.id ?? "system",
    parent_id: input.parent_id ?? null,
    body: input.body,
    visibility: input.visibility,
    created_at: app.now(),
  });
  return id;
}

export async function listComments(app: AppContext, proposalId: string, includeChairsOnly: boolean): Promise<Row[]> {
  const rows = await app.db.select<Row>("review_comment", { proposal_id: proposalId }, { orderBy: "created_at" });
  return includeChairsOnly ? rows : rows.filter((r) => str(r.visibility) !== "chairs_only");
}

/* ========================================================================== */
/* Decision                                                                    */
/* ========================================================================== */

export interface DecisionInput {
  proposal_id: string;
  round_id?: string | null;
  outcome: DecisionOutcome;
  assigned_track_id?: string | null;
  assigned_format_id?: string | null;
  assigned_duration_minutes?: number | null;
  conditions?: string | null;
  feedback_for_speaker?: string | null;
  rationale?: string | null;
  confirmation_deadline?: string | null;
  quorum_waived_reason?: string | null;
}

/**
 * Record an outcome. Provisional until published (R5): "Chairs decide over
 * days, in meetings, changing their minds. Nothing reaches a speaker until the
 * chair publishes."
 *
 * INV-05-11 bites at publish, not here (R32): a provisional accept is the
 * chair's leaning, and triage is the activity that happens *before* the reviews
 * are all in — so recording one below quorum is allowed and publishing it is
 * not. `quorum_waived_reason` is still accepted here, because the chair records
 * it while they are looking at the proposal rather than at the publish batch.
 */
export async function recordDecision(app: AppContext, input: DecisionInput): Promise<string> {
  const proposal = await app.db.byId<Row>("proposal", input.proposal_id);
  if (!proposal) throw notFound("Proposal", input.proposal_id);
  const eventId = str(proposal.event_id);
  await requireEvent(app, eventId);

  const decidedBy = app.actor.id;
  if (!decidedBy) throw forbidden("A decision must be attributable to a person.");
  // A chair override on a proposal where the chair has a COI is refused
  // outright, not merely logged (05, "Fairness rules made explicit").
  await assertNoConflict(app, eventId, decidedBy, input.proposal_id);

  // A provisional decision is edited in place — `provisional → provisional` is
  // drawn on the diagram. A published one is superseded by the new record.
  const existing = await app.db.select<Row>("decision", { proposal_id: input.proposal_id });
  const current = existing.find((d) => str(d.status) !== "superseded") ?? null;

  if (current && str(current.status) === "provisional") {
    assertDecisionTransition("provisional", "provisional");
    // A field the caller did not mention keeps the value it had; only an
    // explicit null clears it. The decision form sends every field, so
    // emptying a box there still empties the column — but moving a proposal
    // between the queues sends nothing except the outcome, and that must not
    // silently discard the confirmation deadline or a recorded reason for
    // going ahead below quorum.
    const kept = <T>(given: T | undefined, held: unknown): T | null => (given === undefined ? ((held ?? null) as T | null) : (given ?? null));
    await app.db.update("decision", str(current.id), {
      round_id: input.round_id ?? current.round_id ?? null,
      outcome: input.outcome,
      assigned_track_id: kept(input.assigned_track_id, current.assigned_track_id),
      assigned_format_id: kept(input.assigned_format_id, current.assigned_format_id),
      assigned_duration_minutes: kept(input.assigned_duration_minutes, current.assigned_duration_minutes),
      conditions: kept(input.conditions, current.conditions),
      feedback_for_speaker: kept(input.feedback_for_speaker, current.feedback_for_speaker),
      rationale: kept(input.rationale, current.rationale),
      confirmation_deadline: kept(input.confirmation_deadline, current.confirmation_deadline),
      quorum_waived_reason: kept(input.quorum_waived_reason, current.quorum_waived_reason),
      decided_by_person_id: decidedBy,
      decided_at: app.now(),
    });
    app.events.emit({
      type: "decision.recorded",
      subject: { type: "decision", id: str(current.id) },
      event_id: eventId,
      data: {
        decision_id: str(current.id),
        proposal_id: input.proposal_id,
        outcome: input.outcome,
        decided_by: decidedBy,
      },
    });
    app.audit.record({
      action: "decision.update",
      entity_type: "decision",
      entity_id: str(current.id),
      before: { outcome: str(current.outcome) },
      after: { outcome: input.outcome },
      reason: input.quorum_waived_reason ?? null,
    });
    return str(current.id);
  }

  const id = newId("Decision");
  await app.db.insert("decision", {
    id,
    proposal_id: input.proposal_id,
    round_id: input.round_id ?? null,
    outcome: input.outcome,
    assigned_track_id: input.assigned_track_id ?? null,
    assigned_format_id: input.assigned_format_id ?? null,
    assigned_duration_minutes: input.assigned_duration_minutes ?? null,
    conditions: input.conditions ?? null,
    feedback_for_speaker: input.feedback_for_speaker ?? null,
    rationale: input.rationale ?? null,
    decided_by_person_id: decidedBy,
    decided_at: app.now(),
    status: "provisional",
    published_at: null,
    notification_id: null,
    confirmation_deadline: input.confirmation_deadline ?? null,
    // The waitlist is the outcome plus a superseding decision and nothing more (R18).
    supersedes_decision_id: current ? str(current.id) : null,
    quorum_waived_reason: input.quorum_waived_reason ?? null,
    row_version: 1,
  });

  app.events.emit({
    type: "decision.recorded",
    subject: { type: "decision", id },
    event_id: eventId,
    data: { decision_id: id, proposal_id: input.proposal_id, outcome: input.outcome, decided_by: decidedBy },
  });
  app.audit.record({
    action: "decision.record",
    entity_type: "decision",
    entity_id: id,
    after: { proposal_id: input.proposal_id, outcome: input.outcome },
    reason: input.quorum_waived_reason ?? null,
  });
  return id;
}

async function latestRoundFor(app: AppContext, proposalId: string): Promise<string | null> {
  const assignments = await app.db.select<Row>("review_assignment", { proposal_id: proposalId }, { orderBy: "assigned_at DESC" });
  if (assignments.length > 0) return str(assignments[0].round_id);
  const reviews = await app.db.select<Row>("review", { proposal_id: proposalId }, { orderBy: "created_at DESC" });
  return reviews.length > 0 ? str(reviews[0].round_id) : null;
}

// Must match the outcome → template mapping `platform.notify_decision`
// resolves at delivery time (`platform/reactions.ts`) — this is only for the
// preview below to show the chair the truth, not a second source of it. Keys
// are the `proposal.*` templates actually declared in
// `platform/templates.ts`; the previous `decision.*` keys here did not exist.
const DECISION_TEMPLATE: Record<DecisionOutcome, string> = {
  accept: "proposal.accepted",
  waitlist: "proposal.waitlisted",
  reject: "proposal.rejected",
  request_changes: "proposal.changes_requested",
};

export interface PublishPreviewRow {
  decision: Row;
  proposal: Row;
  recipient: { person_id: string; full_name: string; email: string } | null;
  also_notified: { person_id: string; full_name: string; email: string }[];
  template_key: string;
  subject: string;
  blocked: string | null;
}

/**
 * "Nothing reaches a speaker until the chair publishes — as a deliberate batch,
 * with a preview of exactly who gets which email. The alternative is the classic
 * disaster where saving a dropdown emails 400 rejections at 2am."
 *
 * This is the preview. It writes nothing.
 */
export async function previewPublish(
  app: AppContext,
  eventId: string,
  decisionIds: string[],
): Promise<PublishPreviewRow[]> {
  const event = await requireEvent(app, eventId);
  const out: PublishPreviewRow[] = [];
  for (const decisionId of decisionIds) {
    const decision = await app.db.byId<Row>("decision", decisionId);
    if (!decision) continue;
    const proposal = await app.db.byId<Row>("proposal", str(decision.proposal_id));
    if (!proposal || str(proposal.event_id) !== eventId) continue;

    const submitter = await app.db.byId<Row>("person", str(proposal.submitter_person_id));
    const speakerRows = await app.db.select<Row>("proposal_speaker", { proposal_id: str(proposal.id) });
    const others: PublishPreviewRow["also_notified"] = [];
    for (const s of speakerRows) {
      if (str(s.participation_status) === "removed") continue;
      if (str(s.person_id) === str(proposal.submitter_person_id)) continue;
      const person = await app.db.byId<Row>("person", str(s.person_id));
      if (person) others.push({ person_id: person.id as string, full_name: str(person.full_name), email: str(person.email) });
    }

    out.push({
      decision,
      proposal,
      recipient: submitter
        ? { person_id: str(submitter.id), full_name: str(submitter.full_name), email: str(submitter.email) }
        : null,
      also_notified: others,
      template_key: DECISION_TEMPLATE[str(decision.outcome) as DecisionOutcome],
      subject: `${str(event.name)}: your session "${str(proposal.title)}"`,
      blocked: await publishBlockedReason(app, decision, proposal, app.now()),
    });
  }
  return out;
}

/**
 * INV-05-9 — a `Decision` may only be `published` when `Proposal.status` allows
 * it and, for `outcome = accept`, `confirmation_deadline` is set and in the
 * future.
 *
 * INV-05-11 — and, for `outcome = accept`, the proposal has quorum or the chair
 * has recorded a reason for waiving it. This is checked here rather than when
 * the outcome is recorded (R32): leaning towards an acceptance is triage, which
 * happens before the reviews are in; telling the speaker is the act that needs
 * the reviews behind it.
 */
async function publishBlockedReason(app: AppContext, decision: Row, proposal: Row, now: string): Promise<string | null> {
  const status = str(decision.status) as DecisionStatus;
  if (status === "published") return "Already published — publishing again sends nothing."; // INV-05-10
  if (status === "superseded") return "Superseded by a later decision.";

  const proposalStatus = str(proposal.status);
  if (["draft", "withdrawn", "expired"].includes(proposalStatus)) {
    return `The proposal is ${proposalStatus}; a decision cannot be published against it.`;
  }
  if (str(decision.outcome) === "accept") {
    const deadline = strOrNull(decision.confirmation_deadline);
    if (!deadline) return "An acceptance needs a confirmation deadline before it can be published.";
    if (deadline <= now) return "The confirmation deadline is in the past.";

    if (!strOrNull(decision.quorum_waived_reason)?.trim()) {
      const roundId = strOrNull(decision.round_id) ?? (await latestRoundFor(app, str(proposal.id)));
      // INV-05-17: an AI review never satisfies quorum, so this is a human count.
      const score = roundId ? await proposalScoreFor(app, roundId, str(proposal.id)) : null;
      if (score && !score.has_quorum) {
        return `This proposal has ${score.human_review_count} of ${score.target_reviews_per_proposal} reviews. Accepting it needs a recorded reason for going ahead with fewer.`;
      }
    }
  }
  return null;
}

export interface PublishResult {
  published: string[];
  skipped: { decision_id: string; reason: string }[];
}

/**
 * Publishing a batch, in one transaction per proposal: set
 * `Decision.status = published`, move `Proposal.status`, stamp
 * `confirmation_deadline` on accepts, and enqueue exactly one notification per
 * proposal.
 *
 * INV-05-10 — at most one speaker notification per proposal, idempotent on
 * decision id. Re-running a publish tells nobody twice.
 */
export async function publishDecisions(
  app: AppContext,
  eventId: string,
  decisionIds: string[],
): Promise<PublishResult> {
  await requireEvent(app, eventId); // 404s a bogus event id rather than silently publishing nothing
  const published: string[] = [];
  const skipped: { decision_id: string; reason: string }[] = [];
  const now = app.now();

  for (const decisionId of [...new Set(decisionIds)]) {
    const decision = await app.db.byId<Row>("decision", decisionId);
    if (!decision) {
      skipped.push({ decision_id: decisionId, reason: "No such decision." });
      continue;
    }
    const proposal = await app.db.byId<Row>("proposal", str(decision.proposal_id));
    if (!proposal || str(proposal.event_id) !== eventId) {
      skipped.push({ decision_id: decisionId, reason: "That decision belongs to another event." });
      continue;
    }
    const blocked = await publishBlockedReason(app, decision, proposal, now);
    if (blocked) {
      skipped.push({ decision_id: decisionId, reason: blocked });
      continue;
    }
    assertDecisionTransition("provisional", "published"); // INV-05-9

    // Anything this decision supersedes stops being current in the same breath.
    if (decision.supersedes_decision_id) {
      await app.db.update("decision", str(decision.supersedes_decision_id), { status: "superseded" });
    }

    const outcome = str(decision.outcome) as DecisionOutcome;

    // INV-05-10 — exactly one speaker notification per proposal. That is
    // `platform.notify_decision` (10, reaction map: `decision.published` →
    // "email speakers"), reacting to the event emitted below; it is the only
    // writer of a decision notification, so there is nothing to link back
    // into `Decision.notification_id` here (it stays null, as it does for
    // every published decision — see the comment on the reaction for the
    // history of why a second, inline writer used to exist and produced two).
    await app.db.update("decision", decisionId, { status: "published", published_at: now });

    // `Proposal.status` is downstream of the decision, not parallel to it. The
    // transition itself belongs to Submissions.
    if (outcome === "request_changes") {
      await requestChanges(app, str(proposal.id), str(decision.feedback_for_speaker) || "Please revise and resubmit.");
    } else {
      await applyDecisionToProposal(app, str(proposal.id), {
        decision_id: decisionId,
        outcome,
        confirmation_deadline: strOrNull(decision.confirmation_deadline),
        assigned_track_id: strOrNull(decision.assigned_track_id),
        assigned_format_id: strOrNull(decision.assigned_format_id),
        assigned_duration_minutes:
          decision.assigned_duration_minutes === null || decision.assigned_duration_minutes === undefined
            ? null
            : num(decision.assigned_duration_minutes),
      });
    }

    app.events.emit({
      type: "decision.published",
      subject: { type: "decision", id: decisionId },
      event_id: eventId,
      data: {
        decision_id: decisionId,
        proposal_id: str(proposal.id),
        outcome,
        assigned_track_id: strOrNull(decision.assigned_track_id),
        assigned_format_id: strOrNull(decision.assigned_format_id),
        assigned_duration_minutes:
          decision.assigned_duration_minutes === null || decision.assigned_duration_minutes === undefined
            ? null
            : num(decision.assigned_duration_minutes),
        confirmation_deadline: strOrNull(decision.confirmation_deadline),
      },
    });

    // One event per fact: `decision.published` and the outcome fact are
    // different facts for different consumers, and both are cheap (10, "Naming
    // rules"). `request_changes` has no such fact — the proposal event covers it.
    if (outcome === "accept") {
      app.events.emit({
        type: "proposal.accepted",
        subject: { type: "proposal", id: str(proposal.id) },
        event_id: eventId,
        data: {
          proposal_id: str(proposal.id),
          decision_id: decisionId,
          confirmation_deadline: strOrNull(decision.confirmation_deadline),
        },
      });
    } else if (outcome === "waitlist") {
      app.events.emit({
        type: "proposal.waitlisted",
        subject: { type: "proposal", id: str(proposal.id) },
        event_id: eventId,
        data: { proposal_id: str(proposal.id), decision_id: decisionId },
      });
    } else if (outcome === "reject") {
      app.events.emit({
        type: "proposal.rejected",
        subject: { type: "proposal", id: str(proposal.id) },
        event_id: eventId,
        data: { proposal_id: str(proposal.id), decision_id: decisionId },
      });
    }

    app.audit.record({
      action: "decision.publish",
      entity_type: "decision",
      entity_id: decisionId,
      before: { status: "provisional" },
      after: { status: "published", outcome },
      reason: strOrNull(decision.quorum_waived_reason),
    });
    published.push(decisionId);
  }

  return { published, skipped };
}

/**
 * There used to be a second writer here: `writeDecisionNotification` wrote a
 * submitter-only `NotificationDelivery` inline, in the same breath as emitting
 * `decision.published` — which `platform.notify_decision` also reacts to,
 * queuing the same message for the submitter *and* every credited speaker.
 * A submitter who is also a speaker (the common case) got two emails, and the
 * comment above the inline writer claimed INV-05-10 ("at most one speaker
 * notification per proposal") while the code guaranteed two.
 *
 * The reaction is the one path now, and it already had everything the inline
 * copy did except two things, both preserved there rather than here:
 *   - `decision.conditions` — "conditions of acceptance, shown to the
 *     speaker" (05, `Decision`) — is now a variable on `proposal.accepted`
 *     (`platform/templates.ts`) and passed by `platform.notify_decision`.
 *   - `rationale` stays excluded (INV-05-7: committee-only, never reaches the
 *     submitter) — the reaction never reads it, same as before.
 * `comments_for_committee` and reviewer identities were never in the inline
 * body either, so nothing there needed carrying over.
 */

/* ========================================================================== */
/* Reminders                                                                   */
/* ========================================================================== */

/**
 * Both flavours of reminder — scheduled from `ReviewRoundReminderRule`, and
 * manual from the progress view — write a `NotificationDelivery`, increment
 * `ReviewAssignment.reminder_count`, and emit `review_assignment.reminded`.
 * "Did we chase them" and "how many times" are questions with answers.
 *
 * Digesting applies exactly as it does for tasks: a reviewer with nine
 * outstanding proposals gets one message listing nine.
 */
export async function remindReviewer(
  app: AppContext,
  input: {
    round_id: string;
    reviewer_person_id: string;
    assignment_ids: string[];
    trigger: ReminderTrigger;
    template_key?: string;
    channel?: ReminderChannel;
  },
): Promise<string | null> {
  const round = await requireRound(app, input.round_id);
  const event = await requireEvent(app, round.event_id);
  const person = await app.db.byId<Row>("person", input.reviewer_person_id);
  if (!person) return null;

  const assignments: Row[] = [];
  for (const id of input.assignment_ids) {
    const row = await app.db.byId<Row>("review_assignment", id);
    if (!row) continue;
    if (str(row.round_id) !== round.id) continue;
    if (str(row.reviewer_person_id) !== input.reviewer_person_id) continue;
    // Never remind on a terminal assignment status.
    if (isTerminalAssignment(str(row.status) as AssignmentStatus)) continue;
    assignments.push(row);
  }
  if (assignments.length === 0) return null;

  const lines: string[] = [];
  for (const a of assignments) {
    const proposal = await app.db.byId<Row>("proposal", str(a.proposal_id));
    lines.push(
      `· ${proposal ? str(proposal.reference) : str(a.proposal_id)} — ${proposal ? str(proposal.title) : ""} (due ${str(a.due_at) || str(round.closes_at)})`,
    );
  }

  const notificationId = newId("NotificationDelivery");
  const now = app.now();
  await app.db.insert("notification_delivery", {
    id: notificationId,
    org_id: app.orgId,
    event_id: round.event_id,
    template_key: input.template_key ?? "review.reminder",
    recipient_person_id: input.reviewer_person_id,
    recipient_email: str(person.email),
    channel: input.channel ?? "email",
    subject_type: "review_round",
    subject_id: round.id,
    subject: `${str(event.name)}: ${assignments.length} review${assignments.length === 1 ? "" : "s"} outstanding`,
    rendered_body: [
      `You have ${assignments.length} outstanding review${assignments.length === 1 ? "" : "s"} for ${str(event.name)} ("${round.name}").`,
      "",
      ...lines,
    ].join("\n"),
    status: "queued",
    created_at: now,
  });

  for (const a of assignments) {
    await app.db.update("review_assignment", str(a.id), {
      reminder_count: num(a.reminder_count, 0) + 1,
      last_reminded_at: now,
    });
    app.events.emit({
      type: "review_assignment.reminded",
      subject: { type: "assignment", id: str(a.id) },
      event_id: round.event_id,
      data: {
        assignment_id: str(a.id),
        reviewer_person_id: input.reviewer_person_id,
        reminder_count: num(a.reminder_count, 0) + 1,
        trigger: input.trigger,
        triggered_by_person_id: app.actor.id ?? null,
      },
    });
  }

  try {
    const message: DeliveryMessage = { kind: "notification", notification_id: notificationId, org_id: app.orgId };
    await app.env.DELIVERY_QUEUE.send(message);
  } catch (err) {
    console.warn("reminder enqueue failed", { notification_id: notificationId, error: String(err) });
  }
  return notificationId;
}

/* ========================================================================== */
/* Read guards                                                                 */
/* ========================================================================== */

/**
 * INV-11-7 / INV-04-11 — a person may never read review data, scores, reviewer
 * identities or committee discussion for a proposal they submitted or are
 * credited on, regardless of role. A program chair who submits a talk is a
 * submitter for that talk. The surface is absent, not redacted.
 */
export async function assertNotOwnProposal(app: AppContext, personId: string | null, proposalId: string): Promise<void> {
  if (!personId) return;
  const proposal = await app.db.byId<Row>("proposal", proposalId);
  if (!proposal) return;
  if (str(proposal.submitter_person_id) === personId) {
    throw invariantError(
      "INV-11-7",
      "own_proposal_review_data",
      "Review data for a proposal you submitted is not available at any permission level.",
      { proposal_id: proposalId },
      403,
    );
  }
  const credited = await app.db.first<Row>("proposal_speaker", { proposal_id: proposalId, person_id: personId });
  if (credited && str(credited.participation_status) !== "removed") {
    throw invariantError(
      "INV-11-7",
      "own_proposal_review_data",
      "Review data for a proposal you are credited on is not available at any permission level.",
      { proposal_id: proposalId },
      403,
    );
  }
}

/**
 * INV-05-18 — a reviewer may read only the proposals assigned to them in a
 * round whose pool they belong to. Enumerating, searching or fetching any other
 * proposal — including by guessing an identifier — is denied, not merely
 * unlinked.
 */
export async function requireOwnAssignment(app: AppContext, personId: string, assignmentId: string): Promise<Row> {
  const assignment = await app.db.byId<Row>("review_assignment", assignmentId);
  if (!assignment || str(assignment.reviewer_person_id) !== personId) {
    throw invariantError(
      "INV-05-18",
      "not_your_assignment",
      "You may only open the proposals assigned to you.",
      { assignment_id: assignmentId },
      403,
    );
  }
  const round = await requireRound(app, str(assignment.round_id));
  const member = await app.db.first<Row>("review_round_reviewer", {
    round_id: round.id,
    person_id: personId,
    status: "active",
  });
  if (!member) {
    throw invariantError(
      "INV-05-18",
      "not_in_round_pool",
      "You are not in this round's reviewer pool. Membership of one round's pool implies nothing about another's.",
      { round_id: round.id },
      403,
    );
  }
  await assertNotOwnProposal(app, personId, str(assignment.proposal_id)); // INV-11-7
  return assignment;
}

/**
 * INV-05-6 — when `show_other_reviews_before_submit` is false, a reviewer
 * cannot read other reviews, aggregate scores or discussion for a proposal
 * until their own review is submitted or their assignment is declined.
 * Anchoring is real.
 */
export async function canSeeOtherReviews(app: AppContext, round: RoundView, assignment: Row): Promise<boolean> {
  if (round.show_other_reviews_before_submit) return true;
  const status = str(assignment.status);
  if (status === "declined") return true;
  if (status === "submitted") return true;
  const own = await currentReviewFor(app, str(assignment.id));
  return !!own && (str(own.status) === "submitted" || str(own.status) === "stale");
}

export function assertMaySeeOtherReviews(allowed: boolean): void {
  if (!allowed) {
    throw invariantError(
      "INV-05-6",
      "reviews_hidden_until_submitted",
      "Other reviews, the aggregate and the discussion open once your own review is submitted.",
      undefined,
      403,
    );
  }
}

export { toRubricView };
