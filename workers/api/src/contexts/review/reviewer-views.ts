/**
 * Review & Selection — the reviewer surface. "A dashboard of its own, not
 * buried in admin" (implementer brief). Pure rendering: routes load the data,
 * these functions turn it into `SafeHtml`.
 */

import { str, strOrNull, type Row } from "@podiumstack/data/db.js";
import type { ReviewableProjection } from "@podiumstack/domain/review/anonymity.js";
import type { ReviewerProgress } from "@podiumstack/domain/review/scoring.js";
import { formatInZone, relativeDays } from "@podiumstack/domain/shared/time.js";
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
import type { ProposalScore } from "@podiumstack/domain/review/scoring.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { badge, card, empty, field, humanise, pageHead, progressBar } from "../../ui/layout.js";
import { plural, spell, Spell } from "../../ui/words.js";
import type { ReviewerAssignmentRow, ReviewerRound } from "./reviewer-model.js";
import { opts } from "./views.js";

/* ========================================================================== */
/* GET /review — my assignments                                               */
/* ========================================================================== */

export interface ReviewerQueueData {
  rows: ReviewerAssignmentRow[];
  progressByRound: Record<string, ReviewerProgress>;
  rounds: ReviewerRound[];
  /** Declared conflicts, counted — never listed, because the subject is a person. */
  conflicts: number;
  /** `queue` · `submitted` · `declined` — which of the three the rail is on. */
  show: ReviewerQueueFilter;
  now: string;
}

export type ReviewerQueueFilter = "queue" | "submitted" | "declined";

const ASSIGNMENT_ACTIONABLE: AssignmentStatus[] = ["assigned", "accepted", "in_progress"];

function isOverdue(r: ReviewerAssignmentRow, now: string): boolean {
  const due = strOrNull(r.assignment.due_at);
  return !!due && due < now && ASSIGNMENT_ACTIONABLE.includes(str(r.assignment.status) as AssignmentStatus);
}

function isOutstanding(r: ReviewerAssignmentRow): boolean {
  return ASSIGNMENT_ACTIONABLE.includes(str(r.assignment.status) as AssignmentStatus);
}

/** Splits the reviewer's assignments the three ways the rail navigates them. */
export function partitionQueue(rows: ReviewerAssignmentRow[]): Record<ReviewerQueueFilter, ReviewerAssignmentRow[]> {
  return {
    queue: rows.filter(isOutstanding),
    submitted: rows.filter((r) => str(r.assignment.status) === "submitted"),
    declined: rows.filter((r) => !isOutstanding(r) && str(r.assignment.status) !== "submitted"),
  };
}

/**
 * `/review` — the reviewer's queue.
 *
 * The screen a committee member opens twenty times during a round, so it is
 * built around the one question they are actually asking: *what do I still owe,
 * and which one is next.*
 *
 * It is one list, not a grid of cards. A card per proposal was eleven boxes of
 * identical shape, and the only thing that varies between two assignments — how
 * late each one is — was the smallest thing on each card. Here the due date is
 * the first column, in mono so eleven of them can be compared by running an eye
 * down the left edge, and it is the only thing that carries colour.
 *
 * Submitted and declined work has moved out of the page entirely and into the
 * rail (`?show=`). A queue that shows finished work alongside unfinished work
 * makes the reader do the filtering.
 */
