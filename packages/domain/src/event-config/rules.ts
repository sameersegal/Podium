/**
 * 02 — Event Configuration: the pure rules.
 *
 * Everything here is a total function over plain data. The aggregate roots
 * (`Event`, `CallForProposals`, `SubmissionForm`, `Venue`) call into it from
 * `workers/api/src/contexts/event-config/service.ts`, which is where the
 * invariants are actually enforced against persisted state.
 */

import {
  MAPPING_TYPES,
  REQUIRED_MAPPINGS,
  validateConditionOrdering,
  validateMappings,
  type ConditionOp,
  type ConditionRule,
  type EventMode,
  type EventStatus,
  type FieldAudience,
  type FieldType,
  type FormFieldSpec,
  type FormSpec,
  type FormStepSpec,
  type MapsTo,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Event state machine                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The only transitions drawn in the `Event` state diagram (02). A transition
 * that is not drawn does not exist: `draft → archived` is not a thing, and
 * neither is `archived → draft`.
 */
export const EVENT_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ["active"],
  active: ["archived"],
  archived: ["active"], // unarchive (admin, rare)
};

export function canTransitionEvent(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ActivationReadiness {
  day_count: number;
  session_format_count: number;
  room_count: number;
  mode: EventMode;
}

/**
 * INV-02-11 — an `Event` cannot become `active` without at least one
 * `EventDay`, one `SessionFormat`, and — if `mode != online` — one `Room`.
 */
export function activationBlockers(r: ActivationReadiness): string[] {
  const missing: string[] = [];
  if (r.day_count < 1) missing.push("at least one event day");
  if (r.session_format_count < 1) missing.push("at least one session format");
  if (r.mode !== "online" && r.room_count < 1) missing.push("at least one room");
  return missing;
}

/* -------------------------------------------------------------------------- */
/* Session formats                                                             */
/* -------------------------------------------------------------------------- */

export interface DurationSpec {
  default_duration_minutes: number;
  min_duration_minutes?: number | null;
  max_duration_minutes?: number | null;
  max_speakers?: number | null;
}

/** Durations are always integer minutes (11, "Time"), and have to bracket. */
export function durationProblems(d: DurationSpec): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(d.default_duration_minutes) || d.default_duration_minutes <= 0) {
    errors.push("Default duration must be a whole number of minutes greater than zero.");
  }
  if (d.min_duration_minutes != null && d.min_duration_minutes > d.default_duration_minutes) {
    errors.push("Minimum duration cannot be longer than the default duration.");
  }
  if (d.max_duration_minutes != null && d.max_duration_minutes < d.default_duration_minutes) {
    errors.push("Maximum duration cannot be shorter than the default duration.");
  }
  if (d.min_duration_minutes != null && d.max_duration_minutes != null && d.min_duration_minutes > d.max_duration_minutes) {
    errors.push("Minimum duration cannot be longer than the maximum duration.");
  }
  if (d.max_speakers != null && (!Number.isInteger(d.max_speakers) || d.max_speakers < 1)) {
    errors.push("A format must allow at least one speaker.");
  }
  return errors;
}

/* -------------------------------------------------------------------------- */
/* CFP window                                                                  */
/* -------------------------------------------------------------------------- */

export interface CfpWindow {
  opens_at: string;
  closes_at: string;
  overrides?: (string | null | undefined)[];
}

/**
 * INV-02-4 — `closes_at > opens_at`; `CfpFormatOption.closes_at_override`, if
 * set, must be `<= closes_at`.
 */
export function cfpWindowProblems(w: CfpWindow): string[] {
  const errors: string[] = [];
  if (!w.opens_at || !w.closes_at) {
    errors.push("A call for proposals needs both an opening and a closing instant.");
    return errors;
  }
  if (!(new Date(w.closes_at).getTime() > new Date(w.opens_at).getTime())) {
    errors.push("The closing time must be after the opening time.");
  }
  for (const o of w.overrides ?? []) {
    if (!o) continue;
    if (new Date(o).getTime() > new Date(w.closes_at).getTime()) {
      errors.push(`An earlier deadline of ${o} is after the call closes; overrides may only bring a deadline forward.`);
    }
  }
  return errors;
}

