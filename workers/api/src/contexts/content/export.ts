/**
 * `Export` — 11-cross-cutting.md, "Bulk import and export". INV-11-12: an
 * export is generated under the requesting person's permissions, evaluated
 * fresh, and can never contain a record or column that person could not read
 * through the API.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { DomainError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { addDays } from "@podiumstack/domain/shared/time.js";
import type { Principals } from "@podiumstack/domain/shared/authorization.js";
import {
  EXPORT_COLUMNS,
  IMPLEMENTED_FORMATS,
  narrowExport,
  project,
  zipOptions,
  type ExportPermission,
  type ZipOptions,
} from "@podiumstack/domain/content/export.js";
import { EXPORT_TTL_DAYS, type ExportFormat, type ExportSubject } from "@podiumstack/domain/content/types.js";
import { toCsv } from "@podiumstack/domain/content/csv.js";
import { createZip, type ZipEntry } from "@podiumstack/domain/content/zip.js";
import { uploadAssetDirect } from "./assets.js";
import { toRoundView, roundResults } from "../review/scoring.js";

export interface CreateExportInput {
  subject: ExportSubject;
  format: ExportFormat;
  filters?: Record<string, unknown> | null;
  options?: Record<string, unknown> | null;
  include_pii: boolean;
  event_id?: string | null;
}

export async function createExport(app: AppContext, principals: Principals, input: CreateExportInput): Promise<Row> {
  if (!IMPLEMENTED_FORMATS.includes(input.format) && !(input.format === "zip" && input.subject === "files")) {
    throw new DomainError({ code: "unsupported_format", message: `${input.format} is not implemented yet.`, status: 422 });
  }
  // Evaluated now, purely to fail fast with a clear 403 before queuing —
  // generation re-evaluates permissions itself (INV-11-12).
  narrowExport(principals, { subject: input.subject, format: input.format, include_pii: input.include_pii, event_id: input.event_id }, app.now());

  const id = newId("Export");
  const row: Row = {
    id,
    event_id: input.event_id ?? null,
    subject: input.subject,
    format: input.format,
    filters: input.filters ? JSON.stringify(input.filters) : null,
    options: input.options ? JSON.stringify(input.options) : null,
    include_pii: input.include_pii ? 1 : 0,
    status: "queued",
    expires_at: addDays(app.now(), EXPORT_TTL_DAYS),
    requested_by_person_id: app.actor.id ?? "system",
    created_at: app.now(),
  };
  await app.db.insert("export", row);
  app.audit.record({ action: "export.request", entity_type: "export", entity_id: id, after: { subject: input.subject, format: input.format, include_pii: input.include_pii } });
  return row;
}

export async function getExport(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("export", id);
  if (!row) throw notFound("Export", id);
  return row;
}

export async function listExports(app: AppContext): Promise<Row[]> {
  return app.db.select<Row>("export", {}, { orderBy: "created_at DESC" });
}

/* -------------------------------------------------------------------------- */
/* Row sources, per subject                                                    */
/* -------------------------------------------------------------------------- */

async function proposalRows(app: AppContext, perm: ExportPermission, eventId: string | null): Promise<Record<string, unknown>[]> {
  const where: Row = eventId ? { event_id: eventId } : {};
  let rows = await app.db.select<Row>("proposal", where);
  if (perm.access === "own") rows = rows.filter((r) => perm.own_proposal_ids.includes(str(r.id)));
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const speakers = await app.db.raw<Row>(
      "SELECT p.full_name, p.email FROM proposal_speaker ps JOIN person p ON p.id = ps.person_id WHERE ps.proposal_id = ? AND ps.participation_status != 'removed'",
      [str(r.id)],
    );
    const track = r.track_id ? await app.db.byId<Row>("track", str(r.track_id)) : null;
    const format = r.session_format_id ? await app.db.byId<Row>("session_format", str(r.session_format_id)) : null;
    const submitter = await app.db.byId<Row>("person", str(r.submitter_person_id));
    out.push({
      id: str(r.id),
      reference: str(r.reference),
      title: str(r.title),
      status: str(r.status),
      track: track ? str(track.name) : "",
      format: format ? str(format.name) : "",
      duration_minutes: r.duration_minutes ?? null,
      origin: str(r.origin),
      submitted_at: strOrNull(r.submitted_at),
      is_late: !!r.is_late,
      speaker_names: speakers.map((s) => str(s.full_name)).join("; "),
      speaker_emails: speakers.map((s) => str(s.email)).join("; "),
      submitter_email: submitter ? str(submitter.email) : "",
    });
  }
  return out;
}

