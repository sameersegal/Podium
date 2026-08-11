/**
 * `/admin/events/:eventId` — the event dashboard.
 *
 * What this replaced: five counts of configuration rows (days, tracks,
 * formats, rooms, calls) above a twenty-field settings form. Every number on it
 * was a number nobody acts on, and the form was the screen — an overview that
 * opens with a form is a form with a heading.
 *
 * What it is now: the four questions an organizer opens this screen to ask.
 *
 *   1. Where is the round?          the funnel, and submissions over time
 *   2. What is holding it up?       "Needs you", ordered by urgency
 *   3. Is review going to finish?   per-round progress and who is behind
 *   4. What is coming?              deadlines, nearest first
 *
 * Settings moved behind a button, into a drawer. It is still one click away
 * and it is no longer the first thing on the page.
 */

import { h, cx } from "../kit.js";
import { api, unwrap } from "../api.js";
import { canWrite, resource, reload, openDrawer, closeDrawer, toast, reportError } from "../store.js";
import { onChange } from "../live.js";
import { setChrome } from "../chrome.js";
import { badge, button, card, empty, field, formatDate, formatDateTime, humanise, notice, pageHead, pluralise, relativeDays, stat, stats } from "../ui.js";

let liveBound = null;

export function dashboard(params) {
  setChrome({ section: "overview", title: "Overview" });

  const key = "dashboard:" + params.eventId;
  const res = resource(key, () => api.get("/v1/events/" + params.eventId + "/dashboard").then(unwrap));

  // Every one of these numbers is derived from rows another organizer may be
  // writing right now, so the dashboard reloads on any change in the room
  // rather than aging quietly on a second monitor. The frame carries no data;
  // the refetch is what re-authorizes.
  if (liveBound !== key) {
    liveBound = key;
    onChange([], () => reload(key));
  }

  if (res.error) {
    return card(
      h(
        "div",
        null,
        notice(res.error.message, "err"),
        button("Try again", () => reload(key), { variant: "secondary" }),
      ),
      "Could not load the dashboard",
    );
  }
  if (!res.data) return skeleton();

  const d = res.data;
  return h(
    "div",
    { class: "console-dashboard" },
    head(d, params.eventId, res.loading),
    d.event.status === "draft" && !d.readiness.ready ? readinessCard(d, params.eventId) : null,
    funnel(d),
    h(
      "div",
      { class: "console-grid two" },
      needsYou(d, params.eventId),
      submissions(d, params.eventId),
    ),
    h(
      "div",
      { class: "console-grid two" },
      reviewProgress(d, params.eventId),
      h("div", null, scheduleCard(d, params.eventId), sponsorCard(d, params.eventId)),
    ),
    deadlines(d),
  );
}

/* -------------------------------------------------------------------------- */
/* Head                                                                        */
/* -------------------------------------------------------------------------- */

function head(d, eventId, loading) {
  const writable = canWrite("event.configure");
  return pageHead(
    d.event.name,
    "Everything on this screen is a link to the place the thing can be done.",
    h(
      "div",
      { class: "console-actions" },
      loading ? h("span", { class: "console-refreshing" }, "Refreshing…") : null,
      badge(d.event.status),
      writable ? button("Event settings", () => openSettings(eventId), { variant: "secondary" }) : null,
      writable && d.event.status === "draft"
        ? button("Activate event", () => activate(eventId), { disabled: !d.readiness.ready })
        : null,
    ),
  );
}