/* -------------------------------------------------------------------------- */
/* Form versioning and immutability                                            */
/* -------------------------------------------------------------------------- */

/**
 * INV-02-9 — a published `SubmissionForm`, `FormStep` or `FormField` is
 * immutable except for `sort_order` within a step and cosmetic text (`label`,
 * `help_text`, `description`). Anything else clones a new version.
 */
export const COSMETIC_FIELD_ATTRS = ["label", "help_text", "description", "placeholder", "sort_order"] as const;
export const COSMETIC_STEP_ATTRS = ["title", "description", "sort_order"] as const;

export function isCosmeticFieldPatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).every((k) => (COSMETIC_FIELD_ATTRS as readonly string[]).includes(k));
}

export function isCosmeticStepPatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).every((k) => (COSMETIC_STEP_ATTRS as readonly string[]).includes(k));
}

/** The non-cosmetic attributes of a patch, for the error message. */
export function structuralAttrs(patch: Record<string, unknown>, cosmetic: readonly string[]): string[] {
  return Object.keys(patch).filter((k) => !cosmetic.includes(k));
}

/* -------------------------------------------------------------------------- */
/* Form validation                                                             */
/* -------------------------------------------------------------------------- */

/** INV-02-7 — a mapped field's type is constrained to match its `maps_to`. */
export function mappingTypeProblems(form: FormSpec): string[] {
  const errors: string[] = [];
  for (const step of form.steps) {
    for (const f of step.fields) {
      if (f.maps_to === "none") continue;
      const allowed = MAPPING_TYPES[f.maps_to as Exclude<MapsTo, "none">];
      if (allowed && !allowed.includes(f.type)) {
        errors.push(`Field "${f.key}" maps to ${f.maps_to}, which needs one of: ${allowed.join(", ")} (it is ${f.type}).`);
      }
    }
  }
  return errors;
}

/** INV-02-6 — `FormField.key` is unique within a form. */
export function duplicateKeyProblems(form: FormSpec): string[] {
  const seen = new Map<string, number>();
  for (const step of form.steps) {
    for (const f of step.fields) seen.set(f.key, (seen.get(f.key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => `More than one field uses the key "${k}".`);
}

/**
 * Everything that must hold before a `SubmissionForm` may be published:
 * INV-02-6 (unique keys), INV-02-7 (mappings and their types), INV-02-8
 * (condition ordering).
 */
export function publishBlockers(form: FormSpec): string[] {
  return [
    ...duplicateKeyProblems(form),
    ...validateMappings(form),
    ...mappingTypeProblems(form),
    ...validateConditionOrdering(form),
  ];
}

/** `submission_form.published.changed_field_keys[]` — added, removed or altered. */
export function changedFieldKeys(previous: FormSpec | null, next: FormSpec): string[] {
  const flatten = (f: FormSpec | null) => {
    const out = new Map<string, FormFieldSpec>();
    for (const s of f?.steps ?? []) for (const fld of s.fields) out.set(fld.key, fld);
    return out;
  };
  const before = flatten(previous);
  const after = flatten(next);
  const changed = new Set<string>();
  for (const [key, fld] of after) {
    const prev = before.get(key);
    if (!prev) {
      changed.add(key);
      continue;
    }
    if (fieldSignature(prev) !== fieldSignature(fld)) changed.add(key);
  }
  for (const key of before.keys()) if (!after.has(key)) changed.add(key);
  return [...changed].sort();
}

function fieldSignature(f: FormFieldSpec): string {
  return JSON.stringify({
    label: f.label,
    help_text: f.help_text ?? null,
    placeholder: f.placeholder ?? null,
    type: f.type,
    options: f.options ?? null,
    is_required: f.is_required,
    validation: f.validation ?? null,
    visible_when: f.visible_when ?? null,
    maps_to: f.maps_to,
    audience: f.audience,
    pii: f.pii,
  });
}

/* -------------------------------------------------------------------------- */
/* The public projection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * INV-02-12 — `PublicCfp` contains no `FormField` whose `audience != public`,
 * and no field marked `pii`. This is the single place that filter lives, so
 * the JSON surface and the rendered page cannot disagree.
 */
export function publicFormSpec(form: FormSpec): FormSpec {
  return {
    ...form,
    steps: [...form.steps]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        ...s,
        fields: [...s.fields]
          .sort((a, b) => a.sort_order - b.sort_order)
          .filter((f) => f.audience === "public" && !f.pii),
      })),
  };
}