async function sessionRows(app: AppContext, perm: ExportPermission, eventId: string | null): Promise<Record<string, unknown>[]> {
  const where: Row = eventId ? { event_id: eventId } : {};
  let rows = await app.db.select<Row>("session", where);
  if (perm.access === "own") rows = rows.filter((r) => perm.own_session_ids.includes(str(r.id)));
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const speakers = await app.db.raw<Row>(
      "SELECT p.full_name, p.email FROM session_speaker ss JOIN person p ON p.id = ss.person_id WHERE ss.session_id = ? AND ss.confirmation_status != 'replaced'",
      [str(r.id)],
    );
    const track = r.track_id ? await app.db.byId<Row>("track", str(r.track_id)) : null;
    const format = r.session_format_id ? await app.db.byId<Row>("session_format", str(r.session_format_id)) : null;
    const placement = await app.db.first<Row>("placement", { session_id: str(r.id) });
    const room = placement?.room_id ? await app.db.byId<Row>("room", str(placement.room_id)) : null;
    out.push({
      id: str(r.id),
      reference: str(r.reference),
      title: str(r.title),
      status: str(r.status),
      content_status: str(r.content_status),
      track: track ? str(track.name) : "",
      format: format ? str(format.name) : "",
      duration_minutes: r.duration_minutes ?? null,
      room: room ? str(room.name) : "",
      starts_at: placement ? strOrNull(placement.starts_at) : null,
      speaker_names: speakers.map((s) => str(s.full_name)).join("; "),
      speaker_emails: speakers.map((s) => str(s.email)).join("; "),
    });
  }
  return out;
}

async function speakerRows(app: AppContext, eventId: string | null): Promise<Record<string, unknown>[]> {
  const personIds = eventId
    ? (await app.db.raw<{ person_id: string }>("SELECT DISTINCT person_id FROM event_participant WHERE event_id = ?", [eventId])).map((r) => r.person_id)
    : null;
  const people = personIds ? await app.db.select<Row>("person", { id: personIds }) : await app.db.select<Row>("person", {});
  const out: Record<string, unknown>[] = [];
  for (const p of people) {
    const profile = await app.db.first<Row>("speaker_profile", { person_id: str(p.id) });
    const sessions = eventId
      ? await app.db.raw<{ title: string }>(
          "SELECT s.title FROM session_speaker ss JOIN session s ON s.id = ss.session_id WHERE ss.person_id = ? AND s.event_id = ?",
          [str(p.id), eventId],
        )
      : [];
    out.push({
      person_id: str(p.id),
      full_name: str(p.full_name),
      display_name: strOrNull(p.display_name),
      job_title: profile ? strOrNull(profile.job_title) : null,
      company: profile ? strOrNull(profile.company) : null,
      headline: profile ? strOrNull(profile.headline) : null,
      location: profile ? strOrNull(profile.location) : null,
      session_titles: sessions.map((s) => s.title).join("; "),
      email: str(p.email),
      phone: profile ? strOrNull(profile.phone) : null,
      dietary_notes: profile ? strOrNull(profile.dietary_notes) : null,
      accessibility_notes: profile ? strOrNull(profile.accessibility_notes) : null,
    });
  }
  return out;
}

async function participantRows(app: AppContext, eventId: string | null): Promise<Record<string, unknown>[]> {
  if (!eventId) return [];
  const rows = await app.db.raw<Row>(
    "SELECT ep.*, p.full_name, p.email FROM event_participant ep JOIN person p ON p.id = ep.person_id WHERE ep.event_id = ?",
    [eventId],
  );
  return rows.map((r) => ({
    person_id: str(r.person_id),
    full_name: str(r.full_name),
    kind: str(r.kind),
    status: str(r.status),
    source: str(r.source),
    portal_access: str(r.portal_access),
    created_at: str(r.created_at),
    email: str(r.email),
  }));
}

async function taskRows(app: AppContext, eventId: string | null): Promise<Record<string, unknown>[]> {
  const where: Row = eventId ? { event_id: eventId } : {};
  const rows = await app.db.select<Row>("task_instance", where);
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const def = await app.db.byId<Row>("task_definition", str(r.task_definition_id));
    const assignee = r.assignee_person_id ? await app.db.byId<Row>("person", str(r.assignee_person_id)) : null;
    out.push({
      id: str(r.id),
      definition_key: def ? str(def.key) : "",
      title: def ? str(def.title) : "",
      subject_type: str(r.subject_type),
      subject_id: str(r.subject_id),
      assignee_name: assignee ? str(assignee.full_name) : "",
      status: str(r.status),
      due_at: strOrNull(r.due_at),
      completed_at: strOrNull(r.completed_at),
      is_blocking: !!r.is_blocking,
      assignee_email: assignee ? str(assignee.email) : "",
    });
  }
  return out;
}

