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
import { boot, drawer, closeDrawer, toasts, dismissToast } from "./store.js";
import { chrome } from "./chrome.js";
import { route, match, location, navigate, start } from "./router.js";
import { connect } from "./live.js";
import { icons, formatDate } from "./ui.js";

import { dashboard } from "./views/dashboard.js";
import { formBuilder } from "./views/form-builder.js";
import { agenda } from "./views/agenda.js";
import { proposals } from "./views/proposals.js";

/* -------------------------------------------------------------------------- */
/* The route table                                                             */
/* -------------------------------------------------------------------------- */

route("/admin/events/:eventId", dashboard);
route("/admin/events/:eventId/schedule", agenda);
route("/admin/events/:eventId/proposals", proposals);
route("/admin/cfps/:cfpId/form", formBuilder);

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
    h("a", { class: "brand", href: "/admin" }, h("img", { src: "/podium-logo-horizontal-light.png", alt: "Podium" })),
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
