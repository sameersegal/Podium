/**
 * 02 — Event Configuration: read models.
 *
 * Nothing here writes. `loadFormSpec` is the seam other contexts depend on —
 * submissions renders a draft against it, review reads answers through it —
 * so its signature is part of this context's published surface.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { publicFormSpec } from "@podiumstack/domain/event-config/rules.js";
import {
  cfpStatus,
  evaluateCondition,
  type CfpStatus,
  type ConditionRule,
  type EventStatus,
  type FieldAudience,
  type FieldType,
  type FormFieldSpec,
  type FormSpec,
  type FormStepSpec,
  type MapsTo,
} from "@podiumstack/domain/event-config/types.js";
import { notFound } from "@podiumstack/domain/shared/errors.js";
import { escapeHtml, html, inlineScript, joinHtml, markdown, raw, type SafeHtml } from "../../ui/html.js";

export interface SelectOption {
  value: string;
  label: string;
  description?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

export async function eventRow(app: AppContext, idOrSlug: string): Promise<Row> {
  const row = idOrSlug.startsWith("evt_")
    ? await app.db.byId<Row>("event", idOrSlug)
    : await app.db.first<Row>("event", { slug: idOrSlug });
  if (!row) throw notFound("Event", idOrSlug);
  return row;
}

export async function cfpRow(app: AppContext, cfpId: string): Promise<Row> {
  const row = await app.db.byId<Row>("call_for_proposals", cfpId);
  if (!row) throw notFound("Call for proposals", cfpId);
  return row;
}

/** `CallForProposals.status` is derived, never stored (INV-11-6). */
export async function derivedCfpStatus(app: AppContext, cfp: Row, event?: Row | null): Promise<CfpStatus> {
  const ev = event ?? (await app.db.byId<Row>("event", str(cfp.event_id)));
  return cfpStatus(
    {
      opens_at: str(cfp.opens_at),
      closes_at: str(cfp.closes_at),
      closed_early_at: strOrNull(cfp.closed_early_at),
      published_at: strOrNull(cfp.published_at),
      active_form_id: strOrNull(cfp.active_form_id),
    },
    (str(ev?.status, "draft") as EventStatus) ?? "draft",
    app.now(),
  );
}

/**
 * `Proposal` lives in another context; this is a read of a count the
 * `cfp.closed` payload is specified to carry (10-domain-events.md).
 */
export async function proposalCount(app: AppContext, cfpId: string): Promise<number> {
  return app.db.count("proposal", { cfp_id: cfpId });
}

/* -------------------------------------------------------------------------- */
/* Form specs                                                                  */
/* -------------------------------------------------------------------------- */

function toFieldSpec(r: Row): FormFieldSpec {
  return {
    id: str(r.id),
    step_id: str(r.step_id),
    key: str(r.key),
    label: str(r.label),
    help_text: strOrNull(r.help_text),
    placeholder: strOrNull(r.placeholder),
    type: str(r.type) as FieldType,
    options: parseJson<SelectOption[] | null>(r.options, null),
    is_required: bool(r.is_required),
    validation: parseJson<Record<string, unknown> | null>(r.validation, null),
    visible_when: parseJson<ConditionRule | null>(r.visible_when, null),
    maps_to: str(r.maps_to, "none") as MapsTo,
    audience: str(r.audience, "public") as FieldAudience,
    pii: bool(r.pii),
    identifies_speaker: bool(r.identifies_speaker),
    sort_order: num(r.sort_order),
  };
}

function toStepSpec(r: Row, fields: FormFieldSpec[]): FormStepSpec {
  return {
    id: str(r.id),
    key: str(r.key),
    title: str(r.title),
    description: strOrNull(r.description),
    sort_order: num(r.sort_order),
    visible_when: parseJson<ConditionRule | null>(r.visible_when, null),
    is_optional: bool(r.is_optional),
    fields,
  };
}

/**
 * The whole form, steps and fields ordered.
 *
 * **Other contexts depend on this function.** Submissions binds a draft to a
 * form version and renders it from exactly this shape; do not change the
 * signature without changing them.
 */
