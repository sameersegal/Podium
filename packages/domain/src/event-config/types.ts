/**
 * 02 — Event Configuration. Enums, the CFP derived status, and the form
 * runtime's condition rules.
 */

export const EVENT_STATUS = ["draft", "active", "archived"] as const;
export type EventStatus = (typeof EVENT_STATUS)[number];

export const EVENT_MODE = ["in_person", "online", "hybrid"] as const;
export type EventMode = (typeof EVENT_MODE)[number];

export const EVENT_VISIBILITY = ["private", "public"] as const;
export type EventVisibility = (typeof EVENT_VISIBILITY)[number];

export const CFP_AUDIENCE = ["public", "sponsors_only", "invite_only"] as const;
export type CfpAudience = (typeof CFP_AUDIENCE)[number];

export const CFP_STATUS = ["draft", "scheduled", "open", "closed", "archived"] as const;
export type CfpStatus = (typeof CFP_STATUS)[number];

export const LATE_SUBMISSION_POLICY = ["reject", "allow_with_flag"] as const;
export type LateSubmissionPolicy = (typeof LATE_SUBMISSION_POLICY)[number];

export const WITHDRAW_ALLOWED_UNTIL = ["decision", "always", "never"] as const;
export type WithdrawAllowedUntil = (typeof WITHDRAW_ALLOWED_UNTIL)[number];

export const FORM_STATUS = ["draft", "published", "retired"] as const;
export type FormStatus = (typeof FORM_STATUS)[number];

export const FIELD_TYPE = [
  "short_text",
  "long_text",
  "markdown",
  "email",
  "url",
  "number",
  "single_select",
  "multi_select",
  "checkbox",
  "date",
  "file",
  "speaker_list",
  "track_picker",
  "format_picker",
  "duration_picker",
  "consent",
] as const;
export type FieldType = (typeof FIELD_TYPE)[number];

export const MAPS_TO = [
  "none",
  "title",
  "abstract",
  "description",
  "track",
  "format",
  "duration",
  "level",
  "keywords",
  "av_requirements",
  "recording_consent",
  "coi_disclosure",
  "speakers",
] as const;
export type MapsTo = (typeof MAPS_TO)[number];

export const FIELD_AUDIENCE = ["public", "committee_only", "organizer_only"] as const;
export type FieldAudience = (typeof FIELD_AUDIENCE)[number];

export const AV_CAPABILITY = [
  "projector",
  "confidence_monitor",
  "stage_mics",
  "handheld_mics",
  "recording",
  "livestream",
  "hybrid_av",
  "hands_on_power",
  "wifi_dedicated",
] as const;
export type AvCapability = (typeof AV_CAPABILITY)[number];

export const CAPACITY_POLICY = ["open", "ticketed", "capped"] as const;
export type CapacityPolicy = (typeof CAPACITY_POLICY)[number];

export const ORIGIN = ["cfp", "sponsor", "invited"] as const;
export type Origin = (typeof ORIGIN)[number];

export const AUDIENCE_LEVEL = ["beginner", "intermediate", "advanced", "all"] as const;
export type AudienceLevel = (typeof AUDIENCE_LEVEL)[number];

export const RECORDING_CONSENT = ["granted", "denied", "conditional", "unanswered"] as const;
export type RecordingConsent = (typeof RECORDING_CONSENT)[number];

export const TIME_SLOT_KIND = ["session", "keynote", "break", "lunch", "social", "registration"] as const;
export type TimeSlotKind = (typeof TIME_SLOT_KIND)[number];

/**
 * `CallForProposals.status` is derived from `opens_at`/`closes_at` and a manual
 * `closed_early_at` — never stored (INV-11-6).
 */
