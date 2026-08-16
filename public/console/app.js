/**
 * The admin console — R30's client-rendered surface, entry point.
 *
 * What this file owns is the chrome: the top bar, the event bar, the section
 * nav, the drawer, the toast stack, and the decision about which screen is on
 * the page. Screens live in `views/`.
 *
 * The console is being ported screen by screen, so its route table is a subset
 * of `/admin` and says so out loud. A link to a path not in the table is left
 * to the browser and the server-rendered page answers it — which is what makes
 * this incremental rather than a flag day, and why every screen stays reachable
 * while it is being moved. `workers/api/src/surfaces/console.ts` holds the same
 * list on the server side; the two have to agree.
 */

import { h, mount, redraw } from "./kit.js";
import { api, unwrap } from "./api.js";
import { boot, applyBoot, drawer, closeDrawer, toasts, dismissToast } from "./store.js";
import { chrome } from "./chrome.js";
import { route, match, location, navigate, onNavigate, start } from "./router.js";
import { connect } from "./live.js";
import { icons, relativeDays } from "./ui.js";

import { dashboard } from "./views/dashboard.js";
import { formBuilder } from "./views/form-builder.js";
import { agenda } from "./views/agenda.js";
import { proposals } from "./views/proposals.js";
import { cfps, events, onboarding, publications, review, roster, sessions, setup } from "./views/tables.js";
import { adminHome, proposalDetail } from "./views/details.js";
import { reviewerQueue, reviewerScorecard } from "./views/reviewer.js";

/* -------------------------------------------------------------------------- */
/* The route table                                                             */
/* -------------------------------------------------------------------------- */

route("/admin/events/:eventId", dashboard);
route("/admin/events/:eventId/schedule", agenda);
route("/admin/events/:eventId/proposals", proposals);
route("/admin", adminHome);
route("/admin/events", events);
route("/admin/proposals/:proposalId", proposalDetail);
route("/admin/events/:eventId/setup", setup);
route("/admin/events/:eventId/cfps", cfps);
route("/admin/events/:eventId/sessions", sessions);
route("/admin/events/:eventId/review", review);
route("/admin/events/:eventId/roster", roster);
route("/admin/events/:eventId/onboarding", onboarding);
route("/admin/events/:eventId/publications", publications);
route("/admin/cfps/:cfpId/form", formBuilder);

// The reviewer surface. Same client, same components, different rail: these two
// screens belong to one person's queue rather than to an event, which is why
// they carry no event id and why `boot.surface` — not the path — decides which
// chrome is drawn around them.
route("/review", reviewerQueue);
route("/review/:assignmentId", reviewerScorecard);

/* -------------------------------------------------------------------------- */
/* The event in context                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `boot.event` is what the *document* was opened on, and a console that never
 * reloads outlives that answer.
 *
 * The bug this exists to close: opening `/admin/events` and clicking an event
 * used to land on that event's dashboard with no event bar and no section nav —
 * the screen was right and every way out of it was missing, because `boot.event`
 * was `null` for the rest of the document's life. `/admin` had the visible
 * version of the same fault, rendering "No event is in context yet" over an
 * organization that has two.
 *
 * The rule, stated rather than inherited from which route happened to be
 * loaded first:
 *
 * - **A route that names an event switches to it.** That includes the two that
 *   name it indirectly, through a call or a proposal; the server resolves those
 *   and this asks it to, rather than guessing from a payload that has not
 *   arrived.
 * - **A route that names none keeps the one already in context.** `/admin` and
 *   `/admin/events` are organization-wide, and the event you were working on a
 *   click ago is a better answer than nothing. A *cold* load of either has
 *   nothing to keep, which is why `/admin` opens on the most recent event there
 *   and this is the one place the two arrivals differ — deliberately, and only
 *   ever by keeping more context, never less.
 *
 * Permissions come back with it. `can` and `can_write` are computed against the
 * event in the payload, so adopting an event without re-reading them would leave
 * the console drawing the previous event's buttons — the stale authority R30
 * says the console must never accumulate.
 */
