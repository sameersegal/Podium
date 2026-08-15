/**
 * Review & Selection — 05-review-and-selection.md.
 *
 * Reviewer surface (`portalPage`): `/review`, `/review/:assignmentId`.
 * Chair and admin (`adminPage`): rounds, pool, assignments, progress, results,
 * rubrics, decisions and publish, committee discussion.
 * Management API: `/v1/rounds`, `/v1/assignments`, `/v1/reviews`,
 * `/v1/decisions`, `/v1/proposals/:id/score`.
 *
 * Round/rubric/pool/assignment/decision administration is gated on
 * `decision.manage` (owner/admin/program_chair write, track_lead recommend —
 * read only through this surface, since no finer-grained capability exists in
 * the matrix). The reviewer surface is gated by assignment ownership
 * (INV-05-18), not by a capability row.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import type {
  AssignedBy,
  AssignmentStatus,
  CoiReason,
  CoiSubjectType,
  CommentVisibility,
  Confidence,
  DeclineReason,
  PoolRole,
  Recommendation,
  ReviewFlag,
  RoundAnonymity,
} from "@podiumstack/domain/review/types.js";
import { isTerminalAssignment, type OverallScale, type RoundScope } from "@podiumstack/domain/review/types.js";
import { reviewerIdentityVisible } from "@podiumstack/domain/review/anonymity.js";
import { notFound, validationError } from "@podiumstack/domain/shared/errors.js";
import { relativeDays, zonedDateTimeToInstant } from "@podiumstack/domain/shared/time.js";
import { expectedVersion, staleWriteRedirect } from "../../http/concurrency.js";
import { flashCookie, requirePersonalAuthorship, type RequestContext } from "../../http/context.js";
import { readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect, text } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, type SafeHtml } from "../../ui/html.js";
import { pageHead } from "../../ui/layout.js";
import { adminPage, loadEvent, reviewerPage, type EventRef } from "../../ui/shell.js";
import { personDisplayName } from "../identity/service.js";
import {
  addComment,
  addPoolMember,
  aiEvaluationEnabled,
  assertNoConflict,
  confirmAssignments,
  createAssignment,
  createRound,
  createRubric,
  createSponsorComplianceRubric,
  declareConflict,
  declineAssignment,
  deleteConflict,
  generateAiReviewsForRound,
  listComments,
  overrideAiReview,
  previewPublish,
  proposeAutoDistribution,
  proposeBulkAssignment,
  publishDecisions,
  recordDecision,
  remindReviewer,
  removePoolMember,
  requireAssignmentRow,
  requireOwnAssignment,
  revokeAssignment,
  saveReviewDraft,
  setAssignmentStatus,
  submitReview,
  toPoolMemberView,
  transitionRound,
  updateRound,
  updateRubric,
  currentLoads,
  type AssignmentFilter,
  type DecisionInput,
  type PoolMemberView,
  type ReviewDraftInput,
  type RoundInput,
} from "./service.js";
import {
  applyResultFilters,
  loadConflicts,
  loadReviews,
  progressForRound,
  requireEvent,
  requireRound,
  requireRubric,
  roundResults,
  roundScopeProposals,
  RESULT_SORTS,
  toRoundView,
  decisionQueue,
  proposalScoreFor,
  type ResultFilters,
  type ResultSort,
  type RoundView,
} from "./scoring.js";
import {
  assignmentsView,
  decisionFormView,
  decisionsListView,
  opts,
  parseCriteriaFromInput,
  poolView,
  proposalDiscussionView,
  progressView,
  publishPreviewView,
  resultsCsvRow,
  resultsView,
  roundDetailView,
  roundFormView,
  roundsOverviewView,
  rubricFormView,
  rubricsListView,
  toCsv,
  type AssignmentRowView,
  type CommentThreadItem,
  type PersonRef,
  type PoolRowView,
  type AiReviewView,
  type HumanReviewView,
} from "./views.js";
import {
  overrideScorecardForm,
  partitionQueue,
  reviewerAssignmentView,
  reviewerDashboardView,
  type ReviewerQueueFilter,
} from "./reviewer-views.js";
import {
  loadReviewerQueue,
  loadScorecard,
  outstandingQueue,
  toQueueView,
  toScorecardView,
  type ReviewerRound,
} from "./reviewer-model.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });
const WARN = (message: string) => ({ "set-cookie": flashCookie("warn", message) });

/* -------------------------------------------------------------------------- */
/* Shared loaders                                                             */
/* -------------------------------------------------------------------------- */

async function loadRoundFor(ctx: RequestContext, roundId: string): Promise<{ round: RoundView; event: EventRef }> {
  const app = ctx.app();
  const round = await requireRound(app, roundId);
  ctx.eventId = round.event_id;
  const event = await loadEvent(ctx, round.event_id);
  if (!event) throw notFound("Event", round.event_id);
  return { round, event };
}

async function loadProposalFor(ctx: RequestContext, proposalId: string): Promise<{ proposal: Row; event: EventRef }> {
  const app = ctx.app();
  const proposal = await app.db.byId<Row>("proposal", proposalId);
  if (!proposal) throw notFound("Proposal", proposalId);
  ctx.eventId = str(proposal.event_id);
  const event = await loadEvent(ctx, str(proposal.event_id));
  if (!event) throw notFound("Event", str(proposal.event_id));
  return { proposal, event };
}

async function personRefs(app: AppContext, ids: (string | null | undefined)[]): Promise<Record<string, PersonRef>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return {};
  const rows = await app.db.raw<Row>(
    `SELECT id, full_name, display_name, email FROM person WHERE id IN (${unique.map(() => "?").join(",")})`,
    unique,
  );
  const out: Record<string, PersonRef> = {};
  for (const r of rows) out[str(r.id)] = { id: str(r.id), name: personDisplayName(r), email: str(r.email) };
  return out;
}

async function eventLookups(app: AppContext, eventId: string) {
  const [tracks, formats, cfps] = await Promise.all([
    app.db.select<Row>("track", { event_id: eventId }, { orderBy: "sort_order" }),
    app.db.select<Row>("session_format", { event_id: eventId }, { orderBy: "sort_order" }),
    app.db.select<Row>("call_for_proposals", { event_id: eventId }, { orderBy: "created_at" }),
  ]);
  return { tracks, formats, cfps };
}

async function loadPoolRows(app: AppContext, round: RoundView): Promise<PoolRowView[]> {
  const rows = await app.db.select<Row>("review_round_reviewer", { round_id: round.id }, { orderBy: "created_at" });
  const members = rows.map(toPoolMemberView);
  const loads = await currentLoads(app, round.id);
  const people = await personRefs(app, members.map((m) => m.person_id));
  return members.map((m) => ({ member: m, person: people[m.person_id] ?? null, load: loads[m.person_id] ?? 0 }));
}

async function loadAssignmentRows(app: AppContext, round: RoundView): Promise<AssignmentRowView[]> {
  const assignmentRows = await app.db.select<Row>("review_assignment", { round_id: round.id }, { orderBy: "assigned_at" });
  const proposalIds = [...new Set(assignmentRows.map((a) => str(a.proposal_id)))];
  const proposals = proposalIds.length
    ? await app.db.raw<Row>(`SELECT id, reference, title FROM proposal WHERE id IN (${proposalIds.map(() => "?").join(",")})`, proposalIds)
    : [];
  const proposalById = new Map(proposals.map((p) => [str(p.id), p]));
  const people = await personRefs(app, assignmentRows.map((a) => str(a.reviewer_person_id)));
  return assignmentRows.map((a) => ({
    assignment: a,
    proposal: proposalById.get(str(a.proposal_id)) ?? null,
    reviewer: people[str(a.reviewer_person_id)] ?? null,
  }));
}