export function reviewerDashboardView(d: ReviewerQueueData): SafeHtml {
  const parts = partitionQueue(d.rows);
  const shown = parts[d.show];
  const outstanding = parts.queue;
  const overdue = outstanding.filter((r) => isOverdue(r, d.now));
  const next = outstanding[0] ?? null;

  if (d.rows.length === 0) {
    return html`${pageHead("Nothing is assigned to you", "When a chair adds you to a round and assigns you proposals, they arrive here.")}
      ${card(
        html`<p class="muted">
          There is nothing to do in the meantime. You will be emailed when a round opens, and the queue will be waiting for you when you
          follow the link.
        </p>`,
      )}`;
  }

  const totals = Object.values(d.progressByRound).reduce(
    (acc, p) => ({ assigned: acc.assigned + p.assigned, submitted: acc.submitted + p.submitted }),
    { assigned: 0, submitted: 0 },
  );
  const pct = totals.assigned ? Math.round((totals.submitted / totals.assigned) * 100) : 0;

  return html`
    <div class="grid queue-aside">
      <div class="stack">
        ${pageHead(
          queueTitle(d.show, shown.length, overdue.length),
          queueLede(d),
          d.show === "queue" && next
            ? html`<a class="btn" href="/review/${str(next.assignment.id)}">Review the next one</a>`
            : raw(""),
        )}
        ${shown.length === 0
          ? empty(EMPTY_FOR[d.show])
          : html`<section class="card rows" data-keylist>${shown.map((r) => queueRow(r, d.now))}</section>`}
        ${d.show === "queue" ? html`<p class="small muted">${queueFooter(parts)}</p>` : raw("")}
      </div>

      <div class="stack sticky-aside">
        ${card(html`<p class="eyebrow">Your progress</p>
          <p class="big-figure">${totals.submitted}<span class="of">/${totals.assigned}</span></p>
          ${progressBar(pct)}
          <p class="small muted" style="margin:10px 0 0">${paceSentence(d, outstanding.length)}</p>`)}
        ${card(html`<p class="eyebrow">Conflicts</p>
          <p class="small muted" style="margin:0">${conflictSentence(d.conflicts)}</p>`)}
      </div>
    </div>
  `;
}

const EMPTY_FOR: Record<ReviewerQueueFilter, string> = {
  queue: "Everything assigned to you is done.",
  submitted: "You have not submitted a review in this round yet.",
  declined: "You have not declined anything.",
};

/**
 * "Nine left, three of them late" — the state of the queue, as a sentence, in
 * the heading. A heading that says "My reviews" is a heading that has spent the
 * largest type on the page saying which page you are on, which you knew.
 */
function queueTitle(show: ReviewerQueueFilter, count: number, late: number): string {
  if (show === "submitted") return `${Spell(count)} submitted`;
  if (show === "declined") return `${Spell(count)} declined`;
  if (count === 0) return "You are done";
  if (late === 0) return `${Spell(count)} left`;
  return `${Spell(count)} left, ${spell(late)} of them late`;
}

/**
 * What the reviewer will and will not be shown, said before they ask. Anonymity
 * is a property of the round (R10), so a reviewer sitting in two rounds with
 * different settings is told the strictest one applies somewhere.
 */
function queueLede(d: ReviewerQueueData): string {
  const kinds = new Set(d.rounds.map((r) => r.anonymity));
  if (kinds.has("double_blind")) {
    return kinds.size > 1
      ? "One of your rounds is double-blind: there you will not see names, affiliations or links."
      : "Blind review. You will not see names, affiliations or links.";
  }
  if (kinds.has("single_blind")) return "Single-blind review. You see the speaker; they do not see you.";
  return "Open review. Names and affiliations are shown, and yours is shown to the committee.";
}

function queueFooter(parts: Record<ReviewerQueueFilter, ReviewerAssignmentRow[]>): string {
  const done = parts.submitted.length;
  if (done === 0) return "Nothing submitted yet.";
  return `Plus ${spell(done)} you have already submitted.`;
}

/**
 * "At two a day you finish four days before the round closes."
 *
 * Two a day is an assumption and is stated as one. The rest is arithmetic
 * against the round's own close date, which is the number a reviewer is
 * actually budgeting against — a percentage complete never told anyone whether
 * they were going to make it.
 */
function paceSentence(d: ReviewerQueueData, remaining: number): string {
  if (remaining === 0) return "Nothing outstanding. Thank you.";
  const closes = d.rounds.map((r) => r.closes_at).filter((c): c is string => Boolean(c)).sort()[0];
  if (!closes) return `${plural(remaining, "proposal")} still to score. This round has no closing date.`;
  const daysLeft = Math.round((Date.parse(closes) - Date.parse(d.now)) / 86_400_000);
  const daysNeeded = Math.ceil(remaining / 2);
  const slack = daysLeft - daysNeeded;
  if (daysLeft < 0) return `The round closed ${plural(Math.abs(daysLeft), "day")} ago and ${plural(remaining, "proposal")} are still open.`;
  if (slack > 0) return `At two a day you finish ${plural(slack, "day")} before the round closes.`;
  if (slack === 0) return "At two a day you finish on the day the round closes.";
  return `At two a day you would miss the close by ${plural(Math.abs(slack), "day")}.`;
}

