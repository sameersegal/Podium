/**
 * Review & Selection — the chair and admin surfaces (05-review-and-selection.md).
 *
 * Pure rendering. Every function here takes data the routes already loaded
 * and returns `SafeHtml`; nothing in this file touches `AppContext`.
 */

import { str, type Row } from "@podiumstack/data/db.js";
import type { PoolMemberView } from "./service.js";
import type { DistributionResult, UnassignableProposal } from "@podiumstack/domain/review/assignment.js";
import type { ConflictRecord } from "@podiumstack/domain/review/coi.js";
import type { ReviewerProgress } from "@podiumstack/domain/review/scoring.js";
import {
  COI_REASON,
  COI_SUBJECT_TYPE,
  COMMENT_VISIBILITY,
  CONFIDENCE,
  CRITERION_TYPE,
  DECISION_OUTCOME,
  OVERALL_SCALE,
  POOL_ROLE,
  RECOMMENDATION,
  ROUND_ANONYMITY,
  type CriterionType,
  type CriterionView,
  type PoolRole,
  type RoundAnonymity,
  type RoundStatus,
  type RubricView,
} from "@podiumstack/domain/review/types.js";
import type { ResultFilters, ResultRow, RoundView } from "./scoring.js";
import type { PublishPreviewRow } from "./service.js";
import { calendarDateInZone, formatTimeInZone } from "@podiumstack/domain/shared/time.js";
import { versionField } from "../../http/concurrency.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, progressBar, stat, submitButton, table } from "../../ui/layout.js";
import type { EventRef } from "../../ui/shell.js";

export interface PersonRef {
  id: string;
  name: string;
  email: string;
}

export function opts(values: readonly string[]): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: humanise(v) }));
}

function personLink(p: PersonRef | undefined | null, id: string): SafeHtml {
  if (!p) return html`<span class="mono small muted">${id}</span>`;
  return html`<a href="/admin/people/${p.id}">${p.name}</a>`;
}

/* ========================================================================== */
/* /admin/events/:eventId/review — rounds overview                            */
/* ========================================================================== */

export interface RoundSummary {
  round: RoundView;
  rubricName: string;
  poolSize: number;
  assignmentCount: number;
  submittedCount: number;
  proposalCount: number;
}

export function roundsOverviewView(d: { event: EventRef; rounds: RoundSummary[]; canWrite: boolean }): SafeHtml {
  const rows = d.rounds.map(
    (s) => html`<tr>
      <td><a href="/admin/rounds/${s.round.id}"><strong>${s.round.name}</strong></a><br><span class="small muted">${humanise(s.round.anonymity)}</span></td>
      <td>${badge(s.round.status)}</td>
      <td class="small">${calendarDateInZone(s.round.opens_at, d.event.timezone)} → ${calendarDateInZone(s.round.closes_at, d.event.timezone)}</td>
      <td>${s.rubricName}</td>
      <td>${s.proposalCount}</td>
      <td>${s.poolSize}</td>
      <td>${s.submittedCount} / ${s.assignmentCount}</td>
      <td class="right"><a class="btn secondary small" href="/admin/rounds/${s.round.id}">Open</a></td>
    </tr>`,
  );
  return html`
    ${pageHead(
      "Review",
      "Rounds are plural on purpose — a light screening pass, then a deep round on the survivors, then a shortlist meeting.",
      d.canWrite ? html`<a class="btn" href="/admin/events/${d.event.id}/review/rounds/new">New round</a>` : raw(""),
    )}
    ${table(["Round", "Status", "Window", "Rubric", "Proposals", "Pool", "Submitted / assigned", ""], rows, "No review rounds yet.")}
  `;
}

/* ========================================================================== */
/* New round / round settings                                                 */
/* ========================================================================== */

export interface RoundFormData {
  event: EventRef;
  round: RoundView | null;
  rubrics: RubricView[];
  tracks: Row[];
  formats: Row[];
  cfps: Row[];
}

export function roundFormView(d: RoundFormData): SafeHtml {
  const r = d.round;
  const action = r ? `/admin/rounds/${r.id}` : `/admin/events/${d.event.id}/review/rounds/new`;
  const scope = (r?.scope ?? {}) as { track_ids?: string[]; format_ids?: string[]; cfp_ids?: string[]; min_prior_score?: number | null };
  return card(
    html`<form method="post" action="${action}" class="stack">
      ${r ? versionField(r) : raw("")}
      ${field({ name: "name", label: "Name", required: true, value: r?.name ?? "", placeholder: "Screening" })}
      ${field({ name: "sequence", label: "Sequence", type: "number", required: true, min: 1, value: r?.sequence ?? 1, help: "Order within the event — 1 for the first pass." })}
      ${field({
        name: "rubric_id",
        label: "Rubric",
        type: "select",
        required: true,
        value: r?.rubric_id ?? "",
        options: d.rubrics.map((rb) => ({ value: rb.id, label: `${rb.name} (v${rb.version})` })),
        help: d.rubrics.length === 0 ? "No rubrics yet — create one first." : undefined,
      })}
      ${field({
        name: "anonymity",
        label: "Anonymity",
        type: "select",
        required: true,
        value: r?.anonymity ?? "double_blind",
        options: opts(ROUND_ANONYMITY),
        help: "double_blind also hides speaker identity from reviewers; sponsor sessions are excluded from blind rounds by scope.",
      })}
      ${field({ name: "opens_at", label: `Opens (${d.event.timezone})`, type: "datetime-local", required: true, value: r ? toLocal(r.opens_at, d.event.timezone) : "" })}
      ${field({ name: "closes_at", label: `Closes (${d.event.timezone})`, type: "datetime-local", required: true, value: r ? toLocal(r.closes_at, d.event.timezone) : "" })}
      ${field({ name: "target_reviews_per_proposal", label: "Reviews needed per proposal (quorum)", type: "number", required: true, min: 1, value: r?.target_reviews_per_proposal ?? 2 })}
      ${field({ name: "max_assignments_per_reviewer", label: "Max assignments per reviewer", type: "number", min: 1, value: r?.max_assignments_per_reviewer ?? "" })}
      ${field({ name: "show_other_reviews_before_submit", label: "Let a reviewer see other reviews before their own is submitted", type: "checkbox", value: !!r?.show_other_reviews_before_submit, help: "Default off — anchoring is real." })}
      ${field({ name: "discussion_enabled", label: "Discussion enabled", type: "checkbox", value: r ? r.discussion_enabled : true })}
      <fieldset class="field">
        <legend>Scope — which proposals are in play</legend>
        <span class="help">Leave everything blank for "every reviewable proposal in the event".</span>
        ${field({ name: "scope_track_ids", label: "Tracks", type: "multi_select", options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })), value: scope.track_ids ?? [] })}
        ${field({ name: "scope_format_ids", label: "Formats", type: "multi_select", options: d.formats.map((f) => ({ value: str(f.id), label: str(f.name) })), value: scope.format_ids ?? [] })}
        ${field({ name: "scope_cfp_ids", label: "Calls for proposals", type: "multi_select", options: d.cfps.map((c) => ({ value: str(c.id), label: str(c.name) })), value: scope.cfp_ids ?? [] })}
        ${field({ name: "scope_min_prior_score", label: "Minimum mean score in an earlier round", type: "number", step: "0.1", value: scope.min_prior_score ?? "", help: "Narrows a deep round to what survived screening." })}
      </fieldset>
      ${submitButton(r ? "Save settings" : "Create round")}
    </form>`,
    r ? "Settings" : undefined,
  );
}

