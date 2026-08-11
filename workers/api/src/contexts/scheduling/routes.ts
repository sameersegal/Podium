/**
 * 08 — Scheduling & Publication: the admin screens.
 *
 * `/admin/events/:eventId/schedule`      the agenda builder — placement is
 *                                        form-only, no JavaScript required
 * `/admin/events/:eventId/schedule/slots` the optional `TimeSlot` grid
 * `/admin/events/:eventId/publications`  publish, roll back, diff
 * `/admin/events/:eventId/embeds`        `EmbedConfig` CRUD
 *
 * Every `Placement` write goes through the schedule Durable Object
 * (`runSerialised`) — INV-08-14 conflicts come back in the same response the
 * write produces; the redirect-and-reload this surface uses (like every other
 * admin screen here) re-reads that same, now-persisted, list.
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import {
  AUTO_PLACE_STRATEGY,
  CONFLICT_LABELS,
  EMBED_FORMAT,
  TIME_SLOT_KIND,
  WIDGET_LABELS,
  WIDGET_TYPE,
  type AutoPlaceStrategy,
  type EmbedFormat,
  type WidgetType,
} from "@podiumconf/domain/scheduling/types.js";
import { notFound, validationError } from "@podiumconf/domain/shared/errors.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { addMinutes, formatInZone, formatTimeInZone, zonedDateTimeToInstant } from "@podiumconf/domain/shared/time.js";
import { runSerialised } from "../../durable/schedule.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput, type Input } from "../../http/input.js";
import { htmlResponse, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, joinHtml, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, table } from "../../ui/layout.js";
import { adminPage, loadEvent, type EventRef } from "../../ui/shell.js";
import { acknowledgeConflict, listConflicts, type ConflictView } from "./conflicts.js";
import { listPublications as listPublicationRows, pendingChanges, publishSchedule, rollbackPublication } from "./publication.js";
import {
  createEmbed,
  embedSnippet,
  loadAgendaBuilder,
  loadAutoPlaceRun,
  loadDiff,
  loadEmbeds,
  loadPublications,
  proposeAutoPlace,
  setEmbedStatus,
  updateEmbed,
  type AgendaBuilderData,
  type AutoPlaceProposalView,
  type EmbedConfigRow,
  type PlacementView,
} from "./views.js";
import { layoutGrid, renderGrid, type GridItem } from "./widgets.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

function opts(values: readonly string[]): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: humanise(v) }));
}

async function loadEventFor(ctx: RequestContext, idOrSlug: string): Promise<EventRef> {
  const ref = await loadEvent(ctx, idOrSlug);
  if (!ref) throw notFound("Event", idOrSlug);
  ctx.eventId = ref.id;
  return ref;
}

/** The write's own returned conflicts (`commands.ts`'s `PlacementResult.conflicts`) — INV-08-14. */
function conflictSummary(conflicts: { severity: string; acknowledged_reason?: string | null }[]): string {
  const errors = conflicts.filter((c) => c.severity === "error" && !c.acknowledged_reason).length;
  const warnings = conflicts.filter((c) => c.severity === "warning" && !c.acknowledged_reason).length;
  if (errors === 0 && warnings === 0) return "No new conflicts.";
  const parts = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return `${parts.join(", ")} to review.`;
}

export function registerSchedulingRoutes(router: Router<RequestContext>): void {
  registerAgendaRoutes(router);
  registerSlotRoutes(router);
  registerPublicationRoutes(router);
  registerEmbedRoutes(router);
}

/* -------------------------------------------------------------------------- */
/* Agenda builder                                                             */
/* -------------------------------------------------------------------------- */

function registerAgendaRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/schedule", async (_req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireRead("schedule.place", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const data = await loadAgendaBuilder(app, ref.id);
    const canWrite = ctx.canWrite("schedule.place", { event_id: ref.id });

    const dayId = ctx.url.searchParams.get("day") ?? data.days[0]?.id ?? null;
    const runId = ctx.url.searchParams.get("run");
    const run = runId ? await loadAutoPlaceRun(app, runId).catch(() => null) : null;

    return htmlResponse(
      adminPage(
        ctx,
        {
          title: "Agenda",
          event: ref,
          active: "schedule",
          width: "wide",
          // Placement already serialises through SCHEDULE_DO, so two
          // organizers cannot corrupt the grid — but the loser of that race
          // finds out by having their move rejected. This tells them the grid
          // moved while they were reading it. Nudge, because every row here
          // has an inline move form in it.
          live: { mode: "nudge", subjects: ["placement", "session", "schedule"] },
        },
        html`${pageHead(
            "Agenda",
            "Place confirmed sessions into rooms and times. Conflicts are computed on every write and shown below — placing a broken schedule is allowed; publishing one is not.",
          )}
          ${data.pendingCount > 0
            ? html`<p class="notice warn">${data.pendingCount} change${data.pendingCount === 1 ? "" : "s"} not yet published. <a href="/admin/events/${ref.id}/publications">Review and publish</a>.</p>`
            : raw("")}
          ${daySwitcher(ref, data.days, dayId)}
          <div class="grid two">
            <div>
              ${dayId ? dayGrid(ref, data, dayId) : empty("Add an event day in setup before placing sessions.")}
              ${dayId ? placedList(ref, data, dayId, canWrite) : raw("")}
            </div>
            <div>
              ${canWrite ? autoPlaceSection(ref, run) : raw("")}
              ${conflictsSection(ref, data.conflicts, canWrite)}
              ${canWrite ? unplacedSection(ref, data) : raw("")}
            </div>
          </div>`,
      ),
    );
  });

  router.post("/admin/events/:eventId/schedule/place", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const data = await loadAgendaBuilder(ctx.app(ref.id), ref.id);
    const day = data.days.find((d) => d.id === input.str("event_day_id"));
    if (!day) throw validationError("Choose a day.", [{ field_key: "event_day_id", message: "Choose a day." }]);
    const session = data.unplaced.find((s) => s.id === input.str("session_id"));
    const startsAt = zonedDateTimeToInstant(day.date, input.str("start_time", "09:00"), ref.timezone);
    const endsAt = addMinutes(startsAt, session?.duration_minutes ?? 30);

    const result = await runSerialised(ctx.env, {
      command: {
        kind: "place",
        session_id: input.str("session_id"),
        room_id: input.str("room_id"),
        event_day_id: day.id,
        starts_at: startsAt,
        ends_at: endsAt,
      },
      orgId: ctx.orgId,
      eventId: ref.id,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    return redirect(`/admin/events/${ref.id}/schedule?day=${day.id}`, 303, OK(`Placed. ${conflictSummary(result.conflicts)}`));
  });

  router.post("/admin/events/:eventId/schedule/move", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const data = await loadAgendaBuilder(ctx.app(ref.id), ref.id);
    const day = data.days.find((d) => d.id === input.str("event_day_id"));
    if (!day) throw validationError("Choose a day.", [{ field_key: "event_day_id", message: "Choose a day." }]);
    const startsAt = zonedDateTimeToInstant(day.date, input.str("start_time", "09:00"), ref.timezone);
    const placement = [...data.placementsByDay.values()].flat().find((p) => p.id === input.str("placement_id"));
    const endsAt = addMinutes(startsAt, placement?.session.duration_minutes ?? 30);

    const result = await runSerialised(ctx.env, {
      command: {
        kind: "move",
        placement_id: input.str("placement_id"),
        room_id: input.str("room_id"),
        event_day_id: day.id,
        starts_at: startsAt,
        ends_at: endsAt,
      },
      orgId: ctx.orgId,
      eventId: ref.id,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    return redirect(`/admin/events/${ref.id}/schedule?day=${day.id}`, 303, OK(`Moved. ${conflictSummary(result.conflicts)}`));
  });

  router.post("/admin/events/:eventId/schedule/remove", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const day = input.optional("event_day_id");
    const result = await runSerialised(ctx.env, {
      command: { kind: "remove", placement_id: input.str("placement_id") },
      orgId: ctx.orgId,
      eventId: ref.id,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    return redirect(`/admin/events/${ref.id}/schedule${day ? `?day=${day}` : ""}`, 303, OK(`Removed from the schedule. ${conflictSummary(result.conflicts)}`));
  });

  router.post("/admin/events/:eventId/schedule/acknowledge", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    await acknowledgeConflict(app, input.str("conflict_id"), input.str("reason"));
    await app.flush();
    return redirect(`/admin/events/${ref.id}/schedule`, 303, OK("Conflict acknowledged. It stays visible, and it is on the record."));
  });

  router.post("/admin/events/:eventId/schedule/auto-place", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const strategy = (input.str("strategy", "greedy_fill") || "greedy_fill") as AutoPlaceStrategy;
    const trackIds = input.list("track_ids");
    const dayIds = input.list("event_day_ids");
    const runId = await proposeAutoPlace(app, ref.id, {
      strategy,
      scope: { track_ids: trackIds.length ? trackIds : undefined, event_day_ids: dayIds.length ? dayIds : undefined },
    });
    await app.flush();
    return redirect(`/admin/events/${ref.id}/schedule?run=${runId}`, 303, OK("Placements suggested. Review the rationale before accepting."));
  });

  router.post("/admin/events/:eventId/schedule/auto-place/apply", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const runId = input.str("run_id");
    const sessionIds = input.has("apply_all") ? undefined : [input.str("session_id")];
    const result = await runSerialised(ctx.env, {
      command: { kind: "apply_auto_place", run_id: runId, session_ids: sessionIds },
      orgId: ctx.orgId,
      eventId: ref.id,
      actor: ctx.actor,
      correlationId: ctx.correlationId,
    });
    const applied = result.applied_session_ids?.length ?? 0;
    const skipped = result.skipped_session_ids?.length ?? 0;
    const message = `${applied} placement${applied === 1 ? "" : "s"} accepted.${skipped ? ` ${skipped} skipped — already placed by the time this ran.` : ""} ${conflictSummary(result.conflicts)}`;
    return redirect(`/admin/events/${ref.id}/schedule?run=${runId}`, 303, OK(message));
  });
}

