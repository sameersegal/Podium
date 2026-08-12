/**
 * The submitter-facing multi-step wizard (04, "Submission-time validation" and
 * "Submitter portal read model") plus the rest of the portal's own-proposal
 * screens.
 *
 * Nothing here writes directly to `proposal_answer` / `proposal` — every
 * mutation goes through `service.ts`. This file only renders and shapes what
 * the wizard needs to present one step, or the review-and-submit summary, or
 * the dashboard.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import {
  evaluateCondition,
  type ConditionRule,
  type FieldType,
  type FormFieldSpec,
  type FormSpec,
  type FormStepSpec,
} from "@podiumconf/domain/event-config/types.js";
import type { FieldError } from "@podiumconf/domain/shared/errors.js";
import { answerDisplay } from "@podiumconf/domain/submissions/answer-display.js";
import { isBlank, type AnswerMap } from "@podiumconf/domain/submissions/answers.js";
import { nextAction, type EditAffordance, type NextAction } from "@podiumconf/domain/submissions/types.js";
import { cfpFormatOptions, cfpTrackOptions, resolvedOptions, type CfpFormatView, type CfpTrackView } from "../event-config/views.js";
import { formatInZone } from "@podiumconf/domain/shared/time.js";
import { escapeHtml, html, joinHtml, markdown, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, progressBar, stat, table } from "../../ui/layout.js";
import type { EventRef } from "../../ui/shell.js";
import { visibleSteps, editAffordance, allFields } from "./service.js";
import type { ProposalDetail, DashboardInvitation, DashboardSession, DashboardTask, SubmitterDashboard } from "./views.js";
import type { CfpWindow } from "./service.js";

/* -------------------------------------------------------------------------- */
/* Step shape                                                                  */
/* -------------------------------------------------------------------------- */

export interface WizardStepEntry {
  key: string;
  title: string;
  description: string | null;
  kind: "form" | "review";
  fields: FormFieldSpec[];
}

/** Step-level filtering only — fields are left unfiltered so the client script can toggle them. */
function renderableSteps(form: FormSpec, answers: AnswerMap): FormStepSpec[] {
  return [...form.steps]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((s) => evaluateCondition(s.visible_when, answers))
    .map((s) => ({ ...s, fields: [...s.fields].sort((a, b) => a.sort_order - b.sort_order) }));
}

/**
 * The wizard's own step list. A form step with no fields (the seeded main CFP
 * form ends with one keyed `review-and-submit`) *is* the review screen; a form
 * with none (the sponsor form) gets a synthetic one appended, so every wizard
 * ends with a "review and submit" screen regardless of how the form is built.
 */
export function wizardSteps(form: FormSpec, answers: AnswerMap): WizardStepEntry[] {
  const steps: WizardStepEntry[] = renderableSteps(form, answers).map((s) => ({
    key: s.key,
    title: s.title,
    description: s.description ?? null,
    kind: "form",
    fields: s.fields,
  }));
  if (steps.length === 0) {
    return [{ key: "__review__", title: "Review and submit", description: null, kind: "review", fields: [] }];
  }
  const last = steps[steps.length - 1];
  if (last.fields.length === 0) {
    last.kind = "review";
    if (!last.title) last.title = "Review and submit";
  } else {
    steps.push({
      key: "__review__",
      title: "Review and submit",
      description: "Check everything before you send it.",
      kind: "review",
      fields: [],
    });
  }
  return steps;
}

export function resolveStepKey(steps: WizardStepEntry[], requested: string, fallback: string | null): string {
  if (steps.some((s) => s.key === requested)) return requested;
  if (fallback && steps.some((s) => s.key === fallback)) return fallback;
  return steps[0]?.key ?? "__review__";
}

/* -------------------------------------------------------------------------- */
/* Step indicator                                                             */
/* -------------------------------------------------------------------------- */

