/**
 * Read models shared by the content routes: `FilesLibrary`, JSON shapes, and
 * the PII-aware projections the model requires.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { markLatest } from "@podiumstack/domain/content/assets.js";
import { redactRecord } from "@podiumstack/domain/shared/pii.js";

/* -------------------------------------------------------------------------- */
/* FilesLibrary — 11, "The files library"                                     */
/* -------------------------------------------------------------------------- */

export interface FilesLibraryRow {
  slot_key: string;
  latest: Row;
  version_count: number;
  comment_count: number;
  belongs_to: { kind: string; id: string; label: string };
}

export interface FilesLibraryFilters {
  kind?: string | null; // purpose
  session_id?: string | null;
  speaker_person_id?: string | null;
  missing?: boolean; // "whose slides are still not here"
}

/**
 * What each `slot_key` subject is called, for every slot on the screen at once.
 *
 * This was one `byId` per row, which on the seeded event alone was twenty-two
 * statements to render one table and grew with the number of files — the
 * definition of an N+1 (`implementer.md`, G). Four subject types means at most
 * four `IN (…)` reads however many slots there are, and typically one or two,
 * since a files library is mostly sessions and people.
 *
 * Deleted subjects are still labelled — `includeDeleted` — because a file
 * outliving its session must say what it belonged to rather than go blank.
 */
type BelongsTo = { kind: string; id: string; label: string };

async function belongsToLabels(app: AppContext, subjects: { type: string; id: string }[]): Promise<Map<string, BelongsTo>> {
  const byType = new Map<string, Set<string>>();
  for (const s of subjects) {
    if (!s.id) continue;
    const set = byType.get(s.type) ?? new Set<string>();
    set.add(s.id);
    byType.set(s.type, set);
  }

  const TABLES: Record<string, { table: string; includeDeleted: boolean; label: (r: Row) => string; missing: string }> = {
    session: { table: "session", includeDeleted: true, label: (r) => str(r.title), missing: "(deleted session)" },
    person: { table: "person", includeDeleted: true, label: (r) => str(r.display_name) || str(r.full_name), missing: "(deleted person)" },
    task: { table: "task_instance", includeDeleted: false, label: (r) => str(r.subject_type), missing: "task" },
    sponsor: { table: "sponsor", includeDeleted: true, label: (r) => str(r.name), missing: "(deleted sponsor)" },
  };

  const out = new Map<string, BelongsTo>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const spec = TABLES[type];
      if (!spec) {
        // An unknown subject type labels itself, exactly as it always has.
        for (const id of ids) out.set(`${type}:${id}`, { kind: type, id, label: id });
        return;
      }
      const rows = await app.db.select<Row>(spec.table, { id: [...ids] }, { includeDeleted: spec.includeDeleted });
      const found = new Map(rows.map((r) => [str(r.id), r]));
      for (const id of ids) {
        const row = found.get(id);
        out.set(`${type}:${id}`, { kind: type, id, label: row ? spec.label(row) : spec.missing });
      }
    }),
  );
  return out;
}

/**
 * How many comments sit on each slot — one `GROUP BY` for the page.
 *
 * Was `COUNT(*) … WHERE slot_key = ?` per row: twenty-seven statements on the
 * seeded event, and one more for every file anybody ever uploads. The predicate
 * is unchanged (INV-11-2 excludes soft-deleted comments); only the number of
 * times it is sent is.
 */
async function commentCountsBySlot(app: AppContext): Promise<Map<string, number>> {
  const rows = await app.db.raw<{ slot_key: string; n: number }>(
    "SELECT slot_key, COUNT(*) AS n FROM asset_comment WHERE deleted_at IS NULL GROUP BY slot_key",
  );
  return new Map(rows.map((r) => [str(r.slot_key), num(r.n)]));
}

/**
 * "One row per `slot_key` with its latest version, filename, size, type,
 * version count, uploader, upload date, comment count, and what it belongs
 * to" (11). Filterable by kind, by session, by speaker and by missing-ness —
 * "the question is almost always 'whose slides are still not here'."
 */
