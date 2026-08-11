/**
 * 04, "Why content is both promoted columns and answers".
 *
 * Every answer is a `ProposalAnswer` row keyed by `FormField.key`. The fields
 * the rest of the system reasons about are *also* real columns, written
 * transactionally from the mapped answers via `FormField.maps_to` (INV-02-7).
 *
 * Answers for fields that later become invisible are **retained, not deleted**,
 * and excluded from validation and from committee views.
 */

import {
  visibleSteps,
  type FieldType,
  type FormFieldSpec,
  type FormSpec,
  type MapsTo,
} from "../event-config/types.js";
import type { AudienceLevel, RecordingConsent } from "../event-config/types.js";
import { EMPTY_PROMOTED, type PromotedContent } from "./types.js";

export type AnswerMap = Record<string, unknown>;

/** Every field in the form, whether or not it is currently visible. */
export function allFields(form: FormSpec): FormFieldSpec[] {
  return form.steps.flatMap((s) => s.fields);
}

export function fieldByKey(form: FormSpec, key: string): FormFieldSpec | null {
  return allFields(form).find((f) => f.key === key) ?? null;
}

/** `field_key -> step_key`, so a validation error can be routed to its step. */
export function stepKeyIndex(form: FormSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const step of form.steps) for (const f of step.fields) out[f.key] = step.key;
  return out;
}

export function visibleFieldKeys(form: FormSpec, answers: AnswerMap): Set<string> {
  return new Set(visibleSteps(form, answers).flatMap((s) => s.fields.map((f) => f.key)));
}

/**
 * The answer set a committee view or a validation pass should see: the
 * retained-but-invisible answers are dropped here rather than deleted at rest.
 */
export function visibleAnswers(form: FormSpec, answers: AnswerMap): AnswerMap {
  const keys = visibleFieldKeys(form, answers);
  const out: AnswerMap = {};
  for (const [k, v] of Object.entries(answers)) if (keys.has(k)) out[k] = v;
  return out;
}

export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Coerce a submitted form value into the shape `ProposalAnswer.value` holds for
 * this field type. Autosave "runs none of [the ruleset] beyond type coercion"
 * (04, "Submission-time validation").
 */
export function coerceAnswer(type: FieldType, raw: unknown): unknown {
  const one = Array.isArray(raw) ? raw[0] : raw;
  switch (type) {
    case "number":
    case "duration_picker": {
      if (isBlank(one)) return null;
      const n = Number(one);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    case "checkbox":
    case "consent":
      if (Array.isArray(raw)) return raw.length > 0;
      return raw === true || raw === "1" || raw === "true" || raw === "on" || raw === "yes";
    case "multi_select":
      if (isBlank(raw)) return [];
      return (Array.isArray(raw) ? raw : String(raw).split(",")).map((v) => String(v).trim()).filter((v) => v !== "");
    case "file":
      if (isBlank(raw)) return { asset_ids: [] };
      if (typeof raw === "object" && raw !== null && "asset_ids" in (raw as Record<string, unknown>)) return raw;
      return { asset_ids: (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean) };
    case "speaker_list":
      // Speakers are `ProposalSpeaker` rows; the answer records the roster the
      // submitter saw, not the relationship itself.
      if (isBlank(raw)) return [];
      return Array.isArray(raw) ? raw.map(String) : [String(raw)];
    default:
      return isBlank(one) ? null : String(one);
  }
}

export function assetIdsIn(value: unknown): string[] {
  if (value && typeof value === "object" && "asset_ids" in (value as Record<string, unknown>)) {
    const ids = (value as { asset_ids?: unknown }).asset_ids;
    return Array.isArray(ids) ? ids.map(String) : [];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* maps_to promotion                                                           */
/* -------------------------------------------------------------------------- */

const AUDIENCE_LEVELS = new Set(["beginner", "intermediate", "advanced", "all"]);
const CONSENTS = new Set(["granted", "denied", "conditional", "unanswered"]);

function toRecordingConsent(type: FieldType, value: unknown): RecordingConsent {
  if (type === "consent" || type === "checkbox") return value ? "granted" : "denied";
  const s = String(value ?? "").trim();
  return CONSENTS.has(s) ? (s as RecordingConsent) : "unanswered";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((v) => v !== "");
  if (isBlank(value)) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * Build the promoted `Proposal` columns from the mapped answers. Only *visible*
 * fields promote: an answer to a field whose condition has flipped off is
 * retained at rest but must not go on writing a column nobody can see.
 */
export function promoteAnswers(form: FormSpec, answers: AnswerMap): PromotedContent {
  const out: PromotedContent = { ...EMPTY_PROMOTED, keywords: [], av_requirements: [] };
  const visible = visibleSteps(form, answers);
  for (const step of visible) {
    for (const f of step.fields) {
      if (f.maps_to === "none") continue;
      const value = answers[f.key];
      applyMapping(out, f.maps_to, f.type, value);
    }
  }
  return out;
}

function applyMapping(target: PromotedContent, mapping: MapsTo, type: FieldType, value: unknown): void {
  switch (mapping) {
    case "title":
      target.title = isBlank(value) ? "" : String(value).trim();
      break;
    case "abstract":
      target.abstract = isBlank(value) ? "" : String(value).trim();
      break;
    case "description":
      target.description = isBlank(value) ? null : String(value);
      break;
    case "track":
      target.track_id = isBlank(value) ? null : String(value);
      break;
    case "format":
      target.session_format_id = isBlank(value) ? null : String(value);
      break;
    case "duration": {
      if (isBlank(value)) {
        target.requested_duration_minutes = null;
        break;
      }
      const n = Number(value);
      target.requested_duration_minutes = Number.isFinite(n) ? Math.round(n) : null;
      break;
    }
    case "level": {
      const s = String(value ?? "").trim();
      target.audience_level = AUDIENCE_LEVELS.has(s) ? (s as AudienceLevel) : null;
      break;
    }
    case "keywords":
      target.keywords = toStringArray(value);
      break;
    case "av_requirements":
      target.av_requirements = toStringArray(value);
      break;
    case "recording_consent":
      target.recording_consent = toRecordingConsent(type, value);
      break;
    case "coi_disclosure":
      target.coi_disclosure = isBlank(value) ? null : String(value);
      break;
    case "speakers":
    case "none":
      break;
  }
}

/** Which `maps_to` a form actually uses — drives which columns a partial save may touch. */
export function mappedKeys(form: FormSpec): Partial<Record<MapsTo, string>> {
  const out: Partial<Record<MapsTo, string>> = {};
  for (const f of allFields(form)) if (f.maps_to !== "none") out[f.maps_to] = f.key;
  return out;
}