function stepIndicator(steps: WizardStepEntry[], currentKey: string, completed: Set<string>, basePath: string): SafeHtml {
  return html`<ul class="steps">
    ${steps.map((s, i) => {
      const cls = s.key === currentKey ? "current" : completed.has(s.key) ? "done" : "";
      return html`<li class="${cls}"><a href="${basePath}/step/${s.key}">${i + 1}. ${s.title}</a></li>`;
    })}
  </ul>`;
}

/* -------------------------------------------------------------------------- */
/* Field controls                                                             */
/* -------------------------------------------------------------------------- */

const NEEDS_EMPTY_SENTINEL = new Set<FieldType>(["multi_select", "checkbox", "consent"]);

function controlFor(
  f: FormFieldSpec,
  value: unknown,
  error: string | undefined,
  opts: { tracks: CfpTrackView[]; formats: CfpFormatView[] },
): SafeHtml {
  const name = `answer.${f.key}`;
  const options = resolvedOptions(f, opts.tracks, opts.formats);
  const sentinel = NEEDS_EMPTY_SENTINEL.has(f.type) ? html`<input type="hidden" name="${name}" value="">` : raw("");

  switch (f.type) {
    case "long_text":
      return html`${sentinel}${field({ name, label: f.label, type: "textarea", rows: 6, required: f.is_required, validate: false, help: f.help_text, value: value ?? "", error })}`;
    case "markdown":
      return html`${sentinel}${field({
        name,
        label: f.label,
        type: "textarea",
        rows: 6,
        required: f.is_required, validate: false,
        help: (f.help_text ? `${f.help_text} ` : "") + "Markdown (headings, bold, italics, links, lists) is supported.",
        value: value ?? "",
        error,
      })}`;
    case "email":
      return field({ name, label: f.label, type: "email", required: f.is_required, validate: false, help: f.help_text, value: value ?? "", error });
    case "url":
      return field({ name, label: f.label, type: "url", required: f.is_required, validate: false, help: f.help_text, value: value ?? "", error });
    case "number":
    case "duration_picker":
      return field({ name, label: f.label, type: "number", required: f.is_required, validate: false, help: f.help_text, value: value ?? "", error });
    case "date":
      return field({ name, label: f.label, type: "date", required: f.is_required, validate: false, help: f.help_text, value: value ?? "", error });
    case "single_select":
    case "track_picker":
    case "format_picker":
      return field({ name, label: f.label, type: "select", required: f.is_required, validate: false, help: f.help_text, value: value ?? "", options, error });
    case "multi_select":
      return html`${sentinel}${field({
        name,
        label: f.label,
        type: "multi_select",
        help: f.help_text,
        value: Array.isArray(value) ? value : [],
        options,
        error,
      })}`;
    case "checkbox":
    case "consent":
      return html`${sentinel}${field({ name, label: f.label, type: "checkbox", required: f.is_required, validate: false, help: f.help_text, value: !!value, error })}`;
    case "file":
      return fileControl(f, value, error);
    case "speaker_list":
      // Rendered by `speakerRosterBlock`, not here — it is a roster, not a value.
      return raw("");
    case "short_text":
    default:
      return field({ name, label: f.label, type: "text", required: f.is_required, validate: false, help: f.help_text, value: value ?? "", error });
  }
}

function fileControl(f: FormFieldSpec, value: unknown, error: string | undefined): SafeHtml {
  const existingIds = value && typeof value === "object" && Array.isArray((value as { asset_ids?: unknown }).asset_ids)
    ? ((value as { asset_ids: unknown[] }).asset_ids as unknown[]).map(String)
    : [];
  return html`<div class="field">
    <label>${f.label}${f.is_required ? html` <span class="req">*</span>` : raw("")}</label>
    ${f.help_text ? html`<span class="help">${f.help_text}</span>` : raw("")}
    ${existingIds.length ? html`<p class="small muted">${existingIds.length} file${existingIds.length === 1 ? "" : "s"} attached already. Choosing a new file replaces it.</p>` : raw("")}
    <input type="file" name="answer.${f.key}">
    ${error ? html`<span class="field-error">${error}</span>` : raw("")}
  </div>`;
}

