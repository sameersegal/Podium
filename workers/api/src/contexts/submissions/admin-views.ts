/**
 * Admin-facing screens for 04 — the proposal queue and the full detail view,
 * including the organizer edit form (INV-04-7) and the entitlement panel for
 * sponsor proposals.
 */

import { num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { AUDIENCE_LEVEL, ORIGIN, RECORDING_CONSENT } from "@podiumconf/domain/event-config/types.js";
import type { FieldError } from "@podiumconf/domain/shared/errors.js";
import { formatDateInZone, formatInZone } from "@podiumconf/domain/shared/time.js";
import { PROPOSAL_STATUS } from "@podiumconf/domain/submissions/types.js";
import { html, joinHtml, markdown, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, editLink, empty, field, humanise, pageHead, sortBar, table } from "../../ui/layout.js";
import type { EventRef } from "../../ui/shell.js";
import type { ProposalDetail, QueueFilters, QueueRow } from "./views.js";

/* -------------------------------------------------------------------------- */
/* The queue                                                                   */
/* -------------------------------------------------------------------------- */

export function queueFiltersFrom(url: URL): QueueFilters {
  const multi = (name: string) => url.searchParams.getAll(name).flatMap((v) => v.split(",")).filter(Boolean);
  return {
    status: multi("status"),
    track_id: multi("track_id"),
    format_id: multi("format_id"),
    origin: multi("origin"),
    cfp_id: multi("cfp_id"),
    q: url.searchParams.get("q"),
    sort: url.searchParams.get("sort") ?? "newest",
    cursor: url.searchParams.get("cursor"),
    limit: Number(url.searchParams.get("limit") ?? 50),
  };
}

function qs(url: URL, overrides: Record<string, string | null>): string {
  const p = new URLSearchParams(url.search);
  p.delete("cursor");
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  return `?${p.toString()}`;
}

const SORTS: { key: string; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "reference", label: "Reference" },
  { key: "title", label: "Title" },
  { key: "submitted", label: "Submitted" },
  { key: "status", label: "Status" },
];

export interface QueuePageData {
  event: EventRef;
  rows: QueueRow[];
  filters: QueueFilters;
  total: number;
  nextCursor: string | null;
  url: URL;
  cfps: Row[];
  tracks: Row[];
  formats: Row[];
}

