/**
 * `sync.airtable` — the two-way mirror against an Airtable base.
 *
 * The base id is configuration; the personal access token is the credential and
 * lives behind `secret_ref` (INV-09-3). The token needs `schema.bases:read`,
 * `data.records:read` and `data.records:write` on the one base.
 *
 * Three provider facts shape this adapter, and all three are why the contract
 * looks the way it does:
 *
 *   * **Ten records per write.** `batch_limit` is 10 because Airtable's records
 *     endpoint refuses an eleventh, so the core batches rather than discovering
 *     this at 400 proposals.
 *   * **Five requests per second per base.** Exceeding it earns a 429 and a
 *     30-second lockout, which is far more expensive than waiting. Requests are
 *     spaced here rather than in the core, because the limit is Airtable's, not
 *     a property of syncing.
 *   * **The change feed is not worth its complexity.** Airtable's webhook
 *     payload cursor needs a webhook registered per base, refreshed every seven
 *     days, and returns change specs rather than records. At conference scale —
 *     hundreds to low thousands of rows — listing the table and letting the core
 *     hash-compare is simpler, has no expiry to forget, and cannot silently miss
 *     a change. `list_changes` therefore pages the whole table and returns it;
 *     the core was going to hash every record anyway (INV-09-19), so this costs
 *     reads, not correctness.
 */

import {
  configString,
  PluginError,
  type PluginContext,
  type SyncChangePage,
  type SyncPlugin,
  type SyncRecordInput,
  type SyncTable,
  type SyncUpsertResult,
} from "../contracts.js";

const API = "https://api.airtable.com/v0";

/** 5 req/s per base; 210ms keeps a margin without being slow enough to notice. */
const MIN_REQUEST_GAP_MS = 210;

/** Airtable's hard cap on records per create/update call. */
const BATCH_LIMIT = 10;

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

function baseId(ctx: PluginContext): string {
  const id = configString(ctx, "base_id").trim();
  if (!id) throw new PluginError("sync.airtable", "No Airtable base id is configured.");
  return id;
}

/**
 * One request, rate-limited and with the provider's error text preserved.
 *
 * `last_error` on the integration is the only thing an organizer sees when a
 * sync stops, so an Airtable message like "Unknown field name: Speakers" has to
 * survive to it. A bare status code sends them to the logs.
 */
async function call<T>(
  ctx: PluginContext,
  path: string,
  init: RequestInit & { gate?: RateGate } = {},
): Promise<T> {
  if (!ctx.secret) throw new PluginError("sync.airtable", "No Airtable access token is configured.");
  await (init.gate ?? sharedGate).wait();

  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.secret}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PluginError("sync.airtable", airtableMessage(res.status, body), res.status);
  }
  return (await res.json()) as T;
}

function airtableMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } | string };
    const err = parsed.error;
    const message = typeof err === "string" ? err : (err?.message ?? err?.type);
    if (message) return `Airtable: ${message}`;
  } catch {
    /* fall through to the raw body */
  }
  if (status === 429) return "Airtable is rate-limiting this base; the next sweep will retry.";
  return `Airtable returned ${status}. ${body.slice(0, 200)}`.trim();
}

/**
 * Spaces requests to one per `MIN_REQUEST_GAP_MS`.
 *
 * Module-scoped because the limit is per base and a Worker isolate handles one
 * organization's sweep at a time; a per-call gate would let a batch of ten
 * upserts fire together and earn exactly the 429 this exists to avoid.
 */