export async function loadFormSpec(app: AppContext, formId: string): Promise<FormSpec> {
  const form = await app.db.byId<Row>("submission_form", formId);
  if (!form) throw notFound("Submission form", formId);
  const [steps, fields] = await Promise.all([
    app.db.select<Row>("form_step", { form_id: formId }, { orderBy: "sort_order, id" }),
    app.db.select<Row>("form_field", { form_id: formId }, { orderBy: "sort_order, id" }),
  ]);
  const byStep = new Map<string, FormFieldSpec[]>();
  for (const f of fields) {
    const spec = toFieldSpec(f);
    byStep.set(spec.step_id, [...(byStep.get(spec.step_id) ?? []), spec]);
  }
  return {
    id: str(form.id),
    cfp_id: str(form.cfp_id),
    version: num(form.version),
    status: str(form.status, "draft") as FormSpec["status"],
    steps: steps.map((s) => toStepSpec(s, byStep.get(str(s.id)) ?? [])),
  };
}

/** INV-02-5: at most one `published` form per CFP, so this is unambiguous. */
export async function loadPublishedForm(app: AppContext, cfpId: string): Promise<FormSpec | null> {
  const row = await app.db.first<Row>("submission_form", { cfp_id: cfpId, status: "published" });
  return row ? loadFormSpec(app, str(row.id)) : null;
}

/** The version new drafts bind to — `CallForProposals.active_form_id`. */
export async function loadActiveForm(app: AppContext, cfpId: string): Promise<FormSpec | null> {
  const cfp = await cfpRow(app, cfpId);
  const id = strOrNull(cfp.active_form_id);
  return id ? loadFormSpec(app, id) : loadPublishedForm(app, cfpId);
}

export async function listFormVersions(app: AppContext, cfpId: string): Promise<Row[]> {
  return app.db.select<Row>("submission_form", { cfp_id: cfpId }, { orderBy: "version DESC" });
}

/** The working version the builder edits: the newest draft, else the published one. */
export async function builderForm(app: AppContext, cfpId: string): Promise<FormSpec | null> {
  const versions = await listFormVersions(app, cfpId);
  const draft = versions.find((v) => str(v.status) === "draft");
  const published = versions.find((v) => str(v.status) === "published");
  const chosen = draft ?? published ?? versions[0];
  return chosen ? loadFormSpec(app, str(chosen.id)) : null;
}

/* -------------------------------------------------------------------------- */
/* CFP options                                                                 */
/* -------------------------------------------------------------------------- */

export interface CfpFormatView {
  id: string;
  session_format_id: string;
  name: string;
  slug: string;
  description: string | null;
  default_duration_minutes: number;
  min_duration_minutes: number | null;
  max_duration_minutes: number | null;
  max_speakers: number;
  closes_at_override: string | null;
  max_proposals_per_person: number | null;
  is_available: boolean;
  sort_order: number;
}

export interface CfpTrackView {
  id: string;
  track_id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  closes_at_override: string | null;
  max_proposals_per_person: number | null;
  is_available: boolean;
  sort_order: number;
}

export async function cfpFormatOptions(app: AppContext, cfpId: string, availableOnly = false): Promise<CfpFormatView[]> {
  const options = await app.db.select<Row>("cfp_format_option", { cfp_id: cfpId }, { orderBy: "sort_order, id" });
  const out: CfpFormatView[] = [];
  for (const o of options) {
    if (availableOnly && !bool(o.is_available)) continue;
    const fmt = await app.db.byId<Row>("session_format", str(o.session_format_id));
    if (!fmt) continue; // archived formats drop out (INV-11-2)
    out.push({
      id: str(o.id),
      session_format_id: str(fmt.id),
      name: str(fmt.name),
      slug: str(fmt.slug),
      description: strOrNull(fmt.description),
      default_duration_minutes: num(fmt.default_duration_minutes),
      min_duration_minutes: fmt.min_duration_minutes === null ? null : num(fmt.min_duration_minutes),
      max_duration_minutes: fmt.max_duration_minutes === null ? null : num(fmt.max_duration_minutes),
      max_speakers: num(fmt.max_speakers, 1),
      closes_at_override: strOrNull(o.closes_at_override),
      max_proposals_per_person: o.max_proposals_per_person === null ? null : num(o.max_proposals_per_person),
      is_available: bool(o.is_available),
      sort_order: num(o.sort_order),
    });
  }
  return out;
}

