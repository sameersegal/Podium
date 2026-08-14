/**
 * 02 — Event Configuration: the admin screens and the JSON surfaces.
 *
 * Admin (server-rendered):
 *   /admin/events…                events, setup, activation
 *   /admin/events/:id/cfps…       calls for proposals
 *   /admin/cfps/:id…              CFP settings and the form builder
 *
 * Management API: /v1/events…, /v1/cfps…, /v1/forms…
 * Public API:     /v1/public/events/:eventSlug/cfps/:cfpSlug (INV-02-12)
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  buildConditionRule,
  CONDITION_OP_LABELS,
  CONDITION_OPS,
  fieldsBefore,
  opNeedsValue,
  OPTION_TYPES,
  optionLines,
  parseOptionLines,
  type SelectOption,
} from "@podiumstack/domain/event-config/rules.js";
import {
  AV_CAPABILITY,
  CAPACITY_POLICY,
  CFP_AUDIENCE,
  EVENT_MODE,
  EVENT_VISIBILITY,
  FIELD_AUDIENCE,
  FIELD_TYPE,
  LATE_SUBMISSION_POLICY,
  MAPS_TO,
  ORIGIN,
  PROVISIONING_SOURCE,
  WITHDRAW_ALLOWED_UNTIL,
  type CapacityPolicy,
  type CfpAudience,
  type ConditionOp,
  type EventMode,
  type EventVisibility,
  type FieldAudience,
  type FieldType,
  type FormSpec,
  type LateSubmissionPolicy,
  type MapsTo,
  type Origin,
  type ProvisioningSource,
  type WithdrawAllowedUntil,
} from "@podiumstack/domain/event-config/types.js";
import { notFound } from "@podiumstack/domain/shared/errors.js";
import { slugify } from "@podiumstack/domain/shared/ids.js";
import { calendarDateInZone, formatInZone, formatTimeInZone, timezoneOptions, zonedDateTimeToInstant } from "@podiumstack/domain/shared/time.js";
import { expectedVersion, staleWriteRedirect, versionField } from "../../http/concurrency.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { escapeHtml, html, inlineScript, joinHtml, markdown, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, addForm, badge, card, empty, field, humanise, pageHead, stat, table } from "../../ui/layout.js";
import { adminPage, toEventRef, type EventRef } from "../../ui/shell.js";
import {
  activationCheck,
  activateEvent,
  addField,
  addStep,
  archiveConfiguration,
  archiveEvent,
  createCfp,
  createDraftVersion,
  createEventDay,
  createRoom,
  createSessionFormat,
  createTrack,
  cursorPage,
  deleteEventDay,
  deleteField,
  deleteStep,
  moveField,
  moveStep,
  publishCfp,
  publishForm,
  closeCfp,
  reopenCfp,
  referenceCount,
  reorderForm,
  restoreConfiguration,
  unarchiveEvent,
  updateCfp,
  updateCfpOptions,
  updateEvent,
  updateEventDay,
  updateField,
  updateRoom,
  updateSessionFormat,
  updateStep,
  updateTrack,
  upsertVenue,
} from "./service.js";
import {
  applyStarterBlueprint,
  cloneCandidates,
  provisionEvent,
  requireCloneSource,
  summaryLine,
} from "./provisioning.js";
import {
  builderForm,
  cfpFormatOptions,
  cfpRow,
  cfpTrackOptions,
  FIELD_TYPE_GROUPS,
  FIELD_TYPE_HINTS,
  FIELD_TYPE_LABELS,
  derivedCfpStatus,
  eventRow,
  listFormVersions,
  loadFormSpec,
  loadPublishedForm,
  proposalCount,
  publicCfpView,
  renderPublicForm,
  resolvedOptions,
  type CfpFormatView,
  type CfpTrackView,
} from "./views.js";

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                             */
/* -------------------------------------------------------------------------- */

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

function opts(values: readonly string[]): SelectOption[] {
  return values.map((v) => ({ value: v, label: humanise(v) }));
}

function provisioningSource(value: string | null): ProvisioningSource {
  return (PROVISIONING_SOURCE as readonly string[]).includes(value ?? "") ? (value as ProvisioningSource) : "starter";
}

/** "DevFlow Conf 2027" → "DevFlow Conf 2028". Anything else gets a suffix. */
function nextEditionName(name: string): string {
  const match = name.match(/(19|20)\d{2}(?!.*\d)/);
  if (!match) return `${name} (copy)`;
  return `${name.slice(0, match.index)}${Number(match[0]) + 1}${name.slice((match.index ?? 0) + 4)}`;
}

/**
 * 02, "Starting an event" — where the new event's configuration comes from.
 * Server-rendered and script-free, so the clone picker is always visible rather
 * than revealed: it is ignored unless "copy an existing event" is chosen.
 */
function sourceChooser(selected: ProvisioningSource, cloneFrom: string, candidates: Row[]): SafeHtml {
  const canClone = candidates.length > 0;
  const choices = [
    {
      value: "starter",
      label: "Standard setup",
      description: "days, a track to rename, the usual formats, rooms, a call with its form, review rubrics and the speaker checklist",
    },
    ...(canClone
      ? [{ value: "clone", label: "Copy an existing event", description: "its configuration, with every deadline moved to match the new dates" }]
      : []),
    { value: "empty", label: "Empty", description: "nothing but the event itself" },
  ];
  return html`${field({
      name: "source",
      label: "Start from",
      type: "radio",
      value: canClone ? selected : selected === "clone" ? "starter" : selected,
      options: choices,
    })}
    ${canClone
      ? field({
          name: "clone_from_event_id",
          label: "Event to copy",
          type: "select",
          value: cloneFrom,
          options: candidates.map((e) => ({ value: str(e.id), label: `${str(e.name)} (${str(e.starts_on)})` })),
          help: "Used only when you copy an existing event. Proposals, sessions, reviews and people are never copied.",
        })
      : raw("")}`;
}

/** INV-02-1: an instant a human reads for an event is shown in `Event.timezone`. */
function toLocalInput(instant: string | null | undefined, timezone: string): string {
  if (!instant) return "";
  return `${calendarDateInZone(instant, timezone)}T${formatTimeInZone(instant, timezone)}`;
}

function fromLocalInput(value: string | null, timezone: string): string | null {
  if (!value) return null;
  const [date, time] = value.split("T");
  if (!date) return null;
  return zonedDateTimeToInstant(date, time || "00:00", timezone);
}

function when(instant: string | null | undefined, timezone: string): string {
  return instant ? `${formatInZone(instant, timezone)} (${timezone})` : "—";
}

async function loadEventFor(ctx: RequestContext, idOrSlug: string): Promise<{ row: Row; ref: EventRef }> {
  const row = await eventRow(ctx.app(), idOrSlug);
  ctx.eventId = str(row.id);
  return { row, ref: toEventRef(row) };
}

async function loadCfpFor(ctx: RequestContext, cfpId: string): Promise<{ cfp: Row; event: Row; ref: EventRef }> {
  const app = ctx.app();
  const cfp = await cfpRow(app, cfpId);
  const event = await eventRow(app, str(cfp.event_id));
  ctx.eventId = str(event.id);
  return { cfp, event, ref: toEventRef(event) };
}

function pageParams(ctx: RequestContext): { cursor: string | null; limit: number } {
  return {
    cursor: ctx.url.searchParams.get("cursor"),
    limit: Number(ctx.url.searchParams.get("limit") ?? 50),
  };
}

/* -------------------------------------------------------------------------- */
/* JSON shapes                                                                 */
/* -------------------------------------------------------------------------- */

function eventJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    org_id: str(row.org_id),
    name: str(row.name),
    slug: str(row.slug),
    edition: strOrNull(row.edition),
    tagline: strOrNull(row.tagline),
    description: strOrNull(row.description),
    timezone: str(row.timezone),
    starts_on: str(row.starts_on),
    ends_on: str(row.ends_on),
    venue_id: strOrNull(row.venue_id),
    mode: str(row.mode),
    website_url: strOrNull(row.website_url),
    logo_asset_id: strOrNull(row.logo_asset_id),
    status: str(row.status),
    visibility: str(row.visibility),
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
    cloned_from_event_id: strOrNull(row.cloned_from_event_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    archived_at: strOrNull(row.archived_at),
    row_version: num(row.row_version, 1),
  };
}

function dayJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    date: str(row.date),
    label: strOrNull(row.label),
    sort_order: num(row.sort_order),
    is_public: bool(row.is_public),
  };
}

/** `Track.lead_person_ids` is derived from `RoleGrant` at track scope (INV-11-6). */
async function trackJson(ctx: RequestContext, row: Row): Promise<Record<string, unknown>> {
  const leads = await ctx
    .app()
    .db.raw<{ person_id: string }>(
      "SELECT person_id FROM role_grant WHERE role = 'track_lead' AND scope_type = 'track' AND scope_id = ? AND revoked_at IS NULL",
      [str(row.id)],
    );
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    name: str(row.name),
    slug: str(row.slug),
    description: strOrNull(row.description),
    color: strOrNull(row.color),
    sort_order: num(row.sort_order),
    target_session_count: row.target_session_count === null ? null : num(row.target_session_count),
    lead_person_ids: leads.map((l) => l.person_id),
    is_public: bool(row.is_public),
    deleted_at: strOrNull(row.deleted_at),
  };
}

function formatJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    name: str(row.name),
    slug: str(row.slug),
    description: strOrNull(row.description),
    default_duration_minutes: num(row.default_duration_minutes),
    min_duration_minutes: row.min_duration_minutes === null ? null : num(row.min_duration_minutes),
    max_duration_minutes: row.max_duration_minutes === null ? null : num(row.max_duration_minutes),
    max_speakers: num(row.max_speakers, 1),
    eligible_origins: parseJson<string[]>(row.eligible_origins, ["cfp"]),
    requires_review: bool(row.requires_review),
    requires_recording_consent: bool(row.requires_recording_consent),
    capacity_policy: str(row.capacity_policy),
    sort_order: num(row.sort_order),
    is_public: bool(row.is_public),
    deleted_at: strOrNull(row.deleted_at),
  };
}

function venueJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    name: str(row.name),
    address: strOrNull(row.address),
    map_url: strOrNull(row.map_url),
    timezone: strOrNull(row.timezone),
  };
}

function roomJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    venue_id: str(row.venue_id),
    name: str(row.name),
    slug: str(row.slug),
    capacity: row.capacity === null ? null : num(row.capacity),
    floor: strOrNull(row.floor),
    av_capabilities: parseJson<string[]>(row.av_capabilities, []),
    default_track_id: strOrNull(row.default_track_id),
    sort_order: num(row.sort_order),
    is_public: bool(row.is_public),
    deleted_at: strOrNull(row.deleted_at),
  };
}

async function cfpJson(ctx: RequestContext, row: Row): Promise<Record<string, unknown>> {
  const app = ctx.app();
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    name: str(row.name),
    slug: str(row.slug),
    audience: str(row.audience),
    intro_markdown: strOrNull(row.intro_markdown),
    guidelines_url: strOrNull(row.guidelines_url),
    opens_at: str(row.opens_at),
    closes_at: str(row.closes_at),
    grace_period_minutes: num(row.grace_period_minutes),
    late_submission_policy: str(row.late_submission_policy),
    max_proposals_per_person: row.max_proposals_per_person === null ? null : num(row.max_proposals_per_person),
    allow_edit_after_submit: bool(row.allow_edit_after_submit),
    withdraw_allowed_until: str(row.withdraw_allowed_until),
    active_form_id: strOrNull(row.active_form_id),
    notify_on_submit: bool(row.notify_on_submit),
    closed_early_at: strOrNull(row.closed_early_at),
    published_at: strOrNull(row.published_at),
    // Derived, never stored (INV-11-6).
    status: await derivedCfpStatus(app, row),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    row_version: num(row.row_version, 1),
  };
}