export function proposalQueueView(data: QueuePageData): SafeHtml {
  const { url } = data;
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><input type="checkbox" name="proposal_ids" value="${str(r.id)}"></td>
      <td><a href="/admin/proposals/${str(r.id)}"><strong>${str(r.title) || "Untitled"}</strong></a><br><span class="mono small muted">${str(r.reference)}</span></td>
      <td>${r.submitter_name}<br><span class="small muted">${r.submitter_email}</span></td>
      <td>${r.speaker_names || html`<span class="muted">—</span>`}</td>
      <td>${r.track_name ?? html`<span class="muted">—</span>`}</td>
      <td>${r.format_name ?? html`<span class="muted">—</span>`}</td>
      <td>${badge(str(r.origin))}${r.sponsor_name ? html`<br><span class="small muted">${r.sponsor_name}</span>` : raw("")}</td>
      <td>${badge(str(r.status))}</td>
      <td class="small muted nowrap">${strOrNull(r.submitted_at) ? formatDateInZone(str(r.submitted_at), data.event.timezone) : "—"}</td>
      <td class="right">${editLink(`/admin/proposals/${str(r.id)}`, "Open")}</td>
    </tr>`,
  );

  const statusOptions = PROPOSAL_STATUS.map((s) => ({ value: s, label: humanise(s) }));
  const originOptions = ORIGIN.map((o) => ({ value: o, label: humanise(o) }));
  const activeFilters = [data.filters.q, ...(data.filters.status ?? []), ...(data.filters.origin ?? []), ...(data.filters.track_id ?? []), ...(data.filters.format_id ?? []), ...(data.filters.cfp_id ?? [])].filter(Boolean).length;

  return html`${pageHead("Proposals", `${data.total} proposal${data.total === 1 ? "" : "s"} for ${data.event.name}.`)}
    <details class="filter-bar"${activeFilters > 0 ? raw(" open") : raw("")}>
      <summary>Filters${activeFilters > 0 ? html` <span class="badge info">${activeFilters}</span>` : raw("")}</summary>
    <form method="get" class="inline-grid">
      ${field({ name: "q", label: "Search", value: data.filters.q ?? "", placeholder: "Title, reference or submitter" })}
      ${field({ name: "status", label: "Status", type: "multi_select", options: statusOptions, value: data.filters.status ?? [] })}
      ${field({ name: "origin", label: "Origin", type: "multi_select", options: originOptions, value: data.filters.origin ?? [] })}
      ${field({
        name: "track_id",
        label: "Track",
        type: "multi_select",
        options: data.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })),
        value: data.filters.track_id ?? [],
      })}
      ${field({
        name: "format_id",
        label: "Format",
        type: "multi_select",
        options: data.formats.map((f) => ({ value: str(f.id), label: str(f.name) })),
        value: data.filters.format_id ?? [],
      })}
      ${field({
        name: "cfp_id",
        label: "Call",
        type: "multi_select",
        options: data.cfps.map((c) => ({ value: str(c.id), label: str(c.name) })),
        value: data.filters.cfp_id ?? [],
      })}
      <div class="actions">
        <button type="submit">Filter</button>
        ${activeFilters > 0 ? html`<a class="btn secondary" href="${url.pathname}">Clear</a>` : raw("")}
      </div>
    </form>
    </details>
    ${sortBar(SORTS.map((s) => ({ href: qs(url, { sort: s.key }), label: s.label, current: (data.filters.sort ?? "newest") === s.key })))}
    <form method="post" action="/admin/events/${data.event.id}/proposals/bulk">
      <div class="bulk-actions" id="bulk-actions">
        <label class="checkline"><input type="checkbox" id="select-all"> Select all</label>
        <span class="muted small">Bulk actions appear here once review is open.</span>
      </div>
      ${table(["", "Proposal", "Submitter", "Speakers", "Track", "Format", "Origin", "Status", "Submitted", ""], rows, "No proposals match these filters.")}
    </form>
    ${data.nextCursor ? html`<p><a href="${qs(url, { cursor: data.nextCursor })}">Next page →</a></p>` : raw("")}
    <script>
      (function(){
        var all = document.getElementById('select-all');
        if (!all) return;
        all.addEventListener('change', function(){
          document.querySelectorAll('input[name="proposal_ids"]').forEach(function(cb){ cb.checked = all.checked; });
        });
      })();
    </script>`;
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                      */
/* -------------------------------------------------------------------------- */

export interface AdminDetailData {
  detail: ProposalDetail;
  event: EventRef;
  tracks: Row[];
  formats: Row[];
  canEdit: boolean;
  fieldErrors: FieldError[];
}

export function proposalAdminDetailView(data: AdminDetailData): SafeHtml {
  const { detail } = data;
  const p = detail.proposal;

  const byStep = new Map<string, typeof detail.answer_views>();
  for (const a of detail.answer_views) byStep.set(a.step_key, [...(byStep.get(a.step_key) ?? []), a]);
  const answerBlocks = [...byStep.entries()].map(
    ([, answers]) => html`<div class="review-step">
      <h3>${answers[0]?.step_title}</h3>
      ${table(
        ["Field", "Audience", "Answer"],
        answers.map(
          (a) => html`<tr class="${a.visible ? "" : "muted"}">
            <td>${a.label}</td>
            <td>${a.audience === "public" ? raw("") : badge(a.audience)}${a.pii ? badge("pii", "warn") : raw("")}${a.visible ? raw("") : html` <span class="small muted">(hidden by a later answer)</span>`}</td>
            <td>${a.type === "markdown" ? markdown(String(a.value ?? "")) : (a.display ?? "—")}</td>
          </tr>`,
        ),
        "",
      )}
    </div>`,
  );

  const speakerRows = detail.speakers.map(
    (s) => html`<tr>
      <td>${s.person ? str(s.person.full_name) : "(removed)"}${s.person ? html`<br><span class="small muted">${str(s.person.email)}</span>` : raw("")}</td>
      <td>${badge(str(s.speaker_role))}</td>
      <td>${badge(str(s.participation_status))}</td>
      <td>${s.is_submitter ? "Submitter" : ""}</td>
    </tr>`,
  );

  const revisionRows = detail.revisions.map((r) => {
    const diff = parseJson<Record<string, { from: unknown; to: unknown }>>(r.diff, {});
    const diffRows = Object.entries(diff).map(
      ([f, d]) => html`<tr><td>${f}</td><td class="small">${String(d.from ?? "—")}</td><td class="small">${String(d.to ?? "—")}</td></tr>`,
    );
    return html`<div class="review-step">
      <h4>#${num(r.revision_number)} — ${badge(str(r.change_kind))} <span class="small muted">${formatInZone(str(r.created_at), data.event.timezone)}</span></h4>
      ${diffRows.length ? table(["Field", "From", "To"], diffRows, "") : html`<p class="small muted">No content diff recorded.</p>`}
    </div>`;
  });

  const entitlementPanel =
    detail.sponsor && detail.entitlement
      ? card(
          html`<p><strong>${str(detail.sponsor.name)}</strong> — ${humanise(str(detail.entitlement.entitlement_type))}</p>
            <p class="small muted">Quantity ${num(detail.entitlement.quantity)}${strOrNull(detail.entitlement.submission_deadline) ? html` · deadline ${str(detail.entitlement.submission_deadline)}` : raw("")}</p>`,
          "Sponsor entitlement",
        )
      : raw("");

  return html`${pageHead(
      str(p.title) || "Untitled proposal",
      `${str(p.reference)} · ${detail.event ? str(detail.event.name) : ""}`,
      html`${badge(str(p.status))}
        ${data.canEdit
          ? html`${actionForm(`/admin/proposals/${str(p.id)}/withdraw`, "Withdraw", { confirm: "Withdraw this proposal?" })}`
          : raw("")}`,
    )}
    <p class="muted">${str(p.abstract)}</p>
    ${entitlementPanel}
    ${card(table(["Speaker", "Role", "Status", ""], speakerRows, "Nobody named yet."), "Speakers")}
    ${joinHtml(answerBlocks)}
    ${data.canEdit ? card(organizerEditForm(data), "Organizer edit") : raw("")}
    ${data.canEdit
      ? card(
          html`<form method="post" action="/admin/proposals/${str(p.id)}/request-changes" class="stack">
            ${field({ name: "note", label: "What needs to change", type: "textarea", rows: 4, required: true })}
            <button type="submit">Request changes</button>
          </form>`,
          "Request changes",
        )
      : raw("")}
    ${card(joinHtml(revisionRows.length ? revisionRows : [empty("No revisions yet.")]), "Revision history")}`;
}

function errorFor(errors: FieldError[], key: string): string | undefined {
  return errors.find((e) => e.field_key === key)?.message;
}

function organizerEditForm(data: AdminDetailData): SafeHtml {
  const p = data.detail.proposal;
  const errors = data.fieldErrors;
  return html`<form method="post" action="/admin/proposals/${str(p.id)}/edit" class="stack">
    ${field({ name: "title", label: "Title", required: true, value: str(p.title), error: errorFor(errors, "title") })}
    ${field({ name: "abstract", label: "Abstract", type: "textarea", rows: 5, required: true, value: str(p.abstract), error: errorFor(errors, "abstract") })}
    ${field({ name: "description", label: "Description (committee only)", type: "textarea", rows: 4, value: strOrNull(p.description) ?? "" })}
    ${field({
      name: "session_format_id",
      label: "Format",
      type: "select",
      value: strOrNull(p.session_format_id) ?? "",
      options: data.formats.map((f) => ({ value: str(f.id), label: str(f.name) })),
    })}
    ${field({ name: "requested_duration_minutes", label: "Duration (minutes)", type: "number", value: p.requested_duration_minutes ?? "" })}
    ${field({
      name: "track_id",
      label: "Submitter's track preference",
      type: "select",
      value: strOrNull(p.track_id) ?? "",
      options: data.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })),
    })}
    ${field({
      name: "assigned_track_id",
      label: "Assigned track",
      type: "select",
      value: strOrNull(p.assigned_track_id) ?? "",
      options: data.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })),
      help: "The chair's decision — may differ from the submitter's preference.",
    })}
    ${field({
      name: "audience_level",
      label: "Audience level",
      type: "select",
      value: strOrNull(p.audience_level) ?? "",
      options: AUDIENCE_LEVEL.map((v) => ({ value: v, label: humanise(v) })),
    })}
    ${field({ name: "keywords", label: "Keywords", value: parseJson<string[]>(p.keywords, []).join(", "), help: "Comma-separated." })}
    ${field({ name: "language", label: "Language", value: str(p.language, "en") })}
    ${field({
      name: "recording_consent",
      label: "Recording consent",
      type: "select",
      value: str(p.recording_consent, "unanswered"),
      options: RECORDING_CONSENT.map((v) => ({ value: v, label: humanise(v) })),
    })}
    ${field({ name: "recording_conditions", label: "Recording conditions", type: "textarea", rows: 2, value: strOrNull(p.recording_conditions) ?? "" })}
    ${field({ name: "coi_disclosure", label: "Conflict of interest disclosure", type: "textarea", rows: 2, value: strOrNull(p.coi_disclosure) ?? "" })}
    ${field({ name: "reason", label: "Reason for this edit", required: true, help: "Shown in the audit trail." })}
    <button type="submit">Save organizer edit</button>
  </form>`;
}