/* -------------------------------------------------------------------------- */
/* Condition authoring                                                         */
/* -------------------------------------------------------------------------- */

export const CONDITION_OPS: readonly ConditionOp[] = ["eq", "neq", "in", "not_in", "is_set", "is_empty", "gt", "lt"];

export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  not_in: "is not one of",
  is_set: "has any answer",
  is_empty: "has no answer",
  gt: "is greater than",
  lt: "is less than",
};

export function opNeedsValue(op: ConditionOp): boolean {
  return op !== "is_set" && op !== "is_empty";
}

/** Build a `visible_when` rule from the builder's three inputs. */
export function buildConditionRule(field: string, op: ConditionOp, rawValue: string): ConditionRule | null {
  if (!field) return null;
  if (!CONDITION_OPS.includes(op)) return null;
  if (!opNeedsValue(op)) return { all: [{ field, op }] };
  if (rawValue === "" || rawValue === undefined || rawValue === null) return null;
  if (op === "in" || op === "not_in") {
    const list = rawValue
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? { all: [{ field, op, value: list }] } : null;
  }
  return { all: [{ field, op, value: rawValue }] };
}

/** The fields a rule on `target` may legally reference (INV-02-8). */
export function fieldsBefore(form: FormSpec, stepId: string, fieldId?: string | null): FormFieldSpec[] {
  const out: FormFieldSpec[] = [];
  for (const step of [...form.steps].sort((a, b) => a.sort_order - b.sort_order)) {
    for (const f of [...step.fields].sort((a, b) => a.sort_order - b.sort_order)) {
      if (fieldId && f.id === fieldId) return out;
      out.push(f);
    }
    if (!fieldId && step.id === stepId) return out;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Select options                                                              */
/* -------------------------------------------------------------------------- */

export interface SelectOption {
  value: string;
  label: string;
  description?: string | null;
}

/**
 * The builder takes options one per line, either `value|label` or just a
 * label (whose value is then the slugified label).
 */
export function parseOptionLines(src: string, slugify: (s: string) => string): SelectOption[] {
  return src
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.indexOf("|");
      if (bar < 0) return { value: slugify(line), label: line };
      const value = line.slice(0, bar).trim();
      const label = line.slice(bar + 1).trim();
      return { value: value || slugify(label), label: label || value };
    });
}

export function optionLines(options: SelectOption[] | null | undefined): string {
  return (options ?? []).map((o) => (o.value === o.label ? o.label : `${o.value}|${o.label}`)).join("\n");
}

/** Types whose answers come from a fixed list the operator authors. */
export const OPTION_TYPES: readonly FieldType[] = ["single_select", "multi_select"];

/** Types whose options are supplied by the CFP's configuration, not typed in. */
export const CONFIGURED_OPTION_TYPES: readonly FieldType[] = ["track_picker", "format_picker"];

/* -------------------------------------------------------------------------- */
/* The default form                                                            */
/* -------------------------------------------------------------------------- */

export interface FormTemplateField {
  key: string;
  label: string;
  help_text?: string | null;
  placeholder?: string | null;
  type: FieldType;
  options?: SelectOption[] | null;
  is_required: boolean;
  maps_to: MapsTo;
  audience: FieldAudience;
  pii: boolean;
}