/** Wraps a control so the client-side condition script can find and toggle it. */
function fieldBlock(f: FormFieldSpec, control: SafeHtml): SafeHtml {
  if (f.type === "speaker_list") return raw(""); // the roster block stands alone
  return html`<div
    data-field-key="${f.key}"
    ${f.visible_when ? raw(`data-visible-when="${escapeHtml(JSON.stringify(f.visible_when))}"`) : raw("")}
  >${control}</div>`;
}

/**
 * The same flat all-of evaluation `evaluateCondition` runs server-side,
 * inlined so a conditional field toggles without a page reload (04, "one
 * control per FieldType ... conditional fields toggled client-side"). Fields
 * with no rule are default-visible and untouched, which is the `<noscript>`-
 * safe fallback: nothing here ever *shows* a field that server rendering hid,
 * only hides ones a script can prove should not be shown yet.
 */
function conditionScript(fields: FormFieldSpec[]): SafeHtml {
  const rules: Record<string, ConditionRule> = {};
  for (const f of fields) if (f.visible_when) rules[f.key] = f.visible_when;
  if (Object.keys(rules).length === 0) return raw("");
  const payload = JSON.stringify(rules).replace(/</g, "\\u003c");
  return raw(`<script>
(function(){
  var rules = ${payload};
  var form = document.currentScript.closest('form');
  if (!form) return;
  function answer(key){
    var el = form.querySelector('[data-field-key="'+key+'"]');
    if(!el) return "";
    var input = el.querySelector('input,select,textarea');
    if(!input) return "";
    if(input.type === 'checkbox') return input.checked ? 'true' : 'false';
    if(input.multiple) return Array.prototype.slice.call(input.selectedOptions).map(function(o){return o.value;});
    return input.value;
  }
  function norm(v){ return v === null || v === undefined ? "" : String(v); }
  function test(c){
    var a = answer(c.field);
    switch(c.op){
      case 'eq': return norm(a) === norm(c.value);
      case 'neq': return norm(a) !== norm(c.value);
      case 'in': return Array.isArray(c.value) && c.value.map(norm).indexOf(norm(a)) >= 0;
      case 'not_in': return Array.isArray(c.value) && c.value.map(norm).indexOf(norm(a)) < 0;
      case 'is_set': return norm(a) !== "" && !(Array.isArray(a) && a.length === 0);
      case 'is_empty': return norm(a) === "" || (Array.isArray(a) && a.length === 0);
      case 'gt': return Number(a) > Number(c.value);
      case 'lt': return Number(a) < Number(c.value);
      default: return true;
    }
  }
  function apply(){
    Object.keys(rules).forEach(function(key){
      var el = form.querySelector('[data-field-key="'+key+'"]');
      if(!el) return;
      var visible = (rules[key].all || []).every(test);
      el.hidden = !visible;
    });
  }
  form.addEventListener('change', apply);
  form.addEventListener('input', apply);
  apply();
})();
</script>`);
}

/* -------------------------------------------------------------------------- */
/* Speaker roster                                                             */
/* -------------------------------------------------------------------------- */

export interface RosterEntry {
  person_id: string;
  full_name: string;
  speaker_role: string;
  participation_status: string;
}

export async function speakerRoster(app: AppContext, _proposalId: string, speakerRows: Row[]): Promise<RosterEntry[]> {
  const out: RosterEntry[] = [];
  for (const s of speakerRows) {
    const person = await app.db.byId<Row>("person", str(s.person_id));
    out.push({
      person_id: str(s.person_id),
      full_name: person ? str(person.full_name) : "(removed)",
      speaker_role: str(s.speaker_role),
      participation_status: str(s.participation_status),
    });
  }
  return out;
}

