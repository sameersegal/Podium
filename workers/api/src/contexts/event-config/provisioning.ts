/**
 * 02 — "Starting an event: the starter blueprint and cloning".
 *
 * An event is never created empty unless that is asked for. This module is the
 * half that touches storage: it turns `STARTER_BLUEPRINT` into rows, or copies
 * an earlier edition's configuration onto a new event with every date rebased
 * (INV-02-16).
 *
 * It orchestrates rather than writes. Every row goes through the service that
 * owns its aggregate — `createTrack` here, `copyRubricToEvent` in review,
 * `copyTaskDefinitionsToEvent` in onboarding, `copyTiersToEvent` in sponsorship,
 * `copyTemplatesToEvent` in platform — so slug uniqueness, validation, the
 * emitted `track.created` / `room.created` facts and the audit trail are the
 * ones a hand-built event would get. A provisioned event has no second class of
 * row in it.
 *
 * The whole thing runs in one `AppContext`, so a caller flushes once and every
 * reaction sees a complete event.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  blueprintDays,
  calendarDaysBetween,
  rebaseInstant,
  starterCfpWindow,
  STARTER_BLUEPRINT,
} from "@podiumstack/domain/event-config/blueprint.js";
import { formSpecAsTemplate } from "@podiumstack/domain/event-config/rules.js";
import type {
  CapacityPolicy,
  CfpAudience,
  EventMode,
  LateSubmissionPolicy,
  Origin,
  ProvisioningSource,
  WithdrawAllowedUntil,
} from "@podiumstack/domain/event-config/types.js";
import { DomainError, notFound } from "@podiumstack/domain/shared/errors.js";
import { copyTemplatesToEvent } from "../platform/notifications.js";
import { copyTaskDefinitionsToEvent, createDefaultTaskDefinitions } from "../onboarding/service.js";
import { copyRubricToEvent, createProgrammeScorecardRubric, createSponsorComplianceRubric } from "../review/service.js";
import { copyTiersToEvent } from "../sponsorship/service.js";
import {
  createCfp,
  createEvent,
  createEventDay,
  createRoom,
  createSessionFormat,
  createTrack,
  publishForm,
  updateCfpOptions,
  upsertVenue,
  type CreateEventInput,
} from "./service.js";
import { eventRow, loadFormSpec, loadPublishedForm } from "./views.js";

/* -------------------------------------------------------------------------- */
/* What a caller gets back                                                     */
/* -------------------------------------------------------------------------- */

export interface ProvisioningSummary {
  source: ProvisioningSource;
  source_event_id: string | null;
  /** Whole days every copied instant was shifted by (INV-02-16). */
  day_shift: number;
  counts: Record<string, number>;
}

const EMPTY_SUMMARY = (source: ProvisioningSource): ProvisioningSummary => ({
  source,
  source_event_id: null,
  day_shift: 0,
  counts: {},
});

/**
 * `counts` is keyed by the aggregate, not by a display string, so the
 * `event.cloned` payload (10) stays a stable contract and the screens do the
 * wording. Spelled out rather than suffixed because English does not derive:
 * "calls for proposals" pluralises in the middle and "days" is not "daies".
 */
const COUNT_LABELS: Record<string, [singular: string, plural: string]> = {
  day: ["day", "days"],
  track: ["track", "tracks"],
  session_format: ["session format", "session formats"],
  venue: ["venue", "venues"],
  room: ["room", "rooms"],
  cfp: ["call for proposals", "calls for proposals"],
  rubric: ["rubric", "rubrics"],
  task_definition: ["onboarding task", "onboarding tasks"],
  sponsorship_tier: ["sponsorship tier", "sponsorship tiers"],
  notification_template: ["message template", "message templates"],
};