/* -------------------------------------------------------------------------- */
/* Agenda builder — rendering                                                 */
/* -------------------------------------------------------------------------- */

function daySwitcher(ref: EventRef, days: AgendaBuilderData["days"], activeDayId: string | null): SafeHtml {
  if (days.length === 0) return raw("");
  return html`<nav class="subnav" style="margin:0 0 1rem;border:1px solid var(--line);border-radius:var(--radius)">
    ${days.map(
      (d) => html`<a href="/admin/events/${ref.id}/schedule?day=${d.id}"${d.id === activeDayId ? raw(' aria-current="page"') : raw("")}>${d.label ?? d.date}</a>`,
    )}
  </nav>`;
}

function dayGrid(ref: EventRef, data: AgendaBuilderData, dayId: string): SafeHtml {
  const day = data.days.find((d) => d.id === dayId);
  if (!day) return raw("");
  const placements = data.placementsByDay.get(dayId) ?? [];
  if (placements.length === 0) return card(empty("Nothing placed on this day yet."), "Grid");

  const items: GridItem[] = placements.map((p) => ({ id: p.id, room_id: p.room_id, starts_at: p.starts_at, ends_at: p.ends_at }));
  const times = placements.flatMap((p) => [new Date(p.starts_at).getTime(), new Date(p.ends_at).getTime()]);
  const windowStart = new Date(Math.min(...times)).toISOString();
  const windowEnd = new Date(Math.max(...times)).toISOString();
  const layout = layoutGrid(items, data.rooms, windowStart, windowEnd, ref.timezone);
  const byId = new Map(placements.map((p) => [p.id, p]));

  return card(
    renderGrid(layout, (b) => {
      const p = byId.get(b.item.id)!;
      return html`<a href="#placement-${p.id}"><span class="t">${p.session.title}</span><br><span class="small muted">${p.room_name}</span></a>`;
    }),
    "Grid",
  );
}

function placedList(ref: EventRef, data: AgendaBuilderData, dayId: string, canWrite: boolean): SafeHtml {
  const placements = data.placementsByDay.get(dayId) ?? [];
  if (placements.length === 0) return raw("");
  const rows = placements.map((p) => placementRow(ref, data, p, canWrite));
  return card(table(["Session", "Room", "Time", "Status", ""], rows, "Nothing placed yet."), "Placed sessions");
}

function placementRow(ref: EventRef, data: AgendaBuilderData, p: PlacementView, canWrite: boolean): SafeHtml {
  const dayOptions = data.days.map((d) => ({ value: d.id, label: d.label ?? d.date }));
  const roomOptions = data.rooms.map((r) => ({ value: r.id, label: r.name }));
  return html`<tr id="placement-${p.id}">
    <td><strong>${p.session.title}</strong><br><span class="mono small muted">${p.session.reference}</span>${p.session.speaker_names.length ? html`<br><span class="small muted">${p.session.speaker_names.join(", ")}</span>` : raw("")}</td>
    <td>${p.room_name}</td>
    <td>${formatInZone(p.starts_at, ref.timezone)} – ${formatTimeInZone(p.ends_at, ref.timezone)}</td>
    <td>${badge(p.status, p.status === "locked" ? "warn" : "")}</td>
    <td class="right">
      ${canWrite
        ? html`<details class="row-edit"><summary>Move</summary>
            <form method="post" action="/admin/events/${ref.id}/schedule/move" class="inline-grid">
              <input type="hidden" name="placement_id" value="${p.id}">
              ${field({ name: "event_day_id", label: "Day", type: "select", required: true, value: p.event_day_id, options: dayOptions })}
              ${field({ name: "room_id", label: "Room", type: "select", required: true, value: p.room_id, options: roomOptions })}
              ${field({ name: "start_time", label: `Start (${ref.timezone})`, type: "time", required: true, value: formatTimeInZone(p.starts_at, ref.timezone) })}
              ${p.status === "locked" ? html`<p class="small warn" style="color:var(--warn)">This placement is locked — moving it is a deliberate override.</p>` : raw("")}
              <button type="submit" class="small">Move</button>
            </form>
            ${actionForm(`/admin/events/${ref.id}/schedule/remove`, "Remove from schedule", {
              className: "danger",
              confirm: p.status === "locked" ? "This placement is locked. Remove it anyway?" : "Remove this placement? The session returns to confirmed.",
              hidden: { placement_id: p.id, event_day_id: p.event_day_id },
            })}
          </details>`
        : raw("")}
    </td>
  </tr>`;
}