function formJson(spec: FormSpec): Record<string, unknown> {
  return {
    id: spec.id,
    cfp_id: spec.cfp_id,
    version: spec.version,
    status: spec.status,
    steps: spec.steps.map((s) => ({
      id: s.id,
      key: s.key,
      title: s.title,
      description: s.description ?? null,
      sort_order: s.sort_order,
      visible_when: s.visible_when ?? null,
      is_optional: s.is_optional,
      fields: s.fields.map((f) => ({
        id: f.id,
        step_id: f.step_id,
        key: f.key,
        label: f.label,
        help_text: f.help_text ?? null,
        placeholder: f.placeholder ?? null,
        type: f.type,
        options: f.options ?? null,
        is_required: f.is_required,
        validation: f.validation ?? null,
        visible_when: f.visible_when ?? null,
        maps_to: f.maps_to,
        audience: f.audience,
        pii: f.pii,
        identifies_speaker: f.identifies_speaker,
        sort_order: f.sort_order,
      })),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Input readers                                                               */
/* -------------------------------------------------------------------------- */

function readTrackInput(input: Input) {
  return {
    name: input.str("name"),
    slug: input.optional("slug"),
    description: input.optional("description"),
    color: input.optional("color"),
    sort_order: input.int("sort_order"),
    target_session_count: input.int("target_session_count"),
    is_public: input.has("is_public") ? input.bool("is_public") : undefined,
  };
}

function readFormatInput(input: Input) {
  return {
    name: input.str("name"),
    slug: input.optional("slug"),
    description: input.optional("description"),
    default_duration_minutes: input.int("default_duration_minutes", 30) ?? 30,
    min_duration_minutes: input.int("min_duration_minutes"),
    max_duration_minutes: input.int("max_duration_minutes"),
    max_speakers: input.int("max_speakers", 1) ?? 1,
    eligible_origins: (input.list("eligible_origins").filter((o) => (ORIGIN as readonly string[]).includes(o)) as Origin[]),
    requires_review: input.has("requires_review") ? input.bool("requires_review") : undefined,
    requires_recording_consent: input.has("requires_recording_consent") ? input.bool("requires_recording_consent") : undefined,
    capacity_policy: (input.optional("capacity_policy") as CapacityPolicy) ?? undefined,
    sort_order: input.int("sort_order"),
    is_public: input.has("is_public") ? input.bool("is_public") : undefined,
  };
}

function readRoomInput(input: Input) {
  return {
    name: input.str("name"),
    slug: input.optional("slug"),
    capacity: input.int("capacity"),
    floor: input.optional("floor"),
    av_capabilities: input.list("av_capabilities").filter((c) => (AV_CAPABILITY as readonly string[]).includes(c)),
    default_track_id: input.optional("default_track_id"),
    sort_order: input.int("sort_order"),
    is_public: input.has("is_public") ? input.bool("is_public") : undefined,
  };
}

function readCfpInput(input: Input, timezone: string, isJson: boolean) {
  const instant = (name: string) => (isJson ? input.optional(name) : fromLocalInput(input.optional(name), timezone));
  return {
    name: input.str("name"),
    slug: input.optional("slug"),
    audience: (input.optional("audience") as CfpAudience) ?? undefined,
    intro_markdown: input.optional("intro_markdown"),
    guidelines_url: input.optional("guidelines_url"),
    opens_at: instant("opens_at") ?? "",
    closes_at: instant("closes_at") ?? "",
    grace_period_minutes: input.int("grace_period_minutes", 0) ?? 0,
    late_submission_policy: (input.optional("late_submission_policy") as LateSubmissionPolicy) ?? undefined,
    max_proposals_per_person: input.int("max_proposals_per_person"),
    allow_edit_after_submit: input.bool("allow_edit_after_submit"),
    withdraw_allowed_until: (input.optional("withdraw_allowed_until") as WithdrawAllowedUntil) ?? undefined,
    notify_on_submit: input.bool("notify_on_submit"),
  };
}

function readFieldInput(input: Input, form: FormSpec, stepId: string, fieldId?: string) {
  const type = input.str("type", "short_text") as FieldType;
  const optionSrc = input.str("options");
  const rule = buildConditionRule(
    input.str("visible_when_field"),
    (input.str("visible_when_op", "eq") || "eq") as ConditionOp,
    input.str("visible_when_value"),
  );
  // INV-02-8 — the rule may only name a field that precedes this one.
  const allowed = new Set(fieldsBefore(form, stepId, fieldId ?? null).map((f) => f.key));
  const visible_when = rule && rule.all.every((c) => allowed.has(c.field)) ? rule : null;
  return {
    key: input.optional("key"),
    label: input.str("label"),
    help_text: input.optional("help_text"),
    placeholder: input.optional("placeholder"),
    type,
    options: optionSrc ? parseOptionLines(optionSrc, slugify) : null,
    is_required: input.bool("is_required"),
    visible_when: input.has("visible_when_field") ? visible_when : undefined,
    maps_to: (input.str("maps_to", "none") || "none") as MapsTo,
    audience: (input.str("audience", "public") || "public") as FieldAudience,
    pii: input.bool("pii"),
    identifies_speaker: input.bool("identifies_speaker"),
    sort_order: input.int("sort_order"),
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerEventConfigRoutes(router: Router<RequestContext>): void {
  registerAdminEventRoutes(router);
  registerAdminSetupRoutes(router);
  registerAdminCfpRoutes(router);
  registerAdminFormRoutes(router);
  registerManagementApi(router);
  registerPublicApi(router);
}

/* -------------------------------------------------------------------------- */
/* Admin — events                                                              */
/* -------------------------------------------------------------------------- */

function registerAdminEventRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events", async (_req, ctx) => {
    ctx.requireRead("config.manage");
    const app = ctx.app();
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC, id DESC" });
    const rows: SafeHtml[] = [];
    for (const e of events) {
      const cfps = await app.db.count("call_for_proposals", { event_id: str(e.id) });
      rows.push(html`<tr>
        <td><a href="/admin/events/${str(e.id)}"><strong>${str(e.name)}</strong></a><br><span class="mono small muted">${str(e.slug)}</span></td>
        <td>${str(e.starts_on)} → ${str(e.ends_on)}<br><span class="small muted mono">${str(e.timezone)}</span></td>
        <td>${badge(str(e.status))}</td>
        <td>${humanise(str(e.mode))}</td>
        <td>${badge(str(e.visibility), str(e.visibility) === "public" ? "ok" : "")}</td>
        <td>${cfps}</td>
        <td class="right"><a class="btn secondary small" href="/admin/events/${str(e.id)}/setup">Setup</a>
          ${ctx.canWrite("event.configure")
            ? html` <a class="btn secondary small" href="/admin/events/new?from=${str(e.id)}">Duplicate</a>`
            : raw("")}</td>
      </tr>`);
    }
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Events", active: "events", width: "wide" },
        html`${pageHead(
            "Events",
            "Every edition you run. An event holds its own days, tracks, formats, rooms and calls for proposals.",
            ctx.canWrite("event.configure") ? html`<a class="btn" href="/admin/events/new">New event</a>` : raw(""),
          )}
          ${table(["Event", "Dates", "Status", "Mode", "Visibility", "CFPs", ""], rows, "No events yet. Create the first one.")}`,
      ),
    );
  });

  router.get("/admin/events/new", async (req, ctx) => {
    ctx.requireWrite("event.configure");
    const app = ctx.app();
    const from = new URL(req.url).searchParams.get("from");
    if (from) ctx.requireRead("config.manage", { event_id: from });
    const source = from ? await requireCloneSource(app, from) : null;
    // Only events this organizer may actually read: the picker is not a list
    // of every event in the org for someone scoped to one of them.
    const candidates = (await cloneCandidates(app)).filter((e) => ctx.canRead("config.manage", { event_id: str(e.id) }));
    return htmlResponse(
      adminPage(
        ctx,
        { title: source ? "Duplicate event" : "New event", active: "events", width: "narrow" },
        html`${pageHead(
            source ? `Duplicate ${str(source.name)}` : "New event",
            source
              ? "A copy of this event's configuration — tracks, formats, rooms, calls, rubrics, the checklist and the rate card — with every deadline moved to match the new dates. No proposals, sessions or people come across."
              : "Name it, say when and where. Everything else starts from a working default you can change.",
          )}
          ${card(html`<form method="post" action="/admin/events/new" class="stack">
            ${field({
              name: "name",
              label: "Name",
              required: true,
              value: source ? nextEditionName(str(source.name)) : "",
              placeholder: "AI Engineer World's Fair 2026",
            })}
            ${field({ name: "slug", label: "URL slug", help: "Appears in public links. Leave blank to derive it from the name." })}
            ${field({ name: "edition", label: "Edition", help: "For grouping recurring events — \"2026\", \"Summit '27\"." })}
            ${field({ name: "tagline", label: "Tagline", value: source ? str(source.tagline) : "" })}
            ${field({
              name: "timezone",
              label: "Timezone",
              type: "select",
              required: true,
              options: timezoneOptions(source ? str(source.timezone) : null),
              value: source ? str(source.timezone) : "America/Los_Angeles",
              help: "This is the timezone every schedule time is displayed in.",
            })}
            ${field({ name: "starts_on", label: "First day", type: "date", required: true })}
            ${field({ name: "ends_on", label: "Last day", type: "date", required: true })}
            ${field({
              name: "mode",
              label: "Mode",
              type: "select",
              required: true,
              value: source ? str(source.mode) : "in_person",
              options: opts(EVENT_MODE),
            })}
            ${field({ name: "website_url", label: "Website", type: "url", value: source ? str(source.website_url) : "", help: "The marketing site the schedule embeds into." })}
            ${source
              ? html`<p class="help">A duplicate is always created private and in draft, whatever the event it came from was.</p>`
              : field({ name: "visibility", label: "Visibility", type: "select", required: true, value: "private", options: opts(EVENT_VISIBILITY) })}
            ${sourceChooser(source ? "clone" : "starter", str(source?.id ?? ""), candidates)}
            <button type="submit">${source ? "Duplicate event" : "Create event"}</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/events/new", async (req, ctx) => {
    ctx.requireWrite("event.configure");
    const input = await readInput(req);
    const cloneFrom = input.optional("clone_from_event_id");
    // Copying an event's configuration is reading it: an organizer scoped to
    // one event may not lift another's rate card out through a clone.
    if (provisioningSource(input.optional("source")) === "clone" && cloneFrom) {
      ctx.requireRead("config.manage", { event_id: cloneFrom });
    }
    const app = ctx.app();
    const { event, summary } = await provisionEvent(app, {
      name: input.str("name"),
      slug: input.optional("slug"),
      edition: input.optional("edition"),
      tagline: input.optional("tagline"),
      description: input.optional("description"),
      timezone: input.str("timezone", "UTC"),
      starts_on: input.str("starts_on"),
      ends_on: input.str("ends_on"),
      mode: (input.optional("mode") as EventMode) ?? "in_person",
      website_url: input.optional("website_url"),
      visibility: (input.optional("visibility") as EventVisibility) ?? "private",
      source: provisioningSource(input.optional("source")),
      clone_from_event_id: input.optional("clone_from_event_id"),
    });
    await app.flush();
    const created = summary.source === "empty" ? "Event created, empty." : `Event created with ${summaryLine(summary)}.`;
    const next = summary.source === "empty" ? " Add days, tracks, formats and rooms next." : " Change anything that is not right.";
    return redirect(`/admin/events/${str(event.id)}/setup`, 303, OK(created + next));
  });

  router.get("/admin/events/:eventId", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const { row, ref } = await loadEventFor(ctx, params.eventId);
    const app = ctx.app(ref.id);
    const check = await activationCheck(app, ref.id);
    const [cfps, tracks, venue] = await Promise.all([
      app.db.select<Row>("call_for_proposals", { event_id: ref.id }, { orderBy: "created_at" }),
      app.db.count("track", { event_id: ref.id }),
      app.db.first<Row>("venue", { event_id: ref.id }),
    ]);
    // Provenance only (INV-02-15): a source that has since been removed leaves
    // a dangling id, which is why this is a lookup and not a join.
    const clonedFrom = row.cloned_from_event_id ? await app.db.byId<Row>("event", str(row.cloned_from_event_id)) : null;
    const canWrite = ctx.canWrite("event.configure", { event_id: ref.id });

    return htmlResponse(
      adminPage(
        ctx,
        { title: ref.name, event: ref, active: "overview", width: "wide" },
        html`${pageHead(
            ref.name,
            str(row.tagline) || "Overview and settings.",
            html`${badge(ref.status)}
              ${canWrite ? html`<a class="btn secondary" href="/admin/events/new?from=${ref.id}">Duplicate</a>` : raw("")}
              ${canWrite && ref.status === "draft" ? actionForm(`/admin/events/${ref.id}/activate`, "Activate event", { className: "" }) : raw("")}
              ${canWrite && ref.status === "active" ? actionForm(`/admin/events/${ref.id}/archive`, "Archive event", { confirm: "Archive this event? Its calls for proposals close." }) : raw("")}
              ${canWrite && ref.status === "archived" ? actionForm(`/admin/events/${ref.id}/activate`, "Unarchive", { hidden: { reason: "Unarchived from the event overview." } }) : raw("")}`,
          )}
          ${clonedFrom
            ? html`<p class="muted small">
                Configuration copied from <a href="/admin/events/${str(clonedFrom.id)}">${str(clonedFrom.name)}</a>.
              </p>`
            : raw("")}
          <div class="stats">
            ${stat("days", check.day_count, `/admin/events/${ref.id}/setup`)}
            ${stat("tracks", tracks, `/admin/events/${ref.id}/setup`)}
            ${stat("formats", check.session_format_count, `/admin/events/${ref.id}/setup`)}
            ${stat("rooms", check.room_count, `/admin/events/${ref.id}/setup`)}
            ${stat("calls for proposals", cfps.length, `/admin/events/${ref.id}/cfps`)}
          </div>
          ${ref.status === "draft"
            ? card(
                check.ready
                  ? html`<p class="notice ok">Configuration is complete — this event can go active.</p>
                      ${canWrite ? actionForm(`/admin/events/${ref.id}/activate`, "Activate event", { className: "" }) : raw("")}`
                  : html`<p class="notice warn">
                        Before this event can go active it needs ${check.blockers.join(", ")}.
                      </p>
                      <p><a class="btn secondary" href="/admin/events/${ref.id}/setup">Go to setup</a></p>`,
                "Readiness",
              )
            : raw("")}
          ${card(
            html`<form method="post" action="/admin/events/${ref.id}" class="stack">
              ${versionField(row)}
              ${field({ name: "name", label: "Name", required: true, value: str(row.name) })}
              ${field({ name: "edition", label: "Edition", value: str(row.edition) })}
              ${field({ name: "tagline", label: "Tagline", value: str(row.tagline) })}
              ${field({ name: "description", label: "Description", type: "textarea", rows: 5, value: str(row.description), help: "Markdown." })}
              ${field({ name: "timezone", label: "Timezone", type: "select", required: true, options: timezoneOptions(str(row.timezone)), value: str(row.timezone), help: "Every time shown for this event is rendered here." })}
              ${field({ name: "starts_on", label: "First day", type: "date", required: true, value: str(row.starts_on) })}
              ${field({ name: "ends_on", label: "Last day", type: "date", required: true, value: str(row.ends_on) })}
              ${field({ name: "mode", label: "Mode", type: "select", required: true, value: str(row.mode), options: opts(EVENT_MODE) })}
              ${field({ name: "website_url", label: "Website", type: "url", value: str(row.website_url) })}
              ${field({
                name: "visibility",
                label: "Visibility",
                type: "select",
                required: true,
                value: str(row.visibility),
                options: opts(EVENT_VISIBILITY),
                help: "A public call for proposals needs an active, public event.",
              })}
              ${field({ name: "venue_id", label: "Venue", type: "select", value: str(row.venue_id), options: venue ? [{ value: str(venue.id), label: str(venue.name) }] : [] })}
              ${canWrite ? html`<button type="submit">Save settings</button>` : html`<p class="muted small">You have read-only access to this event's configuration.</p>`}
            </form>`,
            "Settings",
          )}`,
      ),
    );
  });

  router.post("/admin/events/:eventId", async (req, ctx, params) => {
    ctx.requireWrite("event.configure", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    try {
      // INV-11-14 — the form round-trips `row_version`, so an edit written
      // against a stale copy is refused rather than overwriting the other
      // organizer's.
      await updateEvent(
        app,
        params.eventId,
        {
          name: input.str("name"),
          edition: input.optional("edition"),
          tagline: input.optional("tagline"),
          description: input.optional("description"),
          timezone: input.str("timezone"),
          starts_on: input.str("starts_on"),
          ends_on: input.str("ends_on"),
          mode: input.str("mode"),
          website_url: input.optional("website_url"),
          visibility: input.str("visibility"),
          venue_id: input.optional("venue_id"),
        },
        expectedVersion(input),
      );
    } catch (err) {
      const stale = await staleWriteRedirect(err, app, `/admin/events/${params.eventId}`);
      if (stale) return stale;
      throw err;
    }
    await app.flush();
    return redirect(`/admin/events/${params.eventId}`, 303, OK("Settings saved."));
  });

  router.post("/admin/events/:eventId/activate", async (req, ctx, params) => {
    ctx.requireWrite("event.configure", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const current = await eventRow(app, params.eventId);
    if (str(current.status) === "archived") {
      await unarchiveEvent(app, params.eventId, input.str("reason", "Unarchived by an administrator."));
    } else {
      await activateEvent(app, params.eventId);
    }
    await app.flush();
    return redirect(`/admin/events/${params.eventId}`, 303, OK("This event is active."));
  });

  router.post("/admin/events/:eventId/archive", async (_req, ctx, params) => {
    ctx.requireWrite("event.configure", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    await archiveEvent(app, params.eventId);
    await app.flush();
    return redirect(`/admin/events/${params.eventId}`, 303, OK("Event archived."));
  });
}

/* -------------------------------------------------------------------------- */
/* Admin — setup                                                               */
/* -------------------------------------------------------------------------- */

function registerAdminSetupRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/setup", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const { row, ref } = await loadEventFor(ctx, params.eventId);
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("config.manage", { event_id: ref.id });
    const [days, tracks, formats, venue] = await Promise.all([
      app.db.select<Row>("event_day", { event_id: ref.id }, { orderBy: "sort_order, date" }),
      app.db.select<Row>("track", { event_id: ref.id }, { orderBy: "sort_order, name" }),
      app.db.select<Row>("session_format", { event_id: ref.id }, { orderBy: "sort_order, name" }),
      app.db.first<Row>("venue", { event_id: ref.id }),
    ]);
    const rooms = venue ? await app.db.select<Row>("room", { venue_id: str(venue.id) }, { orderBy: "sort_order, name" }) : [];
    const check = await activationCheck(app, ref.id);

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Setup", event: ref, active: "setup", width: "wide" },
        html`${pageHead("Setup", "Days, tracks, session formats, the venue and its rooms. Everything a call for proposals and the schedule need.")}
          ${check.ready
            ? raw("")
            : html`<p class="notice warn">Still missing before this event can go active: ${check.blockers.join(", ")}.</p>`}
          ${canWrite && !check.ready
            ? card(
                html`<p>
                    Rather than filling these in one at a time, start from the standard setup: days across the event's
                    dates, a track to rename, the usual session formats, a venue with three rooms, a call for proposals
                    with its form already published, review rubrics and the speaker checklist. Anything already here is
                    left alone, and everything it writes is an ordinary row you can change or delete.
                  </p>
                  ${actionForm(`/admin/events/${ref.id}/blueprint`, "Apply the standard setup", { className: "" })}`,
                "Start from the standard setup",
              )
            : raw("")}
          ${daysSection(ref, row, days, canWrite)}
          ${tracksSection(ref, tracks, canWrite)}
          ${formatsSection(ref, formats, canWrite)}
          ${venueSection(ref, venue, rooms, tracks, canWrite)}`,
      ),
    );
  });

  /**
   * The same blueprint the create form applies, for an event that was created
   * empty — or created before this existed. Idempotent by design: it fills the
   * parts that are missing and leaves the rest alone.
   */
  router.post("/admin/events/:eventId/blueprint", async (_req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const summary = await applyStarterBlueprint(app, params.eventId);
    await app.flush();
    const message = Object.keys(summary.counts).length
      ? `Added ${summaryLine(summary)}.`
      : "Nothing to add — this event already has everything the standard setup would create.";
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK(message));
  });

  /* days ------------------------------------------------------------------ */

  router.post("/admin/events/:eventId/days", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await createEventDay(app, params.eventId, {
      date: input.str("date"),
      label: input.optional("label"),
      is_public: input.has("is_public") ? input.bool("is_public") : true,
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Day added."));
  });

  router.post("/admin/events/:eventId/days/:dayId", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    if (input.str("action") === "delete") {
      await deleteEventDay(app, params.dayId);
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Day removed."));
    }
    await updateEventDay(app, params.dayId, {
      date: input.str("date"),
      label: input.optional("label"),
      is_public: input.bool("is_public"),
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Day updated."));
  });

  /* tracks ---------------------------------------------------------------- */

  router.post("/admin/events/:eventId/tracks", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await createTrack(app, params.eventId, { ...readTrackInput(input), is_public: true });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Track added."));
  });

  router.post("/admin/events/:eventId/tracks/:trackId", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const action = input.str("action");
    if (action === "archive") {
      // INV-02-10 — configuration referenced by content is archived, not deleted.
      await archiveConfiguration(app, "track", params.trackId);
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Track archived. Existing proposals keep it."));
    }
    if (action === "restore") {
      await restoreConfiguration(app, "track", params.trackId);
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Track restored."));
    }
    await updateTrack(app, params.trackId, readTrackInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Track updated."));
  });

  /* formats --------------------------------------------------------------- */

  router.post("/admin/events/:eventId/formats", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await createSessionFormat(app, params.eventId, readFormatInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Session format added."));
  });

  router.post("/admin/events/:eventId/formats/:formatId", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const action = input.str("action");
    if (action === "archive") {
      await archiveConfiguration(app, "session_format", params.formatId); // INV-02-10
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Format archived."));
    }
    if (action === "restore") {
      await restoreConfiguration(app, "session_format", params.formatId);
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Format restored."));
    }
    await updateSessionFormat(app, params.formatId, readFormatInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Format updated."));
  });

  /* venue and rooms -------------------------------------------------------- */

  router.post("/admin/events/:eventId/venue", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await upsertVenue(
      app,
      params.eventId,
      {
        name: input.str("name"),
        address: input.optional("address"),
        map_url: input.optional("map_url"),
        timezone: input.optional("timezone"),
      },
      input.optional("venue_id"),
    );
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Venue saved."));
  });

  router.post("/admin/events/:eventId/rooms", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    let venueId = input.optional("venue_id");
    if (!venueId) {
      const venue = await app.db.first<Row>("venue", { event_id: params.eventId });
      if (!venue) throw notFound("Venue");
      venueId = str(venue.id);
    }
    await createRoom(app, venueId, readRoomInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Room added."));
  });

  router.post("/admin/events/:eventId/rooms/:roomId", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const action = input.str("action");
    if (action === "archive") {
      await archiveConfiguration(app, "room", params.roomId); // INV-02-10
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Room archived."));
    }
    if (action === "restore") {
      await restoreConfiguration(app, "room", params.roomId);
      await app.flush();
      return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Room restored."));
    }
    await updateRoom(app, params.roomId, readRoomInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/setup`, 303, OK("Room updated."));
  });
}

/* setup sections ------------------------------------------------------------ */

function editDetails(summary: string, body: SafeHtml): SafeHtml {
  return html`<details class="row-edit"><summary>${summary}</summary>${body}</details>`;
}

function daysSection(ev: EventRef, row: Row, days: Row[], canWrite: boolean): SafeHtml {
  const rows = days.map(
    (d) => html`<tr>
      <td><strong>${str(d.date)}</strong></td>
      <td>${str(d.label) || html`<span class="muted">—</span>`}</td>
      <td>${bool(d.is_public) ? badge("public", "ok") : badge("staff only", "warn")}</td>
      <td class="right">
        ${canWrite
          ? editDetails(
              "Edit",
              html`<form method="post" action="/admin/events/${ev.id}/days/${str(d.id)}" class="inline-grid">
                  ${field({ name: "date", label: "Date", type: "date", required: true, value: str(d.date) })}
                  ${field({ name: "label", label: "Label", value: str(d.label) })}
                  ${field({ name: "is_public", label: "On the public schedule", type: "checkbox", value: bool(d.is_public) })}
                  <button type="submit" class="small">Save</button>
                </form>
                ${actionForm(`/admin/events/${ev.id}/days/${str(d.id)}`, "Remove day", {
                  className: "danger",
                  confirm: "Remove this day?",
                  hidden: { action: "delete" },
                })}`,
            )
          : raw("")}
      </td>
    </tr>`,
  );
  return card(
    html`<p class="muted">Days exist so the schedule grid and per-day publication are not derived by date arithmetic across timezone boundaries. Dates are calendar dates in <span class="mono">${ev.timezone}</span>.</p>
      ${table(["Date", "Label", "Visibility", ""], rows, "No days yet.")}
      ${canWrite
        ? addForm("Add a day", html`<form method="post" action="/admin/events/${ev.id}/days" class="inline-grid">
            ${field({ name: "date", label: "Date", type: "date", required: true, min: str(row.starts_on), max: str(row.ends_on) })}
            ${field({ name: "label", label: "Label", placeholder: "Day 1 — Workshops" })}
            ${field({ name: "is_public", label: "On the public schedule", type: "checkbox", value: true })}
            <button type="submit">Add day</button>
          </form>`)
        : raw("")}`,
    "Days",
  );
}

function tracksSection(ev: EventRef, tracks: Row[], canWrite: boolean): SafeHtml {
  const rows = tracks.map(
    (t) => html`<tr>
      <td>
        ${str(t.color) ? raw(`<span class="swatch" style="background:${escapeHtml(str(t.color))}"></span>`) : raw("")}
        <strong>${str(t.name)}</strong><br><span class="mono small muted">${str(t.slug)}</span>
      </td>
      <td>${str(t.description) || html`<span class="muted">—</span>`}</td>
      <td>${t.target_session_count === null ? html`<span class="muted">—</span>` : num(t.target_session_count)}</td>
      <td>${bool(t.is_public) ? badge("public", "ok") : badge("hidden")}</td>
      <td class="right">
        ${canWrite
          ? editDetails(
              "Edit",
              html`<form method="post" action="/admin/events/${ev.id}/tracks/${str(t.id)}" class="inline-grid">
                  ${field({ name: "name", label: "Name", required: true, value: str(t.name) })}
                  ${field({ name: "slug", label: "Slug", value: str(t.slug) })}
                  ${field({ name: "description", label: "Description", type: "textarea", rows: 2, value: str(t.description) })}
                  ${field({ name: "color", label: "Colour", type: "color", value: str(t.color) || "#4b5563" })}
                  ${field({ name: "target_session_count", label: "Target sessions", type: "number", min: 0, value: t.target_session_count })}
                  ${field({ name: "is_public", label: "Public", type: "checkbox", value: bool(t.is_public) })}
                  <button type="submit" class="small">Save</button>
                </form>
                ${actionForm(`/admin/events/${ev.id}/tracks/${str(t.id)}`, "Archive track", {
                  confirm: "Archive this track? Proposals and sessions that use it keep it.",
                  hidden: { action: "archive" },
                })}`,
            )
          : raw("")}
      </td>
    </tr>`,
  );
  return card(
    html`<p class="muted">Tracks are more than labels: reviewer pools, track leads, quotas and schedule columns are all per-track. Archiving keeps them on anything already using them.</p>
      ${table(["Track", "Description", "Target", "Visibility", ""], rows, "No tracks yet.")}
      ${canWrite
        ? addForm("Add a track", html`<form method="post" action="/admin/events/${ev.id}/tracks" class="inline-grid">
            ${field({ name: "name", label: "Name", required: true, placeholder: "Agents" })}
            ${field({ name: "slug", label: "Slug", placeholder: "agents" })}
            ${field({ name: "description", label: "Description", type: "textarea", rows: 2, help: "Shown on the CFP form to guide submitters." })}
            ${field({ name: "color", label: "Colour", type: "color", value: "#4b5563" })}
            ${field({ name: "target_session_count", label: "Target sessions", type: "number", min: 0 })}
            <button type="submit">Add track</button>
          </form>`)
        : raw("")}`,
    "Tracks",
  );
}

function formatsSection(ev: EventRef, formats: Row[], canWrite: boolean): SafeHtml {
  const formatFields = (f: Row | null) => html`
    ${field({ name: "name", label: "Name", required: true, value: f ? str(f.name) : "", placeholder: "Conference talk" })}
    ${field({ name: "slug", label: "Slug", value: f ? str(f.slug) : "" })}
    ${field({ name: "description", label: "Description", type: "textarea", rows: 2, value: f ? str(f.description) : "" })}
    ${field({ name: "default_duration_minutes", label: "Default duration (minutes)", type: "number", required: true, min: 1, value: f ? num(f.default_duration_minutes) : 30 })}
    ${field({ name: "min_duration_minutes", label: "Minimum duration", type: "number", min: 1, value: f?.min_duration_minutes ?? "" })}
    ${field({ name: "max_duration_minutes", label: "Maximum duration", type: "number", min: 1, value: f?.max_duration_minutes ?? "" })}
    ${field({ name: "max_speakers", label: "Maximum speakers", type: "number", min: 1, value: f ? num(f.max_speakers, 1) : 1, help: "Panels raise this." })}
    ${field({
      name: "eligible_origins",
      label: "Who may submit this format",
      type: "multi_select",
      options: opts(ORIGIN),
      value: f ? parseJson<string[]>(f.eligible_origins, ["cfp"]) : ["cfp"],
      help: "A proposal's origin must be one of these.",
    })}
    ${field({ name: "requires_review", label: "Requires review", type: "checkbox", value: f ? bool(f.requires_review) : true })}
    ${field({ name: "requires_recording_consent", label: "Requires recording consent", type: "checkbox", value: f ? bool(f.requires_recording_consent) : false })}
    ${field({ name: "capacity_policy", label: "Capacity policy", type: "select", required: true, value: f ? str(f.capacity_policy) : "open", options: opts(CAPACITY_POLICY) })}`;

  const rows = formats.map(
    (f) => html`<tr>
      <td><strong>${str(f.name)}</strong><br><span class="mono small muted">${str(f.slug)}</span></td>
      <td>
        ${num(f.default_duration_minutes)} min${f.min_duration_minutes || f.max_duration_minutes
          ? html` <span class="muted small">(${f.min_duration_minutes ?? "—"}–${f.max_duration_minutes ?? "—"})</span>`
          : raw("")}
      </td>
      <td>${num(f.max_speakers, 1)}</td>
      <td>${parseJson<string[]>(f.eligible_origins, []).map((o) => badge(o))}</td>
      <td>${bool(f.requires_review) ? badge("reviewed", "info") : badge("no review")}</td>
      <td>${badge(str(f.capacity_policy))}</td>
      <td class="right">
        ${canWrite
          ? editDetails(
              "Edit",
              html`<form method="post" action="/admin/events/${ev.id}/formats/${str(f.id)}" class="inline-grid">
                  ${formatFields(f)}
                  ${field({ name: "is_public", label: "Public", type: "checkbox", value: bool(f.is_public) })}
                  <button type="submit" class="small">Save</button>
                </form>
                ${actionForm(`/admin/events/${ev.id}/formats/${str(f.id)}`, "Archive format", {
                  confirm: "Archive this format?",
                  hidden: { action: "archive" },
                })}`,
            )
          : raw("")}
      </td>
    </tr>`,
  );
  return card(
    html`${table(["Format", "Duration", "Speakers", "Origins", "Review", "Capacity", ""], rows, "No session formats yet. An event needs at least one to go active.")}
      ${canWrite
        ? addForm("Add a session format", html`<form method="post" action="/admin/events/${ev.id}/formats" class="inline-grid">
            ${formatFields(null)}
            <button type="submit">Add format</button>
          </form>`)
        : raw("")}`,
    "Session formats",
  );
}

function venueSection(ev: EventRef, venue: Row | null, rooms: Row[], tracks: Row[], canWrite: boolean): SafeHtml {
  const trackOptions = tracks.map((t) => ({ value: str(t.id), label: str(t.name) }));
  const roomFields = (r: Row | null) => html`
    ${field({ name: "name", label: "Name", required: true, value: r ? str(r.name) : "", placeholder: "Golden Gate Ballroom" })}
    ${field({ name: "slug", label: "Slug", value: r ? str(r.slug) : "" })}
    ${field({ name: "capacity", label: "Capacity", type: "number", min: 0, value: r?.capacity ?? "", help: "Drives the over-capacity warning; never enforced." })}
    ${field({ name: "floor", label: "Floor", value: r ? str(r.floor) : "" })}
    ${field({
      name: "av_capabilities",
      label: "AV capabilities",
      type: "multi_select",
      options: opts(AV_CAPABILITY),
      value: r ? parseJson<string[]>(r.av_capabilities, []) : [],
      help: "Matched against a session's AV requirements.",
    })}
    ${field({ name: "default_track_id", label: "Home track", type: "select", value: r ? str(r.default_track_id) : "", options: trackOptions })}`;

  const roomRows = rooms.map(
    (r) => html`<tr>
      <td><strong>${str(r.name)}</strong><br><span class="mono small muted">${str(r.slug)}</span></td>
      <td>${r.capacity === null ? html`<span class="muted">—</span>` : num(r.capacity)}</td>
      <td>${str(r.floor) || html`<span class="muted">—</span>`}</td>
      <td>${parseJson<string[]>(r.av_capabilities, []).map((c) => badge(c))}</td>
      <td>${bool(r.is_public) ? badge("public", "ok") : badge("staff only", "warn")}</td>
      <td class="right">
        ${canWrite
          ? editDetails(
              "Edit",
              html`<form method="post" action="/admin/events/${ev.id}/rooms/${str(r.id)}" class="inline-grid">
                  ${roomFields(r)}
                  ${field({ name: "is_public", label: "On the public schedule", type: "checkbox", value: bool(r.is_public) })}
                  <button type="submit" class="small">Save</button>
                </form>
                ${actionForm(`/admin/events/${ev.id}/rooms/${str(r.id)}`, "Archive room", {
                  confirm: "Archive this room?",
                  hidden: { action: "archive" },
                })}`,
            )
          : raw("")}
      </td>
    </tr>`,
  );

  return card(
    html`${canWrite
        ? html`<form method="post" action="/admin/events/${ev.id}/venue" class="inline-grid">
            <input type="hidden" name="venue_id" value="${venue ? str(venue.id) : ""}">
            ${field({ name: "name", label: "Venue name", required: true, value: venue ? str(venue.name) : "" })}
            ${field({ name: "address", label: "Address", type: "textarea", rows: 2, value: venue ? str(venue.address) : "" })}
            ${field({ name: "map_url", label: "Map URL", type: "url", value: venue ? str(venue.map_url) : "" })}
            ${field({ name: "timezone", label: "Timezone", type: "select", options: timezoneOptions(venue ? str(venue.timezone) : null), value: venue ? str(venue.timezone) : "", help: `Leave unchosen to use the event timezone (${ev.timezone}).` })}
            <button type="submit">${venue ? "Save venue" : "Add venue"}</button>
          </form>`
        : venue
          ? html`<p><strong>${str(venue.name)}</strong> · ${str(venue.address)}</p>`
          : empty("No venue yet.")}
      <h3>Rooms</h3>
      ${venue
        ? html`${table(["Room", "Capacity", "Floor", "AV", "Visibility", ""], roomRows, "No rooms yet. An in-person or hybrid event needs at least one to go active.")}
            ${canWrite
              ? addForm("Add a room", html`<form method="post" action="/admin/events/${ev.id}/rooms" class="inline-grid">
                  <input type="hidden" name="venue_id" value="${str(venue.id)}">
                  ${roomFields(null)}
                  <button type="submit">Add room</button>
                </form>`)
              : raw("")}`
        : empty("Add the venue first — rooms belong to it.")}`,
    "Venue and rooms",
  );
}

/* -------------------------------------------------------------------------- */
/* Admin — calls for proposals                                                 */
/* -------------------------------------------------------------------------- */

function registerAdminCfpRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/cfps", async (_req, ctx, params) => {
    ctx.requireRead("cfp.configure", { event_id: params.eventId });
    const { row, ref } = await loadEventFor(ctx, params.eventId);
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("cfp.configure", { event_id: ref.id });
    const cfps = await app.db.select<Row>("call_for_proposals", { event_id: ref.id }, { orderBy: "opens_at, id" });
    const base = str(ctx.env.PUBLIC_BASE_URL) || ctx.url.origin;

    const rows: SafeHtml[] = [];
    for (const c of cfps) {
      const status = await derivedCfpStatus(app, c, row);
      const count = await proposalCount(app, str(c.id));
      const published = await loadPublishedForm(app, str(c.id));
      const publicUrl = `${base}/e/${str(row.slug)}/cfp/${str(c.slug)}`;
      rows.push(html`<tr>
        <td><a href="/admin/cfps/${str(c.id)}"><strong>${str(c.name)}</strong></a><br><span class="mono small muted">${str(c.slug)}</span></td>
        <td>${badge(status)}<br><span class="small muted">${badge(str(c.audience))}</span></td>
        <td class="small">${when(str(c.opens_at), ref.timezone)}<br>→ ${when(str(c.closes_at), ref.timezone)}</td>
        <td>${count}</td>
        <td>${published ? html`v${published.version} ${badge("published", "ok")}` : badge("no published form", "warn")}</td>
        <td>${copyableUrl(publicUrl, str(c.id))}</td>
        <td class="right">
          <a class="btn secondary small" href="/admin/cfps/${str(c.id)}/form">Form builder</a>
          ${canWrite && !c.published_at ? actionForm(`/admin/cfps/${str(c.id)}/publish`, "Publish call", { className: "" }) : raw("")}
          ${canWrite && status === "open" ? actionForm(`/admin/cfps/${str(c.id)}/close`, "Close now", { confirm: "Close this call now?" }) : raw("")}
        </td>
      </tr>`);
    }

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Calls for proposals", event: ref, active: "cfp", width: "wide" },
        html`${pageHead(
            "Calls for proposals",
            "An event may run several at once — a main call, a workshops call with its own deadline, and a sponsor intake that opens later.",
            canWrite ? html`<a class="btn" href="/admin/events/${ref.id}/cfps/new">New call</a>` : raw(""),
          )}
          ${str(row.status) !== "active" || str(row.visibility) !== "public"
            ? html`<p class="notice warn">Public call pages need an <strong>active</strong>, <strong>public</strong> event. This event is ${str(row.status)} and ${str(row.visibility)}.</p>`
            : raw("")}
          ${table(["Call", "Status", "Window", "Proposals", "Form", "Public link", ""], rows, "No calls for proposals yet.")}`,
      ),
    );
  });

  router.get("/admin/events/:eventId/cfps/new", async (_req, ctx, params) => {
    ctx.requireWrite("cfp.configure", { event_id: params.eventId });
    const { ref } = await loadEventFor(ctx, params.eventId);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New call for proposals", event: ref, active: "cfp", width: "narrow" },
        html`${pageHead("New call for proposals", `Times are entered and shown in ${ref.timezone}.`)}
          ${card(html`<form method="post" action="/admin/events/${ref.id}/cfps/new" class="stack">
            ${field({ name: "name", label: "Name", required: true, placeholder: "Main CFP 2026" })}
            ${field({ name: "slug", label: "URL slug", help: "The public URL segment. Derived from the name if blank." })}
            ${field({ name: "audience", label: "Audience", type: "select", required: true, value: "public", options: opts(CFP_AUDIENCE), help: "Sponsors-only and invite-only calls are never public." })}
            ${field({ name: "opens_at", label: `Opens (${ref.timezone})`, type: "datetime-local", required: true })}
            ${field({ name: "closes_at", label: `Closes (${ref.timezone})`, type: "datetime-local", required: true, help: "Must be after it opens." })}
            ${field({ name: "intro_markdown", label: "Introduction", type: "textarea", rows: 5, help: "Markdown, shown on the call's public page." })}
            <button type="submit">Create call</button>
          </form>`)}
          <p class="muted small">A four-step submission form is created with the call — <span class="mono">your-details → the-talk → logistics → review-and-submit</span> — as a draft you can edit before publishing.</p>`,
      ),
    );
  });

  router.post("/admin/events/:eventId/cfps/new", async (req, ctx, params) => {
    ctx.requireWrite("cfp.configure", { event_id: params.eventId });
    const { ref } = await loadEventFor(ctx, params.eventId);
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const values = readCfpInput(input, ref.timezone, false);
    const cfp = await createCfp(app, ref.id, {
      ...values,
      allow_edit_after_submit: true,
      notify_on_submit: true,
    });
    await app.flush();
    return redirect(`/admin/cfps/${str(cfp.id)}/form`, 303, OK("Call created with a draft form. Publish the form, then the call."));
  });

  router.get("/admin/cfps/:cfpId", async (_req, ctx, params) => {
    const { cfp, event, ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireRead("cfp.configure", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("cfp.configure", { event_id: ref.id });
    const status = await derivedCfpStatus(app, cfp, event);
    const [formats, tracks, published] = await Promise.all([
      cfpFormatOptions(app, params.cfpId),
      cfpTrackOptions(app, params.cfpId),
      loadPublishedForm(app, params.cfpId),
    ]);
    const base = str(ctx.env.PUBLIC_BASE_URL) || ctx.url.origin;
    const publicUrl = `${base}/e/${str(event.slug)}/cfp/${str(cfp.slug)}`;

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(cfp.name), event: ref, active: "cfp", width: "wide" },
        html`${pageHead(
            str(cfp.name),
            `Derived status: ${status}. ${cfp.published_at ? "" : "Not published yet."}`,
            html`${badge(status)}
              <a class="btn secondary" href="/admin/cfps/${params.cfpId}/form">Form builder</a>
              ${canWrite && !cfp.published_at ? actionForm(`/admin/cfps/${params.cfpId}/publish`, "Publish call", { className: "" }) : raw("")}
              ${canWrite && status === "open" ? actionForm(`/admin/cfps/${params.cfpId}/close`, "Close now", { confirm: "Close this call now?" }) : raw("")}`,
          )}
          ${card(html`<p class="small muted">Public page — works for anyone, with no account, in every status including closed.</p>
            ${copyableUrl(publicUrl, params.cfpId)}
            <p class="small"><a href="${publicUrl}">Open the public page</a> · <a href="/v1/public/events/${str(event.slug)}/cfps/${str(cfp.slug)}">JSON</a></p>`, "Public link")}
          ${status === "closed" && canWrite
            ? card(
                html`<p class="muted">Reopening a closed call is an override, so it is logged with a reason. If the closing time has passed, give a new one.</p>
                  <form method="post" action="/admin/cfps/${params.cfpId}/reopen" class="inline-grid">
                    ${field({ name: "reason", label: "Why", required: true, placeholder: "Committee agreed a 48-hour extension." })}
                    ${field({ name: "closes_at", label: `New closing time (${ref.timezone})`, type: "datetime-local" })}
                    <button type="submit">Reopen call</button>
                  </form>`,
                "Reopen",
              )
            : raw("")}
          ${card(
            html`<form method="post" action="/admin/cfps/${params.cfpId}" class="stack">
              ${versionField(cfp)}
              ${field({ name: "name", label: "Name", required: true, value: str(cfp.name) })}
              ${field({ name: "audience", label: "Audience", type: "select", required: true, value: str(cfp.audience), options: opts(CFP_AUDIENCE) })}
              ${field({ name: "opens_at", label: `Opens (${ref.timezone})`, type: "datetime-local", required: true, value: toLocalInput(str(cfp.opens_at), ref.timezone) })}
              ${field({ name: "closes_at", label: `Closes (${ref.timezone})`, type: "datetime-local", required: true, value: toLocalInput(str(cfp.closes_at), ref.timezone) })}
              ${field({ name: "grace_period_minutes", label: "Grace period (minutes)", type: "number", min: 0, value: num(cfp.grace_period_minutes), help: "Lets in-flight submissions land after the bell." })}
              ${field({ name: "late_submission_policy", label: "Late submissions", type: "select", required: true, value: str(cfp.late_submission_policy), options: opts(LATE_SUBMISSION_POLICY), help: "allow_with_flag marks the proposal late for the committee." })}
              ${field({ name: "max_proposals_per_person", label: "Maximum proposals per person", type: "number", min: 1, value: cfp.max_proposals_per_person ?? "", help: "Blank means unlimited." })}
              ${field({ name: "allow_edit_after_submit", label: "Submitters may edit until the call closes", type: "checkbox", value: bool(cfp.allow_edit_after_submit) })}
              ${field({ name: "withdraw_allowed_until", label: "Withdrawal allowed until", type: "select", required: true, value: str(cfp.withdraw_allowed_until), options: opts(WITHDRAW_ALLOWED_UNTIL) })}
              ${field({ name: "notify_on_submit", label: "Send the submitter a confirmation", type: "checkbox", value: bool(cfp.notify_on_submit) })}
              ${field({ name: "intro_markdown", label: "Introduction", type: "textarea", rows: 6, value: str(cfp.intro_markdown) })}
              ${field({ name: "guidelines_url", label: "Guidelines URL", type: "url", value: str(cfp.guidelines_url) })}
              ${canWrite ? html`<button type="submit">Save settings</button>` : raw("")}
            </form>`,
            "Settings",
          )}
          ${card(
            html`<p class="muted">Which formats and tracks this call accepts, and any deadline that comes earlier than the call's own.</p>
              <form method="post" action="/admin/cfps/${params.cfpId}/options">
                ${optionTable("Formats", formats.map((f) => ({ id: f.id, name: f.name, is_available: f.is_available, closes_at_override: f.closes_at_override, max: f.max_proposals_per_person })), "format", ref.timezone)}
                ${optionTable("Tracks", tracks.map((t) => ({ id: t.id, name: t.name, is_available: t.is_available, closes_at_override: t.closes_at_override, max: t.max_proposals_per_person })), "track", ref.timezone)}
                ${canWrite ? html`<button type="submit">Save availability</button>` : raw("")}
              </form>`,
            "What this call accepts",
          )}
          ${card(
            published
              ? html`<p>Published form <strong>version ${published.version}</strong> with ${published.steps.length} steps and ${published.steps.reduce((n, s) => n + s.fields.length, 0)} fields.</p>
                  <p><a class="btn secondary" href="/admin/cfps/${params.cfpId}/form">Open the form builder</a></p>`
              : html`<p class="notice warn">No published form yet. A call cannot open without one.</p>
                  <p><a class="btn" href="/admin/cfps/${params.cfpId}/form">Open the form builder</a></p>`,
            "Submission form",
          )}`,
      ),
    );
  });

  router.post("/admin/cfps/:cfpId", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const values = readCfpInput(input, ref.timezone, false);
    try {
      // INV-11-14 — see the event settings route above.
      await updateCfp(
        app,
        params.cfpId,
        {
          name: values.name,
          audience: values.audience,
          intro_markdown: values.intro_markdown,
          guidelines_url: values.guidelines_url,
          opens_at: values.opens_at,
          closes_at: values.closes_at,
          grace_period_minutes: values.grace_period_minutes,
          late_submission_policy: values.late_submission_policy,
          max_proposals_per_person: values.max_proposals_per_person,
          allow_edit_after_submit: values.allow_edit_after_submit,
          withdraw_allowed_until: values.withdraw_allowed_until,
          notify_on_submit: values.notify_on_submit,
        },
        expectedVersion(input),
      );
    } catch (err) {
      const stale = await staleWriteRedirect(err, app, `/admin/cfps/${params.cfpId}`);
      if (stale) return stale;
      throw err;
    }
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}`, 303, OK("Call settings saved."));
  });

  router.post("/admin/cfps/:cfpId/options", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const collect = (prefix: string) => {
      const ids = input.list(`${prefix}_ids`);
      return ids.map((id) => ({
        id,
        is_available: input.list(`${prefix}_available`).includes(id),
        closes_at_override: fromLocalInput(input.optional(`${prefix}_override_${id}`), ref.timezone),
        max_proposals_per_person: input.int(`${prefix}_max_${id}`),
      }));
    };
    await updateCfpOptions(app, params.cfpId, "cfp_format_option", collect("format"));
    await updateCfpOptions(app, params.cfpId, "cfp_track_option", collect("track"));
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}`, 303, OK("Availability saved."));
  });

  router.post("/admin/cfps/:cfpId/publish", async (_req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const app = ctx.app(ref.id);
    await publishCfp(app, params.cfpId);
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}`, 303, OK("Call published."));
  });

  router.post("/admin/cfps/:cfpId/close", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    await closeCfp(app, params.cfpId, input.optional("reason"));
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}`, 303, OK("Call closed."));
  });

  router.post("/admin/cfps/:cfpId/reopen", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    await reopenCfp(app, params.cfpId, input.str("reason"), fromLocalInput(input.optional("closes_at"), ref.timezone));
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}`, 303, OK("Call reopened. The reason is on the audit log."));
  });
}

