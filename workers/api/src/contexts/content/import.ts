/**
 * `BulkImport` — map, validate, preview, then run (11, "Bulk import and
 * export"). INV-11-13: nothing is written to the target entities before the
 * operator confirms the preview, and a malformed row never aborts the rows
 * around it.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { DomainError, notFound } from "@podiumconf/domain/shared/errors.js";
import { normaliseEmail } from "@podiumconf/domain/identity/types.js";
import { newId as mintId } from "@podiumconf/domain/shared/ids.js";
import { parseCsv } from "@podiumconf/domain/content/csv.js";
import {
  applyMapping,
  autoMapColumns,
  fieldsFor,
  previewRows,
  splitList,
  summarise,
  type PreviewRow,
} from "@podiumconf/domain/content/import.js";
import type { DedupeKey, ImportSubject, OnDuplicate } from "@podiumconf/domain/content/types.js";
import { uploadAssetDirect } from "./assets.js";
import { addParticipant } from "../identity/service.js";

export interface CreateImportInput {
  subject: ImportSubject;
  event_id?: string | null;
  csvText?: string;
  file?: File;
}

async function readCsvText(input: CreateImportInput): Promise<{ text: string; filename: string }> {
  if (input.file) return { text: await input.file.text(), filename: input.file.name || "import.csv" };
  if (input.csvText) return { text: input.csvText, filename: "pasted.csv" };
  throw new DomainError({ code: "no_source", message: "Provide a CSV file or pasted CSV text.", status: 422 });
}

/** "The source file is kept, so 'where did this record come from' is answerable a year later." */
export async function createImport(app: AppContext, input: CreateImportInput): Promise<Row> {
  const { text, filename } = await readCsvText(input);
  const parsed = parseCsv(text);
  if (parsed.headers.length === 0) throw new DomainError({ code: "empty_csv", message: "That file has no header row.", status: 422 });

  const id = mintId("BulkImport");
  const { asset } = await uploadAssetDirect(app, {
    file: new File([text], filename, { type: "text/csv" }),
    slot_key: `import:${id}`,
    purpose: "document",
    visibility: "private",
  });

  const mapping = autoMapColumns(parsed.headers, input.subject);
  await app.db.insert("bulk_import", {
    id,
    org_id: app.orgId,
    event_id: input.event_id ?? null,
    subject: input.subject,
    source_asset_id: str(asset.id),
    source_text: text,
    column_mapping: JSON.stringify(mapping),
    dedupe_key: "email",
    on_duplicate: "update",
    status: "mapping",
    requested_by_person_id: app.actor.id ?? "system",
    created_at: app.now(),
    row_version: 1,
  });
  app.audit.record({ action: "bulk_import.create", entity_type: "bulk_import", entity_id: id, after: { subject: input.subject, row_count: parsed.rows.length } });
  return getImport(app, id);
}

export async function getImport(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("bulk_import", id, { includeDeleted: true });
  if (!row) throw notFound("Import", id);
  return row;
}

export async function listImports(app: AppContext): Promise<Row[]> {
  return app.db.select<Row>("bulk_import", {}, { orderBy: "created_at DESC" });
}

export async function parsedCsvOf(app: AppContext, importRow: Row) {
  return parseCsv(str(importRow.source_text));
}

export async function setMapping(
  app: AppContext,
  id: string,
  input: { column_mapping: Record<string, string>; dedupe_key: DedupeKey; on_duplicate: OnDuplicate },
): Promise<void> {
  await getImport(app, id);
  await app.db.update("bulk_import", id, {
    column_mapping: JSON.stringify(input.column_mapping),
    dedupe_key: input.dedupe_key,
    on_duplicate: input.on_duplicate,
    status: "mapping",
  });
}

/* -------------------------------------------------------------------------- */
/* Existing-record lookup, per subject                                        */
/* -------------------------------------------------------------------------- */

async function existingByEmail(app: AppContext): Promise<Map<string, string>> {
  const rows = await app.db.select<Row>("person", {});
  const out = new Map<string, string>();
  for (const r of rows) if (r.email) out.set(normaliseEmail(str(r.email)), str(r.id));
  return out;
}

async function existingBySponsorName(app: AppContext): Promise<Map<string, string>> {
  const rows = await app.db.select<Row>("sponsor", {});
  const out = new Map<string, string>();
  for (const r of rows) out.set(str(r.name).trim().toLowerCase(), str(r.id));
  return out;
}

