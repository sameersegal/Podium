/**
 * Scheduling — admin read models. The agenda builder, the publications
 * screen and embed configuration. Nothing here writes; every write is a
 * command in `commands.ts` (through the schedule Durable Object),
 * `publication.ts`, or a direct insert of a non-`Placement` row (an
 * `AutoPlaceRun` proposal, an `EmbedConfig`) that does not need the
 * per-event serialisation `Placement` mutations require.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { autoPlace, proposalAsPlacements, type AutoPlaceInputs, type ProposedPlacement, type UnplaceableSession } from "@podiumconf/domain/scheduling/auto-place.js";
import { detectConflicts, type ConflictFinding } from "@podiumconf/domain/scheduling/conflicts.js";
import { isPlaceableStatus } from "@podiumconf/domain/scheduling/placement.js";
import {
  widgetSupportsFormat,
  type AutoPlaceStrategy,
  type EmbedFormat,
  type WidgetType,
} from "@podiumconf/domain/scheduling/types.js";
import { invariantError, notFound } from "@podiumconf/domain/shared/errors.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { listConflicts, type ConflictView } from "./conflicts.js";
import { loadScheduleFacts, type ScheduleFacts } from "./facts.js";
import { pendingChanges, type PublishScope } from "./publication.js";
import type { WidgetFilters, FieldAllowlist } from "./widgets.js";

/* -------------------------------------------------------------------------- */
/* Agenda builder                                                             */
/* -------------------------------------------------------------------------- */

export interface SessionSummary {
  id: string;
  reference: string;
  title: string;
  duration_minutes: number;
  track_name: string | null;
  format_name: string | null;
  speaker_names: string[];
  status: string;
  visibility: string;
}

export interface PlacementView {
  id: string;
  session: SessionSummary;
  room_id: string;
  room_name: string;
  event_day_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
}

export interface AgendaBuilderData {
  event: { id: string; name: string; slug: string; timezone: string };
  days: { id: string; date: string; label: string | null }[];
  rooms: { id: string; name: string; capacity: number | null }[];
  timeSlots: Row[];
  placementsByDay: Map<string, PlacementView[]>;
  unplaced: SessionSummary[];
  conflicts: ConflictView[];
  pendingCount: number;
}

function sessionSummary(facts: ScheduleFacts, sessionId: string): SessionSummary {
  const s = facts.sessions[sessionId];
  const row = facts.sessionRows.find((r) => str(r.id) === sessionId);
  return {
    id: sessionId,
    reference: row ? str(row.reference) : sessionId,
    title: s?.title ?? (row ? str(row.title) : sessionId),
    duration_minutes: s?.duration_minutes ?? 0,
    track_name: s?.track_name ?? null,
    format_name: null,
    speaker_names: (s?.speaker_person_ids ?? []).map((id) => facts.people?.[id] ?? id),
    status: s?.status ?? "",
    visibility: s?.visibility ?? "public",
  };
}

export async function loadAgendaBuilder(app: AppContext, eventId: string): Promise<AgendaBuilderData> {
  const facts = await loadScheduleFacts(app, eventId);
  const formatRows = await app.db.select<Row>("session_format", { event_id: eventId });
  const formatById = new Map(formatRows.map((f) => [str(f.id), str(f.name)]));

  const placementsByDay = new Map<string, PlacementView[]>();
  const placedSessionIds = new Set<string>();
  for (const p of facts.placementRows) {
    const summary = sessionSummary(facts, str(p.session_id));
    const sessionRow = facts.sessionRows.find((r) => str(r.id) === str(p.session_id));
    summary.format_name = sessionRow ? formatById.get(str(sessionRow.session_format_id)) ?? null : null;
    placedSessionIds.add(str(p.session_id));
    const view: PlacementView = {
      id: str(p.id),
      session: summary,
      room_id: str(p.room_id),
      room_name: facts.rooms[str(p.room_id)]?.name ?? str(p.room_id),
      event_day_id: str(p.event_day_id),
      starts_at: str(p.starts_at),
      ends_at: str(p.ends_at),
      status: str(p.status, "tentative"),
      notes: strOrNull(p.notes),
    };
    const dayId = str(p.event_day_id);
    placementsByDay.set(dayId, [...(placementsByDay.get(dayId) ?? []), view]);
  }
  for (const list of placementsByDay.values()) list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const unplaced: SessionSummary[] = [];
  for (const row of facts.sessionRows) {
    const id = str(row.id);
    if (placedSessionIds.has(id)) continue;
    if (!isPlaceableStatus(str(row.status))) continue;
    const summary = sessionSummary(facts, id);
    summary.format_name = formatById.get(str(row.session_format_id)) ?? null;
    unplaced.push(summary);
  }
  unplaced.sort((a, b) => a.reference.localeCompare(b.reference));

  const [conflicts, pending] = await Promise.all([listConflicts(app, eventId), pendingChanges(app, eventId)]);

  return {
    event: { id: facts.event.id, name: facts.event.name, slug: facts.event.slug, timezone: facts.event.timezone },
    days: facts.dayRows.map((d) => ({ id: str(d.id), date: str(d.date), label: strOrNull(d.label) })),
    rooms: facts.roomRows.map((r) => ({ id: str(r.id), name: str(r.name), capacity: r.capacity === null ? null : num(r.capacity) })),
    timeSlots: facts.slotRows,
    placementsByDay,
    unplaced,
    conflicts,
    pendingCount: pending.count,
  };
}

