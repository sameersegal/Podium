/**
 * Review & Selection — what is left of the server-rendered reviewer surface.
 *
 * This file used to render the reviewer's whole surface: the queue at `/review`
 * and the scorecard at `/review/:assignmentId`. Both are the console's now, and
 * R30's second amendment deleted the pages that answered `?nojs=1` behind them,
 * so those renderers went with them — `contexts/review/reviewer-model.ts` still
 * loads the same data, and `GET /v1/me/assignments[/:id]` is the only thing that
 * serves it.
 *
 * What remains is `overrideScorecardForm`: the **chair's** override of an AI
 * first-pass review, which is a different surface (`/admin/…`), is still
 * server-rendered, and shares this file only because it draws the same rubric
 * criteria with the same helpers.
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
/* Shared rubric rendering, used by the chair's override form below           */
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