async function activate(eventId) {
  try {
    await api.post("/v1/events/" + eventId + "/activate");
    toast("ok", "This event is active.");
    reload("dashboard:" + eventId);
  } catch (err) {
    reportError(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Settings — behind a button                                                  */
/* -------------------------------------------------------------------------- */

function openSettings(eventId) {
  const key = "event:" + eventId;
  const draft = {};
  let saving = false;

  openDrawer(
    "Event settings",
    () => {
      const res = resource(key, () => api.get("/v1/events/" + eventId));
      if (!res.data) return h("p", { class: "muted" }, "Loading…");
      const ev = res.data;
      const value = (name) => (name in draft ? draft[name] : ev[name] == null ? "" : ev[name]);
      const set = (name) => (e) => {
        draft[name] = e.target.value;
      };

      const save = async () => {
        if (saving) return;
        saving = true;
        try {
          // INV-11-14 — the read's `row_version` goes back with the write, so
          // an edit made against a stale copy is refused rather than
          // overwriting the other organizer's.
          await api.patch("/v1/events/" + eventId, Object.assign({ row_version: ev.row_version }, draft));
          toast("ok", "Settings saved.");
          closeDrawer();
          reload("dashboard:" + eventId);
          reload(key);
        } catch (err) {
          if (err.code === "version_conflict") {
            toast("err", "Someone else changed this event while you had it open. Reopen the settings to see their version.");
            reload(key);
          } else {
            reportError(err);
          }
        } finally {
          saving = false;
        }
      };

      return h(
        "div",
        { class: "stack" },
        field({ name: "name", label: "Name", required: true, value: value("name"), oninput: set("name") }),
        field({ name: "edition", label: "Edition", value: value("edition"), oninput: set("edition") }),
        field({ name: "tagline", label: "Tagline", value: value("tagline"), oninput: set("tagline") }),
        field({ name: "description", label: "Description", type: "textarea", rows: 5, help: "Markdown.", value: value("description"), oninput: set("description") }),
        field({ name: "timezone", label: "Timezone", required: true, help: "Every time shown for this event is rendered here.", value: value("timezone"), oninput: set("timezone") }),
        h(
          "div",
          { class: "console-row-2" },
          field({ name: "starts_on", label: "First day", type: "date", required: true, value: value("starts_on"), onchange: set("starts_on") }),
          field({ name: "ends_on", label: "Last day", type: "date", required: true, value: value("ends_on"), onchange: set("ends_on") }),
        ),
        field({
          name: "mode",
          label: "Mode",
          type: "select",
          value: value("mode"),
          onchange: set("mode"),
          options: ["in_person", "online", "hybrid"].map((v) => ({ value: v, label: humanise(v) })),
        }),
        field({
          name: "visibility",
          label: "Visibility",
          type: "select",
          value: value("visibility"),
          onchange: set("visibility"),
          help: "A public call for proposals needs an active, public event.",
          options: ["private", "public"].map((v) => ({ value: v, label: humanise(v) })),
        }),
        field({ name: "website_url", label: "Website", type: "url", value: value("website_url"), oninput: set("website_url") }),
        h(
          "div",
          { class: "console-drawer-actions" },
          button("Save settings", save),
          button("Cancel", closeDrawer, { variant: "secondary" }),
        ),
      );
    },
    { wide: false },
  );
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

function readinessCard(d, eventId) {
  return card(
    h(
      "div",
      null,
      notice("Before this event can go active it needs " + d.readiness.blockers.join(", ") + ".", "warn"),
      h("p", null, h("a", { class: "btn secondary", href: "/admin/events/" + eventId + "/setup" }, "Go to setup")),
    ),
    "Readiness",
  );
}

/* -------------------------------------------------------------------------- */
/* The funnel                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Six steps, drawn to scale against the widest of them. The bar is the point:
 * "312 submitted, 41 accepted, 12 on the schedule" is a sentence about a
 * conference; six equal boxes with numbers in them is a table.
 */
function funnel(d) {
  const peak = Math.max(1, ...d.funnel.map((s) => s.count));
  return card(
    h(
      "ol",
      { class: "console-funnel" },
      d.funnel.map((step) =>
        h(
          "li",
          { key: step.key },
          h(
            "a",
            { href: step.href },
            h("span", { class: "console-funnel-n" }, String(step.count)),
            h(
              "span",
              { class: "console-funnel-track" },
              h("span", { class: "console-funnel-label" }, step.label),
              h("span", {
                class: "console-funnel-bar",
                style: { width: Math.round((step.count / peak) * 100) + "%" },
                "aria-hidden": "true",
              }),
            ),
          ),
        ),
      ),
    ),
    "This round",
  );
}

/* -------------------------------------------------------------------------- */
/* Needs you                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The queue, ordered by how much it hurts to leave it. A row with a count of
 * zero is dropped rather than greyed: an empty list is the honest way to say
 * nothing needs doing, and nine zeroes is a wall to read past on the days when
 * something does.
 */
function needsYou(d, eventId) {
  const base = "/admin/events/" + eventId;
  const rows = [
    {
      n: d.decisions.confirmation_overdue,
      tone: "err",
      label: "acceptances past their confirmation deadline",
      href: base + "/sessions",
      why: "The slot is held by someone who has not answered.",
    },
    {
      n: d.schedule.conflict_errors,
      tone: "err",
      label: "unresolved schedule conflicts",
      href: base + "/schedule",
      why: "A room or a speaker is double-booked.",
    },
    {
      n: d.onboarding.blocking_open,
      tone: "err",
      label: "blocking tasks outstanding",
      href: base + "/onboarding",
      why: "These stop a session being published.",
    },
    {
      n: d.decisions.provisional,
      tone: "warn",
      label: "provisional decisions not yet published",
      href: base + "/decisions",
      why: "Nobody has been told. Decisions stay private until you publish them.",
    },
    {
      n: d.onboarding.overdue,
      tone: "warn",
      label: "overdue speaker tasks",
      href: base + "/onboarding",
      why: null,
    },
    {
      n: d.onboarding.awaiting_review,
      tone: "warn",
      label: "task submissions waiting on you",
      href: base + "/onboarding",
      why: null,
    },
    {
      n: d.decisions.awaiting_confirmation,
      tone: "info",
      label: "sessions awaiting speaker confirmation",
      href: base + "/sessions",
      why: null,
    },
    {
      n: d.schedule.pending_publication_changes,
      tone: "info",
      label: "unpublished schedule changes",
      href: base + "/publications",
      why: "The public schedule does not show these yet.",
    },
    {
      n: d.schedule.conflict_warnings,
      tone: "info",
      label: "schedule warnings",
      href: base + "/schedule",
      why: null,
    },
    {
      n: d.sponsorship.holds_expiring,
      tone: "warn",
      label: "sponsor entitlements expiring within 14 days",
      href: base + "/sponsorships",
      why: "An unused hold is released when it expires (R22).",
    },
  ].filter((r) => r.n > 0);

  return card(
    rows.length
      ? h(
          "ul",
          { class: "console-queue" },
          rows.map((r, i) =>
            h(
              "li",
              { key: i, class: "console-queue-" + r.tone },
              h(
                "a",
                { href: r.href },
                h("span", { class: "console-queue-n" }, String(r.n)),
                h(
                  "span",
                  { class: "console-queue-body" },
                  h("span", { class: "console-queue-label" }, r.label),
                  r.why ? h("span", { class: "console-queue-why" }, r.why) : null,
                ),
              ),
            ),
          ),
        )
      : empty("Nothing is waiting on you."),
    "Needs you",
  );
}

/* -------------------------------------------------------------------------- */
/* Submissions                                                                 */
/* -------------------------------------------------------------------------- */

function submissions(d, eventId) {
  const series = d.submissions_by_day;
  const total = series.reduce((sum, p) => sum + p.count, 0);
  const peak = Math.max(1, ...series.map((p) => p.count));

  return card(
    h(
      "div",
      null,
      h(
        "p",
        { class: "lede" },
        total
          ? total + " " + pluralise(total, "submission") + " in the last 30 days."
          : "No submissions in the last 30 days.",
      ),
      series.length
        ? h(
            "div",
            { class: "console-chart", role: "img", "aria-label": "Submissions per day over the last 30 days" },
            series.map((p) =>
              h("span", {
                key: p.date,
                class: "console-chart-bar",
                style: { height: Math.max(4, Math.round((p.count / peak) * 100)) + "%" },
                title: p.count + " on " + formatDate(p.date),
              }),
            ),
          )
        : null,
      d.cfps.length
        ? h(
            "ul",
            { class: "console-list" },
            d.cfps.map((c) =>
              h(
                "li",
                { key: c.id },
                h("a", { href: "/admin/cfps/" + c.id }, c.name),
                badge(c.status),
                h(
                  "span",
                  { class: "muted small" },
                  c.submissions + " " + pluralise(c.submissions, "submission"),
                  c.status === "open" && c.closes_at ? " · closes " + relativeDays(c.closes_at) : "",
                ),
              ),
            ),
          )
        : empty("No calls for proposals yet."),
      h(
        "p",
        { class: "console-card-foot" },
        h("a", { href: "/admin/events/" + eventId + "/cfps" }, "All calls for proposals →"),
      ),
    ),
    "Submissions",
  );
}

/* -------------------------------------------------------------------------- */
/* Review                                                                      */
/* -------------------------------------------------------------------------- */

function reviewProgress(d, eventId) {
  if (!d.review.rounds.length) {
    return card(empty("No review rounds yet."), "Review");
  }
  return card(
    h(
      "div",
      null,
      d.review.rounds.map((r) => {
        const pct = r.assignments ? Math.round((r.submitted / r.assignments) * 100) : 0;
        return h(
          "div",
          { key: r.id, class: "console-round" },
          h(
            "div",
            { class: "console-round-head" },
            h("strong", null, r.name),
            badge(r.status),
            h("span", { class: "muted small" }, r.submitted + " of " + r.assignments + " reviews in"),
          ),
          h(
            "div",
            { class: "console-meter", role: "img", "aria-label": pct + "% of assignments submitted" },
            h("span", { style: { width: pct + "%" } }),
          ),
          r.below_quorum > 0
            ? h(
                "p",
                { class: "small" },
                h(
                  "a",
                  { href: "/admin/events/" + eventId + "/review" },
                  r.below_quorum +
                    " " +
                    pluralise(r.below_quorum, "proposal") +
                    " short of " +
                    r.target +
                    " " +
                    pluralise(r.target, "review"),
                ),
                h("span", { class: "muted" }, " — these cannot be decided yet."),
              )
            : null,
          r.declined > 0 ? h("p", { class: "small muted" }, r.declined + " assignments declined.") : null,
        );
      }),
      d.review.reviewers_behind.length
        ? h(
            "div",
            null,
            h("h4", null, "Reviewers with work outstanding"),
            h(
              "ul",
              { class: "console-list" },
              d.review.reviewers_behind.map((p) =>
                h(
                  "li",
                  { key: p.person_id },
                  h("span", null, p.name),
                  h(
                    "span",
                    { class: cx("muted small", p.overdue > 0 && "console-overdue") },
                    p.outstanding + " outstanding" + (p.overdue > 0 ? ", " + p.overdue + " overdue" : ""),
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        "p",
        { class: "console-card-foot" },
        h("a", { href: "/admin/events/" + eventId + "/review" }, "Open the review board →"),
      ),
    ),
    "Review",
  );
}

/* -------------------------------------------------------------------------- */
/* Schedule and sponsors                                                       */
/* -------------------------------------------------------------------------- */

function scheduleCard(d, eventId) {
  const placed = d.schedule.placed;
  const target = placed + d.schedule.unplaced;
  const pct = target ? Math.round((placed / target) * 100) : 0;
  return card(
    h(
      "div",
      null,
      h("p", { class: "lede" }, placed + " of " + target + " confirmed sessions have a room and a time."),
      h(
        "div",
        { class: "console-meter", role: "img", "aria-label": pct + "% of confirmed sessions placed" },
        h("span", { style: { width: pct + "%" } }),
      ),
      stats([
        stat("unplaced", d.schedule.unplaced, "/admin/events/" + eventId + "/schedule", { tone: d.schedule.unplaced ? "warn" : null }),
        stat("conflicts", d.schedule.conflict_errors, "/admin/events/" + eventId + "/schedule", { tone: d.schedule.conflict_errors ? "err" : null }),
        stat("unpublished", d.schedule.pending_publication_changes, "/admin/events/" + eventId + "/publications"),
      ]),
    ),
    "Schedule",
  );
}

function sponsorCard(d, eventId) {
  const s = d.sponsorship;
  if (!s.sponsorships) return null;
  const pct = s.entitlements_granted ? Math.round((s.entitlements_consumed / s.entitlements_granted) * 100) : 0;
  return card(
    h(
      "div",
      null,
      h(
        "p",
        { class: "lede" },
        s.entitlements_consumed +
          " of " +
          s.entitlements_granted +
          " sponsor speaking slots used, across " +
          s.sponsorships +
          " " +
          pluralise(s.sponsorships, "sponsorship") +
          ".",
      ),
      h(
        "div",
        { class: "console-meter", role: "img", "aria-label": pct + "% of sponsor speaking slots used" },
        h("span", { style: { width: Math.min(100, pct) + "%" } }),
      ),
      h(
        "p",
        { class: "console-card-foot" },
        h("a", { href: "/admin/events/" + eventId + "/sponsorships" }, "Sponsorships →"),
      ),
    ),
    "Sponsor entitlements",
  );
}

/* -------------------------------------------------------------------------- */
/* Deadlines                                                                   */
/* -------------------------------------------------------------------------- */

function deadlines(d) {
  if (!d.deadlines.length) return null;
  return card(
    h(
      "ol",
      { class: "console-timeline" },
      d.deadlines.map((dl, i) =>
        h(
          "li",
          { key: i, class: "console-timeline-" + dl.kind },
          h("span", { class: "console-timeline-when" }, relativeDays(dl.at) || formatDate(dl.at)),
          dl.href ? h("a", { href: dl.href }, dl.label) : h("span", null, dl.label),
          h("span", { class: "muted small" }, formatDateTime(dl.at, d.event.timezone)),
        ),
      ),
    ),
    "What is coming",
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

function skeleton() {
  return h(
    "div",
    { class: "console-skeleton", "aria-busy": "true", "aria-label": "Loading the dashboard" },
    [0, 1, 2, 3].map((i) => h("div", { key: i, class: "console-skeleton-card" })),
  );
}