/**
 * The roster sits inside the step's own `<form>`, and managing a co-speaker is
 * a different POST to a different route — but HTML has no nested forms, and a
 * browser that meets an inner `<form>` closes the outer one, orphaning every
 * control after it (here: the whole rest of the step, plus "Save draft" and
 * "Save and continue"). So the roster's buttons stay where they belong
 * visually and are associated by `form=` id to real form elements emitted
 * after the step form closes. `companionForms` is what the caller must render.
 */
function speakerRosterBlock(
  f: FormFieldSpec,
  roster: RosterEntry[],
  submitterPersonId: string,
  basePath: string,
  origin: string,
  error: string | undefined,
  currentStepKey: string,
): { block: SafeHtml; companionForms: SafeHtml } {
  const active = roster.filter((r) => r.participation_status !== "removed");
  const removable = active.filter((r) => r.speaker_role !== "primary" || origin === "sponsor");
  const formId = (personId: string) => `rmspk_${personId.replace(/[^\w]/g, "_")}`;
  const rows = active.map(
    (r) => html`<tr>
      <td>${r.full_name}${str(r.person_id) === submitterPersonId ? html` <span class="small muted">(you)</span>` : raw("")}</td>
      <td>${badge(r.speaker_role)}</td>
      <td>${badge(r.participation_status)}</td>
      <td class="right">${removable.some((x) => x.person_id === r.person_id)
        ? html`<button
            type="submit"
            form="${formId(r.person_id)}"
            class="small secondary"
            ${raw(`onclick="return confirm('${escapeHtml(`Remove ${r.full_name} from this proposal?`)}')"`)}
          >Remove</button>`
        : raw("")}</td>
    </tr>`,
  );

  const block = html`<div class="field" data-field-key="${f.key}">
    <label>${f.label}${f.is_required ? html` <span class="req">*</span>` : raw("")}</label>
    ${f.help_text ? html`<span class="help">${f.help_text}</span>` : raw("")}
    ${table(["Speaker", "Role", "Status", ""], rows, "Nobody named yet.")}
    <details class="row-edit"><summary>Add a co-speaker</summary>
      <div class="inline-grid">
        ${field({ name: "full_name", label: "Their name", required: true, attrs: 'form="add-cospeaker"' })}
        ${field({
          name: "email",
          label: "Their email",
          type: "email",
          required: true,
          help: "They get a one-time link to confirm.",
          attrs: 'form="add-cospeaker"',
        })}
        <button type="submit" form="add-cospeaker" class="small">Add co-speaker</button>
      </div>
    </details>
    ${error ? html`<span class="field-error">${error}</span>` : raw("")}
  </div>`;

  const companionForms = html`<form method="post" action="${basePath}/speakers" id="add-cospeaker" hidden>
      <input type="hidden" name="redirect_step" value="${currentStepKey}">
    </form>
    ${joinHtml(
      removable.map(
        (r) => html`<form method="post" action="${basePath}/speakers/${r.person_id}/remove" id="${formId(r.person_id)}" hidden>
          <input type="hidden" name="redirect_step" value="${currentStepKey}">
        </form>`,
      ),
    )}`;

  return { block, companionForms };
}

/* -------------------------------------------------------------------------- */
/* Answer summary (review step)                                               */
/* -------------------------------------------------------------------------- */

/**
 * The draft has not been saved as answers a reader would query, so this resolves
 * pickers against the CFP's own options rather than through `referenceLabels` —
 * same `answerDisplay` rule either way, so the review step and the read view
 * cannot drift apart. Assets are not looked up here: mid-wizard, "2 files" is
 * what the submitter needs to know, and `fileControl` says the same thing.
 */
