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

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  evaluateCondition,
  type ConditionRule,
  type FieldType,
  type FormFieldSpec,
  type FormSpec,
  type FormStepSpec,
} from "@podiumstack/domain/event-config/types.js";
import type { FieldError } from "@podiumstack/domain/shared/errors.js";
import { formatInZone } from "@podiumstack/domain/shared/time.js";
import { answerDisplay } from "@podiumstack/domain/submissions/answer-display.js";
import { isBlank, type AnswerMap } from "@podiumstack/domain/submissions/answers.js";
import { nextAction, type EditAffordance, type NextAction } from "@podiumstack/domain/submissions/types.js";
import { cfpFormatOptions, cfpTrackOptions, resolvedOptions, type CfpFormatView, type CfpTrackView } from "../event-config/views.js";
import { escapeHtml, html, inlineScript, joinHtml, markdown, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, progressBar, stat, table } from "../../ui/layout.js";
import { plural, Spell } from "../../ui/words.js";
import type { EventRef } from "../../ui/shell.js";
import { visibleSteps, editAffordance, allFields } from "./service.js";
import type {
  ProposalDetail,
  DashboardInvitation,
  DashboardTask,
  SessionRecord,
  SubmitterDashboard,
} from "./views.js";
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
  return inlineScript(`
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
`);
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
            ${raw(`data-confirm="${escapeHtml(`Remove ${r.full_name} from this proposal?`)}"`)}
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

/**
 * `/portal` — the speaker's page.
 *
 * One page about one talk, not a dashboard of cards about several. A speaker
 * opens this three times a year and always for the same reason: *is there
 * anything I have to do, and where has my talk got to.* The page answers those
 * two in that order and puts everything else — the other talks, the profile —
 * below the fold as one line each.
 *
 * R13 is the shape of it. `Proposal` and `Session` stay separate in the model
 * and are presented here as one record: the timeline is the arc a single talk
 * travels, not two rows a reader has to reconcile.
 *
 * Three rules:
 *
 * - **One primary action on the page.** It lives in the "Do this first" block
 *   and nowhere else. If a speaker has to choose between two filled buttons,
 *   the page has failed to say which one matters.
 * - **A deadline is stated with its consequence.** "Overdue since 10 February"
 *   is a fact; "· blocks your listing" is the reason anybody should care.
 * - **Nothing here needs a script** (08, "Degrade gracefully").
 */
export function portalHomeView(dash: SubmitterDashboard, records: SessionRecord[]): SafeHtml {
  if (records.length === 0 && dash.invitations.length === 0) {
    return html`
      <p class="eyebrow">Your talks</p>
      <h1>You have not started a proposal yet</h1>
      <p class="lede">When you submit one, this page becomes the talk: where it has got to, and what is still waiting on you.</p>
      <p class="actions"><a class="btn" href="/">Find an open call</a></p>
    `;
  }

  // The lead is whatever is most urgent. `sessionRecords` already orders them,
  // so this only pulls a talk that is actually waiting on the reader to the
  // front of a list that would otherwise be chronological.
  const ranked = [...records].sort((a, b) => urgencyRank(a) - urgencyRank(b));
  const lead = ranked[0] ?? null;
  const others = ranked.slice(1);

  return html`
    ${dash.invitations.length ? invitationsBlock(dash.invitations) : raw("")}
    ${lead ? leadTalk(lead) : raw("")}
    ${others.length ? otherTalks(others) : raw("")}
    ${profileSection(dash)}
  `;
}

/** Waiting on you, then in flight, then finished. */
function urgencyRank(r: SessionRecord): number {
  if (r.next_action?.urgency === "err") return 0;
  if (r.next_action?.urgency === "warn") return 1;
  if (r.tasks.some((t) => t.overdue)) return 1;
  if (r.tasks.length > 0) return 2;
  if (r.stage === "Delivered" || r.tone === "") return 4;
  return 3;
}