async function contactRows(app: AppContext): Promise<Record<string, unknown>[]> {
  const people = await app.db.select<Row>("person", {});
  const out: Record<string, unknown>[] = [];
  for (const p of people) {
    const profile = await app.db.first<Row>("speaker_profile", { person_id: str(p.id) });
    const events = await app.db.raw<{ event_id: string }>("SELECT event_id FROM event_participant WHERE person_id = ?", [str(p.id)]);
    out.push({
      person_id: str(p.id),
      full_name: str(p.full_name),
      company: profile ? strOrNull(profile.company) : null,
      job_title: profile ? strOrNull(profile.job_title) : null,
      tags: JSON.parse(str(p.tags, "[]")).join("; "),
      events: events.length,
      email: str(p.email),
    });
  }
  return out;
}

async function communicationRows(app: AppContext, eventId: string | null): Promise<Record<string, unknown>[]> {
  const where: Row = {};
  if (eventId) where.event_id = eventId;
  const clauses = Object.keys(where).map((k) => `${k} = ?`);
  const filter = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = await app.db.raw<Row>(`SELECT * FROM notification_delivery${filter} ORDER BY created_at DESC`, Object.values(where));
  return rows.map((r) => ({
    id: str(r.id),
    created_at: str(r.created_at),
    template_key: strOrNull(r.template_key),
    campaign_id: strOrNull(r.campaign_id),
    channel: str(r.channel),
    status: str(r.status),
    suppressed_reason: strOrNull(r.suppressed_reason),
    subject_type: strOrNull(r.subject_type),
    subject_id: strOrNull(r.subject_id),
    subject: strOrNull(r.subject),
    recipient_person_id: strOrNull(r.recipient_person_id),
    recipient_email: str(r.recipient_email),
    rendered_body: str(r.rendered_body),
  }));
}

async function reviewResultRows(app: AppContext, filters: Record<string, unknown>, perm: ExportPermission): Promise<Record<string, unknown>[]> {
  const roundId = filters.round_id ? String(filters.round_id) : null;
  if (!roundId) throw new DomainError({ code: "round_id_required", message: "review_results exports need filters.round_id.", status: 422 });
  const roundRow = await app.db.byId<Row>("review_round", roundId);
  if (!roundRow) throw notFound("Review round", roundId);
  const round = toRoundView(roundRow);
  const results = await roundResults(app, round);
  return results.rows
    .filter((r) => !perm.excluded_proposal_ids.includes(r.proposal.id)) // INV-11-7
    .map((r) => ({
      proposal_id: str(r.proposal.id),
      reference: str(r.proposal.reference),
      title: str(r.proposal.title),
      track: strOrNull(r.proposal.track_id),
      format: strOrNull(r.proposal.session_format_id),
      status: str(r.proposal.status),
      review_count: r.score.review_count,
      average_score: r.score.mean,
      median_score: r.score.median,
      disagreement: r.score.disagreement,
      recommendation_mix: Object.entries(r.score.recommendation_histogram).map(([k, v]) => `${k}:${v}`).join("; "),
      decision_outcome: r.decision ? str(r.decision.outcome) : null,
    }));
}

async function subjectRows(app: AppContext, subject: ExportSubject, perm: ExportPermission, eventId: string | null, filters: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  switch (subject) {
    case "proposals":
      return proposalRows(app, perm, eventId);
    case "sessions":
      return sessionRows(app, perm, eventId);
    case "speakers":
      return speakerRows(app, eventId);
    case "participants":
      return participantRows(app, eventId);
    case "tasks":
      return taskRows(app, eventId);
    case "contacts":
      return contactRows(app);
    case "communications":
      return communicationRows(app, eventId);
    case "review_results":
      return reviewResultRows(app, filters, perm);
    case "files":
      return []; // handled separately as a zip bundle
  }
}

/* -------------------------------------------------------------------------- */
/* Files — zip of latest versions, one folder per session (or speaker)         */
/* -------------------------------------------------------------------------- */

