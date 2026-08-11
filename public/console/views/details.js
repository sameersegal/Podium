/**
 * `/admin` and `/admin/proposals/:proposalId`.
 *
 * The console's entry point and the screen its busiest list links into. Both
 * are read-first: what an organizer does here is look, decide, and go
 * somewhere. The writes that belong to a proposal — requesting changes,
 * withdrawing, recording a decision — stay on the server-rendered screen for
 * now and are linked, not hidden; a form that round-trips `row_version` and
 * refuses a stale write (INV-11-14) is not worth reimplementing badly.
 */

import { h, cx } from "../kit.js";
import { api, unwrap } from "../api.js";
import { boot, can, resource, reload } from "../store.js";
import { setChrome } from "../chrome.js";
import { badge, button, card, empty, formatDate, formatDateTime, humanise, notice, pageHead, relativeDays, stat, stats } from "../ui.js";

const dash = () => h("span", { class: "muted" }, "—");

/* -------------------------------------------------------------------------- */
/* /admin — what needs me today                                                */
/* -------------------------------------------------------------------------- */

/**
 * The landing page. It reuses the event dashboard's read for the event in
 * context, because "what needs me today" is the same question `/admin/events/:id`
 * answers and two aggregates that disagree would be worse than one.
 */
export function adminHome() {
  setChrome({ section: "events", title: "Admin" });
  const ev = boot.event;

  if (!ev) {
    return h(
      "div",
      null,
      pageHead("Admin", "No event is in context yet."),
      card(
        h(
          "div",
          null,
          h("p", null, "Create an event to begin, or open one from the list."),
          h(
            "p",
            { class: "actions" },
            h("a", { class: "btn", href: "/admin/events/new" }, "New event"),
            h("a", { class: "btn secondary", href: "/admin/events" }, "All events"),
          ),
        ),
      ),
    );
  }

  const key = "dashboard:" + ev.id;
  const res = resource(key, () => api.get("/v1/events/" + ev.id + "/dashboard").then(unwrap));
  if (res.error) return card(notice(res.error.message, "err"), "Could not load your dashboard");
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));

  const d = res.data;
  const base = "/admin/events/" + ev.id;
  const attention = [
    { n: d.decisions.confirmation_overdue, label: "acceptances past their confirmation deadline", href: base + "/sessions", tone: "err" },
    { n: d.schedule.conflict_errors, label: "unresolved schedule conflicts", href: base + "/schedule", tone: "err" },
    { n: d.onboarding.blocking_open, label: "blocking tasks outstanding", href: base + "/onboarding", tone: "err" },
    { n: d.decisions.provisional, label: "decisions not yet published", href: base + "/decisions", tone: "warn" },
    { n: d.schedule.pending_publication_changes, label: "unpublished schedule changes", href: base + "/publications", tone: "info" },
  ].filter((x) => x.n > 0);

  return h(
    "div",
    null,
    pageHead(
      "Welcome back" + (boot.person ? ", " + firstName(boot.person) : ""),
      "You are looking at " + ev.name + ". Everything below links to where the thing can be done.",
      h("a", { class: "btn secondary", href: "/admin/events" }, "All events"),
    ),
    stats(
      d.funnel.map((s) => stat(s.label, s.count, s.href, { key: s.key })),
    ),
    attention.length
      ? card(
          h(
            "ul",
            { class: "console-queue" },
            attention.map((r, i) =>
              h(
                "li",
                { key: i, class: "console-queue-" + r.tone },
                h(
                  "a",
                  { href: r.href },
                  h("span", { class: "console-queue-n" }, String(r.n)),
                  h("span", { class: "console-queue-body" }, h("span", { class: "console-queue-label" }, r.label)),
                ),
              ),
            ),
          ),
          "Needs you",
        )
      : card(empty("Nothing is waiting on you."), "Needs you"),
    d.deadlines.length
      ? card(
          h(
            "ol",
            { class: "console-timeline" },
            d.deadlines.slice(0, 5).map((dl, i) =>
              h(
                "li",
                { key: i, class: "console-timeline-" + dl.kind },
                h("span", { class: "console-timeline-when" }, relativeDays(dl.at) || formatDate(dl.at)),
                dl.href ? h("a", { href: dl.href }, dl.label) : h("span", null, dl.label),
              ),
            ),
          ),
          "What is coming",
        )
      : null,
  );
}

function firstName(person) {
  return String(person.display_name || person.full_name || "").split(" ")[0];
}

/* -------------------------------------------------------------------------- */
/* /admin/proposals/:proposalId                                                */
/* -------------------------------------------------------------------------- */