function unplacedSection(ref: EventRef, data: AgendaBuilderData): SafeHtml {
  if (data.unplaced.length === 0) return card(empty("Every confirmed session is on the schedule."), "Unplaced sessions");
  const dayOptions = data.days.map((d) => ({ value: d.id, label: d.label ?? d.date }));
  const roomOptions = data.rooms.map((r) => ({ value: r.id, label: r.name }));
  return card(
    html`${joinHtml(
      data.unplaced.map(
        (s) => html`<div class="row-edit" style="border-bottom:1px solid var(--line);padding:.6rem 0">
          <strong>${s.title}</strong> <span class="small muted">(${s.duration_minutes} min${s.track_name ? ` · ${s.track_name}` : ""}${s.format_name ? ` · ${s.format_name}` : ""})</span>
          ${s.speaker_names.length ? html`<br><span class="small muted">${s.speaker_names.join(", ")}</span>` : raw("")}
          <form method="post" action="/admin/events/${ref.id}/schedule/place" class="inline-grid">
            <input type="hidden" name="session_id" value="${s.id}">
            ${field({ name: "event_day_id", label: "Day", type: "select", required: true, options: dayOptions })}
            ${field({ name: "room_id", label: "Room", type: "select", required: true, options: roomOptions })}
            ${field({ name: "start_time", label: `Start (${ref.timezone})`, type: "time", required: true, value: "09:00" })}
            <button type="submit" class="small">Place</button>
          </form>
        </div>`,
      ),
    )}`,
    `Unplaced sessions (${data.unplaced.length})`,
  );
}

function conflictsSection(ref: EventRef, conflicts: ConflictView[], canWrite: boolean): SafeHtml {
  if (conflicts.length === 0) return card(html`<p class="notice ok">No conflicts. The schedule is clean.</p>`, "Conflicts");
  const rows = conflicts.map(
    (c) => html`<tr>
      <td>${badge(c.severity, c.severity === "error" ? "err" : "warn")}</td>
      <td><strong>${CONFLICT_LABELS[c.code] ?? c.code}</strong><br><span class="small muted">${c.message}</span></td>
      <td class="small">${c.session_ids.length} session${c.session_ids.length === 1 ? "" : "s"}</td>
      <td class="right">
        ${c.acknowledged_reason
          ? html`<span class="badge ok">Acknowledged</span><br><span class="small muted">${c.acknowledged_reason}</span>`
          : canWrite
            ? html`<details class="row-edit"><summary>Acknowledge</summary>
                <form method="post" action="/admin/events/${ref.id}/schedule/acknowledge" class="inline-grid">
                  <input type="hidden" name="conflict_id" value="${c.id}">
                  ${field({ name: "reason", label: "Why is this acceptable", required: true })}
                  <button type="submit" class="small">Acknowledge</button>
                </form>
              </details>`
            : raw("")}
      </td>
    </tr>`,
  );
  return card(table(["Severity", "Conflict", "Involves", ""], rows), `Conflicts (${conflicts.length})`);
}

function autoPlaceSection(ref: EventRef, run: AutoPlaceProposalView | null): SafeHtml {
  const form = html`<form method="post" action="/admin/events/${ref.id}/schedule/auto-place" class="inline-grid">
    ${field({ name: "strategy", label: "Strategy", type: "select", required: true, value: "greedy_fill", options: opts(AUTO_PLACE_STRATEGY) })}
    <button type="submit">Suggest placements</button>
  </form>`;

  if (!run) return card(form, "Assisted placement");

  const rows = run.proposed.map(
    (p) => html`<tr>
      <td><strong>${p.session.title}</strong></td>
      <td>${p.room_name}, ${p.day_label}<br><span class="small muted">${formatTimeInZone(p.starts_at, ref.timezone)}–${formatTimeInZone(p.ends_at, ref.timezone)}</span></td>
      <td class="small muted">${p.rationale}</td>
      <td class="right">
        <form method="post" action="/admin/events/${ref.id}/schedule/auto-place/apply" class="inline-form">
          <input type="hidden" name="run_id" value="${run.run_id}">
          <input type="hidden" name="session_id" value="${p.session_id}">
          <button type="submit" class="small">Accept</button>
        </form>
      </td>
    </tr>`,
  );

  return card(
    html`${form}
      <h3>Proposal — ${humanise(run.strategy)}</h3>
      ${run.conflicts_introduced.length
        ? html`<p class="notice warn">This proposal would introduce: ${run.conflicts_introduced.map((c) => `${CONFLICT_LABELS[c.code as keyof typeof CONFLICT_LABELS] ?? c.code} (${c.severity})`).join(", ")}.</p>`
        : raw("")}
      ${run.proposed.length > 0
        ? html`${table(["Session", "Where", "Why", ""], rows)}
            <form method="post" action="/admin/events/${ref.id}/schedule/auto-place/apply" class="inline-form">
              <input type="hidden" name="run_id" value="${run.run_id}">
              <input type="hidden" name="apply_all" value="1">
              <button type="submit">Accept all ${run.proposed.length}</button>
            </form>`
        : html`<p class="empty">Nothing left to accept from this suggestion.</p>`}
      ${run.unplaceable.length
        ? html`<h3>Could not be placed</h3>
            <ul>${run.unplaceable.map((u) => html`<li><strong>${u.session.title}</strong> — ${u.reason}</li>`)}</ul>`
        : raw("")}`,
    "Assisted placement",
  );
}

/* -------------------------------------------------------------------------- */
/* TimeSlot grid                                                              */
/* -------------------------------------------------------------------------- */

