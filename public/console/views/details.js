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
import { badge, button, card, empty, formatDate, formatDateTime, humanise, notice, pageHead, plural, relativeDays, spell } from "../ui.js";

const dash = () => h("span", { class: "muted" }, "—");

/* -------------------------------------------------------------------------- */
/* /admin — what needs me today                                                */
/* -------------------------------------------------------------------------- */

/**
 * `/admin` — Today.
 *
 * The same screen `workers/api/src/surfaces/admin-home.ts` renders, over the
 * same read model, because the two share a URL: an organizer who lands here
 * with scripts blocked and one who lands here without must not find a different
 * product. Where the two disagree, the server-rendered one is right.
 *
 * It answers "what needs me today" rather than "how is the event going". A row
 * is a thing somebody does; a row with a count of zero is not drawn; and the
 * second line of each row says *why it matters* rather than restating the
 * count in words.
 */
export function adminHome() {
  setChrome({ section: "today", title: "Today" });
  const ev = boot.event;

  if (!ev) {
    return h(
      "div",
      null,
      pageHead(
        "There is no event yet",
        "Everything else in here hangs off one, so this is the only thing to do.",
        h("a", { class: "btn", href: "/admin/events/new" }, "Create an event"),
      ),
    );
  }

  // The Today subset — this screen draws none of the sections the event
  // dashboard adds, and asking for them costs roughly three times the
  // statements. Keyed apart from the full read so the two do not share a
  // cache entry and hand each other a half-filled payload.
  const key = "today:" + ev.id;
  const res = resource(key, () => api.get("/v1/events/" + ev.id + "/dashboard?sections=today").then(unwrap));
  if (res.error) return card(notice(res.error.message, "err"), "Could not load your dashboard");
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));

  const d = res.data;
  const base = "/admin/events/" + ev.id;
  const rows = needsYou(d, base);
  const total = rows.reduce((n, r) => n + r.count, 0);

  return h(
    "div",
    { class: "stack" },
    pageHead(
      total === 0 ? "Nothing needs you today" : spell(total) + " things need you today",
      total === 0
        ? "Everything that can be waiting on somebody is waiting on somebody else."
        : "Ordered by what stops the event if it slips. Everything else is quiet.",
      [
        h("a", { key: "x", class: "btn secondary", href: "/admin/exports" }, "Export"),
        h("a", { key: "p", class: "btn", href: base + "/publications" }, "Publish schedule"),
      ],
    ),
    pipeline(d),
    h(
      "div",
      { class: "grid main-aside" },
      h(
        "section",
        { class: "card rows" },
        h(
          "div",
          { class: "card-head" },
          h("h2", { class: "eyebrow" }, "Needs you"),
          h("span", { class: "spacer" }),
          h("p", { class: "note" }, "Blocking first"),
        ),
        rows.length === 0
          ? empty("Nothing is waiting on you. That is either very good news, or the event has not started yet.")
          : rows.map((r, i) => needsRow(r, i)),
      ),
      h("div", { class: "stack" }, roundCard(d), deadlinesCard(d)),
    ),
  );
}

/** Which of the six funnel stages carries which wash. */
const FUNNEL_TONE = { draft: "", submitted: "accent", in_review: "accent", accepted: "ok", confirmed: "ok", placed: "" };
const FUNNEL_SEG = ["seg-draft", "seg-waiting", "seg-review", "seg-accepted", "seg-accepted", "seg-placed"];

function pipeline(d) {
  const total = d.funnel.reduce((n, f) => n + f.count, 0);
  if (total === 0) return null;
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", { class: "eyebrow" }, "The round, end to end"),
      h("span", { class: "spacer" }),
      h("p", { class: "note" }, plural(d.schedule.sessions, "session") + " · " + d.schedule.placed + " placed"),
    ),
    h(
      "div",
      { class: "pipeline" },
      d.funnel.map((f) =>
        h(
          "a",
          { key: f.key, class: FUNNEL_TONE[f.key] || "", href: f.href },
          h("span", { class: "n" }, String(f.count)),
          h("span", { class: "l" }, f.label),
        ),
      ),
    ),
    h(
      "div",
      { class: "pipeline-bar" },
      d.funnel.map((f, i) =>
        h("span", { key: f.key, class: FUNNEL_SEG[i], style: "width:" + ((f.count / total) * 100).toFixed(1) + "%" }),
      ),
    ),
  );
}

/**
 * The five queues an organizer actually works, in the order that decides which
 * one to open first: what has already gone wrong, then what is about to, then
 * what merely has not happened yet.
 *
 * Kept in step with `needsYou` in `surfaces/admin-home.ts` by hand. Both read
 * the same dashboard; if a row's wording changes, it changes in both.
 */
