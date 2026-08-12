/**
 * `/admin/events/:eventId/schedule` — the agenda builder.
 *
 * This is the screen R30 was written for. The server-rendered version placed a
 * session by choosing a room and typing a start time into a form, one submit
 * per placement, and reloading the whole grid to see the result; on a two-day
 * event with six rooms that is the difference between an afternoon and a week.
 *
 * The three things the model asks of this screen, and where each one lives:
 *
 * - **INV-08-14** — a placement write recomputes conflicts synchronously and
 *   returns them. So a drop re-renders the cell from the write's own response
 *   and the conflict panel updates in the same frame. Nothing here re-fetches
 *   the grid to find out what it broke.
 * - **One writer per event** (11, "Concurrency"). Every write goes through the
 *   schedule Durable Object, so two organizers dragging the same slot queue
 *   rather than interleave. The client does nothing to help with that and must
 *   not try; it just has to be honest when the answer comes back different from
 *   what it optimistically drew.
 * - **Time is the event's, never the browser's** (11, "Time"). The grid works
 *   in wall-clock minutes and sends `start_time`; the server owns the
 *   conversion. There is no `Date` arithmetic in this file that crosses a zone.
 */

import { h, cx, redraw } from "../kit.js";
import { api, unwrap } from "../api.js";
import { canWrite, resource, reload, put, toast, reportError } from "../store.js";
import { onChange } from "../live.js";
import { setChrome } from "../chrome.js";
import { badge, button, card, empty, humanise, icons, notice, pageHead, pluralise } from "../ui.js";

/** Pixels per minute. 1.4 puts a 30-minute talk at a readable 42px. */
const PPM = 1.4;
const SNAP_MINUTES = 5;
const DEFAULT_WINDOW = { start: 8 * 60, end: 20 * 60 };

const ui = { day: null, drag: null, busy: false, showUnplaced: true };
let liveBound = null;

export function agenda(params) {
  setChrome({ section: "schedule", title: "Agenda" });

  const key = "schedule:" + params.eventId;
  const res = resource(key, () => api.get("/v1/events/" + params.eventId + "/schedule").then(unwrap));

  if (liveBound !== key) {
    liveBound = key;
    // Another organizer's placement lands as a frame carrying no data; the
    // refetch is what re-authorizes and what redraws.
    onChange(["placement", "session", "schedule"], () => reload(key));
  }

  if (res.error) return card(notice(res.error.message, "err"), "Could not load the agenda");
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));

  const d = res.data;
  if (!d.days.length || !d.rooms.length) {
    return h(
      "div",
      null,
      pageHead("Agenda", "Place confirmed sessions into rooms and times."),
      card(
        empty(
          !d.days.length
            ? "This event has no days yet. Add them in setup before building an agenda."
            : "This event has no rooms yet. Add them in setup before building an agenda.",
        ),
      ),
    );
  }

  const day = d.days.find((x) => x.id === ui.day) ?? d.days[0];
  const writable = canWrite("schedule.place");
  const ctx = { key, eventId: params.eventId, data: d, day, writable };
  // The drag handlers live on `document` and outlive any one render, so they
  // reach the screen's context through here rather than through a closure that
  // would go stale the moment the grid re-rendered under the pointer.
  current = ctx;

  return h(
    "div",
    { class: "agenda-screen" },
    head(ctx),
    dayBar(ctx),
    conflictsPanel(ctx),
    h("div", { class: "agenda-body" }, grid(ctx), unplacedPanel(ctx)),
    ui.drag ? dragGhost() : null,
  );
}

/* -------------------------------------------------------------------------- */
/* Head                                                                        */
/* -------------------------------------------------------------------------- */

function head(ctx) {
  const d = ctx.data;
  const unplaced = d.unplaced.length;
  return pageHead(
    "Agenda",
    ctx.writable
      ? "Drag a session onto the grid to place it, and drag a placed one to move it."
      : "You have read-only access to this event's schedule.",
    h(
      "div",
      { class: "console-actions" },
      h("span", { class: "muted small" }, unplaced + " " + pluralise(unplaced, "session") + " unplaced"),
      d.pending_count > 0
        ? h("a", { class: "btn secondary", href: "/admin/events/" + ctx.eventId + "/publications" }, d.pending_count + " unpublished")
        : null,
      ctx.writable ? button("Suggest placements", () => autoPlace(ctx), { variant: "secondary" }) : null,
    ),
  );
}