/**
 * Counted, never listed. A conflict's subject is a person or an employer, and
 * naming which proposals were withheld would leak exactly what withholding them
 * was for (INV-05-18).
 */
function conflictSentence(n: number): string {
  if (n === 0) return "You have no declared conflicts, so nothing has been withheld from your queue.";
  if (n === 1) return "One conflict is on file for you. Proposals it touches are withheld from your queue rather than shown and refused.";
  return `${Spell(n)} conflicts are on file for you. Proposals they touch are withheld from your queue rather than shown and refused.`;
}

/**
 * One assignment. The columns are, in order: how late it is, what it is, and the
 * one verb that moves it.
 */
function queueRow(r: ReviewerAssignmentRow, now: string): SafeHtml {
  const status = str(r.assignment.status) as AssignmentStatus;
  const actionable = ASSIGNMENT_ACTIONABLE.includes(status);
  const due = strOrNull(r.assignment.due_at);
  const overdue = isOverdue(r, now);
  const href = `/review/${str(r.assignment.id)}`;

  // "4 days late" / "due in 2 days" — a queue is read as distance to a
  // deadline, and a reviewer holding eleven of them is comparing them to each
  // other rather than to the calendar.
  //
  // Work that is finished says when it was finished instead. A due date on a
  // submitted review is a deadline that no longer applies, sitting in the
  // column the eye goes to first.
  const done = strOrNull(r.assignment.submitted_at);
  const days = due ? Math.round((Date.parse(due) - Date.parse(now)) / 86_400_000) : null;
  const when =
    status === "submitted"
      ? done
        ? `sent ${relativeDays(done, now)}`
        : "submitted"
      : due
        ? overdue
          ? `${plural(Math.abs(days ?? 0), "day")} late`
          : `due ${relativeDays(due, now)}`
        : "no deadline";
  const whenClass =
    status === "submitted" ? "none" : overdue ? "late" : days !== null && days <= 3 ? "soon" : due ? "" : "none";

  // `in_progress` is a scorecard with a draft on it — the one row where the
  // verb is "finish" rather than "start", so it is the one row that says so.
  const hasDraft = status === "in_progress";

  return html`<div class="queue-row ${overdue ? "late" : ""}" data-keyrow data-href="${href}">
    <span class="due ${whenClass}">${when}</span>
    <div class="body">
      <p class="title"><a href="${href}">${r.proposal ? str(r.proposal.title) : "(proposal unavailable)"}</a></p>
      <p class="meta">${[r.proposal ? str(r.proposal.reference) : str(r.assignment.proposal_id), ...r.meta].join(" · ")}</p>
    </div>
    ${hasDraft ? html`<span class="chip">draft saved</span>` : raw("")}
    <a class="btn small ${hasDraft || !actionable ? (actionable ? "" : "secondary") : "secondary"}" href="${href}"
      >${status === "submitted" ? "View" : hasDraft ? "Finish" : actionable ? "Score" : "Open"}</a
    >
  </div>`;
}

/* ========================================================================== */
/* GET /review/:assignmentId — the scorecard                                  */
/* ========================================================================== */

export interface ExistingReviewState {
  review: Row | null;
  scores: ScoreView[];
  naCriterionIds: string[];
}

/** Where this assignment sits in the reviewer's outstanding queue. */
export interface QueuePosition {
  index: number;
  total: number;
  previous: string | null;
  next: string | null;
}