function readSlotInput(input: Input, timezone: string, date: string) {
  return {
    starts_at: zonedDateTimeToInstant(date, input.str("starts_at", "09:00"), timezone),
    ends_at: zonedDateTimeToInstant(date, input.str("ends_at", "09:30"), timezone),
    label: input.optional("label"),
    kind: (input.str("kind", "session") || "session") as (typeof TIME_SLOT_KIND)[number],
    room_ids: input.list("room_ids"),
    is_public: input.has("is_public") ? input.bool("is_public") : true,
    sort_order: input.int("sort_order", 0) ?? 0,
  };
}

function registerSlotRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/schedule/slots", async (_req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireRead("schedule.place", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("schedule.place", { event_id: ref.id });
    const [days, rooms, slots] = await Promise.all([
      app.db.select<Row>("event_day", { event_id: ref.id }, { orderBy: "sort_order, date" }),
      app.db.select<Row>("room", { event_id: ref.id }, { orderBy: "sort_order, name" }),
      app.db.select<Row>("time_slot", { event_id: ref.id }, { orderBy: "sort_order, starts_at" }),
    ]);
    const roomById = new Map(rooms.map((r) => [str(r.id), str(r.name)]));
    const dayOptions = days.map((d) => ({ value: str(d.id), label: strOrNull(d.label) ?? str(d.date) }));
    const roomOptions = rooms.map((r) => ({ value: str(r.id), label: str(r.name) }));

    const rows = slots.map((s) => {
      const day = days.find((d) => str(d.id) === str(s.event_day_id));
      const slotRooms = parseJson<string[]>(s.room_ids, []);
      return html`<tr>
        <td>${day ? (strOrNull(day.label) ?? str(day.date)) : "—"}</td>
        <td>${formatTimeInZone(str(s.starts_at), ref.timezone)}–${formatTimeInZone(str(s.ends_at), ref.timezone)}</td>
        <td>${str(s.label) || badge(str(s.kind))}</td>
        <td>${slotRooms.length ? slotRooms.map((id) => roomById.get(id) ?? id).join(", ") : html`<span class="muted">all rooms</span>`}</td>
        <td>${bool(s.is_public) ? badge("public", "ok") : badge("staff only", "warn")}</td>
        <td class="right">
          ${canWrite
            ? actionForm(`/admin/events/${ref.id}/schedule/slots/${str(s.id)}`, "Delete", { className: "danger", confirm: "Delete this time slot?", hidden: { action: "delete" } })
            : raw("")}
        </td>
      </tr>`;
    });

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Time grid", event: ref, active: "schedule", width: "wide" },
        html`${pageHead("Time grid", "Optional. A strict grid is a convenience for placement and OUTSIDE_EVENT_HOURS checking — free placement works without one.")}
          ${card(table(["Day", "Time", "Label", "Rooms", "Visibility", ""], rows, "No time slots yet — placement is free-form until you add some."))}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/events/${ref.id}/schedule/slots" class="inline-grid">
                  ${field({ name: "event_day_id", label: "Day", type: "select", required: true, options: dayOptions })}
                  ${field({ name: "starts_at", label: `Starts (${ref.timezone})`, type: "time", required: true, value: "09:00" })}
                  ${field({ name: "ends_at", label: `Ends (${ref.timezone})`, type: "time", required: true, value: "09:30" })}
                  ${field({ name: "label", label: "Label", placeholder: "Morning block 1" })}
                  ${field({ name: "kind", label: "Kind", type: "select", required: true, value: "session", options: opts(TIME_SLOT_KIND) })}
                  ${field({ name: "room_ids", label: "Rooms", type: "multi_select", options: roomOptions, help: "Leave empty to apply to every room." })}
                  ${field({ name: "is_public", label: "On the public schedule", type: "checkbox", value: true })}
                  <button type="submit">Add slot</button>
                </form>`,
                "Add a slot",
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/schedule/slots", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const day = await app.db.byId<Row>("event_day", input.str("event_day_id"));
    if (!day) throw notFound("Event day", input.str("event_day_id"));
    const values = readSlotInput(input, ref.timezone, str(day.date));
    await app.db.insert("time_slot", {
      id: newId("TimeSlot"),
      event_day_id: str(day.id),
      event_id: ref.id,
      starts_at: values.starts_at,
      ends_at: values.ends_at,
      label: values.label,
      kind: values.kind,
      room_ids: JSON.stringify(values.room_ids),
      is_public: values.is_public ? 1 : 0,
      sort_order: values.sort_order,
    });
    await app.flush();
    return redirect(`/admin/events/${ref.id}/schedule/slots`, 303, OK("Time slot added."));
  });

  router.post("/admin/events/:eventId/schedule/slots/:slotId", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.place", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const slot = await app.db.byId<Row>("time_slot", params.slotId);
    if (!slot || str(slot.event_id) !== ref.id) throw notFound("Time slot", params.slotId);
    if (input.str("action") === "delete") {
      await app.db.hardDelete("time_slot", { id: params.slotId });
      await app.flush();
      return redirect(`/admin/events/${ref.id}/schedule/slots`, 303, OK("Time slot removed."));
    }
    const day = await app.db.byId<Row>("event_day", str(slot.event_day_id));
    const values = readSlotInput(input, ref.timezone, str(day?.date));
    await app.db.update("time_slot", params.slotId, {
      starts_at: values.starts_at,
      ends_at: values.ends_at,
      label: values.label,
      kind: values.kind,
      room_ids: JSON.stringify(values.room_ids),
      is_public: values.is_public ? 1 : 0,
      sort_order: values.sort_order,
    });
    await app.flush();
    return redirect(`/admin/events/${ref.id}/schedule/slots`, 303, OK("Time slot updated."));
  });
}