export async function cfpTrackOptions(app: AppContext, cfpId: string, availableOnly = false): Promise<CfpTrackView[]> {
  const options = await app.db.select<Row>("cfp_track_option", { cfp_id: cfpId }, { orderBy: "sort_order, id" });
  const out: CfpTrackView[] = [];
  for (const o of options) {
    if (availableOnly && !bool(o.is_available)) continue;
    const trk = await app.db.byId<Row>("track", str(o.track_id));
    if (!trk) continue;
    out.push({
      id: str(o.id),
      track_id: str(trk.id),
      name: str(trk.name),
      slug: str(trk.slug),
      description: strOrNull(trk.description),
      color: strOrNull(trk.color),
      closes_at_override: strOrNull(o.closes_at_override),
      max_proposals_per_person: o.max_proposals_per_person === null ? null : num(o.max_proposals_per_person),
      is_available: bool(o.is_available),
      sort_order: num(o.sort_order),
    });
  }
  return out;
}

/**
 * "Talk (30 min)", not "Talk (30 min) (30 min)". A `SessionFormat.name` is free
 * text an organizer writes, and writing the duration into it is the obvious
 * thing to do — the seeded event does it for all six formats — so the duration
 * is appended only when the name has not already said it.
 */
export function withDuration(name: string, minutes: number): string {
  return new RegExp(`\\b${minutes}\\s*(min|minute)`, "i").test(name) ? name : `${name} (${minutes} min)`;
}

/**
 * `track_picker` and `format_picker` take their options from the CFP's
 * configuration rather than from typed-in text, so a condition on "format"
 * compares ids that the submitted proposal will actually carry.
 */
export function pickerOptions(
  type: FieldType,
  tracks: CfpTrackView[],
  formats: CfpFormatView[],
): SelectOption[] | null {
  if (type === "track_picker") return tracks.map((t) => ({ value: t.track_id, label: t.name, description: t.description }));
  if (type === "format_picker")
    return formats.map((f) => ({
      value: f.session_format_id,
      label: withDuration(f.name, f.default_duration_minutes),
      description: f.description,
    }));
  return null;
}

/**
 * The options a field actually offers, with pickers resolved. A picker whose
 * call configures nothing falls back to whatever the spec already carries —
 * `publicCfpView` resolves pickers once, against the real track and format
 * ids, and hands the resolved spec on to renderers that no longer hold the
 * configuration; without this fallback those renderers would show an empty
 * dropdown and any condition keyed to a format id would never match.
 */
export function resolvedOptions(field: FormFieldSpec, tracks: CfpTrackView[], formats: CfpFormatView[]): SelectOption[] {
  const picked = pickerOptions(field.type, tracks, formats);
  if (picked && picked.length > 0) return picked;
  return field.options ?? [];
}

/* -------------------------------------------------------------------------- */
/* PublicCfp                                                                   */
/* -------------------------------------------------------------------------- */

export interface PublicCfp {
  event: {
    name: string;
    slug: string;
    tagline: string | null;
    starts_on: string;
    ends_on: string;
    timezone: string;
    logo_url: string | null;
    website_url: string | null;
  };
  cfp: {
    name: string;
    slug: string;
    intro_markdown: string | null;
    guidelines_url: string | null;
    opens_at: string;
    closes_at: string;
    status: CfpStatus;
  };
  tracks: { name: string; slug: string; description: string | null; color: string | null }[];
  formats: {
    name: string;
    slug: string;
    description: string | null;
    default_duration_minutes: number;
    min_duration_minutes: number | null;
    max_duration_minutes: number | null;
    closes_at_override: string | null;
  }[];
  form: {
    id: string;
    version: number;
    steps: FormStepSpec[];
  } | null;
  max_proposals_per_person: number | null;
  allow_edit_after_submit: boolean;
}

async function logoUrl(app: AppContext, assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const asset = await app.db.byId<Row>("asset", assetId);
  // `/assets/:assetId` — keyed by id, not by the R2 `storage_key`, which is
  // where the bytes live and was never itself a routable path.
  return asset ? `/assets/${str(asset.id)}` : null;
}

/**
 * INV-02-12 — readable without authentication for a CFP whose `audience` is
 * `public` on an `active`, `public` event, **in every derived status including
 * `closed`**. A 404 on a link still circulating on social media reads as a
 * broken conference, so a closed call is content, not an error.
 *
 * The projection contains no `FormField` whose `audience != public` and no
 * field marked `pii`.
 */