export function reviewerAssignmentView(d: {
  assignment: Row;
  roundName: string;
  anonymity: string;
  proposal: ReviewableProjection;
  rubric: RubricView;
  criteria: CriterionView[];
  existing: ExistingReviewState;
  canSeeOthers: boolean;
  otherReviews: ReviewView[];
  aggregate: ProposalScore | null;
  comments: Row[];
  discussionEnabled: boolean;
  position: QueuePosition | null;
  now: string;
}): SafeHtml {
  const status = str(d.assignment.status) as AssignmentStatus;
  const declinable = ["assigned", "accepted", "in_progress"].includes(status);
  const submittable = status !== "declined" && status !== "revoked" && status !== "expired";
  const due = strOrNull(d.assignment.due_at);
  const overdue = !!due && due < d.now && declinable;

  // `.review-split` is two columns on a wide screen: the proposal on the left,
  // the scorecard on the right and sticky. Scoring means reading an abstract
  // and answering a rubric at the same time, and stacked they were a screen
  // apart — every criterion cost a scroll up and a scroll back. Below the `lg`
  // breakpoint they stack, in that order, which is the order the job is done in.
  return html`
    ${queueBar(d.position)}
    ${pageHead(
      d.proposal.title,
      `${d.proposal.reference} · ${d.roundName} · ${humanise(d.anonymity)}`,
      html`${badge(status)}
        ${due
          ? html`<span class="${overdue ? "urgency-err" : "muted small"}">${overdue ? "overdue — was due " : "due "}${relativeDays(due, d.now)}</span>`
          : raw("")}`,
    )}
    ${d.proposal.blinded
      ? html`<p class="notice info">This round is double-blind: speaker names, bios, affiliations, links and any answer flagged personal are hidden from you.</p>`
      : raw("")}
    <div class="review-split">
      <div class="review-reading">
        ${card(proposalBody(d.proposal), "The proposal")}
        ${d.canSeeOthers ? otherReviewsCard(d) : lockedCard()}
        ${d.discussionEnabled && d.canSeeOthers ? discussionCard(d) : raw("")}
        ${declinable ? declineForm(d.assignment) : raw("")}
      </div>
      <div class="review-scoring">
        ${submittable ? card(scorecardForm(d), "Scorecard") : raw("")}
      </div>
    </div>
  `;
}

/**
 * "4 of 17", with the way back and the way on. A reviewer working a round is
 * doing one thing seventeen times, and the screen should say where they are in
 * it rather than looking identical on the first and the last.
 */
function queueBar(position: QueuePosition | null): SafeHtml {
  if (!position) return html`<p class="review-queuebar"><a href="/review">← All my reviews</a></p>`;
  return html`<p class="review-queuebar">
    <a href="/review">← All my reviews</a>
    <span class="muted">${position.index + 1} of ${position.total} outstanding</span>
    <span class="spacer"></span>
    ${position.previous ? html`<a class="btn secondary small" href="/review/${position.previous}">Previous</a>` : raw("")}
    ${position.next ? html`<a class="btn secondary small" href="/review/${position.next}">Skip to next</a>` : raw("")}
  </p>`;
}

function proposalBody(p: ReviewableProjection): SafeHtml {
  return html`
    <p>${p.abstract}</p>
    ${p.description ? html`<div class="small">${p.description}</div>` : raw("")}
    <dl class="kv">
      ${p.audience_level ? html`<dt>Audience level</dt><dd>${humanise(p.audience_level)}</dd>` : raw("")}
      ${p.requested_duration_minutes ? html`<dt>Requested duration</dt><dd>${p.requested_duration_minutes} minutes</dd>` : raw("")}
      ${p.keywords.length ? html`<dt>Keywords</dt><dd>${p.keywords.join(", ")}</dd>` : raw("")}
      ${p.sponsor_name ? html`<dt>Sponsor</dt><dd>${p.sponsor_name}</dd>` : raw("")}
      ${p.coi_disclosure ? html`<dt>Disclosed conflicts</dt><dd>${p.coi_disclosure}</dd>` : raw("")}
    </dl>
    ${p.answers.length
      ? html`<dl class="kv">
          ${p.answers.map((a) => html`<dt>${a.label}</dt><dd>${a.display ?? html`<span class="muted">Not answered</span>`}</dd>`)}
        </dl>`
      : raw("")}
    ${p.speakers.length
      ? html`<h3>Speakers</h3>
          ${p.speakers.map(
            (s) => html`<div class="speaker-card">
              <strong>${s.full_name}</strong>${s.headline ? html` — ${s.headline}` : raw("")}${s.company ? html` · ${s.company}` : raw("")}
              ${s.bio ? html`<p class="small">${s.bio}</p>` : raw("")}
              ${s.links.length ? html`<p class="small">${s.links.map((l) => html`<a href="${l}" rel="noopener">${l}</a> `)}</p>` : raw("")}
            </div>`,
          )}`
      : raw("")}
  `;
}

function scoreValue(existing: ExistingReviewState, criterionId: string): ScoreView | undefined {
  return existing.scores.find((s) => s.criterion_id === criterionId);
}