function optionTable(
  title: string,
  items: { id: string; name: string; is_available: boolean; closes_at_override: string | null; max: number | null }[],
  prefix: string,
  timezone: string,
): SafeHtml {
  if (items.length === 0) return html`<h3>${title}</h3>${empty(`No ${title.toLowerCase()} configured on the event yet.`)}`;
  return html`<h3>${title}</h3>
    ${table(
      ["Available", title.slice(0, -1), "Earlier deadline", "Max per person"],
      items.map(
        (i) => html`<tr>
          <td>
            <input type="hidden" name="${prefix}_ids" value="${i.id}">
            <input type="checkbox" name="${prefix}_available" value="${i.id}"${i.is_available ? raw(" checked") : raw("")}>
          </td>
          <td>${i.name}</td>
          <td><input type="datetime-local" name="${prefix}_override_${i.id}" value="${toLocalInput(i.closes_at_override, timezone)}"></td>
          <td><input type="number" min="1" name="${prefix}_max_${i.id}" value="${i.max ?? ""}"></td>
        </tr>`,
      ),
    )}`;
}

/** A public URL that can be selected and copied without leaving the page. */
function copyableUrl(url: string, id: string): SafeHtml {
  const elId = `copy_${id.replace(/[^\w]/g, "_")}`;
  return html`<span class="copy-url">
    <input id="${elId}" class="mono" readonly value="${url}" size="52" onfocus="this.select()">
    <button type="button" class="secondary small" data-copy-for="${elId}">Copy</button>
  </span>
  ${inlineScript(`(function(){var b=document.currentScript.previousElementSibling.querySelector('[data-copy-for]');if(!b)return;b.addEventListener('click',function(){var i=document.getElementById('${elId}');i.select();try{navigator.clipboard?navigator.clipboard.writeText(i.value):document.execCommand('copy');}catch(e){document.execCommand('copy');}b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1500);});})();`)}`;
}

