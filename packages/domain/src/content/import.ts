/**
 * `BulkImport` — map, validate, preview, then run (11, "Bulk import and
 * export").
 *
 * Pure: the rules that decide what a row *would* do. Nothing here writes, which
 * is half of INV-11-13; the other half is that the worker only writes after the
 * operator confirms the preview this module produces.
 *
 * "Errors are per row. Row 412 has a malformed email; rows 1–411 and 413–900
 * still import."
 */

import type { DedupeKey, ImportSubject, OnDuplicate } from "./types.js";

export interface ImportFieldSpec {
  key: string;
  label: string;
  required?: boolean;
  /** Header spellings that mean this field, lowercased. */
  aliases?: string[];
  /** Returns an error message, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
}

const emailRule = (v: string): string | null =>
  !v ? null : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : `"${v}" is not an email address.`;

const urlRule = (v: string): string | null =>
  !v || /^https?:\/\/\S+$/.test(v) ? null : `"${v}" is not an absolute URL.`;

const PERSON_FIELDS: ImportFieldSpec[] = [
  { key: "full_name", label: "Full name", required: true, aliases: ["name", "fullname", "full name", "speaker", "speaker name"] },
  { key: "email", label: "Email", required: true, aliases: ["e-mail", "email address", "mail"], validate: emailRule },
  { key: "display_name", label: "Display name", aliases: ["display name", "short name"] },
  { key: "pronouns", label: "Pronouns" },
  { key: "timezone", label: "Timezone", aliases: ["time zone", "tz"] },
  { key: "locale", label: "Locale", aliases: ["language"] },
  { key: "job_title", label: "Job title", aliases: ["title", "role", "position"] },
  { key: "company", label: "Company", aliases: ["organisation", "organization", "employer", "org"] },
  { key: "headline", label: "Headline" },
  { key: "bio", label: "Bio", aliases: ["biography", "about"] },
  { key: "short_bio", label: "Short bio", aliases: ["short biography"] },
  { key: "location", label: "Location", aliases: ["city", "country"] },
  { key: "website", label: "Website", aliases: ["url", "homepage", "site"], validate: urlRule },
  { key: "tags", label: "Tags", aliases: ["labels"] },
];

const PARTICIPANT_FIELDS: ImportFieldSpec[] = [
  ...PERSON_FIELDS,
  { key: "participant_kind", label: "Roster kind", aliases: ["kind", "participant type", "type"] },
  { key: "participant_status", label: "Roster status", aliases: ["status", "rsvp"] },
];

const SESSION_FIELDS: ImportFieldSpec[] = [
  { key: "title", label: "Title", required: true, aliases: ["session", "session title", "talk"] },
  { key: "abstract", label: "Abstract", aliases: ["description", "summary"] },
  { key: "format", label: "Format", aliases: ["session format", "type"] },
  { key: "track", label: "Track", aliases: ["topic"] },
  { key: "language", label: "Language" },
  { key: "level", label: "Level", aliases: ["audience level"] },
  { key: "speaker_emails", label: "Speaker emails", aliases: ["speakers", "speaker email"] },
  { key: "reference", label: "Reference", aliases: ["ref", "code"] },
];

const SPONSOR_FIELDS: ImportFieldSpec[] = [
  { key: "name", label: "Name", required: true, aliases: ["company", "sponsor", "sponsor name"] },
  { key: "website_url", label: "Website", aliases: ["website", "url"], validate: urlRule },
  { key: "description", label: "Description", aliases: ["about", "blurb"] },
  { key: "contact_email", label: "Contact email", aliases: ["email"], validate: emailRule },
  { key: "contact_name", label: "Contact name", aliases: ["contact"] },
  { key: "reference", label: "Reference", aliases: ["ref", "code"] },
];

export const IMPORT_FIELDS: Record<ImportSubject, ImportFieldSpec[]> = {
  person: PERSON_FIELDS,
  event_participant: PARTICIPANT_FIELDS,
  session: SESSION_FIELDS,
  sponsor: SPONSOR_FIELDS,
};

export function fieldsFor(subject: ImportSubject): ImportFieldSpec[] {
  return IMPORT_FIELDS[subject] ?? PERSON_FIELDS;
}

/**
 * A first guess at `column_mapping`, which the operator then confirms. Guessing
 * is a courtesy; confirming is the rule (11: "confirmed by the operator before
 * the run").
 */
export function autoMapColumns(headers: string[], subject: ImportSubject): Record<string, string> {
  const specs = fieldsFor(subject);
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const header of headers) {
    const h = header.trim().toLowerCase();
    const match = specs.find(
      (s) => !taken.has(s.key) && (s.key === h || s.label.toLowerCase() === h || (s.aliases ?? []).includes(h)),
    );
    if (match) {
      out[header] = match.key;
      taken.add(match.key);
    } else {
      out[header] = "";
    }
  }
  return out;
}