function criterionField(c: CriterionView, existing: ExistingReviewState): SafeHtml {
  const score = scoreValue(existing, c.id);
  const isNa = existing.naCriterionIds.includes(c.id);
  const naBox = c.allows_na
    ? field({ name: `na_${c.id}`, id: `na_${c.id}`, label: `Not applicable — can't judge this`, type: "checkbox", value: isNa })
    : raw("");

  let control: SafeHtml;
  switch (c.type) {
    case "numeric":
      control = field({
        name: `score_number_${c.id}`,
        id: `crit_${c.id}`,
        label: c.label,
        type: "number",
        required: c.is_required && !c.allows_na,
        min: c.scale_min ?? undefined,
        max: c.scale_max ?? undefined,
        value: score?.value_number ?? "",
        help: c.description,
      });
      break;
    case "select":
      control = field({
        name: `score_option_${c.id}`,
        id: `crit_${c.id}`,
        label: c.label,
        type: "radio",
        value: score?.value_option ?? "",
        help: c.description,
        options: c.options.map((o) => ({ value: o.value, label: o.label, description: o.description })),
      });
      break;
    case "boolean":
      // A plain checkbox cannot distinguish "unanswered" from "false" — a
      // radio makes both states explicit, which INV-05-5 needs to tell apart.
      control = field({
        name: `score_bool_${c.id}`,
        id: `crit_${c.id}`,
        label: c.label,
        type: "radio",
        value: score?.value_bool === undefined || score?.value_bool === null ? "" : String(score.value_bool),
        help: c.description,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      });
      break;
    case "text":
      control = field({
        name: `score_text_${c.id}`,
        id: `crit_${c.id}`,
        label: c.label,
        type: "textarea",
        rows: 3,
        required: c.is_required && !c.allows_na,
        value: score?.value_text ?? "",
        help: c.description,
        attrs: c.max_length ? `maxlength="${c.max_length}"` : undefined,
      });
      break;
  }
  return html`<div class="criterion">${control}${naBox}</div>`;
}

/**
 * 05, "AI evaluation": "A human can override it." An override is a full human
 * review against the same rubric and the same validation (INV-05-5), not a
 * rubber stamp — so it reuses the reviewer's own scorecard fields, prefilled
 * with what the machine said, and demands a written reason.
 */
export function overrideScorecardForm(d: {
  action: string;
  rubric: RubricView;
  criteria: CriterionView[];
  existing: ExistingReviewState;
}): SafeHtml {
  const review = d.existing.review;
  return html`<details class="disclosure">
    <summary>Override with my own review</summary>
    <form method="post" action="${d.action}" class="stack">
      ${d.criteria.map((c) => criterionField(c, d.existing))}
      ${d.rubric.overall_scale === "recommendation"
        ? field({ name: "recommendation", label: "Overall recommendation", type: "select", required: true, value: review ? str(review.recommendation) : "", options: opts(RECOMMENDATION) })
        : raw("")}
      ${field({ name: "confidence", label: "Confidence", type: "select", value: review ? str(review.confidence) : "", options: opts(CONFIDENCE) })}
      ${field({ name: "comments_for_committee", label: "Comments for the committee", type: "textarea", rows: 3, help: "Never visible to the submitter." })}
      ${field({ name: "reason", label: "Why you are overriding it", required: true, help: "Recorded on the audit trail. The AI review is superseded, never deleted." })}
      <button type="submit">Override with my review</button>
    </form>
  </details>`;
}