/* -------------------------------------------------------------------------- */
/* Assisted placement                                                         */
/* -------------------------------------------------------------------------- */

export interface AutoPlaceScopeInput {
  session_ids?: string[];
  track_ids?: string[];
  event_day_ids?: string[];
  room_ids?: string[];
}

export interface AutoPlaceProposalView {
  run_id: string;
  strategy: AutoPlaceStrategy;
  proposed: (ProposedPlacement & { session: SessionSummary; room_name: string; day_label: string })[];
  unplaceable: (UnplaceableSession & { session: SessionSummary })[];
  conflicts_introduced: { code: string; severity: string; message: string }[];
  status: string;
}

/** Facts → the pure solver's input shape. */
function autoPlaceInputsFrom(facts: ScheduleFacts, scope: AutoPlaceScopeInput | undefined, strategy: AutoPlaceStrategy): AutoPlaceInputs {
  const placedSessionIds = new Set(facts.placements.map((p) => p.session_id));
  const candidates = Object.values(facts.sessions).filter((s) => isPlaceableStatus(s.status) && !placedSessionIds.has(s.id) && s.visibility === "public");
  return {
    event_id: facts.event_id,
    timezone: facts.timezone,
    min_transit_minutes: facts.min_transit_minutes,
    strategy,
    scope: scope ?? null,
    candidates,
    existing: facts.placements,
    sessions: facts.sessions,
    rooms: Object.values(facts.rooms),
    days: Object.values(facts.days),
    slots: facts.slots,
    series: facts.series,
  };
}

/** The conflicts a proposal *would* create — INV-08-15 never mutates, so this is read-only. */
function conflictsIntroducedBy(facts: ScheduleFacts, proposed: ProposedPlacement[]): ConflictFinding[] {
  const proposedPlacements = proposalAsPlacements(proposed);
  const proposedIds = new Set(proposedPlacements.map((p) => p.id));
  const merged = detectConflicts({ ...facts, placements: [...facts.placements, ...proposedPlacements] });
  return merged.filter((f) => f.placement_ids.some((id) => proposedIds.has(id)));
}

/** Runs the solver and persists the proposal — emits `schedule.auto_place_proposed`. Not a Placement write, so no DO round-trip. */
export async function proposeAutoPlace(
  app: AppContext,
  eventId: string,
  input: { strategy: AutoPlaceStrategy; scope?: AutoPlaceScopeInput },
): Promise<string> {
  const facts = await loadScheduleFacts(app, eventId);
  const inputs = autoPlaceInputsFrom(facts, input.scope, input.strategy);
  const { proposed, unplaceable } = autoPlace(inputs);
  const introduced = conflictsIntroducedBy(facts, proposed);

  const id = newId("AutoPlaceRun");
  const now = app.now();
  await app.db.insert("auto_place_run", {
    id,
    event_id: eventId,
    scope: input.scope ? JSON.stringify(input.scope) : null,
    strategy: input.strategy,
    proposed: JSON.stringify(proposed),
    status: "proposed",
    requested_by_person_id: app.actor.id ?? "system",
    applied_session_ids: JSON.stringify([]),
    created_at: now,
  });

  app.events.emit({
    type: "schedule.auto_place_proposed",
    subject: { type: "event", id: eventId },
    event_id: eventId,
    data: {
      run_id: id,
      strategy: input.strategy,
      proposed_count: proposed.length,
      unplaceable_count: unplaceable.length,
      conflicts_introduced: introduced.map((f) => ({ code: f.code, severity: f.severity })),
    },
  });
  app.audit.record({
    action: "schedule.auto_place_propose",
    entity_type: "auto_place_run",
    entity_id: id,
    after: { strategy: input.strategy, proposed_count: proposed.length, unplaceable_count: unplaceable.length },
  });
  return id;
}