export function cfpStatus(
  cfp: {
    opens_at: string;
    closes_at: string;
    closed_early_at?: string | null;
    published_at?: string | null;
    active_form_id?: string | null;
  },
  eventStatus: EventStatus,
  now: string,
): CfpStatus {
  if (eventStatus === "archived") return "archived";
  if (!cfp.published_at) return "draft";
  if (cfp.closed_early_at && cfp.closed_early_at <= now) return "closed";
  if (now < cfp.opens_at) return "scheduled";
  if (now > cfp.closes_at) return "closed";
  return "open";
}

/**
 * INV-02-13 — a CFP in derived `status = closed` accepts no new proposal and no
 * edit to an existing one, except where `Proposal.status = changes_requested`
 * or the grace window is still open.
 */
export function acceptsSubmission(
  cfp: { opens_at: string; closes_at: string; closed_early_at?: string | null; published_at?: string | null; grace_period_minutes?: number; late_submission_policy?: LateSubmissionPolicy },
  eventStatus: EventStatus,
  now: string,
): { allowed: boolean; late: boolean; reason?: string } {
  const status = cfpStatus(cfp, eventStatus, now);
  if (status === "open") return { allowed: true, late: false };
  if (status === "draft" || status === "scheduled") {
    return { allowed: false, late: false, reason: "This call for proposals is not open yet." };
  }
  if (status === "archived") return { allowed: false, late: false, reason: "This event has been archived." };
  // closed — grace window, then the late policy
  const graceEnd = new Date(new Date(cfp.closes_at).getTime() + (cfp.grace_period_minutes ?? 0) * 60_000).toISOString();
  if (!cfp.closed_early_at && now <= graceEnd) return { allowed: true, late: false };
  if (!cfp.closed_early_at && cfp.late_submission_policy === "allow_with_flag") return { allowed: true, late: true };
  return { allowed: false, late: false, reason: "This call for proposals has closed." };
}

/* -------------------------------------------------------------------------- */
/* Condition rules                                                             */
/* -------------------------------------------------------------------------- */

export type ConditionOp = "eq" | "neq" | "in" | "not_in" | "is_set" | "is_empty" | "gt" | "lt";

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ConditionRule {
  all: Condition[];
}

/**
 * `visible_when` is deliberately tiny — a flat all-of list, no nesting
 * (02, "Condition rules"). INV-02-8 keeps evaluation a single forward pass.
 */
export function evaluateCondition(rule: unknown, answers: Record<string, unknown>): boolean {
  if (!rule || typeof rule !== "object") return true;
  const all = (rule as ConditionRule).all;
  if (!Array.isArray(all) || all.length === 0) return true;
  return all.every((c) => evaluateOne(c, answers[c.field]));
}

function evaluateOne(c: Condition, actual: unknown): boolean {
  const norm = (v: unknown) => (typeof v === "boolean" ? String(v) : v === null || v === undefined ? "" : String(v));
  switch (c.op) {
    case "eq":
      return norm(actual) === norm(c.value);
    case "neq":
      return norm(actual) !== norm(c.value);
    case "in":
      return Array.isArray(c.value) && c.value.map(norm).includes(norm(actual));
    case "not_in":
      return Array.isArray(c.value) && !c.value.map(norm).includes(norm(actual));
    case "is_set":
      return actual !== undefined && actual !== null && actual !== "" && !(Array.isArray(actual) && actual.length === 0);
    case "is_empty":
      return actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "gt":
      return Number(actual) > Number(c.value);
    case "lt":
      return Number(actual) < Number(c.value);
    default:
      return true;
  }
}

export interface FormFieldSpec {
  id: string;
  step_id: string;
  key: string;
  label: string;
  help_text?: string | null;
  placeholder?: string | null;
  type: FieldType;
  options?: { value: string; label: string; description?: string | null }[] | null;
  is_required: boolean;
  validation?: Record<string, unknown> | null;
  visible_when?: ConditionRule | null;
  maps_to: MapsTo;
  audience: FieldAudience;
  pii: boolean;
  sort_order: number;
}