function fromLocalInput(value: string | null, timezone: string): string {
  if (!value) return "";
  const [date, time] = value.split("T");
  if (!date) return "";
  return zonedDateTimeToInstant(date, time || "00:00", timezone);
}

function readScope(input: Input): RoundScope {
  const scope: RoundScope = {};
  const trackIds = input.list("scope_track_ids");
  const formatIds = input.list("scope_format_ids");
  const cfpIds = input.list("scope_cfp_ids");
  const min = input.optional("scope_min_prior_score");
  if (trackIds.length) scope.track_ids = trackIds;
  if (formatIds.length) scope.format_ids = formatIds;
  if (cfpIds.length) scope.cfp_ids = cfpIds;
  if (min) scope.min_prior_score = Number(min);
  return scope;
}

function readRoundFields(input: Input, timezone: string): Omit<RoundInput, "event_id"> {
  return {
    name: input.str("name"),
    sequence: input.int("sequence", 1) ?? 1,
    rubric_id: input.str("rubric_id"),
    scope: readScope(input),
    anonymity: (input.str("anonymity", "double_blind") || "double_blind") as RoundAnonymity,
    opens_at: fromLocalInput(input.str("opens_at"), timezone),
    closes_at: fromLocalInput(input.str("closes_at"), timezone),
    target_reviews_per_proposal: input.int("target_reviews_per_proposal", 2) ?? 2,
    max_assignments_per_reviewer: input.int("max_assignments_per_reviewer"),
    allow_self_assignment: input.bool("allow_self_assignment"),
    show_other_reviews_before_submit: input.bool("show_other_reviews_before_submit"),
    discussion_enabled: input.has("discussion_enabled") ? input.bool("discussion_enabled") : true,
  };
}

function filterFromParams(params: URLSearchParams): AssignmentFilter & { only_under_quorum?: boolean } {
  const trackIds = params.getAll("track_ids");
  const formatIds = params.getAll("format_ids");
  const cfpIds = params.getAll("cfp_ids");
  return {
    track_ids: trackIds.length ? trackIds : undefined,
    format_ids: formatIds.length ? formatIds : undefined,
    cfp_ids: cfpIds.length ? cfpIds : undefined,
    keyword: params.get("keyword") || null,
    only_under_quorum: params.get("only_under_quorum") !== null,
  };
}

function filterFromInput(input: Input): AssignmentFilter {
  const trackIds = input.list("track_ids");
  const formatIds = input.list("format_ids");
  const cfpIds = input.list("cfp_ids");
  return {
    track_ids: trackIds.length ? trackIds : undefined,
    format_ids: formatIds.length ? formatIds : undefined,
    cfp_ids: cfpIds.length ? cfpIds : undefined,
    keyword: input.optional("keyword"),
    only_under_quorum: input.bool("only_under_quorum"),
  };
}

function resultFiltersFromQuery(url: URL): ResultFilters {
  const sort = url.searchParams.get("sort");
  return {
    track_id: url.searchParams.get("track_id"),
    format_id: url.searchParams.get("format_id"),
    flag: url.searchParams.get("flag"),
    decision_state: url.searchParams.get("decision_state"),
    quorum: url.searchParams.get("quorum") === "yes" || url.searchParams.get("quorum") === "no" ? (url.searchParams.get("quorum") as "yes" | "no") : null,
    sort: (RESULT_SORTS as readonly string[]).includes(sort ?? "") ? (sort as ResultSort) : undefined,
    direction: url.searchParams.get("direction") === "desc" ? "desc" : "asc",
  };
}

function readReviewDraft(input: Input, criteria: { id: string; type: string }[]): ReviewDraftInput {
  const scores: ReviewDraftInput["scores"] = [];
  const na: string[] = [];
  for (const c of criteria) {
    if (input.has(`na_${c.id}`)) {
      na.push(c.id);
      continue;
    }
    switch (c.type) {
      case "numeric": {
        const v = input.int(`score_number_${c.id}`);
        if (v !== null) scores.push({ criterion_id: c.id, value_number: v, value_option: null, value_text: null, value_bool: null });
        break;
      }
      case "select": {
        const v = input.optional(`score_option_${c.id}`);
        if (v) scores.push({ criterion_id: c.id, value_number: null, value_option: v, value_text: null, value_bool: null });
        break;
      }
      case "text": {
        const v = input.optional(`score_text_${c.id}`);
        if (v) scores.push({ criterion_id: c.id, value_number: null, value_option: null, value_text: v, value_bool: null });
        break;
      }
      case "boolean": {
        const v = input.optional(`score_bool_${c.id}`);
        if (v === "true" || v === "false") {
          scores.push({ criterion_id: c.id, value_number: null, value_option: null, value_text: null, value_bool: v === "true" });
        }
        break;
      }
    }
  }
  return {
    scores,
    na_criterion_ids: na,
    recommendation: (input.optional("recommendation") as Recommendation | null) ?? null,
    confidence: (input.optional("confidence") as Confidence | null) ?? null,
    comments_for_committee: input.optional("comments_for_committee"),
    comments_for_speaker: input.optional("comments_for_speaker"),
    flags: input.list("flags") as ReviewFlag[],
  };
}

