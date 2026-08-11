/**
 * `CustomFieldDefinition` — 11, "Custom fields".
 *
 * "Adding a field is deciding its PII class." `pii` and `audience` are required
 * at creation and never defaulted (INV-11-11), because the damage is not two
 * hundred fields, it is one free-text box with a passport number in it.
 */

import { invariantError, validationError, type FieldError } from "../shared/errors.js";
import { isSlug } from "../shared/ids.js";
import { REDACTED } from "../shared/pii.js";
import {
  CUSTOM_FIELD_AUDIENCES,
  CUSTOM_FIELD_TYPES,
  type CustomFieldAudience,
  type CustomFieldType,
} from "./types.js";

export interface CustomFieldDefinitionView {
  id: string;
  key: string;
  label: string;
  help_text?: string | null;
  type: CustomFieldType;
  options?: { value: string; label: string }[] | null;
  is_required: boolean;
  pii: boolean;
  audience: CustomFieldAudience;
  show_in_list: boolean;
  is_filterable: boolean;
  sort_order: number;
  status: "active" | "archived";
}

export interface DefinitionInput {
  key: string;
  label: string;
  type: string;
  /** Deliberately `unknown`: absent is an error, not a default. */
  pii: unknown;
  audience: unknown;
  options?: { value: string; label: string }[] | null;
  is_required?: boolean;
}

/**
 * INV-11-11: a `CustomFieldDefinition` must declare `pii` and `audience` at
 * creation. Both are checked for *presence*, not truthiness — `pii: false` is a
 * decision, `pii: undefined` is an omission, and only the second is rejected.
 */
export function assertDeclaredClassification(input: DefinitionInput): { pii: boolean; audience: CustomFieldAudience } {
  const errors: FieldError[] = [];
  if (input.pii === undefined || input.pii === null || input.pii === "") {
    errors.push({ field_key: "pii", message: "Say whether this field holds personal data. There is no default." });
  }
  const audience = String(input.audience ?? "");
  if (!audience) {
    errors.push({ field_key: "audience", message: "Choose who may see this field. There is no default." });
  } else if (!(CUSTOM_FIELD_AUDIENCES as readonly string[]).includes(audience)) {
    errors.push({ field_key: "audience", message: `${audience} is not one of ${CUSTOM_FIELD_AUDIENCES.join(", ")}.` });
  }
  if (errors.length > 0) {
    throw invariantError(
      "INV-11-11",
      "classification_required",
      "A custom field must declare its PII class and its audience when it is created.",
      { field_errors: errors },
    );
  }
  return { pii: toBool(input.pii), audience: audience as CustomFieldAudience };
}

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "yes";
}

export function assertDefinitionShape(input: DefinitionInput): void {
  const errors: FieldError[] = [];
  if (!isSlug(input.key)) {
    errors.push({ field_key: "key", message: "A key is lowercase letters, digits and hyphens — it is what values are stored under." });
  }
  if (!input.label.trim()) errors.push({ field_key: "label", message: "Give the field a label." });
  if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(input.type)) {
    errors.push({ field_key: "type", message: `${input.type} is not one of ${CUSTOM_FIELD_TYPES.join(", ")}.` });
  }
  if ((input.type === "single_select" || input.type === "multi_select") && !(input.options ?? []).length) {
    errors.push({ field_key: "options", message: "A select field needs at least one option." });
  }
  if (errors.length > 0) throw validationError("That custom field is not valid.", errors);
}

/* -------------------------------------------------------------------------- */
/* Values                                                                      */
/* -------------------------------------------------------------------------- */

/** Coerce and validate one submitted value against its definition. */
export function coerceValue(def: CustomFieldDefinitionView, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return null;
  switch (def.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw fieldError(def, `"${String(raw)}" is not a number.`);
      return n;
    }
    case "checkbox":
      return toBool(raw);
    case "date": {
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fieldError(def, "Use a date in YYYY-MM-DD form.");
      return s;
    }
    case "url": {
      const s = String(raw).trim();
      if (!/^https?:\/\/\S+$/.test(s)) throw fieldError(def, "Use an absolute URL.");
      return s;
    }
    case "single_select": {
      const s = String(raw).trim();
      if (!(def.options ?? []).some((o) => o.value === s)) throw fieldError(def, `"${s}" is not one of the options.`);
      return s;
    }
    case "multi_select": {
      const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(",").map((s) => s.trim());
      const values = list.filter(Boolean);
      for (const v of values) {
        if (!(def.options ?? []).some((o) => o.value === v)) throw fieldError(def, `"${v}" is not one of the options.`);
      }
      return values;
    }
    default:
      return String(raw);
  }
}

function fieldError(def: CustomFieldDefinitionView, message: string) {
  return validationError(`${def.label}: ${message}`, [{ field_key: `custom.${def.key}`, message }]);
}

export function assertRequiredPresent(defs: CustomFieldDefinitionView[], values: Record<string, unknown>): void {
  const errors: FieldError[] = [];
  for (const def of defs) {
    // "required at the surface that edits it, never retroactively".
    if (def.status !== "active" || !def.is_required) continue;
    const v = values[def.key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      errors.push({ field_key: `custom.${def.key}`, message: `${def.label} is required.` });
    }
  }
  if (errors.length > 0) throw validationError("Some required fields are missing.", errors);
}

/* -------------------------------------------------------------------------- */
/* Redaction and audience                                                      */
/* -------------------------------------------------------------------------- */

/**
 * INV-11-11, second half: values of `pii` fields are redacted wherever the
 * built-in PII fields are, and values whose `audience != public` never reach a
 * publication snapshot or a public response.
 */
export function redactCustomValues(
  defs: CustomFieldDefinitionView[],
  values: Record<string, unknown>,
  opts: { includePii: boolean; surface?: "internal" | "public" },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(values ?? {})) {
    const def = byKey.get(key);
    if (!def) {
      // A value whose definition is gone is not classified, so it is not shown.
      if (opts.surface === "public") continue;
      out[key] = value;
      continue;
    }
    if (opts.surface === "public" && def.audience !== "public") continue;
    if (def.pii && !opts.includePii) {
      out[key] = value === null || value === undefined ? value : REDACTED;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The keys a publication snapshot may carry for a subject type. */
export function publicKeys(defs: CustomFieldDefinitionView[]): string[] {
  return defs.filter((d) => d.audience === "public" && !d.pii && d.status === "active").map((d) => d.key);
}

/* -------------------------------------------------------------------------- */
/* Usage (R27)                                                                 */
/* -------------------------------------------------------------------------- */

export interface DefinitionUsage {
  definition_id: string;
  key: string;
  /** Subjects with a non-empty value, over subjects that could have one. */
  filled: number;
  total: number;
  fill_rate: number;
  last_used_at: string | null;
}

export function usageOf(
  def: CustomFieldDefinitionView,
  subjects: { values: Record<string, unknown>; updated_at?: string | null }[],
): DefinitionUsage {
  let filled = 0;
  let last: string | null = null;
  for (const s of subjects) {
    const v = s.values?.[def.key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    filled++;
    const at = s.updated_at ?? null;
    if (at && (!last || at > last)) last = at;
  }
  return {
    definition_id: def.id,
    key: def.key,
    filled,
    total: subjects.length,
    fill_rate: subjects.length === 0 ? 0 : filled / subjects.length,
    last_used_at: last,
  };
}