function describeAnswer(f: FormFieldSpec, value: unknown, tracks: CfpTrackView[], formats: CfpFormatView[]): SafeHtml {
  if (f.type === "markdown" && !isBlank(value)) return markdown(String(value));
  const options = resolvedOptions(f, tracks, formats);
  const display = answerDisplay(
    { type: f.type, options },
    value,
    Object.fromEntries(options.map((o) => [o.value, o.label])),
  );
  return display === null ? html`<span class="muted">Not answered</span>` : html`${display}`;
}

/* -------------------------------------------------------------------------- */
/* Page renderers                                                             */
/* -------------------------------------------------------------------------- */

export interface StepPageData {
  proposal: Row;
  event: EventRef;
  form: FormSpec;
  answers: AnswerMap;
  steps: WizardStepEntry[];
  current: WizardStepEntry;
  tracks: CfpTrackView[];
  formats: CfpFormatView[];
  roster: RosterEntry[];
  fieldErrors: FieldError[];
  affordance: EditAffordance;
  window: CfpWindow;
  clientRevision: number;
  submitterPersonId: string;
  progress: Row | null;
}

export function renderWizardPage(data: StepPageData): SafeHtml {
  const basePath = `/portal/proposals/${str(data.proposal.id)}`;
  const completed = new Set(parseJson<string[]>(data.progress?.completed_step_keys, []));
  const errorFor = (key: string) => data.fieldErrors.find((e) => e.field_key === key)?.message;

  const notice = data.affordance.requires_unsubmit
    ? html`<p class="notice info">
        This proposal is already with the committee. The call is still open, so saving a change here updates it and
        resubmits it for you — a new revision the committee sees.
      </p>`
    : raw("");

  if (data.current.kind === "review") {
    return html`${pageHead(str(data.proposal.title) || "Untitled proposal", `${str(data.proposal.reference)} · Review and submit`)}
      ${stepIndicator(data.steps, data.current.key, completed, basePath)}
      ${notice}
      ${data.fieldErrors.length
        ? html`<p class="notice err">${data.fieldErrors.length} thing${data.fieldErrors.length === 1 ? "" : "s"} to fix before this can be submitted — see below.</p>`
        : raw("")}
      ${card(reviewSummary(data), "Review your answers")}
      <p>
        <a class="btn secondary" href="/portal/proposals/${str(data.proposal.id)}">Save and finish later</a>
        <form method="post" action="${basePath}/submit" class="inline-form">
          <button type="submit">Submit proposal</button>
        </form>
      </p>`;
  }

  const fields = data.current.fields;
  const currentIndex = data.steps.findIndex((s) => s.key === data.current.key);
  const nextStepKey = data.steps[currentIndex + 1]?.key ?? data.current.key;

  const companions: SafeHtml[] = [];
  const blocks = fields.map((f) => {
    if (f.type !== "speaker_list") {
      return fieldBlock(f, controlFor(f, data.answers[f.key], errorFor(f.key), { tracks: data.tracks, formats: data.formats }));
    }
    const roster = speakerRosterBlock(
      f,
      data.roster,
      data.submitterPersonId,
      basePath,
      str(data.proposal.origin),
      errorFor(f.key),
      data.current.key,
    );
    companions.push(roster.companionForms);
    return roster.block;
  });

  return html`${pageHead(str(data.proposal.title) || "Untitled proposal", `${str(data.proposal.reference)} · ${data.current.title}`)}
    ${stepIndicator(data.steps, data.current.key, completed, basePath)}
    ${notice}
    ${data.fieldErrors.length
      ? html`<p class="notice err">
          ${data.fieldErrors.length} required answer${data.fieldErrors.length === 1 ? " is" : "s are"} still missing:
          ${data.fieldErrors.map((e) => e.message).join(" ")} Your answers so far are saved — fill these in to continue.
        </p>`
      : raw("")}
    ${card(
      html`<form method="post" action="${basePath}/step/${data.current.key}" enctype="multipart/form-data" class="stack">
        <input type="hidden" name="client_revision" value="${data.clientRevision}">
        <input type="hidden" name="next_step_key" value="${nextStepKey}">
        ${data.current.description ? html`<p class="muted">${data.current.description}</p>` : raw("")}
        ${fields.length === 0 ? empty("Nothing to fill in on this step.") : joinHtml(blocks)}
        <div class="actions">
          <button type="submit" name="save" value="1" class="secondary" formnovalidate>Save draft</button>
          <button type="submit" name="next" value="1">Save and continue</button>
        </div>
        ${conditionScript(fields)}
      </form>
      ${joinHtml(companions)}`,
    )}`;
}