/* -------------------------------------------------------------------------- */
/* Admin — the form builder                                                    */
/* -------------------------------------------------------------------------- */

function registerAdminFormRoutes(router: Router<RequestContext>): void {
  router.get("/admin/cfps/:cfpId/form", async (_req, ctx, params) => {
    const { cfp, event, ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireRead("cfp.configure", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("cfp.configure", { event_id: ref.id });
    const spec = await builderForm(app, params.cfpId);
    const versions = await listFormVersions(app, params.cfpId);
    const [tracks, formats] = await Promise.all([cfpTrackOptions(app, params.cfpId, true), cfpFormatOptions(app, params.cfpId, true)]);

    if (!spec) {
      return htmlResponse(
        adminPage(ctx, { title: "Form builder", event: ref, active: "cfp" }, card(empty("This call has no form yet."))),
      );
    }

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Form builder", event: ref, active: "cfp", width: "wide" },
        html`${pageHead(
            `${str(cfp.name)} — submission form`,
            "Steps, fields, conditional visibility and what each answer becomes on the proposal. A published form is versioned, not edited in place.",
            html`${badge(spec.status)} <span class="badge">version ${spec.version}</span>
              <a class="btn secondary" href="/admin/cfps/${params.cfpId}/form/preview">Preview the public form</a>
              ${canWrite && spec.status === "draft"
                ? actionForm(`/admin/cfps/${params.cfpId}/form/publish`, "Publish this version", { className: "", hidden: { form_id: spec.id } })
                : raw("")}
              ${canWrite && spec.status === "published"
                ? actionForm(`/admin/cfps/${params.cfpId}/form/new-version`, "New draft version", {})
                : raw("")}`,
          )}
          ${spec.status === "published"
            ? html`<p class="notice">This version is live. Cosmetic edits — label, help text, order — apply in place; anything else creates a new draft version automatically.</p>`
            : raw("")}
          ${versionList(versions, spec.id)}
          ${joinHtml(spec.steps.map((step, i) => stepCard(params.cfpId, spec, step, i, tracks, formats, canWrite)))}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/cfps/${params.cfpId}/form/steps" class="inline-grid">
                  <input type="hidden" name="form_id" value="${spec.id}">
                  ${field({ name: "title", label: "Step title", required: true, placeholder: "Sponsorship details" })}
                  ${field({ name: "key", label: "Key", help: "Stable across versions. Derived from the title if blank." })}
                  ${field({ name: "description", label: "Description", type: "textarea", rows: 2 })}
                  ${field({ name: "is_optional", label: "Submitters may skip this step", type: "checkbox" })}
                  <button type="submit">Add step</button>
                </form>`,
                "Add a step",
              )
            : raw("")}`,
      ),
    );
  });

  router.get("/admin/cfps/:cfpId/form/preview", async (_req, ctx, params) => {
    const { cfp, ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireRead("cfp.configure", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const view = await publicCfpView(app, params.cfpId, { allowNonPublic: true });
    const spec = await builderForm(app, params.cfpId);
    const [tracks, formats] = await Promise.all([cfpTrackOptions(app, params.cfpId, true), cfpFormatOptions(app, params.cfpId, true)]);
    const publicOnly = spec
      ? {
          steps: spec.steps.map((s) => ({ ...s, fields: s.fields.filter((f) => f.audience === "public" && !f.pii) })),
        }
      : { steps: [] };

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Public form preview", event: ref, active: "cfp", width: "default" },
        html`${pageHead(
            `${str(cfp.name)} — what the public sees`,
            "This is the form as an applicant sees it: committee-only, organizer-only and personal-data fields are absent. Conditional fields appear and disappear as you change the answers.",
            html`<a class="btn secondary" href="/admin/cfps/${params.cfpId}/form">Back to the builder</a>`,
          )}
          ${view?.cfp.intro_markdown ? card(markdown(view.cfp.intro_markdown), "Introduction") : raw("")}
          <noscript><p class="notice">With scripts off, every conditional field is shown with a note saying when it applies.</p></noscript>
          ${renderPublicForm(publicOnly, { tracks, formats, disabled: true })}`,
      ),
    );
  });

  router.post("/admin/cfps/:cfpId/form/steps", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    await addStep(app, input.str("form_id"), {
      key: input.optional("key"),
      title: input.str("title"),
      description: input.optional("description"),
      is_optional: input.bool("is_optional"),
    });
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Step added."));
  });

  router.post("/admin/cfps/:cfpId/form/steps/:stepId", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const action = input.str("action");
    if (action === "delete") {
      await deleteStep(app, params.stepId);
      await app.flush();
      return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Step removed."));
    }
    if (action === "up" || action === "down") {
      await moveStep(app, params.stepId, action);
      await app.flush();
      return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Step moved."));
    }
    await updateStep(app, params.stepId, {
      title: input.str("title"),
      description: input.optional("description"),
      is_optional: input.bool("is_optional"),
    });
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Step updated."));
  });

  router.post("/admin/cfps/:cfpId/form/fields", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const formId = input.str("form_id");
    const stepId = input.str("step_id");
    const spec = await loadFormSpec(app, formId);
    await addField(app, formId, { step_id: stepId, ...readFieldInput(input, spec, stepId) });
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Field added."));
  });

  router.post("/admin/cfps/:cfpId/form/fields/:fieldId", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const action = input.str("action");
    if (action === "delete") {
      await deleteField(app, params.fieldId);
      await app.flush();
      return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Field removed."));
    }
    if (action === "up" || action === "down") {
      await moveField(app, params.fieldId, action);
      await app.flush();
      return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Field moved."));
    }
    const existing = await app.db.byId<Row>("form_field", params.fieldId);
    if (!existing) throw notFound("Form field", params.fieldId);
    const spec = await loadFormSpec(app, str(existing.form_id));
    const values = readFieldInput(input, spec, str(existing.step_id), params.fieldId);
    await updateField(app, params.fieldId, {
      label: values.label,
      help_text: values.help_text,
      placeholder: values.placeholder,
      type: values.type,
      options: values.options,
      is_required: values.is_required,
      visible_when: values.visible_when,
      maps_to: values.maps_to,
      audience: values.audience,
      pii: values.pii,
      identifies_speaker: values.identifies_speaker,
    });
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Field updated."));
  });

  router.post("/admin/cfps/:cfpId/form/publish", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    let formId = input.optional("form_id");
    if (!formId) {
      const spec = await builderForm(app, params.cfpId);
      formId = spec?.id ?? null;
    }
    if (!formId) throw notFound("Submission form");
    await publishForm(app, formId);
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("Form published. The previous version is retired; drafts already bound to it keep it."));
  });

  router.post("/admin/cfps/:cfpId/form/new-version", async (req, ctx, params) => {
    const { ref } = await loadCfpFor(ctx, params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    await createDraftVersion(app, params.cfpId, input.optional("notes"));
    await app.flush();
    return redirect(`/admin/cfps/${params.cfpId}/form`, 303, OK("New draft version created from the published one."));
  });
}

function versionList(versions: Row[], currentId: string): SafeHtml {
  if (versions.length <= 1) return raw("");
  return card(
    table(
      ["Version", "Status", "Published", "Notes"],
      versions.map(
        (v) => html`<tr>
          <td>${str(v.id) === currentId ? html`<strong>v${num(v.version)}</strong> (editing)` : html`v${num(v.version)}`}</td>
          <td>${badge(str(v.status))}</td>
          <td class="small">${strOrNull(v.published_at) ?? "—"}</td>
          <td class="small muted">${str(v.notes)}</td>
        </tr>`,
      ),
    ),
    "Versions",
  );
}

function stepCard(
  cfpId: string,
  spec: FormSpec,
  step: FormSpec["steps"][number],
  index: number,
  tracks: CfpTrackView[],
  formats: CfpFormatView[],
  canWrite: boolean,
): SafeHtml {
  const draft = spec.status === "draft";
  const rows = step.fields.map((f) => {
    const options = resolvedOptions(f, tracks, formats);
    const summary = f.visible_when
      ? f.visible_when.all
          .map((c) => {
            const target = spec.steps.flatMap((s) => s.fields).find((x) => x.key === c.field);
            const targetOptions = target ? resolvedOptions(target, tracks, formats) : [];
            const valueLabel = Array.isArray(c.value)
              ? c.value.map((v) => targetOptions.find((o) => o.value === String(v))?.label ?? String(v)).join(", ")
              : targetOptions.find((o) => o.value === String(c.value))?.label ?? String(c.value ?? "");
            return `${target?.label ?? c.field} ${CONDITION_OP_LABELS[c.op]}${opNeedsValue(c.op) ? ` ${valueLabel}` : ""}`;
          })
          .join(" and ")
      : null;
    return html`<tr>
      <td>
        <strong>${f.label}</strong>${f.is_required ? html` <span class="req">*</span>` : raw("")}<br>
        <span class="mono small muted">${f.key}</span>
      </td>
      <td>${badge(f.type)}</td>
      <td>${f.maps_to === "none" ? html`<span class="muted">—</span>` : badge(f.maps_to, "info")}</td>
      <td>${badge(f.audience, f.audience === "public" ? "ok" : "warn")}${f.pii ? badge("pii", "err") : raw("")}</td>
      <td class="small">${summary ? html`Shown when ${summary}` : html`<span class="muted">always shown</span>`}</td>
      <td class="right">
        ${canWrite
          ? html`${actionForm(`/admin/cfps/${cfpId}/form/fields/${f.id}`, "▲", { hidden: { action: "up" } })}
              ${actionForm(`/admin/cfps/${cfpId}/form/fields/${f.id}`, "▼", { hidden: { action: "down" } })}
              ${editDetails(
                "Edit",
                html`<form method="post" action="/admin/cfps/${cfpId}/form/fields/${f.id}" class="inline-grid">
                    ${fieldFormControls(spec, step, tracks, formats, f, options)}
                    <button type="submit" class="small">Save field</button>
                  </form>
                  ${draft
                    ? actionForm(`/admin/cfps/${cfpId}/form/fields/${f.id}`, "Delete field", {
                        className: "danger",
                        confirm: `Delete "${f.label}"?`,
                        hidden: { action: "delete" },
                      })
                    : html`<p class="small muted">Deleting a question on a published form would strand answers. Create a new draft version first.</p>`}`,
              )}`
          : raw("")}
      </td>
    </tr>`;
  });

  return card(
    html`<div class="page-head">
        <div class="grow">
          <h2>Step ${index + 1} · ${step.title} ${step.is_optional ? badge("optional") : raw("")}</h2>
          <p class="small mono muted">${step.key}</p>
          ${step.description ? html`<p class="muted">${step.description}</p>` : raw("")}
        </div>
        ${canWrite
          ? html`<div class="actions">
              ${actionForm(`/admin/cfps/${cfpId}/form/steps/${step.id}`, "▲", { hidden: { action: "up" } })}
              ${actionForm(`/admin/cfps/${cfpId}/form/steps/${step.id}`, "▼", { hidden: { action: "down" } })}
            </div>`
          : raw("")}
      </div>
      ${table(["Field", "Type", "Becomes", "Audience", "Shown when", ""], rows, "No fields on this step yet.")}
      ${canWrite
        ? html`<details class="add-field">
            <summary><strong>Add a field to “${step.title}”</strong></summary>
            <form method="post" action="/admin/cfps/${cfpId}/form/fields" class="inline-grid">
              <input type="hidden" name="form_id" value="${spec.id}">
              <input type="hidden" name="step_id" value="${step.id}">
              ${fieldFormControls(spec, step, tracks, formats, null, [])}
              <button type="submit">Add field</button>
            </form>
          </details>`
        : raw("")}
      ${canWrite && spec.status === "draft" && step.fields.length === 0
        ? actionForm(`/admin/cfps/${cfpId}/form/steps/${step.id}`, "Remove step", {
            className: "danger",
            confirm: `Remove the step "${step.title}"?`,
            hidden: { action: "delete" },
          })
        : raw("")}`,
  );
}

/**
 * The add/edit control set. The conditional section only offers fields that
 * precede this one (INV-02-8), and its value control becomes a dropdown of
 * that field's own options where it has them.
 */
function fieldFormControls(
  spec: FormSpec,
  step: FormSpec["steps"][number],
  tracks: CfpTrackView[],
  formats: CfpFormatView[],
  existing: FormSpec["steps"][number]["fields"][number] | null,
  existingOptions: SelectOption[],
): SafeHtml {
  const candidates = fieldsBefore(spec, step.id, existing?.id ?? null);
  const uid = `${step.id}_${existing?.id ?? "new"}`.replace(/[^\w]/g, "_");
  const optionMap: Record<string, SelectOption[]> = {};
  for (const c of candidates) optionMap[c.key] = resolvedOptions(c, tracks, formats);
  const rule = existing?.visible_when?.all?.[0] ?? null;
  const isPicker = existing ? existing.type === "track_picker" || existing.type === "format_picker" : false;

  return html`
    ${field({ name: "label", label: "Label", required: true, value: existing?.label ?? "", placeholder: "Key takeaway", id: `lbl_${uid}` })}
    ${existing ? raw("") : field({ name: "key", label: "Key", help: "Stable identifier, unique in this form. Derived from the label if blank.", id: `key_${uid}` })}
    ${field({ name: "type", label: "Type", type: "select", required: true, value: existing?.type ?? "short_text", options: FIELD_TYPE.map((t) => ({ value: t, label: humanise(t) })), id: `typ_${uid}` })}
    ${field({ name: "is_required", label: "Required", type: "checkbox", value: existing?.is_required ?? false, id: `req_${uid}` })}
    ${field({ name: "help_text", label: "Help text", value: existing?.help_text ?? "", id: `hlp_${uid}` })}
    ${field({ name: "placeholder", label: "Placeholder", value: existing?.placeholder ?? "", id: `plc_${uid}` })}
    ${field({
      name: "options",
      label: "Options",
      type: "textarea",
      rows: 4,
      value: isPicker ? "" : optionLines(existingOptions.length ? existingOptions : existing?.options ?? []),
      placeholder: "Beginner\nIntermediate\nAdvanced",
      help: "One per line, for dropdowns and multi-selects. Use value|Label to fix the stored value. Track and format pickers take their options from this call's configuration.",
      id: `opt_${uid}`,
    })}
    ${field({
      name: "maps_to",
      label: "Becomes",
      type: "select",
      required: true,
      value: existing?.maps_to ?? "none",
      options: MAPS_TO.map((m) => ({ value: m, label: m === "none" ? "just an answer" : humanise(m) })),
      help: "Promotes the answer into a first-class proposal column. At most one field per form per value.",
      id: `map_${uid}`,
    })}
    ${field({
      name: "audience",
      label: "Who sees the answer",
      type: "select",
      required: true,
      value: existing?.audience ?? "public",
      options: FIELD_AUDIENCE.map((a) => ({ value: a, label: humanise(a) })),
      help: "Only public answers may reach the published schedule or the public call page.",
      id: `aud_${uid}`,
    })}
    ${field({ name: "pii", label: "The answer is personal data", type: "checkbox", value: existing?.pii ?? false, help: "Redacted from public responses, snapshots and logs.", id: `pii_${uid}` })}
    ${field({
      name: "identifies_speaker",
      label: "The answer names the speaker",
      type: "checkbox",
      value: existing?.identifies_speaker ?? false,
      help: "Hidden from reviewers in a double-blind round. A speaker bio is the usual case: published beside the talk, so not personal data — just fatal to anonymity.",
      id: `ids_${uid}`,
    })}
    <fieldset class="field conditional">
      <legend>Conditional visibility</legend>
      <span class="help">Show this field only when an earlier answer says so. A rule may only reference fields that come before this one.</span>
      ${candidates.length === 0
        ? html`<p class="muted small">No earlier field to depend on yet.</p>`
        : html`<div class="cond-row">
            <select name="visible_when_field" id="cf_${uid}">
              <option value="">— always show —</option>
              ${candidates.map((c) => html`<option value="${c.key}"${rule?.field === c.key ? raw(" selected") : raw("")}>${c.label}</option>`)}
            </select>
            <select name="visible_when_op" id="co_${uid}">
              ${CONDITION_OPS.map((o) => html`<option value="${o}"${rule?.op === o ? raw(" selected") : raw("")}>${CONDITION_OP_LABELS[o]}</option>`)}
            </select>
            <span id="cv_${uid}">
              <input type="text" name="visible_when_value" value="${rule && !Array.isArray(rule.value) ? String(rule.value ?? "") : ""}" placeholder="value">
            </span>
          </div>
          ${inlineScript(`(function(){
  var options = ${JSON.stringify(optionMap).replace(/</g, "\\u003c")};
  var current = ${JSON.stringify(rule && !Array.isArray(rule.value) ? String(rule.value ?? "") : "").replace(/</g, "\\u003c")};
  var sel = document.getElementById('cf_${uid}');
  var wrap = document.getElementById('cv_${uid}');
  if(!sel || !wrap) return;
  function render(){
    var list = options[sel.value] || [];
    wrap.textContent = '';
    if(list.length){
      var s = document.createElement('select');
      s.name = 'visible_when_value';
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— choose —';
      s.appendChild(blank);
      list.forEach(function(o){
        var opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        if(o.value === current) opt.selected = true;
        s.appendChild(opt);
      });
      wrap.appendChild(s);
    } else {
      var i = document.createElement('input');
      i.type = 'text'; i.name = 'visible_when_value'; i.value = current; i.placeholder = 'value';
      wrap.appendChild(i);
    }
  }
  sel.addEventListener('change', function(){ current = ''; render(); });
  render();
})();`)}`}
    </fieldset>`;
}

/* -------------------------------------------------------------------------- */
/* Management API                                                              */
/* -------------------------------------------------------------------------- */

function registerManagementApi(router: Router<RequestContext>): void {
  /* events ---------------------------------------------------------------- */

  router.get("/v1/events", async (_req, ctx) => {
    ctx.requireRead("config.manage");
    const { cursor, limit } = pageParams(ctx);
    const page = await cursorPage(ctx.app(), "event", { orgScoped: true, softDelete: true, cursor, limit });
    return json({ data: page.items.map(eventJson), next_cursor: page.next_cursor });
  });

  router.post("/v1/events", async (req, ctx) => {
    ctx.requireWrite("event.configure");
    const input = await readInput(req);
    const app = ctx.app();
    // 02, "Starting an event": `source` defaults to `starter`, because an event
    // created empty is a dozen forms before anything works. `empty` is how a
    // caller importing configuration another way opts out.
    const { event, summary } = await provisionEvent(app, {
      name: input.str("name"),
      slug: input.optional("slug"),
      edition: input.optional("edition"),
      tagline: input.optional("tagline"),
      description: input.optional("description"),
      timezone: input.str("timezone", "UTC"),
      starts_on: input.str("starts_on"),
      ends_on: input.str("ends_on"),
      mode: (input.optional("mode") as EventMode) ?? "in_person",
      website_url: input.optional("website_url"),
      visibility: (input.optional("visibility") as EventVisibility) ?? "private",
      settings: input.json<Record<string, unknown>>("settings", {}),
      source: provisioningSource(input.optional("source")),
      clone_from_event_id: input.optional("clone_from_event_id"),
    });
    await app.flush();
    return json({ ...eventJson(event), provisioning: summary }, { status: 201 });
  });

  router.post("/v1/events/:eventId/clone", async (req, ctx, params) => {
    ctx.requireWrite("event.configure");
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const source = await requireCloneSource(ctx.app(), params.eventId);
    const app = ctx.app();
    const { event, summary } = await provisionEvent(app, {
      name: input.str("name"),
      slug: input.optional("slug"),
      edition: input.optional("edition"),
      tagline: input.optional("tagline") ?? strOrNull(source.tagline),
      description: input.optional("description") ?? strOrNull(source.description),
      timezone: input.str("timezone", str(source.timezone, "UTC")),
      starts_on: input.str("starts_on"),
      ends_on: input.str("ends_on"),
      mode: (input.optional("mode") as EventMode) ?? (str(source.mode, "in_person") as EventMode),
      website_url: input.optional("website_url") ?? strOrNull(source.website_url),
      // INV-02-15 — a clone lands private whatever the source was.
      visibility: "private",
      settings: parseJson<Record<string, unknown>>(source.settings, {}),
      source: "clone",
      clone_from_event_id: params.eventId,
    });
    await app.flush();
    return json({ ...eventJson(event), provisioning: summary }, { status: 201 });
  });

  router.get("/v1/events/:eventId", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const row = await eventRow(ctx.app(), params.eventId);
    return json(eventJson(row));
  });

  router.patch("/v1/events/:eventId", async (req, ctx, params) => {
    ctx.requireWrite("event.configure", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const row = await updateEvent(app, params.eventId, input.all(), input.int("row_version"));
    await app.flush();
    return json(eventJson(row));
  });

  router.post("/v1/events/:eventId/activate", async (_req, ctx, params) => {
    ctx.requireWrite("event.configure", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const row = await activateEvent(app, params.eventId);
    await app.flush();
    return json(eventJson(row));
  });

  router.post("/v1/events/:eventId/archive", async (_req, ctx, params) => {
    ctx.requireWrite("event.configure", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const row = await archiveEvent(app, params.eventId);
    await app.flush();
    return json(eventJson(row));
  });

  router.get("/v1/events/:eventId/readiness", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    return json(await activationCheck(ctx.app(params.eventId), params.eventId));
  });

  /* days ------------------------------------------------------------------ */

  router.get("/v1/events/:eventId/days", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const rows = await ctx.app().db.select<Row>("event_day", { event_id: params.eventId }, { orderBy: "sort_order, date" });
    return json({ data: rows.map(dayJson) });
  });

  router.post("/v1/events/:eventId/days", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const row = await createEventDay(app, params.eventId, {
      date: input.str("date"),
      label: input.optional("label"),
      sort_order: input.int("sort_order"),
      is_public: input.has("is_public") ? input.bool("is_public") : true,
    });
    await app.flush();
    return json(dayJson(row), { status: 201 });
  });

  router.patch("/v1/days/:dayId", async (req, ctx, params) => {
    const day = await ctx.app().db.byId<Row>("event_day", params.dayId);
    if (!day) throw notFound("Event day", params.dayId);
    ctx.requireWrite("config.manage", { event_id: str(day.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(day.event_id));
    const row = await updateEventDay(app, params.dayId, {
      date: input.optional("date") ?? undefined,
      label: input.has("label") ? input.optional("label") : undefined,
      sort_order: input.int("sort_order"),
      is_public: input.has("is_public") ? input.bool("is_public") : undefined,
    });
    await app.flush();
    return json(dayJson(row));
  });

  router.delete("/v1/days/:dayId", async (_req, ctx, params) => {
    const day = await ctx.app().db.byId<Row>("event_day", params.dayId);
    if (!day) throw notFound("Event day", params.dayId);
    ctx.requireWrite("config.manage", { event_id: str(day.event_id) });
    const app = ctx.app(str(day.event_id));
    await deleteEventDay(app, params.dayId);
    await app.flush();
    return json({ deleted: params.dayId });
  });

  /* tracks ---------------------------------------------------------------- */

  router.get("/v1/events/:eventId/tracks", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const { cursor, limit } = pageParams(ctx);
    const page = await cursorPage(ctx.app(params.eventId), "track", {
      where: { event_id: params.eventId },
      orgScoped: false,
      softDelete: true,
      cursor,
      limit,
    });
    return json({ data: await Promise.all(page.items.map((r) => trackJson(ctx, r))), next_cursor: page.next_cursor });
  });

  router.post("/v1/events/:eventId/tracks", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const row = await createTrack(app, params.eventId, readTrackInput(input));
    await app.flush();
    return json(await trackJson(ctx, row), { status: 201 });
  });

  router.patch("/v1/tracks/:trackId", async (req, ctx, params) => {
    const track = await ctx.app().db.byId<Row>("track", params.trackId);
    if (!track) throw notFound("Track", params.trackId);
    ctx.requireWrite("config.manage", { event_id: str(track.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(track.event_id));
    const row = await updateTrack(app, params.trackId, readTrackInput(input));
    await app.flush();
    return json(await trackJson(ctx, row));
  });

  router.delete("/v1/tracks/:trackId", async (_req, ctx, params) => {
    const track = await ctx.app().db.byId<Row>("track", params.trackId);
    if (!track) throw notFound("Track", params.trackId);
    ctx.requireWrite("config.manage", { event_id: str(track.event_id) });
    const app = ctx.app(str(track.event_id));
    // INV-02-10: archived, never hard-deleted.
    const row = await archiveConfiguration(app, "track", params.trackId);
    await app.flush();
    return json({ archived: params.trackId, referenced_by: await referenceCount(app, "track", params.trackId), track: await trackJson(ctx, row) });
  });

  /* formats --------------------------------------------------------------- */

  router.get("/v1/events/:eventId/formats", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const { cursor, limit } = pageParams(ctx);
    const page = await cursorPage(ctx.app(params.eventId), "session_format", {
      where: { event_id: params.eventId },
      orgScoped: false,
      softDelete: true,
      cursor,
      limit,
    });
    return json({ data: page.items.map(formatJson), next_cursor: page.next_cursor });
  });

  router.post("/v1/events/:eventId/formats", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const row = await createSessionFormat(app, params.eventId, readFormatInput(input));
    await app.flush();
    return json(formatJson(row), { status: 201 });
  });

  router.patch("/v1/formats/:formatId", async (req, ctx, params) => {
    const fmt = await ctx.app().db.byId<Row>("session_format", params.formatId);
    if (!fmt) throw notFound("Session format", params.formatId);
    ctx.requireWrite("config.manage", { event_id: str(fmt.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(fmt.event_id));
    const row = await updateSessionFormat(app, params.formatId, readFormatInput(input));
    await app.flush();
    return json(formatJson(row));
  });

  router.delete("/v1/formats/:formatId", async (_req, ctx, params) => {
    const fmt = await ctx.app().db.byId<Row>("session_format", params.formatId);
    if (!fmt) throw notFound("Session format", params.formatId);
    ctx.requireWrite("config.manage", { event_id: str(fmt.event_id) });
    const app = ctx.app(str(fmt.event_id));
    const row = await archiveConfiguration(app, "session_format", params.formatId); // INV-02-10
    await app.flush();
    return json({ archived: params.formatId, format: formatJson(row) });
  });

  /* venue and rooms -------------------------------------------------------- */

  router.get("/v1/events/:eventId/venues", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const rows = await ctx.app().db.select<Row>("venue", { event_id: params.eventId }, { orderBy: "id" });
    return json({ data: rows.map(venueJson) });
  });

  router.post("/v1/events/:eventId/venues", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const row = await upsertVenue(
      app,
      params.eventId,
      { name: input.str("name"), address: input.optional("address"), map_url: input.optional("map_url"), timezone: input.optional("timezone") },
      input.optional("venue_id"),
    );
    await app.flush();
    return json(venueJson(row), { status: 201 });
  });

  router.get("/v1/events/:eventId/rooms", async (_req, ctx, params) => {
    ctx.requireRead("config.manage", { event_id: params.eventId });
    const { cursor, limit } = pageParams(ctx);
    const page = await cursorPage(ctx.app(params.eventId), "room", {
      where: { event_id: params.eventId },
      orgScoped: false,
      softDelete: true,
      cursor,
      limit,
    });
    return json({ data: page.items.map(roomJson), next_cursor: page.next_cursor });
  });

  router.post("/v1/events/:eventId/rooms", async (req, ctx, params) => {
    ctx.requireWrite("config.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    let venueId = input.optional("venue_id");
    if (!venueId) {
      const venue = await app.db.first<Row>("venue", { event_id: params.eventId });
      if (!venue) throw notFound("Venue");
      venueId = str(venue.id);
    }
    const row = await createRoom(app, venueId, readRoomInput(input));
    await app.flush();
    return json(roomJson(row), { status: 201 });
  });

  router.patch("/v1/rooms/:roomId", async (req, ctx, params) => {
    const room = await ctx.app().db.byId<Row>("room", params.roomId);
    if (!room) throw notFound("Room", params.roomId);
    ctx.requireWrite("config.manage", { event_id: str(room.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(room.event_id));
    const row = await updateRoom(app, params.roomId, readRoomInput(input));
    await app.flush();
    return json(roomJson(row));
  });

  router.delete("/v1/rooms/:roomId", async (_req, ctx, params) => {
    const room = await ctx.app().db.byId<Row>("room", params.roomId);
    if (!room) throw notFound("Room", params.roomId);
    ctx.requireWrite("config.manage", { event_id: str(room.event_id) });
    const app = ctx.app(str(room.event_id));
    const row = await archiveConfiguration(app, "room", params.roomId); // INV-02-10
    await app.flush();
    return json({ archived: params.roomId, room: roomJson(row) });
  });

  /* cfps ------------------------------------------------------------------ */

  router.get("/v1/events/:eventId/cfps", async (_req, ctx, params) => {
    ctx.requireRead("cfp.configure", { event_id: params.eventId });
    const { cursor, limit } = pageParams(ctx);
    const page = await cursorPage(ctx.app(params.eventId), "call_for_proposals", {
      where: { event_id: params.eventId },
      orgScoped: false,
      softDelete: true,
      cursor,
      limit,
    });
    return json({ data: await Promise.all(page.items.map((r) => cfpJson(ctx, r))), next_cursor: page.next_cursor });
  });

  router.post("/v1/events/:eventId/cfps", async (req, ctx, params) => {
    ctx.requireWrite("cfp.configure", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const event = await eventRow(app, params.eventId);
    const row = await createCfp(app, params.eventId, readCfpInput(input, str(event.timezone), true));
    await app.flush();
    return json(await cfpJson(ctx, row), { status: 201 });
  });

  router.get("/v1/cfps/:cfpId", async (_req, ctx, params) => {
    const app = ctx.app();
    const cfp = await cfpRow(app, params.cfpId);
    ctx.requireRead("cfp.configure", { event_id: str(cfp.event_id) });
    return json(await cfpJson(ctx, cfp));
  });

  router.patch("/v1/cfps/:cfpId", async (req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await updateCfp(app, params.cfpId, input.all(), input.int("row_version"));
    await app.flush();
    return json(await cfpJson(ctx, row));
  });

  router.post("/v1/cfps/:cfpId/publish", async (_req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    const row = await publishCfp(app, params.cfpId);
    await app.flush();
    return json(await cfpJson(ctx, row));
  });

  router.post("/v1/cfps/:cfpId/close", async (req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await closeCfp(app, params.cfpId, input.optional("reason"));
    await app.flush();
    return json(await cfpJson(ctx, row));
  });

  router.post("/v1/cfps/:cfpId/reopen", async (req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await reopenCfp(app, params.cfpId, input.str("reason"), input.optional("closes_at"));
    await app.flush();
    return json(await cfpJson(ctx, row));
  });

  router.get("/v1/cfps/:cfpId/options", async (_req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireRead("cfp.configure", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    return json({ formats: await cfpFormatOptions(app, params.cfpId), tracks: await cfpTrackOptions(app, params.cfpId) });
  });

  router.patch("/v1/cfps/:cfpId/options", async (req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    await updateCfpOptions(app, params.cfpId, "cfp_format_option", input.json("formats", []));
    await updateCfpOptions(app, params.cfpId, "cfp_track_option", input.json("tracks", []));
    await app.flush();
    return json({ formats: await cfpFormatOptions(app, params.cfpId), tracks: await cfpTrackOptions(app, params.cfpId) });
  });

  /* forms ----------------------------------------------------------------- */

  router.get("/v1/cfps/:cfpId/forms", async (_req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireRead("cfp.configure", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    const versions = await listFormVersions(app, params.cfpId);
    return json({
      data: versions.map((v) => ({
        id: str(v.id),
        cfp_id: str(v.cfp_id),
        version: num(v.version),
        status: str(v.status),
        published_at: strOrNull(v.published_at),
        notes: strOrNull(v.notes),
      })),
    });
  });

  router.post("/v1/cfps/:cfpId/forms", async (req, ctx, params) => {
    const cfp = await cfpRow(ctx.app(), params.cfpId);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await createDraftVersion(app, params.cfpId, input.optional("notes"));
    await app.flush();
    return json(formJson(await loadFormSpec(app, str(row.id))), { status: 201 });
  });

  router.get("/v1/forms/:formId", async (_req, ctx, params) => {
    const app = ctx.app();
    const spec = await loadFormSpec(app, params.formId);
    const cfp = await cfpRow(app, spec.cfp_id);
    ctx.requireRead("cfp.configure", { event_id: str(cfp.event_id) });
    return json(formJson(spec));
  });

  router.post("/v1/forms/:formId/publish", async (_req, ctx, params) => {
    const app0 = ctx.app();
    const spec = await loadFormSpec(app0, params.formId);
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    await publishForm(app, params.formId);
    await app.flush();
    return json(formJson(await loadFormSpec(app, params.formId)));
  });

  router.post("/v1/forms/:formId/steps", async (req, ctx, params) => {
    const app0 = ctx.app();
    const spec = await loadFormSpec(app0, params.formId);
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await addStep(app, params.formId, {
      key: input.optional("key"),
      title: input.str("title"),
      description: input.optional("description"),
      is_optional: input.bool("is_optional"),
      sort_order: input.int("sort_order"),
      visible_when: input.json("visible_when", null),
    });
    await app.flush();
    return json({ id: str(row.id), form_id: str(row.form_id), key: str(row.key), title: str(row.title) }, { status: 201 });
  });

  /**
   * The whole builder in one read: the call, the version it is editing, its
   * other versions, the track and format options its pickers resolve against,
   * and the catalogue of field types.
   *
   * The catalogue is served rather than held on the client because it is
   * derived from `FIELD_TYPE`, `MAPS_TO` and `FIELD_AUDIENCE` — enums the model
   * owns and the drift checker watches. A picker with its own copy of the list
   * is a picker that will still offer a type after the model drops one.
   */
  router.get("/v1/cfps/:cfpId/builder", async (_req, ctx, params) => {
    const app0 = ctx.app();
    const cfp = await cfpRow(app0, params.cfpId);
    const eventId = str(cfp.event_id);
    ctx.requireRead("cfp.configure", { event_id: eventId });
    ctx.eventId = eventId;
    const app = ctx.app(eventId);
    const [spec, versions, tracks, formats, event] = await Promise.all([
      builderForm(app, params.cfpId),
      listFormVersions(app, params.cfpId),
      cfpTrackOptions(app, params.cfpId, true),
      cfpFormatOptions(app, params.cfpId, true),
      app.db.byId<Row>("event", eventId),
    ]);
    return json({
      data: {
        cfp: { id: params.cfpId, name: str(cfp.name), slug: str(cfp.slug), event_id: eventId },
        event: event ? { id: eventId, name: str(event.name), slug: str(event.slug) } : null,
        form: spec ? formJson(spec) : null,
        versions: versions.map((v) => ({
          id: str(v.id),
          version: num(v.version),
          status: str(v.status),
          published_at: strOrNull(v.published_at),
          notes: strOrNull(v.notes),
        })),
        tracks: tracks.map((t) => ({ id: t.track_id, label: t.name })),
        formats: formats.map((f) => ({ id: f.session_format_id, label: f.name })),
        field_types: FIELD_TYPE.map((type) => ({
          type,
          label: FIELD_TYPE_LABELS[type],
          description: FIELD_TYPE_HINTS[type],
          group: FIELD_TYPE_GROUPS[type],
          takes_options: OPTION_TYPES.includes(type),
        })),
        maps_to: MAPS_TO.map((value) => ({ value, label: humanise(value) })),
        audiences: FIELD_AUDIENCE.map((value) => ({ value, label: humanise(value) })),
        can_write: ctx.canWrite("cfp.configure", { event_id: eventId }),
      },
    });
  });

  /**
   * The whole order in one write — what a drag-and-drop builder produces.
   * Applying it move-by-move would leave INV-02-8 failing against an
   * intermediate order that nobody asked for.
   */
  router.post("/v1/forms/:formId/reorder", async (req, ctx, params) => {
    const app0 = ctx.app();
    const spec = await loadFormSpec(app0, params.formId);
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const next = await reorderForm(app, params.formId, {
      steps: input.json<{ id: string; sort_order: number }[]>("steps", []),
      fields: input.json<{ id: string; step_id?: string | null; sort_order: number }[]>("fields", []),
    });
    await app.flush();
    return json(formJson(next));
  });

  router.patch("/v1/steps/:stepId", async (req, ctx, params) => {
    const app0 = ctx.app();
    const existing = await app0.db.byId<Row>("form_step", params.stepId);
    if (!existing) throw notFound("Form step", params.stepId);
    const spec = await loadFormSpec(app0, str(existing.form_id));
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await updateStep(app, params.stepId, input.all());
    await app.flush();
    return json({ id: str(row.id), form_id: str(row.form_id), key: str(row.key), title: str(row.title) });
  });

  router.post("/v1/forms/:formId/fields", async (req, ctx, params) => {
    const app0 = ctx.app();
    const spec = await loadFormSpec(app0, params.formId);
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await addField(app, params.formId, {
      step_id: input.str("step_id"),
      key: input.optional("key"),
      label: input.str("label"),
      help_text: input.optional("help_text"),
      placeholder: input.optional("placeholder"),
      type: input.str("type", "short_text") as FieldType,
      options: input.json<SelectOption[] | null>("options", null),
      is_required: input.bool("is_required"),
      validation: input.json<Record<string, unknown> | null>("validation", null),
      visible_when: input.json("visible_when", null),
      maps_to: input.str("maps_to", "none") as MapsTo,
      audience: input.str("audience", "public") as FieldAudience,
      pii: input.bool("pii"),
      identifies_speaker: input.bool("identifies_speaker"),
      sort_order: input.int("sort_order"),
    });
    await app.flush();
    return json({ id: str(row.id), form_id: str(row.form_id), key: str(row.key) }, { status: 201 });
  });

  router.patch("/v1/fields/:fieldId", async (req, ctx, params) => {
    const app0 = ctx.app();
    const existing = await app0.db.byId<Row>("form_field", params.fieldId);
    if (!existing) throw notFound("Form field", params.fieldId);
    const spec = await loadFormSpec(app0, str(existing.form_id));
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(cfp.event_id));
    const row = await updateField(app, params.fieldId, input.all());
    await app.flush();
    return json({ id: str(row.id), form_id: str(row.form_id), key: str(row.key), label: str(row.label) });
  });

  router.delete("/v1/fields/:fieldId", async (_req, ctx, params) => {
    const app0 = ctx.app();
    const existing = await app0.db.byId<Row>("form_field", params.fieldId);
    if (!existing) throw notFound("Form field", params.fieldId);
    const spec = await loadFormSpec(app0, str(existing.form_id));
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    await deleteField(app, params.fieldId);
    await app.flush();
    return json({ deleted: params.fieldId });
  });

  router.delete("/v1/steps/:stepId", async (_req, ctx, params) => {
    const app0 = ctx.app();
    const existing = await app0.db.byId<Row>("form_step", params.stepId);
    if (!existing) throw notFound("Form step", params.stepId);
    const spec = await loadFormSpec(app0, str(existing.form_id));
    const cfp = await cfpRow(app0, spec.cfp_id);
    ctx.requireWrite("cfp.configure", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    await deleteStep(app, params.stepId);
    await app.flush();
    return json({ deleted: params.stepId });
  });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

function registerPublicApi(router: Router<RequestContext>): void {
  /**
   * INV-02-12 — unauthenticated, for a `public` CFP on an `active`, `public`
   * event, in every derived status including `closed`. Cached on the CFP's
   * `updated_at`, which is what the model says it is keyed on.
   */
  router.get("/v1/public/events/:eventSlug/cfps/:cfpSlug", async (req, ctx, params) => {
    const view = await publicCfpView(ctx.app(), params.cfpSlug, { eventSlug: params.eventSlug });
    if (!view) return json({ error: "not_found", message: "No such call for proposals." }, { status: 404 });
    const etag = `W/"${view.cfp.slug}-${view.cfp.status}-${view.form?.version ?? 0}"`;
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return json(view, { headers: { etag, "cache-control": "public, max-age=60" } });
  });
}