async function existingBySessionReference(app: AppContext, eventId: string | null): Promise<Map<string, string>> {
  if (!eventId) return new Map();
  const rows = await app.db.select<Row>("session", { event_id: eventId });
  const out = new Map<string, string>();
  for (const r of rows) if (r.reference) out.set(str(r.reference).trim().toLowerCase(), str(r.id));
  return out;
}

async function existingMapFor(app: AppContext, importRow: Row): Promise<Map<string, string>> {
  const subject = str(importRow.subject) as ImportSubject;
  const dedupeKey = str(importRow.dedupe_key) as DedupeKey;
  if (dedupeKey === "none") return new Map();
  if (subject === "person" || subject === "event_participant") return existingByEmail(app);
  if (subject === "sponsor") return dedupeKey === "email" ? new Map() : existingBySponsorName(app);
  if (subject === "session") return existingBySessionReference(app, strOrNull(importRow.event_id));
  return new Map();
}

/* -------------------------------------------------------------------------- */
/* Validate + preview                                                          */
/* -------------------------------------------------------------------------- */

export interface PreviewResult {
  rows: PreviewRow[];
  summary: ReturnType<typeof summarise>;
}

/**
 * "Map → validate → preview, then run. The operator sees what will be
 * created, what will be updated and what will be rejected, before anything is
 * written" (11). This writes only to `bulk_import_row` — the import's own
 * scratch table — never to the target entities (INV-11-13).
 */
export async function previewImport(app: AppContext, id: string): Promise<PreviewResult> {
  const importRow = await getImport(app, id);
  const parsed = await parsedCsvOf(app, importRow);
  const mapping = str(importRow.column_mapping) ? JSON.parse(str(importRow.column_mapping)) : {};
  const existing = await existingMapFor(app, importRow);

  const rows = previewRows(parsed.headers, parsed.rows, mapping, {
    subject: str(importRow.subject) as ImportSubject,
    dedupe_key: str(importRow.dedupe_key) as DedupeKey,
    on_duplicate: str(importRow.on_duplicate) as OnDuplicate,
    existing,
  });

  await app.db.rawRun("DELETE FROM bulk_import_row WHERE import_id = ?", [id]);
  for (const r of rows) {
    await app.db.rawRun(
      "INSERT INTO bulk_import_row (import_id, row_number, raw, outcome, entity_id, column_name, message) VALUES (?,?,?,?,?,?,?)",
      [id, r.row_number, JSON.stringify(r.raw), r.outcome, r.matched_id, r.column, r.message],
    );
  }
  await app.db.update("bulk_import", id, { status: "previewing" });
  return { rows, summary: summarise(rows) };
}

export async function previewedRows(app: AppContext, id: string): Promise<Row[]> {
  return app.db.raw<Row>("SELECT * FROM bulk_import_row WHERE import_id = ? ORDER BY row_number", [id]);
}

/* -------------------------------------------------------------------------- */
/* Run — write phase                                                          */
/* -------------------------------------------------------------------------- */

const RUNNABLE_SUBJECTS: ImportSubject[] = ["person", "event_participant"];

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

/**
 * "A CSV of `name,email,title,company,bio` creates people, speaker profiles
 * and roster rows" — the task's own description of what this run phase does.
 */
async function applyPersonFields(app: AppContext, mapped: Record<string, string>, existingPersonId: string | null): Promise<string> {
  const email = normaliseEmail(mapped.email ?? "");
  const now = app.now();
  let personId = existingPersonId;

  if (!personId) {
    const byEmail = await app.db.first<Row>("person", { email });
    personId = byEmail ? str(byEmail.id) : null;
  }

  if (!personId) {
    personId = mintId("Person");
    await app.db.insert("person", {
      id: personId,
      org_id: app.orgId,
      email,
      full_name: mapped.full_name || email,
      display_name: mapped.display_name ?? null,
      pronouns: mapped.pronouns ?? null,
      timezone: mapped.timezone ?? null,
      locale: mapped.locale ?? null,
      status: "invited",
      is_placeholder: 0,
      tags: JSON.stringify(splitList(mapped.tags)),
      custom_field_values: "{}",
      created_at: now,
      updated_at: now,
    });
    app.events.emit({
      type: "person.created",
      subject: { type: "person", id: personId },
      data: { person_id: personId, full_name: mapped.full_name || email, email, source: "import" },
    });
  } else {
    const patch: Row = { updated_at: now };
    if (mapped.full_name) patch.full_name = mapped.full_name;
    if (mapped.display_name) patch.display_name = mapped.display_name;
    if (mapped.pronouns) patch.pronouns = mapped.pronouns;
    if (mapped.timezone) patch.timezone = mapped.timezone;
    if (mapped.locale) patch.locale = mapped.locale;
    await app.db.update("person", personId, patch);
  }

  const profileFields = ["headline", "job_title", "company", "bio", "short_bio", "location"] as const;
  if (profileFields.some((f) => mapped[f])) {
    const profile = await app.db.first<Row>("speaker_profile", { person_id: personId });
    const patch: Row = {};
    for (const f of profileFields) if (mapped[f]) patch[f] = mapped[f];
    if (profile) {
      await app.db.update("speaker_profile", str(profile.id), { ...patch, updated_at: now });
    } else {
      await app.db.insert("speaker_profile", {
        id: mintId("SpeakerProfile"),
        person_id: personId,
        org_id: app.orgId,
        visibility: JSON.stringify({}),
        is_listed: 1,
        ...patch,
        updated_at: now,
      });
    }
  }
  if (mapped.website) {
    const existingLink = await app.db.first<Row>("profile_link", { url: mapped.website });
    if (!existingLink) {
      const profile = await app.db.first<Row>("speaker_profile", { person_id: personId });
      if (profile) {
        await app.db.insert("profile_link", {
          id: mintId("ProfileLink"),
          speaker_profile_id: str(profile.id),
          kind: "website",
          url: mapped.website,
          label: null,
          sort_order: 0,
          is_public: 1,
        });
      }
    }
  }
  return personId;
}