function needsYou(d, base) {
  const rows = [
    {
      count: d.decisions.provisional,
      tone: "danger",
      what: "Provisional decisions nobody has been told about",
      why: "Nobody hears anything until you publish, and the confirmation clock does not start either.",
      verb: "Publish decisions",
      href: base + "/decisions",
    },
    {
      count: d.decisions.awaiting_confirmation,
      tone: "warn",
      what: "Accepted speakers have not confirmed",
      why:
        d.decisions.confirmation_overdue > 0
          ? d.decisions.confirmation_overdue + " are past their deadline and can expire."
          : "None are past their deadline yet. A reminder goes out from the session list.",
      verb: "Chase " + d.decisions.awaiting_confirmation,
      href: base + "/sessions?status=pending_confirmation",
    },
    {
      count: d.onboarding.overdue,
      tone: "warn",
      what: "Onboarding tasks are past due",
      why:
        d.onboarding.blocking_open > 0
          ? d.onboarding.blocking_open + " open tasks are blocking, and a session with one stays off the public schedule."
          : "None of them block publication, so this is a chase rather than a hold.",
      verb: "Open board",
      href: base + "/onboarding",
    },
    {
      count: d.schedule.unplaced,
      tone: "info",
      what: "Confirmed sessions have no room and no time",
      why: "Nothing reaches the public schedule until each one has both.",
      verb: "Place them",
      href: base + "/schedule",
    },
    {
      count: d.schedule.conflict_errors,
      tone: "danger",
      what: "Placements conflict and nobody has acknowledged it",
      why: "A blocking conflict refuses publication, so the schedule cannot go out while one is open.",
      verb: "Resolve",
      href: base + "/schedule",
    },
    {
      count: d.schedule.pending_publication_changes,
      tone: "quiet",
      what: "Schedule changes are not on the public site yet",
      why: "The public page and the calendar feed still show the last published version.",
      verb: "Review diff",
      href: base + "/publications",
    },
  ].filter((r) => r.count > 0);
  const order = ["danger", "warn", "info", "quiet"];
  rows.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone));
  return rows;
}

function needsRow(r, i) {
  return h(
    "div",
    { key: r.what, class: "needs-row " + r.tone },
    h("span", { class: "rule", "aria-hidden": "true" }),
    h("span", { class: "n" }, String(r.count)),
    h("div", { class: "body" }, h("p", { class: "what" }, r.what), h("p", { class: "why" }, r.why)),
    h(
      "div",
      { class: "actions" },
      h("a", { class: "btn small" + (i === 0 ? "" : " secondary"), href: r.href }, r.verb),
    ),
  );
}

/**
 * The open round, and who is holding it up. Named rather than counted: "eleven
 * reviews outstanding" is not something anybody can act on, and "Priya has
 * eleven, four of them late" is a message somebody can send.
 */
function roundCard(d) {
  const round = d.review.rounds.find((r) => r.status === "open") || d.review.rounds[0];
  if (!round || round.assignments === 0) return null;
  const pct = Math.round((round.submitted / round.assignments) * 100);
  const behind = d.review.reviewers_behind.slice(0, 3);
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", { class: "eyebrow" }, round.name),
      h("span", { class: "spacer" }),
      h("p", { class: "note mono" }, round.submitted + "/" + round.assignments + " reviews"),
    ),
    h("div", { class: "progress" }, h("span", { style: "width:" + pct + "%" })),
    h(
      "p",
      { class: "small muted", style: "margin:6px 0 14px" },
      round.below_quorum > 0
        ? plural(round.below_quorum, "proposal") +
            (round.below_quorum === 1 ? " is" : " are") +
            " short of quorum and cannot be decided."
        : "Every proposal in this round has enough reviews to be decided.",
    ),
    behind.length
      ? h(
          "div",
          null,
          h("p", { class: "eyebrow small", style: "margin-bottom:8px" }, "Holding it up"),
          h(
            "div",
            { class: "stack", style: "gap:8px" },
            behind.map((p) =>
              h(
                "div",
                { key: p.person_id, class: "person-row" },
                h("span", { class: "avatar initials", "aria-hidden": "true" }, initials(p.name)),
                h("span", { class: "name" }, p.name),
                h(
                  "span",
                  { class: "load" + (p.overdue > 0 ? " late" : "") },
                  p.outstanding + (p.overdue > 0 ? " · " + p.overdue + " late" : ""),
                ),
              ),
            ),
          ),
          h(
            "form",
            { method: "post", action: "/admin/rounds/" + round.id + "/progress/remind", style: "margin-top:14px" },
            behind.map((p) => h("input", { key: p.person_id, type: "hidden", name: "reviewer_person_id", value: p.person_id })),
            h(
              "button",
              { type: "submit", class: "secondary block" },
              behind.length === 1 ? "Nudge them" : "Nudge all " + (behind.length === 2 ? "two" : "three"),
            ),
          ),
        )
      : null,
  );
}

/**
 * What is coming, as distance rather than as dates. An organizer reads this
 * column to find out how much room they have, and "in 4 days" answers that
 * where "12 May" needs subtracting from today first.
 */
function deadlinesCard(d) {
  const rows = d.deadlines.slice(0, 5);
  if (rows.length === 0) return null;
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "eyebrow", style: "margin-bottom:12px" }, "Next deadlines"),
    h(
      "div",
      { class: "deadlines" },
      rows.map((dl, i) => {
        const days = Math.round((Date.parse(dl.at) - Date.now()) / 86400000);
        const tone = days < 7 ? "near" : days < 14 ? "soon" : "";
        return h(
          "div",
          { key: i, class: "deadline" + (i === rows.length - 1 && rows.length > 1 ? " last" : "") },
          h("span", { class: "when " + tone }, relativeDays(dl.at) || formatDate(dl.at)),
          h("span", { class: "what" }, dl.href ? h("a", { href: dl.href }, dl.label) : dl.label),
        );
      }),
    ),
  );
}

function initials(name) {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
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