export interface FormStepSpec {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  sort_order: number;
  visible_when?: ConditionRule | null;
  is_optional: boolean;
  fields: FormFieldSpec[];
}

export interface FormSpec {
  id: string;
  cfp_id: string;
  version: number;
  status: FormStatus;
  steps: FormStepSpec[];
}

/**
 * INV-02-8 — a rule may only reference fields that precede it in step/field
 * order. Cycles are impossible by construction; this is the check that keeps
 * it that way when a form is edited.
 */
export function validateConditionOrdering(form: FormSpec): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const step of [...form.steps].sort((a, b) => a.sort_order - b.sort_order)) {
    for (const c of step.visible_when?.all ?? []) {
      if (!seen.has(c.field)) errors.push(`Step "${step.key}" depends on "${c.field}", which does not come before it.`);
    }
    for (const f of [...step.fields].sort((a, b) => a.sort_order - b.sort_order)) {
      for (const c of f.visible_when?.all ?? []) {
        if (!seen.has(c.field)) errors.push(`Field "${f.key}" depends on "${c.field}", which does not come before it.`);
      }
      seen.add(f.key);
    }
  }
  return errors;
}

/** INV-02-7: mapped fields are unique, and the five required ones must exist. */
export const REQUIRED_MAPPINGS: MapsTo[] = ["title", "abstract", "track", "format", "speakers"];

export function validateMappings(form: FormSpec): string[] {
  const errors: string[] = [];
  const byMapping = new Map<string, string[]>();
  for (const step of form.steps) {
    for (const f of step.fields) {
      if (f.maps_to === "none") continue;
      byMapping.set(f.maps_to, [...(byMapping.get(f.maps_to) ?? []), f.key]);
    }
  }
  for (const [mapping, keys] of byMapping) {
    if (keys.length > 1) errors.push(`More than one field maps to ${mapping}: ${keys.join(", ")}.`);
  }
  for (const required of REQUIRED_MAPPINGS) {
    const keys = byMapping.get(required);
    if (!keys || keys.length === 0) {
      errors.push(`A published form must have a field mapped to ${required}.`);
      continue;
    }
    const fld = form.steps.flatMap((s) => s.fields).find((f) => f.key === keys[0]);
    if (fld && !fld.is_required) errors.push(`The field mapped to ${required} must be required.`);
  }
  return errors;
}

/** Which field types a `maps_to` value may be attached to. */
export const MAPPING_TYPES: Record<Exclude<MapsTo, "none">, FieldType[]> = {
  title: ["short_text"],
  abstract: ["long_text", "markdown"],
  description: ["long_text", "markdown"],
  track: ["track_picker", "single_select"],
  format: ["format_picker", "single_select"],
  duration: ["duration_picker", "number"],
  level: ["single_select"],
  keywords: ["multi_select", "short_text"],
  av_requirements: ["multi_select"],
  recording_consent: ["consent", "single_select", "checkbox"],
  coi_disclosure: ["long_text", "short_text"],
  speakers: ["speaker_list"],
};

/** Which steps and fields are visible given the answers so far. */
export function visibleSteps(form: FormSpec, answers: Record<string, unknown>): FormStepSpec[] {
  return [...form.steps]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((s) => evaluateCondition(s.visible_when, answers))
    .map((s) => ({
      ...s,
      fields: [...s.fields].sort((a, b) => a.sort_order - b.sort_order).filter((f) => evaluateCondition(f.visible_when, answers)),
    }));
}

/** `DraftProgress.percent_complete` — required visible fields answered / total. */
export function percentComplete(form: FormSpec, answers: Record<string, unknown>): number {
  const required = visibleSteps(form, answers).flatMap((s) => s.fields.filter((f) => f.is_required));
  if (required.length === 0) return 100;
  const answered = required.filter((f) => {
    const v = answers[f.key];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });
  return Math.round((answered.length / required.length) * 100);
}
