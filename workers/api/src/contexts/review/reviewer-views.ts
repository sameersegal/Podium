/**
 * Review & Selection — the reviewer surface. "A dashboard of its own, not
 * buried in admin" (implementer brief). Pure rendering: routes load the data,
 * these functions turn it into `SafeHtml`.
 */

import { str, type Row } from "@podiumconf/data/db.js";
import type { ReviewableProjection } from "@podiumconf/domain/review/anonymity.js";
import type { ReviewerProgress } from "@podiumconf/domain/review/scoring.js";
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
} from "@podiumconf/domain/review/types.js";
import type { ProposalScore } from "@podiumconf/domain/review/scoring.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { badge, card, empty, field, humanise, pageHead, progressBar } from "../../ui/layout.js";
import { opts } from "./views.js";

/* ========================================================================== */
/* GET /review — my assignments                                               */
/* ========================================================================== */

export interface ReviewerAssignmentRow {
  assignment: Row;
  round_name: string;
  proposal: { reference: string; title: string } | null;
}

export function reviewerDashboardView(d: { rows: ReviewerAssignmentRow[]; progressByRound: Record<string, ReviewerProgress> }): SafeHtml {
  if (d.rows.length === 0) {
    return html`
      ${pageHead("My reviews", "Proposals assigned to you across every round you are part of.")}
      ${card(
        html`<p>You have no review assignments right now.</p>
          <p class="small muted">
            When a chair adds you to a round's reviewer pool and assigns you proposals, they will show up here — one card per proposal,
            with a due date and a big "Score this proposal" button. Nothing to do in the meantime.
          </p>`,
        "Nothing assigned yet",
      )}
    `;
  }

  const byRound = new Map<string, ReviewerAssignmentRow[]>();
  for (const r of d.rows) {
    const key = str(r.assignment.round_id);
    const list = byRound.get(key) ?? [];
    list.push(r);
    byRound.set(key, list);
  }

  const sections = [...byRound.entries()].map(([roundId, rows]) => {
    const progress = d.progressByRound[roundId];
    const cards = rows.map((r) => assignmentCard(r));
    return html`
      <h2>${rows[0].round_name}</h2>
      ${progress
        ? html`<div class="progress-row">${progressBar(progress.completion_pct)}<span class="small muted">${progress.submitted} of ${progress.assigned} done${progress.overdue ? html` · <span class="badge err">${progress.overdue} overdue</span>` : raw("")}</span></div>`
        : raw("")}
      <div class="grid two">${cards}</div>
    `;
  });

  return html`
    ${pageHead("My reviews", "Proposals assigned to you across every round you are part of.")}
    ${sections}
  `;
}

const ASSIGNMENT_ACTIONABLE: AssignmentStatus[] = ["assigned", "accepted", "in_progress"];

function assignmentCard(r: ReviewerAssignmentRow): SafeHtml {
  const status = str(r.assignment.status) as AssignmentStatus;
  const actionable = ASSIGNMENT_ACTIONABLE.includes(status);
  return card(
    html`<p class="mono small muted">${r.proposal ? str(r.proposal.reference) : str(r.assignment.proposal_id)}</p>
      <h3>${r.proposal ? str(r.proposal.title) : "(proposal unavailable)"}</h3>
      <p class="small">${badge(status)} ${str(r.assignment.due_at) ? html`· due ${str(r.assignment.due_at).slice(0, 10)}` : raw("")}</p>
      <p><a class="button" href="/review/${str(r.assignment.id)}">${status === "submitted" ? "View my review" : actionable ? "Score this proposal" : "Open"}</a></p>`,
  );
}

/* ========================================================================== */
/* GET /review/:assignmentId — the scorecard                                  */
/* ========================================================================== */

export interface ExistingReviewState {
  review: Row | null;
  scores: ScoreView[];
  naCriterionIds: string[];
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
}): SafeHtml {
  const status = str(d.assignment.status) as AssignmentStatus;
  const declinable = ["assigned", "accepted", "in_progress"].includes(status);
  const submittable = status !== "declined" && status !== "revoked" && status !== "expired";

  return html`
    ${pageHead(
      d.proposal.title,
      `${d.proposal.reference} · ${d.roundName} · ${humanise(d.anonymity)}`,
      badge(status),
    )}
    ${d.proposal.blinded
      ? html`<p class="notice info">This round is double-blind: speaker names, bios, affiliations, links and any answer flagged personal are hidden from you.</p>`
      : raw("")}
    ${card(proposalBody(d.proposal), "The proposal")}
    ${submittable ? card(scorecardForm(d), "Scorecard") : raw("")}
    ${declinable ? declineForm(d.assignment) : raw("")}
    ${d.canSeeOthers ? otherReviewsCard(d) : lockedCard()}
    ${d.discussionEnabled && d.canSeeOthers ? discussionCard(d) : raw("")}
  `;
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
      ? html`<dl class="kv">${p.answers.map((a) => html`<dt>${a.label}</dt><dd>${typeof a.value === "string" ? a.value : JSON.stringify(a.value)}</dd>`)}</dl>`
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
}): SafeHtml {
  const review = d.existing.review;
  return html`<form method="post" action="/review/${str(d.assignment.id)}" class="stack">
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
      <button type="submit" name="intent" value="submit">Submit review</button>
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