function leadTalk(r: SessionRecord): SafeHtml {
  const open = r.tasks.filter((t) => t.status !== "completed" && t.status !== "waived");
  const done = r.tasks.length - open.length;
  return html`
    <p class="eyebrow">${r.event_name}</p>
    <h1>${r.title}</h1>
    <p class="lede">${stateLine(r, open.length)}</p>

    ${doThisFirst(r)}

    <section class="section">
      <div class="section-head"><p class="eyebrow">Where it has got to</p></div>
      ${arc(r)}
    </section>

    ${r.tasks.length
      ? html`<section class="section">
          <div class="section-head">
            <p class="eyebrow">What we need from you</p>
            <span class="spacer"></span>
            <span class="count">${done} of ${r.tasks.length} done</span>
          </div>
          <ul class="tasks">${joinHtml(r.tasks.map((t) => taskLine(t, r.event_timezone)))}</ul>
        </section>`
      : raw("")}
  `;
}

/**
 * One sentence saying what the talk is and how much is outstanding. It replaces
 * a status badge, which named the state without saying what follows from it.
 */
function stateLine(r: SessionRecord, open: number): string {
  const shape = [r.session?.status === "cancelled" ? null : r.stage].filter(Boolean).join("");
  const waiting =
    open === 0
      ? "Nothing is waiting on you."
      : open === 1
        ? "One thing is waiting on you."
        : `${Spell(open)} things are waiting on you.`;
  return `${shape}. ${waiting}`;
}

/**
 * The one thing to do, in the only block on the page that carries a filled
 * button. Absent when there is nothing to do, rather than rendered empty with
 * an encouraging sentence in it.
 */