/**
 * The form posts a wall-clock time the routes read in the event's zone, so the
 * value shown has to be in that zone too — otherwise opening a round's settings
 * and saving them unchanged shifts both dates by the offset.
 */
function toLocal(instant: string, timezone: string): string {
  if (!instant) return "";
  return `${calendarDateInZone(instant, timezone)}T${formatTimeInZone(instant, timezone)}`;
}

/* ========================================================================== */
/* /admin/rounds/:roundId — settings + transitions                            */
/* ========================================================================== */

const ROUND_NEXT: Record<RoundStatus, { action: string; label: string; confirm?: string }[]> = {
  draft: [{ action: "open", label: "Open round (issues assignments)" }],
  open: [{ action: "close", label: "Close round" }],
  closed: [
    { action: "reopen", label: "Reopen" },
    { action: "finalise", label: "Finalise (needs every proposal decided)", confirm: "Finalise this round? This is the last step before nothing more can change." },
  ],
  finalised: [],
};

export function roundDetailView(d: {
  event: EventRef;
  round: RoundView;
  rubrics: RubricView[];
  tracks: Row[];
  formats: Row[];
  cfps: Row[];
  canWrite: boolean;
  aiEvaluationEnabled: boolean;
}): SafeHtml {
  const r = d.round;
  const nav = html`<p class="small">
    <a href="/admin/rounds/${r.id}/pool">Pool</a> ·
    <a href="/admin/rounds/${r.id}/assignments">Assignments</a> ·
    <a href="/admin/rounds/${r.id}/progress">Progress</a> ·
    <a href="/admin/rounds/${r.id}/results">Results</a>
  </p>`;
  return html`
    ${pageHead(r.name, `Round ${r.sequence} · ${humanise(r.anonymity)}`, badge(r.status))}
    ${nav}
    ${d.canWrite && ROUND_NEXT[r.status].length > 0
      ? card(
          html`${ROUND_NEXT[r.status].map((t) => actionForm(`/admin/rounds/${r.id}/${t.action}`, t.label, { confirm: t.confirm }))}`,
          "Move this round on",
        )
      : raw("")}
    ${d.canWrite && d.aiEvaluationEnabled
      ? card(
          html`<p class="small muted">
              Evaluates every in-scope proposal that does not already have a current AI review. Never counts toward
              quorum (INV-05-17); always labelled, in the results table and every export, as a machine's opinion, and
              a human can override any of them from the results page.
            </p>
            ${actionForm(`/admin/rounds/${r.id}/ai-evaluate`, "Run AI first-pass", {
              confirm: "Generate AI first-pass reviews for every in-scope proposal without one? This never counts toward quorum.",
            })}`,
          "AI first-pass review",
        )
      : raw("")}
    ${d.canWrite ? roundFormView({ event: d.event, round: r, rubrics: d.rubrics, tracks: d.tracks, formats: d.formats, cfps: d.cfps }) : raw("")}
  `;
}

/* ========================================================================== */
/* /admin/rounds/:roundId/pool                                                */
/* ========================================================================== */

export interface PoolRowView {
  member: PoolMemberView;
  person: PersonRef | null;
  load: number;
}

export function poolView(d: {
  event: EventRef;
  round: RoundView;
  rows: PoolRowView[];
  tracks: Row[];
  canWrite: boolean;
  acceptUrl?: { url: string; email: string } | null;
}): SafeHtml {
  const rows = d.rows.map(
    (r) => html`<tr>
      <td>${personLink(r.person, r.member.person_id)}${r.person ? html`<div class="small muted">${r.person.email}</div>` : raw("")}</td>
      <td>${badge(r.member.pool_role)}</td>
      <td class="small">${r.member.track_ids?.length ? r.member.track_ids.map((t) => badge(t)) : html`<span class="muted">any track</span>`}</td>
      <td>${r.load}${r.member.max_assignments !== null ? html` / ${r.member.max_assignments}` : raw("")}</td>
      <td>${badge(r.member.status, r.member.status === "active" ? "ok" : "err")}</td>
      <td class="right">
        ${d.canWrite && r.member.status === "active"
          ? actionForm(`/admin/rounds/${d.round.id}/pool/${r.member.id}/remove`, "Remove", { confirm: "Remove them from this round's pool? Their outstanding assignments are revoked." })
          : raw("")}
      </td>
    </tr>`,
  );
  return html`
    ${pageHead(`Pool · ${d.round.name}`, "Membership of one round's pool implies nothing about any other round.")}
    ${d.acceptUrl
      ? card(
          html`<p class="lede">Reviewer invitation for <strong>${d.acceptUrl.email}</strong> is ready.</p>
            <p class="notice warn">Shown once. Copy it now — provisioning a reviewer never depends on mail delivery.</p>
            <p class="mono" style="word-break:break-all;user-select:all;padding:.75rem;background:#f4f4f5;border-radius:6px">${d.acceptUrl.url}</p>`,
          "Copy this invitation link",
        )
      : raw("")}
    ${table(["Reviewer", "Pool role", "Track limit", "Load", "Status", ""], rows, "Nobody is in this round's pool yet.")}
    ${d.canWrite
      ? card(
          html`<form method="post" action="/admin/rounds/${d.round.id}/pool" class="inline-grid">
            ${field({ name: "email", label: "Email", type: "email", required: true, help: "Finds them if they already exist, or creates a placeholder and an invitation." })}
            ${field({ name: "full_name", label: "Name", help: "Optional if they already have a record." })}
            ${field({ name: "pool_role", label: "Pool role", type: "select", required: true, value: "reviewer", options: opts(POOL_ROLE) })}
            ${field({ name: "track_ids", label: "Limit to tracks", type: "multi_select", options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })) })}
            ${field({ name: "max_assignments", label: "Per-person cap", type: "number", min: 1, help: "Overrides the round's cap for this person." })}
            <button type="submit">Add to pool</button>
          </form>`,
          "Add a reviewer",
        )
      : raw("")}
  `;
}