export function proposalDetail(params) {
  setChrome({ section: "proposals", title: "Proposal" });
  if (!can("proposal.read_any")) return card(notice("You do not have access to this proposal.", "warn"), "Proposal");

  const key = "proposal:" + params.proposalId;
  const res = resource(key, () => api.get("/v1/proposals/" + params.proposalId));
  if (res.error) {
    return card(
      h("div", null, notice(res.error.message, "err"), button("Try again", () => reload(key), { variant: "secondary" })),
      "Could not load this proposal",
    );
  }
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));

  const p = res.data;
  const tz = p.event?.timezone || "UTC";

  return h(
    "div",
    null,
    h(
      "p",
      { class: "review-queuebar" },
      h("a", { href: "/admin/events/" + p.event_id + "/proposals" }, "← All proposals"),
      h("span", { class: "muted" }, p.reference),
      h("span", { class: "spacer" }),
      p.session_id ? h("a", { class: "btn secondary small", href: "/admin/sessions/" + p.session_id }, "Its session") : null,
      // The writes stay on the server-rendered screen, which already
      // round-trips `row_version` and refuses a stale edit (INV-11-14).
      h("a", { class: "btn secondary small", href: "/admin/proposals/" + p.id + "?nojs=1" }, "Edit"),
      can("decision.manage") ? h("a", { class: "btn secondary small", href: "/admin/proposals/" + p.id + "/decision" }, "Decision") : null,
    ),
    pageHead(
      p.title || "Untitled proposal",
      p.event ? p.event.name : "",
      h(
        "div",
        { class: "console-actions" },
        badge(p.status),
        p.is_late ? badge("late", "warn") : null,
        p.origin !== "cfp" ? badge(p.origin) : null,
      ),
    ),
    h(
      "div",
      { class: "review-split" },
      h(
        "div",
        { class: "review-reading" },
        card(
          h(
            "div",
            null,
            h("p", null, p.abstract || h("span", { class: "muted" }, "No abstract.")),
            p.description ? h("p", { class: "small" }, p.description) : null,
          ),
          "Abstract",
        ),
        answersCard(p),
      ),
      h(
        "div",
        { class: "review-scoring" },
        card(
          h(
            "dl",
            { class: "kv" },
            row("Reference", h("span", { class: "mono" }, p.reference)),
            row("Status", badge(p.status)),
            row("Submitted", p.submitted_at ? formatDateTime(p.submitted_at, tz) : dash()),
            row("Last activity", formatDateTime(p.last_activity_at, tz)),
            row("Level", p.audience_level ? humanise(p.audience_level) : dash()),
            row("Requested length", p.requested_duration_minutes ? p.requested_duration_minutes + " min" : dash()),
            row("Language", p.language || dash()),
            row("Keywords", p.keywords?.length ? p.keywords.join(", ") : dash()),
            row("Recording consent", humanise(p.recording_consent)),
            p.confirmation_deadline ? row("Confirm by", formatDateTime(p.confirmation_deadline, tz)) : null,
          ),
          "At a glance",
        ),
        speakersCard(p),
        p.coi_disclosure ? card(h("p", { class: "small" }, p.coi_disclosure), "Disclosed conflicts") : null,
      ),
    ),
  );
}

function row(label, value) {
  return [h("dt", { key: "dt-" + label }, label), h("dd", { key: "dd-" + label }, value)];
}

function speakersCard(p) {
  const live = (p.speakers || []).filter((s) => s.participation_status !== "removed");
  return card(
    live.length
      ? h(
          "ul",
          { class: "console-list" },
          live.map((s) =>
            h(
              "li",
              { key: s.person_id },
              h(
                "span",
                null,
                s.full_name ? h("a", { href: "/admin/people/" + s.person_id }, s.full_name) : h("span", { class: "muted" }, "(removed)"),
                // `email` is null unless this reader is entitled to it.
                s.email ? h("div", { class: "small muted" }, s.email) : null,
              ),
              badge(s.speaker_role),
              badge(s.participation_status),
            ),
          ),
        )
      : empty("Nobody named yet."),
    "Speakers",
  );
}

/**
 * The submitted answers, grouped by the step they were asked in — which is the
 * order the applicant answered them and the only order that reads as a
 * document rather than a dump.
 */
function answersCard(p) {
  const views = p.answer_views || [];
  if (!views.length) return card(empty("No answers recorded."), "Submission");
  const steps = [];
  for (const a of views) {
    const last = steps[steps.length - 1];
    if (last && last.key === a.step_key) last.items.push(a);
    else steps.push({ key: a.step_key, title: a.step_title, items: [a] });
  }
  return h(
    "div",
    null,
    steps.map((s) =>
      card(
        h(
          "dl",
          { class: "kv" },
          s.items.map((a) => [
            h("dt", { key: "dt-" + a.field_key }, a.label),
            h(
              "dd",
              { key: "dd-" + a.field_key, class: cx(a.type === "long_text" || a.type === "markdown" ? "prose" : "") },
              a.display ?? (a.value == null || a.value === "" ? h("span", { class: "muted" }, "Not answered") : String(a.value)),
            ),
          ]),
        ),
        s.title,
        { key: s.key },
      ),
    ),
  );
}