function readDecisionInput(input: Input, timezone: string): Omit<DecisionInput, "proposal_id"> {
  return {
    outcome: input.str("outcome") as DecisionInput["outcome"],
    assigned_track_id: input.optional("assigned_track_id"),
    assigned_format_id: input.optional("assigned_format_id"),
    assigned_duration_minutes: input.int("assigned_duration_minutes"),
    conditions: input.optional("conditions"),
    feedback_for_speaker: input.optional("feedback_for_speaker"),
    rationale: input.optional("rationale"),
    confirmation_deadline: input.optional("confirmation_deadline") ? fromLocalInput(input.str("confirmation_deadline"), timezone) : null,
    quorum_waived_reason: input.optional("quorum_waived_reason"),
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerReviewRoutes(router: Router<RequestContext>): void {
  registerReviewerRoutes(router);
  registerReviewerApi(router);
  registerRoundRoutes(router);
  registerPoolRoutes(router);
  registerAssignmentRoutes(router);
  registerProgressRoutes(router);
  registerResultsRoutes(router);
  registerRubricRoutes(router);
  registerDecisionRoutes(router);
  registerDiscussionRoutes(router);
  registerManagementApi(router);
}

/* ========================================================================== */
/* Reviewer surface — /review                                                 */
/* ========================================================================== */

/*
 * The loading lives in `reviewer-model.ts`, not here: these two screens are
 * rendered twice — as HTML below, and as JSON for the console that owns the
 * same two URLs (R30) — and a second copy of the loading would be a second
 * answer to "what do I still owe".
 *
 * `outstandingQueue`, from the same file, is why the scorecard can say "3 of
 * 17" and offer the next one. A reviewer working through a round was being
 * returned to `/review` after every submission and left to find their place
 * again — the difference between reviewing seventeen proposals and reviewing
 * four and giving up.
 */

const SHOW_TITLES: Record<ReviewerQueueFilter, string> = {
  queue: "My queue",
  submitted: "Submitted",
  declined: "Declined",
};

function queueFilter(value: string | null): ReviewerQueueFilter {
  return value === "submitted" || value === "declined" ? value : "queue";
}

/**
 * What the rail says the reviewer is working on. One round is named; several
 * are counted, because a rail that lists three round names has become a second
 * navigation.
 */
function railRound(rounds: ReviewerRound[], now: string): { name: string; lines: string[] } | null {
  if (rounds.length === 0) return null;
  if (rounds.length > 1) {
    return { name: `${rounds.length} open rounds`, lines: [rounds.map((r) => r.name).join(" · ")] };
  }
  const round = rounds[0];
  const parts: string[] = [];
  if (round.closes_at) parts.push(`closes ${relativeDays(round.closes_at, now)}`);
  // `double-blind`, not `Double blind`: it is a compound adjective, and the
  // rail is the one place this word appears in running text rather than as a
  // field value.
  parts.push(round.anonymity.replace(/_/g, "-"));
  return { name: round.name, lines: [parts.join(" · ")] };
}

function registerReviewerRoutes(router: Router<RequestContext>): void {
  router.get("/review", async (_req, ctx) => {
    const person = ctx.requirePerson();
    const { rows, progressByRound, rounds, conflicts } = await loadReviewerQueue(ctx.app(), person.id, ctx.now);

    const show = queueFilter(ctx.url.searchParams.get("show"));
    const parts = partitionQueue(rows);
    return htmlResponse(
      reviewerPage(
        ctx,
        {
          title: SHOW_TITLES[show],
          round: railRound(rounds, ctx.now),
          active: show,
          counts: { queue: parts.queue.length, submitted: parts.submitted.length, declined: parts.declined.length },
          hints: [
            { keys: ["J", "K"], label: "move" },
            { keys: ["↵"], label: "open" },
          ],
        },
        reviewerDashboardView({ rows, progressByRound, rounds, conflicts, show, now: ctx.now }),
      ),
    );
  });

  router.get("/review/:assignmentId", async (_req, ctx, params) => {
    const person = ctx.requirePerson();
    // INV-05-18 + INV-11-7 — ownership is the guard, inside the loader.
    const m = await loadScorecard(ctx.app(), person.id, params.assignmentId, ctx.now);

    return htmlResponse(
      reviewerPage(
        ctx,
        {
          title: m.proposal.title,
          round: railRound(
            [{ id: m.round.id, name: m.round.name, anonymity: m.round.anonymity, closes_at: m.round.closes_at ?? null }],
            ctx.now,
          ),
          active: "queue",
          crumbs: [{ label: "Review", href: "/review" }, { label: m.round.name, href: "/review" }, { label: m.proposal.title }],
        },
        reviewerAssignmentView({
          assignment: m.assignment,
          roundName: m.round.name,
          anonymity: m.round.anonymity,
          proposal: m.proposal,
          rubric: m.rubric,
          criteria: m.criteria,
          existing: { review: m.review, scores: m.scores, naCriterionIds: m.naCriterionIds },
          canSeeOthers: m.canSeeOthers,
          otherReviews: m.otherReviews,
          aggregate: m.aggregate,
          comments: m.comments,
          discussionEnabled: m.round.discussion_enabled,
          position: m.position,
          now: ctx.now,
        }),
      ),
    );
  });

  router.post("/review/:assignmentId", async (req, ctx, params) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const assignment = await requireOwnAssignment(app, person.id, params.assignmentId);
    const round = await requireRound(app, str(assignment.round_id));
    const { criteria } = await requireRubric(app, round.rubric_id);
    const input = await readInput(req);
    const draft = readReviewDraft(input, criteria);
    if (input.str("intent", "save") === "submit") {
      // The next one is chosen *before* the write, because submitting removes
      // this assignment from the outstanding queue and the reviewer's place in
      // it goes with it.
      const queue = await outstandingQueue(app, person.id);
      const at = queue.indexOf(params.assignmentId);
      const next = at >= 0 ? (queue[at + 1] ?? null) : null;
      await submitReview(app, params.assignmentId, draft);
      await app.flush();
      const remaining = Math.max(0, queue.length - 1);
      return next
        ? redirect(`/review/${next}`, 303, OK(`Review submitted. ${remaining} left in your queue.`))
        : redirect("/review", 303, OK("Review submitted — that was the last one in your queue. Thank you."));
    }
    await saveReviewDraft(app, params.assignmentId, draft);
    await app.flush();
    return redirect(`/review/${params.assignmentId}`, 303, OK("Draft saved."));
  });

  router.post("/review/:assignmentId/decline", async (req, ctx, params) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    await requireOwnAssignment(app, person.id, params.assignmentId);
    const input = await readInput(req);
    await declineAssignment(app, params.assignmentId, input.str("reason") as DeclineReason, input.optional("note"));
    await app.flush();
    return redirect("/review", 303, OK("Assignment declined."));
  });
}

/* ========================================================================== */
/* Portal API — /v1/me/assignments                                            */
/* ========================================================================== */

/**
 * The same two screens, as JSON, for the console that now owns their URLs
 * (R30).
 *
 * **Why `/v1/me/` and not the management surface.** These are the *portal*
 * surface as [`09`](docs/domain/09-api-and-integrations.md) defines it: a
 * session cookie, and scope derived from a relationship rather than a role. A
 * reviewer sees these assignments because they are theirs (INV-05-18), not
 * because a matrix row grants them `review.read` over an event — which is why
 * `requireOwnAssignment` is the guard here, exactly as it is on the HTML routes
 * beside them, and why no capability is checked. The management surface already
 * has the chair's view of the same data at `GET /v1/assignments?round_id=`,
 * gated the other way.
 *
 * **Writing a review is not here.** `POST /v1/reviews` already takes the draft
 * and the submission, from a signed-in person and never from a key
 * (INV-09-27), so the console posts there. A second write path for the same act
 * would be a second place for the anonymity and validation rules to be got
 * wrong.
 */
function registerReviewerApi(router: Router<RequestContext>): void {
  router.get("/v1/me/assignments", async (_req, ctx) => {
    const person = ctx.requirePerson();
    return json({ data: toQueueView(await loadReviewerQueue(ctx.app(), person.id, ctx.now)) });
  });

  router.get("/v1/me/assignments/:assignmentId", async (_req, ctx, params) => {
    const person = ctx.requirePerson();
    return json({ data: toScorecardView(await loadScorecard(ctx.app(), person.id, params.assignmentId, ctx.now)) });
  });

  /**
   * Declining is the reviewer's own statement about themselves — most often
   * "I have a conflict" — so it is `/v1/me/` and it needs a person, for the
   * same reason writing the review does (INV-09-27). It is not a chair
   * revoking an assignment; that is
   * `POST /admin/rounds/:roundId/assignments/:assignmentId/revoke`.
   */
  router.post("/v1/me/assignments/:assignmentId/decline", async (req, ctx, params) => {
    requirePersonalAuthorship(ctx, "Declining an assignment");
    const person = ctx.requirePerson();
    const app = ctx.app();
    await requireOwnAssignment(app, person.id, params.assignmentId);
    const input = await readInput(req);
    const reason = input.optional("reason");
    if (!reason) {
      throw validationError("A reason is required.", [{ field_key: "reason", message: "Why are you declining this one?" }]);
    }
    await declineAssignment(app, params.assignmentId, reason as DeclineReason, input.optional("note"));
    await app.flush();
    return json({ id: params.assignmentId, status: "declined" });
  });
}

/* ========================================================================== */
/* Rounds — /admin/events/:eventId/review, /admin/rounds/:roundId             */
/* ========================================================================== */

function registerRoundRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/review", async (_req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const roundRows = await app.db.select<Row>("review_round", { event_id: event.id }, { orderBy: "sequence, created_at" });
    const rounds = roundRows.map(toRoundView);
    const summaries = [];
    for (const round of rounds) {
      const rubric = await app.db.byId<Row>("rubric", round.rubric_id);
      const poolSize = await app.db.count("review_round_reviewer", { round_id: round.id, status: "active" });
      const assignmentCount = await app.db.count("review_assignment", { round_id: round.id });
      const submittedCount = await app.db.count("review_assignment", { round_id: round.id, status: "submitted" });
      const proposalCount = (await roundScopeProposals(app, round)).length;
      summaries.push({ round, rubricName: rubric ? str(rubric.name) : "—", poolSize, assignmentCount, submittedCount, proposalCount });
    }
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Review", event, active: "review", width: "wide" },
        roundsOverviewView({ event, rounds: summaries, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }) }),
      ),
    );
  });

  router.get("/admin/events/:eventId/review/rounds/new", async (_req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const rubricRows = await app.db.select<Row>("rubric", { event_id: event.id }, { orderBy: "name, version DESC" });
    const { toRubricView } = await import("./scoring.js");
    const rubrics = rubricRows.map(toRubricView);
    const { tracks, formats, cfps } = await eventLookups(app, event.id);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New round", event, active: "review" },
        html`${pageHead("New round", "A screening pass, a deep round, a shortlist meeting — modelling one round forces the others into spreadsheets.")}${roundFormView({ event, round: null, rubrics, tracks, formats, cfps })}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/review/rounds/new", async (req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const id = await createRound(app, { event_id: event.id, ...readRoundFields(input, event.timezone) });
    await app.flush();
    return redirect(`/admin/rounds/${id}`, 303, OK("Round created, still a draft. Add the pool next."));
  });

  router.get("/admin/rounds/:roundId", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const rubricRows = await app.db.select<Row>("rubric", { event_id: event.id }, { orderBy: "name, version DESC" });
    const { toRubricView } = await import("./scoring.js");
    const rubrics = rubricRows.map(toRubricView);
    const { tracks, formats, cfps } = await eventLookups(app, event.id);
    return htmlResponse(
      adminPage(
        ctx,
        { title: round.name, event, active: "review" },
        roundDetailView({
          event,
          round,
          rubrics,
          tracks,
          formats,
          cfps,
          canWrite: ctx.canWrite("decision.manage", { event_id: event.id }),
          aiEvaluationEnabled: await aiEvaluationEnabled(app),
        }),
      ),
    );
  });

  router.post("/admin/rounds/:roundId/ai-evaluate", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const result = await generateAiReviewsForRound(app, round.id);
    await app.flush();
    return redirect(
      `/admin/rounds/${round.id}`,
      303,
      OK(`Generated ${result.generated} AI first-pass review${result.generated === 1 ? "" : "s"}.${result.skipped ? ` ${result.skipped} skipped (already reviewed or failed).` : ""}`),
    );
  });

  router.post("/admin/rounds/:roundId", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    try {
      // INV-11-14 — the version the chair's browser rendered, not the one this
      // request just read.
      await updateRound(app, round.id, readRoundFields(input, event.timezone), expectedVersion(input));
    } catch (err) {
      const stale = await staleWriteRedirect(err, app, `/admin/rounds/${round.id}`);
      if (stale) return stale;
      throw err;
    }
    await app.flush();
    return redirect(`/admin/rounds/${round.id}`, 303, OK("Settings saved."));
  });

  const transition = (to: "open" | "closed" | "finalised", reasonDefault?: string) =>
    async (req: Request, ctx: RequestContext, params: Record<string, string>) => {
      const { round, event } = await loadRoundFor(ctx, params.roundId);
      ctx.requireWrite("decision.manage", { event_id: event.id });
      const input = await readInput(req);
      const app = ctx.app(event.id);
      await transitionRound(app, round.id, to, { reason: input.optional("reason") ?? reasonDefault ?? null });
      await app.flush();
      return redirect(`/admin/rounds/${round.id}`, 303, OK(`Round ${to === "open" ? "opened" : to === "closed" ? "closed" : "finalised"}.`));
    };

  router.post("/admin/rounds/:roundId/open", transition("open"));
  router.post("/admin/rounds/:roundId/reopen", transition("open", "Reopened by an administrator."));
  router.post("/admin/rounds/:roundId/close", transition("closed"));
  router.post("/admin/rounds/:roundId/finalise", transition("finalised"));
}

/* ========================================================================== */
/* Pool — /admin/rounds/:roundId/pool                                         */
/* ========================================================================== */

function registerPoolRoutes(router: Router<RequestContext>): void {
  router.get("/admin/rounds/:roundId/pool", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const rows = await loadPoolRows(app, round);
    const { tracks } = await eventLookups(app, event.id);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Pool · ${round.name}`, event, active: "review" },
        poolView({ event, round, rows, tracks, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }) }),
      ),
    );
  });

  router.post("/admin/rounds/:roundId/pool", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const result = await addPoolMember(
      app,
      {
        round_id: round.id,
        email: input.str("email"),
        full_name: input.optional("full_name"),
        pool_role: (input.str("pool_role", "reviewer") || "reviewer") as PoolRole,
        track_ids: input.list("track_ids"),
        max_assignments: input.int("max_assignments"),
      },
      ctx.env.PUBLIC_BASE_URL || ctx.url.origin,
    );
    await app.flush();
    if (result.invitation) {
      const rows = await loadPoolRows(app, round);
      const { tracks } = await eventLookups(app, event.id);
      return htmlResponse(
        adminPage(
          ctx,
          { title: "Invitation created", event, active: "review" },
          poolView({
            event,
            round,
            rows,
            tracks,
            canWrite: true,
            acceptUrl: { url: result.invitation.accept_url, email: result.invitation.email },
          }),
        ),
      );
    }
    return redirect(`/admin/rounds/${round.id}/pool`, 303, OK("Added to the pool."));
  });

  router.post("/admin/rounds/:roundId/pool/:memberId/remove", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await removePoolMember(app, params.memberId, input.optional("reason"));
    await app.flush();
    return redirect(`/admin/rounds/${round.id}/pool`, 303, OK("Removed from the pool. Their outstanding assignments were revoked."));
  });
}

/* ========================================================================== */
/* Assignments — /admin/rounds/:roundId/assignments                           */
/* ========================================================================== */