/* ========================================================================== */
/* /admin/rounds/:roundId/assignments                                         */
/* ========================================================================== */

export interface AssignmentRowView {
  assignment: Row;
  proposal: Row | null;
  reviewer: PersonRef | null;
}

export function assignmentsView(d: {
  event: EventRef;
  round: RoundView;
  rows: AssignmentRowView[];
  pool: PoolRowView[];
  /** Every proposal the round's scope puts in play — the single-assign picker. */
  poolProposals: Row[];
  tracks: Row[];
  formats: Row[];
  cfps: Row[];
  canWrite: boolean;
  report?: { created: number; refused: { proposal_id: string; reviewer_person_id: string; message: string }[] } | null;
  /** An auto-distribution proposal awaiting chair confirmation — nothing written yet (R12). */
  pendingProposal?: DistributionResult | null;
  /** Unassignable proposals from the most recent write (bulk or confirmed auto). */
  unassignable?: UnassignableProposal[] | null;
  filterState?: { track_ids: string[]; format_ids: string[]; cfp_ids: string[]; keyword: string };
}): SafeHtml {
  const rows = d.rows.map(
    (r) => html`<tr>
      <td>${r.proposal ? html`<a href="/admin/proposals/${str(r.proposal.id)}/review"><strong>${str(r.proposal.reference)}</strong></a><br><span class="small muted">${str(r.proposal.title)}</span>` : str(r.assignment.proposal_id)}</td>
      <td>${personLink(r.reviewer, str(r.assignment.reviewer_person_id))}</td>
      <td>${badge(str(r.assignment.assigned_by))}</td>
      <td>${badge(str(r.assignment.status))}</td>
      <td class="small">${calendarDateInZone(str(r.assignment.due_at), d.event.timezone)}</td>
      <td class="right">
        ${d.canWrite && !["submitted", "revoked", "expired"].includes(str(r.assignment.status))
          ? actionForm(`/admin/rounds/${d.round.id}/assignments/${str(r.assignment.id)}/revoke`, "Revoke", { confirm: "Revoke this assignment?" })
          : raw("")}
      </td>
    </tr>`,
  );

  return html`
    ${pageHead(`Assignments · ${d.round.name}`, "Caps, filtered bulk assignment, and auto-distribution — all three refuse silently-bad outcomes loudly.")}
    ${d.report
      ? card(
          html`<p class="notice ${d.report.refused.length ? "warn" : "ok"}">${d.report.created} assignment${d.report.created === 1 ? "" : "s"} created.
            ${d.report.refused.length ? html` ${d.report.refused.length} refused.` : raw("")}</p>
            ${d.report.refused.length
              ? html`<ul>${d.report.refused.map((r) => html`<li><span class="mono small">${r.proposal_id} / ${r.reviewer_person_id}</span> — ${r.message}</li>`)}</ul>`
              : raw("")}`,
          "Result",
        )
      : raw("")}
    ${d.pendingProposal ? autoProposalCard(d.round, d.pendingProposal) : raw("")}
    ${unassignableCard(d.pendingProposal?.unassignable ?? d.unassignable ?? undefined)}
    ${table(["Proposal", "Reviewer", "Assigned by", "Status", "Due", ""], rows, "No assignments yet.")}
    ${d.canWrite
      ? card(
          html`<form method="post" action="/admin/rounds/${d.round.id}/assignments/one" class="inline-grid">
            ${field({
              name: "proposal_id",
              label: "Proposal",
              type: "select",
              required: true,
              options: d.poolProposals.map((p) => ({ value: str(p.id), label: `${str(p.reference)} — ${str(p.title)}` })),
            })}
            ${field({
              name: "reviewer_person_id",
              label: "Reviewer",
              type: "select",
              required: true,
              options: d.pool
                .filter((p) => p.member.status === "active" && p.member.pool_role === "reviewer")
                .map((p) => ({ value: p.member.person_id, label: p.person?.name ?? p.member.person_id })),
            })}
            <button type="submit">Assign</button>
          </form>
          <p class="small muted">
            One proposal to one reviewer. Caps and conflicts of interest are checked the same way as they are in bulk —
            a refusal says which rule it broke.
          </p>`,
          "Assign a single proposal",
        )
      : raw("")}
    ${d.canWrite
      ? html`<div class="grid two">
          ${card(
            html`<form method="get" action="/admin/rounds/${d.round.id}/assignments/auto" class="stack">
              ${filterFields(d, "auto")}
              <button type="submit">Propose auto-distribution</button>
            </form>
            <p class="small muted">Honours caps, track affinity and every conflict of interest, aiming at ${d.round.target_reviews_per_proposal} reviews per proposal. Proposes; nothing is written until you confirm.</p>`,
            "Auto-distribute",
          )}
          ${card(
            html`<form method="post" action="/admin/rounds/${d.round.id}/assignments/bulk" class="stack">
              ${filterFields(d, "bulk")}
              ${field({
                name: "reviewer_person_ids",
                label: "Reviewers",
                type: "multi_select",
                required: true,
                options: d.pool.filter((p) => p.member.status === "active" && p.member.pool_role === "reviewer").map((p) => ({ value: p.member.person_id, label: p.person?.name ?? p.member.person_id })),
              })}
              ${field({
                name: "mode",
                label: "Mode",
                type: "select",
                required: true,
                value: "spread",
                options: [
                  { value: "spread", label: "Spread — round-robin one reviewer per proposal" },
                  { value: "one_each", label: "One each — every chosen reviewer gets every proposal" },
                ],
              })}
              <button type="submit">Assign filtered set</button>
            </form>`,
            "Filtered bulk assignment",
          )}
        </div>`
      : raw("")}
  `;
}

function filterFields(d: { tracks: Row[]; formats: Row[]; cfps: Row[]; filterState?: { track_ids: string[]; format_ids: string[]; cfp_ids: string[]; keyword: string } }, prefix: string): SafeHtml {
  const s = d.filterState ?? { track_ids: [], format_ids: [], cfp_ids: [], keyword: "" };
  return html`
    ${field({ name: "track_ids", id: `${prefix}_track_ids`, label: "Track", type: "multi_select", options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })), value: s.track_ids })}
    ${field({ name: "format_ids", id: `${prefix}_format_ids`, label: "Format", type: "multi_select", options: d.formats.map((f) => ({ value: str(f.id), label: str(f.name) })), value: s.format_ids })}
    ${field({ name: "cfp_ids", id: `${prefix}_cfp_ids`, label: "Call for proposals", type: "multi_select", options: d.cfps.map((c) => ({ value: str(c.id), label: str(c.name) })), value: s.cfp_ids })}
    ${field({ name: "keyword", id: `${prefix}_keyword`, label: "Keyword", value: s.keyword })}
    ${field({ name: "only_under_quorum", id: `${prefix}_only_under_quorum`, label: "Only proposals still short of quorum", type: "checkbox", value: true })}
  `;
}