/* -------------------------------------------------------------------------- */
/* Publications                                                               */
/* -------------------------------------------------------------------------- */

function diffLine(d: Row): SafeHtml {
  const before = parseJson<Record<string, unknown> | null>(d.before, null);
  const after = parseJson<Record<string, unknown> | null>(d.after, null);
  const describe = (v: Record<string, unknown> | null) => (v ? Object.entries(v).map(([k, val]) => `${k}: ${val}`).join(", ") : "—");
  return html`<li><strong>${humanise(str(d.change_type))}</strong> — <span class="mono small">${str(d.session_id)}</span>
    ${before ? html`<br><span class="small muted">was: ${describe(before)}</span>` : raw("")}
    ${after ? html`<br><span class="small muted">now: ${describe(after)}</span>` : raw("")}
  </li>`;
}

function registerPublicationRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/publications", async (_req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireRead("schedule.publish", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("schedule.publish", { event_id: ref.id });
    const [publications, pending, conflicts] = await Promise.all([
      loadPublications(app, ref.id),
      pendingChanges(app, ref.id),
      listConflicts(app, ref.id),
    ]);
    const errorConflicts = conflicts.filter((c) => c.severity === "error" && !c.acknowledged_reason);

    const rows: SafeHtml[] = [];
    for (const p of publications) {
      const diff = await loadDiff(app, p.id);
      rows.push(html`<tr>
        <td><strong>v${p.version}</strong></td>
        <td>${badge(p.status, p.status === "live" ? "ok" : p.status === "rolled_back" ? "err" : "")}</td>
        <td>${formatInZone(p.published_at, ref.timezone)}</td>
        <td>${p.session_count}</td>
        <td class="mono small">${p.content_etag}</td>
        <td class="small">${p.note ?? "—"}${p.override_reasons ? html`<br><span class="small" style="color:var(--warn)">Published with ${Object.keys(p.override_reasons).length} override${Object.keys(p.override_reasons).length === 1 ? "" : "s"}.</span>` : raw("")}</td>
        <td class="right">
          ${diff.length
            ? html`<details class="row-edit"><summary>${diff.length} change${diff.length === 1 ? "" : "s"}</summary><ul class="small">${diff.map(diffLine)}</ul></details>`
            : html`<span class="small muted">first publish</span>`}
          ${canWrite && p.status !== "live"
            ? actionForm(`/admin/publications/${p.id}/rollback`, "Roll back to this version", { confirm: `Make v${p.version} live again?` })
            : raw("")}
        </td>
      </tr>`);
    }

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Publish", event: ref, active: "publish", width: "wide" },
        html`${pageHead(
            "Publish",
            "The published schedule is an immutable snapshot the embed and ICS feed read from — organizers keep working; the public page only changes here.",
          )}
          ${pending.count > 0
            ? html`<p class="notice warn"><strong>${pending.count} change${pending.count === 1 ? "" : "s"}</strong> not yet published: ${Object.entries(pending.by_kind).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${humanise(k)}`).join(", ")}.</p>`
            : html`<p class="notice ok">The published schedule matches the working schedule.</p>`}
          ${canWrite
            ? card(
                html`${pending.changes.length
                    ? html`<ul class="small">${pending.changes.map((c) => html`<li><strong>${humanise(c.kind)}</strong> — ${c.title}: ${c.detail}</li>`)}</ul>`
                    : raw("")}
                  ${errorConflicts.length
                    ? html`<p class="notice err">${errorConflicts.length} unresolved error-severity conflict${errorConflicts.length === 1 ? "" : "s"} will block affected sessions from publishing unless overridden below.</p>
                        <details><summary>Override and publish anyway</summary>
                          <form method="post" action="/admin/events/${ref.id}/publications" class="inline-grid">
                            ${errorConflicts.map((c) => field({ name: `override_reason.${c.session_ids[0]}`, label: `Why override "${CONFLICT_LABELS[c.code] ?? c.code}" on ${c.session_ids[0]}`, placeholder: "e.g. Known clash, accepted by the chairs." }))}
                            ${field({ name: "note", label: "Note", placeholder: "What changed" })}
                            <button type="submit">Publish with overrides</button>
                          </form>
                        </details>`
                    : html`<form method="post" action="/admin/events/${ref.id}/publications" class="inline-grid">
                        ${field({ name: "note", label: "Note", placeholder: "Added two lightning talks, moved the keynote" })}
                        <button type="submit">Publish now</button>
                      </form>`}`,
                "Publish now",
              )
            : raw("")}
          ${table(["Version", "Status", "Published", "Sessions", "Etag", "Note", ""], rows, "Nothing published yet.")}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/publications", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.publish", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const overrideReasons: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.all())) {
      if (key.startsWith("override_reason.") && typeof value === "string" && value.trim()) {
        overrideReasons[key.slice("override_reason.".length)] = value.trim();
      }
    }
    const outcome = await publishSchedule(app, ref.id, {
      note: input.optional("note"),
      override_reasons: Object.keys(overrideReasons).length ? overrideReasons : undefined,
    });
    // `schedule.published` and `schedule.changed` are the whole point of this
    // command: they invalidate the embed cache, tell affected speakers their
    // talk moved, and reach every subscribed webhook. Without the flush the
    // snapshot lands and nobody hears about it.
    await app.flush();
    return redirect(
      `/admin/events/${ref.id}/publications`,
      303,
      OK(`Published v${outcome.version} — ${outcome.session_count} sessions, ${outcome.diff.length} change${outcome.diff.length === 1 ? "" : "s"} from the previous version.${outcome.skipped.length ? ` ${outcome.skipped.length} session(s) held back — not publishable yet.` : ""}`),
    );
  });

  router.post("/admin/publications/:publicationId/rollback", async (req, ctx, params) => {
    const app0 = ctx.app();
    const pub = await app0.db.byId<Row>("schedule_publication", params.publicationId);
    if (!pub) throw notFound("Publication", params.publicationId);
    ctx.eventId = str(pub.event_id);
    ctx.requireWrite("schedule.publish", { event_id: ctx.eventId });
    const input = await readInput(req);
    const app = ctx.app(ctx.eventId);
    const outcome = await rollbackPublication(app, ctx.eventId, params.publicationId, input.optional("reason"));
    await app.flush();
    return redirect(`/admin/events/${ctx.eventId}/publications`, 303, OK(`Rolled back to v${outcome.restored_version}.`));
  });
}