function registerAssignmentRoutes(router: Router<RequestContext>): void {
  router.get("/admin/rounds/:roundId/assignments", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const [rows, pool, lookups, poolProposals] = await Promise.all([
      loadAssignmentRows(app, round),
      loadPoolRows(app, round),
      eventLookups(app, event.id),
      roundScopeProposals(app, round),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Assignments · ${round.name}`, event, active: "review", width: "wide" },
        assignmentsView({ event, round, rows, pool, poolProposals, ...lookups, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }) }),
      ),
    );
  });

  router.get("/admin/rounds/:roundId/assignments/auto", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const filter = filterFromParams(ctx.url.searchParams);
    const pendingProposal = await proposeAutoDistribution(app, round.id, filter);
    const [rows, pool, lookups, poolProposals] = await Promise.all([
      loadAssignmentRows(app, round),
      loadPoolRows(app, round),
      eventLookups(app, event.id),
      roundScopeProposals(app, round),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Assignments · ${round.name}`, event, active: "review", width: "wide" },
        assignmentsView({
          event,
          round,
          rows,
          pool,
          poolProposals,
          ...lookups,
          canWrite: true,
          pendingProposal,
          filterState: {
            track_ids: filter.track_ids ?? [],
            format_ids: filter.format_ids ?? [],
            cfp_ids: filter.cfp_ids ?? [],
            keyword: filter.keyword ?? "",
          },
        }),
      ),
    );
  });

  router.post("/admin/rounds/:roundId/assignments/auto/confirm", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const pairs = input.list("pair").map((p) => {
      const [proposal_id, reviewer_person_id] = p.split(":");
      return { proposal_id, reviewer_person_id, assigned_by: "algorithm" as AssignedBy };
    });
    const report = await confirmAssignments(app, round.id, pairs);
    await app.flush();
    const [rows, pool, lookups, poolProposals] = await Promise.all([
      loadAssignmentRows(app, round),
      loadPoolRows(app, round),
      eventLookups(app, event.id),
      roundScopeProposals(app, round),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Assignments · ${round.name}`, event, active: "review", width: "wide" },
        assignmentsView({ event, round, rows, pool, poolProposals, ...lookups, canWrite: true, report }),
      ),
    );
  });

  router.post("/admin/rounds/:roundId/assignments/bulk", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const filter = filterFromInput(input);
    const reviewerIds = input.list("reviewer_person_ids");
    const mode = (input.str("mode", "spread") || "spread") as "spread" | "one_each";
    const proposed = await proposeBulkAssignment(app, round.id, { filter, reviewer_person_ids: reviewerIds, mode });
    const result = await confirmAssignments(app, round.id, proposed.proposed);
    await app.flush();
    const [rows, pool, lookups, poolProposals] = await Promise.all([
      loadAssignmentRows(app, round),
      loadPoolRows(app, round),
      eventLookups(app, event.id),
      roundScopeProposals(app, round),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Assignments · ${round.name}`, event, active: "review", width: "wide" },
        assignmentsView({
          event,
          round,
          rows,
          pool,
          poolProposals,
          ...lookups,
          canWrite: true,
          report: result,
          unassignable: proposed.unassignable,
        }),
      ),
    );
  });

  /**
   * One proposal, one reviewer. Bulk and auto-distribution cover the volume
   * case, but a chair also just wants to hand *this* abstract to *that*
   * reviewer, and expressing that as a keyword filter that happens to match one
   * row is a trap: a filter that matches two rows assigns two.
   */
  router.post("/admin/rounds/:roundId/assignments/one", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const report = await confirmAssignments(app, round.id, [
      { proposal_id: input.str("proposal_id"), reviewer_person_id: input.str("reviewer_person_id"), assigned_by: "chair" as AssignedBy },
    ]);
    await app.flush();
    const refused = report.refused[0];
    return redirect(
      `/admin/rounds/${round.id}/assignments`,
      303,
      refused ? WARN(`Not assigned — ${refused.message}`) : OK("Assigned."),
    );
  });

  router.post("/admin/rounds/:roundId/assignments/:assignmentId/revoke", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await revokeAssignment(app, params.assignmentId, input.optional("reason"));
    await app.flush();
    return redirect(`/admin/rounds/${round.id}/assignments`, 303, OK("Assignment revoked."));
  });
}

/* ========================================================================== */
/* Progress — /admin/rounds/:roundId/progress                                 */
/* ========================================================================== */

function registerProgressRoutes(router: Router<RequestContext>): void {
  router.get("/admin/rounds/:roundId/progress", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const progress = await progressForRound(app, round.id);
    const people = await personRefs(app, progress.map((p) => p.reviewer_person_id));
    const rows = progress.map((p) => ({ ...p, person: people[p.reviewer_person_id] ?? null }));
    return htmlResponse(
      adminPage(
        ctx,
        {
          title: `Progress · ${round.name}`,
          event,
          active: "review",
          width: "wide",
          // This page's header has claimed to be "Live — recomputed on every
          // assignment and review change" since it was written, and until now
          // that meant "recomputed whenever you reload it". Read-only apart
          // from the reminder checkboxes, which the dirty guard in live.js
          // covers, so it can safely refresh itself.
          live: { mode: "refresh", subjects: ["review", "review_assignment"] },
        },
        progressView({ event, round, rows, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }) }),
      ),
    );
  });

  router.post("/admin/rounds/:roundId/progress/remind", async (req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const reviewerIds = input.list("reviewer_person_id");
    const assignmentRows = await app.db.select<Row>("review_assignment", { round_id: round.id });
    let sent = 0;
    for (const reviewerId of reviewerIds) {
      const outstanding = assignmentRows
        .filter((a) => str(a.reviewer_person_id) === reviewerId && !isTerminalAssignment(str(a.status) as AssignmentStatus))
        .map((a) => str(a.id));
      if (outstanding.length === 0) continue;
      const id = await remindReviewer(app, { round_id: round.id, reviewer_person_id: reviewerId, assignment_ids: outstanding, trigger: "manual" });
      if (id) sent++;
    }
    await app.flush();
    return redirect(`/admin/rounds/${round.id}/progress`, 303, OK(`Reminded ${sent} reviewer${sent === 1 ? "" : "s"}.`));
  });
}

/* ========================================================================== */
/* Results — /admin/rounds/:roundId/results                                   */
/* ========================================================================== */

function registerResultsRoutes(router: Router<RequestContext>): void {
  router.get("/admin/rounds/:roundId/results", async (_req, ctx, params) => {
    const { round, event } = await loadRoundFor(ctx, params.roundId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const filters = resultFiltersFromQuery(ctx.url);
    const view = await roundResults(app, round);
    const filteredRows = applyResultFilters(view.rows, filters);

    if (ctx.url.searchParams.get("format") === "csv") {
      // INV-11-12: an export is a read — honours the requester's pii:read.
      const includeTitle = ctx.includePii({ event_id: event.id });
      const csv = toCsv(filteredRows.map((r) => resultsCsvRow(r, view.criteria, includeTitle)));
      return text(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${round.id}-results.csv"`,
        },
      });
    }

    const { tracks, formats } = await eventLookups(app, event.id);
    return htmlResponse(
      adminPage(
        ctx,
        {
          title: `Results · ${round.name}`,
          event,
          active: "review",
          width: "wide",
          // The chair's working surface while reviews land. Sorting and
          // filtering are query parameters, so a refresh keeps them.
          live: { mode: "refresh", subjects: ["review", "decision", "proposal"] },
        },
        resultsView({ event, round, criteria: view.criteria, rows: filteredRows, filters, tracks, formats }),
      ),
    );
  });
}

/* ========================================================================== */
/* Rubrics — /admin/rubrics                                                   */
/* ========================================================================== */

