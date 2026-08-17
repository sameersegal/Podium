/**
 * The console's list screens.
 *
 * Eight screens that are the same shape — read a `/v1` collection, show it as a
 * table, link each row at the thing it is — so they share a file and a helper
 * rather than eight near-identical modules. Anything with a real interaction of
 * its own (the agenda grid, the form builder, the proposal board, the
 * dashboard) has its own file, because that is where the differences are.
 *
 * What each one still owns: which columns matter, what an empty list should
 * say, and which actions belong on it. A generic table renderer that also
 * decided those would be a table renderer nobody could make read well.
 */

import { h, cx, redraw } from "../kit.js";
import { api, unwrap } from "../api.js";
import { can, canWrite, resource, reload, toast, reportError, openDrawer, closeDrawer } from "../store.js";
import { setChrome } from "../chrome.js";
import { badge, button, card, empty, field, formatDate, formatDateTime, humanise, notice, pageHead, pluralise, relativeDays, stat, stats } from "../ui.js";

/* -------------------------------------------------------------------------- */
/* Shared shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Load a collection and render it, or render why it could not be.
 *
 * The three states are always the same three — loading, failed, empty — and
 * getting any of them wrong is more visible than getting the happy path wrong:
 * a screen that shows nothing when a request failed reads as "there is nothing
 * here", which is a lie the reader will act on.
 */
function collection(key, load, render, options) {
  const o = options || {};
  const res = resource(key, load);
  if (res.error) {
    return card(
      h("div", null, notice(res.error.message, "err"), button("Try again", () => reload(key), { variant: "secondary" })),
      o.errorTitle || "Could not load this",
    );
  }
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));
  return render(res.data, res);
}

function table(headers, rows, emptyMessage) {
  if (!rows.length) return card(empty(emptyMessage));
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, headers.map((head, i) => h("th", { key: i, class: cx(typeof head === "object" && head.num && "num") }, typeof head === "object" ? head.label : head)))),
      h("tbody", null, rows),
    ),
  );
}

const dash = () => h("span", { class: "muted" }, "—");

/* -------------------------------------------------------------------------- */
/* /admin/events                                                               */
/* -------------------------------------------------------------------------- */