export async function publicCfpView(
  app: AppContext,
  cfpSlugOrId: string,
  opts: { eventSlug?: string | null; allowNonPublic?: boolean } = {},
): Promise<PublicCfp | null> {
  let cfp: Row | null = null;
  if (cfpSlugOrId.startsWith("cfp_")) {
    cfp = await app.db.byId<Row>("call_for_proposals", cfpSlugOrId);
  } else if (opts.eventSlug) {
    const ev = await app.db.first<Row>("event", { slug: opts.eventSlug });
    if (!ev) return null;
    cfp = await app.db.first<Row>("call_for_proposals", { event_id: str(ev.id), slug: cfpSlugOrId });
  } else {
    cfp = await app.db.first<Row>("call_for_proposals", { slug: cfpSlugOrId });
  }
  if (!cfp) return null;

  const event = await app.db.byId<Row>("event", str(cfp.event_id));
  if (!event) return null;
  if (opts.eventSlug && str(event.slug) !== opts.eventSlug) return null;

  if (!opts.allowNonPublic) {
    if (str(event.status) !== "active" || str(event.visibility) !== "public") return null;
    if (str(cfp.audience) !== "public") return null;
  }

  const status = await derivedCfpStatus(app, cfp, event);
  const [tracks, formats, published] = await Promise.all([
    cfpTrackOptions(app, str(cfp.id), true),
    cfpFormatOptions(app, str(cfp.id), true),
    loadPublishedForm(app, str(cfp.id)),
  ]);

  const form = published ? publicFormSpec(published) : null;
  const withPickers = form
    ? {
        ...form,
        steps: form.steps.map((s) => ({
          ...s,
          fields: s.fields.map((f) => ({ ...f, options: resolvedOptions(f, tracks, formats) })),
        })),
      }
    : null;

  return {
    event: {
      name: str(event.name),
      slug: str(event.slug),
      tagline: strOrNull(event.tagline),
      starts_on: str(event.starts_on),
      ends_on: str(event.ends_on),
      timezone: str(event.timezone, "UTC"),
      logo_url: await logoUrl(app, strOrNull(event.logo_asset_id)),
      website_url: strOrNull(event.website_url),
    },
    cfp: {
      name: str(cfp.name),
      slug: str(cfp.slug),
      intro_markdown: strOrNull(cfp.intro_markdown),
      guidelines_url: strOrNull(cfp.guidelines_url),
      opens_at: str(cfp.opens_at),
      closes_at: str(cfp.closes_at),
      status,
    },
    tracks: tracks.map((t) => ({ name: t.name, slug: t.slug, description: t.description, color: t.color })),
    formats: formats.map((f) => ({
      name: f.name,
      slug: f.slug,
      description: f.description,
      default_duration_minutes: f.default_duration_minutes,
      min_duration_minutes: f.min_duration_minutes,
      max_duration_minutes: f.max_duration_minutes,
      closes_at_override: f.closes_at_override,
    })),
    form: withPickers ? { id: withPickers.id, version: withPickers.version, steps: withPickers.steps } : null,
    max_proposals_per_person: cfp.max_proposals_per_person === null ? null : num(cfp.max_proposals_per_person),
    allow_edit_after_submit: bool(cfp.allow_edit_after_submit),
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering the public form                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render a form spec as read-only HTML — what a visitor sees before they have
 * an account ("the form is inspectable before signup", 02).
 *
 * Conditional fields toggle without a page reload: each conditional field is
 * wrapped in an element carrying its rule, and a small inline script re-runs
 * the same flat all-of evaluation on every change. With scripts blocked the
 * `<noscript>` rule shows every conditional field and explains when it
 * applies, so nothing is invisible (08, "Degrade gracefully").
 */
export function renderPublicForm(
  spec: { steps: FormStepSpec[] },
  opts: { tracks?: CfpTrackView[]; formats?: CfpFormatView[]; disabled?: boolean; namePrefix?: string } = {},
): SafeHtml {
  const tracks = opts.tracks ?? [];
  const formats = opts.formats ?? [];
  const prefix = opts.namePrefix ?? "answer.";
  const labelOf = new Map<string, string>();
  // A condition names another field's *stored value* — for a picker that is an
  // id. Resolving option labels across the whole form, not just within the
  // field being described, is what turns "Shown only when Session format is
  // fmt_01JQ…" into something a submitter can read.
  const optionLabelOf = new Map<string, Map<string, string>>();
  for (const s of spec.steps) {
    for (const f of s.fields) {
      labelOf.set(f.key, f.label);
      optionLabelOf.set(f.key, new Map(resolvedOptions(f, tracks, formats).map((o) => [o.value, o.label])));
    }
  }

  const conditions: Record<string, ConditionRule> = {};
  for (const s of spec.steps) {
    for (const f of s.fields) if (f.visible_when) conditions[f.key] = f.visible_when;
  }

  const steps = spec.steps.map(
    (step, i) => html`<section class="card form-step" data-step-key="${step.key}">
      <h3>Step ${i + 1} · ${step.title}${step.is_optional ? html` <span class="badge">optional</span>` : raw("")}</h3>
      ${step.description ? html`<p class="muted">${step.description}</p>` : raw("")}
      ${step.fields.length === 0
        ? // A dashed empty box for a step that legitimately collects nothing —
          // "Review and submit" always does — reads as a step that failed to
          // load. One muted line says the same thing without the alarm.
          html`<p class="small muted">No questions on this step.</p>`
        : joinHtml(step.fields.map((f) => renderPublicField(f, { tracks, formats, prefix, disabled: opts.disabled, labelOf, optionLabelOf })))}
    </section>`,
  );

  return html`${joinHtml(steps)}${conditionScript(conditions)}`;
}

function describeCondition(rule: ConditionRule, labelOf: Map<string, string>, optionLabel: (k: string, v: unknown) => string): string {
  return rule.all
    .map((c) => {
      const who = labelOf.get(c.field) ?? c.field;
      switch (c.op) {
        case "is_set":
          return `${who} has an answer`;
        case "is_empty":
          return `${who} has no answer`;
        case "in":
          return `${who} is one of ${(Array.isArray(c.value) ? c.value : [c.value]).map((v) => optionLabel(c.field, v)).join(", ")}`;
        case "not_in":
          return `${who} is not one of ${(Array.isArray(c.value) ? c.value : [c.value]).map((v) => optionLabel(c.field, v)).join(", ")}`;
        case "neq":
          return `${who} is not ${optionLabel(c.field, c.value)}`;
        case "gt":
          return `${who} is more than ${String(c.value)}`;
        case "lt":
          return `${who} is less than ${String(c.value)}`;
        default:
          return `${who} is ${optionLabel(c.field, c.value)}`;
      }
    })
    .join(" and ");
}

function renderPublicField(
  f: FormFieldSpec,
  ctx: {
    tracks: CfpTrackView[];
    formats: CfpFormatView[];
    prefix: string;
    disabled?: boolean;
    labelOf: Map<string, string>;
    optionLabelOf: Map<string, Map<string, string>>;
  },
): SafeHtml {
  const options = resolvedOptions(f, ctx.tracks, ctx.formats);
  const optionLabel = (key: string, value: unknown) =>
    ctx.optionLabelOf.get(key)?.get(String(value)) ?? String(value);
  const name = `${ctx.prefix}${f.key}`;
  const id = `pf_${f.key.replace(/[^\w]/g, "_")}`;
  const dis = ctx.disabled ? raw(" disabled") : raw("");
  const req = f.is_required && !ctx.disabled ? raw(" required") : raw("");

  let control: SafeHtml;
  switch (f.type) {
    case "long_text":
    case "markdown":
      control = html`<textarea id="${id}" name="${name}" rows="5" placeholder="${f.placeholder ?? ""}"${req}${dis}></textarea>`;
      break;
    case "single_select":
    case "track_picker":
    case "format_picker":
      control = html`<select id="${id}" name="${name}"${req}${dis}>
        <option value="">— choose —</option>
        ${options.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
      </select>`;
      break;
    case "multi_select":
      control = html`<select id="${id}" name="${name}" multiple size="${Math.min(6, Math.max(3, options.length))}"${dis}>
        ${options.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
      </select>`;
      break;
    case "checkbox":
    case "consent":
      control = html`<label class="checkline"><input type="checkbox" id="${id}" name="${name}" value="1"${dis}> ${f.label}</label>`;
      break;
    case "number":
    case "duration_picker":
      control = html`<input id="${id}" type="number" name="${name}" placeholder="${f.placeholder ?? ""}"${req}${dis}>`;
      break;
    case "date":
      control = html`<input id="${id}" type="date" name="${name}"${req}${dis}>`;
      break;
    case "email":
      control = html`<input id="${id}" type="email" name="${name}" placeholder="${f.placeholder ?? ""}"${req}${dis}>`;
      break;
    case "url":
      control = html`<input id="${id}" type="url" name="${name}" placeholder="${f.placeholder ?? ""}"${req}${dis}>`;
      break;
    case "file":
      control = html`<input id="${id}" type="file" name="${name}"${dis}>`;
      break;
    case "speaker_list":
      control = html`<p class="muted small">You, plus any co-speakers you add by name and email.</p>`;
      break;
    default:
      control = html`<input id="${id}" type="text" name="${name}" placeholder="${f.placeholder ?? ""}"${req}${dis}>`;
  }

  const conditional = f.visible_when
    ? describeCondition(f.visible_when, ctx.labelOf, optionLabel)
    : null;

  return html`<div
    class="field"
    data-field-key="${f.key}"
    ${f.visible_when ? raw(`data-visible-when="${escapeHtml(JSON.stringify(f.visible_when))}"`) : raw("")}
  >
    <label for="${id}">${f.label}${f.is_required ? html` <span class="req">*</span>` : raw("")}</label>
    ${f.help_text ? html`<span class="help">${f.help_text}</span>` : raw("")}
    ${conditional ? html`<span class="help conditional-note">Shown only when ${conditional}.</span>` : raw("")}
    ${control}
  </div>`;
}

/**
 * The same flat all-of evaluation as `evaluateCondition`, inlined so the page
 * needs no bundle. Fields without a rule are never touched.
 */
function conditionScript(conditions: Record<string, ConditionRule>): SafeHtml {
  if (Object.keys(conditions).length === 0) return raw("");
  const payload = JSON.stringify(conditions).replace(/</g, "\\u003c");
  return inlineScript(`
(function(){
  var rules = ${payload};
  var root = document.currentScript.parentNode;
  function answer(key){
    var el = root.querySelector('[data-field-key="'+key+'"]');
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
      var el = root.querySelector('[data-field-key="'+key+'"]');
      if(!el) return;
      var visible = (rules[key].all || []).every(test);
      el.hidden = !visible;
      el.style.display = visible ? '' : 'none';
    });
  }
  root.addEventListener('change', apply);
  root.addEventListener('input', apply);
  apply();
})();
`);
}

/* -------------------------------------------------------------------------- */
/* The field-type catalogue                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How each `FieldType` is presented in the builder's picker.
 *
 * These are `Record<FieldType, …>` rather than lookup objects on purpose: enums
 * are additive (see CLAUDE.md), and a member added to `FIELD_TYPE` without a
 * label here fails the typecheck instead of reaching the picker as a bare
 * `snake_case` token. The picker itself is client-rendered and reads this
 * through `GET /v1/cfps/:cfpId/builder`, so it cannot hold a stale copy.
 */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  short_text: "Short text",
  long_text: "Paragraph",
  markdown: "Markdown",
  email: "Email",
  url: "Link",
  number: "Number",
  single_select: "Choose one",
  multi_select: "Choose several",
  checkbox: "Checkbox",
  date: "Date",
  file: "File upload",
  speaker_list: "Speakers",
  track_picker: "Track",
  format_picker: "Session format",
  duration_picker: "Duration",
  consent: "Consent",
};

export const FIELD_TYPE_HINTS: Record<FieldType, string> = {
  short_text: "One line. Titles, job titles, handles.",
  long_text: "Several lines of plain text.",
  markdown: "Rich text an applicant writes in Markdown.",
  email: "Validated as an address.",
  url: "Validated as a link.",
  number: "Whole or decimal.",
  single_select: "A list you write; exactly one answer.",
  multi_select: "A list you write; any number of answers.",
  checkbox: "A single yes/no box.",
  date: "A calendar date.",
  file: "A slide deck, a headshot, a rider.",
  speaker_list: "The co-speaker invitation control.",
  track_picker: "The tracks this call offers.",
  format_picker: "The session formats this call offers.",
  duration_picker: "The durations the chosen format allows.",
  consent: "A recorded yes, with the wording it was given against.",
};

/** The picker's sections. Order here is the order they are shown in. */
export const FIELD_TYPE_GROUPS: Record<FieldType, "text" | "choice" | "session" | "other"> = {
  short_text: "text",
  long_text: "text",
  markdown: "text",
  email: "text",
  url: "text",
  number: "text",
  single_select: "choice",
  multi_select: "choice",
  checkbox: "choice",
  consent: "choice",
  track_picker: "session",
  format_picker: "session",
  duration_picker: "session",
  speaker_list: "session",
  date: "other",
  file: "other",
};

/** Re-exported so callers need one import for the runtime and the shapes. */
export { evaluateCondition, markdown };
export type { FormSpec, FormStepSpec, FormFieldSpec, CfpStatus };