function doThisFirst(r: SessionRecord): SafeHtml {
  const action = r.next_action;
  const awaitingConfirmation = r.session?.status === "pending_confirmation";
  // When nothing about the talk itself is urgent, the block belongs to the
  // nearest outstanding task — a speaker with three things owed and no block
  // here has a page that says "three things are waiting on you" and then
  // declines to say which one to start with.
  if (!awaitingConfirmation && (!action?.label || action.urgency === "info")) {
    const soonest = r.tasks
      .filter((t) => t.status !== "completed" && t.status !== "waived")
      .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"))[0];
    if (!soonest) return raw("");
    return html`<div class="do-first">
      <p class="eyebrow">Do this first</p>
      <h2>${soonest.title}</h2>
      <p>
        ${soonest.overdue && soonest.due_at
          ? `It was due ${formatInZone(soonest.due_at, r.event_timezone, { day: "numeric", month: "long" })}.`
          : soonest.due_at
            ? `It is due ${formatInZone(soonest.due_at, r.event_timezone, { day: "numeric", month: "long" })}.`
            : "There is no deadline on this one."}
        ${soonest.is_blocking
          ? "Until it is done, your session stays off the public schedule."
          : "It is the next thing the event needs from you."}
      </p>
      <div class="actions"><a class="btn accent" href="/portal/tasks/${soonest.id}">Open it</a></div>
    </div>`;
  }
  if (!action?.label) return raw("");
  return html`<div class="do-first">
    <p class="eyebrow">Do this first</p>
    <h2>${awaitingConfirmation ? "Confirm you are still speaking" : action.label}</h2>
    <p>
      ${awaitingConfirmation
        ? action.deadline
          ? `We need to hear from you by ${formatInZone(action.deadline, r.event_timezone)}. If we do not, the slot is released to somebody on the waitlist.`
          : "Until you confirm, the slot is held but not yours, and it does not go on the public schedule."
        : action.label}
    </p>
    <div class="actions">
      <a class="btn accent" href="${r.href}">${awaitingConfirmation ? "Yes, I am speaking" : "Open it"}</a>
      ${awaitingConfirmation && r.proposal
        ? html`<a class="btn secondary" href="/portal/proposals/${r.proposal.id}">I need to withdraw</a>`
        : raw("")}
    </div>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* the arc                                                                     */
/* -------------------------------------------------------------------------- */

interface ArcStep {
  when: string | null;
  name: string;
  detail: string;
  /**
   * Whether this step has happened. The *state* is derived from it rather than
   * declared per step, because "now" has to be exactly one step: two of them
   * lit at once is a timeline that cannot say where the reader is standing,
   * which is the only thing a timeline is for.
   */
  done: boolean;
  quote?: string | null;
}

/**
 * Submitted → reviewed → accepted → confirm → onboarding → on stage.
 *
 * This is R13 made visible: one arc, not a proposal row beside a session row.
 * Steps whose date this reader is not entitled to simply have no date — the
 * label still renders, because "reviewed" having happened is the thing the
 * speaker wants to know, and *when* the committee met is not theirs.
 */
function arc(r: SessionRecord): SafeHtml {
  const p = r.proposal;
  const s = r.session;
  const status = p?.status ?? "";
  const decided = Boolean(p?.decision_published_at) || ["accepted", "waitlisted", "rejected"].includes(status);
  const accepted = status === "accepted" || Boolean(s);
  const confirmed = s ? ["confirmed", "scheduled", "published", "delivered"].includes(s.status) : false;
  const onSchedule = s ? ["scheduled", "published", "delivered"].includes(s.status) : false;

  const tasksDone = r.tasks.length > 0 && r.tasks.every((t) => t.status === "completed" || t.status === "waived");

  const steps: ArcStep[] = [
    {
      when: p?.submitted_at ?? null,
      name: "Submitted",
      detail: p?.cfp_name ? `To ${p.cfp_name}.` : "Your proposal reached the committee.",
      done: Boolean(p?.submitted_at),
    },
    {
      when: null,
      name: "Reviewed",
      detail: decided ? "The committee read it and scored it." : "The committee is reading it. You will hear when the round closes.",
      done: decided,
    },
    {
      when: p?.decision_published_at ?? null,
      name: accepted ? "Accepted" : decided ? "Decided" : "A decision",
      detail: accepted ? "You have a slot in the program." : decided ? r.stage : "One decision, published to everyone at once.",
      done: decided,
      quote: p?.feedback_for_speaker ?? null,
    },
    {
      when: null,
      name: "Confirm your slot",
      detail: confirmed ? "You confirmed. The slot is yours." : "Tell us you are still coming, so the slot stops being provisional.",
      done: confirmed,
    },
    {
      when: null,
      name: "Onboarding",
      detail:
        r.tasks.length === 0
          ? "Bio, headshot and anything else the event needs from you."
          : `${r.tasks.filter((t) => t.status === "completed" || t.status === "waived").length} of ${r.tasks.length} done.`,
      done: tasksDone,
    },
    {
      when: r.starts_at,
      name: "On stage",
      detail: r.starts_at
        ? `${formatInZone(r.starts_at, r.event_timezone)}${r.room_name ? ` · ${r.room_name}` : ""}`
        : onSchedule
          ? "On the public schedule."
          : "Once the schedule is published, your time and room appear here.",
      done: s?.status === "delivered",
    },
  ];

  // Exactly one step is "now": the first one that has not happened. Everything
  // before it is behind you and everything after it is hollow.
  const at = steps.findIndex((step) => !step.done);
  const stateOf = (i: number) => (at === -1 || i < at ? "past" : i === at ? "now" : "future");

  return html`<div class="arc">
    ${joinHtml(
      steps.map((step, i) => {
        const state = stateOf(i);
        return html`<div class="step ${state}">
          <span class="when"
            >${state === "now"
              ? "now"
              : step.when
                ? formatInZone(step.when, r.event_timezone, { day: "numeric", month: "short" })
                : ""}</span
          >
          <span class="track"><span class="dot" aria-hidden="true"></span><span class="line" aria-hidden="true"></span></span>
          <div class="what">
            <p class="name">${step.name}</p>
            <p>${step.detail}</p>
            ${step.quote ? html`<blockquote>${step.quote}</blockquote>` : raw("")}
          </div>
        </div>`;
      }),
    )}
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* tasks, other talks, profile                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A task row says what it is, when it is due, and *what happens if it is not*.
 * "Due 10 February" is a date; "blocks your listing" is the reason to open it.
 */
function taskLine(t: DashboardTask, timezone: string): SafeHtml {
  const done = t.status === "completed" || t.status === "waived";
  const consequence = t.is_blocking ? " · blocks your listing" : "";
  const due = done
    ? t.status === "waived"
      ? "Waived"
      : "Done"
    : t.overdue && t.due_at
      ? `Overdue since ${formatInZone(t.due_at, timezone, { day: "numeric", month: "long" })}${consequence}`
      : t.due_at
        ? `Due ${formatInZone(t.due_at, timezone, { day: "numeric", month: "long" })}${consequence}`
        : `No deadline${consequence}`;
  return html`<li class="${done ? "done" : t.overdue ? "overdue" : ""}">
    <span class="circle" aria-hidden="true">${done ? "✓" : ""}</span>
    <div class="body">
      <p class="name">${t.title}</p>
      <p class="due">${due}</p>
    </div>
    <span class="actions"><a class="btn secondary small" href="/portal/tasks/${t.id}">${done ? "View" : "Open"}</a></span>
  </li>`;
}

function otherTalks(records: SessionRecord[]): SafeHtml {
  return html`<section class="section">
    <div class="section-head"><p class="eyebrow">Your other talks</p></div>
    <ul class="other-talks">
      ${joinHtml(
        records.map(
          (r) => html`<li>
            <span class="state">${r.percent_complete !== null && r.proposal?.status === "draft" ? `Draft · ${r.percent_complete}%` : r.stage}</span>
            <span class="title"><a href="${r.href}">${r.title}</a></span>
            <span class="nudge">${nudge(r)}</span>
          </li>`,
        ),
      )}
    </ul>
  </section>`;
}

/** The one thing worth saying about a talk that is not the one you are on. */
function nudge(r: SessionRecord): string {
  const overdue = r.tasks.filter((t) => t.overdue).length;
  if (overdue > 0) return `${plural(overdue, "task")} overdue`;
  if (r.next_action?.urgency === "err" || r.next_action?.urgency === "warn") return r.next_action.label;
  if (r.starts_at) return formatInZone(r.starts_at, r.event_timezone, { day: "numeric", month: "short" });
  return r.event_name;
}

function invitationsBlock(invitations: DashboardInvitation[]): SafeHtml {
  return html`<div class="do-first">
    <p class="eyebrow">Do this first</p>
    <h2>${invitations.length === 1 ? "You have been asked to co-speak" : `${Spell(invitations.length)} people have asked you to co-speak`}</h2>
    ${joinHtml(
      invitations.map(
        (i) => html`<p>
            <strong>${i.title}</strong> — ${i.event_name}${i.invited_by ? `, from ${i.invited_by}` : ""}. Until you accept, you are not
            listed on it and it does not appear among your talks.
          </p>
          <div class="actions">
            <form method="post" action="/portal/proposals/${i.proposal_id}/invitation/accept" class="inline-form">
              <button type="submit" class="accent">Yes, I am speaking</button>
            </form>
            <form method="post" action="/portal/proposals/${i.proposal_id}/invitation/decline" class="inline-form">
              <button type="submit" class="secondary">No, take my name off</button>
            </form>
          </div>`,
      ),
    )}
  </div>`;
}

function profileSection(dash: SubmitterDashboard): SafeHtml {
  return html`<section class="section">
    <div class="section-head">
      <p class="eyebrow">Your profile</p>
      <span class="spacer"></span>
      <span class="count">${dash.profile.completeness}% complete</span>
    </div>
    <p>
      ${dash.profile.is_listed
        ? "Your bio and headshot are what the public speaker page shows."
        : "You are not listed publicly. Nothing about you appears on the event site."}
    </p>
    <p class="actions"><a class="btn secondary" href="/portal/profile">Edit your profile</a></p>
  </section>`;
}

function urgencyClass(u: NextAction["urgency"]): string {
  return u === "err" ? "urgency-err" : u === "warn" ? "urgency-warn" : "";
}

/* -------------------------------------------------------------------------- */
/* Proposal list + read view                                                  */
/* -------------------------------------------------------------------------- */

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