export async function loadAutoPlaceRun(app: AppContext, runId: string): Promise<AutoPlaceProposalView> {
  const run = await app.db.byId<Row>("auto_place_run", runId);
  if (!run) throw notFound("Auto-place run", runId);
  const eventId = str(run.event_id);
  const facts = await loadScheduleFacts(app, eventId);
  const dayLabel = new Map(facts.dayRows.map((d) => [str(d.id), strOrNull(d.label) ?? str(d.date)]));
  const formatRows = await app.db.select<Row>("session_format", { event_id: eventId });
  const formatById = new Map(formatRows.map((f) => [str(f.id), str(f.name)]));

  const proposed = parseJson<ProposedPlacement[]>(run.proposed, []);
  const introduced = conflictsIntroducedBy(facts, proposed);
  const applied = new Set(parseJson<string[]>(run.applied_session_ids, []));

  // `unplaceable` is `D` (08: no column on `auto_place_run`) — re-run the same
  // scope and strategy against the *current* board rather than freezing a
  // stale verdict. A session that has since been placed elsewhere by hand
  // simply stops showing up here, which is the point of a derived field.
  const scope = parseJson<AutoPlaceScopeInput | null>(run.scope, null) ?? undefined;
  const strategy = str(run.strategy, "greedy_fill") as AutoPlaceStrategy;
  const fresh = autoPlace(autoPlaceInputsFrom(facts, scope, strategy));
  const unplaceable = fresh.unplaceable.filter((u) => !applied.has(u.session_id));

  return {
    run_id: runId,
    strategy,
    status: str(run.status, "proposed"),
    proposed: proposed
      .filter((p) => !applied.has(p.session_id))
      .map((p) => {
        const summary = sessionSummary(facts, p.session_id);
        const sessionRow = facts.sessionRows.find((r) => str(r.id) === p.session_id);
        summary.format_name = sessionRow ? formatById.get(str(sessionRow.session_format_id)) ?? null : null;
        return { ...p, session: summary, room_name: facts.rooms[p.room_id]?.name ?? p.room_id, day_label: dayLabel.get(p.event_day_id) ?? p.event_day_id };
      }),
    unplaceable: unplaceable.map((u) => ({ ...u, session: sessionSummary(facts, u.session_id) })),
    conflicts_introduced: introduced.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
  };
}

/* -------------------------------------------------------------------------- */
/* Publications                                                                */
/* -------------------------------------------------------------------------- */

export interface PublicationRow {
  id: string;
  version: number;
  status: string;
  published_at: string;
  published_by_person_id: string;
  note: string | null;
  content_etag: string;
  session_count: number;
  override_reasons: Record<string, string> | null;
}

export async function loadPublications(app: AppContext, eventId: string): Promise<PublicationRow[]> {
  const rows = await app.db.select<Row>("schedule_publication", { event_id: eventId }, { orderBy: "version DESC" });
  const out: PublicationRow[] = [];
  for (const r of rows) {
    const count = await app.db.count("published_session", { publication_id: str(r.id) });
    out.push({
      id: str(r.id),
      version: num(r.version),
      status: str(r.status),
      published_at: str(r.published_at),
      published_by_person_id: str(r.published_by_person_id),
      note: strOrNull(r.note),
      content_etag: str(r.content_etag),
      session_count: count,
      override_reasons: parseJson<Record<string, string> | null>(r.override_reasons, null),
    });
  }
  return out;
}

export async function loadDiff(app: AppContext, publicationId: string): Promise<Row[]> {
  return app.db.select<Row>("schedule_diff_entry", { publication_id: publicationId }, { orderBy: "id" });
}

/* -------------------------------------------------------------------------- */
/* Embeds                                                                      */
/* -------------------------------------------------------------------------- */

export interface EmbedConfigRow {
  id: string;
  event_id: string;
  key: string;
  name: string;
  widget_type: WidgetType;
  allowed_origins: string[];
  filters: WidgetFilters;
  format: EmbedFormat;
  fields: FieldAllowlist | null;
  theme: Record<string, unknown> | null;
  show_unpublished: boolean;
  cache_ttl_seconds: number;
  pinned_publication_id: string | null;
  status: string;
}

export function toEmbedConfig(row: Row): EmbedConfigRow {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    key: str(row.key),
    name: str(row.name),
    widget_type: str(row.widget_type) as WidgetType,
    allowed_origins: parseJson<string[]>(row.allowed_origins, []),
    filters: parseJson<WidgetFilters>(row.filters, {}),
    format: str(row.format, "js_widget") as EmbedFormat,
    fields: parseJson<FieldAllowlist | null>(row.fields, null),
    theme: parseJson<Record<string, unknown> | null>(row.theme, null),
    show_unpublished: bool(row.show_unpublished),
    cache_ttl_seconds: num(row.cache_ttl_seconds, 300),
    pinned_publication_id: strOrNull(row.pinned_publication_id),
    status: str(row.status, "active"),
  };
}

export async function loadEmbeds(app: AppContext, eventId: string): Promise<EmbedConfigRow[]> {
  const rows = await app.db.select<Row>("embed_config", { event_id: eventId }, { orderBy: "created_at" });
  return rows.map(toEmbedConfig);
}