let contextToken = 0;

function eventContextFor(pathname) {
  const hit = match(pathname);
  if (!hit) return null;
  // The reviewer surface has no event in context and never acquires one — its
  // queue crosses rounds and can cross events, and the boot payload it needs is
  // the one it already has.
  if (isReviewer()) return null;
  const current = boot.event ? boot.event.id : null;
  // Named outright: switch when it is not the one we are on.
  if (hit.params.eventId) return hit.params.eventId === current ? null : pathname;
  // Named through an entity: only the server can say which event a call or a
  // proposal belongs to, so ask, and let it answer "the one you are on".
  if (hit.params.cfpId || hit.params.proposalId) return pathname;
  // Organization-wide: adopt the server's choice only when there is nothing to
  // keep. `/admin` on a fresh console is the case that matters.
  if (!current && boot.events.length) return pathname;
  return null;
}

function syncEventContext(pathname) {
  const path = eventContextFor(pathname);
  if (!path) return;
  const token = ++contextToken;
  api
    .get("/v1/console/bootstrap?path=" + encodeURIComponent(path))
    .then(unwrap)
    .then((payload) => {
      // A second navigation while this was in flight owns the context now.
      if (token !== contextToken || !payload) return;
      applyBoot(payload);
      // The live room is per event, so following the route means following it
      // here too — otherwise the console sits in the room of the event it was
      // opened on and quietly misses every change to the one on screen.
      if (boot.event) connect(boot.event.id);
      redraw();
    })
    .catch(() => {
      // A screen this reader may not open, or an event that has gone. The view
      // itself will refuse the same request and say so properly; the chrome
      // staying as it was is the right failure.
    });
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* The rail                                                                    */
/* -------------------------------------------------------------------------- */

/** Which of the two consoles this document is. The server decides; see `surfaces/console.ts`. */
function isReviewer() {
  return boot.surface === "reviewer";
}

/**
 * The reviewer's rail — the same three destinations `reviewerPage` builds in
 * `ui/shell.ts`, and for the same reason the admin rail is duplicated there:
 * the two surfaces share URLs and a reader moving between them must not find
 * the navigation rearranged underneath.
 *
 * They are `?show=` filters on one route rather than three routes, so `active`
 * is the filter rather than the path. The one link out says it is leaving:
 * reviewer and speaker are frequently the same person wearing different hats,
 * and this is where the hat is stated.
 */
function reviewerGroups(active) {
  const counts = (boot.reviewer && boot.reviewer.counts) || {};
  const n = (value, urgency) => (value ? { count: value, urgency: urgency || "quiet" } : {});
  return [
    {
      items: [
        Object.assign({ href: "/review", label: "My queue", key: "queue" }, n(counts.queue, "warn")),
        Object.assign({ href: "/review?show=submitted", label: "Submitted", key: "submitted" }, n(counts.submitted)),
        Object.assign({ href: "/review?show=declined", label: "Declined", key: "declined" }, n(counts.declined)),
      ],
    },
    { items: [{ href: "/portal", label: "My speaker portal", key: "portal", external: true }] },
  ];
}

/**
 * The event's own workflow, in the order it happens — the same five groups
 * `adminRail` builds in `ui/shell.ts`, because the console and the
 * server-rendered screens share URLs and a reader moving between them must not
 * find the navigation rearranged underneath.
 *
 * If you change a group here, change it there. The two lists are short, they
 * are both in view when either is edited, and a generated third copy would be
 * a build step this console exists to avoid.
 */
function railGroups(active) {
  if (isReviewer()) return reviewerGroups(active);
  const ev = boot.event;
  const counts = boot.rail || {};
  const n = (value, urgency) => (value ? { count: value, urgency: urgency || "quiet" } : {});

  if (!ev) {
    return [
      {
        label: "Organization",
        items: [
          { href: "/admin", label: "Today", key: "today" },
          { href: "/admin/events", label: "Events", key: "events" },
          { href: "/admin/contacts", label: "Contacts", key: "contacts" },
          { href: "/admin/sponsors", label: "Sponsors", key: "sponsors" },
          { href: "/admin/team", label: "Team", key: "team" },
        ],
      },
    ];
  }

  const base = "/admin/events/" + ev.id;
  return [
    {
      label: "Now",
      items: [
        Object.assign({ href: "/admin", label: "Today", key: "today" }, n(counts.today, "warn")),
        { href: base, label: "Overview", key: "overview" },
      ],
    },
    {
      label: "Intake",
      items: [
        Object.assign({ href: base + "/cfps", label: "Calls for papers", key: "cfp" }, n(counts.cfps)),
        Object.assign({ href: base + "/proposals", label: "Proposals", key: "proposals" }, n(counts.proposals)),
      ],
    },
    {
      label: "Decide",
      items: [
        Object.assign({ href: base + "/review", label: "Review", key: "review" }, n(counts.review)),
        Object.assign({ href: base + "/decisions", label: "Decisions", key: "decisions" }, n(counts.decisions, "warn")),
      ],
    },
    {
      label: "Program",
      items: [
        Object.assign({ href: base + "/sessions", label: "Sessions", key: "sessions" }, n(counts.sessions)),
        { href: base + "/roster", label: "Speakers", key: "roster" },
        Object.assign({ href: base + "/onboarding", label: "Onboarding", key: "onboarding" }, n(counts.onboarding, "danger")),
        Object.assign({ href: base + "/schedule", label: "Agenda", key: "schedule" }, n(counts.agenda)),
        Object.assign({ href: base + "/publications", label: "Publish", key: "publish" }, n(counts.publish)),
      ],
    },
    {
      label: "Around it",
      items: [
        { href: base + "/sponsorships", label: "Sponsors", key: "sponsors" },
        { href: base + "/campaigns", label: "Messaging", key: "campaigns" },
        { href: base + "/files", label: "Files", key: "files" },
        { href: base + "/setup", label: "Setup", key: "setup" },
        { href: "/admin/contacts", label: "Contacts", key: "contacts" },
      ],
    },
  ];
}

function railLink(item, active) {
  return h(
    "a",
    {
      key: item.key + item.href,
      class: "rail-link",
      href: item.href,
      target: item.external ? "_blank" : null,
      rel: item.external ? "noopener" : null,
      "aria-current": item.key === active ? "page" : null,
    },
    h("span", null, item.label),
    item.count ? h("span", { class: "count " + (item.urgency || "quiet") }, String(item.count)) : null,
    item.external ? h("span", { class: "ext", "aria-hidden": "true" }, "↗") : null,
  );
}

/**
 * `12–14 May · 272 days out`, and the timezone under it. Same two lines the
 * server-rendered rail draws, computed the same way: `starts_on` is a calendar
 * date in the event's own zone and is never converted (11, "Time").
 */
function eventLines(ev) {
  const at = (iso, opts) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", Object.assign({ timeZone: "UTC" }, opts));
  const sameMonth = ev.starts_on.slice(0, 7) === ev.ends_on.slice(0, 7);
  const span =
    ev.starts_on === ev.ends_on
      ? at(ev.starts_on, { day: "numeric", month: "short" })
      : sameMonth
        ? at(ev.starts_on, { day: "numeric" }) + "–" + at(ev.ends_on, { day: "numeric", month: "short" })
        : at(ev.starts_on, { day: "numeric", month: "short" }) + " – " + at(ev.ends_on, { day: "numeric", month: "short" });
  const days = Math.round((Date.parse(ev.starts_on + "T00:00:00Z") - Date.parse(boot.now || new Date().toISOString())) / 86400000);
  const distance = days > 0 ? days + " days out" : days === 0 ? "today" : Math.abs(days) + " days ago";
  return [span + " · " + distance, ev.timezone];
}

/**
 * What the reviewer's rail says they are working on: one round named, several
 * counted. A rail that lists three round names has become a second navigation
 * — the same rule `railRound` follows on the server, over the same rounds.
 */
function reviewerContext() {
  const rounds = (boot.reviewer && boot.reviewer.rounds) || [];
  if (rounds.length === 0) return null;
  if (rounds.length > 1) {
    return { name: rounds.length + " open rounds", lines: [rounds.map((r) => r.name).join(" · ")] };
  }
  const round = rounds[0];
  const parts = [];
  const closes = relativeDays(round.closes_at, Date.parse(boot.now || new Date().toISOString()));
  if (closes) parts.push("closes " + closes);
  // `double-blind`, not `Double blind`: it is a compound adjective, and the
  // rail is the one place this word appears in running text.
  parts.push(String(round.anonymity).replace(/_/g, "-"));
  return { name: round.name, lines: [parts.join(" · ")] };
}

/**
 * The event in context, and the way to point the console at another one.
 *
 * Mirrors `railContext` in `ui/layout.ts` — the same `<details>`, the same
 * rows, the same explicit "open in a new tab" beside each. The rows are
 * ordinary links, so the router picks them up and switches in the same
 * document; `boot.events` is already on the payload, so this costs no fetch.
 *
 * One event is not a choice, so with fewer than two the card is the plain
 * link it was.
 */
function eventSwitcher(ev, running) {
  const events = boot.events || [];
  const dot = running ? h("span", { class: "dot", "aria-hidden": "true" }) : null;

  if (events.length < 2) {
    return h(
      "div",
      { class: "rail-context" },
      h("div", { class: "head" }, dot, h("a", { class: "name", href: "/admin/events/" + ev.id }, ev.name)),
      eventLines(ev).map((line, i) => h("p", { key: i }, line)),
    );
  }

  return h(
    "details",
    { class: "rail-context switcher" },
    h(
      "summary",
      null,
      // Name and dates both inside the summary: a closed `<details>` hides
      // everything else, and the dates are what the card is for.
      h(
        "span",
        { class: "head" },
        dot,
        h("span", { class: "name" }, ev.name),
        h("span", { class: "caret", "aria-hidden": "true" }, "▾"),
        h("span", { class: "sr-only" }, "Switch event"),
      ),
      eventLines(ev).map((line, i) => h("p", { key: i }, line)),
    ),
    h(
      "div",
      { class: "event-menu" },
      h("p", { class: "rail-group-label" }, "Switch to"),
      events.map((e) =>
        h(
          "span",
          { key: e.id, class: "event-row" + (e.id === ev.id ? " current" : "") },
          h(
            "a",
            { href: "/admin/events/" + e.id, "aria-current": e.id === ev.id ? "true" : null },
            h("span", { class: "n" }, e.name),
            h("span", { class: "s" }, e.status),
          ),
          h(
            "a",
            { class: "tab", href: "/admin/events/" + e.id, target: "_blank", rel: "noopener", title: "Open in a new tab" },
            "↗",
            h("span", { class: "sr-only" }, "Open " + e.name + " in a new tab"),
          ),
        ),
      ),
      h("a", { class: "all", href: "/admin/events" }, "All events"),
    ),
  );
}

function rail(active) {
  const ev = boot.event;
  const today = (boot.now || "").slice(0, 10);
  const running = ev ? today >= ev.starts_on && today <= ev.ends_on : false;
  const context = isReviewer() ? reviewerContext() : null;
  return h(
    "details",
    { class: "rail" },
    h(
      "summary",
      { class: "rail-brand" },
      // A phone affordance: above 64rem the stylesheet drops this row and the
      // event card below is the top of the sidebar. So it names the event, not
      // the product — the mark is in the top bar now, and a closed drawer
      // labelled "Podium" tells the reader nothing. Sized in the markup against
      // layout shift, as the server-rendered rail is — `ui/layout.ts::rail()`.
      ev && !isReviewer()
        ? h("span", { class: "rail-brand-name" }, ev.name)
        : h("img", { class: "mark", src: "/podium-logo-horizontal-light.png", alt: "Podium", width: "81", height: "24" }),
      h("span", { class: "spacer" }),
      h("span", { class: "toggle", "aria-hidden": "true" }, icons.menu ? icons.menu() : "≡"),
      h("span", { class: "sr-only" }, "Menu"),
    ),
    h(
      "div",
      { class: "rail-body" },
      context
        ? h(
            "div",
            { class: "rail-context" },
            h("div", { class: "head" }, h("span", { class: "name" }, context.name)),
            context.lines.map((line, i) => h("p", { key: i }, line)),
          )
        : ev
          ? eventSwitcher(ev, running)
          : null,
      h(
        "nav",
        { class: "rail-nav", "aria-label": "Sections" },
        railGroups(active).map((g, i) =>
          h(
            "div",
            { key: g.label || i, class: "rail-group" },
            g.label ? h("p", { class: "rail-group-label" }, g.label) : null,
            g.items.map((item) => railLink(item, active)),
          ),
        ),
      ),
      h(
        "div",
        { class: "rail-foot" },
        // The organizer's foot only. A reviewer has no team screen and no
        // settings, and `railFooter` gives them the same three-less foot.
        isReviewer() ? null : railLink({ href: "/admin/events", label: "All events", key: "events" }, active),
        isReviewer() ? null : railLink({ href: "/admin/team", label: "Team", key: "team" }, active),
        isReviewer() ? null : railLink({ href: "/admin/settings", label: "Settings", key: "settings" }, active),
        boot.person
          ? railLink(
              {
                href: "/portal/profile",
                label: boot.person.display_name || boot.person.full_name,
                key: "me",
                external: true,
              },
              active,
            )
          : null,
        // Signing out is a POST, as it is on every server-rendered screen: a
        // sign-out reachable by GET is one a prefetch or a link scanner can fire.
        h(
          "form",
          { method: "post", action: "/logout", class: "rail-signout" },
          h("button", { type: "submit", class: "ghost small" }, "Sign out"),
        ),
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* The top bar                                                                 */
/* -------------------------------------------------------------------------- */

function bar() {
  const ev = boot.event;
  const reviewer = isReviewer();
  // One crumb is not a breadcrumb — it is the `<h1>` two lines below, in mono.
  // The event used to lead every trail on the organizer's side, which made a
  // path out of the name the rail is already flying; with it gone there is no
  // parent left to name, so the organizer's bar draws none. The reviewer's
  // queue really is one level under Review, and keeps its trail. Same rule as
  // `crumbs()` in `ui/layout.ts`, which drops any trail shorter than two.
  const crumbs = reviewer ? [{ label: "Review", href: "/review" }, { label: chrome.title || "My queue" }] : [];
  return h(
    "header",
    { class: "bar" },
    // The palette lives in `public/keys.js`, which is loaded on both surfaces
    // and finds this button by its attribute rather than by an import.
    //
    // Not drawn for a reviewer, the same choice `reviewerPage` makes with
    // `search: false`: a reviewer's whole world is the queue in front of them,
    // and a palette over three destinations is a menu pretending to be a
    // search box.
    reviewer
      ? null
      : h(
          "button",
          { type: "button", class: "omni", "data-palette": "", "aria-haspopup": "dialog" },
          h("span", { class: "label" }, "Search proposals, people, sessions"),
          h("kbd", null, h("span", { class: "on-mac" }, "⌘K"), h("span", { class: "on-pc" }, "Ctrl K")),
        ),
    crumbs.length > 1
      ? h(
          "nav",
          { class: "crumbs", "aria-label": "Breadcrumb" },
          crumbs.map((c, i) => [
            i > 0 ? h("span", { key: "s" + i, class: "sep", "aria-hidden": "true" }, "/") : null,
            c.href
              ? h("a", { key: "c" + i, href: c.href }, c.label)
              : h("span", { key: "c" + i, "aria-current": "page" }, c.label),
          ]),
        )
      : null,
    h("span", { class: "spacer" }),
    chrome.hints && chrome.hints.length
      ? h(
          "p",
          { class: "hints", "data-hints": "" },
          chrome.hints.map((hint, i) =>
            h("span", { key: i, class: "hint" }, hint.keys.map((k, j) => h("kbd", { key: j }, k)), hint.label),
          ),
        )
      : null,
    ev
      ? h(
          "a",
          { class: "pill", href: "/e/" + ev.slug, target: "_blank", rel: "noopener" },
          "Public page ↗",
        )
      : null,
    // The mark closes the bar, on the workspace's white — so the dark lockup,
    // the one place in the console that uses it. Mirrors `barBrand` in
    // `ui/layout.ts`, down to the width and height that keep the row from
    // reflowing when the image lands.
    h(
      "a",
      { class: "bar-brand", href: reviewer ? "/review" : "/admin" },
      h("img", { src: "/podium-logo-horizontal.png", alt: "Podium", width: "81", height: "24" }),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer and toasts                                                           */
/* -------------------------------------------------------------------------- */

function drawerView() {
  if (!drawer.open) return null;
  return h(
    "div",
    { class: "console-scrim", onclick: (ev) => ev.target === ev.currentTarget && closeDrawer() },
    h(
      "aside",
      {
        class: "console-drawer" + (drawer.wide ? " wide" : ""),
        role: "dialog",
        "aria-modal": "true",
        "aria-label": drawer.title,
      },
      h(
        "header",
        null,
        h("h2", null, drawer.title),
        h(
          "button",
          { type: "button", class: "console-icon-btn", onclick: closeDrawer, "aria-label": "Close" },
          icons.close(),
        ),
      ),
      h("div", { class: "console-drawer-body" }, drawer.render ? drawer.render() : null),
    ),
  );
}

function toastStack() {
  if (!toasts.length) return null;
  return h(
    "div",
    { class: "console-toasts", role: "status", "aria-live": "polite" },
    toasts.map((t) =>
      h(
        "div",
        { key: t.id, class: "console-toast " + t.kind },
        h("span", null, t.message),
        t.action ? h("button", { type: "button", class: "link", onclick: t.action.onclick }, t.action.label) : null,
        h(
          "button",
          { type: "button", class: "console-icon-btn", onclick: () => dismissToast(t.id), "aria-label": "Dismiss" },
          icons.close(),
        ),
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* The shell                                                                   */
/* -------------------------------------------------------------------------- */

function shell() {
  const hit = match(location.pathname);
  return h(
    "div",
    { class: "frame" },
    rail(chrome.section),
    h(
      "div",
      { class: "workspace" },
      bar(),
      h(
        "main",
        null,
        hit
          ? hit.view(hit.params)
          : h(
              "div",
              { class: "card" },
              h("h1", null, "Not part of the console yet"),
              h("p", { class: "lede" }, "This screen is still server-rendered. Reload to open it."),
              h("p", null, h("a", { href: location.pathname, "data-native": "true" }, "Open it")),
            ),
      ),
    ),
    drawerView(),
    toastStack(),
  );
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

// Escape closes the drawer before it closes anything else — a half-typed
// settings form behind a scrim is the one thing on screen that can trap focus.
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && drawer.open) {
    ev.preventDefault();
    closeDrawer();
  }
});

onNavigate(syncEventContext);
start();
if (boot.event) connect(boot.event.id);

const root = document.getElementById("console");
// The boot document ships a "Loading the console…" placeholder so the page is
// not blank while the module loads. The renderer only knows about nodes it
// created, so the placeholder is cleared here rather than left underneath the
// first render.
root.textContent = "";
mount(root, shell);
redraw();