export function events() {
  setChrome({ section: "events", title: "Events" });
  return collection("events", () => api.get("/v1/events").then(unwrap), (list) =>
    h(
      "div",
      null,
      pageHead(
        "Events",
        "Every edition this organization runs.",
        canWrite("event.configure") ? h("a", { class: "btn", href: "/admin/events/new" }, "New event") : null,
      ),
      table(
        ["Event", "Status", "When", "Timezone", { label: "", num: false }],
        list.map((e) =>
          h(
            "tr",
            { key: e.id },
            h(
              "td",
              null,
              h("a", { href: "/admin/events/" + e.id }, h("strong", null, e.name)),
              e.tagline ? h("div", { class: "small muted" }, e.tagline) : null,
            ),
            h("td", null, badge(e.status)),
            h("td", null, formatDate(e.starts_on) + " – " + formatDate(e.ends_on)),
            h("td", null, h("span", { class: "mono small" }, e.timezone)),
            h("td", { class: "right" }, h("a", { class: "btn secondary small", href: "/admin/events/" + e.id }, "Open")),
          ),
        ),
        "No events yet.",
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/sessions                                             */
/* -------------------------------------------------------------------------- */

export function sessions(params) {
  setChrome({ section: "sessions", title: "Sessions" });
  const key = "sessions:" + params.eventId;
  return collection(
    key,
    () =>
      Promise.all([
        api.get("/v1/sessions?event_id=" + params.eventId + "&limit=200").then(unwrap),
        api.get("/v1/events/" + params.eventId + "/program-health").then(unwrap),
      ]).then(([list, health]) => ({ list, health })),
    ({ list, health }) => {
    const byStatus = countBy(list, (s) => s.status);
    return h(
      "div",
      null,
      pageHead("Sessions", "The programme — one record per accepted, invited or sponsored talk."),
      stats(
        ["pending_confirmation", "confirmed", "scheduled", "published"].map((s) =>
          stat(humanise(s), byStatus[s] || 0, null, { key: s, tone: s === "pending_confirmation" && byStatus[s] ? "warn" : null }),
        ),
      ),
      programHealth(health, params.eventId),
      table(
        ["Session", "Status", "Content", "Track", "Format", "Speakers"],
        list.map((s) =>
          h(
            "tr",
            { key: s.id },
            h(
              "td",
              null,
              h("a", { href: "/admin/sessions/" + s.id }, h("strong", null, s.title)),
              h("div", { class: "mono small muted" }, s.reference),
            ),
            h("td", null, badge(s.status)),
            h(
              "td",
              null,
              badge(s.content_status),
              // INV-06-9 — divergence from the decision snapshot is the normal
              // case after a copy-edit, so it is a marker and a filter, never a
              // notification (R14).
              s.content_diverged ? h("span", { class: "badge warn", title: "Edited since the decision was made" }, "edited") : null,
            ),
            h("td", null, s.track_name || dash()),
            h("td", null, s.format_name || dash()),
            h("td", null, s.speaker_names || dash()),
          ),
        ),
        "No sessions yet. They appear here once decisions are published.",
      ),
    );
    },
  );
}

/**
 * The programme-health tiles, which used to be the server-rendered board's and
 * would have been deleted with it (R30, second amendment).
 *
 * Four counts that each name something not ready, and the sponsor share. The
 * share is here rather than on the sponsorship screen because this is where
 * somebody would notice it is too high — "how much of my programme did I sell"
 * is a question about the programme.
 */
function programHealth(health, eventId) {
  if (!health) return null;
  const share = health.sponsor_session_share?.overall;
  const pct = share && share.total ? Math.round((share.sponsored / share.total) * 100) : 0;
  return card(
    h(
      "div",
      null,
      stats([
        stat("unconfirmed speakers", health.unconfirmed_speakers, null, { key: "us", tone: health.unconfirmed_speakers ? "warn" : null }),
        stat("onboarding at risk", health.onboarding_at_risk, "/admin/events/" + eventId + "/onboarding", {
          key: "oar",
          tone: health.onboarding_at_risk ? "warn" : null,
        }),
        stat("unplaced confirmed", health.unplaced_confirmed, "/admin/events/" + eventId + "/schedule", {
          key: "up",
          tone: health.unplaced_confirmed ? "warn" : null,
        }),
        // A session that cannot reach the public is the one worth an alarm:
        // every other number here is work in progress, this one is a hold.
        stat("unpublishable", health.unpublishable, null, { key: "unp", tone: health.unpublishable ? "err" : null }),
        stat("sponsor share", pct + "%", null, { key: "ss" }),
      ]),
      health.track_balance?.length
        ? table(
            ["Track", { label: "Confirmed", num: true }, { label: "Target", num: true }],
            health.track_balance.map((t) =>
              h(
                "tr",
                { key: t.track_id },
                h("td", null, t.name),
                h("td", { class: "num" }, t.confirmed),
                h("td", { class: "num" }, t.target == null ? dash() : t.target),
              ),
            ),
            "No tracks to balance.",
          )
        : null,
    ),
    "Programme health",
  );
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/cfps                                                 */
/* -------------------------------------------------------------------------- */

export function cfps(params) {
  setChrome({ section: "cfp", title: "Calls for proposals" });
  const key = "cfps:" + params.eventId;
  return collection(key, () => api.get("/v1/events/" + params.eventId + "/cfps").then(unwrap), (list) =>
    h(
      "div",
      null,
      pageHead(
        "Calls for proposals",
        "Each call has its own audience, window and submission form.",
        canWrite("cfp.configure")
          ? h("a", { class: "btn", href: "/admin/events/" + params.eventId + "/cfps/new" }, "New call")
          : null,
      ),
      list.length
        ? h(
            "div",
            { class: "console-grid two" },
            list.map((c) =>
              card(
                h(
                  "div",
                  null,
                  h("p", { class: "small muted" }, humanise(c.audience) + " · " + c.slug),
                  h(
                    "p",
                    null,
                    "Open " + formatDateTime(c.opens_at) + " → " + formatDateTime(c.closes_at),
                    c.status === "open" && c.closes_at
                      ? h("span", { class: "muted small" }, " · closes " + relativeDays(c.closes_at))
                      : null,
                  ),
                  h(
                    "p",
                    { class: "actions" },
                    h("a", { class: "btn secondary small", href: "/admin/cfps/" + c.id }, "Settings"),
                    h("a", { class: "btn secondary small", href: "/admin/cfps/" + c.id + "/form" }, "Form builder"),
                  ),
                ),
                c.name,
                { key: c.id },
              ),
            ),
          )
        : card(empty("No call for proposals yet. One is needed before anybody can submit.")),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/setup                                                */
/* -------------------------------------------------------------------------- */

/**
 * Days, tracks, formats and rooms — the configuration an event cannot go active
 * without. Four collections on one screen because they are read together: "does
 * this event have what it needs" is one question, not four.
 */
/**
 * One drawer, four collections.
 *
 * Days, tracks, formats and rooms differ only in their fields and their two
 * URLs — create is `POST` under the event, update and delete are `PATCH` and
 * `DELETE` on the record itself. Writing that four times produced four places
 * to get the reload key or the error handling subtly different, which is what
 * the server-rendered page this replaced actually suffered from.
 *
 * `spec.fields(draft, set)` returns the vnodes; everything else is here.
 */
function configEditor(spec) {
  const { title, createUrl, itemUrl, reloadKey, record, fields, initial } = spec;
  const draft = Object.assign({}, initial, record || {});
  let saving = false;

  const set = (name, transform) => (e) => {
    const raw = e && e.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e;
    draft[name] = transform ? transform(raw) : raw;
  };

  openDrawer(record ? "Edit " + title : "Add " + title, () => {
    const save = async () => {
      if (saving) return;
      saving = true;
      try {
        if (record) await api.patch(itemUrl(record.id), draft);
        else await api.post(createUrl, draft);
        toast("ok", record ? humanise(title) + " saved." : humanise(title) + " added.");
        closeDrawer();
        reload(reloadKey);
      } catch (err) {
        reportError(err);
      } finally {
        saving = false;
      }
    };

    return h(
      "div",
      { class: "stack" },
      fields(draft, set),
      h(
        "div",
        { class: "console-drawer-actions" },
        button(saving ? "Saving…" : "Save", save, { variant: "primary", disabled: saving, busy: saving }),
        button("Cancel", closeDrawer, { variant: "secondary" }),
      ),
    );
  });
}

/**
 * Delete behind a confirmation.
 *
 * `window.confirm` rather than a bespoke modal: this is the one destructive
 * action on the screen, the browser's dialog cannot be missed, and a modal
 * built for four call sites is a component nobody maintains. A room is
 * *archived* rather than removed (INV-02-10) and the wording says so, because
 * "Delete" over a room that then reappears in a published snapshot is a lie.
 */
async function removeConfig(label, itemUrl, id, reloadKey) {
  if (!window.confirm("Remove " + label + "? Anything already referring to it keeps working.")) return;
  try {
    await api.del(itemUrl(id));
    toast("ok", humanise(label) + " removed.");
    reload(reloadKey);
  } catch (err) {
    reportError(err);
  }
}

/** The two actions every configuration row carries, or nothing if read-only. */
function rowActions(canEdit, onEdit, onRemove) {
  if (!canEdit) return null;
  return h(
    "td",
    { class: "actions" },
    button("Edit", onEdit, { variant: "secondary", size: "small" }),
    button("Remove", onRemove, { variant: "secondary", size: "small" }),
  );
}

export function setup(params) {
  setChrome({ section: "setup", title: "Setup" });
  const key = "setup:" + params.eventId;
  const base = "/v1/events/" + params.eventId;
  const canEdit = canWrite("config.manage");
  return collection(
    key,
    () =>
      Promise.all([
        api.get(base + "/readiness"),
        api.get(base + "/days").then(unwrap),
        api.get(base + "/tracks").then(unwrap),
        api.get(base + "/formats").then(unwrap),
        api.get(base + "/rooms").then(unwrap),
      ]).then(([readiness, days, tracks, formats, rooms]) => ({ readiness, days, tracks, formats, rooms })),
    (d) =>
      h(
        "div",
        null,
        pageHead("Setup", "Days, tracks, formats and rooms. An event needs these before it can go active."),
        d.readiness.ready
          ? notice("Configuration is complete — this event can go active.", "ok")
          : notice("Before this event can go active it needs " + d.readiness.blockers.join(", ") + ".", "warn"),
        stats([
          stat("days", d.days.length, null, { key: "d" }),
          stat("tracks", d.tracks.length, null, { key: "t" }),
          stat("formats", d.formats.length, null, { key: "f" }),
          stat("rooms", d.rooms.length, null, { key: "r" }),
        ]),
        card(
          table(
            canEdit ? ["Day", "Date", "Public", ""] : ["Day", "Date", "Public"],
            d.days.map((x) =>
              h(
                "tr",
                { key: x.id },
                h("td", null, x.label || dash()),
                h("td", null, formatDate(x.date)),
                h("td", null, x.is_public ? "Yes" : "No"),
                rowActions(
                  canEdit,
                  () => editDay(params.eventId, key, x),
                  () => removeConfig("this day", (id) => "/v1/days/" + id, x.id, key),
                ),
              ),
            ),
            "No days yet.",
          ),
          "Days",
          { actions: canEdit ? button("Add a day", () => editDay(params.eventId, key, null), { variant: "secondary", size: "small" }) : null },
        ),
        card(
          table(
            canEdit ? ["Track", "Target sessions", "Public", ""] : ["Track", "Target sessions", "Public"],
            d.tracks.map((x) =>
              h(
                "tr",
                { key: x.id },
                h("td", null, h("span", { class: "swatch", style: { background: x.color || "#ccc" } }), x.name),
                h("td", null, x.target_session_count ?? dash()),
                h("td", null, x.is_public ? "Yes" : "No"),
                rowActions(
                  canEdit,
                  () => editTrack(params.eventId, key, x),
                  () => removeConfig("this track", (id) => "/v1/tracks/" + id, x.id, key),
                ),
              ),
            ),
            "No tracks yet.",
          ),
          "Tracks",
          { actions: canEdit ? button("Add a track", () => editTrack(params.eventId, key, null), { variant: "secondary", size: "small" }) : null },
        ),
        card(
          table(
            canEdit
              ? ["Format", { label: "Default length", num: true }, "Review", "Origins", ""]
              : ["Format", { label: "Default length", num: true }, "Review", "Origins"],
            d.formats.map((x) =>
              h(
                "tr",
                { key: x.id },
                h("td", null, x.name),
                h("td", { class: "num" }, (x.default_duration_minutes ?? 0) + " min"),
                h("td", null, x.requires_review ? "Reviewed" : h("span", { class: "muted" }, "Not reviewed")),
                h("td", null, (x.eligible_origins || []).map(humanise).join(", ") || dash()),
                rowActions(
                  canEdit,
                  () => editFormat(params.eventId, key, x),
                  () => removeConfig("this format", (id) => "/v1/formats/" + id, x.id, key),
                ),
              ),
            ),
            "No session formats yet.",
          ),
          "Session formats",
          { actions: canEdit ? button("Add a format", () => editFormat(params.eventId, key, null), { variant: "secondary", size: "small" }) : null },
        ),
        card(
          table(
            canEdit ? ["Room", { label: "Capacity", num: true }, "Public", ""] : ["Room", { label: "Capacity", num: true }, "Public"],
            d.rooms.map((x) =>
              h(
                "tr",
                { key: x.id },
                h("td", null, x.name),
                h("td", { class: "num" }, x.capacity ?? dash()),
                h("td", null, x.is_public ? "Yes" : "No"),
                rowActions(
                  canEdit,
                  () => editRoom(params.eventId, key, x, d.tracks),
                  // INV-02-10 — configuration a published snapshot may already
                  // name is archived, never deleted.
                  () => removeConfig("this room", (id) => "/v1/rooms/" + id, x.id, key),
                ),
              ),
            ),
            "No rooms yet.",
          ),
          "Rooms",
          { actions: canEdit ? button("Add a room", () => editRoom(params.eventId, key, null, d.tracks), { variant: "secondary", size: "small" }) : null },
        ),
      ),
  );
}

/* The four field sets. Each names only what the `/v1` route actually reads. */

function editDay(eventId, key, record) {
  configEditor({
    title: "day",
    createUrl: "/v1/events/" + eventId + "/days",
    itemUrl: (id) => "/v1/days/" + id,
    reloadKey: key,
    record: record && { id: record.id, date: record.date, label: record.label || "", is_public: record.is_public },
    initial: { date: "", label: "", is_public: true },
    fields: (draft, set) => [
      field({ name: "date", label: "Date", type: "date", required: true, value: draft.date, onchange: set("date") }),
      field({ name: "label", label: "Label", help: "“Day one”, “Workshops”. Optional.", value: draft.label, oninput: set("label") }),
      field({ name: "is_public", label: "Show on the public schedule", type: "checkbox", value: draft.is_public, onchange: set("is_public") }),
    ],
  });
}

function editTrack(eventId, key, record) {
  configEditor({
    title: "track",
    createUrl: "/v1/events/" + eventId + "/tracks",
    itemUrl: (id) => "/v1/tracks/" + id,
    reloadKey: key,
    record: record && {
      id: record.id,
      name: record.name,
      color: record.color || "",
      description: record.description || "",
      target_session_count: record.target_session_count ?? "",
      is_public: record.is_public,
    },
    initial: { name: "", color: "", description: "", target_session_count: "", is_public: true },
    fields: (draft, set) => [
      field({ name: "name", label: "Name", required: true, value: draft.name, oninput: set("name") }),
      field({ name: "color", label: "Colour", type: "color", value: draft.color || "#cccccc", onchange: set("color") }),
      field({ name: "description", label: "Description", type: "textarea", rows: 3, value: draft.description, oninput: set("description") }),
      field({
        name: "target_session_count",
        label: "Target sessions",
        type: "number",
        help: "What the programme is aiming for in this track. Optional.",
        value: draft.target_session_count,
        oninput: set("target_session_count", (v) => (v === "" ? null : Number(v))),
      }),
      field({ name: "is_public", label: "Show on the public schedule", type: "checkbox", value: draft.is_public, onchange: set("is_public") }),
    ],
  });
}

function editFormat(eventId, key, record) {
  configEditor({
    title: "format",
    createUrl: "/v1/events/" + eventId + "/formats",
    itemUrl: (id) => "/v1/formats/" + id,
    reloadKey: key,
    record: record && {
      id: record.id,
      name: record.name,
      default_duration_minutes: record.default_duration_minutes ?? 30,
      max_speakers: record.max_speakers ?? 1,
      eligible_origins: record.eligible_origins || [],
      requires_review: record.requires_review,
      is_public: record.is_public,
    },
    initial: { name: "", default_duration_minutes: 30, max_speakers: 1, eligible_origins: ["cfp"], requires_review: true, is_public: true },
    fields: (draft, set) => [
      field({ name: "name", label: "Name", required: true, value: draft.name, oninput: set("name") }),
      field({
        name: "default_duration_minutes",
        label: "Default length (minutes)",
        type: "number",
        required: true,
        value: draft.default_duration_minutes,
        oninput: set("default_duration_minutes", (v) => Number(v)),
      }),
      field({ name: "max_speakers", label: "Maximum speakers", type: "number", value: draft.max_speakers, oninput: set("max_speakers", (v) => Number(v)) }),
      field({
        name: "eligible_origins",
        label: "Where a session of this format may come from",
        type: "multi_select",
        help: "A format no origin can reach cannot be proposed or invited.",
        value: draft.eligible_origins,
        options: ["cfp", "invited", "sponsored", "internal"].map((v) => ({ value: v, label: humanise(v) })),
        onchange: set("eligible_origins"),
      }),
      field({ name: "requires_review", label: "Goes through review", type: "checkbox", value: draft.requires_review, onchange: set("requires_review") }),
      field({ name: "is_public", label: "Show on the public schedule", type: "checkbox", value: draft.is_public, onchange: set("is_public") }),
    ],
  });
}

function editRoom(eventId, key, record, tracks) {
  configEditor({
    title: "room",
    createUrl: "/v1/events/" + eventId + "/rooms",
    itemUrl: (id) => "/v1/rooms/" + id,
    reloadKey: key,
    record: record && {
      id: record.id,
      name: record.name,
      capacity: record.capacity ?? "",
      floor: record.floor || "",
      default_track_id: record.default_track_id || "",
      is_public: record.is_public,
    },
    initial: { name: "", capacity: "", floor: "", default_track_id: "", is_public: true },
    fields: (draft, set) => [
      field({ name: "name", label: "Name", required: true, value: draft.name, oninput: set("name") }),
      field({ name: "capacity", label: "Capacity", type: "number", value: draft.capacity, oninput: set("capacity", (v) => (v === "" ? null : Number(v))) }),
      field({ name: "floor", label: "Floor", value: draft.floor, oninput: set("floor") }),
      field({
        name: "default_track_id",
        label: "Default track",
        type: "select",
        help: "Used when placing a session that has no track of its own.",
        value: draft.default_track_id,
        options: [{ value: "", label: "None" }].concat((tracks || []).map((t) => ({ value: t.id, label: t.name }))),
        onchange: set("default_track_id"),
      }),
      field({ name: "is_public", label: "Show on the public schedule", type: "checkbox", value: draft.is_public, onchange: set("is_public") }),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/review                                               */
/* -------------------------------------------------------------------------- */

export function review(params) {
  setChrome({ section: "review", title: "Review" });
  if (!can("review.read")) return card(notice("You do not have access to this event's review rounds.", "warn"), "Review");
  const key = "rounds:" + params.eventId;
  return collection(key, () => api.get("/v1/rounds?event_id=" + params.eventId).then(unwrap), (list) =>
    h(
      "div",
      null,
      pageHead("Review", "Rounds, their reviewer pools, and how far each one has got."),
      list.length
        ? list.map((r) =>
            card(
              h(
                "div",
                null,
                h(
                  "p",
                  { class: "console-round-head" },
                  badge(r.status),
                  h("span", { class: "muted small" }, humanise(r.anonymity)),
                  h("span", { class: "muted small" }, r.target_reviews_per_proposal + " " + pluralise(r.target_reviews_per_proposal, "review") + " per proposal"),
                ),
                h(
                  "p",
                  { class: "small muted" },
                  "Open " + formatDateTime(r.opens_at) + " → " + formatDateTime(r.closes_at),
                  r.status === "open" && r.closes_at ? " · closes " + relativeDays(r.closes_at) : "",
                ),
                h(
                  "p",
                  { class: "actions" },
                  h("a", { class: "btn secondary small", href: "/admin/rounds/" + r.id }, "Round settings"),
                  h("a", { class: "btn secondary small", href: "/admin/rounds/" + r.id + "/assignments" }, "Assignments"),
                  h("a", { class: "btn secondary small", href: "/admin/rounds/" + r.id + "/progress" }, "Progress"),
                  h("a", { class: "btn secondary small", href: "/admin/rounds/" + r.id + "/results" }, "Results"),
                ),
              ),
              r.name,
              { key: r.id },
            ),
          )
        : card(empty("No review round yet. A round is what turns submitted proposals into reviewed ones.")),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/roster                                               */
/* -------------------------------------------------------------------------- */

export function roster(params) {
  setChrome({ section: "roster", title: "Speakers" });
  const key = "roster:" + params.eventId;
  const canRoster = canWrite("roster.manage");
  const canNote = canWrite("person_note.manage");
  return collection(key, () => api.get("/v1/participants?event_id=" + params.eventId + "&limit=200").then(unwrap), (list) => {
    const outstanding = list.reduce((n, p) => n + (p.task_completion?.outstanding || 0), 0);
    return h(
      "div",
      null,
      pageHead(
        "Speakers",
        "Everyone taking part in this event, and what each of them still owes.",
        canRoster ? button("Add someone", () => addParticipant(params.eventId, key), { variant: "secondary", size: "small" }) : null,
      ),
      stats([
        stat("participants", list.length, null, { key: "p" }),
        stat("outstanding tasks", outstanding, "/admin/events/" + params.eventId + "/onboarding", { key: "o", tone: outstanding ? "warn" : null }),
      ]),
      table(
        canRoster
          ? ["Person", "Kind", "Status", "Portal", { label: "Sessions", num: true }, "Tasks", ""]
          : ["Person", "Kind", "Status", "Portal", { label: "Sessions", num: true }, "Tasks"],
        list.map((p) =>
          h(
            "tr",
            { key: p.id },
            h(
              "td",
              null,
              h("a", { href: "/admin/people/" + p.person_id }, p.full_name),
              // `email` arrives null unless this reader is entitled to it; the
              // row says withheld rather than pretending there is none.
              h("div", { class: "small muted" }, p.email || h("span", { title: "Withheld — personal data" }, "•••")),
            ),
            h("td", null, humanise(p.kind)),
            h("td", null, badge(p.status)),
            h("td", null, humanise(p.portal_access)),
            h("td", { class: "num" }, p.session_count ?? 0),
            h(
              "td",
              null,
              p.task_completion
                ? h(
                    "span",
                    { class: cx(p.task_completion.outstanding && "urgency-warn") },
                    p.task_completion.completed + " done" + (p.task_completion.outstanding ? ", " + p.task_completion.outstanding + " outstanding" : ""),
                  )
                : dash(),
            ),
            canRoster
              ? h(
                  "td",
                  { class: "actions" },
                  // `allowed_status` is the server's, off the state diagram in
                  // 01 — an entry with nowhere to go offers nothing rather than
                  // a dropdown that 422s.
                  (p.allowed_status || []).length
                    ? button("Move", () => moveStatus(p, key), { variant: "secondary", size: "small" })
                    : null,
                  p.portal_access === "none"
                    ? button("Invite to portal", () => invitePortal(p, key), { variant: "secondary", size: "small" })
                    : null,
                  canNote ? button("Note", () => addNote(p, params.eventId), { variant: "secondary", size: "small" }) : null,
                )
              : null,
          ),
        ),
        "Nobody is taking part yet.",
      ),
    );
  });
}

function addParticipant(eventId, key) {
  const draft = { event_id: eventId, full_name: "", email: "", kind: "speaker", status: "invited" };
  let saving = false;
  openDrawer("Add someone to the roster", () => {
    const set = (name) => (e) => {
      draft[name] = e.target.value;
    };
    const save = async () => {
      if (saving) return;
      saving = true;
      try {
        await api.post("/v1/participants", draft);
        toast("ok", (draft.full_name || draft.email) + " is on the roster.");
        closeDrawer();
        reload(key);
      } catch (err) {
        reportError(err);
      } finally {
        saving = false;
      }
    };
    return h(
      "div",
      { class: "stack" },
      field({ name: "full_name", label: "Name", value: draft.full_name, oninput: set("full_name") }),
      field({
        name: "email",
        label: "Email",
        type: "email",
        required: true,
        help: "An existing person with this address is reused rather than duplicated (INV-01-11).",
        value: draft.email,
        oninput: set("email"),
      }),
      field({
        name: "kind",
        label: "Taking part as",
        type: "select",
        value: draft.kind,
        onchange: set("kind"),
        options: ["speaker", "sponsor_contact", "staff", "reviewer", "prospect", "other"].map((v) => ({ value: v, label: humanise(v) })),
      }),
      field({
        name: "status",
        label: "Starting status",
        type: "select",
        value: draft.status,
        onchange: set("status"),
        options: ["prospect", "invited", "confirmed"].map((v) => ({ value: v, label: humanise(v) })),
      }),
      h(
        "div",
        { class: "console-drawer-actions" },
        button(saving ? "Adding…" : "Add", save, { variant: "primary", disabled: saving, busy: saving }),
        button("Cancel", closeDrawer, { variant: "secondary" }),
      ),
    );
  });
}

function moveStatus(participant, key) {
  const allowed = participant.allowed_status || [];
  let to = allowed[0];
  let saving = false;
  openDrawer("Move " + participant.full_name, () => {
    const save = async () => {
      if (saving) return;
      saving = true;
      try {
        await api.patch("/v1/participants/" + participant.id, { status: to });
        toast("ok", participant.full_name + " is now " + humanise(to).toLowerCase() + ".");
        closeDrawer();
        reload(key);
      } catch (err) {
        reportError(err);
      } finally {
        saving = false;
      }
    };
    return h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, "Currently ", h("strong", null, humanise(participant.status)), "."),
      field({
        name: "status",
        label: "Move to",
        type: "radio",
        value: to,
        onchange: (e) => {
          to = e.target.value;
        },
        options: allowed.map((v) => ({ value: v, label: humanise(v) })),
      }),
      h(
        "div",
        { class: "console-drawer-actions" },
        button(saving ? "Moving…" : "Move", save, { variant: "primary", disabled: saving, busy: saving }),
        button("Cancel", closeDrawer, { variant: "secondary" }),
      ),
    );
  });
}

/**
 * INV-01-15 — the accept link is shown once, here, and is never re-readable.
 * The drawer stays open holding it, because closing it on success would throw
 * away the only copy of something the organizer may need to paste into a chat.
 */
function invitePortal(participant, key) {
  let state = { phase: "confirm", invitation: null };
  openDrawer("Invite " + participant.full_name + " to the portal", () => {
    if (state.phase === "done") {
      return h(
        "div",
        { class: "stack" },
        notice("Invitation sent to " + state.invitation.email + ".", "ok"),
        field({
          name: "accept_url",
          label: "Their link",
          help: "Shown once and never again — copy it now if you want to send it yourself.",
          value: state.invitation.accept_url,
          readonly: true,
        }),
        h("div", { class: "console-drawer-actions" }, button("Done", closeDrawer, { variant: "primary" })),
      );
    }
    const send = async () => {
      if (state.phase === "sending") return;
      state = { phase: "sending", invitation: null };
      redraw();
      try {
        const invitation = await api.post("/v1/participants/" + participant.id + "/portal-invite");
        state = { phase: "done", invitation };
        reload(key);
      } catch (err) {
        state = { phase: "confirm", invitation: null };
        reportError(err);
      }
      redraw();
    };
    return h(
      "div",
      { class: "stack" },
      h("p", null, "This emails them a link to their speaker portal, where they can see their sessions and what they still owe."),
      h(
        "div",
        { class: "console-drawer-actions" },
        button(state.phase === "sending" ? "Sending…" : "Send the invitation", send, {
          variant: "primary",
          disabled: state.phase === "sending",
          busy: state.phase === "sending",
        }),
        button("Cancel", closeDrawer, { variant: "secondary" }),
      ),
    );
  });
}

function addNote(participant, eventId) {
  let body = "";
  let saving = false;
  openDrawer("A note about " + participant.full_name, () => {
    const save = async () => {
      if (saving || !body.trim()) return;
      saving = true;
      try {
        await api.post("/v1/people/" + participant.person_id + "/notes", { body, event_id: eventId });
        toast("ok", "Note added.");
        closeDrawer();
      } catch (err) {
        reportError(err);
      } finally {
        saving = false;
      }
    };
    return h(
      "div",
      { class: "stack" },
      field({
        name: "body",
        label: "Note",
        type: "textarea",
        rows: 5,
        required: true,
        help: "Visible to staff on this event, never to the speaker.",
        value: body,
        oninput: (e) => {
          body = e.target.value;
        },
      }),
      h(
        "div",
        { class: "console-drawer-actions" },
        button(saving ? "Saving…" : "Add the note", save, { variant: "primary", disabled: saving, busy: saving }),
        button("Cancel", closeDrawer, { variant: "secondary" }),
      ),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/onboarding                                           */
/* -------------------------------------------------------------------------- */

export function onboarding(params) {
  setChrome({ section: "onboarding", title: "Onboarding" });
  const key = "tasks:" + params.eventId;
  return collection(key, () => api.get("/v1/tasks?event_id=" + params.eventId + "&limit=300").then(unwrap), (list) => {
    const open = list.filter((t) => !["completed", "waived", "cancelled"].includes(t.status));
    const blocking = open.filter((t) => t.is_blocking);
    const overdue = open.filter((t) => t.due_at && Date.parse(t.due_at) < Date.now());
    return h(
      "div",
      null,
      pageHead(
        "Onboarding",
        "What every speaker still owes, and which of it stops a session being published.",
        canWrite("task.define") ? h("a", { class: "btn secondary", href: "/admin/events/" + params.eventId + "/tasks" }, "Task definitions") : null,
      ),
      stats([
        stat("open", open.length, null, { key: "o" }),
        stat("blocking", blocking.length, null, { key: "b", tone: blocking.length ? "err" : null }),
        stat("overdue", overdue.length, null, { key: "d", tone: overdue.length ? "err" : null }),
        stat("done", list.length - open.length, null, { key: "c" }),
      ]),
      table(
        ["Task", "Session", "Assignee", "Status", "Due", ""],
        // Most urgent first: blocking, then overdue, then by deadline. A task
        // list ordered by insertion is a list nobody works from.
        [...open]
          .sort((a, b) => rank(a) - rank(b) || String(a.due_at || "9").localeCompare(String(b.due_at || "9")))
          .map((t) =>
            h(
              "tr",
              { key: t.id },
              h(
                "td",
                null,
                h("a", { href: "/admin/tasks/" + t.id }, t.title),
                t.is_blocking ? h("span", { class: "badge warn", title: "Stops the session being published" }, "blocking") : null,
              ),
              h("td", null, t.session_title ? h("a", { href: "/admin/sessions/" + t.session_id }, t.session_title) : dash()),
              h("td", null, t.assignee_name || dash()),
              h("td", null, badge(t.status)),
              h(
                "td",
                { class: cx(t.due_at && Date.parse(t.due_at) < Date.now() && "urgency-err") },
                t.due_at ? relativeDays(t.due_at) : dash(),
              ),
              h(
                "td",
                { class: "right" },
                canWrite("task.define") && t.status !== "completed"
                  ? button("Remind", () => remind(key, t), { variant: "secondary", size: "small" })
                  : null,
              ),
            ),
          ),
        "Nothing outstanding. Every task on this event is done, waived or cancelled.",
      ),
    );
  });
}

function rank(t) {
  if (t.is_blocking) return 0;
  if (t.due_at && Date.parse(t.due_at) < Date.now()) return 1;
  return 2;
}

async function remind(key, task) {
  try {
    await api.post("/v1/tasks/" + task.id + "/remind", {});
    toast("ok", "Reminder queued.");
    reload(key);
  } catch (err) {
    reportError(err);
  }
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/publications                                         */
/* -------------------------------------------------------------------------- */

export function publications(params) {
  setChrome({ section: "publish", title: "Publish" });
  const key = "publications:" + params.eventId;
  return collection(key, () => api.get("/v1/events/" + params.eventId + "/publications"), (payload) => {
    const pending = payload.pending_changes;
    const writable = canWrite("schedule.publish");
    return h(
      "div",
      null,
      pageHead(
        "Publish",
        "The public schedule is an immutable snapshot. Publishing takes a new one; rolling back restores an old one.",
        writable ? button("Publish now", () => publish(key, params.eventId), { disabled: pending.count === 0 }) : null,
      ),
      // R25 — auto-publish stays off, so the staleness indicator has to be loud
      // enough that manual publishing does not silently lag reality.
      pending.count > 0
        ? notice(
            pending.count +
              " unpublished " +
              pluralise(pending.count, "change") +
              " — the public schedule does not show " +
              (pending.count === 1 ? "it" : "them") +
              " yet.",
            "warn",
          )
        : notice("The public schedule matches the working copy.", "ok"),
      pending.count > 0
        ? card(
            h(
              "ul",
              { class: "console-list" },
              pending.changes.slice(0, 20).map((c, i) =>
                h("li", { key: i }, h("span", null, c.title || c.session_id), h("span", { class: "badge" }, humanise(c.kind))),
              ),
            ),
            "What would be published",
          )
        : null,
      table(
        [{ label: "Version", num: true }, "Status", "Published", { label: "Sessions", num: true }, "Note", ""],
        payload.data.map((p) =>
          h(
            "tr",
            { key: p.id },
            h("td", { class: "num" }, "v" + p.version),
            h("td", null, badge(p.status)),
            h("td", null, formatDateTime(p.published_at)),
            h("td", { class: "num" }, p.session_count),
            h("td", { class: "small muted" }, p.note || dash()),
            h(
              "td",
              { class: "right" },
              writable && p.status !== "live"
                ? button("Roll back to this", () => rollback(key, p), { variant: "secondary", size: "small" })
                : null,
            ),
          ),
        ),
        "Nothing published yet.",
      ),
    );
  });
}

async function publish(key, eventId) {
  try {
    const outcome = unwrap(await api.post("/v1/events/" + eventId + "/publications", {}));
    toast("ok", "Published v" + outcome.version + " — " + outcome.session_count + " " + pluralise(outcome.session_count, "session") + " live.");
    reload(key);
  } catch (err) {
    reportError(err);
  }
}

async function rollback(key, publication) {
  const reason = window.prompt("Why are you rolling back to v" + publication.version + "? It goes on the record.");
  if (!reason || !reason.trim()) return;
  try {
    await api.post("/v1/publications/" + publication.id + "/rollback", { reason: reason.trim() });
    toast("ok", "Rolled back. v" + publication.version + " is live again.");
    reload(key);
  } catch (err) {
    reportError(err);
  }
}

/* -------------------------------------------------------------------------- */

function countBy(list, of) {
  const out = {};
  for (const item of list) {
    const k = of(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
