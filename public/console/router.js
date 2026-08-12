/**
 * The console's client router.
 *
 * The console owns a subset of `/admin` and is growing into the rest, so the
 * router has to answer "is this mine?" rather than assume it. A link to a path
 * no console route matches is left alone and the browser navigates to the
 * server-rendered screen — which is what makes the port incremental instead of
 * a flag day, and what keeps every screen reachable while it is being moved.
 *
 * The same table is the server's, in `workers/api/src/surfaces/console.ts`.
 * The two must agree: a path the server boots the console for and the client
 * cannot match renders an empty shell.
 */

import { redraw } from "./kit.js";

const routes = [];

/** `pattern` uses `:name` segments, matching the server-side router. */
export function route(pattern, view) {
  routes.push({ segments: pattern.split("/").filter(Boolean), view });
}

export function match(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { view: r.view, params };
  }
  return null;
}

export const location = {
  pathname: window.location.pathname,
  search: window.location.search,
  query: new URLSearchParams(window.location.search),
};

function sync() {
  location.pathname = window.location.pathname;
  location.search = window.location.search;
  location.query = new URLSearchParams(window.location.search);
}

/**
 * Navigate. A path the console does not own becomes a real navigation, so the
 * server-rendered screen loads normally rather than blanking the shell.
 */
export function navigate(href, options) {
  const opts = options || {};
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin || !match(url.pathname)) {
    window.location.href = url.href;
    return;
  }
  if (opts.replace) window.history.replaceState({}, "", url.href);
  else window.history.pushState({}, "", url.href);
  sync();
  if (!opts.keepScroll) window.scrollTo(0, 0);
  redraw();
}

/** Rewrite the query string without a navigation — filters, selected tab. */
export function setQuery(patch, options) {
  const next = new URLSearchParams(window.location.search);
  for (const k in patch) {
    const v = patch[k];
    if (v == null || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  const search = next.toString();
  const href = window.location.pathname + (search ? "?" + search : "");
  window.history.replaceState({}, "", href);
  sync();
  if (!options || !options.silent) redraw();
}

export function start() {
  window.addEventListener("popstate", () => {
    sync();
    redraw();
  });

  // One delegated listener rather than an `onclick` on every link: the views
  // render ordinary `<a href>` elements, so a middle-click, a modifier-click
  // and "open in new tab" all keep working, and a link is still a link with
  // scripts halfway through loading.
  document.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest && ev.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download") || a.dataset.native === "true") return;
    const url = new URL(a.getAttribute("href"), window.location.origin);
    if (url.origin !== window.location.origin) return;
    // `match()` compares pathname only, so a link back to a console-owned path
    // with `?nojs=1` attached — every "the write form stays server-rendered"
    // escape hatch in the app — still matched and got swallowed into a
    // same-document re-render that silently dropped the query string. The
    // server's own `consoleDocument` already treats `?nojs=1` as "not mine"
    // (surfaces/console.ts); the client has to agree, or none of those links
    // ever reach the page they say they link to.
    if (url.searchParams.get("nojs") === "1") return; // explicit escape hatch — let the browser navigate
    if (!match(url.pathname)) return; // server-rendered — let the browser do it
    ev.preventDefault();
    navigate(url.href);
  });
}