function registerRubricRoutes(router: Router<RequestContext>): void {
  router.get("/admin/rubrics", async (_req, ctx) => {
    const app = ctx.app();
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    const eventId = ctx.url.searchParams.get("event_id") || (events[0] ? str(events[0].id) : null);
    if (!eventId) {
      return htmlResponse(
        adminPage(ctx, { title: "Rubrics", active: "review" }, rubricsListView({ event: null, rubrics: [], canWrite: false, eventOptions: [] })),
      );
    }
    const event = await loadEvent(ctx, eventId);
    if (!event) throw notFound("Event", eventId);
    ctx.eventId = event.id;
    ctx.requireRead("decision.manage", { event_id: event.id });
    const rubricRows = await app.db.select<Row>("rubric", { event_id: event.id }, { orderBy: "name, version DESC" });
    const { toRubricView } = await import("./scoring.js");
    const rubrics = rubricRows.map(toRubricView);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Rubrics", event, active: "review" },
        rubricsListView({ event, rubrics, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }), eventOptions: events }),
      ),
    );
  });

  router.post("/admin/rubrics", async (req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id") || "";
    if (!eventId) throw validationError("Choose an event first.", [{ field_key: "event_id", message: "Which event is this rubric for?" }]);
    ctx.eventId = eventId;
    ctx.requireWrite("decision.manage", { event_id: eventId });
    const input = await readInput(req);
    const app = ctx.app(eventId);
    const id = await createRubric(app, {
      event_id: eventId,
      name: input.str("name"),
      description: input.optional("description"),
      overall_scale: (input.str("overall_scale", "recommendation") || "recommendation") as OverallScale,
      requires_comment: input.bool("requires_comment"),
      criteria: [
        {
          key: "placeholder",
          label: "Placeholder criterion — edit me",
          type: "numeric",
          scale_min: 1,
          scale_max: 5,
          weight: 1,
          is_required: true,
          allows_na: false,
          sort_order: 0,
        },
      ],
    });
    await app.flush();
    return redirect(`/admin/rubrics/${id}`, 303, OK("Rubric created. Replace the placeholder criterion with the real ones."));
  });

  router.post("/admin/rubrics/sponsor-preset", async (_req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id") || "";
    if (!eventId) throw validationError("Choose an event first.", [{ field_key: "event_id", message: "Which event is this rubric for?" }]);
    ctx.eventId = eventId;
    ctx.requireWrite("decision.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const id = await createSponsorComplianceRubric(app, eventId);
    await app.flush();
    return redirect(`/admin/rubrics/${id}`, 303, OK("Sponsor compliance rubric created."));
  });

  router.get("/admin/rubrics/:rubricId", async (_req, ctx, params) => {
    const app = ctx.app();
    const { rubric, criteria } = await requireRubric(app, params.rubricId);
    ctx.eventId = rubric.event_id;
    ctx.requireRead("decision.manage", { event_id: rubric.event_id });
    const event = await loadEvent(ctx, rubric.event_id);
    if (!event) throw notFound("Event", rubric.event_id);
    const rounds = await app.db.select<Row>("review_round", { rubric_id: rubric.id });
    const locked = rounds.some((r) => str(r.status) !== "draft");
    return htmlResponse(
      adminPage(
        ctx,
        { title: rubric.name, event, active: "review" },
        rubricFormView({ event, rubric, criteria, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }), locked }),
      ),
    );
  });

  router.post("/admin/rubrics/:rubricId", async (req, ctx, params) => {
    const app = ctx.app();
    const { rubric } = await requireRubric(app, params.rubricId);
    ctx.eventId = rubric.event_id;
    ctx.requireWrite("decision.manage", { event_id: rubric.event_id });
    const input = await readInput(req);
    const criteria = parseCriteriaFromInput((name) => input.get(name));
    const result = await updateRubric(app, params.rubricId, {
      name: input.str("name"),
      description: input.optional("description"),
      overall_scale: (input.str("overall_scale", "recommendation") || "recommendation") as OverallScale,
      requires_comment: input.bool("requires_comment"),
      criteria,
    });
    await app.flush();
    return redirect(`/admin/rubrics/${result.rubric_id}`, 303, OK(result.new_version ? "Saved as a new version — a round already using this rubric has started, so scores already given keep the rubric they were given under." : "Rubric saved."));
  });
}

/* ========================================================================== */
/* Decisions — /admin/events/:eventId/decisions                               */
/* ========================================================================== */

function registerDecisionRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/decisions", async (_req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    // Flat in the number of proposals — `decisionQueue` reads the decisions,
    // rounds, reviews and criteria for the whole queue at once rather than
    // per row. It was six statements per proposal.
    const rows = (await decisionQueue(app, event.id, ["submitted", "in_review", "changes_requested", "waitlisted"])).map((r) => ({
      proposal: r.proposal,
      decision: r.decision,
      hasQuorum: r.score ? r.score.has_quorum : false,
      // INV-05-17: an AI review never counts towards quorum, so the queue
      // shows the human count that actually gates the publish.
      reviews: r.score ? { done: r.score.human_review_count, target: r.score.target_reviews_per_proposal } : null,
    }));
    const { tracks, formats } = await eventLookups(app, event.id);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Decisions", event, active: "decisions", width: "wide" },
        decisionsListView({ event, rows, tracks, formats, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }) }),
      ),
    );
  });

  router.post("/admin/events/:eventId/decisions", async (req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const outcome = input.optional("outcome");
    if (outcome) {
      // Moving a proposal between the queues is one click and says only where
      // it moved to. Everything else the decision already carries — a
      // confirmation deadline, a reason for going ahead below quorum — is
      // deliberately absent rather than null, so `recordDecision` keeps it.
      const deadline = input.optional("confirmation_deadline");
      await recordDecision(app, {
        proposal_id: input.str("proposal_id"),
        outcome: outcome as DecisionInput["outcome"],
        ...(deadline ? { confirmation_deadline: fromLocalInput(deadline, event.timezone) } : {}),
      });
      await app.flush();
    }
    return redirect(`/admin/events/${event.id}/decisions`, 303, OK("Moved. Still yours alone until you publish."));
  });

  router.get("/admin/proposals/:proposalId/decision", async (_req, ctx, params) => {
    const { proposal, event } = await loadProposalFor(ctx, params.proposalId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const decisions = await app.db.select<Row>("decision", { proposal_id: str(proposal.id) });
    const decision = decisions.find((d) => str(d.status) !== "superseded") ?? null;
    const roundId = await latestRoundForProposal(app, str(proposal.id));
    const score = roundId ? await proposalScoreFor(app, roundId, str(proposal.id)) : null;
    const { tracks, formats } = await eventLookups(app, event.id);
    return htmlResponse(
      adminPage(
        ctx,
        { title: str(proposal.title), event, active: "decisions" },
        decisionFormView({ event, proposal, decision, tracks, formats, hasQuorum: score ? score.has_quorum : false, canWrite: ctx.canWrite("decision.manage", { event_id: event.id }) }),
      ),
    );
  });

  router.post("/admin/proposals/:proposalId/decision", async (req, ctx, params) => {
    const { proposal, event } = await loadProposalFor(ctx, params.proposalId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await recordDecision(app, { proposal_id: str(proposal.id), ...readDecisionInput(input, event.timezone) });
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}/decision`, 303, OK("Decision recorded — still provisional until published."));
  });

  router.get("/admin/events/:eventId/decisions/publish", async (_req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    let decisionIds = ctx.url.searchParams.getAll("decision_id");
    if (decisionIds.length === 0) {
      const provisional = await app.db.raw<Row>(
        `SELECT d.id FROM decision d JOIN proposal p ON p.id = d.proposal_id WHERE p.event_id = ? AND d.status = 'provisional'`,
        [event.id],
      );
      decisionIds = provisional.map((r) => str(r.id));
    }
    const rows = await previewPublish(app, event.id, decisionIds);
    return htmlResponse(adminPage(ctx, { title: "Publish decisions", event, active: "decisions", width: "wide" }, publishPreviewView({ event, rows })));
  });

  router.post("/admin/events/:eventId/decisions/publish", async (req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const decisionIds = input.list("decision_id");
    const result = await publishDecisions(app, event.id, decisionIds);
    await app.flush();
    return redirect(
      `/admin/events/${event.id}/decisions`,
      303,
      OK(`Published ${result.published.length} decision${result.published.length === 1 ? "" : "s"}.${result.skipped.length ? ` ${result.skipped.length} skipped.` : ""}`),
    );
  });
}

async function latestRoundForProposal(app: AppContext, proposalId: string): Promise<string | null> {
  const assignments = await app.db.select<Row>("review_assignment", { proposal_id: proposalId }, { orderBy: "assigned_at DESC" });
  if (assignments.length > 0) return str(assignments[0].round_id);
  const reviews = await app.db.select<Row>("review", { proposal_id: proposalId }, { orderBy: "created_at DESC" });
  return reviews.length > 0 ? str(reviews[0].round_id) : null;
}

/* ========================================================================== */
/* Committee discussion + COI — /admin/proposals/:proposalId/review           */
/* ========================================================================== */

function registerDiscussionRoutes(router: Router<RequestContext>): void {
  router.get("/admin/proposals/:proposalId/review", async (_req, ctx, params) => {
    const { proposal, event } = await loadProposalFor(ctx, params.proposalId);
    ctx.requireRead("decision.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const canWrite = ctx.canWrite("decision.manage", { event_id: event.id });
    const commentRows = await listComments(app, str(proposal.id), canWrite);
    const people = await personRefs(app, commentRows.map((c) => str(c.author_person_id)));
    const top = commentRows.filter((c) => !c.parent_id);
    const threads: CommentThreadItem[] = top.map((c) => ({
      comment: c,
      author: people[str(c.author_person_id)] ?? null,
      replies: commentRows
        .filter((r) => str(r.parent_id) === str(c.id))
        .map((r) => ({ comment: r, author: people[str(r.author_person_id)] ?? null })),
    }));

    const conflictRows = await loadConflicts(app, event.id);
    const proposalConflicts = conflictRows.filter((c) => c.subject_type === "proposal" && c.subject_id === proposal.id);
    const reviewerPeople = await personRefs(app, proposalConflicts.map((c) => c.reviewer_person_id));
    const conflicts = proposalConflicts.map((c) => ({ ...c, reviewerName: reviewerPeople[c.reviewer_person_id]?.name ?? c.reviewer_person_id }));

    const rounds = await app.db.select<Row>("review_round", { event_id: event.id });

    // What the committee actually wrote. Blind rounds withhold the reviewer's
    // name from committee readers too (05, "Fairness rules made explicit") —
    // the scores and the prose are the chair's to read either way.
    const humanRows = (await app.db.select<Row>("review", { proposal_id: str(proposal.id), author_kind: "human" })).filter(
      (r) => str(r.status) === "submitted",
    );
    const humanReviewers = await personRefs(app, humanRows.map((r) => strOrNull(r.reviewer_person_id)));
    const humanReviews: HumanReviewView[] = [];
    for (const r of humanRows) {
      const round = rounds.find((x) => str(x.id) === str(r.round_id));
      const showName = round ? reviewerIdentityVisible(str(round.anonymity) as RoundAnonymity) : false;
      const criteria = round ? (await requireRubric(app, str(round.rubric_id))).criteria : [];
      const scoreRows = await app.db.select<Row>("criterion_score", { review_id: str(r.id) });
      humanReviews.push({
        id: str(r.id),
        round_name: round ? str(round.name) : "—",
        reviewer_name: showName ? (humanReviewers[str(r.reviewer_person_id)]?.name ?? null) : null,
        overall_score: r.overall_score === null || r.overall_score === undefined ? null : Number(r.overall_score),
        recommendation: strOrNull(r.recommendation),
        confidence: strOrNull(r.confidence),
        flags: parseJson<string[]>(r.flags, []),
        comments_for_committee: strOrNull(r.comments_for_committee),
        comments_for_speaker: strOrNull(r.comments_for_speaker),
        submitted_at: strOrNull(r.submitted_at),
        scores: criteria.map((c) => {
          const s = scoreRows.find((x) => str(x.criterion_id) === c.id);
          const value =
            s === undefined
              ? "—"
              : s.value_number !== null && s.value_number !== undefined
                ? String(num(s.value_number))
                : (strOrNull(s.value_option) ?? strOrNull(s.value_text) ?? (s.value_bool === null || s.value_bool === undefined ? "—" : bool(s.value_bool) ? "Yes" : "No"));
          return { label: c.label, value, weight: c.weight ?? null };
        }),
      });
    }

    // 05, "AI evaluation": the chair's screen shows the machine's opinion
    // labelled, and offers the override on the spot. A superseded one still
    // shows — the disagreement is the point (INV-05-16).
    const aiRows = await app.db.select<Row>("review", { proposal_id: str(proposal.id), author_kind: "ai" });
    const aiReviews: AiReviewView[] = [];
    for (const r of aiRows) {
      const superseded = str(r.status) === "superseded";
      let overrideForm: SafeHtml | null = null;
      if (canWrite && !superseded) {
        const round = rounds.find((x) => str(x.id) === str(r.round_id));
        if (round) {
          const { rubric, criteria } = await requireRubric(app, str(round.rubric_id));
          const scoreRows = await app.db.select<Row>("criterion_score", { review_id: str(r.id) });
          overrideForm = overrideScorecardForm({
            action: `/admin/reviews/${str(r.id)}/override`,
            rubric,
            criteria,
            existing: {
              review: r,
              scores: scoreRows.map((s) => ({
                criterion_id: str(s.criterion_id),
                value_number: s.value_number === null || s.value_number === undefined ? null : num(s.value_number),
                value_option: strOrNull(s.value_option),
                value_text: strOrNull(s.value_text),
                value_bool: s.value_bool === null || s.value_bool === undefined ? null : bool(s.value_bool),
              })),
              naCriterionIds: [],
            },
          });
        }
      }
      aiReviews.push({
        id: str(r.id),
        overall_score: r.overall_score === null || r.overall_score === undefined ? null : Number(r.overall_score),
        recommendation: strOrNull(r.recommendation),
        ai_evaluator_key: str(r.ai_evaluator_key),
        ai_model: strOrNull(r.ai_model),
        ai_rationale: strOrNull(r.ai_rationale),
        superseded,
        overrideForm,
      });
    }

    return htmlResponse(
      adminPage(
        ctx,
        {
          title: str(proposal.title),
          event,
          active: "review",
          width: "wide",
          // Two chairs arguing past each other is exactly what this screen is
          // for. Nudge rather than refresh: there is a reply box on it, and
          // half a comment is not worth losing to a swap.
          live: { mode: "nudge", subjects: ["review_comment", "review", "decision", "conflict_of_interest"] },
        },
        proposalDiscussionView({
          event,
          proposal,
          rounds: rounds.map(toRoundView),
          threads,
          conflicts,
          aiReviews,
          humanReviews,
          canWriteComments: canWrite,
          canDeclareCoi: canWrite,
          canSeeChairsOnly: canWrite,
        }),
      ),
    );
  });

  /**
   * The HTML twin of `POST /v1/reviews/:reviewId/override`. 05 promises the
   * chair can override the machine, and until this existed the promise was
   * only keepable through the API — which is not where chairs work.
   */
  router.post("/admin/reviews/:reviewId/override", async (req, ctx, params) => {
    const app = ctx.app();
    const ai = await app.db.byId<Row>("review", params.reviewId);
    if (!ai) throw notFound("Review", params.reviewId);
    const round = await requireRound(app, str(ai.round_id));
    ctx.eventId = round.event_id;
    ctx.requireWrite("decision.manage", { event_id: round.event_id });
    const { criteria } = await requireRubric(app, round.rubric_id);
    const input = await readInput(req);
    const draft = readReviewDraft(input, criteria);
    await overrideAiReview(app, params.reviewId, { ...draft, assignment_id: null }, input.str("reason"));
    await app.flush();
    return redirect(`/admin/proposals/${str(ai.proposal_id)}/review`, 303, OK("Your review now supersedes the machine's."));
  });

  router.post("/admin/proposals/:proposalId/review/comments", async (req, ctx, params) => {
    const { proposal, event } = await loadProposalFor(ctx, params.proposalId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await addComment(app, {
      proposal_id: str(proposal.id),
      parent_id: input.optional("parent_id"),
      body: input.str("body"),
      visibility: (input.str("visibility", "committee_only") || "committee_only") as CommentVisibility,
    });
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}/review`, 303, OK("Comment posted."));
  });

  router.post("/admin/proposals/:proposalId/review/coi", async (req, ctx, params) => {
    const { proposal, event } = await loadProposalFor(ctx, params.proposalId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const subjectType = (input.str("subject_type", "proposal") || "proposal") as CoiSubjectType;
    await declareConflict(app, {
      event_id: event.id,
      reviewer_person_id: input.str("reviewer_person_id"),
      subject_type: subjectType,
      subject_id: subjectType === "company_domain" ? null : subjectType === "proposal" ? str(proposal.id) : input.optional("subject_id"),
      subject_value: subjectType === "company_domain" ? input.str("subject_value") : null,
      reason: input.str("reason") as CoiReason,
      source: "declared_by_chair",
      note: input.optional("note"),
    });
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}/review`, 303, OK("Conflict declared."));
  });

  router.post("/admin/proposals/:proposalId/review/coi/:coiId/remove", async (req, ctx, params) => {
    const { proposal, event } = await loadProposalFor(ctx, params.proposalId);
    ctx.requireWrite("decision.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await deleteConflict(app, params.coiId, input.str("reason", "Removed from the proposal's discussion screen."));
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}/review`, 303, OK("Conflict removed."));
  });
}