export async function filesLibrary(app: AppContext, filters: FilesLibraryFilters = {}): Promise<FilesLibraryRow[]> {
  const all = await app.db.select<Row>("asset", {}, { orderBy: "created_at DESC" });
  const bySlot = new Map<string, Row[]>();
  for (const a of all) {
    const list = bySlot.get(str(a.slot_key)) ?? [];
    list.push(a);
    bySlot.set(str(a.slot_key), list);
  }

  // Every slot that survives filtering, resolved first, so the two lookups
  // below are asked once for the whole page rather than once per row.
  const kept: { slotKey: string; latest: Row; versions: Row[]; subjectType: string; subjectId: string }[] = [];
  for (const [slotKey, versions] of bySlot) {
    const marked = markLatest(versions.map((v) => ({ id: str(v.id), version: num(v.version), deleted_at: strOrNull(v.deleted_at) })));
    const latestId = marked.find((m) => m.is_latest)?.id;
    const latest = versions.find((v) => str(v.id) === latestId);
    if (!latest) continue;
    if (filters.kind && str(latest.purpose) !== filters.kind) continue;

    const parts = slotKey.split(":");
    const subjectType = parts[0] ?? "";
    const subjectId = parts[1] ?? "";
    if (filters.session_id && !(subjectType === "session" && subjectId === filters.session_id)) continue;
    if (filters.speaker_person_id && !(subjectType === "person" && subjectId === filters.speaker_person_id)) continue;
    kept.push({ slotKey, latest, versions, subjectType, subjectId });
  }

  const [commentCounts, labels] = await Promise.all([
    commentCountsBySlot(app),
    belongsToLabels(app, kept.map((k) => ({ type: k.subjectType, id: k.subjectId }))),
  ]);

  const out: FilesLibraryRow[] = kept.map((k) => ({
    slot_key: k.slotKey,
    latest: k.latest,
    version_count: k.versions.filter((v) => !v.deleted_at).length,
    comment_count: commentCounts.get(k.slotKey) ?? 0,
    belongs_to: labels.get(`${k.subjectType}:${k.subjectId}`) ?? { kind: k.subjectType, id: k.subjectId, label: k.subjectId },
  }));
  // "missing-ness" is answered from the other side (sessions with no slides
  // slot at all) — surfaced by the caller joining against the roster/session
  // list, since a library over `asset` alone cannot show what was never
  // uploaded.
  return out.sort((a, b) => str(b.latest.created_at).localeCompare(str(a.latest.created_at)));
}

/** Sessions in the event with no `session:<id>:slides` slot yet — "whose slides are still not here". */
export async function sessionsMissingSlides(app: AppContext, eventId: string): Promise<Row[]> {
  return app.db.raw<Row>(
    `SELECT s.* FROM session s
      WHERE s.event_id = ? AND s.deleted_at IS NULL AND s.status != 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM asset a WHERE a.slot_key = 'session:' || s.id || ':slides' AND a.deleted_at IS NULL)
      ORDER BY s.title`,
    [eventId],
  );
}

/* -------------------------------------------------------------------------- */
/* JSON shapes                                                                 */
/* -------------------------------------------------------------------------- */

export function assetJson(row: Row, isLatest: boolean): Record<string, unknown> {
  return {
    id: str(row.id),
    storage_key: str(row.storage_key),
    filename: str(row.filename),
    content_type: str(row.content_type),
    size_bytes: num(row.size_bytes),
    checksum: str(row.checksum),
    width: row.width === null || row.width === undefined ? null : num(row.width),
    height: row.height === null || row.height === undefined ? null : num(row.height),
    scan_status: str(row.scan_status),
    visibility: str(row.visibility),
    uploaded_by_person_id: str(row.uploaded_by_person_id),
    purpose: str(row.purpose),
    expires_at: strOrNull(row.expires_at),
    slot_key: str(row.slot_key),
    version: num(row.version),
    supersedes_asset_id: strOrNull(row.supersedes_asset_id),
    is_latest: isLatest, // D — no column (INV-11-6)
    created_at: str(row.created_at),
  };
}

export function commentJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    asset_id: str(row.asset_id),
    slot_key: str(row.slot_key),
    author_person_id: str(row.author_person_id),
    body: str(row.body),
    parent_id: strOrNull(row.parent_id),
    created_at: str(row.created_at),
    edited_at: strOrNull(row.edited_at),
  };
}

export function customFieldJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    subject_type: str(row.subject_type),
    key: str(row.key),
    label: str(row.label),
    help_text: strOrNull(row.help_text),
    type: str(row.type),
    options: row.options ? parseJson<unknown[]>(row.options, []) : null,
    is_required: bool(row.is_required),
    pii: bool(row.pii),
    audience: str(row.audience),
    show_in_list: bool(row.show_in_list),
    is_filterable: bool(row.is_filterable),
    sort_order: num(row.sort_order),
    status: str(row.status),
  };
}

export function importJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    subject: str(row.subject),
    source_asset_id: strOrNull(row.source_asset_id),
    column_mapping: parseJson<Record<string, string>>(row.column_mapping, {}),
    dedupe_key: str(row.dedupe_key),
    on_duplicate: str(row.on_duplicate),
    status: str(row.status),
    requested_by_person_id: str(row.requested_by_person_id),
    created_at: str(row.created_at),
    completed_at: strOrNull(row.completed_at),
  };
}

export function exportJson(row: Row, rowCount: number | null, byteSize: number | null): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    subject: str(row.subject),
    format: str(row.format),
    filters: row.filters ? parseJson<Record<string, unknown>>(row.filters, {}) : null,
    options: row.options ? parseJson<Record<string, unknown>>(row.options, {}) : null,
    include_pii: bool(row.include_pii),
    status: str(row.status),
    result_asset_id: strOrNull(row.result_asset_id),
    row_count: rowCount, // D
    byte_size: byteSize, // D
    expires_at: str(row.expires_at),
    requested_by_person_id: str(row.requested_by_person_id),
    created_at: str(row.created_at),
  };
}

/** `byte_size` is derived off the generated `Asset.size_bytes` (INV-11-6). */
export async function exportSize(app: AppContext, row: Row): Promise<{ row_count: number | null; byte_size: number | null }> {
  if (!row.result_asset_id) return { row_count: null, byte_size: null };
  const asset = await app.db.byId<Row>("asset", str(row.result_asset_id));
  return { row_count: null, byte_size: asset ? num(asset.size_bytes) : null };
}

export { redactRecord };