function autoProposalCard(round: RoundView, proposal: DistributionResult): SafeHtml {
  if (proposal.proposed.length === 0) {
    return card(html`<p class="notice warn">Nothing to propose — every in-scope proposal already has as many reviewers as this filter allows.</p>`, "Proposed assignments");
  }
  return card(
    html`<p class="lede">${proposal.proposed.length} assignment${proposal.proposed.length === 1 ? "" : "s"} proposed. Nothing is written yet — confirm to create them.</p>
      ${table(
        ["Proposal", "Reviewer"],
        proposal.proposed.map((p) => html`<tr><td class="mono small">${p.proposal_id}</td><td class="mono small">${p.reviewer_person_id}</td></tr>`),
      )}
      <form method="post" action="/admin/rounds/${round.id}/assignments/auto/confirm" class="stack">
        ${proposal.proposed.map((p) => html`<input type="hidden" name="pair" value="${p.proposal_id}:${p.reviewer_person_id}">`)}
        ${submitButton("Confirm and create these assignments")}
      </form>`,
    "Proposed assignments",
  );
}

/** "Show the unassignable report loudly" — 05, "Assignment at scale". */
function unassignableCard(list: UnassignableProposal[] | undefined): SafeHtml {
  if (!list || list.length === 0) return raw("");
  return card(
    html`<p class="notice err">${list.length} proposal${list.length === 1 ? "" : "s"} cannot reach quorum with this pool. Reported, not quietly under-reviewed.</p>
      <ul>
        ${list.map((u) => html`<li><span class="mono small">${u.proposal_id}</span> — ${u.achievable} of ${u.needed} achievable: ${u.detail}</li>`)}
      </ul>`,
    "Unassignable",
  );
}

/* ========================================================================== */
/* /admin/rounds/:roundId/progress                                            */
/* ========================================================================== */

export function progressView(d: {
  event: EventRef;
  round: RoundView;
  rows: (ReviewerProgress & { person: PersonRef | null })[];
  canWrite: boolean;
}): SafeHtml {
  const rows = d.rows.map(
    (p) => html`<tr>
      <td>
        ${d.canWrite ? html`<input type="checkbox" name="reviewer_person_id" value="${p.reviewer_person_id}">` : raw("")}
        ${personLink(p.person, p.reviewer_person_id)}
      </td>
      <td>${p.assigned}</td>
      <td>${p.accepted}</td>
      <td>${p.declined}</td>
      <td>${p.submitted}</td>
      <td>${p.outstanding}</td>
      <td>${p.overdue > 0 ? html`<span class="badge err">${p.overdue}</span>` : "0"}</td>
      <td style="min-width:8rem">${progressBar(p.completion_pct)}<span class="small muted">${p.completion_pct}%</span></td>
      <td class="small">${p.last_activity_at ? p.last_activity_at.slice(0, 10) : html`<span class="muted">—</span>`}</td>
      <td class="small">${p.reminder_count}${p.last_reminded_at ? html` · last ${p.last_reminded_at.slice(0, 10)}` : raw("")}</td>
    </tr>`,
  );
  return html`
    ${pageHead(`Progress · ${d.round.name}`, "Live — recomputed on every assignment and review change.")}
    <form method="post" action="/admin/rounds/${d.round.id}/progress/remind">
      ${table(
        ["", "Assigned", "Accepted", "Declined", "Submitted", "Outstanding", "Overdue", "Completion", "Last activity", "Reminders"],
        rows,
        "Nobody is in this round's pool yet.",
      )}
      ${d.canWrite ? html`<p><button type="submit" class="secondary">Remind selected</button></p>` : raw("")}
    </form>
  `;
}

/* ========================================================================== */
/* /admin/rounds/:roundId/results                                             */
/* ========================================================================== */

const SORT_LABELS: Record<string, string> = {
  reference: "Proposal",
  title: "Title",
  mean: "Mean",
  weighted_mean: "Weighted mean",
  median: "Median",
  disagreement: "Disagreement",
  review_count: "Reviews",
  quorum: "Quorum",
  stale: "Stale",
  decision: "Decision",
};

function sortLink(base: string, filters: ResultFilters, column: string, label: string): SafeHtml {
  const params = new URLSearchParams();
  if (filters.track_id) params.set("track_id", filters.track_id);
  if (filters.format_id) params.set("format_id", filters.format_id);
  if (filters.flag) params.set("flag", filters.flag);
  if (filters.decision_state) params.set("decision_state", filters.decision_state);
  if (filters.quorum) params.set("quorum", filters.quorum);
  const nextDirection = filters.sort === column && filters.direction !== "desc" ? "desc" : "asc";
  params.set("sort", column);
  params.set("direction", nextDirection);
  const active = filters.sort === column || (!filters.sort && column === "reference");
  const arrow = active ? (filters.direction === "desc" ? " ↓" : " ↑") : "";
  return html`<a href="${base}?${params.toString()}">${label}${arrow}</a>`;
}

