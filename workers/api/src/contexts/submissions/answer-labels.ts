/**
 * The names behind the ids a `ProposalAnswer` holds, so a reader sees "Platform
 * engineering" rather than `trk_01JQ…` (04, `ProposalAnswer.display`).
 *
 * One lookup per referenced table for a whole proposal, not one per answer, and
 * through `db.select` rather than raw SQL so org scoping and soft delete
 * (INV-11-1 / INV-11-2) still apply — an archived track resolves to nothing and
 * renders as `UNRESOLVED_REFERENCE`, which is the honest answer.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import type { FieldType } from "@podiumstack/domain/event-config/types.js";
import { referenceIdsIn, type ReferenceLabels } from "@podiumstack/domain/submissions/answer-display.js";

export interface LabelledAnswer {
  type: FieldType;
  value: unknown;
}

interface LabelSource {
  table: string;
  name: (row: Row) => string;
}

/** Which entity each reference-valued field type points at, and what names it. */
const SOURCE_FOR: Partial<Record<FieldType, LabelSource>> = {
  track_picker: { table: "track", name: (r) => str(r.name) },
  format_picker: { table: "session_format", name: (r) => str(r.name) },
  speaker_list: { table: "person", name: (r) => str(r.display_name) || str(r.full_name) },
  file: { table: "asset", name: (r) => str(r.filename) },
};

export async function referenceLabels(app: AppContext, answers: LabelledAnswer[]): Promise<ReferenceLabels> {
  const idsByTable = new Map<string, { source: LabelSource; ids: Set<string> }>();
  for (const a of answers) {
    const source = SOURCE_FOR[a.type];
    if (!source) continue;
    const ids = referenceIdsIn(a.type, a.value);
    if (ids.length === 0) continue;
    const bucket = idsByTable.get(source.table) ?? { source, ids: new Set<string>() };
    for (const id of ids) bucket.ids.add(id);
    idsByTable.set(source.table, bucket);
  }

  const labels: Record<string, string> = {};
  for (const { source, ids } of idsByTable.values()) {
    const rows = await app.db.select<Row>(source.table, { id: [...ids] });
    for (const row of rows) labels[str(row.id)] = source.name(row);
  }
  return labels;
}
