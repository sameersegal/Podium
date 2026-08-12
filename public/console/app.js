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
import { icons, formatDate } from "./ui.js";

import { dashboard } from "./views/dashboard.js";
import { formBuilder } from "./views/form-builder.js";
import { agenda } from "./views/agenda.js";
import { proposals } from "./views/proposals.js";
import { cfps, events, onboarding, publications, review, roster, sessions, setup } from "./views/tables.js";
import { adminHome, proposalDetail } from "./views/details.js";

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

/** The primary tabs, mirroring `adminPage` in `ui/shell.ts`. */
function topbar() {
  const ev = boot.event;
  const tabs = [
    { href: "/admin/events", label: "Events", current: Boolean(ev) },
    { href: "/admin/contacts", label: "Contacts" },
    { href: "/admin/sponsors", label: "Sponsors" },
    { href: "/admin/team", label: "Team" },
    { href: "/admin/settings", label: "Settings" },
  ];
  return h(
    "div",
    { class: "topbar" },
    h(
      "a",
      { class: "brand", href: "/admin" },
      // Sized in the markup as well as in CSS: the console draws its chrome
      // before the image has loaded, and a top bar that changes height once it
      // does moves the screen under the reader's cursor.
      h("img", { src: "/podium-logo-horizontal-light.png", alt: "Podium", width: "81", height: "24" }),
    ),
    h(
      "nav",
      { class: "tabs", "aria-label": "Sections" },
      tabs.map((t) =>
        h("a", { key: t.href, href: t.href, "aria-current": t.current ? "page" : null }, t.label),
      ),
    ),
    h("span", { class: "spacer" }),
    h("a", { href: "/portal", target: "_blank", rel: "noopener" }, "Speaker portal"),
    boot.person
      ? h("span", { class: "console-who" }, boot.person.display_name || boot.person.full_name)
      : null,
    // Signing out is a POST, as it is on every server-rendered screen: a
    // sign-out reachable by GET is one a prefetch or a link scanner can fire.
    h(
      "form",
      { method: "post", action: "/logout" },
      h("button", { type: "submit", class: "secondary small" }, "Sign out"),
    ),
  );
}

function eventbar() {
  const ev = boot.event;
  if (!ev) return null;
  return h(
    "div",
    { class: "eventbar" },
    h("a", { class: "name", href: "/admin/events/" + ev.id }, ev.name),
    h("span", { class: "badge" }, ev.status),
    h(
      "span",
      { class: "meta" },
      formatDate(ev.starts_on) + " – " + formatDate(ev.ends_on) + " · ",
      h("span", { class: "mono" }, ev.timezone),
    ),
    h("span", { class: "spacer" }),
    h("a", { href: "/e/" + ev.slug, target: "_blank", rel: "noopener" }, "Public page"),
  );
}

/** The event sections, mirroring `adminNav`. Ported screens navigate in place. */
function subnav(active) {
  const ev = boot.event;
  if (!ev) return null;
  const base = "/admin/events/" + ev.id;
  const items = [
    { href: base, label: "Overview", key: "overview" },
    { href: base + "/setup", label: "Setup", key: "setup" },
    { href: base + "/cfps", label: "Call for papers", key: "cfp" },
    { href: base + "/proposals", label: "Proposals", key: "proposals" },
    { href: base + "/review", label: "Review", key: "review" },
    { href: base + "/decisions", label: "Decisions", key: "decisions" },
    { href: base + "/sessions", label: "Sessions", key: "sessions" },
    { href: base + "/roster", label: "Speakers", key: "roster" },
    { href: base + "/onboarding", label: "Onboarding", key: "onboarding" },
    { href: base + "/files", label: "Files", key: "files" },
    { href: base + "/schedule", label: "Agenda", key: "schedule" },
    { href: base + "/publications", label: "Publish", key: "publish" },
    { href: base + "/sponsorships", label: "Sponsors", key: "sponsors" },
    { href: base + "/campaigns", label: "Messaging", key: "campaigns" },
  ];
  const current = items.find((i) => i.key === active);
  return h(
    "details",
    { class: "subnav", open: false },
    h("summary", null, current ? current.label : "Menu"),
    h(
      "nav",
      { "aria-label": "Event sections" },
      items.map((i) =>
        h("a", { key: i.key, href: i.href, "aria-current": i.key === active ? "page" : null }, i.label),
      ),
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
    { class: "console-root" },
    topbar(),
    eventbar(),
    subnav(chrome.section),
    h(
      "main",
      { class: "wide" },
      hit
        ? hit.view(hit.params)
        : h(
            "div",
            { class: "card" },
            h("h1", null, "Not part of the console yet"),
            h(
              "p",
              { class: "lede" },
              "This screen is still server-rendered. Reload to open it.",
            ),
            h("p", null, h("a", { href: location.pathname, "data-native": "true" }, "Open it")),
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