export function resultsView(d: {
  event: EventRef;
  round: RoundView;
  criteria: CriterionView[];
  rows: ResultRow[];
  filters: ResultFilters;
  tracks: Row[];
  formats: Row[];
}): SafeHtml {
  const base = `/admin/rounds/${d.round.id}/results`;
  const headers = [
    sortLink(base, d.filters, "reference", SORT_LABELS.reference),
    sortLink(base, d.filters, "title", SORT_LABELS.title),
    sortLink(base, d.filters, "mean", SORT_LABELS.mean),
    sortLink(base, d.filters, "weighted_mean", SORT_LABELS.weighted_mean),
    sortLink(base, d.filters, "disagreement", SORT_LABELS.disagreement),
    sortLink(base, d.filters, "review_count", "Human / AI"),
    sortLink(base, d.filters, "quorum", SORT_LABELS.quorum),
    sortLink(base, d.filters, "stale", SORT_LABELS.stale),
    "Recommendations",
    "Flags",
    sortLink(base, d.filters, "decision", SORT_LABELS.decision),
  ];
  const rows = d.rows.map((r) => {
    const s = r.score;
    return html`<tr>
      <td><a href="/admin/proposals/${r.proposal.id}/review">${str(r.proposal.reference)}</a></td>
      <td>${str(r.proposal.title)}</td>
      <td>${s.mean ?? "—"}</td>
      <td>${s.weighted_mean ?? "—"}</td>
      <td>${s.disagreement ?? "—"}</td>
      <td>${s.human_review_count}${s.ai_review_count ? html` <span class="badge ai">+${s.ai_review_count} AI</span>` : raw("")}</td>
      <td>${s.has_quorum ? badge("has quorum", "ok") : badge("short", "warn")}</td>
      <td>${s.stale_count > 0 ? html`<span class="badge warn">${s.stale_count}</span>` : "—"}</td>
      <td class="small">${Object.entries(s.recommendation_histogram).map(([k, v]) => html`${humanise(k)}: ${v} `)}</td>
      <td class="small">${Object.entries(s.flag_counts).map(([k, v]) => badge(`${humanise(k)} ${v}`))}</td>
      <td>${r.decision ? badge(str(r.decision.outcome), str(r.decision.outcome) === "accept" ? "ok" : str(r.decision.outcome) === "reject" ? "err" : "") : html`<span class="muted">none</span>`}</td>
    </tr>`;
  });

  return html`
    ${pageHead(`Results · ${d.round.name}`, "The chair's working surface. Ranking is never automatic — the numbers and the disagreement signal are, the decision is yours.", html`<a class="btn secondary" href="${base}?${csvQuery(d.filters)}">Download CSV</a>`)}
    ${card(
      html`<form method="get" action="${base}" class="filter-bar">
        ${field({ name: "track_id", label: "Track", type: "select", value: d.filters.track_id ?? "", options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })) })}
        ${field({ name: "format_id", label: "Format", type: "select", value: d.filters.format_id ?? "", options: d.formats.map((f) => ({ value: str(f.id), label: str(f.name) })) })}
        ${field({ name: "quorum", label: "Quorum", type: "select", value: d.filters.quorum ?? "", options: [{ value: "yes", label: "Has quorum" }, { value: "no", label: "Short of quorum" }] })}
        ${field({ name: "decision_state", label: "Decision", type: "select", value: d.filters.decision_state ?? "", options: [{ value: "none", label: "No decision" }, ...opts(DECISION_OUTCOME)] })}
        ${submitButton("Filter", "secondary")}
      </form>`,
      "Filter",
    )}
    ${table(headers, rows, "Nothing in scope for this round yet.")}
  `;
}

function csvQuery(filters: ResultFilters): string {
  const params = new URLSearchParams();
  if (filters.track_id) params.set("track_id", filters.track_id);
  if (filters.format_id) params.set("format_id", filters.format_id);
  if (filters.flag) params.set("flag", filters.flag);
  if (filters.decision_state) params.set("decision_state", filters.decision_state);
  if (filters.quorum) params.set("quorum", filters.quorum);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.direction) params.set("direction", filters.direction);
  params.set("format", "csv");
  return params.toString();
}

/** One row of the `review_results` export — 05, "The results table". */
export function resultsCsvRow(row: ResultRow, criteria: CriterionView[], includeTitle: boolean): Record<string, string | number> {
  const s = row.score;
  const out: Record<string, string | number> = {
    reference: str(row.proposal.reference),
    title: includeTitle ? str(row.proposal.title) : "",
    mean: s.mean ?? "",
    weighted_mean: s.weighted_mean ?? "",
    median: s.median ?? "",
    stddev: s.stddev ?? "",
    disagreement: s.disagreement ?? "",
    human_review_count: s.human_review_count,
    ai_review_count: s.ai_review_count,
    has_quorum: s.has_quorum ? "yes" : "no",
    stale_count: s.stale_count,
    decision_outcome: row.decision ? str(row.decision.outcome) : "",
    decision_status: row.decision ? str(row.decision.status) : "",
  };
  for (const c of criteria) out[`criterion:${c.key}`] = s.per_criterion_mean[c.key] ?? "";
  return out;
}

export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c] ?? "")).join(","));
  return lines.join("\r\n");
}

/* ========================================================================== */
/* /admin/rubrics                                                             */
/* ========================================================================== */

export function rubricsListView(d: { event: EventRef | null; rubrics: RubricView[]; canWrite: boolean; eventOptions: Row[] }): SafeHtml {
  const rows = d.rubrics.map(
    (r) => html`<tr>
      <td><a href="/admin/rubrics/${r.id}"><strong>${r.name}</strong></a></td>
      <td>v${r.version}</td>
      <td>${badge(r.overall_scale)}</td>
      <td>${r.requires_comment ? badge("comment required", "info") : raw("")}</td>
    </tr>`,
  );
  return html`
    ${pageHead("Rubrics", "Typed criteria, weights and anchor descriptions — the anchors are the single highest-leverage field for score consistency.")}
    ${d.event ? raw("") : card(html`<form method="get" action="/admin/rubrics" class="inline-form"><select name="event_id">${d.eventOptions.map((e) => html`<option value="${str(e.id)}">${str(e.name)}</option>`)}</select><button class="small secondary" type="submit">Switch event</button></form>`)}
    ${table(["Name", "Version", "Overall scale", ""], rows, "No rubrics for this event yet.")}
    ${d.canWrite && d.event
      ? html`<div class="grid two">
          ${card(
            html`<form method="post" action="/admin/rubrics?event_id=${d.event.id}" class="stack">
              ${field({ name: "name", label: "Name", required: true })}
              ${field({ name: "description", label: "Description", type: "textarea", rows: 2 })}
              ${field({ name: "overall_scale", label: "Overall scale", type: "select", required: true, value: "recommendation", options: opts(OVERALL_SCALE) })}
              ${field({ name: "requires_comment", label: "Requires at least one written comment", type: "checkbox", value: true })}
              <p class="small muted">Add criteria after creating — a rubric needs at least one.</p>
              ${submitButton("Create rubric")}
            </form>`,
            "New rubric",
          )}
          ${card(
            html`<p class="small muted">A sponsor session is checked, not selected. One criterion is the whole design.</p>
              ${actionForm(`/admin/rubrics/sponsor-preset?event_id=${d.event.id}`, "Create the sponsor compliance rubric")}`,
            "Sponsor compliance preset",
          )}
        </div>`
      : raw("")}
  `;
}

const CRITERION_ROWS = 8;