/* -------------------------------------------------------------------------- */
/* Embeds                                                                      */
/* -------------------------------------------------------------------------- */

function readEmbedInput(input: Input) {
  return {
    name: input.str("name"),
    widget_type: input.str("widget_type") as WidgetType,
    format: input.str("format") as EmbedFormat,
    allowed_origins: input.str("allowed_origins").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    filters: {
      event_day_ids: input.list("filter_event_day_ids"),
      track_ids: input.list("filter_track_ids"),
      format_ids: input.list("filter_format_ids"),
      sponsor_only: input.bool("filter_sponsor_only"),
    },
    theme: {
      mode: input.optional("theme_mode") ?? undefined,
      accent: input.optional("theme_accent") ?? undefined,
      density: input.optional("theme_density") ?? undefined,
      show_speakers: input.has("theme_show_speakers") ? input.bool("theme_show_speakers") : undefined,
      show_rooms: input.has("theme_show_rooms") ? input.bool("theme_show_rooms") : undefined,
    },
    show_unpublished: input.bool("show_unpublished"),
    cache_ttl_seconds: input.int("cache_ttl_seconds", 300) ?? 300,
    pinned_publication_id: input.optional("pinned_publication_id"),
  };
}

function registerEmbedRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/embeds", async (_req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    // Embeds control public origins (CORS) and can expose unpublished preview
    // data, so they are gated like publishing rather than like placement.
    ctx.requireRead("schedule.publish", { event_id: ref.id });
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("schedule.publish", { event_id: ref.id });
    const [embeds, tracks, days, formats, publications] = await Promise.all([
      loadEmbeds(app, ref.id),
      app.db.select<Row>("track", { event_id: ref.id }, { orderBy: "sort_order" }),
      app.db.select<Row>("event_day", { event_id: ref.id }, { orderBy: "sort_order" }),
      app.db.select<Row>("session_format", { event_id: ref.id }, { orderBy: "sort_order" }),
      listPublicationRows(app, ref.id),
    ]);
    const base = str(ctx.env.PUBLIC_BASE_URL) || ctx.url.origin;

    const widgetOptions = WIDGET_TYPE.map((w) => ({ value: w, label: WIDGET_LABELS[w] }));
    const formatOptions = EMBED_FORMAT.map((f) => ({ value: f, label: humanise(f) }));
    const trackOptions = tracks.map((t) => ({ value: str(t.id), label: str(t.name) }));
    const dayOptions = days.map((d) => ({ value: str(d.id), label: strOrNull(d.label) ?? str(d.date) }));
    const formatFilterOptions = formats.map((f) => ({ value: str(f.id), label: str(f.name) }));
    const pubOptions = publications.map((p) => ({ value: str(p.id), label: `v${num(p.version)}` }));

    const embedFields = (e: EmbedConfigRow | null) => html`
      ${field({ name: "name", label: "Name", required: true, value: e?.name ?? "", placeholder: "Main site — full schedule" })}
      ${field({ name: "widget_type", label: "Widget", type: "select", required: true, value: e?.widget_type, options: widgetOptions, help: "What is rendered." })}
      ${field({ name: "format", label: "Format", type: "select", required: true, value: e?.format, options: formatOptions, help: "How it is delivered. An impossible pair (e.g. speaker_gallery as ics) is rejected on save." })}
      ${field({ name: "allowed_origins", label: "Allowed origins", required: true, value: e?.allowed_origins.join(", ") ?? "", placeholder: "https://example.com, https://blog.example.com", help: "CORS and frame-ancestors allowlist. Exact origins, space or comma separated." })}
      ${field({ name: "filter_track_ids", label: "Limit to tracks", type: "multi_select", value: e?.filters.track_ids ?? [], options: trackOptions })}
      ${field({ name: "filter_event_day_ids", label: "Limit to days", type: "multi_select", value: e?.filters.event_day_ids ?? [], options: dayOptions })}
      ${field({ name: "filter_format_ids", label: "Limit to session formats", type: "multi_select", value: e?.filters.format_ids ?? [], options: formatFilterOptions })}
      ${field({ name: "filter_sponsor_only", label: "Sponsored sessions only", type: "checkbox", value: e?.filters.sponsor_only ?? false })}
      ${field({ name: "cache_ttl_seconds", label: "Cache TTL (seconds)", type: "number", value: e?.cache_ttl_seconds ?? 300, min: 0 })}
      ${field({ name: "pinned_publication_id", label: "Pin to a version", type: "select", value: e?.pinned_publication_id ?? "", options: pubOptions, help: "Leave blank to always serve the live version." })}
      ${field({ name: "show_unpublished", label: "Preview embed — shows unpublished working data, for staging sites", type: "checkbox", value: e?.show_unpublished ?? false })}
    `;

    const rows = embeds.map((e) => {
      const { url, snippet } = embedSnippet(e, base);
      return html`<tr>
        <td><strong>${e.name}</strong><br><span class="small muted">${WIDGET_LABELS[e.widget_type]}</span></td>
        <td>${badge(e.widget_type)} ${badge(e.format, "info")}</td>
        <td>${e.allowed_origins.length ? e.allowed_origins.join(", ") : html`<span class="muted">none — every origin refused</span>`}</td>
        <td>${e.status === "active" ? badge("active", "ok") : badge("disabled", "err")}${e.show_unpublished ? html`<br>${badge("preview", "warn")}` : raw("")}</td>
        <td class="small">
          <div class="copy-url"><input class="mono" readonly value="${url}" size="30" onfocus="this.select()"></div>
          <details><summary>Snippet</summary><textarea readonly rows="3" class="mono small" style="width:100%">${snippet}</textarea></details>
        </td>
        <td class="right">
          ${canWrite
            ? html`<details class="row-edit"><summary>Edit</summary>
                <form method="post" action="/admin/embeds/${e.id}" class="inline-grid">${embedFields(e)}<button type="submit" class="small">Save</button></form>
                ${actionForm(`/admin/embeds/${e.id}/status`, e.status === "active" ? "Disable" : "Enable", { hidden: { status: e.status === "active" ? "disabled" : "active" } })}
              </details>`
            : raw("")}
        </td>
      </tr>`;
    });

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Embeds", event: ref, active: "publish", width: "wide" },
        html`${pageHead("Embeds", "Each embed answers two questions independently: what to show, and how to deliver it. Every one reads the published schedule, never live data, unless marked preview.")}
          ${table(["Embed", "Type", "Allowed origins", "Status", "Public URL / snippet", ""], rows, "No embeds yet.")}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/events/${ref.id}/embeds" class="inline-grid">
                  ${embedFields(null)}
                  <button type="submit">Create embed</button>
                </form>`,
                "New embed",
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/embeds", async (req, ctx, params) => {
    const ref = await loadEventFor(ctx, params.eventId);
    ctx.requireWrite("schedule.publish", { event_id: ref.id });
    const input = await readInput(req);
    const app = ctx.app(ref.id);
    const values = readEmbedInput(input);
    await createEmbed(app, ref.id, values);
    await app.flush();
    return redirect(`/admin/events/${ref.id}/embeds`, 303, OK("Embed created."));
  });

  router.post("/admin/embeds/:embedId", async (req, ctx, params) => {
    const app0 = ctx.app();
    const row = await app0.db.byId<Row>("embed_config", params.embedId);
    if (!row) throw notFound("Embed config", params.embedId);
    ctx.eventId = str(row.event_id);
    ctx.requireWrite("schedule.publish", { event_id: ctx.eventId });
    const input = await readInput(req);
    const app = ctx.app(ctx.eventId);
    await updateEmbed(app, params.embedId, readEmbedInput(input));
    await app.flush();
    return redirect(`/admin/events/${ctx.eventId}/embeds`, 303, OK("Embed updated."));
  });

  router.post("/admin/embeds/:embedId/status", async (req, ctx, params) => {
    const app0 = ctx.app();
    const row = await app0.db.byId<Row>("embed_config", params.embedId);
    if (!row) throw notFound("Embed config", params.embedId);
    ctx.eventId = str(row.event_id);
    ctx.requireWrite("schedule.publish", { event_id: ctx.eventId });
    const input = await readInput(req);
    const status = input.str("status") === "active" ? "active" : "disabled";
    const app = ctx.app(ctx.eventId);
    await setEmbedStatus(app, params.embedId, status);
    await app.flush();
    return redirect(`/admin/events/${ctx.eventId}/embeds`, 303, OK(`Embed ${status}.`));
  });
}