export async function embedByKey(app: AppContext, key: string): Promise<EmbedConfigRow | null> {
  const row = await app.db.first<Row>("embed_config", { key });
  return row ? toEmbedConfig(row) : null;
}

export interface CreateEmbedInput {
  name: string;
  widget_type: WidgetType;
  format: EmbedFormat;
  allowed_origins: string[];
  filters?: WidgetFilters;
  fields?: FieldAllowlist;
  theme?: Record<string, unknown>;
  show_unpublished?: boolean;
  cache_ttl_seconds?: number;
  pinned_publication_id?: string | null;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createEmbed(app: AppContext, eventId: string, input: CreateEmbedInput): Promise<Row> {
  // INV-08-12 — a format the type cannot express is rejected at configuration
  // time, not at request time.
  if (!widgetSupportsFormat(input.widget_type, input.format)) {
    throw invariantError(
      "INV-08-12",
      "widget_format_unsupported",
      `${input.widget_type} cannot be delivered as ${input.format}.`,
      { widget_type: input.widget_type, format: input.format },
    );
  }
  const id = newId("EmbedConfig");
  const now = app.now();
  const row = await app.db.insert("embed_config", {
    id,
    event_id: eventId,
    key: randomKey(),
    name: input.name,
    widget_type: input.widget_type,
    allowed_origins: JSON.stringify(input.allowed_origins),
    filters: input.filters ? JSON.stringify(input.filters) : null,
    format: input.format,
    fields: input.fields ? JSON.stringify(input.fields) : null,
    theme: input.theme ? JSON.stringify(input.theme) : null,
    show_unpublished: input.show_unpublished ? 1 : 0,
    cache_ttl_seconds: input.cache_ttl_seconds ?? 300,
    pinned_publication_id: input.pinned_publication_id ?? null,
    status: "active",
    created_by_person_id: app.actor.id ?? "system",
    created_at: now,
  });
  app.events.emit({
    type: "embed_config.created",
    subject: { type: "embed", id },
    event_id: eventId,
    data: { embed_config_id: id, event_id: eventId, format: input.format, allowed_origins: input.allowed_origins },
  });
  app.audit.record({ action: "embed_config.create", entity_type: "embed_config", entity_id: id, after: { widget_type: input.widget_type, format: input.format } });
  return row;
}

export async function updateEmbed(app: AppContext, embedId: string, input: CreateEmbedInput): Promise<void> {
  const existing = await app.db.byId<Row>("embed_config", embedId);
  if (!existing) throw notFound("Embed config", embedId);
  if (!widgetSupportsFormat(input.widget_type, input.format)) {
    throw invariantError(
      "INV-08-12",
      "widget_format_unsupported",
      `${input.widget_type} cannot be delivered as ${input.format}.`,
      { widget_type: input.widget_type, format: input.format },
    );
  }
  await app.db.update("embed_config", embedId, {
    name: input.name,
    widget_type: input.widget_type,
    allowed_origins: JSON.stringify(input.allowed_origins),
    filters: input.filters ? JSON.stringify(input.filters) : null,
    format: input.format,
    fields: input.fields ? JSON.stringify(input.fields) : null,
    theme: input.theme ? JSON.stringify(input.theme) : null,
    show_unpublished: input.show_unpublished ? 1 : 0,
    cache_ttl_seconds: input.cache_ttl_seconds ?? 300,
    pinned_publication_id: input.pinned_publication_id ?? null,
  });
  app.audit.record({ action: "embed_config.update", entity_type: "embed_config", entity_id: embedId, after: { widget_type: input.widget_type, format: input.format } });
}

export async function setEmbedStatus(app: AppContext, embedId: string, status: "active" | "disabled"): Promise<void> {
  const existing = await app.db.byId<Row>("embed_config", embedId);
  if (!existing) throw notFound("Embed config", embedId);
  await app.db.update("embed_config", embedId, { status });
  app.audit.record({ action: "embed_config.set_status", entity_type: "embed_config", entity_id: embedId, after: { status } });
}

/** The public URL and copy-paste snippet an organizer pastes into their site. */
export function embedSnippet(embed: EmbedConfigRow, baseUrl: string): { url: string; snippet: string } {
  const url = `${baseUrl}/embed/${embed.key}`;
  if (embed.format === "js_widget") {
    return {
      url,
      snippet: `<div data-podium-widget="${embed.widget_type}" data-podium-key="${embed.key}"></div>\n<script src="${baseUrl}/embed.js" async></script>`,
    };
  }
  if (embed.format === "iframe") {
    return { url, snippet: `<iframe src="${url}" style="width:100%;border:0;min-height:480px" loading="lazy" title="${embed.name}"></iframe>` };
  }
  return { url, snippet: url };
}