export function rubricFormView(d: { event: EventRef; rubric: RubricView; criteria: CriterionView[]; canWrite: boolean; locked: boolean }): SafeHtml {
  const rows = [...d.criteria];
  while (rows.length < CRITERION_ROWS) rows.push(blankCriterion());
  return html`
    ${pageHead(d.rubric.name, `v${d.rubric.version}${d.locked ? " — locked: a round already using this rubric has started, so an edit creates a new version rather than changing what reviewers scored against." : ""}`)}
    ${d.canWrite
      ? card(
          html`<form method="post" action="/admin/rubrics/${d.rubric.id}" class="stack">
            ${field({ name: "name", label: "Name", required: true, value: d.rubric.name })}
            ${field({ name: "description", label: "Description", type: "textarea", rows: 2, value: d.rubric.description ?? "" })}
            ${field({ name: "overall_scale", label: "Overall scale", type: "select", required: true, value: d.rubric.overall_scale, options: opts(OVERALL_SCALE) })}
            ${field({ name: "requires_comment", label: "Requires at least one written comment", type: "checkbox", value: d.rubric.requires_comment })}
            <h3>Criteria</h3>
            <p class="small muted">Anchor text for what a 1 and a 5 mean is the single highest-leverage field for score consistency. For a select criterion, list options one per line as <span class="mono">value | Label | description | score</span> — score is optional; omit it and the criterion is a histogram, excluded from the mean.</p>
            ${rows.map((c, i) => criterionFields(c, i))}
            ${submitButton(d.locked ? "Save as a new version" : "Save rubric")}
          </form>`,
          "Edit",
        )
      : raw("")}
  `;
}

function blankCriterion(): CriterionView {
  return {
    id: "",
    rubric_id: "",
    key: "",
    label: "",
    description: null,
    type: "numeric",
    scale_min: 1,
    scale_max: 5,
    options: [],
    max_length: null,
    weight: 1,
    is_required: true,
    allows_na: false,
    sort_order: 0,
  };
}

// Every field name carries its row index — a checkbox that is unchecked is
// simply absent from posted form data, which would silently desync a
// same-name-array reading (`criterion_key[]`, `criterion_is_required[]`) the
// moment one row's checkbox is off. Indexed names keep each row self-contained.
function criterionFields(c: CriterionView, i: number): SafeHtml {
  return html`<fieldset class="field">
    <legend>Criterion ${i + 1}</legend>
    <div class="inline-grid">
      ${field({ name: `criterion_key_${i}`, label: "Key", value: c.key, placeholder: "technical-depth" })}
      ${field({ name: `criterion_label_${i}`, label: "Label", value: c.label, placeholder: "Technical depth" })}
      ${field({ name: `criterion_type_${i}`, label: "Type", type: "select", value: c.type, options: opts(CRITERION_TYPE) })}
      ${field({ name: `criterion_weight_${i}`, label: "Weight", type: "number", step: "0.1", min: 0, value: c.weight })}
      ${field({ name: `criterion_scale_min_${i}`, label: "Scale min", type: "number", value: c.scale_min ?? "" })}
      ${field({ name: `criterion_scale_max_${i}`, label: "Scale max", type: "number", value: c.scale_max ?? "" })}
      ${field({ name: `criterion_max_length_${i}`, label: "Max length (text)", type: "number", value: c.max_length ?? "" })}
      ${field({ name: `criterion_is_required_${i}`, label: "Required", type: "checkbox", value: c.is_required })}
      ${field({ name: `criterion_allows_na_${i}`, label: "Allows N/A", type: "checkbox", value: c.allows_na })}
    </div>
    ${field({ name: `criterion_description_${i}`, label: "Anchor description", type: "textarea", rows: 2, value: c.description ?? "" })}
    ${field({ name: `criterion_options_${i}`, label: "Options (select only)", type: "textarea", rows: 3, value: optionLines(c.options) })}
  </fieldset>`;
}

function optionLines(options: CriterionView["options"]): string {
  return options.map((o) => [o.value, o.label, o.description ?? "", o.score ?? ""].join(" | ")).join("\n");
}

function parseOptionLines(text: string): { value: string; label: string; description?: string | null; score?: number | null }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label, description, score] = line.split("|").map((s) => s.trim());
      return {
        value: value || label || "",
        label: label || value || "",
        description: description || null,
        score: score ? Number(score) : null,
      };
    });
}

/** Reads the `CRITERION_ROWS` indexed fields `criterionFields` rendered back into drafts. */
export function parseCriteriaFromInput(read: (name: string) => string | null): {
  key: string;
  label: string;
  description?: string | null;
  type: CriterionType;
  scale_min?: number | null;
  scale_max?: number | null;
  options?: { value: string; label: string; description?: string | null; score?: number | null }[];
  max_length?: number | null;
  weight?: number;
  is_required?: boolean;
  allows_na?: boolean;
  sort_order?: number;
}[] {
  const out: ReturnType<typeof parseCriteriaFromInput> = [];
  for (let i = 0; i < CRITERION_ROWS; i++) {
    const label = (read(`criterion_label_${i}`) ?? "").trim();
    const key = (read(`criterion_key_${i}`) ?? "").trim();
    if (!label && !key) continue;
    const type = (read(`criterion_type_${i}`) || "numeric") as CriterionType;
    const scaleMin = read(`criterion_scale_min_${i}`);
    const scaleMax = read(`criterion_scale_max_${i}`);
    const maxLen = read(`criterion_max_length_${i}`);
    const weight = read(`criterion_weight_${i}`);
    out.push({
      key: key || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      label: label || key,
      description: read(`criterion_description_${i}`) || null,
      type,
      scale_min: type === "numeric" ? (scaleMin ? Number(scaleMin) : null) : null,
      scale_max: type === "numeric" || type === "boolean" ? (scaleMax ? Number(scaleMax) : null) : null,
      options: type === "select" ? parseOptionLines(read(`criterion_options_${i}`) ?? "") : undefined,
      max_length: type === "text" ? (maxLen ? Number(maxLen) : null) : null,
      weight: weight ? Number(weight) : 1,
      is_required: read(`criterion_is_required_${i}`) !== null,
      allows_na: read(`criterion_allows_na_${i}`) !== null,
      sort_order: i,
    });
  }
  return out;
}

/* ========================================================================== */
/* /admin/events/:eventId/decisions                                           */
/* ========================================================================== */

export interface DecisionRowView {
  proposal: Row;
  decision: Row | null;
  hasQuorum: boolean;
}