async function buildFilesZip(app: AppContext, eventId: string | null, opts: ZipOptions): Promise<Uint8Array> {
  const slotRows = eventId
    ? await app.db.raw<Row>(
        `SELECT sa.kind, sa.session_id, a.* FROM session_asset sa JOIN asset a ON a.id = sa.asset_id
           JOIN session s ON s.id = sa.session_id WHERE s.event_id = ? AND a.scan_status = 'clean' AND a.deleted_at IS NULL`,
        [eventId],
      )
    : [];
  const entries: ZipEntry[] = [];
  const encoder = new TextEncoder();
  const seenSlots = new Set<string>();
  for (const r of slotRows) {
    const slotKey = str(r.slot_key);
    if (opts.latest_versions_only) {
      const latest = await app.db.raw<{ v: number }>("SELECT MAX(version) AS v FROM asset WHERE slot_key = ? AND deleted_at IS NULL", [slotKey]);
      if (num(r.version) !== num(latest[0]?.v)) continue;
    }
    if (seenSlots.has(`${slotKey}:${r.version}`)) continue;
    seenSlots.add(`${slotKey}:${r.version}`);
    const session = await app.db.byId<Row>("session", str(r.session_id));
    const folder = opts.grouping === "flat" ? "" : `${(session ? str(session.title) : str(r.session_id)).replace(/[/\\]/g, "-")}/`;
    const object = await app.env.ASSETS_BUCKET.get(str(r.storage_key));
    const bytes = object ? new Uint8Array(await object.arrayBuffer()) : encoder.encode("");
    entries.push({ path: `${folder}${str(r.filename)}`, data: bytes });
  }
  return createZip(entries);
}

/* -------------------------------------------------------------------------- */
/* Generate — the write phase, invoked via `waitUntil` right after creation    */
/* -------------------------------------------------------------------------- */

export async function generateExport(app: AppContext, principals: Principals, exportId: string): Promise<void> {
  const row = await getExport(app, exportId);
  if (str(row.status) !== "queued") return; // idempotent — already handled
  await app.db.update("export", exportId, { status: "running" });

  try {
    const eventId = strOrNull(row.event_id);
    const subject = str(row.subject) as ExportSubject;
    const format = str(row.format) as ExportFormat;
    const filters = row.filters ? JSON.parse(str(row.filters)) : {};
    const perm = narrowExport(principals, { subject, format, include_pii: !!row.include_pii, event_id: eventId }, app.now());

    let bytes: Uint8Array;
    let contentType: string;
    let filename: string;
    let rowCount = 0;

    if (format === "zip" && subject === "files") {
      bytes = await buildFilesZip(app, eventId, zipOptions(row.options ? JSON.parse(str(row.options)) : null));
      contentType = "application/zip";
      filename = `${subject}-${exportId}.zip`;
    } else {
      const rows = await subjectRows(app, subject, perm, eventId, filters);
      const projected = rows.map((r) => project(r, perm.columns.length ? perm.columns : [...(EXPORT_COLUMNS[subject] ?? [])]));
      rowCount = projected.length;
      if (format === "json") {
        bytes = new TextEncoder().encode(JSON.stringify(projected, null, 2));
        contentType = "application/json";
        filename = `${subject}-${exportId}.json`;
      } else {
        bytes = new TextEncoder().encode(toCsv(perm.columns, projected));
        contentType = "text/csv";
        filename = `${subject}-${exportId}.csv`;
      }
    }

    const { asset } = await uploadAssetDirect(app, {
      file: new File([bytes], filename, { type: contentType }),
      slot_key: `export:${exportId}`,
      purpose: "document",
      visibility: "private",
    });
    // Exports are ready to download the moment the bytes land — an operator's
    // own generated file needs no separate scan gate.
    await app.db.update("asset", str(asset.id), { scan_status: "clean" });

    // `row_count` and `byte_size` are `D` — derived, no column (INV-11-6).
    // `byte_size` reads off the generated `Asset.size_bytes`; `row_count` is
    // recomputed from the file when a reader asks (views.ts).
    await app.db.update("export", exportId, { status: "ready", result_asset_id: asset.id });
    app.events.emit({
      type: "export.ready",
      subject: { type: "export", id: exportId },
      data: { export_id: exportId, subject, format, row_count: rowCount, byte_size: bytes.byteLength, expires_at: str(row.expires_at) },
    });
  } catch (err) {
    await app.db.update("export", exportId, { status: "failed" });
    console.error("export generation failed", { export_id: exportId, error: err instanceof Error ? err.message : String(err) });
  }
}