function scorecardForm(d: {
  assignment: Row;
  rubric: RubricView;
  criteria: CriterionView[];
  existing: ExistingReviewState;
  position?: QueuePosition | null;
}): SafeHtml {
  const review = d.existing.review;
  const savedAt = review && str(review.status) === "draft" ? strOrNull(review.updated_at) : null;
  const hasNext = Boolean(d.position && d.position.next);
  return html`${savedAt
      ? html`<p class="small muted">Draft saved ${formatInZone(savedAt, "UTC")} UTC. Nothing here is visible to anyone else until you submit.</p>`
      : raw("")}
    <form method="post" action="/review/${str(d.assignment.id)}" class="stack">
    ${d.criteria.map((c) => criterionField(c, d.existing))}
    ${d.rubric.overall_scale === "recommendation"
      ? field({ name: "recommendation", label: "Overall recommendation", type: "select", required: true, value: review ? str(review.recommendation) : "", options: opts(RECOMMENDATION) })
      : raw("")}
    ${field({ name: "confidence", label: "Confidence", type: "select", value: review ? str(review.confidence) : "", options: opts(CONFIDENCE) })}
    ${field({ name: "flags", label: "Flags", type: "multi_select", options: opts(REVIEW_FLAG), value: review ? JSON.parse(str(review.flags, "[]") || "[]") : [] })}
    ${field({ name: "comments_for_committee", label: "Comments for the committee", type: "textarea", rows: 4, value: review ? str(review.comments_for_committee) : "", help: "Never visible to the submitter." })}
    ${field({ name: "comments_for_speaker", label: "Comments for the speaker", type: "textarea", rows: 4, value: review ? str(review.comments_for_speaker) : "", help: "Released only if a decision using this feedback is published." })}
    ${d.rubric.requires_comment ? html`<p class="small muted">This rubric requires at least one written comment.</p>` : raw("")}
    <div class="actions">
      <button type="submit" name="intent" value="save" class="secondary">Save draft</button>
      <button type="submit" name="intent" value="submit">
        ${hasNext ? "Submit and open the next" : "Submit review"}
      </button>
    </div>
  </form>`;
}

function declineForm(assignment: Row): SafeHtml {
  return card(
    html`<form method="post" action="/review/${str(assignment.id)}/decline" class="inline-grid">
      ${field({ name: "reason", label: "Reason", type: "select", required: true, options: opts(DECLINE_REASON) })}
      ${field({ name: "note", label: "Note" })}
      <button type="submit" class="secondary">Decline this assignment</button>
    </form>
    <p class="small muted">Declining for a conflict of interest records it, so you are never asked again (05).</p>`,
    "Can't review this one?",
  );
}

function lockedCard(): SafeHtml {
  return card(
    html`<p class="notice info">
      Other reviews, the aggregate and the discussion open once your own review is submitted or you decline. Anchoring is real —
      this is deliberate, not a bug.
    </p>`,
  );
}

function otherReviewsCard(d: { otherReviews: ReviewView[]; aggregate: ProposalScore | null }): SafeHtml {
  const human = d.otherReviews.filter((r) => r.author_kind === "human");
  const ai = d.otherReviews.filter((r) => r.author_kind === "ai");
  return card(
    html`${d.aggregate
        ? html`<dl class="kv">
            <dt>Mean</dt><dd>${d.aggregate.mean ?? "—"}</dd>
            <dt>Median</dt><dd>${d.aggregate.median ?? "—"}</dd>
            <dt>Reviews</dt><dd>${d.aggregate.human_review_count} human${d.aggregate.ai_review_count ? html`, ${d.aggregate.ai_review_count} AI` : raw("")}</dd>
            <dt>Quorum</dt><dd>${d.aggregate.has_quorum ? badge("met", "ok") : badge("short", "warn")}</dd>
          </dl>`
        : raw("")}
      ${human.length === 0 ? empty("No other human reviews yet.") : human.map((r) => reviewSummary(r))}
      ${ai.map((r) => reviewSummary(r))}`,
    "Other reviews",
  );
}

function reviewSummary(r: ReviewView): SafeHtml {
  return html`<div class="review-summary">
    <p class="small">
      ${r.author_kind === "ai" ? badge("AI", "ai") : raw("")}
      ${r.recommendation ? badge(r.recommendation) : raw("")}
      ${r.confidence ? html`<span class="muted small">confidence: ${r.confidence}</span>` : raw("")}
    </p>
    ${r.author_kind === "ai" && r.ai_rationale ? html`<p class="small">${r.ai_rationale}</p>` : raw("")}
    ${r.comments_for_committee ? html`<p class="small">${r.comments_for_committee}</p>` : raw("")}
  </div>`;
}

function discussionCard(d: { comments: Row[] }): SafeHtml {
  return card(
    d.comments.length === 0
      ? empty("No discussion yet.")
      : html`<ul class="notes">${d.comments.map((c) => html`<li><div class="small muted">${badge(str(c.visibility))}</div><div>${str(c.body)}</div></li>`)}</ul>`,
    "Discussion",
  );
}