function reviewSummary(data: StepPageData): SafeHtml {
  const formSteps = data.steps.filter((s) => s.kind === "form");
  const errorFor = (key: string) => data.fieldErrors.find((e) => e.field_key === key)?.message;
  const blocks = formSteps.map((s) => {
    const rows = s.fields
      .filter((f) => evaluateCondition(f.visible_when, data.answers))
      .map((f) => {
        const error = errorFor(f.key);
        const answer =
          f.type === "speaker_list"
            ? data.roster.filter((r) => r.participation_status !== "removed").map((r) => r.full_name).join(", ") ||
              html`<span class="muted">Nobody named yet</span>`
            : describeAnswer(f, data.answers[f.key], data.tracks, data.formats);
        return html`<tr class="${error ? "err" : ""}"><td>${f.label}</td><td>${answer}${error ? html`<br><span class="field-error">${error}</span>` : raw("")}</td></tr>`;
      });
    return html`<div class="review-step">
      <h3>${s.title} <a class="small" href="/portal/proposals/${str(data.proposal.id)}/step/${s.key}">Edit</a></h3>
      ${table(["Field", "Answer"], rows, "Nothing on this step.")}
    </div>`;
  });
  return joinHtml(blocks);
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export function dashboardView(dash: SubmitterDashboard): SafeHtml {
  const proposalRows = dash.proposals.map(
    (p) => html`<tr>
      <td><a href="/portal/proposals/${p.id}"><strong>${p.title}</strong></a><br><span class="mono small muted">${p.reference}</span></td>
      <td>${p.event_name}</td>
      <td>${badge(p.status)}</td>
      <td class="${urgencyClass(p.next_action.urgency)}">${p.next_action.label}</td>
      <td class="right">${p.edit.editable ? html`<a class="btn secondary small" href="/portal/proposals/${p.id}">Continue</a>` : raw("")}</td>
    </tr>`,
  );

  const invitationRows = dash.invitations.map(
    (i: DashboardInvitation) => html`<tr>
      <td><strong>${i.title}</strong><br><span class="small muted">${i.event_name}</span></td>
      <td>${badge(i.speaker_role)}</td>
      <td class="right">
        <form method="post" action="/portal/proposals/${i.proposal_id}/invitation/accept" class="inline-form">
          <button type="submit" class="small">Accept</button>
        </form>
        <form method="post" action="/portal/proposals/${i.proposal_id}/invitation/decline" class="inline-form">
          <button type="submit" class="small secondary">Decline</button>
        </form>
      </td>
    </tr>`,
  );

  const sessionRows = dash.sessions.map(
    (s: DashboardSession) => html`<tr>
      <td><a href="/portal/sessions/${s.id}"><strong>${s.title}</strong></a><br><span class="mono small muted">${s.reference}</span></td>
      <td>${s.event_name}</td>
      <td>${badge(s.status)}</td>
      <td>${s.starts_at ? `${s.starts_at} ${s.room_name ? `· ${s.room_name}` : ""}` : html`<span class="muted">Not scheduled yet</span>`}</td>
    </tr>`,
  );

  const taskRows = dash.tasks.map(
    (t: DashboardTask) => html`<tr>
      <td>${t.title}</td>
      <td>${t.event_name}</td>
      <td class="${t.overdue ? "urgency-err" : ""}">${t.due_at ?? html`<span class="muted">No deadline</span>`}${t.overdue ? " (overdue)" : ""}</td>
      <td>${badge(t.status)}</td>
    </tr>`,
  );

  const overdue = dash.tasks.filter((t) => t.overdue).length;
  // A zero state that only states the absence is a dead end. Where there is a
  // next step it says so and links to it.
  const noProposals = html`<p class="empty">You have not started a proposal yet.<br><a class="btn" href="/">Find an open call</a></p>`;

  return html`${pageHead("My dashboard", "Everything you have outstanding across every event.")}
    <div class="stats">
      ${stat("proposals", dash.proposals.length, "/portal/proposals")}
      ${stat("sessions", dash.sessions.length, "/portal/sessions")}
      ${stat("open tasks", dash.tasks.length, "/portal/tasks")}
      ${stat("overdue", overdue, "/portal/tasks")}
      ${stat("profile complete", `${dash.profile.completeness}%`, "/portal/profile")}
    </div>
    ${proposalRows.length ? card(table(["Proposal", "Event", "Status", "Next action", ""], proposalRows), "My proposals") : card(noProposals, "My proposals")}
    ${dash.invitations.length ? card(table(["Proposal", "Role", ""], invitationRows, ""), "Speaking invitations") : raw("")}
    ${card(table(["Session", "Event", "Status", "When"], sessionRows, "Nothing confirmed yet."), "My sessions")}
    ${card(table(["Task", "Event", "Due", "Status"], taskRows, "No open tasks."), "My tasks")}
    ${card(
      html`<div class="progress-row">${progressBar(dash.profile.completeness)}<span class="small muted">${dash.profile.completeness}% complete</span></div>
        <p class="small muted">${dash.profile.is_listed ? "Listed in the speaker directory." : "Not listed publicly."}</p>
        <p class="actions"><a class="btn secondary" href="/portal/profile">Edit my profile</a></p>`,
      "Profile",
    )}`;
}

function urgencyClass(u: NextAction["urgency"]): string {
  return u === "err" ? "urgency-err" : u === "warn" ? "urgency-warn" : "";
}

/* -------------------------------------------------------------------------- */
/* Proposal list + read view                                                  */
/* -------------------------------------------------------------------------- */

export function proposalsListView(proposals: SubmitterDashboard["proposals"]): SafeHtml {
  const rows = proposals.map(
    (p) => html`<tr>
      <td><a href="/portal/proposals/${p.id}"><strong>${p.title}</strong></a><br><span class="mono small muted">${p.reference}</span></td>
      <td>${p.event_name}</td>
      <td>${badge(p.status)}</td>
      <td class="${urgencyClass(p.next_action.urgency)}">${p.next_action.label}</td>
    </tr>`,
  );
  return html`${pageHead("My proposals", "Every proposal you submitted or are credited on, across every event.", html`<a class="btn" href="/portal/proposals/new">Start a proposal</a>`)}
    ${table(["Proposal", "Event", "Status", "Next action"], rows, "You have not started a proposal yet.")}`;
}

export function proposalReadView(detail: ProposalDetail, next: NextAction, canEdit: boolean): SafeHtml {
  const p = detail.proposal;
  const timezone = str(detail.event?.timezone, "UTC");
  const byStep = new Map<string, typeof detail.answer_views>();
  for (const a of detail.answer_views) {
    if (!a.visible) continue;
    byStep.set(a.step_key, [...(byStep.get(a.step_key) ?? []), a]);
  }
  const answerBlocks = [...byStep.entries()].map(
    ([, answers]) => html`<div class="review-step">
      <h3>${answers[0]?.step_title}</h3>
      ${table(
        ["Field", "Answer"],
        answers.map(
          (a) => html`<tr>
            <td>${a.label}</td>
            <td>${a.type === "markdown" ? markdown(String(a.value ?? "")) : (a.display ?? html`<span class="muted">Not answered</span>`)}</td>
          </tr>`,
        ),
        "",
      )}
    </div>`,
  );

  const speakerRows = detail.speakers
    .filter((s) => str(s.participation_status) !== "removed")
    .map(
      (s) => html`<tr>
        <td>${s.person ? str(s.person.full_name) : "(removed)"}</td>
        <td>${badge(str(s.speaker_role))}</td>
        <td>${badge(str(s.participation_status))}</td>
      </tr>`,
    );

  const revisionRows = detail.revisions.map((r) => {
    const diff = parseJson<Record<string, { from: unknown; to: unknown }>>(r.diff, {});
    return html`<tr>
      <td>#${num(r.revision_number)}</td>
      <td>${badge(str(r.change_kind))}</td>
      <td class="small">${Object.keys(diff).join(", ") || "—"}</td>
      <td class="small muted">${formatInZone(str(r.created_at), timezone)}</td>
    </tr>`;
  });

  return html`${pageHead(
      str(p.title) || "Untitled proposal",
      `${str(p.reference)} · ${detail.event ? str(detail.event.name) : ""}`,
      html`${badge(str(p.status))} ${canEdit ? html`<a class="btn secondary" href="/portal/proposals/${str(p.id)}/step/${str(detail.progress?.current_step_key ?? detail.form.steps[0]?.key ?? "")}">Continue editing</a>` : raw("")}`,
    )}
    <p class="${urgencyClass(next.urgency)}">${next.label}</p>
    ${detail.decision && detail.decision.published_at
      ? html`<div class="notice ${str(detail.decision.outcome) === "accept" ? "ok" : ""}">
          <strong>Decision:</strong> ${humanise(str(detail.decision.outcome))}
          ${strOrNull(detail.decision.feedback_for_speaker) ? html`<p>${str(detail.decision.feedback_for_speaker)}</p>` : raw("")}
        </div>`
      : raw("")}
    ${card(table(["Speaker", "Role", "Status"], speakerRows, "Nobody named yet."), "Speakers")}
    ${joinHtml(answerBlocks)}
    ${card(table(["Rev.", "Kind", "Changed", "When"], revisionRows, "No history yet."), "Revision history")}`;
}

/* -------------------------------------------------------------------------- */
/* New proposal picker                                                        */
/* -------------------------------------------------------------------------- */

export function newProposalPickerView(cfps: Row[], entitlementsByEvent: Map<string, Row[]>): SafeHtml {
  if (cfps.length === 0) {
    return html`${pageHead("Start a proposal", "There is nothing open to submit to right now.")}${empty(
      "No call for proposals is currently open for you.",
    )}`;
  }
  const cards = cfps.map((c) => {
    const entitlements = entitlementsByEvent.get(str(c.event_id)) ?? [];
    return card(
      html`<p class="muted">${str(c.event_name)} · closes ${formatInZone(str(c.closes_at), str(c.event_timezone, "UTC"))}${bool(c.is_late) ? html` <span class="badge warn">late submissions flagged</span>` : raw("")}</p>
        <form method="post" action="/portal/proposals/new" class="stack">
          <input type="hidden" name="cfp_id" value="${str(c.id)}">
          ${entitlements.length
            ? field({
                name: "entitlement_id",
                label: "Submitting as a sponsor?",
                type: "select",
                options: entitlements.map((e) => ({ value: str(e.id), label: `${str(e.sponsor_name)} — ${humanise(str(e.entitlement_type))}` })),
                help: "Leave blank to submit through the open call instead.",
              })
            : raw("")}
          <button type="submit">Start "${str(c.name)}"</button>
        </form>`,
      str(c.name),
    );
  });
  return html`${pageHead("Start a proposal", "Pick which call you are submitting to.")}${joinHtml(cards)}`;
}

export { allFields, editAffordance, nextAction, visibleSteps };