export function decisionsListView(d: { event: EventRef; rows: DecisionRowView[]; tracks: Row[]; formats: Row[]; canWrite: boolean }): SafeHtml {
  const rows = d.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/proposals/${str(r.proposal.id)}/decision"><strong>${str(r.proposal.reference)}</strong></a><br><span class="small muted">${str(r.proposal.title)}</span></td>
      <td>${r.hasQuorum ? badge("has quorum", "ok") : badge("short of quorum", "warn")}</td>
      <td>${r.decision ? badge(str(r.decision.outcome)) : html`<span class="muted">none</span>`}</td>
      <td>${r.decision ? badge(str(r.decision.status), str(r.decision.status) === "published" ? "ok" : "warn") : raw("")}</td>
      <td class="right">
        ${d.canWrite
          ? html`<form method="post" action="/admin/events/${d.event.id}/decisions" class="inline-grid">
              <input type="hidden" name="proposal_id" value="${str(r.proposal.id)}">
              <select name="outcome">
                <option value="">— set outcome —</option>
                ${DECISION_OUTCOME.map((o) => html`<option value="${o}"${r.decision && str(r.decision.outcome) === o ? raw(" selected") : raw("")}>${humanise(o)}</option>`)}
              </select>
              <input type="datetime-local" name="confirmation_deadline" placeholder="confirm by">
              <input type="text" name="quorum_waived_reason" placeholder="reason to waive quorum, if needed">
              <button type="submit" class="small">Record</button>
            </form>`
          : raw("")}
      </td>
    </tr>`,
  );
  return html`
    ${pageHead("Decisions", "Provisional until published. Nothing reaches a speaker until you publish, as a deliberate batch.", html`<a class="btn secondary" href="/admin/events/${d.event.id}/decisions/publish">Review and publish</a>`)}
    ${table(["Proposal", "Quorum", "Outcome", "Status", ""], rows, "Nothing to decide yet.")}
  `;
}

export function decisionFormView(d: { event: EventRef; proposal: Row; decision: Row | null; tracks: Row[]; formats: Row[]; hasQuorum: boolean; canWrite: boolean }): SafeHtml {
  const dec = d.decision;
  return html`
    ${pageHead(str(d.proposal.title), `${str(d.proposal.reference)} · ${d.hasQuorum ? "has quorum" : "short of quorum"}`, dec ? badge(str(dec.status)) : raw(""))}
    ${d.canWrite
      ? card(
          html`<form method="post" action="/admin/proposals/${str(d.proposal.id)}/decision" class="stack">
            ${field({ name: "outcome", label: "Outcome", type: "select", required: true, value: dec ? str(dec.outcome) : "", options: opts(DECISION_OUTCOME) })}
            ${field({ name: "assigned_track_id", label: "Assign to track", type: "select", value: dec ? str(dec.assigned_track_id) : "", options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })) })}
            ${field({ name: "assigned_format_id", label: "Assign to format", type: "select", value: dec ? str(dec.assigned_format_id) : "", options: d.formats.map((f) => ({ value: str(f.id), label: str(f.name) })) })}
            ${field({ name: "assigned_duration_minutes", label: "Assigned duration (minutes)", type: "number", min: 1, value: dec?.assigned_duration_minutes ?? "" })}
            ${field({ name: "confirmation_deadline", label: `Confirmation deadline (${d.event.timezone})`, type: "datetime-local", value: dec ? toLocal(str(dec.confirmation_deadline), d.event.timezone) : "", help: "Required to publish an acceptance." })}
            ${field({ name: "conditions", label: "Conditions of acceptance (shown to the speaker)", type: "textarea", rows: 2, value: dec ? str(dec.conditions) : "" })}
            ${field({ name: "feedback_for_speaker", label: "Feedback for the speaker", type: "textarea", rows: 4, value: dec ? str(dec.feedback_for_speaker) : "", help: "The one channel to the speaker." })}
            ${field({ name: "rationale", label: "Rationale (committee-only)", type: "textarea", rows: 3, value: dec ? str(dec.rationale) : "" })}
            ${!d.hasQuorum ? field({ name: "quorum_waived_reason", label: "Reason to accept without quorum", type: "textarea", rows: 2, help: "Required to accept below quorum." }) : raw("")}
            ${submitButton("Record decision")}
          </form>`,
          "Decision",
        )
      : raw("")}
  `;
}

/* ========================================================================== */
/* /admin/events/:eventId/decisions/publish                                   */
/* ========================================================================== */

export function publishPreviewView(d: { event: EventRef; rows: PublishPreviewRow[] }): SafeHtml {
  const publishable = d.rows.filter((r) => !r.blocked);
  const rows = d.rows.map(
    (r) => html`<tr>
      <td>${str(r.proposal.reference)}<div class="small muted">${str(r.proposal.title)}</div></td>
      <td>${badge(str(r.decision.outcome))}</td>
      <td>${r.recipient ? html`${r.recipient.full_name}<div class="small muted">${r.recipient.email}</div>` : html`<span class="muted">no submitter on record</span>`}</td>
      <td class="small">${r.also_notified.map((p) => p.full_name).join(", ") || "—"}</td>
      <td class="mono small">${r.template_key}</td>
      <td>${r.blocked ? html`<span class="badge err">blocked</span><div class="small muted">${r.blocked}</div>` : badge("will send", "ok")}</td>
    </tr>`,
  );
  return html`
    ${pageHead("Publish decisions", "Exactly who receives which message, before anything is sent. Nothing reaches a speaker until you confirm here.")}
    ${table(["Proposal", "Outcome", "Recipient", "Also notified", "Template", ""], rows, "Nothing provisional to publish.")}
    ${publishable.length > 0
      ? html`<form method="post" action="/admin/events/${d.event.id}/decisions/publish" class="stack">
          ${publishable.map((r) => html`<input type="hidden" name="decision_id" value="${str(r.decision.id)}">`)}
          <button type="submit" onclick="return confirm('Send ${publishable.length} notification${publishable.length === 1 ? "" : "s"} now? This cannot be undone from here.')">Publish ${publishable.length} decision${publishable.length === 1 ? "" : "s"}</button>
        </form>`
      : empty("Nothing is ready to publish.")}
  `;
}

/* ========================================================================== */
/* /admin/proposals/:proposalId/review — discussion + COI                     */
/* ========================================================================== */

export interface CommentThreadItem {
  comment: Row;
  author: PersonRef | null;
  replies: { comment: Row; author: PersonRef | null }[];
}

/**
 * 05, "AI evaluation": always labelled, never counts toward quorum
 * (INV-05-17), always overridable. The chair's screen has to show all three —
 * a first-pass score the chair can see but not answer is the anchoring problem
 * R24 exists to contain, with none of the remedy.
 */
function aiReviewsCard(reviews: AiReviewView[]): SafeHtml {
  if (reviews.length === 0) return raw("");
  return card(
    html`${reviews.map(
      (r) => html`<div class="review-summary">
        <p class="small">
          ${badge("AI", "ai")}
          ${r.overall_score !== null ? html`<strong>${r.overall_score}</strong>` : raw("")}
          ${r.recommendation ? badge(humanise(r.recommendation)) : raw("")}
          <span class="muted">${r.ai_evaluator_key}${r.ai_model ? html` · ${r.ai_model}` : raw("")}</span>
          ${r.superseded ? badge("overridden by a human", "warn") : raw("")}
        </p>
        ${r.ai_rationale ? html`<p class="small">${r.ai_rationale}</p>` : raw("")}
        ${r.overrideForm ?? raw("")}
      </div>`,
    )}
    <p class="small muted">Never counts toward quorum (INV-05-17). An override writes a human review that supersedes this one; the machine's opinion is kept, not deleted.</p>`,
    "AI first-pass",
  );
}

