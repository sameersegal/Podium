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

import { h, cx } from "../kit.js";
import { api, unwrap } from "../api.js";
import { can, canWrite, resource, reload, toast, reportError } from "../store.js";
import { setChrome } from "../chrome.js";
import { badge, button, card, empty, formatDate, formatDateTime, humanise, notice, pageHead, pluralise, relativeDays, stat, stats } from "../ui.js";

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
  return collection(key, () => api.get("/v1/sessions?event_id=" + params.eventId + "&limit=200").then(unwrap), (list) => {
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
  });
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
export function setup(params) {
  setChrome({ section: "setup", title: "Setup" });
  const key = "setup:" + params.eventId;
  const base = "/v1/events/" + params.eventId;
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
        pageHead(
          "Setup",
          "Days, tracks, formats and rooms. An event needs these before it can go active.",
          h("a", { class: "btn secondary", href: "/admin/events/" + params.eventId + "/setup?nojs=1" }, "Edit configuration"),
        ),
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
            ["Day", "Date", "Public"],
            d.days.map((x) => h("tr", { key: x.id }, h("td", null, x.label || dash()), h("td", null, formatDate(x.date)), h("td", null, x.is_public ? "Yes" : "No"))),
            "No days yet.",
          ),
          "Days",
        ),
        card(
          table(
            ["Track", "Target sessions", "Public"],
            d.tracks.map((x) =>
              h(
                "tr",
                { key: x.id },
                h("td", null, h("span", { class: "swatch", style: { background: x.color || "#ccc" } }), x.name),
                h("td", null, x.target_session_count ?? dash()),
                h("td", null, x.is_public ? "Yes" : "No"),
              ),
            ),
            "No tracks yet.",
          ),
          "Tracks",
        ),
        card(
          table(
            ["Format", { label: "Default length", num: true }, "Review", "Origins"],
            d.formats.map((x) =>
              h(
                "tr",
                { key: x.id },
                h("td", null, x.name),
                h("td", { class: "num" }, (x.default_duration_minutes ?? 0) + " min"),
                h("td", null, x.requires_review ? "Reviewed" : h("span", { class: "muted" }, "Not reviewed")),
                h("td", null, (x.eligible_origins || []).map(humanise).join(", ") || dash()),
              ),
            ),
            "No session formats yet.",
          ),
          "Session formats",
        ),
        card(
          table(
            ["Room", { label: "Capacity", num: true }, "Public"],
            d.rooms.map((x) =>
              h("tr", { key: x.id }, h("td", null, x.name), h("td", { class: "num" }, x.capacity ?? dash()), h("td", null, x.is_public ? "Yes" : "No")),
            ),
            "No rooms yet.",
          ),
          "Rooms",
        ),
      ),
  );
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
  return collection(key, () => api.get("/v1/participants?event_id=" + params.eventId + "&limit=200").then(unwrap), (list) => {
    const outstanding = list.reduce((n, p) => n + (p.task_completion?.outstanding || 0), 0);
    return h(
      "div",
      null,
      pageHead("Speakers", "Everyone taking part in this event, and what each of them still owes."),
      stats([
        stat("participants", list.length, null, { key: "p" }),
        stat("outstanding tasks", outstanding, "/admin/events/" + params.eventId + "/onboarding", { key: "o", tone: outstanding ? "warn" : null }),
      ]),
      table(
        ["Person", "Kind", "Status", "Portal", { label: "Sessions", num: true }, "Tasks"],
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
          ),
        ),
        "Nobody is taking part yet.",
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
