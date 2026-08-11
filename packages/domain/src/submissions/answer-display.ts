/**
 * `ProposalAnswer.display` (04, "An answer's value is not what a reader sees").
 *
 * `ProposalAnswer.value` holds whatever the field type stores, and four of those
 * types store *references*: `track_picker` and `format_picker` hold a `trk_…` /
 * `fmt_…` id, `speaker_list` holds `per_…` ids, `file` holds `{asset_ids:[…]}`.
 * A `single_select` stores an option's value, not its label, and a `consent`
 * stores a boolean. None of those read as anything to a human, so every surface
 * that shows an answer to a person renders `display` rather than `value`.
 *
 * Derived, therefore computed at read time and never stored (11-cross-cutting,
 * "Derived fields"): the labels it resolves against are other entities' names,
 * which move on their own.
 */

import type { FieldType } from "../event-config/types.js";
import { assetIdsIn, isBlank } from "./answers.js";

export interface DisplayableField {
  type: FieldType;
  /** The field's own options, for `single_select` / `multi_select`. */
  options?: { value: string; label: string; description?: string | null }[] | null;
}

/** `id -> name`, for every reference the answers of one proposal hold. */
export type ReferenceLabels = Readonly<Record<string, string>>;

/** The field types whose answer holds ids rather than something a human typed. */
export const REFERENCE_FIELD_TYPES = [
  "track_picker",
  "format_picker",
  "speaker_list",
  "file",
] as const satisfies readonly FieldType[];

export function isReferenceField(type: FieldType): boolean {
  return (REFERENCE_FIELD_TYPES as readonly FieldType[]).includes(type);
}

/**
 * A reference whose target is gone — a hard-deleted track, a person whose row a
 * reader may not see. The id is deliberately not shown as a fallback: it names
 * nothing, and printing it is the defect this module exists to prevent.
 */
export const UNRESOLVED_REFERENCE = "(no longer available)";

/** Every id an answer of this type holds, so a caller can look them all up in one pass. */
export function referenceIdsIn(type: FieldType, value: unknown): string[] {
  switch (type) {
    case "track_picker":
    case "format_picker":
      return isBlank(value) ? [] : [String(value)];
    case "speaker_list":
      if (isBlank(value)) return [];
      return (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== "");
    case "file":
      return assetIdsIn(value);
    default:
      return [];
  }
}

/**
 * How this answer reads. `null` means unanswered — the caller decides whether
 * that shows as "Not answered", an em dash, or nothing at all.
 *
 * `labels` that are missing are not an error: a caller that deliberately
 * withholds them (a double-blind round withholds filenames, 05) gets the
 * count-only rendering rather than a leak.
 */
export function answerDisplay(
  field: DisplayableField,
  value: unknown,
  labels: ReferenceLabels = {},
): string | null {
  if (isBlank(value)) return null;
  switch (field.type) {
    case "checkbox":
    case "consent":
      return value ? "Yes" : "No";
    case "duration_picker":
      return `${String(value)} minutes`;
    case "track_picker":
    case "format_picker":
      return labels[String(value)] ?? UNRESOLVED_REFERENCE;
    case "speaker_list": {
      const names = referenceIdsIn(field.type, value).map((id) => labels[id] ?? UNRESOLVED_REFERENCE);
      return names.length ? names.join(", ") : null;
    }
    case "file": {
      const ids = assetIdsIn(value);
      if (ids.length === 0) return null;
      const named = ids.map((id) => labels[id]).filter((n): n is string => Boolean(n));
      return named.length === ids.length ? named.join(", ") : `${ids.length} file${ids.length === 1 ? "" : "s"}`;
    }
    case "multi_select": {
      const parts = (Array.isArray(value) ? value : [value]).map((v) => optionLabel(field, v));
      return parts.length ? parts.join(", ") : null;
    }
    case "single_select":
      return optionLabel(field, value);
    default:
      return Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
}

function optionLabel(field: DisplayableField, value: unknown): string {
  const v = String(value);
  return field.options?.find((o) => o.value === v)?.label ?? v;
}
