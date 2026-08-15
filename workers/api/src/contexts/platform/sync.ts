/**
 * Two-way sync — 09, "Two-way sync"; R31.
 *
 * The push half marks links dirty from domain events and drains them in
 * debounced batches. The pull half reads the external table, throws away this
 * system's own echoes, and applies what is left through the owning context's
 * service — losing to any local edit made since the last push.
 *
 * Podium is the system of record, and these are the two lines that make that a
 * mechanism rather than a slogan:
 *
 *     if (isEcho(hash, link)) { counts.echoed++; continue; }                    // INV-09-19
 *     if (num(row.row_version) !== link.last_pushed_version) → conflict          // INV-09-18
 */

import { AppContext, soleOrgId, type Env } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { DomainError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import {
  EMPTY_COUNTS,
  assertSyncLinkTransition,
  attachmentFields,
  columnOf,
  fieldSpec,
  linkFields,
  requiredLinkTargets,
  isEcho,
  projectCanonical,
  projectForPush,
  projectInbound,
  subjectSpec,
  syncHash,
  validateFieldMap,
  writableEntries,
  type SyncCounts,
  type SyncFieldMap,
  type SyncLinkStatus,
  type SyncRunDirection,
  type SyncRunTrigger,
  type SyncSubject,
} from "@podiumstack/domain/platform/sync.js";
import type { SyncColumnSpec, SyncPlugin, SyncRecordInput } from "@podiumstack/plugins/registry.js";

import { resolvePlugin, resolvePluginForIntegration, type ResolvedPlugin } from "./service.js";
import { adapterFor, personLinkedSubjects, type MappingScope } from "./sync-subjects.js";

/** How many links one push sweep drains. Bounded so a sweep fits a Worker invocation. */
const PUSH_BATCH = 200;

/** How many external records one pull sweep reads before handing back to the queue. */
const PULL_PAGE_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/* Mapping lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export interface MappingInput {
  integration_id: string;
  subject: SyncSubject;
  external_table_id: string;
  external_table_name?: string | null;
  field_map: SyncFieldMap[];
  include_pii?: boolean;
  filter?: Record<string, unknown> | null;
  event_id?: string | null;
}

export async function createMapping(app: AppContext, input: MappingInput): Promise<Row> {
  const integration = await app.db.byId<Row>("integration", input.integration_id);
  if (!integration) throw notFound("Integration", input.integration_id);
  if (str(integration.capability) !== "sync") {
    throw new DomainError({
      code: "not_a_sync_integration",
      message: `${str(integration.display_name)} is a ${str(integration.capability)} integration, not a sync one.`,
      status: 422,
    });
  }

  const spec = subjectSpec(input.subject);
  const eventId = input.event_id ?? app.eventId ?? null;
  if (spec.scope === "event" && !eventId) {
    throw new DomainError({
      code: "event_required",
      message: `${spec.label} belong to one event, so the mapping needs one.`,
      status: 422,
    });
  }

  const includePii = Boolean(input.include_pii);
  // INV-09-17 and INV-09-21, at save time, while the organizer is looking at it.
  validateFieldMap(input.subject, input.field_map, includePii);

  const id = newId("SyncMapping");
  const now = app.now();
  await app.db.insert("sync_mapping", {
    id,
    integration_id: input.integration_id,
    event_id: spec.scope === "event" ? eventId : null,
    subject: input.subject,
    external_table_id: input.external_table_id,
    external_table_name: input.external_table_name ?? "",
    field_map: JSON.stringify(input.field_map),
    include_pii: includePii ? 1 : 0,
    filter: input.filter ? JSON.stringify(input.filter) : null,
    is_active: 1,
    created_by_person_id: app.actor.id ?? "",
    created_at: now,
    updated_at: now,
  });

  app.events.emit({
    type: "sync_mapping.created",
    subject: { type: "sync_mapping", id },
    event_id: spec.scope === "event" ? eventId : null,
    data: {
      mapping_id: id,
      integration_id: input.integration_id,
      subject: input.subject,
      external_table_id: input.external_table_id,
      field_count: input.field_map.length,
      include_pii: includePii,
    },
  });
  app.audit.record({
    action: "sync_mapping.create",
    entity_type: "sync_mapping",
    entity_id: id,
    after: { subject: input.subject, external_table_id: input.external_table_id, include_pii: includePii },
  });

  return (await app.db.byId<Row>("sync_mapping", id))!;
}

export async function updateMapping(
  app: AppContext,
  mappingId: string,
  patch: Partial<MappingInput> & { is_active?: boolean },
  expectedVersion?: number | null,
): Promise<Row> {
  const mapping = await getMapping(app, mappingId);
  const subject = str(mapping.subject);
  const includePii = patch.include_pii ?? bool(mapping.include_pii);
  const fieldMap = patch.field_map ?? fieldMapOf(mapping);

  validateFieldMap(subject, fieldMap, includePii);

  const values: Row = { updated_at: app.now() };
  if (patch.field_map) values.field_map = JSON.stringify(patch.field_map);
  if (patch.include_pii !== undefined) values.include_pii = includePii ? 1 : 0;
  if (patch.filter !== undefined) values.filter = patch.filter ? JSON.stringify(patch.filter) : null;
  if (patch.external_table_id) values.external_table_id = patch.external_table_id;
  if (patch.external_table_name !== undefined) values.external_table_name = patch.external_table_name ?? "";

  const wasActive = bool(mapping.is_active);
  if (patch.is_active !== undefined) values.is_active = patch.is_active ? 1 : 0;

  if (expectedVersion !== undefined && expectedVersion !== null) {
    await app.db.updateVersioned("sync_mapping", mappingId, expectedVersion, values);
  } else {
    await app.db.update("sync_mapping", mappingId, values);
  }

  if (patch.is_active !== undefined && patch.is_active !== wasActive) {
    app.events.emit({
      type: patch.is_active ? "sync_mapping.activated" : "sync_mapping.deactivated",
      subject: { type: "sync_mapping", id: mappingId },
      event_id: strOrNull(mapping.event_id),
      data: patch.is_active
        ? { mapping_id: mappingId, subject, external_table_id: str(mapping.external_table_id) }
        : { mapping_id: mappingId, subject, reason: "turned off by an organizer" },
    });
  }
  app.audit.record({ action: "sync_mapping.update", entity_type: "sync_mapping", entity_id: mappingId, after: values });

  // A field map change invalidates every stored hash: the projection covers a
  // different set of fields now, so the old hash cannot be compared against the
  // new one. Re-pushing is the only honest way to re-establish the baseline.
  if (patch.field_map || patch.include_pii !== undefined) await markMappingDirty(app, mappingId);

  return (await app.db.byId<Row>("sync_mapping", mappingId))!;
}

export async function getMapping(app: AppContext, mappingId: string): Promise<Row> {
  const row = await app.db.byId<Row>("sync_mapping", mappingId);
  if (!row) throw notFound("SyncMapping", mappingId);
  return row;
}

export function fieldMapOf(mapping: Row): SyncFieldMap[] {
  return parseJson<SyncFieldMap[]>(mapping.field_map, []);
}

export function scopeOf(mapping: Row): MappingScope {
  return { eventId: strOrNull(mapping.event_id), filter: parseJson<Record<string, unknown> | null>(mapping.filter, null) };
}

export async function activeMappings(app: AppContext, integrationId?: string): Promise<Row[]> {
  const where: Row = { is_active: 1 };
  if (integrationId) where.integration_id = integrationId;
  return app.db.select<Row>("sync_mapping", where);
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

async function linkFor(app: AppContext, mappingId: string, subjectType: string, subjectId: string): Promise<Row | null> {
  return app.db.first<Row>("external_record_link", {
    mapping_id: mappingId,
    subject_type: subjectType,
    subject_id: subjectId,
  });
}

async function ensureLink(app: AppContext, mapping: Row, subjectId: string): Promise<Row> {
  const mappingId = str(mapping.id);
  const subjectType = str(mapping.subject);
  const existing = await linkFor(app, mappingId, subjectType, subjectId);
  if (existing) return existing;

  const id = newId("ExternalRecordLink");
  const now = app.now();
  await app.db.insert("external_record_link", {
    id,
    mapping_id: mappingId,
    subject_type: subjectType,
    subject_id: subjectId,
    status: "pending_push",
    created_at: now,
    updated_at: now,
  });
  return (await app.db.byId<Row>("external_record_link", id))!;
}

async function moveLink(app: AppContext, link: Row, to: SyncLinkStatus, values: Row = {}): Promise<void> {
  assertSyncLinkTransition(str(link.status) as SyncLinkStatus, to);
  await app.db.update("external_record_link", str(link.id), { ...values, status: to, updated_at: app.now() });
}

/**
 * Mark one record dirty on every mapping that mirrors its subject.
 *
 * Called from the reaction, so it runs once per domain event per handler and is
 * idempotent by construction: setting an already-`pending_push` link to
 * `pending_push` changes nothing.
 */
export async function markDirty(app: AppContext, subject: SyncSubject, subjectId: string, eventId: string | null): Promise<number> {
  const mappings = await activeMappings(app);
  let n = 0;
  for (const mapping of mappings) {
    if (str(mapping.subject) !== subject) continue;
    const scopedTo = strOrNull(mapping.event_id);
    if (scopedTo && eventId && scopedTo !== eventId) continue;
    const link = await ensureLink(app, mapping, subjectId);
    if (str(link.status) === "unlinked") continue; // erased; do not resurrect
    if (str(link.status) === "pending_push") {
      n++;
      continue;
    }
    await moveLink(app, link, "pending_push");
    n++;
  }
  return n;
}

/** Every link on a mapping back to `pending_push`, after a change of shape. */
async function markMappingDirty(app: AppContext, mappingId: string): Promise<void> {
  await app.db.rawRun(
    `UPDATE external_record_link SET status = 'pending_push', updated_at = ?
      WHERE mapping_id = ? AND status IN ('in_sync', 'error')`,
    [app.now(), mappingId],
  );
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

async function startRun(app: AppContext, mapping: Row, direction: SyncRunDirection, trigger: SyncRunTrigger): Promise<string> {
  const id = newId("SyncRun");
  await app.db.insert("sync_run", {
    id,
    mapping_id: str(mapping.id),
    direction,
    trigger,
    status: "running",
    counts: JSON.stringify(EMPTY_COUNTS),
    cursor_before: strOrNull(mapping.last_cursor),
    started_at: app.now(),
  });
  return id;
}

async function finishRun(
  app: AppContext,
  runId: string,
  mapping: Row,
  direction: SyncRunDirection,
  trigger: SyncRunTrigger,
  counts: SyncCounts,
  opts: { cursorAfter?: string | null; error?: string | null } = {},
): Promise<void> {
  const status = opts.error ? "failed" : counts.failed > 0 ? "completed_with_errors" : "completed";
  await app.db.update("sync_run", runId, {
    status,
    counts: JSON.stringify(counts),
    cursor_after: opts.cursorAfter ?? null,
    finished_at: app.now(),
    error: opts.error ?? null,
  });

  const base = { run_id: runId, mapping_id: str(mapping.id), direction, trigger };
  if (opts.error) {
    app.events.emit({
      type: "sync_run.failed",
      subject: { type: "sync_run", id: runId },
      event_id: strOrNull(mapping.event_id),
      data: { ...base, error: opts.error },
    });
    return;
  }
  app.events.emit({
    type: "sync_run.completed",
    subject: { type: "sync_run", id: runId },
    event_id: strOrNull(mapping.event_id),
    data: { ...base, ...counts },
  });
}

/* -------------------------------------------------------------------------- */
/* Resolving links, attachments and named options                              */
/* -------------------------------------------------------------------------- */

/**
 * Podium ids → provider record ids, for one subject's link fields (INV-09-24).
 *
 * A record id is meaningful only inside the base that minted it, so a link can
 * only be written once the *target* subject is mirrored on the same integration.
 * Where it is not, the field is left out of `links` entirely and
 * `projectForPush` omits the column — rather than writing an empty array, which
 * would clear whatever an organizer had linked by hand.
 */
async function resolveLinks(
  app: AppContext,
  mapping: Row,
  subject: SyncSubject,
  related: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const siblings = await app.db.select<Row>("sync_mapping", { integration_id: str(mapping.integration_id), is_active: 1 });

  for (const spec of linkFields(subject)) {
    const ids = related[spec.field];
    if (!ids) continue;
    const target = siblings.find((m) => str(m.subject) === spec.linkTo);
    if (!target) continue; // not mirrored — the column stays untouched
    if (ids.length === 0) {
      out[spec.field] = [];
      continue;
    }
    const links = await app.db.raw<Row>(
      `SELECT subject_id, external_id FROM external_record_link
        WHERE mapping_id = ? AND external_id IS NOT NULL
          AND subject_id IN (${ids.map(() => "?").join(",")})`,
      [str(target.id), ...ids],
    );
    const byId = new Map(links.map((l) => [str(l.subject_id), str(l.external_id)]));
    // Order follows the related ids, which the adapter sorted by billing order.
    // A related record not yet pushed simply has no chip yet; the next sweep
    // over that mapping creates it and this one picks it up.
    out[spec.field] = ids.map((id) => byId.get(id)).filter((x): x is string => Boolean(x));
  }
  return out;
}

/**
 * Asset ids → signed, no-login URLs the provider fetches for itself.
 *
 * Airtable and its kin take a URL, download it once, and keep their own copy —
 * which is what makes a headshot render as a face in gallery view rather than as
 * a link. The URL is short-lived and that is fine: it only has to survive the
 * one fetch.
 */
async function resolveAttachments(
  app: AppContext,
  subject: SyncSubject,
  assets: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const fields = attachmentFields(subject).filter((f) => assets[f.field]);
  if (fields.length === 0) return out;

  const storage = await resolvePlugin(app, "storage", null);
  if (!storage || storage.plugin.capability !== "storage") return out;

  for (const spec of fields) {
    const urls: string[] = [];
    for (const assetId of assets[spec.field]) {
      const asset = await app.db.byId<Row>("asset", assetId);
      // INV-11-3's sibling concern: never hand out a file that failed its scan.
      if (!asset || str(asset.scan_status) === "infected") continue;
      try {
        const signed = await storage.plugin.presign_download(
          { storage_key: str(asset.storage_key), filename: str(asset.filename) || "file" },
          storage.ctx,
        );
        urls.push(signed.url);
      } catch (err) {
        console.warn("attachment presign failed", { asset_id: assetId, error: String(err) });
      }
    }
    out[spec.field] = urls;
  }
  return out;
}

/**
 * A name chosen from a dropdown, back to the id it stands for.
 *
 * Organizers pick "Platform Engineering", not `trk_01J…`, so a track arrives as
 * a name and has to be resolved inside the event. An unrecognised name is
 * refused rather than nulled: somebody typing a new track into a cell means
 * something, and silently clearing the field would lose both the old value and
 * the intent.
 */
async function resolveOptions(
  app: AppContext,
  subject: SyncSubject,
  eventId: string | null,
  options: Record<string, { optionsFrom: string; name: string | null }>,
): Promise<{ patch: Record<string, unknown>; unknown: { field: string; name: string }[] }> {
  const patch: Record<string, unknown> = {};
  const unknown: { field: string; name: string }[] = [];

  for (const [field, want] of Object.entries(options)) {
    const spec = fieldSpec(subject, field);
    if (!spec) continue;
    const column = columnOf(spec);
    if (!want.name) {
      patch[column] = null;
      continue;
    }
    if (!eventId) {
      unknown.push({ field, name: want.name });
      continue;
    }
    const rows = await app.db.raw<Row>(
      `SELECT id, name FROM ${want.optionsFrom === "track" ? "track" : "session_format"}
        WHERE event_id = ? AND deleted_at IS NULL`,
      [eventId],
    );
    const match = rows.find((r) => str(r.name).trim().toLowerCase() === want.name!.trim().toLowerCase());
    if (!match) unknown.push({ field, name: want.name });
    else patch[column] = str(match.id);
  }
  return { patch, unknown };
}

/* -------------------------------------------------------------------------- */
/* Push                                                                        */
/* -------------------------------------------------------------------------- */

function syncPluginOf(resolved: ResolvedPlugin | null): SyncPlugin | null {
  if (!resolved || resolved.plugin.capability !== "sync") return null;
  return resolved.plugin as SyncPlugin;
}

async function resolveForMapping(app: AppContext, mapping: Row): Promise<{ plugin: SyncPlugin; ctx: ResolvedPlugin["ctx"] } | null> {
  const integration = await app.db.byId<Row>("integration", str(mapping.integration_id));
  if (!integration || str(integration.status) === "disabled") return null;
  const resolved = await resolvePluginForIntegration(app, integration);
  const plugin = syncPluginOf(resolved);
  return plugin && resolved ? { plugin, ctx: resolved.ctx } : null;
}

/**
 * Drain one mapping's dirty links.
 *
 * Batched to the provider's `batch_limit`, because a published decision over
 * four hundred proposals arrives as four hundred events and must not become
 * four hundred API calls (09, "The `sync` capability contract").
 */
export async function runPush(app: AppContext, mapping: Row, trigger: SyncRunTrigger): Promise<SyncCounts> {
  const counts: SyncCounts = { ...EMPTY_COUNTS };
  const runId = await startRun(app, mapping, "push", trigger);
  const resolved = await resolveForMapping(app, mapping);
  if (!resolved) {
    await finishRun(app, runId, mapping, "push", trigger, counts, { error: "No active sync integration for this mapping." });
    return counts;
  }

  const subject = str(mapping.subject) as SyncSubject;
  const adapter = adapterFor(subject);
  const fieldMap = fieldMapOf(mapping);
  const includePii = bool(mapping.include_pii);
  const tableId = str(mapping.external_table_id);

  const dirty = await app.db.select<Row>("external_record_link", { mapping_id: str(mapping.id), status: "pending_push" }, {
    limit: PUSH_BATCH,
  });

  // Project first, then batch: a record whose row vanished under us drops out
  // here rather than becoming a provider call that fails.
  const staged: { link: Row; record: SyncRecordInput; hash: string; version: number }[] = [];
  for (const link of dirty) {
    const row = await adapter.load(app, str(link.subject_id));
    if (!row) {
      await moveLink(app, link, "unlinked");
      emitUnlinked(app, mapping, link, "the record no longer exists");
      counts.skipped++;
      continue;
    }
    const opts = {
      includePii,
      derived: await adapter.derived(app, row),
      links: adapter.links ? await resolveLinks(app, mapping, subject, await adapter.links(app, row)) : undefined,
      attachments: adapter.assets ? await resolveAttachments(app, subject, await adapter.assets(app, row)) : undefined,
    };
    staged.push({
      link,
      record: { external_id: strOrNull(link.external_id), fields: projectForPush(subject, row, fieldMap, opts) },
      // Over the hashable fields only: links and attachments carry provider-side
      // ids and fetched copies, which this system cannot reproduce (INV-09-19).
      hash: await syncHash(projectCanonical(subject, row, fieldMap, opts)),
      version: num(row.row_version, 1),
    });
  }

  for (let i = 0; i < staged.length; i += resolved.plugin.batch_limit) {
    const chunk = staged.slice(i, i + resolved.plugin.batch_limit);
    let results: Awaited<ReturnType<SyncPlugin["upsert_records"]>>;
    try {
      results = await resolved.plugin.upsert_records(tableId, chunk.map((s) => s.record), resolved.ctx);
    } catch (error) {
      for (const s of chunk) {
        await moveLink(app, s.link, "error", { last_error: String(error) });
        counts.failed++;
      }
      continue;
    }

    // A provider returning fewer results than records sent would silently
    // mis-pair ids; treat the tail as failed rather than guess.
    for (let j = 0; j < chunk.length; j++) {
      const s = chunk[j];
      const result = results[j];
      if (!result || result.error || !result.external_id) {
        await moveLink(app, s.link, "error", { last_error: result?.error ?? "The provider returned no record id." });
        counts.failed++;
        continue;
      }
      const isNew = !strOrNull(s.link.external_id);
      await moveLink(app, s.link, "in_sync", {
        external_id: result.external_id,
        last_pushed_hash: s.hash,
        last_pushed_version: s.version,
        last_pushed_at: app.now(),
        last_error: null,
        conflict_payload: null,
      });
      if (isNew) {
        app.events.emit({
          type: "sync_link.created",
          subject: { type: "sync_link", id: str(s.link.id) },
          event_id: strOrNull(mapping.event_id),
          data: {
            link_id: str(s.link.id),
            mapping_id: str(mapping.id),
            subject_type: subject,
            subject_id: str(s.link.subject_id),
            external_id: result.external_id,
          },
        });
      }
      counts.pushed++;
    }
  }

  await app.db.update("sync_mapping", str(mapping.id), { last_push_at: app.now(), updated_at: app.now() });
  await finishRun(app, runId, mapping, "push", trigger, counts);
  return counts;
}

function emitUnlinked(app: AppContext, mapping: Row, link: Row, reason: string): void {
  app.events.emit({
    type: "sync_link.unlinked",
    subject: { type: "sync_link", id: str(link.id) },
    event_id: strOrNull(mapping.event_id),
    data: {
      link_id: str(link.id),
      mapping_id: str(mapping.id),
      subject_type: str(link.subject_type),
      subject_id: str(link.subject_id),
      reason,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Pull                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the external table and apply what genuinely changed.
 *
 * Three gates, in this order, and the order is the design:
 *
 *  1. **Unknown record** — an external row with no link is a row somebody added
 *     by hand. Podium is the system of record, so it is not a create: it is
 *     reported and left alone. A sync that invents proposals from spreadsheet
 *     rows is a sync that fails an audit.
 *  2. **Echo** (INV-09-19) — the hash matches something we already wrote.
 *  3. **Stale** (INV-09-18) — the local row moved since we pushed, so this edit
 *     was written against a value that is no longer true, and it loses.
 */
export async function runPull(app: AppContext, mapping: Row, trigger: SyncRunTrigger): Promise<SyncCounts> {
  const counts: SyncCounts = { ...EMPTY_COUNTS };
  const runId = await startRun(app, mapping, "pull", trigger);
  const resolved = await resolveForMapping(app, mapping);
  if (!resolved) {
    await finishRun(app, runId, mapping, "pull", trigger, counts, { error: "No active sync integration for this mapping." });
    return counts;
  }

  const subject = str(mapping.subject) as SyncSubject;
  const adapter = adapterFor(subject);
  const fieldMap = fieldMapOf(mapping);
  const includePii = bool(mapping.include_pii);
  const writable = writableEntries(subject, fieldMap);
  const tableId = str(mapping.external_table_id);

  // A push-only subject still gets its links reconciled, but nothing it
  // carries can be written, so the read is pointless work (INV-09-23).
  if (writable.length === 0) {
    await finishRun(app, runId, mapping, "pull", trigger, counts, { cursorAfter: null });
    return counts;
  }

  let cursor = strOrNull(mapping.last_cursor);
  let error: string | null = null;

  try {
    for (let page = 0; page < PULL_PAGE_LIMIT; page++) {
      const result = await resolved.plugin.list_changes(tableId, cursor, resolved.ctx);
      for (const change of result.changes) {
        await applyInboundChange(app, mapping, subject, change, { adapter, fieldMap, includePii, counts });
      }
      cursor = result.next_cursor;
      if (!result.has_more) break;
    }
  } catch (err) {
    error = String(err);
  }

  await app.db.update("sync_mapping", str(mapping.id), {
    last_cursor: cursor,
    last_pull_at: app.now(),
    updated_at: app.now(),
  });
  await finishRun(app, runId, mapping, "pull", trigger, counts, { cursorAfter: cursor, error });
  return counts;
}

interface InboundDeps {
  adapter: ReturnType<typeof adapterFor>;
  fieldMap: SyncFieldMap[];
  includePii: boolean;
  counts: SyncCounts;
}

async function applyInboundChange(
  app: AppContext,
  mapping: Row,
  subject: SyncSubject,
  change: { external_id: string; fields: Record<string, unknown>; deleted?: boolean },
  deps: InboundDeps,
): Promise<void> {
  const { adapter, fieldMap, includePii, counts } = deps;

  const link = await app.db.first<Row>("external_record_link", {
    mapping_id: str(mapping.id),
    external_id: change.external_id,
  });

  // Gate 1 — a row nobody here created. Podium does not learn records from a
  // spreadsheet; it publishes them to one.
  if (!link) {
    counts.skipped++;
    return;
  }
  if (str(link.status) === "unlinked") {
    counts.skipped++;
    return;
  }

  if (change.deleted) {
    await moveLink(app, link, "pending_push");
    counts.skipped++;
    return;
  }

  const projected = projectInbound(subject, change.fields, fieldMap, { includePii });
  const hash = await syncHash(projected.values);

  // Gate 2 — INV-09-19. The single reason this whole design terminates.
  if (isEcho(hash, link)) {
    counts.echoed++;
    return;
  }

  const row = await adapter.load(app, str(link.subject_id));
  if (!row) {
    await moveLink(app, link, "unlinked");
    emitUnlinked(app, mapping, link, "the record no longer exists");
    counts.skipped++;
    return;
  }

  const currentVersion = num(row.row_version, 1);
  const pushedVersion = link.last_pushed_version === null || link.last_pushed_version === undefined
    ? null
    : num(link.last_pushed_version);

  // Gate 3 — INV-09-18. Podium is the system of record: an edit written against
  // a value we have since changed loses. It is not discarded — the refused
  // values are kept and a human is shown both — and Podium's current value goes
  // back out so the spreadsheet converges rather than sitting on a lie.
  if (pushedVersion === null || currentVersion !== pushedVersion) {
    await recordConflict(app, mapping, subject, link, {
      rejected: projected.patch,
      expected_version: pushedVersion,
      current_version: currentVersion,
    });
    counts.conflicted++;
    return;
  }

  // A track or format arrives as the name in the dropdown, not as an id.
  const resolved = await resolveOptions(app, subject, strOrNull(mapping.event_id), projected.options);
  if (resolved.unknown.length > 0) {
    // Somebody typed a track this event does not have. That is a real intent —
    // possibly a new track, possibly a typo — and neither guessing nor silently
    // clearing the field is an answer a human would accept.
    const named = resolved.unknown.map((u) => `"${u.name}"`).join(", ");
    await recordConflict(app, mapping, subject, link, {
      rejected: { ...projected.patch, ...Object.fromEntries(resolved.unknown.map((u) => [u.field, u.name])) },
      refused_because: `No ${resolved.unknown[0].field.includes("track") ? "track" : "format"} called ${named} in this event. Create it here first, or correct the cell.`,
      expected_version: pushedVersion,
      current_version: currentVersion,
    });
    counts.conflicted++;
    return;
  }

  const patch = { ...projected.patch, ...resolved.patch };
  if (Object.keys(patch).length === 0) {
    counts.skipped++;
    return;
  }

  let changed: string[];
  try {
    changed = (await adapter.apply?.(app, row, patch)) ?? [];
  } catch (err) {
    // A service refusing the write is the system working: an illegal status
    // transition, a duration outside its format, a version that moved under us.
    // It is recorded as a conflict rather than an error, because the organizer's
    // next move is the same either way — look at both values and decide.
    await recordConflict(app, mapping, subject, link, {
      rejected: patch,
      refused_because: errorMessage(err),
      expected_version: pushedVersion,
      current_version: currentVersion,
    });
    counts.conflicted++;
    return;
  }

  // Accepted. `pending_push` rather than `in_sync` on purpose: the service may
  // have normalised, clamped or partly refused the patch, and re-pushing is how
  // the external table ends up holding what Podium actually stored rather than
  // what the spreadsheet proposed. The re-push cannot loop — its own hash lands
  // in `last_pushed_hash`, so the provider's echo of it is dropped by gate 2.
  await moveLink(app, link, "pending_push", {
    last_pulled_hash: hash,
    last_pulled_at: app.now(),
    last_error: null,
  });
  app.audit.record({
    action: "sync.applied_inbound",
    entity_type: str(link.subject_type),
    entity_id: str(link.subject_id),
    after: { changed_fields: changed, mapping_id: str(mapping.id), external_id: change.external_id },
    reason: "Applied from the linked external table.",
  });
  counts.pulled += changed.length > 0 ? 1 : 0;
  if (changed.length === 0) counts.skipped++;
}

/**
 * One conflict, recorded the same way whichever gate refused it.
 *
 * Three things can refuse an inbound change — a local edit since the last push,
 * a name that matches no track here, a service that rejects the write — and an
 * organizer's next move is identical in all three: look at both values and
 * decide. So they produce one record, one event, and one row in one queue, with
 * `refused_because` carrying the difference.
 */
async function recordConflict(
  app: AppContext,
  mapping: Row,
  subject: SyncSubject,
  link: Row,
  detail: {
    rejected: Record<string, unknown>;
    refused_because?: string;
    expected_version: number | null;
    current_version: number;
  },
): Promise<void> {
  await moveLink(app, link, "conflict", {
    conflict_payload: JSON.stringify({ ...detail, seen_at: app.now() }),
    last_error: detail.refused_because ?? null,
  });
  app.events.emit({
    type: "sync_link.conflicted",
    subject: { type: "sync_link", id: str(link.id) },
    event_id: strOrNull(mapping.event_id),
    data: {
      link_id: str(link.id),
      mapping_id: str(mapping.id),
      subject_type: subject,
      subject_id: str(link.subject_id),
      // Names only, never values (10): a conflict payload quoting a bio would
      // put it into the webhook fan-out under a different consumer's rules.
      fields: Object.keys(detail.rejected),
      expected_version: detail.expected_version,
      current_version: detail.current_version,
    },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof DomainError ? `${err.code}: ${err.message}` : String(err);
}

/* -------------------------------------------------------------------------- */
/* Conflict resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * An organizer's two options, and there are deliberately only two.
 *
 * `keep_podium` re-pushes, which is the default the authority rule implies.
 * `accept_external` does not write the refused values either — it clears the
 * conflict and lets the next pull carry them in against the current version,
 * so the edit still goes through every service rule rather than around them.
 */
export async function resolveConflict(app: AppContext, linkId: string, resolution: "keep_podium" | "accept_external"): Promise<Row> {
  const link = await app.db.byId<Row>("external_record_link", linkId);
  if (!link) throw notFound("ExternalRecordLink", linkId);
  if (str(link.status) !== "conflict") {
    throw new DomainError({ code: "not_in_conflict", message: "That link is not in conflict.", status: 422 });
  }
  const mapping = await getMapping(app, str(link.mapping_id));

  await moveLink(app, link, "pending_push", {
    conflict_payload: null,
    last_error: null,
    // Clearing the pulled hash is what lets `accept_external` work: the values
    // that lost would otherwise read as an echo forever.
    last_pulled_hash: resolution === "accept_external" ? null : link.last_pulled_hash,
  });

  app.events.emit({
    type: "sync_link.resolved",
    subject: { type: "sync_link", id: linkId },
    event_id: strOrNull(mapping.event_id),
    data: {
      link_id: linkId,
      mapping_id: str(mapping.id),
      subject_type: str(link.subject_type),
      subject_id: str(link.subject_id),
      resolution,
    },
  });
  app.audit.record({
    action: "sync.conflict_resolved",
    entity_type: "external_record_link",
    entity_id: linkId,
    before: parseJson<Record<string, unknown>>(link.conflict_payload, {}),
    after: { resolution },
  });

  return (await app.db.byId<Row>("external_record_link", linkId))!;
}

/* -------------------------------------------------------------------------- */
/* Scaffolding                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create the table in the provider, or add the columns it is missing.
 *
 * The setup this replaces is an organizer reading a list of twenty column names
 * off one screen and typing them into another, where a single typo produces a
 * column that silently never syncs. Here the mapping already knows the names and
 * the types, so it can just make them.
 *
 * A `link` column needs its target table to exist first, so the target's mapping
 * is scaffolded before this one's link columns are declared; where the target is
 * not mapped at all, the column is left out and the mapping screen says so
 * (INV-09-24).
 */
export async function scaffoldMapping(app: AppContext, mapping: Row): Promise<{ created: boolean; table: string; skipped: string[] }> {
  const resolved = await resolveForMapping(app, mapping);
  if (!resolved) throw new DomainError({ code: "no_sync_integration", message: "This mapping has no active sync integration.", status: 409 });
  if (!resolved.plugin.ensure_table) {
    throw new DomainError({
      code: "provider_cannot_scaffold",
      message: `${resolved.plugin.display_name} has no schema API, so the table has to be made by hand.`,
      status: 422,
    });
  }

  const subject = str(mapping.subject) as SyncSubject;
  const siblings = await app.db.select<Row>("sync_mapping", { integration_id: str(mapping.integration_id), is_active: 1 });
  const columns: SyncColumnSpec[] = [];
  const skipped: string[] = [];

  for (const entry of fieldMapOf(mapping)) {
    const spec = fieldSpec(subject, entry.field);
    if (!spec) continue;
    if (spec.kind === "link") {
      const target = siblings.find((m) => str(m.subject) === spec.linkTo);
      if (!target || !strOrNull(target.external_table_id)) {
        skipped.push(spec.label);
        continue;
      }
      columns.push({
        external_field: entry.external_field,
        kind: "link",
        links_to_table_id: str(target.external_table_id),
      });
      continue;
    }
    columns.push({ external_field: entry.external_field, kind: spec.kind, primary: spec.primary });
  }

  const existing = strOrNull(mapping.external_table_id);
  const table = await resolved.plugin.ensure_table(
    { external_table_id: existing, name: str(mapping.external_table_name) || subjectSpec(subject).label, columns },
    resolved.ctx,
  );

  await app.db.update("sync_mapping", str(mapping.id), {
    external_table_id: table.external_table_id,
    external_table_name: table.name,
    updated_at: app.now(),
  });
  app.audit.record({
    action: "sync_mapping.scaffold",
    entity_type: "sync_mapping",
    entity_id: str(mapping.id),
    after: { external_table_id: table.external_table_id, columns: columns.length, skipped },
  });

  return { created: !existing, table: table.name, skipped };
}

/**
 * Which mappings this one's link columns need, and whether they are there yet.
 *
 * Shown on the mapping screen so "Speakers is empty" has an answer other than
 * reading the source.
 */
export async function linkReadiness(app: AppContext, mapping: Row): Promise<{ target: SyncSubject; label: string; mapped: boolean }[]> {
  const subject = str(mapping.subject) as SyncSubject;
  const targets = requiredLinkTargets(subject);
  if (targets.length === 0) return [];
  const siblings = await app.db.select<Row>("sync_mapping", { integration_id: str(mapping.integration_id), is_active: 1 });
  return targets.map((target) => ({
    target,
    label: subjectSpec(target).label,
    mapped: siblings.some((m) => str(m.subject) === target),
  }));
}

/* -------------------------------------------------------------------------- */
/* Backfill and reconcile                                                      */
/* -------------------------------------------------------------------------- */

/** Create a link for every record a mapping should mirror, so the first push carries them. */
export async function backfillMapping(app: AppContext, mapping: Row): Promise<number> {
  const adapter = adapterFor(str(mapping.subject));
  const rows = await adapter.list(app, scopeOf(mapping));
  let n = 0;
  for (const row of rows) {
    const link = await ensureLink(app, mapping, str(row.id));
    if (str(link.status) === "pending_push") n++;
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* Erasure (INV-09-22)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Delete everything about one person from every mapped external table.
 *
 * Runs over **inactive mappings too**: a mapping that is merely paused still
 * holds the data, and an erasure that stops at the database boundary is not an
 * erasure (11, "PII"). A provider that refuses leaves the link in `error` and
 * says so, rather than reporting a deletion that did not happen.
 */
export async function erasePersonEverywhere(app: AppContext, personId: string): Promise<{ deleted: number; failed: number }> {
  const mappings = await app.db.select<Row>("sync_mapping", {});
  let deleted = 0;
  let failed = 0;

  for (const mapping of mappings) {
    const subject = str(mapping.subject) as SyncSubject;
    const adapter = adapterFor(subject);
    if (!adapter.byPerson) continue;

    const ids = await adapter.byPerson(app, personId);
    if (ids.length === 0) continue;

    const links: Row[] = [];
    for (const id of ids) {
      const link = await linkFor(app, str(mapping.id), subject, id);
      if (link && strOrNull(link.external_id) && str(link.status) !== "unlinked") links.push(link);
    }
    if (links.length === 0) continue;

    const resolved = await resolveForMapping(app, mapping);
    if (!resolved) {
      for (const link of links) {
        await app.db.update("external_record_link", str(link.id), {
          last_error: "Erasure could not run: the sync integration is gone or disabled.",
          updated_at: app.now(),
        });
        failed++;
      }
      continue;
    }

    try {
      await resolved.plugin.delete_records(str(mapping.external_table_id), links.map((l) => str(l.external_id)), resolved.ctx);
      for (const link of links) {
        await moveLink(app, link, "unlinked", { external_id: null, last_pushed_hash: null, last_pulled_hash: null });
        emitUnlinked(app, mapping, link, "the person was erased");
        deleted++;
      }
    } catch (err) {
      for (const link of links) {
        await app.db.update("external_record_link", str(link.id), { last_error: errorMessage(err), updated_at: app.now() });
        failed++;
      }
    }
  }

  return { deleted, failed };
}

/* -------------------------------------------------------------------------- */
/* Views                                                                       */
/* -------------------------------------------------------------------------- */

export async function conflictsFor(app: AppContext, mappingId?: string): Promise<Row[]> {
  const where: Row = { status: "conflict" };
  if (mappingId) where.mapping_id = mappingId;
  return app.db.select<Row>("external_record_link", where, { orderBy: "updated_at DESC", limit: 200 });
}

export async function runsFor(app: AppContext, mappingId: string): Promise<Row[]> {
  return app.db.select<Row>("sync_run", { mapping_id: mappingId }, { orderBy: "started_at DESC", limit: 50 });
}

export async function linkStats(app: AppContext, mappingId: string): Promise<Record<string, number>> {
  const rows = await app.db.raw<Row>(
    "SELECT status, COUNT(*) AS n FROM external_record_link WHERE mapping_id = ? GROUP BY status",
    [mappingId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[str(r.status)] = num(r.n, 0);
  return out;
}

/**
 * A context for work that did not come from a request — the reaction, the cron
 * sweep, the delivery queue.
 *
 * INV-09-20: an inbound change is attributed to the `Integration` that carried
 * it, so `/admin/audit` answers "who changed this session's title" with the name
 * of the Airtable install rather than with `system`. Marking a record dirty
 * writes no domain data, so that half stays `system` — a bookkeeping row is not
 * an actor's decision.
 */
export async function syncContext(
  env: Env,
  eventId: string | null,
  opts: { causationId?: string | null; integration?: Row | null } = {},
): Promise<AppContext> {
  const integration = opts.integration;
  return new AppContext({
    env,
    orgId: await soleOrgId(env),
    eventId,
    actor: integration
      ? { type: "integration", id: str(integration.id), display_name: str(integration.display_name) }
      : { type: "system", id: null, display_name: "sync" },
    causationId: opts.causationId ?? undefined,
  });
}