/** "3 days, 1 track, 5 session formats" — the flash message after a create. */
export function summaryLine(summary: ProvisioningSummary): string {
  const parts = Object.entries(summary.counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => {
      const [one, many] = COUNT_LABELS[key] ?? [key, `${key}s`];
      return `${n} ${n === 1 ? one : many}`;
    });
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/* -------------------------------------------------------------------------- */
/* The entry point                                                             */
/* -------------------------------------------------------------------------- */

export interface ProvisionEventInput extends CreateEventInput {
  source?: ProvisioningSource;
  /** Required when `source` is `clone`. */
  clone_from_event_id?: string | null;
}

export async function provisionEvent(app: AppContext, input: ProvisionEventInput): Promise<{ event: Row; summary: ProvisioningSummary }> {
  const source: ProvisioningSource = input.source ?? "starter";
  if (source === "clone" && !input.clone_from_event_id) {
    throw new DomainError({
      code: "clone_source_required",
      message: "Choose the event to copy configuration from.",
      status: 422,
    });
  }
  const event = await createEvent(app, {
    ...input,
    // INV-02-15 — a clone lands private whatever the source was, and whatever
    // the form said. Enforced here rather than per-route: a half-built next
    // edition going public because one caller forgot is the failure this
    // prevents, and there is more than one caller.
    visibility: source === "clone" ? "private" : input.visibility,
  });
  const eventId = str(event.id);

  if (source === "empty") return { event, summary: EMPTY_SUMMARY("empty") };
  if (source === "clone") {
    const summary = await cloneEventConfiguration(app, str(input.clone_from_event_id), eventId);
    return { event: { ...event, cloned_from_event_id: summary.source_event_id }, summary };
  }
  return { event, summary: await applyStarterBlueprint(app, eventId) };
}

/* -------------------------------------------------------------------------- */
/* The starter blueprint                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything in `STARTER_BLUEPRINT`, written for one event. Idempotent enough
 * to be safe from the setup screen: an event that already has days, tracks or
 * formats keeps them, and only the empty parts are filled.
 */
export async function applyStarterBlueprint(app: AppContext, eventId: string): Promise<ProvisioningSummary> {
  const event = await eventRow(app, eventId);
  const timezone = str(event.timezone, "UTC");
  const mode = str(event.mode, "in_person") as EventMode;
  const counts: Record<string, number> = {};
  const bump = (label: string, by = 1) => {
    counts[label] = (counts[label] ?? 0) + by;
  };

  if ((await app.db.count("event_day", { event_id: eventId })) === 0) {
    for (const day of blueprintDays(str(event.starts_on), str(event.ends_on))) {
      await createEventDay(app, eventId, { date: day.date, label: day.label, sort_order: day.sort_order });
      bump("day");
    }
  }

  const trackIds: string[] = [];
  if ((await app.db.count("track", { event_id: eventId })) === 0) {
    const t = STARTER_BLUEPRINT.track;
    const row = await createTrack(app, eventId, {
      name: t.name,
      slug: t.slug,
      description: t.description,
      color: t.color,
      sort_order: 0,
    });
    trackIds.push(str(row.id));
    bump("track");
  }

  if ((await app.db.count("session_format", { event_id: eventId })) === 0) {
    for (const [i, f] of STARTER_BLUEPRINT.formats.entries()) {
      await createSessionFormat(app, eventId, {
        name: f.name,
        slug: f.slug,
        description: f.description,
        default_duration_minutes: f.default_duration_minutes,
        min_duration_minutes: f.min_duration_minutes ?? null,
        max_duration_minutes: f.max_duration_minutes ?? null,
        max_speakers: f.max_speakers,
        eligible_origins: f.eligible_origins,
        requires_review: f.requires_review,
        requires_recording_consent: f.requires_recording_consent,
        capacity_policy: f.capacity_policy,
        sort_order: i,
      });
      bump("session_format");
    }
  }

  // INV-02-11 asks for a room only when the event is not online, and a venue
  // for an online conference is a row nobody will ever correct.
  if (mode !== "online" && !(await app.db.first<Row>("venue", { event_id: eventId }))) {
    const venue = await upsertVenue(app, eventId, { name: STARTER_BLUEPRINT.venue.name, timezone });
    bump("venue");
    for (const [i, room] of STARTER_BLUEPRINT.venue.rooms.entries()) {
      await createRoom(app, str(venue.id), {
        name: room.name,
        capacity: room.capacity,
        av_capabilities: room.av_capabilities,
        default_track_id: i === 0 ? (trackIds[0] ?? null) : null,
        sort_order: i,
      });
      bump("room");
    }
  }

  if ((await app.db.count("rubric", { event_id: eventId })) === 0) {
    await createProgrammeScorecardRubric(app, eventId);
    await createSponsorComplianceRubric(app, eventId);
    bump("rubric", 2);
  }

  if ((await app.db.count("task_definition", { event_id: eventId })) === 0) {
    bump("task_definition", (await createDefaultTaskDefinitions(app, eventId)).length);
  }

  // Last, because the call's track and format options are synced from whatever
  // the event has at the moment it is created.
  if ((await app.db.count("call_for_proposals", { event_id: eventId })) === 0) {
    const window = starterCfpWindow({ now: app.now(), starts_on: str(event.starts_on), timezone });
    const cfp = await createCfp(app, eventId, {
      name: STARTER_BLUEPRINT.cfp.name,
      slug: STARTER_BLUEPRINT.cfp.slug,
      audience: "public",
      intro_markdown: STARTER_BLUEPRINT.cfp.intro_markdown,
      opens_at: window.opens_at,
      closes_at: window.closes_at,
    });
    // Published, not draft: a call whose form is still a draft cannot be
    // opened (INV-02-5), and the shipped template already satisfies INV-02-7.
    if (cfp.active_form_id) await publishForm(app, str(cfp.active_form_id));
    bump("cfp");
  }

  app.audit.record({
    action: "event.apply_blueprint",
    entity_type: "event",
    entity_id: eventId,
    after: { source: "starter", counts },
  });
  return { source: "starter", source_event_id: null, day_shift: 0, counts };
}

/* -------------------------------------------------------------------------- */
/* Cloning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Copy one event's configuration onto another (02, "Cloning an edition").
 *
 * Configuration only (INV-02-14): nothing here reads a proposal, a session, a
 * review or a person. What it does read is scoped to the organization by the
 * repository layer (INV-11-1), which is what makes "an event of the same
 * organization" (INV-02-15) true without a second check — a source in another
 * org is simply not found.
 */
export async function cloneEventConfiguration(app: AppContext, sourceEventId: string, targetEventId: string): Promise<ProvisioningSummary> {
  const source = await eventRow(app, sourceEventId);
  const target = await eventRow(app, targetEventId);
  if (sourceEventId === targetEventId) {
    throw new DomainError({ code: "clone_source_is_target", message: "An event cannot be cloned onto itself.", status: 422 });
  }
  const timezone = str(target.timezone, "UTC");
  const shift = calendarDaysBetween(str(source.starts_on), str(target.starts_on));
  const rebase = (instant: string | null) => (instant ? rebaseInstant(instant, timezone, shift) : null);
  const counts: Record<string, number> = {};
  const bump = (label: string, by = 1) => {
    if (by > 0) counts[label] = (counts[label] ?? 0) + by;
  };

  /* days — generated from the new event's own range, labels carried across --- */
  const sourceDays = await app.db.select<Row>("event_day", { event_id: sourceEventId }, { orderBy: "sort_order, date" });
  const labels = sourceDays.map((d) => strOrNull(d.label));
  for (const day of blueprintDays(str(target.starts_on), str(target.ends_on), labels)) {
    const carried = sourceDays[day.sort_order];
    await createEventDay(app, targetEventId, {
      date: day.date,
      label: day.label,
      sort_order: day.sort_order,
      is_public: carried ? bool(carried.is_public) : true,
    });
    bump("day");
  }

  /* tracks and formats — the id maps everything else is remapped through ---- */
  const trackIds = new Map<string, string>();
  for (const t of await app.db.select<Row>("track", { event_id: sourceEventId }, { orderBy: "sort_order, name" })) {
    const row = await createTrack(app, targetEventId, {
      name: str(t.name),
      slug: str(t.slug),
      description: strOrNull(t.description),
      color: strOrNull(t.color),
      sort_order: num(t.sort_order),
      target_session_count: t.target_session_count == null ? null : num(t.target_session_count),
      is_public: bool(t.is_public),
    });
    trackIds.set(str(t.id), str(row.id));
    bump("track");
  }

  const formatIds = new Map<string, string>();
  for (const f of await app.db.select<Row>("session_format", { event_id: sourceEventId }, { orderBy: "sort_order, name" })) {
    const row = await createSessionFormat(app, targetEventId, {
      name: str(f.name),
      slug: str(f.slug),
      description: strOrNull(f.description),
      default_duration_minutes: num(f.default_duration_minutes, 30),
      min_duration_minutes: f.min_duration_minutes == null ? null : num(f.min_duration_minutes),
      max_duration_minutes: f.max_duration_minutes == null ? null : num(f.max_duration_minutes),
      max_speakers: num(f.max_speakers, 1),
      eligible_origins: parseList<Origin>(f.eligible_origins, ["cfp"]),
      requires_review: bool(f.requires_review),
      requires_recording_consent: bool(f.requires_recording_consent),
      capacity_policy: str(f.capacity_policy, "open") as CapacityPolicy,
      sort_order: num(f.sort_order),
      is_public: bool(f.is_public),
    });
    formatIds.set(str(f.id), str(row.id));
    bump("session_format");
  }

  /* venue and rooms -------------------------------------------------------- */
  const sourceVenue = await app.db.first<Row>("venue", { event_id: sourceEventId });
  if (sourceVenue) {
    const venue = await upsertVenue(app, targetEventId, {
      name: str(sourceVenue.name),
      address: strOrNull(sourceVenue.address),
      map_url: strOrNull(sourceVenue.map_url),
      timezone: strOrNull(sourceVenue.timezone),
    });
    bump("venue");
    for (const r of await app.db.select<Row>("room", { venue_id: str(sourceVenue.id) }, { orderBy: "sort_order, name" })) {
      await createRoom(app, str(venue.id), {
        name: str(r.name),
        slug: str(r.slug),
        capacity: r.capacity == null ? null : num(r.capacity),
        floor: strOrNull(r.floor),
        av_capabilities: parseList<string>(r.av_capabilities, []),
        // INV-02-17's rule, applied to a room's home track.
        default_track_id: trackIds.get(str(r.default_track_id)) ?? null,
        sort_order: num(r.sort_order),
        is_public: bool(r.is_public),
      });
      bump("room");
    }
  }

  /* calls for proposals, their options and their form ---------------------- */
  for (const c of await app.db.select<Row>("call_for_proposals", { event_id: sourceEventId }, { orderBy: "created_at" })) {
    await cloneCfp(app, c, targetEventId, { rebase, trackIds, formatIds });
    bump("cfp");
  }

  /* the rest of the configuration surface ---------------------------------- */
  for (const r of await app.db.select<Row>("rubric", { event_id: sourceEventId }, { orderBy: "name" })) {
    await copyRubricToEvent(app, str(r.id), targetEventId);
    bump("rubric");
  }
  bump("task_definition", (await copyTaskDefinitionsToEvent(app, sourceEventId, targetEventId)).length);
  bump("sponsorship_tier", (await copyTiersToEvent(app, sourceEventId, targetEventId, formatIds)).length);
  bump("notification_template", (await copyTemplatesToEvent(app, sourceEventId, targetEventId)).length);

  // INV-02-15 — provenance, set last so it is only true of a clone that
  // finished. Nothing reads through it.
  await app.db.update("event", targetEventId, { cloned_from_event_id: sourceEventId, updated_at: app.now() });

  app.eventId = targetEventId;
  app.events.emit({
    type: "event.cloned",
    subject: { type: "event", id: targetEventId },
    event_id: targetEventId,
    data: {
      event_id: targetEventId,
      source_event_id: sourceEventId,
      day_shift: shift,
      copied: counts,
    },
  });
  app.audit.record({
    action: "event.clone",
    entity_type: "event",
    entity_id: targetEventId,
    after: { source_event_id: sourceEventId, day_shift: shift, counts },
  });
  return { source: "clone", source_event_id: sourceEventId, day_shift: shift, counts };
}

interface CloneMaps {
  rebase: (instant: string | null) => string | null;
  trackIds: Map<string, string>;
  formatIds: Map<string, string>;
}

/**
 * One call, its form and its narrowing options.
 *
 * The form is copied as the clone's **version 1** and published (INV-02-15):
 * `createCfp` seeds whatever template it is handed, so there is no throwaway
 * default version to retire. A source whose form was still a draft is copied as
 * a draft too — publishing it would assert a review the organizer never did.
 */
async function cloneCfp(app: AppContext, source: Row, targetEventId: string, maps: CloneMaps): Promise<Row> {
  const sourceId = str(source.id);
  const published = await loadPublishedForm(app, sourceId);
  const active = published ?? (source.active_form_id ? await loadFormSpec(app, str(source.active_form_id)) : null);

  const cfp = await createCfp(
    app,
    targetEventId,
    {
      name: str(source.name),
      slug: str(source.slug),
      audience: str(source.audience, "public") as CfpAudience,
      intro_markdown: strOrNull(source.intro_markdown),
      guidelines_url: strOrNull(source.guidelines_url),
      // INV-02-16 — the window moves with the event, not with the calendar.
      opens_at: str(maps.rebase(str(source.opens_at))),
      closes_at: str(maps.rebase(str(source.closes_at))),
      grace_period_minutes: num(source.grace_period_minutes),
      late_submission_policy: str(source.late_submission_policy, "reject") as LateSubmissionPolicy,
      max_proposals_per_person: source.max_proposals_per_person == null ? null : num(source.max_proposals_per_person),
      allow_edit_after_submit: bool(source.allow_edit_after_submit),
      withdraw_allowed_until: str(source.withdraw_allowed_until, "always") as WithdrawAllowedUntil,
      notify_on_submit: bool(source.notify_on_submit),
    },
    active ? formSpecAsTemplate(active) : undefined,
  );
  const cfpId = str(cfp.id);

  await cloneCfpOptions(app, sourceId, cfpId, "cfp_track_option", "track_id", maps.trackIds, maps.rebase);
  await cloneCfpOptions(app, sourceId, cfpId, "cfp_format_option", "session_format_id", maps.formatIds, maps.rebase);

  if (published && cfp.active_form_id) await publishForm(app, str(cfp.active_form_id));
  return cfp;
}

/**
 * INV-02-17 — a copied option references the clone's own track or format. An
 * option whose subject was not copied (an archived track, say) is dropped:
 * `createCfp` has already offered everything the new event has, and pointing
 * one of those rows at the source event would leak configuration across events.
 */
async function cloneCfpOptions(
  app: AppContext,
  sourceCfpId: string,
  targetCfpId: string,
  table: "cfp_track_option" | "cfp_format_option",
  column: "track_id" | "session_format_id",
  ids: Map<string, string>,
  rebase: (instant: string | null) => string | null,
): Promise<void> {
  const existing = await app.db.select<Row>(table, { cfp_id: targetCfpId });
  const bySubject = new Map(existing.map((o) => [str(o[column]), str(o.id)]));
  const patches = [];
  for (const o of await app.db.select<Row>(table, { cfp_id: sourceCfpId }, { orderBy: "sort_order" })) {
    const targetSubject = ids.get(str(o[column]));
    const optionId = targetSubject ? bySubject.get(targetSubject) : undefined;
    if (!optionId) continue;
    patches.push({
      id: optionId,
      is_available: bool(o.is_available),
      max_proposals_per_person: o.max_proposals_per_person == null ? null : num(o.max_proposals_per_person),
      closes_at_override: rebase(strOrNull(o.closes_at_override)),
      sort_order: num(o.sort_order),
    });
  }
  if (patches.length > 0) await updateCfpOptions(app, targetCfpId, table, patches);
}

function parseList<T>(value: unknown, fallback: T[]): T[] {
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* What can be cloned                                                          */
/* -------------------------------------------------------------------------- */

/** Every other event of the org, newest first — the "copy from" picker. */
export async function cloneCandidates(app: AppContext, exceptEventId?: string | null): Promise<Row[]> {
  const rows = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC, id DESC" });
  return rows.filter((e) => str(e.id) !== exceptEventId);
}

export async function requireCloneSource(app: AppContext, eventId: string): Promise<Row> {
  const row = await app.db.byId<Row>("event", eventId); // org-scoped: INV-11-1
  if (!row) throw notFound("Event", eventId);
  return row;
}
