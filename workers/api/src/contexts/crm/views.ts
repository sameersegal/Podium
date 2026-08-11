/**
 * Speaker CRM — HTML for the directory, the dashboard, segments and the
 * sourcing-pipeline kanban board (14-speaker-crm.md).
 *
 * "Filters compose with AND, and every filtered set is directly actionable —
 * a filter you cannot act on is a filter you export to a spreadsheet." That
 * principle shapes the directory: the table and the bulk-action form are the
 * same `<form>`, so a checkbox selection survives into "add to segment",
 * "enrol in a pipeline" and "push to an event" without JavaScript.
 *
 * "A dashboard number you cannot click is a number you cannot act on" shapes
 * the dashboard the same way: every stat is a link into a filtered directory
 * built from the same `DirectoryCriteria` the filter form uses.
 */

import { str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { PARTICIPANT_STATUS } from "@podiumconf/domain/identity/types.js";
import type { DirectoryCriteria, StageSpec } from "@podiumconf/domain/crm/index.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { badge, card, empty, field, humanise, pageHead, stat, table } from "../../ui/layout.js";
import type { CardView, CrmDashboard, DirectoryRow, PipelineView, SegmentView } from "./service.js";

/* -------------------------------------------------------------------------- */
/* The directory                                                              */
/* -------------------------------------------------------------------------- */

function criteriaQuery(c: DirectoryCriteria): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(c)) if (v) params.set(k, String(v));
  return params.toString();
}

/** A `DirectoryCriteria` as the query string a segment or a dashboard widget links to. */
export function directoryLink(c: DirectoryCriteria): string {
  const qs = criteriaQuery(c);
  return qs ? `/admin/contacts?${qs}` : "/admin/contacts";
}

export function directoryFiltersFrom(url: URL): DirectoryCriteria {
  const c: DirectoryCriteria = {};
  for (const key of ["q", "company", "job_title", "tag", "custom_field_key", "custom_field_value", "event_id", "participant_status", "last_contacted_before"] as const) {
    const v = url.searchParams.get(key);
    if (v) c[key] = v;
  }
  const spoken = url.searchParams.get("spoken");
  if (spoken === "yes" || spoken === "no") c.spoken = spoken;
  return c;
}

function filterForm(c: DirectoryCriteria, facets: { companies: string[]; tags: string[] }, events: Row[]): SafeHtml {
  return html`<form method="get" action="/admin/contacts" class="inline-grid">
    ${field({ name: "q", label: "Search", value: c.q ?? "", placeholder: "Name, email, company or bio" })}
    ${field({ name: "company", label: "Company", type: "select", value: c.company ?? "", options: facets.companies.map((v) => ({ value: v, label: v })) })}
    ${field({ name: "job_title", label: "Job title contains", value: c.job_title ?? "" })}
    ${field({ name: "tag", label: "Tag", type: "select", value: c.tag ?? "", options: facets.tags.map((v) => ({ value: v, label: v })) })}
    ${field({ name: "custom_field_key", label: "Custom field key", value: c.custom_field_key ?? "" })}
    ${field({ name: "custom_field_value", label: "Custom field value", value: c.custom_field_value ?? "" })}
    ${field({ name: "event_id", label: "Event", type: "select", value: c.event_id ?? "", options: events.map((e) => ({ value: str(e.id), label: str(e.name) })) })}
    ${field({ name: "participant_status", label: "Roster status", type: "select", value: c.participant_status ?? "", options: PARTICIPANT_STATUS.map((v) => ({ value: v, label: humanise(v) })) })}
    ${field({ name: "spoken", label: "Has spoken", type: "select", value: c.spoken ?? "", options: [{ value: "yes", label: "Has spoken" }, { value: "no", label: "Never spoken" }] })}
    ${field({ name: "last_contacted_before", label: "Not contacted since", type: "date", value: c.last_contacted_before ?? "" })}
    <button type="submit" class="small">Filter</button>
    <a class="button secondary small" href="/admin/contacts">Clear</a>
  </form>`;
}