/* ========================================================================== */
/* Management API — /v1                                                       */
/* ========================================================================== */

function registerManagementApi(router: Router<RequestContext>): void {
  router.get("/v1/rounds", async (_req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id");
    if (!eventId) throw validationError("event_id is required.", [{ field_key: "event_id", message: "Which event's rounds?" }]);
    ctx.eventId = eventId;
    ctx.requireRead("review.read", { event_id: eventId });
    const app = ctx.app(eventId);
    const rows = await app.db.select<Row>("review_round", { event_id: eventId }, { orderBy: "sequence" });
    return json({ data: rows.map(toRoundView) });
  });

  router.post("/v1/rounds", async (req, ctx) => {
    const input = await readInput(req);
    const eventId = input.str("event_id");
    ctx.eventId = eventId;
    ctx.requireWrite("decision.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const event = await requireEvent(app, eventId);
    const id = await createRound(app, { event_id: eventId, ...readRoundFields(input, str(event.timezone, "UTC")) });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/rounds/:roundId", async (_req, ctx, params) => {
    const round = await requireRound(ctx.app(), params.roundId);
    ctx.eventId = round.event_id;
    ctx.requireRead("review.read", { event_id: round.event_id });
    return json(round);
  });

  router.get("/v1/assignments", async (_req, ctx) => {
    const roundId = ctx.url.searchParams.get("round_id");
    if (!roundId) throw validationError("round_id is required.", [{ field_key: "round_id", message: "Which round?" }]);
    const app = ctx.app();
    const round = await requireRound(app, roundId);
    ctx.eventId = round.event_id;
    ctx.requireRead("review.read", { event_id: round.event_id });
    const rows = await app.db.select<Row>("review_assignment", { round_id: roundId });
    return json({ data: rows });
  });

  router.post("/v1/assignments", async (req, ctx) => {
    const input = await readInput(req);
    const round = await requireRound(ctx.app(), input.str("round_id"));
    ctx.eventId = round.event_id;
    ctx.requireWrite("decision.manage", { event_id: round.event_id });
    const app = ctx.app(round.event_id);
    const id = await createAssignment(app, {
      round_id: round.id,
      proposal_id: input.str("proposal_id"),
      reviewer_person_id: input.str("reviewer_person_id"),
      assigned_by: (input.str("assigned_by", "chair") || "chair") as AssignedBy,
      due_at: input.optional("due_at"),
    });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/reviews", async (_req, ctx) => {
    const roundId = ctx.url.searchParams.get("round_id");
    const proposalId = ctx.url.searchParams.get("proposal_id");
    if (!roundId && !proposalId) {
      throw validationError("round_id or proposal_id is required.", [{ field_key: "round_id", message: "Filter by a round or a proposal." }]);
    }
    const app = ctx.app();
    const round = roundId ? await requireRound(app, roundId) : null;
    if (round) {
      ctx.eventId = round.event_id;
      ctx.requireRead("review.read", { event_id: round.event_id });
    } else {
      ctx.requireRead("review.read");
    }
    const where: Row = {};
    if (roundId) where.round_id = roundId;
    if (proposalId) where.proposal_id = proposalId;
    const reviews = await loadReviews(app, where);
    const anonymity = round?.anonymity ?? "open";
    return json({
      data: reviews.map((r) => ({
        ...r,
        // 05, "Fairness rules made explicit": reviewer identities are never
        // exposed to submitters, and the management API extends the same rule
        // to any caller unless the round is fully `open`.
        reviewer_person_id: reviewerIdentityVisible(anonymity) ? r.reviewer_person_id : null,
      })),
    });
  });

  router.post("/v1/reviews", async (req, ctx) => {
    // INV-09-27. `requirePerson()` below already refuses a key, but with "Sign
    // in to continue" — which reads like a broken token to a caller holding a
    // perfectly good one, and sends them to check their credentials instead of
    // the rule.
    requirePersonalAuthorship(ctx, "Writing a review");
    const person = ctx.requirePerson();
    const input = await readInput(req);
    const assignmentId = input.str("assignment_id");
    const app = ctx.app();
    const assignment = await requireOwnAssignment(app, person.id, assignmentId);
    const round = await requireRound(app, str(assignment.round_id));
    const { criteria } = await requireRubric(app, round.rubric_id);
    const draft = readReviewDraft(input, criteria);
    const id =
      input.str("intent", "submit") === "submit" ? await submitReview(app, assignmentId, draft) : await saveReviewDraft(app, assignmentId, draft);
    await app.flush();
    return json({ id }, { status: 201 });
  });

  // A chair overriding an AI first-pass review (05, "AI first-pass
  // evaluation": "a human can override it"). Distinct from `POST /v1/reviews`
  // above: that is a reviewer submitting against their own assignment;
  // overriding is a chair action against whichever review the AI wrote,
  // assignment or none, gated on `decision.manage` write rather than
  // assignment ownership.
  router.post("/v1/reviews/:reviewId/override", async (req, ctx, params) => {
    const app = ctx.app();
    const ai = await app.db.byId<Row>("review", params.reviewId);
    if (!ai) throw notFound("Review", params.reviewId);
    const round = await requireRound(app, str(ai.round_id));
    ctx.eventId = round.event_id;
    ctx.requireWrite("decision.manage", { event_id: round.event_id });
    const { criteria } = await requireRubric(app, round.rubric_id);
    const input = await readInput(req);
    const draft = readReviewDraft(input, criteria);
    const id = await overrideAiReview(
      app,
      params.reviewId,
      { ...draft, assignment_id: input.optional("assignment_id") ?? null },
      input.str("reason", "Chair override of the AI first-pass review."),
    );
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/decisions", async (_req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id");
    if (!eventId) throw validationError("event_id is required.", [{ field_key: "event_id", message: "Which event's decisions?" }]);
    ctx.eventId = eventId;
    ctx.requireRead("decision.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const rows = await app.db.raw<Row>(`SELECT d.* FROM decision d JOIN proposal p ON p.id = d.proposal_id WHERE p.event_id = ?`, [eventId]);
    return json({ data: rows });
  });

  router.post("/v1/decisions", async (req, ctx) => {
    const input = await readInput(req);
    const proposalId = input.str("proposal_id");
    const app = ctx.app();
    const proposal = await app.db.byId<Row>("proposal", proposalId);
    if (!proposal) throw notFound("Proposal", proposalId);
    ctx.eventId = str(proposal.event_id);
    ctx.requireWrite("decision.manage", { event_id: str(proposal.event_id) });
    const event = await requireEvent(app, str(proposal.event_id));
    const id = await recordDecision(app, { proposal_id: proposalId, ...readDecisionInput(input, str(event.timezone, "UTC")) });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/proposals/:proposalId/score", async (_req, ctx, params) => {
    const app = ctx.app();
    const proposal = await app.db.byId<Row>("proposal", params.proposalId);
    if (!proposal) throw notFound("Proposal", params.proposalId);
    ctx.eventId = str(proposal.event_id);
    ctx.requireRead("review.read", { event_id: str(proposal.event_id) });
    const roundId = ctx.url.searchParams.get("round_id") ?? (await latestRoundForProposal(app, str(proposal.id)));
    if (!roundId) return json({ proposal_id: str(proposal.id), score: null });
    const score = await proposalScoreFor(app, roundId, str(proposal.id));
    return json({ proposal_id: str(proposal.id), round_id: roundId, score });
  });
}
