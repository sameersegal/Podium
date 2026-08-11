/**
 * `Export` — the permission narrowing (11, "Bulk import and export").
 *
 * "An export is a read. It carries exactly the permissions of the person who
 * asked for it, evaluated at generation time... The one thing an export must
 * never be is a side door around the authorization matrix, which is precisely
 * what it becomes when it is bolted on afterwards as 'just a CSV endpoint'."
 *
 * So the narrowing lives here, in the domain, and the generator in the worker
 * cannot produce a column this module did not hand it.
 */

import { accessFor, type Access, type Capability, type Principals } from "../shared/authorization.js";
import { forbidden, invariantError } from "../shared/errors.js";
import type { ExportFormat, ExportSubject } from "./types.js";

/** Which matrix row governs each export subject. */
const SUBJECT_CAPABILITY: Record<ExportSubject, Capability> = {
  review_results: "review.read",
  proposals: "proposal.read_any",
  sessions: "session.manage",
  speakers: "speaker_profile.edit",
  participants: "roster.manage",
  tasks: "task.approve",
  files: "session.manage",
  contacts: "person_note.manage",
  communications: "communications.read",
};

/** Every column an export of this subject can contain, at full permission. */
export const EXPORT_COLUMNS: Record<ExportSubject, readonly string[]> = {
  review_results: [
    "proposal_id",
    "reference",
    "title",
    "track",
    "format",
    "status",
    "review_count",
    "average_score",
    "median_score",
    "disagreement",
    "recommendation_mix",
    "decision_outcome",
  ],
  proposals: [
    "id",
    "reference",
    "title",
    "status",
    "track",
    "format",
    "duration_minutes",
    "origin",
    "submitted_at",
    "is_late",
    "speaker_names",
    "speaker_emails",
    "submitter_email",
  ],
  sessions: [
    "id",
    "reference",
    "title",
    "status",
    "content_status",
    "track",
    "format",
    "duration_minutes",
    "room",
    "starts_at",
    "speaker_names",
    "speaker_emails",
  ],
  speakers: [
    "person_id",
    "full_name",
    "display_name",
    "job_title",
    "company",
    "headline",
    "location",
    "session_titles",
    "email",
    "phone",
    "dietary_notes",
    "accessibility_notes",
  ],
  participants: ["person_id", "full_name", "kind", "status", "source", "portal_access", "created_at", "email"],
  tasks: [
    "id",
    "definition_key",
    "title",
    "subject_type",
    "subject_id",
    "assignee_name",
    "status",
    "due_at",
    "completed_at",
    "is_blocking",
    "assignee_email",
  ],
  files: ["asset_id", "slot_key", "filename", "version", "size_bytes", "content_type", "scan_status", "uploaded_at", "belongs_to", "uploaded_by"],
  contacts: ["person_id", "full_name", "company", "job_title", "tags", "events", "email"],
  communications: [
    "id",
    "created_at",
    "template_key",
    "campaign_id",
    "channel",
    "status",
    "suppressed_reason",
    "subject_type",
    "subject_id",
    "subject",
    "recipient_person_id",
    "recipient_email",
    "rendered_body",
  ],
};

/**
 * The columns that are PII (11, "PII"). Dropped unless the requester holds
 * `pii:read` **and** asked for them (INV-11-12).
 */
export const PII_COLUMNS: Record<ExportSubject, readonly string[]> = {
  review_results: [],
  proposals: ["speaker_emails", "submitter_email"],
  sessions: ["speaker_emails"],
  speakers: ["email", "phone", "dietary_notes", "accessibility_notes"],
  participants: ["email"],
  tasks: ["assignee_email"],
  files: [],
  contacts: ["email"],
  communications: ["recipient_email", "rendered_body"],
};

export interface ExportRequest {
  subject: ExportSubject;
  format: ExportFormat;
  include_pii: boolean;
  event_id?: string | null;
}

export interface ExportPermission {
  /** `own` narrows the record set; `read`/`write` means the whole scope. */
  access: Access;
  /** True only when they hold `pii:read` and asked for it. */
  include_pii: boolean;
  /** The exact column list the generator is allowed to emit. */
  columns: string[];
  /**
   * INV-11-7: review data for a proposal the requester submitted or is credited
   * on is absent from the surface entirely, export included.
   */
  excluded_proposal_ids: string[];
  /** For `own` access: restrict to these relationship-derived records. */
  own_session_ids: string[];
  own_proposal_ids: string[];
  own_sponsor_ids: string[];
}

/**
 * INV-11-12: generated under the requesting person's permissions as evaluated
 * at generation time; honours `include_pii` only when they hold `pii:read`; can
 * never contain a record or column that person could not read through the API.
 */
export function narrowExport(p: Principals, req: ExportRequest, now: string): ExportPermission {
  const target = { event_id: req.event_id ?? null };
  const capability = SUBJECT_CAPABILITY[req.subject];
  const access = accessFor(p, capability, target, now);
  if (access === "none") {
    throw forbidden(`You cannot export ${req.subject.replace(/_/g, " ")}.`, { subject: req.subject });
  }

  const mayReadPii = accessFor(p, "pii.read", target, now) !== "none";
  const includePii = req.include_pii && mayReadPii;
  if (req.include_pii && !mayReadPii) {
    throw invariantError(
      "INV-11-12",
      "pii_export_not_permitted",
      "An export with personal data requires permission to read personal data.",
      { subject: req.subject },
    );
  }

  const all = EXPORT_COLUMNS[req.subject] ?? [];
  const pii = PII_COLUMNS[req.subject] ?? [];
  const columns = includePii ? [...all] : all.filter((c) => !pii.includes(c));

  return {
    access,
    include_pii: includePii,
    columns,
    excluded_proposal_ids: req.subject === "review_results" ? [...p.relationships.proposal_ids] : [],
    own_session_ids: [...p.relationships.session_ids],
    own_proposal_ids: [...p.relationships.proposal_ids],
    own_sponsor_ids: [...p.relationships.sponsor_ids],
  };
}

/** Strip a row down to the permitted columns. Nothing else reaches the file. */
export function project(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

/**
 * `zip` for `files` "defaults to latest versions only, grouped one folder per
 * session, which is what an AV team asks for".
 */
export interface ZipOptions {
  grouping: "session" | "speaker" | "flat";
  latest_versions_only: boolean;
}

export function zipOptions(raw: Record<string, unknown> | null | undefined): ZipOptions {
  const grouping = String(raw?.grouping ?? "session");
  return {
    grouping: grouping === "speaker" ? "speaker" : grouping === "flat" ? "flat" : "session",
    latest_versions_only: raw?.latest_versions_only === undefined ? true : Boolean(raw.latest_versions_only),
  };
}

/** Formats the generator implements. `xlsx` and `ics` are enum members it does not. */
export const IMPLEMENTED_FORMATS: readonly ExportFormat[] = ["csv", "json", "zip"];