export function directoryView(input: {
  rows: DirectoryRow[];
  total: number;
  criteria: DirectoryCriteria;
  facets: { companies: string[]; tags: string[] };
  events: Row[];
  segments: SegmentView[];
  pipelines: Row[];
  canWrite: boolean;
}): SafeHtml {
  const { rows, total, criteria, facets, events, segments, pipelines, canWrite } = input;
  const trs = rows.map(
    (r) => html`<tr>
      <td>${canWrite ? html`<input type="checkbox" name="person_id" value="${r.id}">` : raw("")}</td>
      <td><a href="/admin/people/${r.id}"><strong>${r.full_name}</strong></a></td>
      <td class="mono small">${r.email}</td>
      <td>${r.job_title ?? html`<span class="muted">—</span>`}</td>
      <td>${r.company ?? html`<span class="muted">—</span>`}</td>
      <td>${r.tags.map((t) => badge(t))}</td>
      <td>${r.event_count}</td>
      <td>${r.session_count}</td>
      <td class="small">${r.last_activity_at ? r.last_activity_at.slice(0, 10) : html`<span class="muted">—</span>`}</td>
    </tr>`,
  );

  const bulk = canWrite
    ? html`<div class="card">
        <h2>Act on the selected contacts</h2>
        <p class="muted small">Tick rows above, then choose what to do with them.</p>
        <div class="inline-grid">
          ${field({ name: "segment_id", label: "Add to segment", type: "select", options: segments.filter((s) => s.kind === "static").map((s) => ({ value: s.id, label: s.name })) })}
          <button type="submit" name="action" value="add_to_segment" class="small">Add to segment</button>
        </div>
        <div class="inline-grid">
          ${field({ name: "pipeline_id", label: "Enrol in pipeline", type: "select", options: pipelines.map((p) => ({ value: str(p.id), label: str(p.name) })) })}
          <button type="submit" name="action" value="enrol_pipeline" class="small">Enrol</button>
        </div>
        <div class="inline-grid">
          ${field({ name: "event_id", label: "Push to event", type: "select", options: events.map((e) => ({ value: str(e.id), label: str(e.name) })) })}
          <button type="submit" name="action" value="push_to_event" class="small">Push to event</button>
        </div>
        <div class="inline-grid">
          <button type="submit" name="action" value="campaign" class="small secondary">Start a campaign with these contacts</button>
        </div>
      </div>`
    : raw("");

  return html`${pageHead("Contacts", `${total} ${total === 1 ? "person" : "people"} in the directory — the compounding asset a conference builds is the people it knows.`, html`<a class="button secondary" href="/admin/contacts/dashboard">Dashboard</a>`)}
    ${card(filterForm(criteria, facets, events))}
    <form method="post" action="/admin/contacts/bulk">
      ${Object.entries(criteria).map(([k, v]) => html`<input type="hidden" name="criteria.${k}" value="${String(v)}">`)}
      ${table(["", "Name", "Email", "Job title", "Company", "Tags", "Events", "Sessions", "Last activity"], trs, "No contacts match these filters.")}
      ${bulk}
    </form>`;
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export function dashboardView(d: CrmDashboard): SafeHtml {
  return html`${pageHead("Contacts dashboard", "Every number here is a link into a filtered directory — a number you cannot click is a number you cannot act on.")}
    <div class="stats">
      ${stat("contacts", d.contact_count, "/admin/contacts")}
      ${stat("speakers", d.speaker_count, directoryLink({ spoken: "yes" }))}
      ${stat("returning speakers", d.returning_speaker_count)}
      ${stat("events run", d.event_count, "/admin/events")}
    </div>
    ${card(
      d.pipeline_summary.length
        ? table(
            ["Pipeline", "Open", "Won", "Lost"],
            d.pipeline_summary.map(
              (p) => html`<tr><td><a href="/admin/pipelines/${p.pipeline_id}">${p.name}</a></td><td>${p.open}</td><td>${p.won}</td><td>${p.lost}</td></tr>`,
            ),
          )
        : empty("No active pipelines."),
      "Pipelines",
    )}
    ${card(
      d.stalled_cards.length
        ? table(
            ["Person", "Stage", "Days in stage", "Next action"],
            d.stalled_cards.map(
              (c) => html`<tr><td><a href="/admin/pipelines/cards/${c.id}">${c.person_name}</a></td><td>${badge(c.stage_name, c.stage_kind === "lost" ? "err" : c.stage_kind === "won" ? "ok" : "")}</td><td>${c.days_in_stage}</td><td>${c.next_action_at ? c.next_action_at.slice(0, 10) : html`<span class="muted">none set</span>`}</td></tr>`,
            ),
          )
        : empty("Nothing stalled."),
      "Stalled cards",
    )}
    <div class="grid two">
      ${card(
        d.top_companies.length
          ? table(["Company", "Contacts"], d.top_companies.map((c) => html`<tr><td><a href="${directoryLink({ company: c.company })}">${c.company}</a></td><td>${c.n}</td></tr>`))
          : empty("No company data yet."),
        "Top companies",
      )}
      ${card(
        d.top_topics.length
          ? table(["Tag", "Contacts"], d.top_topics.map((t) => html`<tr><td><a href="${directoryLink({ tag: t.tag })}">${t.tag}</a></td><td>${t.n}</td></tr>`))
          : empty("No tags yet."),
        "Top topics",
      )}
    </div>
    ${card(
      d.acquisition_mix.length
        ? table(["Source", "Contacts"], d.acquisition_mix.map((s) => html`<tr><td>${humanise(s.source)}</td><td>${s.n}</td></tr>`), "No data yet.")
        : empty("No data yet."),
      "Acquisition mix",
    )}
    ${card(
      d.outreach_volume.length
        ? table(["Month", "Deliveries"], d.outreach_volume.map((o) => html`<tr><td>${o.month}</td><td>${o.n}</td></tr>`))
        : empty("No outreach recorded yet."),
      "Outreach volume",
    )}`;
}

/* -------------------------------------------------------------------------- */
/* Segments                                                                    */
/* -------------------------------------------------------------------------- */

export function segmentListView(segments: SegmentView[], canWrite: boolean): SafeHtml {
  const rows = segments.map(
    (s) => html`<tr>
      <td><a href="/admin/segments/${s.id}"><strong>${s.name}</strong></a></td>
      <td>${badge(s.kind, s.kind === "dynamic" ? "info" : "")}</td>
      <td class="small muted">${s.criteria_description}</td>
      <td>${s.member_count}</td>
      <td>${badge(str(s.visibility))}</td>
    </tr>`,
  );
  return html`${pageHead(
      "Segments",
      "Saved queries, so “AI infra people we have not asked since 2025” is rebuilt once, not slightly differently every time.",
      canWrite ? html`<a class="button" href="#new-segment">New segment</a>` : raw(""),
    )}
    ${table(["Name", "Kind", "Criteria", "Members", "Visibility"], rows, "No segments yet.")}
    ${canWrite
      ? card(
          html`<form method="post" action="/admin/segments" class="stack" id="new-segment">
            ${field({ name: "name", label: "Name", required: true })}
            ${field({ name: "description", label: "Description", type: "textarea", rows: 2 })}
            ${field({
              name: "kind",
              label: "Kind",
              type: "radio",
              required: true,
              value: "dynamic",
              options: [
                { value: "dynamic", label: "Dynamic", description: "Re-resolves the filter below on every read." },
                { value: "static", label: "Static", description: "A frozen list — start it from the directory's checkboxes." },
              ],
              help: "INV-14-1: choose explicitly. A dynamic segment cannot become a decision, and a static one cannot become a query, without an explicit convert.",
            })}
            ${field({ name: "q", label: "Search (dynamic only)" })}
            ${field({ name: "company", label: "Company (dynamic only)" })}
            ${field({ name: "tag", label: "Tag (dynamic only)" })}
            ${field({ name: "spoken", label: "Has spoken (dynamic only)", type: "select", options: [{ value: "yes", label: "Has spoken" }, { value: "no", label: "Never spoken" }] })}
            <button type="submit">Create segment</button>
          </form>`,
          "New segment",
        )
      : raw("")}`;
}

export function segmentDetailView(input: { segment: SegmentView; members: DirectoryRow[]; canWrite: boolean }): SafeHtml {
  const { segment: s, members, canWrite } = input;
  const rows = members.map(
    (m) => html`<tr><td><a href="/admin/people/${m.id}">${m.full_name}</a></td><td class="mono small">${m.email}</td><td>${m.company ?? "—"}</td></tr>`,
  );
  return html`${pageHead(s.name, s.criteria_description, html`<a class="button secondary" href="${directoryLink(s.criteria)}">View in directory</a>`)}
    <div class="stats">
      ${stat("kind", badge(s.kind, s.kind === "dynamic" ? "info" : ""))}
      ${stat("members", s.member_count)}
      ${stat("visibility", badge(str(s.visibility)))}
    </div>
    ${canWrite
      ? card(
          html`<p class="muted small">Converting is explicit and recorded (INV-14-1): a dynamic segment freezes its current members; a static list starts resolving a query instead.</p>
            <form method="post" action="/admin/segments/${s.id}/convert" class="inline-form" onsubmit="return confirm('Convert this segment to ${s.kind === "dynamic" ? "static" : "dynamic"}?')">
              <input type="hidden" name="to" value="${s.kind === "dynamic" ? "static" : "dynamic"}">
              <button type="submit" class="small secondary">Convert to ${s.kind === "dynamic" ? "static" : "dynamic"}</button>
            </form>
            <a class="button secondary small" href="/admin/campaigns/new?segment_id=${s.id}">Send a campaign to this segment</a>`,
          "Manage",
        )
      : raw("")}
    ${card(table(["Name", "Email", "Company"], rows, "No members yet."), "Members")}`;
}

/* -------------------------------------------------------------------------- */
/* Sourcing pipelines — the kanban board                                       */
/* -------------------------------------------------------------------------- */

export function pipelineListView(pipelines: Row[], canWrite: boolean): SafeHtml {
  const rows = pipelines.map(
    (p) => html`<tr>
      <td><a href="/admin/pipelines/${str(p.id)}"><strong>${str(p.name)}</strong></a></td>
      <td>${badge(str(p.status), str(p.status) === "active" ? "ok" : "")}</td>
      <td>${strOrNull(p.event_id) ?? html`<span class="muted">standing</span>`}</td>
    </tr>`,
  );
  return html`${pageHead("Sourcing pipelines", "The conversation between “we should ask her” and “she has accepted.”", canWrite ? html`<a class="button" href="/admin/pipelines/new">New pipeline</a>` : raw(""))}
    ${table(["Pipeline", "Status", "Event"], rows, "No pipelines yet.")}`;
}

export function pipelineNewFormView(events: Row[]): SafeHtml {
  return html`${pageHead("New pipeline", "A default set of stages ships with every pipeline — an empty board is where this feature dies.")}
    ${card(html`<form method="post" action="/admin/pipelines/new" class="stack">
      ${field({ name: "name", label: "Name", required: true, placeholder: "World's Fair 2027 keynotes" })}
      ${field({ name: "event_id", label: "Event (leave blank for a standing pipeline)", type: "select", options: events.map((e) => ({ value: str(e.id), label: str(e.name) })) })}
      <button type="submit">Create pipeline</button>
    </form>`)}`;
}

function cardTile(c: CardView): SafeHtml {
  return html`<a href="/admin/pipelines/cards/${c.id}" style="text-decoration:none;color:inherit;display:block;margin-bottom:.6rem">
    <strong>${c.person_name}</strong>
    ${c.person_company ? html`<div class="small muted">${c.person_company}</div>` : raw("")}
    ${c.topic ? html`<div class="small">${c.topic}</div>` : raw("")}
    <div class="small muted">${c.score !== null ? html`Score ${c.score} · ` : raw("")}${c.owner_name ?? "Unowned"}</div>
    <div class="small ${c.stalled ? "warn" : "muted"}">${c.days_in_stage} day${c.days_in_stage === 1 ? "" : "s"} in stage${c.stalled ? " — stalled" : ""}</div>
  </a>`;
}

/**
 * A stage per column, using the same `.grid.three` and `card()` primitives as
 * every other admin screen — it collapses to one column per row below the
 * breakpoint without a bespoke kanban layout (F, "one implementation, phone
 * and desktop"). Moving a card is the select-and-submit form on its own
 * detail page: no drag-and-drop, so it works with scripts blocked too.
 */
export function pipelineBoardView(input: { pipeline: PipelineView; cards: CardView[]; directoryOptions: { id: string; label: string }[]; canWrite: boolean }): SafeHtml {
  const { pipeline, cards, directoryOptions, canWrite } = input;
  const columns = pipeline.stages.map((stage) => {
    const stageCards = cards.filter((c) => c.stage_id === stage.id);
    const overLimit = !!stage.wip_limit && stageCards.length > stage.wip_limit;
    return card(
      html`<p>${badge(stage.kind, stage.kind === "won" ? "ok" : stage.kind === "lost" ? "err" : "")}</p>
        <p class="small ${overLimit ? "warn" : "muted"}">${stageCards.length}${stage.wip_limit ? ` / ${stage.wip_limit}` : ""}${overLimit ? " — over the WIP limit" : ""}</p>
        ${stageCards.length ? stageCards.map((c) => cardTile(c)) : empty("No cards.")}`,
      stage.name,
    );
  });

  return html`${pageHead(pipeline.name, humanise(pipeline.status), canWrite ? actionFormLike(pipeline) : raw(""))}
    ${canWrite
      ? card(
          html`<form method="post" action="/admin/pipelines/${pipeline.id}/enrol" class="inline-grid">
            ${field({ name: "person_id", label: "Person", type: "select", required: true, options: directoryOptions.map((o) => ({ value: o.id, label: o.label })) })}
            ${field({ name: "topic", label: "Topic" })}
            ${field({ name: "score", label: "Score (0-100)", type: "number", min: 0, max: 100 })}
            <button type="submit" class="small">Enrol from the directory</button>
          </form>`,
          "Enrol somebody new",
        )
      : raw("")}
    <div class="grid three">${columns}</div>`;
}

function actionFormLike(pipeline: PipelineView): SafeHtml {
  const to = pipeline.status === "active" ? "archived" : "active";
  return html`<form method="post" action="/admin/pipelines/${pipeline.id}/status" class="inline-form">
    <input type="hidden" name="status" value="${to}">
    <button type="submit" class="small secondary">${to === "archived" ? "Archive" : "Reopen"}</button>
  </form>`;
}

export function cardDetailView(input: {
  card: Row;
  pipeline: Row;
  stages: (StageSpec & { id: string; card_count: number })[];
  transitions: Row[];
  notes: Row[];
  personName: string;
  canWrite: boolean;
}): SafeHtml {
  const { card: c, pipeline, stages, transitions, notes, personName, canWrite } = input;
  const stageOptions = stages.map((s) => ({ value: str(s.id), label: str(s.name) }));
  return html`${pageHead(`${personName} — ${str(pipeline.name)}`, str(c.topic) || null, html`<a class="button secondary" href="/admin/pipelines/${str(pipeline.id)}">Back to board</a>`)}
    <div class="stats">
      ${stat("score", c.score ?? "—")}
      ${stat("owner", strOrNull(c.owner_person_id) ? "assigned" : "unowned")}
      ${stat("next action", strOrNull(c.next_action_at)?.slice(0, 10) ?? "—")}
    </div>
    ${canWrite
      ? card(
          html`<form method="post" action="/admin/pipelines/cards/${str(c.id)}/move" class="inline-grid">
              ${field({ name: "stage_id", label: "Move to stage", type: "select", options: stageOptions })}
              ${field({ name: "note", label: "Note" })}
              <button type="submit" class="small">Move</button>
            </form>
            <form method="post" action="/admin/pipelines/cards/${str(c.id)}" class="inline-grid">
              ${field({ name: "topic", label: "Topic", value: str(c.topic) })}
              ${field({ name: "score", label: "Score", type: "number", min: 0, max: 100, value: c.score })}
              ${field({ name: "rationale", label: "Rationale", type: "textarea", rows: 3, value: str(c.rationale) })}
              ${field({ name: "next_action_at", label: "Next action", type: "date", value: strOrNull(c.next_action_at)?.slice(0, 10) ?? "" })}
              <button type="submit" class="small">Save</button>
            </form>
            <form method="post" action="/admin/pipelines/cards/${str(c.id)}/convert" class="inline-form" onsubmit="return confirm('Push to the event? This creates an EventParticipant and copies no profile data.')">
              <button type="submit" class="small secondary">Push to event</button>
            </form>`,
          "Manage this card",
        )
      : raw("")}
    ${card(
      table(
        ["From", "To", "By", "When", "Note"],
        transitions.map(
          (t) => html`<tr><td>${strOrNull(t.from_name) ?? html`<span class="muted">enrolled</span>`}</td><td>${str(t.to_name)}</td><td>${strOrNull(t.moved_by_name) ?? "—"}</td><td class="small">${str(t.created_at).slice(0, 19).replace("T", " ")}</td><td class="small">${strOrNull(t.note) ?? ""}</td></tr>`,
        ),
        "No stage history yet.",
      ),
      "Stage history",
    )}
    ${card(
      notes.length
        ? html`<ul class="timeline">${notes.map((n) => html`<li><span class="small muted">${str(n.created_at).slice(0, 10)}</span> — ${str(n.body)}</li>`)}</ul>`
        : empty("No notes yet."),
      "Notes",
    )}`;
}