export interface AiReviewView {
  id: string;
  overall_score: number | null;
  recommendation: string | null;
  ai_evaluator_key: string;
  ai_model: string | null;
  ai_rationale: string | null;
  superseded: boolean;
  /** Rendered by the route, because it needs the round's rubric. */
  overrideForm: SafeHtml | null;
}

/** One submitted human review, as the chair reads it. */
export interface HumanReviewView {
  id: string;
  round_name: string;
  /** Null in a blind round — the score is the point, the name is not. */
  reviewer_name: string | null;
  overall_score: number | null;
  recommendation: string | null;
  confidence: string | null;
  flags: string[];
  comments_for_committee: string | null;
  comments_for_speaker: string | null;
  submitted_at: string | null;
  scores: { label: string; value: string; weight: number | null }[];
}

/**
 * 05 promises the chair reads what the committee wrote. The round's results
 * table aggregates it, but an aggregate is not a review: a mean of 4.36 does
 * not tell a chair that the one reviewer who read it said "name the tooling".
 */
function humanReviewsCard(reviews: HumanReviewView[]): SafeHtml {
  if (reviews.length === 0) return card(empty("No reviews submitted for this proposal yet."), "Reviews");
  return card(
    html`${reviews.map(
      (r) => html`<article class="review-read">
        <h3>
          ${r.reviewer_name ?? "Reviewer (blind round)"}
          ${r.overall_score !== null ? html` <span class="badge">Rating ${r.overall_score}</span>` : raw("")}
          ${r.recommendation ? badge(r.recommendation) : raw("")}
        </h3>
        <p class="small muted">
          ${r.round_name}${r.confidence ? ` · confidence ${humanise(r.confidence)}` : ""}${r.submitted_at
            ? ` · submitted ${r.submitted_at.slice(0, 16).replace("T", " ")}`
            : ""}
        </p>
        ${r.flags.length ? html`<p>${r.flags.map((f) => badge(f))}</p>` : raw("")}
        ${table(
          ["Criterion", "Score", "Weight"],
          r.scores.map((s) => html`<tr><td>${s.label}</td><td>${s.value}</td><td>${s.weight ?? "—"}</td></tr>`),
          "No per-criterion scores.",
        )}
        ${r.comments_for_committee
          ? html`<p><strong>For the committee:</strong> ${r.comments_for_committee}</p>`
          : raw("")}
        ${r.comments_for_speaker ? html`<p><strong>For the speaker:</strong> ${r.comments_for_speaker}</p>` : raw("")}
      </article>`,
    )}`,
    "Reviews",
  );
}

export function proposalDiscussionView(d: {
  event: EventRef;
  proposal: Row;
  rounds: RoundView[];
  threads: CommentThreadItem[];
  conflicts: (ConflictRecord & { reviewerName: string })[];
  aiReviews: AiReviewView[];
  humanReviews: HumanReviewView[];
  canWriteComments: boolean;
  canDeclareCoi: boolean;
  canSeeChairsOnly: boolean;
}): SafeHtml {
  const threadRows = d.threads.map(
    (t) => html`<li class="comment">
      <div class="small muted">${t.author?.name ?? "someone"} · ${str(t.comment.created_at).slice(0, 16).replace("T", " ")} · ${badge(str(t.comment.visibility))}</div>
      <div>${str(t.comment.body)}</div>
      ${t.replies.length
        ? html`<ul class="comment-replies">
            ${t.replies.map(
              (r) => html`<li>
                <div class="small muted">${r.author?.name ?? "someone"} · ${str(r.comment.created_at).slice(0, 16).replace("T", " ")} · ${badge(str(r.comment.visibility))}</div>
                <div>${str(r.comment.body)}</div>
              </li>`,
            )}
          </ul>`
        : raw("")}
      ${d.canWriteComments
        ? html`<form method="post" action="/admin/proposals/${str(d.proposal.id)}/review/comments" class="inline-form">
            <input type="hidden" name="parent_id" value="${str(t.comment.id)}">
            <input type="text" name="body" placeholder="Reply">
            <button class="small secondary" type="submit">Reply</button>
          </form>`
        : raw("")}
    </li>`,
  );

  return html`
    ${pageHead(str(d.proposal.title), `${str(d.proposal.reference)} · committee discussion. Never speaker-visible.`)}
    ${humanReviewsCard(d.humanReviews)}
    ${aiReviewsCard(d.aiReviews)}
    ${card(
      html`<ul class="notes">${threadRows}</ul>
        ${d.canWriteComments
          ? html`<form method="post" action="/admin/proposals/${str(d.proposal.id)}/review/comments" class="stack">
              ${field({ name: "body", label: "New comment", type: "textarea", rows: 3, required: true })}
              ${field({ name: "visibility", label: "Visible to", type: "select", required: true, value: "committee_only", options: opts(COMMENT_VISIBILITY) })}
              ${submitButton("Post")}
            </form>`
          : empty("No comments yet.")}`,
      "Discussion",
    )}
    ${card(
      html`${d.conflicts.length === 0
          ? empty("No conflicts declared against this proposal.")
          : html`<ul>${d.conflicts.map((c) => html`<li>${c.reviewerName} — ${humanise(c.subject_type)} · ${humanise(c.reason)} · ${humanise(c.source)}</li>`)}</ul>`}
        ${d.canDeclareCoi
          ? html`<form method="post" action="/admin/proposals/${str(d.proposal.id)}/review/coi" class="inline-grid">
              ${field({ name: "reviewer_person_id", label: "Reviewer's person id", required: true, help: "per_… — from the pool or the person record." })}
              ${field({ name: "subject_type", label: "Against", type: "select", required: true, value: "proposal", options: opts(COI_SUBJECT_TYPE) })}
              ${field({ name: "subject_value", label: "Domain (company_domain only)" })}
              ${field({ name: "reason", label: "Reason", type: "select", required: true, options: opts(COI_REASON) })}
              ${field({ name: "note", label: "Note" })}
              <button type="submit">Declare conflict</button>
            </form>`
          : raw("")}`,
      "Conflicts of interest",
    )}
  `;
}
