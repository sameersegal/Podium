/**
 * `CustomFieldDefinition` — 11-cross-cutting.md, "Custom fields".
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { DomainError, notFound } from "@podiumconf/domain/shared/errors.js";
import { newId, slugify } from "@podiumconf/domain/shared/ids.js";
import {
  assertDeclaredClassification,
  assertDefinitionShape,
  redactCustomValues,
  usageOf,
  type CustomFieldDefinitionView,
  type DefinitionInput,
} from "@podiumconf/domain/content/custom-fields.js";
import { CUSTOM_FIELD_SOFT_LIMIT, type CustomFieldSubject } from "@podiumconf/domain/content/types.js";

export function toView(row: Row): CustomFieldDefinitionView {
  return {
    id: str(row.id),
    key: str(row.key),
    label: str(row.label),
    help_text: strOrNull(row.help_text),
    type: str(row.type) as CustomFieldDefinitionView["type"],
    options: row.options ? parseJson<{ value: string; label: string }[]>(row.options, []) : null,
    is_required: bool(row.is_required),
    pii: bool(row.pii),
    audience: str(row.audience) as CustomFieldDefinitionView["audience"],
    show_in_list: bool(row.show_in_list),
    is_filterable: bool(row.is_filterable),
    sort_order: num(row.sort_order),
    status: str(row.status) as CustomFieldDefinitionView["status"],
  };
}

export interface CreateFieldInput extends DefinitionInput {
  subject_type: CustomFieldSubject;
  event_id?: string | null;
  show_in_list?: boolean;
  is_filterable?: boolean;
  sort_order?: number;
}

/**
 * INV-11-11: `pii` and `audience` are required at creation, never defaulted —
 * `assertDeclaredClassification` checks presence, not truthiness.
 */
export async function createDefinition(app: AppContext, input: CreateFieldInput): Promise<Row> {
  assertDefinitionShape(input);
  const { pii, audience } = assertDeclaredClassification(input);
  const key = input.key ? slugify(input.key) : slugify(input.label);

  const existing = await app.db.first<Row>("custom_field_definition", { subject_type: input.subject_type, key });
  if (existing) {
    throw new DomainError({ code: "field_exists", message: `"${key}" already exists for ${input.subject_type}. Keys are immutable once values exist.`, status: 409 });
  }

  const id = newId("CustomFieldDefinition");
  const row: Row = {
    id,
    org_id: app.orgId,
    event_id: input.event_id ?? null,
    subject_type: input.subject_type,
    key,
    label: input.label,
    help_text: null,
    type: input.type,
    options: input.options ? JSON.stringify(input.options) : null,
    is_required: input.is_required ? 1 : 0,
    pii: pii ? 1 : 0,
    audience,
    show_in_list: input.show_in_list ? 1 : 0,
    is_filterable: input.is_filterable ? 1 : 0,
    sort_order: input.sort_order ?? 0,
    status: "active",
    created_at: app.now(),
  };
  await app.db.insert("custom_field_definition", row);
  app.events.emit({
    type: "custom_field.defined",
    subject: { type: "custom_field", id },
    data: { definition_id: id, subject_type: input.subject_type, key, type: input.type, pii, audience },
  });
  app.audit.record({ action: "custom_field.create", entity_type: "custom_field_definition", entity_id: id, after: { key, subject_type: input.subject_type, pii, audience } });
  return row;
}

export async function updateDefinition(
  app: AppContext,
  id: string,
  patch: { label?: string; help_text?: string | null; is_required?: boolean; show_in_list?: boolean; is_filterable?: boolean; sort_order?: number; options?: { value: string; label: string }[] | null },
): Promise<void> {
  await getDefinition(app, id); // 404s if missing
  const update: Row = {};
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.help_text !== undefined) update.help_text = patch.help_text;
  if (patch.is_required !== undefined) update.is_required = patch.is_required ? 1 : 0;
  if (patch.show_in_list !== undefined) update.show_in_list = patch.show_in_list ? 1 : 0;
  if (patch.is_filterable !== undefined) update.is_filterable = patch.is_filterable ? 1 : 0;
  if (patch.sort_order !== undefined) update.sort_order = patch.sort_order;
  if (patch.options !== undefined) update.options = patch.options ? JSON.stringify(patch.options) : null;
  // `pii` and `audience` are classified once at creation and never re-decided
  // silently — changing them would retroactively reclassify values nobody
  // re-reviewed, so there is deliberately no update path for either here.
  if (Object.keys(update).length === 0) return;
  await app.db.update("custom_field_definition", id, update);
  app.audit.record({ action: "custom_field.update", entity_type: "custom_field_definition", entity_id: id, after: update });
}

export async function archiveDefinition(app: AppContext, id: string): Promise<void> {
  await app.db.update("custom_field_definition", id, { status: "archived" });
  app.audit.record({ action: "custom_field.archive", entity_type: "custom_field_definition", entity_id: id });
}

export async function unarchiveDefinition(app: AppContext, id: string): Promise<void> {
  await app.db.update("custom_field_definition", id, { status: "active" });
  app.audit.record({ action: "custom_field.unarchive", entity_type: "custom_field_definition", entity_id: id });
}

export async function getDefinition(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("custom_field_definition", id);
  if (!row) throw notFound("Custom field definition", id);
  return row;
}

export async function listDefinitions(app: AppContext, subjectType?: CustomFieldSubject | null): Promise<Row[]> {
  const where: Row = {};
  if (subjectType) where.subject_type = subjectType;
  return app.db.select<Row>("custom_field_definition", where, { orderBy: "subject_type, sort_order, label" });
}

/** R27: no hard cap; a soft warning past roughly 25 definitions per subject type. */
export async function definitionCountBySubject(app: AppContext): Promise<Record<string, number>> {
  const rows = await app.db.raw<{ subject_type: string; n: number }>(
    "SELECT subject_type, COUNT(*) AS n FROM custom_field_definition WHERE org_id = ? AND status = 'active' GROUP BY subject_type",
    [app.orgId],
  );
  return Object.fromEntries(rows.map((r) => [r.subject_type, r.n]));
}

export function overSoftLimit(count: number): boolean {
  return count > CUSTOM_FIELD_SOFT_LIMIT;
}

/** The table on the subject each definition lives on, and its `custom_field_values` column. */
const SUBJECT_TABLE: Record<CustomFieldSubject, string> = {
  person: "person",
  event_participant: "event_participant",
  session: "session",
  sponsor: "sponsor",
};

/**
 * "Fill rate and last-used date per definition" (11, "Custom fields") — the
 * field-management screen's whole point, since the guardrail that matters is
 * INV-11-11, not a count.
 */
export async function usageFor(app: AppContext, def: Row): Promise<ReturnType<typeof usageOf>> {
  const table = SUBJECT_TABLE[str(def.subject_type) as CustomFieldSubject];
  const rows = await app.db.select<Row>(table, {});
  const subjects = rows.map((r) => ({ values: parseJson<Record<string, unknown>>(r.custom_field_values, {}), updated_at: strOrNull(r.updated_at) ?? strOrNull(r.created_at) }));
  return usageOf(toView(def), subjects);
}

export { redactCustomValues };
