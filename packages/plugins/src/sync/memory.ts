/**
 * `sync.memory` — a working table tool that happens to have no server.
 *
 * The two-way sync is the one integration whose interesting behaviour is a
 * *loop*: push, provider reports a change, pull, write, event, push. None of
 * that can be seen — in a test, in `npm run dev`, or by somebody deciding
 * whether to wire up a real base — without something on the other end. Requiring
 * an Airtable account to find out whether echo suppression works is how echo
 * suppression stays untested.
 *
 * So this is a real implementation of the contract against an in-memory store,
 * in the same spirit as `email.log` and `ticketing.stub`: it makes the default
 * path exercisable rather than exceptional. `editExternally` is the piece a real
 * provider gets for free — a human typing in a cell.
 *
 * State is module-scoped and therefore per-isolate: fine for a test and for
 * local dev, useless in production, which is why it is not a `FALLBACK_PLUGINS`
 * entry. Nothing selects it unless an operator installs it by name.
 */

import type {
  PluginContext,
  SyncChangePage,
  SyncPlugin,
  SyncRecordInput,
  SyncTable,
  SyncUpsertResult,
} from "../contracts.js";

interface MemoryRecord {
  external_id: string;
  fields: Record<string, unknown>;
  deleted?: boolean;
}

const TABLES = new Map<string, Map<string, MemoryRecord>>();
let counter = 0;

function keyFor(ctx: PluginContext, table: string): string {
  return `${ctx.integration_id ?? "none"}:${table}`;
}

function tableOf(ctx: PluginContext, table: string): Map<string, MemoryRecord> {
  const key = keyFor(ctx, table);
  let rows = TABLES.get(key);
  if (!rows) {
    rows = new Map();
    TABLES.set(key, rows);
  }
  return rows;
}

export const syncMemoryPlugin: SyncPlugin = {
  key: "sync.memory",
  capability: "sync",
  display_name: "In-memory table (development)",
  requires_secret: false,
  // Deliberately small, so the batching path is exercised by a handful of
  // records rather than only by a real four-hundred-proposal push.
  batch_limit: 3,
  config_fields: [
    { key: "tables", label: "Table names", help: "Comma-separated. Only used to populate the mapping form." },
  ],

  async list_tables(ctx: PluginContext): Promise<SyncTable[]> {
    const names = String(ctx.config.tables ?? "Sessions,Speakers,Proposals,Sponsors")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return names.map((name) => ({
      external_table_id: name,
      name,
      fields: [...new Set([...tableOf(ctx, name).values()].flatMap((r) => Object.keys(r.fields)))].map((f) => ({
        external_field: f,
        label: f,
        type: "singleLineText",
      })),
    }));
  },

  async describe_table(externalTableId: string, ctx: PluginContext): Promise<SyncTable> {
    const rows = tableOf(ctx, externalTableId);
    return {
      external_table_id: externalTableId,
      name: externalTableId,
      fields: [...new Set([...rows.values()].flatMap((r) => Object.keys(r.fields)))].map((f) => ({
        external_field: f,
        label: f,
        type: "singleLineText",
      })),
    };
  },

  async upsert_records(externalTableId: string, records: SyncRecordInput[], ctx: PluginContext): Promise<SyncUpsertResult[]> {
    const rows = tableOf(ctx, externalTableId);
    return records.map((r) => {
      const id = r.external_id ?? `rec${String(++counter).padStart(6, "0")}`;
      const existing = rows.get(id);
      // Merge rather than replace, like every real table tool: a column this
      // mapping does not know about belongs to the organizer, not to us.
      rows.set(id, { external_id: id, fields: { ...(existing?.fields ?? {}), ...r.fields } });
      return { external_id: id };
    });
  },

  async list_changes(externalTableId: string, cursor: string | null, ctx: PluginContext): Promise<SyncChangePage> {
    const all = [...tableOf(ctx, externalTableId).values()];
    // Paged like a provider would, so a caller that ignores `has_more` fails
    // here rather than against the real thing.
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + 50);
    const next = start + page.length;
    return {
      changes: page.map((r) => ({ external_id: r.external_id, fields: r.fields, deleted: r.deleted })),
      next_cursor: next < all.length ? String(next) : null,
      has_more: next < all.length,
    };
  },

  async delete_records(externalTableId: string, externalIds: string[], ctx: PluginContext): Promise<void> {
    const rows = tableOf(ctx, externalTableId);
    for (const id of externalIds) rows.delete(id);
  },

  async handle_inbound_webhook(payload: unknown): Promise<{ external_table_ids: string[] | null }> {
    const body = (payload ?? {}) as Record<string, unknown>;
    return { external_table_ids: typeof body.table_id === "string" ? [body.table_id] : null };
  },

  async health() {
    return { ok: true };
  },
};

/* -------------------------------------------------------------------------- */
/* Test and development helpers                                                */
/* -------------------------------------------------------------------------- */

/** What a human typing in a cell looks like from this side. */
export function editExternally(integrationId: string, table: string, externalId: string, fields: Record<string, unknown>): void {
  const rows = TABLES.get(`${integrationId}:${table}`);
  const row = rows?.get(externalId);
  if (!row) throw new Error(`No record ${externalId} in ${table}.`);
  row.fields = { ...row.fields, ...fields };
}

/** A row somebody added by hand, which the sync must refuse to turn into a record. */
export function insertExternally(integrationId: string, table: string, fields: Record<string, unknown>): string {
  const key = `${integrationId}:${table}`;
  let rows = TABLES.get(key);
  if (!rows) {
    rows = new Map();
    TABLES.set(key, rows);
  }
  const id = `rec${String(++counter).padStart(6, "0")}`;
  rows.set(id, { external_id: id, fields });
  return id;
}

export function externalRecords(integrationId: string, table: string): MemoryRecord[] {
  return [...(TABLES.get(`${integrationId}:${table}`)?.values() ?? [])];
}

export function resetExternalTables(): void {
  TABLES.clear();
  counter = 0;
}