export interface FormTemplateStep {
  key: string;
  title: string;
  description?: string | null;
  is_optional: boolean;
  fields: FormTemplateField[];
}

/**
 * "A conventional four-step shape, which the seed data should ship:
 * `your-details` → `the-talk` → `logistics` → `review-and-submit`" (02).
 *
 * Every CFP starts from this, so a freshly created call already satisfies
 * INV-02-7 and can be published without hunting for the five mapped fields.
 */
export const DEFAULT_FORM_TEMPLATE: FormTemplateStep[] = [
  {
    key: "your-details",
    title: "Your details",
    description: "Who is giving this talk. Add co-speakers by name and email — they do not need an account yet.",
    is_optional: false,
    fields: [
      {
        key: "speakers",
        label: "Speakers",
        help_text: "You are added automatically. Add anyone presenting with you.",
        type: "speaker_list",
        is_required: true,
        maps_to: "speakers",
        audience: "public",
        pii: false,
      },
    ],
  },
  {
    key: "the-talk",
    title: "The talk",
    description: null,
    is_optional: false,
    fields: [
      {
        key: "title",
        label: "Title",
        help_text: "The title as you would like it printed in the programme.",
        placeholder: "Shipping agents that do not need a babysitter",
        type: "short_text",
        is_required: true,
        maps_to: "title",
        audience: "public",
        pii: false,
      },
      {
        key: "abstract",
        label: "Abstract",
        help_text: "What the audience will learn. This is what reviewers read first.",
        type: "long_text",
        is_required: true,
        maps_to: "abstract",
        audience: "public",
        pii: false,
      },
      {
        key: "track",
        label: "Track",
        type: "track_picker",
        is_required: true,
        maps_to: "track",
        audience: "public",
        pii: false,
      },
      {
        key: "format",
        label: "Format",
        type: "format_picker",
        is_required: true,
        maps_to: "format",
        audience: "public",
        pii: false,
      },
      {
        key: "level",
        label: "Audience level",
        type: "single_select",
        options: [
          { value: "beginner", label: "Beginner" },
          { value: "intermediate", label: "Intermediate" },
          { value: "advanced", label: "Advanced" },
          { value: "all", label: "All levels" },
        ],
        is_required: false,
        maps_to: "level",
        audience: "public",
        pii: false,
      },
    ],
  },
  {
    key: "logistics",
    title: "Logistics",
    description: "Only the organizing team sees these answers.",
    is_optional: true,
    fields: [
      {
        key: "av_requirements",
        label: "What do you need in the room?",
        type: "multi_select",
        options: [
          { value: "projector", label: "Projector" },
          { value: "confidence_monitor", label: "Confidence monitor" },
          { value: "stage_mics", label: "Stage microphones" },
          { value: "handheld_mics", label: "Handheld microphones" },
          { value: "recording", label: "Recording" },
          { value: "livestream", label: "Livestream" },
          { value: "hands_on_power", label: "Power at every seat" },
          { value: "wifi_dedicated", label: "Dedicated wifi" },
        ],
        is_required: false,
        maps_to: "av_requirements",
        audience: "organizer_only",
        pii: false,
      },
      {
        key: "recording_consent",
        label: "May we record and publish this session?",
        type: "consent",
        is_required: false,
        maps_to: "recording_consent",
        audience: "organizer_only",
        pii: false,
      },
      {
        key: "coi_disclosure",
        label: "Anything the committee should know about a conflict of interest?",
        help_text: "Employment, funding or a commercial relationship with anyone on the programme team.",
        type: "long_text",
        is_required: false,
        maps_to: "coi_disclosure",
        audience: "committee_only",
        pii: false,
      },
    ],
  },
  {
    key: "review-and-submit",
    title: "Review and submit",
    description: "Check everything over. You can come back to a draft until the call closes.",
    is_optional: false,
    fields: [],
  },
];

/** REQUIRED_MAPPINGS re-exported so callers need one import. */
export { REQUIRED_MAPPINGS };

export type { FormSpec, FormStepSpec, FormFieldSpec };