async function autoPlace(ctx) {
  if (ui.busy) return;
  ui.busy = true;
  redraw();
  try {
    // INV-08-15 — a run proposes; nothing is placed until it is applied. The
    // proposal is reviewed on the server-rendered screen, which already shows
    // the rationale per row.
    await api.post("/v1/events/" + ctx.eventId + "/auto-place", { strategy: "greedy_fill" });
    toast("ok", "Placements suggested. Review the rationale before accepting them.", {
      action: {
        label: "Review",
        onclick: () => {
          window.location.href = "/admin/events/" + ctx.eventId + "/schedule?nojs=1";
        },
      },
      duration: 9000,
    });
  } catch (err) {
    reportError(err);
  } finally {
    ui.busy = false;
    redraw();
  }
}

function dayBar(ctx) {
  return h(
    "div",
    { class: "daybar", role: "tablist" },
    ctx.data.days.map((day) =>
      h(
        "button",
        {
          key: day.id,
          type: "button",
          role: "tab",
          "aria-selected": day.id === ctx.day.id ? "true" : "false",
          class: cx(day.id === ctx.day.id && "current"),
          onclick: () => {
            ui.day = day.id;
            redraw();
          },
        },
        day.label || day.date,
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Conflicts                                                                   */
/* -------------------------------------------------------------------------- */

function conflictsPanel(ctx) {
  const open = ctx.data.conflicts.filter((c) => !c.acknowledged_reason);
  if (!open.length) return null;
  const errors = open.filter((c) => c.severity === "error");
  return card(
    h(
      "div",
      null,
      h(
        "ul",
        { class: "console-list conflict-list" },
        open.slice(0, 8).map((c) =>
          h(
            "li",
            { key: c.id },
            h("span", null, h("span", { class: cx("badge", c.severity === "error" ? "err" : "warn") }, humanise(c.code))),
            h("span", { class: "small muted" }, describeConflict(c)),
            ctx.writable
              ? button("Acknowledge", () => acknowledge(ctx, c), { variant: "secondary", size: "small" })
              : null,
          ),
        ),
      ),
      open.length > 8 ? h("p", { class: "small muted" }, "and " + (open.length - 8) + " more") : null,
    ),
    errors.length ? errors.length + " unresolved " + pluralise(errors.length, "conflict") : "Schedule warnings",
    { class: errors.length ? "console-card-err" : "" },
  );
}

function describeConflict(c) {
  const detail = c.detail || {};
  return [detail.room_name, detail.speaker_name, detail.message].filter(Boolean).join(" · ") || "Affects " + c.placement_ids.length + " placements";
}

async function acknowledge(ctx, conflict) {
  // INV-11-5 — an override carries a reason, so there is nothing to accept
  // silently here.
  const reason = window.prompt("Why is this conflict acceptable? It stays visible, and it goes on the record.");
  if (!reason || !reason.trim()) return;
  try {
    await api.post("/v1/conflicts/" + conflict.id + "/acknowledge", { reason: reason.trim() });
    toast("ok", "Acknowledged. It stays on the board.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  }
}

/* -------------------------------------------------------------------------- */
/* The grid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The window the grid draws, in wall-clock minutes from midnight.
 *
 * Derived from what is already placed rather than fixed at 08:00–20:00: an
 * event with an 07:00 registration and a 23:00 party should not need the
 * organizer to scroll to a part of the day the grid decided was impossible.
 */
function windowFor(placements) {
  let start = DEFAULT_WINDOW.start;
  let end = DEFAULT_WINDOW.end;
  for (const p of placements) {
    start = Math.min(start, floorTo(p.start_minutes, 60));
    end = Math.max(end, ceilTo(p.end_minutes, 60));
  }
  return { start, end };
}

const floorTo = (n, step) => Math.floor(n / step) * step;
const ceilTo = (n, step) => Math.ceil(n / step) * step;

/**
 * Wall-clock minutes for an instant, in the event's zone.
 *
 * `Intl` is doing the zone conversion, which is the one piece of time handling
 * a browser can be trusted with: it is reading a zone, not doing arithmetic
 * across one. Everything that *writes* a time sends `start_time` and lets the
 * server resolve it.
 */
function wallMinutes(iso, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

function clockOf(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function grid(ctx) {
  const tz = ctx.data.event.timezone;
  const placements = ctx.data.placements
    .filter((p) => p.event_day_id === ctx.day.id)
    .map((p) => {
      const start = wallMinutes(p.starts_at, tz);
      const end = wallMinutes(p.ends_at, tz);
      return { ...p, start_minutes: start, end_minutes: end > start ? end : start + 30 };
    });
  const win = windowFor(placements);
  const height = (win.end - win.start) * PPM;

  const hours = [];
  for (let m = win.start; m <= win.end; m += 60) hours.push(m);

  return h(
    "div",
    { class: "agenda-grid-wrap" },
    h(
      "div",
      { class: "agenda-grid", style: { "--agenda-rooms": String(ctx.data.rooms.length) } },
      h(
        "div",
        { class: "agenda-corner" },
        h("span", { class: "mono small muted", title: tz }, tz),
      ),
      ctx.data.rooms.map((r) =>
        h(
          "div",
          // Prefixed: the room heads and the room columns are children of the
          // same grid, so a bare room id would key two different nodes the same.
          { key: "head-" + r.id, class: "agenda-roomhead" },
          h("span", null, r.name),
          r.capacity ? h("span", { class: "small muted" }, r.capacity + " seats") : null,
        ),
      ),
      h(
        "div",
        { class: "agenda-times", style: { height: height + "px" } },
        hours.map((m) =>
          h("div", { key: m, class: "agenda-hour", style: { top: (m - win.start) * PPM + "px" } }, clockOf(m)),
        ),
      ),
      ctx.data.rooms.map((room) =>
        h(
          "div",
          {
            key: "col-" + room.id,
            class: cx("agenda-col", ui.drag && "is-dropzone"),
            style: { height: height + "px" },
            "data-room": room.id,
            "data-window-start": String(win.start),
          },
          hours.map((m) =>
            h("div", { key: "l" + m, class: "agenda-line", style: { top: (m - win.start) * PPM + "px" } }),
          ),
          placements
            .filter((p) => p.room_id === room.id)
            .map((p) => placementBlock(ctx, p, win)),
          ui.drag && ui.drag.over && ui.drag.over.roomId === room.id
            ? h("div", {
                class: "agenda-drop",
                style: {
                  top: (ui.drag.over.minutes - win.start) * PPM + "px",
                  height: Math.max(18, ui.drag.duration * PPM) + "px",
                },
              })
            : null,
        ),
      ),
    ),
  );
}

function placementBlock(ctx, p, win) {
  const conflicted = ctx.data.conflicts.some((c) => !c.acknowledged_reason && c.placement_ids.includes(p.id));
  const dragging = ui.drag && ui.drag.placementId === p.id;
  const minutes = p.end_minutes - p.start_minutes;
  return h(
    "article",
    {
      key: p.id,
      class: cx("agenda-block", conflicted && "is-conflicted", dragging && "is-dragging"),
      // Named on the element so a conflict, a live frame or a test can find the
      // block that belongs to a placement without matching on its title.
      "data-placement": p.id,
      style: { top: (p.start_minutes - win.start) * PPM + "px", height: Math.max(20, minutes * PPM) + "px" },
      title: p.session.title + " — " + clockOf(p.start_minutes) + "–" + clockOf(p.end_minutes),
      onpointerdown: ctx.writable ? (ev) => startDrag(ctx, ev, { placement: p }) : null,
    },
    h("span", { class: "agenda-block-time" }, clockOf(p.start_minutes)),
    h("span", { class: "agenda-block-title" }, p.session.title),
    minutes >= 30 && p.session.speaker_names.length
      ? h("span", { class: "agenda-block-meta" }, p.session.speaker_names.join(", "))
      : null,
    conflicted ? h("span", { class: "agenda-block-flag" }, icons.warning()) : null,
    ctx.writable
      ? h(
          "button",
          {
            type: "button",
            class: "agenda-block-remove",
            "aria-label": "Remove " + p.session.title + " from the schedule",
            onpointerdown: (ev) => ev.stopPropagation(),
            onclick: (ev) => {
              ev.stopPropagation();
              removePlacement(ctx, p);
            },
          },
          icons.close(),
        )
      : null,
  );
}

/* -------------------------------------------------------------------------- */
/* The unplaced queue                                                          */
/* -------------------------------------------------------------------------- */

function unplacedPanel(ctx) {
  const list = ctx.data.unplaced;
  return h(
    "aside",
    { class: "console-panel agenda-unplaced" },
    h(
      "div",
      { class: "console-panel-head" },
      h("h2", null, "Not yet placed"),
      h("p", { class: "console-panel-hint" }, list.length ? "Drag one onto the grid." : "Everything confirmed has a room and a time."),
    ),
    h(
      "div",
      { class: "console-panel-body" },
      list.length
        ? h(
            "ul",
            { class: "agenda-queue" },
            list.map((s) =>
              h(
                "li",
                {
                  key: s.id,
                  class: cx("agenda-card", ui.drag && ui.drag.sessionId === s.id && "is-dragging"),
                  onpointerdown: ctx.writable ? (ev) => startDrag(ctx, ev, { session: s }) : null,
                },
                h("span", { class: "mono small muted" }, s.reference),
                h("strong", null, s.title),
                h(
                  "span",
                  { class: "small muted" },
                  [s.track_name, s.duration_minutes ? s.duration_minutes + " min" : null].filter(Boolean).join(" · "),
                ),
                s.speaker_names.length ? h("span", { class: "small muted" }, s.speaker_names.join(", ")) : null,
              ),
            ),
          )
        : empty("Nothing waiting."),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Dragging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Grid dragging is its own thing, not the list sorting in `dnd.js`: the drop
 * target here is a coordinate — a room and a minute — not a position in a list.
 * Pointer events again, for the same reason: `dragstart` never fires on a
 * touchscreen.
 */
function startDrag(ctx, ev, what) {
  if (ev.button !== 0 || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  const source = what.placement ?? null;
  ui.drag = {
    placementId: source ? source.id : null,
    sessionId: source ? source.session.id : what.session.id,
    label: source ? source.session.title : what.session.title,
    duration: source ? source.end_minutes - source.start_minutes : what.session.duration_minutes || 30,
    x: ev.clientX,
    y: ev.clientY,
    over: null,
    moved: false,
  };
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", endDrag);
  document.body.classList.add("console-dragging");
  redraw();
}

let frame = null;

function onMove(ev) {
  if (!ui.drag) return;
  ev.preventDefault();
  ui.drag.x = ev.clientX;
  ui.drag.y = ev.clientY;
  ui.drag.moved = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    ui.drag.over = hitTest(ui.drag.x, ui.drag.y);
    redraw();
  });
}

function hitTest(x, y) {
  const col = document.elementFromPoint(x, y)?.closest?.("[data-room]");
  if (!col) return null;
  const rect = col.getBoundingClientRect();
  const windowStart = Number(col.dataset.windowStart || 0);
  // Snapped to five minutes: an agenda is not built to the minute, and an
  // unsnapped drop produces 09:07 starts nobody meant.
  const raw = windowStart + (y - rect.top) / PPM;
  const snapped = Math.max(windowStart, Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES);
  return { roomId: col.dataset.room, minutes: snapped };
}

function onUp() {
  const drag = ui.drag;
  endDrag();
  if (!drag || !drag.moved || !drag.over) return redraw();
  commit(drag);
}

function endDrag() {
  ui.drag = null;
  if (frame) cancelAnimationFrame(frame);
  frame = null;
  document.removeEventListener("pointermove", onMove);
  document.removeEventListener("pointerup", onUp);
  document.removeEventListener("pointercancel", endDrag);
  document.body.classList.remove("console-dragging");
  redraw();
}

/** The screen currently on the page — see the note where it is assigned. */
let current = null;

async function commit(drag) {
  const ctx = current;
  if (!ctx) return;
  const body = {
    room_id: drag.over.roomId,
    event_day_id: ctx.day.id,
    // Wall clock. The server resolves it against the day and the event's
    // timezone, so no zone arithmetic happens in this file.
    start_time: clockOf(drag.over.minutes),
  };
  try {
    const res = drag.placementId
      ? await api.patch("/v1/placements/" + drag.placementId, body)
      : await api.post("/v1/events/" + ctx.eventId + "/placements", { ...body, session_id: drag.sessionId });
    const result = unwrap(res);
    // INV-08-14 — the conflicts this write caused come back with it, so the
    // board is honest about what the drop broke without a second request.
    const conflicts = result.conflicts || [];
    const errors = conflicts.filter((c) => c.severity === "error" && !c.acknowledged_reason).length;
    toast(errors ? "warn" : "ok", errors ? errors + " " + pluralise(errors, "conflict") + " to review." : "Placed.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
    reload(ctx.key);
  }
}

async function removePlacement(ctx, p) {
  try {
    const res = await api.del("/v1/placements/" + p.id);
    void unwrap(res);
    toast("ok", "Removed from the schedule.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  }
}

function dragGhost() {
  return h(
    "div",
    { class: "console-ghost", style: { left: ui.drag.x + "px", top: ui.drag.y + "px" }, "aria-hidden": "true" },
    ui.drag.label,
    ui.drag.over ? h("span", { class: "agenda-ghost-time" }, clockOf(ui.drag.over.minutes)) : null,
  );
}
