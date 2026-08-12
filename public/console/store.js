/**
 * Console state that outlives a screen: who is signed in, the toast stack, the
 * open drawer, and the little async-resource holder every view loads through.
 *
 * Nothing here is a permission cache. R30 leans on permissions being recomputed
 * per request, so the console holds what the server last *said* in order to
 * decide whether to draw a button, and the server decides again on the write.
 * A stale `can` here costs a disabled-looking button or a 403 toast, never an
 * unauthorized write.
 */

import { redraw } from "./kit.js";
import { ApiError } from "./api.js";

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

const emptyBoot = () => ({ person: null, org: null, events: [], event: null, can: {}, can_write: {} });

function readBoot() {
  const el = document.getElementById("console-boot");
  if (!el) return emptyBoot();
  try {
    return Object.assign(emptyBoot(), JSON.parse(el.textContent));
  } catch (err) {
    console.error("console boot payload is not JSON", err);
    return emptyBoot();
  }
}

/**
 * Inlined by the server rather than fetched. A console that boots by asking
 * `/v1` who it is renders an empty shell for one round trip on every cold
 * load, and the shell is the part the reader uses to orient.
 */
export const boot = readBoot();

/**
 * Replace the boot payload after a re-read, in place.
 *
 * In place because every view imports this one object and reads through it;
 * rebinding the export would leave each of them holding the payload the
 * document booted with. Missing keys are reset rather than merged, so a
 * payload that answers with no event in context actually clears the one that
 * was there — a stale event bar over a screen belonging to another event is
 * the failure this exists to prevent.
 */
export function applyBoot(next) {
  Object.assign(boot, emptyBoot(), next);
}

/** May the reader see this at all — decides whether a section is drawn. */
export function can(capability) {
  return Boolean(boot.can && boot.can[capability]);
}

/** May the reader change it — decides whether the controls are drawn. */
export function canWrite(capability) {
  return Boolean(boot.can_write && boot.can_write[capability]);
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

export const toasts = [];
let toastSeq = 0;

export function toast(kind, message, options) {
  const o = options || {};
  const entry = { id: ++toastSeq, kind, message, action: o.action || null };
  toasts.push(entry);
  redraw();
  if (kind !== "err") setTimeout(() => dismissToast(entry.id), o.duration || 4000);
  return entry.id;
}

export function dismissToast(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) {
    toasts.splice(i, 1);
    redraw();
  }
}

/**
 * The one place an API failure becomes something a person reads. A typed error
 * names its invariant, and the message the server wrote is better than anything
 * the client could compose — so it is shown, not replaced.
 */
export function reportError(err) {
  if (err && err.name === "AbortError") return;
  if (err instanceof ApiError) {
    const detail = err.fieldErrors.length ? " " + err.fieldErrors.map((f) => f.message).join(" ") : "";
    toast("err", err.message + detail);
    return;
  }
  console.error(err);
  toast("err", "Something went wrong. Nothing was saved.");
}

/* -------------------------------------------------------------------------- */
/* Drawer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One drawer at a time, holding a whole editing surface. Item 4's settings form
 * lives in here: an overview that opens with a twenty-field form is a form with
 * a dashboard stapled above it, and the reader came for the dashboard.
 */
export const drawer = { open: false, title: "", render: null, wide: false };

export function openDrawer(title, render, options) {
  drawer.open = true;
  drawer.title = title;
  drawer.render = render;
  drawer.wide = Boolean(options && options.wide);
  redraw();
}

export function closeDrawer() {
  drawer.open = false;
  drawer.render = null;
  redraw();
}

/* -------------------------------------------------------------------------- */
/* Resources                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A load-once-per-key async holder.
 *
 * Views are pure functions of state that run on every redraw, so they cannot
 * fetch — a view that called `api.get` would fetch on every keystroke anywhere
 * on the screen. Instead a view asks for a resource by key; the first ask
 * starts the load, and the load's completion redraws.
 */
const cache = new Map();

export function resource(key, loader) {
  let entry = cache.get(key);
  if (!entry) {
    entry = { key, loading: true, error: null, data: null, loader, generation: 0 };
    cache.set(key, entry);
    run(entry);
  }
  return entry;
}

function run(entry) {
  const generation = ++entry.generation;
  entry.loading = true;
  entry.error = null;
  Promise.resolve()
    .then(() => entry.loader())
    .then(
      (data) => {
        if (entry.generation !== generation) return;
        entry.data = data;
        entry.loading = false;
        redraw();
      },
      (err) => {
        if (entry.generation !== generation) return;
        entry.error = err;
        entry.loading = false;
        redraw();
      },
    );
}

/** Re-run a resource in place — what a live frame and a successful write both do. */
export function reload(key) {
  const entry = cache.get(key);
  if (entry) run(entry);
}

/** Drop cached resources whose key starts with `prefix`, so the next view reloads them. */
export function invalidate(prefix) {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Replace a resource's data without a round trip. Used where the server already
 * answered with the new state — a placement write returns its conflicts, a
 * reorder returns the reordered form — so re-fetching would only ask for what
 * is already in hand.
 */
export function put(key, data) {
  const entry = cache.get(key);
  if (entry) {
    entry.data = data;
    entry.loading = false;
    entry.error = null;
    entry.generation++;
  }
  redraw();
}