class RateGate {
  private next = 0;
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + MIN_REQUEST_GAP_MS;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const sharedGate = new RateGate();

function encodeTable(externalTableId: string): string {
  return encodeURIComponent(externalTableId);
}

export const syncAirtablePlugin: SyncPlugin = {
  key: "sync.airtable",
  capability: "sync",
  display_name: "Airtable",
  requires_secret: true,
  batch_limit: BATCH_LIMIT,
  config_fields: [
    {
      key: "base_id",
      label: "Base id",
      required: true,
      help: "Starts with `app`. From the base's API docs, or its URL: airtable.com/appXXXXXXXX/...",
    },
  ],

  async list_tables(ctx: PluginContext): Promise<SyncTable[]> {
    const data = await call<{ tables: { id: string; name: string; fields: { name: string; type: string }[] }[] }>(
      ctx,
      `/meta/bases/${baseId(ctx)}/tables`,
    );
    return data.tables.map((t) => ({
      external_table_id: t.id,
      name: t.name,
      fields: t.fields.map((f) => ({
        external_field: f.name,
        label: f.name,
        type: f.type,
        // A formula or rollup accepts no write; offering it as a push target
        // produces a mapping that fails on every record forever.
        read_only: ["formula", "rollup", "count", "autoNumber", "createdTime", "lastModifiedTime"].includes(f.type),
      })),
    }));
  },

  async describe_table(externalTableId: string, ctx: PluginContext): Promise<SyncTable> {
    const tables = await this.list_tables(ctx);
    const found = tables.find((t) => t.external_table_id === externalTableId);
    if (!found) throw new PluginError("sync.airtable", `Table ${externalTableId} is not in this base.`, 404);
    return found;
  },

  /**
   * Creates and updates in one call, split into runs of ten.
   *
   * Records are keyed by Airtable's own id, which the core stored on the link at
   * first push — never by matching a field value. Field matching is how a sync
   * merges two speakers who happen to share a name.
   */
  async upsert_records(
    externalTableId: string,
    records: SyncRecordInput[],
    ctx: PluginContext,
  ): Promise<SyncUpsertResult[]> {
    const base = baseId(ctx);
    const path = `/${base}/${encodeTable(externalTableId)}`;
    const out: SyncUpsertResult[] = [];

    const creates = records.filter((r) => !r.external_id);
    const updates = records.filter((r) => r.external_id);

    for (const chunk of chunks(updates, BATCH_LIMIT)) {
      const body = { records: chunk.map((r) => ({ id: r.external_id, fields: r.fields })), typecast: true };
      try {
        const res = await call<{ records: AirtableRecord[] }>(ctx, path, { method: "PATCH", body: JSON.stringify(body) });
        for (const rec of res.records) out.push({ external_id: rec.id });
      } catch (error) {
        // One bad chunk must not lose the rest of the sweep: the failure is
        // reported per record so the core can mark just those links `error`.
        for (const r of chunk) out.push({ external_id: r.external_id as string, error: String(error) });
      }
    }

    for (const chunk of chunks(creates, BATCH_LIMIT)) {
      const body = { records: chunk.map((r) => ({ fields: r.fields })), typecast: true };
      try {
        const res = await call<{ records: AirtableRecord[] }>(ctx, path, { method: "POST", body: JSON.stringify(body) });
        // Airtable returns created records in request order, which is the only
        // thing tying a new external id back to the record that asked for it.
        res.records.forEach((rec) => out.push({ external_id: rec.id }));
      } catch (error) {
        for (const _ of chunk) out.push({ external_id: "", error: String(error) });
      }
    }

    return out;
  },

  /**
   * Every record in the table, paginated. See the note at the top of this file
   * for why this is a full read rather than a change feed.
   *
   * `cursor` carries Airtable's page offset *within* one sweep, so a sweep that
   * runs out of time resumes rather than starting over.
   */
  async list_changes(externalTableId: string, cursor: string | null, ctx: PluginContext): Promise<SyncChangePage> {
    const params = new URLSearchParams({ pageSize: "100" });
    if (cursor) params.set("offset", cursor);
    const view = configString(ctx, "view");
    if (view) params.set("view", view);

    const data = await call<{ records: AirtableRecord[]; offset?: string }>(
      ctx,
      `/${baseId(ctx)}/${encodeTable(externalTableId)}?${params.toString()}`,
    );

    return {
      changes: data.records.map((r) => ({ external_id: r.id, fields: r.fields })),
      next_cursor: data.offset ?? null,
      has_more: Boolean(data.offset),
    };
  },

  async delete_records(externalTableId: string, externalIds: string[], ctx: PluginContext): Promise<void> {
    const base = baseId(ctx);
    for (const chunk of chunks(externalIds.filter(Boolean), BATCH_LIMIT)) {
      const params = new URLSearchParams();
      for (const id of chunk) params.append("records[]", id);
      try {
        await call(ctx, `/${base}/${encodeTable(externalTableId)}?${params.toString()}`, { method: "DELETE" });
      } catch (error) {
        // An id that is already gone is the desired end state, not a failure —
        // and erasure must not stall on one. Anything else is worth raising,
        // because INV-09-22 says an erasure that did not happen is reported.
        if (!(error instanceof PluginError) || error.status !== 404) throw error;
      }
    }
  },

  /**
   * Airtable's automation webhook posts an arbitrary body — there is no standard
   * shape and no signature we could check uniformly, which is exactly why the
   * URL is the credential (INV-09-15). So the payload is treated as a ping:
   * something in the base changed, go and read it.
   */
  async handle_inbound_webhook(payload: unknown, _ctx: PluginContext): Promise<{ external_table_ids: string[] | null }> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const named = body.table_id ?? body.tableId;
    return { external_table_ids: typeof named === "string" && named ? [named] : null };
  },

  async health(ctx: PluginContext) {
    if (!ctx.secret) return { ok: false, error: "No Airtable access token is configured." };
    const base = configString(ctx, "base_id").trim();
    if (!base) return { ok: false, error: "No Airtable base id is configured." };
    if (!base.startsWith("app")) return { ok: false, error: "An Airtable base id starts with `app`." };
    try {
      const tables = await this.list_tables(ctx);
      return tables.length > 0
        ? { ok: true }
        : { ok: false, error: "The token reached the base but it has no tables." };
    } catch (error) {
      return { ok: false, error: error instanceof PluginError ? error.message : String(error) };
    }
  },
};

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