export interface RunResult {
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
}

export async function runImport(app: AppContext, id: string): Promise<RunResult> {
  const importRow = await getImport(app, id);
  if (str(importRow.status) !== "previewing") {
    throw new DomainError({ code: "not_previewed", message: "Preview the import before running it.", status: 422, invariant: "INV-11-13" });
  }
  const subject = str(importRow.subject) as ImportSubject;
  if (!RUNNABLE_SUBJECTS.includes(subject)) {
    throw new DomainError({
      code: "subject_not_runnable",
      message: `Bulk import can preview "${subject}" rows but writing them is not implemented yet — only person and event_participant run.`,
      status: 422,
    });
  }

  const rows = await previewedRows(app, id);
  const mapping = JSON.parse(str(importRow.column_mapping)) as Record<string, string>;
  const parsed = await parsedCsvOf(app, importRow);
  const result: RunResult = { created_count: 0, updated_count: 0, skipped_count: 0, error_count: 0 };

  for (const row of rows) {
    const outcome = str(row.outcome);
    if (outcome === "error") {
      result.error_count++;
      continue;
    }
    if (outcome === "skip") {
      result.skipped_count++;
      continue;
    }
    const csvRow = parsed.rows.find((r) => r.row_number === num(row.row_number));
    if (!csvRow) continue;
    const mapped = applyMapping(parsed.headers, csvRow.values, mapping);

    try {
      const personId = await applyPersonFields(app, mapped, strOrNull(row.entity_id));
      let finalEntityId = personId;
      if (subject === "event_participant" && importRow.event_id) {
        const participant = await addParticipant(app, {
          event_id: str(importRow.event_id),
          person_id: personId,
          kind: (mapped.participant_kind as never) || "speaker",
          status: (mapped.participant_status as never) || "invited",
          source: "import",
        });
        finalEntityId = str(participant.id);
      }
      await app.db.rawRun("UPDATE bulk_import_row SET outcome = ?, entity_id = ? WHERE import_id = ? AND row_number = ?", [
        outcome === "update" ? "updated" : "created",
        finalEntityId,
        id,
        row.row_number,
      ]);
      if (outcome === "update") result.updated_count++;
      else result.created_count++;
    } catch (err) {
      result.error_count++;
      await app.db.rawRun("UPDATE bulk_import_row SET outcome = 'error', message = ? WHERE import_id = ? AND row_number = ?", [
        err instanceof Error ? err.message : String(err),
        id,
        row.row_number,
      ]);
    }
  }

  const finalStatus = result.error_count > 0 ? "completed_with_errors" : "completed";
  await app.db.update("bulk_import", id, { status: finalStatus, completed_at: app.now() });
  app.events.emit({
    type: "bulk_import.completed",
    subject: { type: "import", id },
    data: { import_id: id, subject, row_count: rows.length, created_count: result.created_count, updated_count: result.updated_count, skipped_count: result.skipped_count, error_count: result.error_count },
  });
  app.audit.record({ action: "bulk_import.run", entity_type: "bulk_import", entity_id: id, after: result });
  return result;
}

export function fieldChoicesFor(subject: ImportSubject) {
  return fieldsFor(subject);
}