export function applyMapping(
  headers: string[],
  values: string[],
  mapping: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const key = mapping[h];
    if (!key) return;
    const v = (values[i] ?? "").trim();
    if (v !== "") out[key] = v;
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-row validation                                                          */
/* -------------------------------------------------------------------------- */

export interface RowProblem {
  column: string | null;
  message: string;
}

export function validateRow(subject: ImportSubject, mapped: Record<string, string>): RowProblem | null {
  for (const spec of fieldsFor(subject)) {
    const value = mapped[spec.key] ?? "";
    if (spec.required && value === "") {
      return { column: spec.key, message: `${spec.label} is required and this row has none.` };
    }
    const problem = spec.validate?.(value);
    if (problem) return { column: spec.key, message: problem };
  }
  return null;
}

/** The value a row is deduplicated on. `none` means every row is a new record. */
export function dedupeValueOf(subject: ImportSubject, mapped: Record<string, string>, key: DedupeKey): string | null {
  if (key === "none") return null;
  if (key === "email") {
    const email = mapped.email ?? mapped.contact_email ?? "";
    return email ? email.trim().toLowerCase() : null;
  }
  return mapped.reference ? mapped.reference.trim() : null;
}

export type PreviewOutcome = "create" | "update" | "skip" | "error";

export interface PreviewRow {
  row_number: number;
  raw: Record<string, string>;
  mapped: Record<string, string>;
  outcome: PreviewOutcome;
  /** The existing record this row matched, when it matched one. */
  matched_id: string | null;
  column: string | null;
  message: string | null;
}

export interface PreviewOptions {
  subject: ImportSubject;
  dedupe_key: DedupeKey;
  on_duplicate: OnDuplicate;
  /** Dedupe value → existing entity id, resolved by the repository. */
  existing: Map<string, string>;
}

/**
 * What the run *would* do, row by row. The operator sees created, updated and
 * rejected counts before anything is written (INV-11-13).
 *
 * Duplicates within the file itself count as duplicates too — people re-import
 * the same file, and they also paste the same person in twice.
 */
export function previewRows(
  headers: string[],
  rows: { row_number: number; values: string[] }[],
  mapping: Record<string, string>,
  opts: PreviewOptions,
): PreviewRow[] {
  const seenInFile = new Map<string, number>();
  return rows.map((row) => {
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = (row.values[i] ?? "").trim();
    });
    const mapped = applyMapping(headers, row.values, mapping);
    const base: PreviewRow = {
      row_number: row.row_number,
      raw,
      mapped,
      outcome: "create",
      matched_id: null,
      column: null,
      message: null,
    };

    const problem = validateRow(opts.subject, mapped);
    if (problem) {
      // One bad cell rejects one row and nothing else (INV-11-13).
      return { ...base, outcome: "error", column: problem.column, message: problem.message };
    }

    const dedupe = dedupeValueOf(opts.subject, mapped, opts.dedupe_key);
    if (!dedupe) return base;

    const earlier = seenInFile.get(dedupe);
    if (earlier !== undefined && opts.on_duplicate !== "create_anyway") {
      return {
        ...base,
        outcome: "skip",
        message: `The same ${opts.dedupe_key} appears on row ${earlier} of this file.`,
      };
    }
    seenInFile.set(dedupe, row.row_number);

    const matched = opts.existing.get(dedupe);
    if (!matched) return base;
    if (opts.on_duplicate === "create_anyway") return { ...base, matched_id: null };
    if (opts.on_duplicate === "skip") {
      return { ...base, outcome: "skip", matched_id: matched, message: "Already here; left as it is." };
    }
    return { ...base, outcome: "update", matched_id: matched };
  });
}

export interface PreviewSummary {
  row_count: number;
  create_count: number;
  update_count: number;
  skip_count: number;
  error_count: number;
}

export function summarise(rows: PreviewRow[]): PreviewSummary {
  return {
    row_count: rows.length,
    create_count: rows.filter((r) => r.outcome === "create").length,
    update_count: rows.filter((r) => r.outcome === "update").length,
    skip_count: rows.filter((r) => r.outcome === "skip").length,
    error_count: rows.filter((r) => r.outcome === "error").length,
  };
}

/** `tags` arrive as "ai, agents; evals" more often than as JSON. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
