import { html, raw, type SafeHtml, escapeHtml } from "./html.js";
import { liveRegion, type LiveOptions } from "./live.js";

export interface NavItem {
  href: string;
  label: string;
  current?: boolean;
  /**
   * Opens in a new tab, with an icon saying so. Reserved for links that leave
   * the mode you are in — switching between admin and the portal mid-task is
   * disorienting when it happens in the tab you were working in.
   */
  external?: boolean;
}

/**
 * The five surfaces, and the two design languages they fall into.
 *
 * `admin` and `reviewer` are the **console**: dense, dark-railed, keyboard-first,
 * for the two or three people who are in it every day. `portal`, `public` and
 * `auth` are the **program book**: editorial, serif, one job per page, for a
 * speaker who visits three times a year and a reader who visits once.
 *
 * They share no colour, no typeface and no component. That is a product
 * decision, not an oversight, and it is why `surface` picks the stylesheet
 * rather than toggling a class inside one.
 */
export type Surface = "admin" | "reviewer" | "portal" | "public" | "auth";

function isConsoleSurface(surface: Surface): boolean {
  return surface === "admin" || surface === "reviewer";
}

/** A rail destination: a link, plus the count that says how loud it is. */
export interface RailItem extends NavItem {
  count?: string | number | null;
  /**
   * What the count means, which is the only thing that colours it. `danger` is
   * "this is already late", `warn` is "this will be late soon"; everything else
   * is quiet even when the number is large, because 184 proposals is not a
   * problem and 7 overdue tasks is.
   */
  urgency?: "quiet" | "warn" | "danger";
}

/** One phase of the event's own workflow, and the destinations inside it. */
export interface RailGroup {
  label?: string | null;
  items: RailItem[];
}

/** What the rail says you are working on, above the nav. */
export interface RailContext {
  name: string;
  href?: string;
  /** Up to two lines of mono metadata under the name. */
  lines?: string[];
  /** Draws the status dot — the event is running now. */
  live?: boolean;
}

export interface Crumb {
  label: string;
  href?: string;
}

/** A keycap hint in the top bar: the keys, and what they do. */
export interface KeyHint {
  keys: string[];
  label: string;
}

/**
 * Everything the console shell draws around a screen. A screen supplies it
 * through `adminPage` / `reviewerPage` and never assembles the chrome itself.
 */
export interface ConsoleChrome {
  /** Where the brand mark goes. */
  home: string;
  context?: RailContext | null;
  groups: RailGroup[];
  /** Below the rail's own rule: Settings, and the signed-in person. */
  footer?: RailItem[];
  crumbs?: Crumb[];
  /** The one persistent piece of event state worth the top bar's right edge. */
  status?: { label: string; kind?: "ok" | "warn" | "danger" } | null;
  /** Draw the ⌘K affordance. */
  search?: boolean;
  hints?: KeyHint[];
}

export interface PageOptions {
  title: string;
  surface?: Surface;
  /** The console shell. Required by `admin` and `reviewer`, ignored elsewhere. */
  console?: ConsoleChrome;
  /** The editorial bar's links. The console reads its navigation off the rail. */
  nav?: NavItem[];
  who?: string | null;
  /** Where the editorial bar's "Profile" points. Defaults to the portal profile. */
  profile?: NavItem;
  /** The brand link. Defaults to the landing page of the current surface. */
  home?: string;
  /** The wordmark on an editorial page. The event's own name on a public page. */
  brand?: string;
  /** Rendered between the bar and the measure. */
  banner?: SafeHtml;
  width?: "narrow" | "default" | "wide";
  flash?: { kind: "ok" | "err" | "warn" | "info"; message: string } | null;
  bodyClass?: string;
  head?: SafeHtml;
  /**
   * Opt this screen into live updates (`ui/live.ts`). Authenticated surfaces
   * only — a public page that passed this would start depending on a script,
   * which 08, "Degrade gracefully" forbids.
   */
  live?: LiveOptions;
}

const HEAD_ICONS = raw(`
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
`);

/**
 * The two latin faces each language opens with, preloaded.
 *
 * Only `latin`, and only the roman: `latin-ext` and the italics carry their own
 * `unicode-range` and are fetched on demand by the few pages that need them.
 * Preloading a face the page never draws is bandwidth taken from one it does.
 *
 * `crossorigin` is required even same-origin — a font is always fetched in CORS
 * mode, and a preload whose mode does not match the real request is downloaded
 * twice.
 */
const PRELOAD: Record<"console" | "editorial", SafeHtml> = {
  // `html` rather than `raw`: there is nothing to interpolate, so there is no
  // reason to reach past the escaper and no new entry in the security baseline.
  console: html`<link rel="preload" href="/fonts/public-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/fonts/jetbrains-mono-latin.woff2" as="font" type="font/woff2" crossorigin>`,
  editorial: html`<link rel="preload" href="/fonts/source-serif-4-latin.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/fonts/karla-latin.woff2" as="font" type="font/woff2" crossorigin>`,
};

/**
 * One stylesheet per language, chosen here so no screen has to know which one
 * it is on. `app.css` is gone: it was one file describing one look, and there
 * are now two looks that share nothing.
 *
 * The font declarations are a second `<link>` rather than an `@import` inside
 * the stylesheet, and the faces themselves are preloaded beside it. An
 * `@import` serialises what should be parallel — stylesheet, then font
 * declarations, then the font — and measured on a throttled mid-range phone
 * that chain did not start downloading a typeface until 543 ms in. Three
 * requests that can all leave with the first one now do.
 */
function stylesheet(surface: Surface): SafeHtml {
  const console = isConsoleSurface(surface);
  const href = console ? "/admin.css" : "/portal.css";
  return html`${PRELOAD[console ? "console" : "editorial"]}
  <link rel="stylesheet" href="/fonts/fonts.css">
  <link rel="stylesheet" href="${href}">`;
}

/**
 * The behaviour behind every `data-confirm` and `data-back` in the app.
 *
 * A static file rather than an inline block on purpose. `script-src` names
 * `'self'` and a per-request nonce and nothing else, and an event-handler
 * attribute cannot carry a nonce — so `onsubmit="return confirm(…)"` had to
 * become markup that declares intent plus one script that acts on it.
 *
 * `defer`, and nothing here is load-bearing for correctness: with scripts
 * blocked the form still submits, exactly as it did when the handler was
 * inline (08, "Degrade gracefully"). The server re-checks every rule anyway —
 * a confirm dialog is a courtesy, never a control.
 */
const CONFIRM_SCRIPT = raw(`<script src="/confirm.js" defer></script>`);

/**
 * The console's keyboard layer — the ⌘K palette, `J`/`K`/`↵` on a list, the
 * `g`-prefixed jumps and the `?` sheet.
 *
 * Loaded only on `admin` and `reviewer`, and deferred, because none of it is
 * load-bearing: every destination it reaches is a link already in the rail, and
 * every row it moves between is a link already in the row. With scripts blocked
 * the console is the same set of pages one click further apart, which is the
 * only promise an accelerator is allowed to make.
 */
const KEYS_SCRIPT = raw(`<script src="/keys.js" defer></script>`);

export function page(opts: PageOptions, body: SafeHtml): SafeHtml {
  const surface = opts.surface ?? "public";
  const dense = isConsoleSurface(surface);
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title} · Podium</title>
  ${HEAD_ICONS}
  ${stylesheet(surface)}
  ${opts.head ?? raw("")}
</head>
<body class="${surface} ${opts.bodyClass ?? ""}">
  ${dense && opts.console ? consoleShell(opts, opts.console, body) : editorialShell(opts, body)}
  ${opts.live ? liveRegion(opts.live) : raw("")}
  ${CONFIRM_SCRIPT}
  ${dense ? KEYS_SCRIPT : raw("")}
</body>
</html>`;
}

function flashBanner(opts: PageOptions): SafeHtml {
  if (!opts.flash) return raw("");
  return html`<div class="flash ${opts.flash.kind}" role="status">${opts.flash.message}</div>`;
}

/* -------------------------------------------------------------------------- */
/* the console shell                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A rail count. The number is mono because it is a number you compare against
 * yesterday's, and it is right-aligned for the same reason.
 */
function railCount(item: RailItem): SafeHtml {
  if (item.count === null || item.count === undefined || item.count === "") return raw("");
  return html`<span class="count ${item.urgency ?? "quiet"}">${item.count}</span>`;
}

function railLink(item: RailItem): SafeHtml {
  const current = item.current ? raw(' aria-current="page"') : raw("");
  if (item.external) {
    return html`<a class="rail-link" href="${item.href}" target="_blank" rel="noopener"
      >${item.label}<span class="ext" aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a
    >`;
  }
  return html`<a class="rail-link" href="${item.href}"${current}><span>${item.label}</span>${railCount(item)}</a>`;
}

/**
 * The rail, and the drawer it becomes on a phone.
 *
 * It is a `<details>` for the same reason `.navmenu` was: a navigation that
 * needs a script to open is a navigation that is sometimes not there. Above
 * `64rem` the stylesheet forces the panel open and the summary stops being a
 * button and goes back to being the brand — the same markup, unfolded, which is
 * what keeps one rail from becoming two navigations that can disagree.
 */
function rail(c: ConsoleChrome): SafeHtml {
  return html`<details class="rail">
    <summary class="rail-brand">
      ${
        // The real lockup, white wordmark on the rail's near-black — the light
        // variant exists for exactly this ground (`brand/README.md`). Sized in
        // the markup as well as the stylesheet: the rail is the first thing
        // drawn and a brand row that changes height when the image lands moves
        // every destination under the reader's cursor.
        html`<img class="mark" src="/podium-logo-horizontal-light.png" alt="Podium" width="81" height="24">`
      }
      <span class="spacer"></span>
      <span class="toggle" aria-hidden="true">${MENU_ICON}</span>
      <span class="sr-only">Menu</span>
    </summary>
    <div class="rail-body">
      ${c.context ? railContext(c.context) : raw("")}
      <nav class="rail-nav" aria-label="Sections">
        ${c.groups.map(
          (g) => html`<div class="rail-group">
            ${g.label ? html`<p class="rail-group-label">${g.label}</p>` : raw("")}
            ${g.items.map(railLink)}
          </div>`,
        )}
      </nav>
      ${c.footer?.length ? html`<div class="rail-foot">${c.footer.map(railLink)}</div>` : raw("")}
    </div>
  </details>`;
}

function railContext(ctx: RailContext): SafeHtml {
  const name = ctx.href
    ? html`<a class="name" href="${ctx.href}">${ctx.name}</a>`
    : html`<span class="name">${ctx.name}</span>`;
  return html`<div class="rail-context">
    <div class="head">${ctx.live ? html`<span class="dot" aria-hidden="true"></span>` : raw("")}${name}</div>
    ${(ctx.lines ?? []).map((line) => html`<p>${line}</p>`)}
  </div>`;
}

function crumbs(items: Crumb[]): SafeHtml {
  if (items.length === 0) return raw("");
  return html`<nav class="crumbs" aria-label="Breadcrumb">
    ${items.map((c, i) =>
      html`${i > 0 ? html`<span class="sep" aria-hidden="true">/</span>` : raw("")}${c.href
        ? html`<a href="${c.href}">${c.label}</a>`
        : html`<span aria-current="page">${c.label}</span>`}`,
    )}
  </nav>`;
}

/**
 * The search affordance. A button, not a form: what it opens searches the rail
 * and the actions on this screen, not the database, so there is nothing to
 * submit and nowhere to submit it (see `public/keys.js`).
 *
 * With scripts blocked it does nothing, and that is the whole cost — every
 * destination behind it is a link in the rail two inches to the left, which is
 * why it is drawn at all rather than hidden until a script says otherwise.
 */
function searchButton(): SafeHtml {
  return html`<button type="button" class="omni" data-palette aria-haspopup="dialog">
    <span class="label">Search proposals, people, sessions</span>
    ${KEYCAP}
  </button>`;
}

/**
 * The ⌘K keycap, both ways round.
 *
 * The server cannot know which keyboard is in front of the reader, and the
 * console re-renders this button on every redraw — so a script that rewrote the
 * text once on load produced "Ctrl K⌘K" the moment the console drew it again.
 * Both labels ship; `public/keys.js` sets `data-platform` on `<html>` once and
 * the stylesheet hides the wrong one.
 */
const KEYCAP = raw(`<kbd><span class="on-mac">\u2318K</span><span class="on-pc">Ctrl K</span></kbd>`);

function keyHints(hints: KeyHint[]): SafeHtml {
  if (hints.length === 0) return raw("");
  return html`<p class="hints" data-hints>
    ${hints.map((h) => html`<span class="hint">${h.keys.map((k) => html`<kbd>${k}</kbd>`)}${h.label}</span>`)}
  </p>`;
}

function consoleShell(opts: PageOptions, c: ConsoleChrome, body: SafeHtml): SafeHtml {
  const width = opts.width === "narrow" ? "narrow" : opts.width === "wide" ? "wide" : "";
  return html`<div class="frame">
    ${rail(c)}
    <div class="workspace">
      <header class="bar">
        ${crumbs(c.crumbs ?? [])}
        <span class="spacer"></span>
        ${c.search === false ? raw("") : searchButton()}
        ${keyHints(c.hints ?? [])}
        ${c.status ? html`<span class="pill ${c.status.kind ?? ""}">${c.status.label}</span>` : raw("")}
      </header>
      <main class="${width}">
        ${flashBanner(opts)}
        ${body}
      </main>
    </div>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* the editorial shell                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One bar, one measure, one job. No tabs, no subnav and no event banner: a
 * speaker has one page and a reader has three, and a row of chrome sized for
 * fourteen sections is what made the old portal read as an admin tool that had
 * been let out.
 */
function editorialShell(opts: PageOptions, body: SafeHtml): SafeHtml {
  const width = opts.width === "wide" ? "wide" : opts.width === "narrow" ? "narrow" : "";
  const links = opts.nav ?? [];
  return html`<header class="sheet-bar">
    <a class="wordmark" href="${homeHref(opts)}">${opts.brand ?? "Podium"}</a>
    <span class="spacer"></span>
    <nav aria-label="Primary">
      ${links.map(navLink)}
      ${opts.who
        ? html`${opts.profile && !opts.profile.external
              ? html`<a href="${opts.profile.href}">${opts.profile.label}</a>`
              : raw("")}
            <form method="post" action="/logout"><button type="submit" class="linky">Sign out</button></form>`
        : html`<a href="/login">Sign in</a>`}
    </nav>
  </header>
  ${opts.banner ?? raw("")}
  <main class="${width}">
    ${flashBanner(opts)}
    ${body}
  </main>`;
}

/** The "leaves this tab" marker. Decorative — the label carries the meaning. */
const EXTERNAL_ICON = raw(
  `<svg class="ext" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H14v4.5"/><path d="M14 2 7.5 8.5"/><path d="M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/></svg>`,
);

/** The collapsed-menu affordance. Decorative — the label carries the meaning. */
const MENU_ICON = raw(
  `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 4h11"/><path d="M2.5 8h11"/><path d="M2.5 12h11"/></svg>`,
);

/** A link that opens in a new tab, announced as such rather than only drawn. */
export function externalLink(href: string, label: string, className = ""): SafeHtml {
  return html`<a href="${href}" target="_blank" rel="noopener" class="${className}"
    >${label}${EXTERNAL_ICON}<span class="sr-only"> (opens in a new tab)</span></a
  >`;
}

function navLink(n: NavItem): SafeHtml {
  const current = n.current ? raw(' aria-current="page"') : raw("");
  if (n.external) {
    return html`<a href="${n.href}" target="_blank" rel="noopener"
      >${n.label}${EXTERNAL_ICON}<span class="sr-only"> (opens in a new tab)</span></a
    >`;
  }
  return html`<a href="${n.href}"${current}>${n.label}</a>`;
}

/** Landing page of the surface you are on — the logo never leaves your mode. */
function homeHref(opts: PageOptions): string {
  if (opts.home) return opts.home;
  if (opts.surface === "admin") return "/admin";
  if (opts.surface === "portal") return "/portal";
  return "/";
}

/* -------------------------------------------------------------------------- */
/* components                                                                  */
/* -------------------------------------------------------------------------- */

export function pageHead(title: string, lede?: string | null, actions?: SafeHtml): SafeHtml {
  return html`<div class="page-head">
    <div class="grow">
      <h1>${title}</h1>
      ${lede ? html`<p class="lede">${lede}</p>` : raw("")}
    </div>
    ${actions ? html`<div class="actions">${actions}</div>` : raw("")}
  </div>`;
}

export function card(body: SafeHtml, title?: string, opts: { className?: string } = {}): SafeHtml {
  return html`<section class="card ${opts.className ?? ""}">${title ? html`<h2>${title}</h2>` : raw("")}${body}</section>`;
}

/**
 * Which day of the event you are looking at — the public schedule and the
 * agenda builder both need it and both used to build it by hand out of
 * `.subnav`, whose spacing lives on `nav > a` and not on its own children. The
 * days therefore rendered run together as one string ("Day 1 — WorkshopsDay
 * 2Day 3"). It is a segmented control, not a borrowed navigation.
 */
export function dayBar(days: { id: string; label: string }[], hrefFor: (id: string) => string, activeId: string | null): SafeHtml {
  if (days.length === 0) return raw("");
  return html`<nav class="daybar" aria-label="Day">
    ${days.map((d) => html`<a href="${hrefFor(d.id)}"${d.id === activeId ? raw(' aria-current="page"') : raw("")}>${d.label}</a>`)}
  </nav>`;
}

/**
 * The sort choices above a table. A row of targets with the current one filled
 * in, rather than a sentence of underlined words separated by middots — which
 * is what "Sort by newest · oldest · reference · title" was.
 */
export function sortBar(options: { href: string; label: string; current: boolean }[]): SafeHtml {
  if (options.length === 0) return raw("");
  return html`<div class="sortbar"><span>Sort by</span>
    ${options.map((o) => html`<a href="${o.href}"${o.current ? raw(' aria-current="true"') : raw("")}>${o.label}</a>`)}
  </div>`;
}

export function stat(label: string, value: unknown, href?: string): SafeHtml {
  const inner = html`<span class="n">${value}</span><span class="l">${label}</span>`;
  return href ? html`<a class="stat" href="${href}" style="text-decoration:none">${inner}</a>` : html`<div class="stat">${inner}</div>`;
}

export function empty(message: string): SafeHtml {
  return html`<p class="empty">${message}</p>`;
}

/**
 * `tall` makes the table its own vertical scroller, which is what activates the
 * sticky header — worth it only for a board long enough to lose its column
 * names while you read it. Everything else scrolls with the page.
 */
export function table(headers: (string | SafeHtml)[], rows: SafeHtml[], emptyMessage = "Nothing here yet.", opts: { tall?: boolean } = {}): SafeHtml {
  if (rows.length === 0) return empty(emptyMessage);
  return html`<div class="table-wrap ${opts.tall ? "tall" : ""}"><table>
    <thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

const BADGE_KIND: Record<string, string> = {
  // proposals
  draft: "",
  submitted: "info",
  in_review: "info",
  changes_requested: "warn",
  accepted: "ok",
  waitlisted: "warn",
  rejected: "err",
  withdrawn: "",
  expired: "err",
  // sessions
  pending_confirmation: "warn",
  confirmed: "ok",
  scheduled: "info",
  published: "ok",
  cancelled: "err",
  delivered: "",
  approved: "ok",
  // tasks
  not_started: "",
  blocked: "warn",
  in_progress: "info",
  completed: "ok",
  waived: "warn",
  overdue: "err",
  // generic
  active: "ok",
  open: "ok",
  closed: "",
  live: "ok",
  provisional: "warn",
  superseded: "",
  pending: "warn",
  declined: "err",
  revoked: "err",
  prospect: "",
  invited: "info",
  ai: "ai",
};

export function badge(value: string | null | undefined, override?: string): SafeHtml {
  if (!value) return raw("");
  const kind = override ?? BADGE_KIND[value] ?? "";
  return html`<span class="badge ${kind}">${humanise(value)}</span>`;
}

export function humanise(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function progressBar(percent: number): SafeHtml {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<div class="progress" title="${pct}%"><span style="width:${pct}%"></span></div>`;
}

export function avatar(name: string, url?: string | null, size = 84): SafeHtml {
  if (url) return html`<img class="avatar" src="${url}" alt="${name}" width="${size}" height="${size}" loading="lazy">`;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return html`<span class="avatar initials" style="width:${size}px;height:${size}px" aria-hidden="true">${initials}</span>`;
}

/* -------------------------------------------------------------------------- */
/* forms                                                                       */
/* -------------------------------------------------------------------------- */

export interface FieldOptions {
  name: string;
  label: string;
  value?: unknown;
  type?: string;
  required?: boolean;
  help?: string | null;
  placeholder?: string | null;
  options?: { value: string; label: string; description?: string | null }[];
  rows?: number;
  error?: string | null;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  multiple?: boolean;
  accept?: string;
  id?: string;
  attrs?: string;
  /**
   * Whether a required control also carries the HTML `required` attribute.
   * The submission wizard sets this false: it validates a step on the server
   * so the failure is a rendered, linkable message on the field rather than a
   * transient browser bubble that no screenshot and no screen reader history
   * can show — and so "Save draft" can save a page that is deliberately
   * incomplete.
   */
  validate?: boolean;
}

export function field(o: FieldOptions): SafeHtml {
  const id = o.id ?? `f_${o.name.replace(/[^\w]/g, "_")}`;
  const req = o.required ? raw(o.validate === false ? ' aria-required="true"' : ' required aria-required="true"') : raw("");
  const extra = o.attrs ? raw(" " + o.attrs) : raw("");
  let control: SafeHtml;
  if (o.type === "textarea") {
    control = html`<textarea id="${id}" name="${o.name}" rows="${o.rows ?? 6}" placeholder="${o.placeholder ?? ""}"${req}${extra}>${o.value ?? ""}</textarea>`;
  } else if (o.type === "select") {
    control = html`<select id="${id}" name="${o.name}"${req}${extra}>
      ${
        // A required select validated on the server still needs an empty first
        // option, or the browser preselects option one and "did not answer"
        // becomes indistinguishable from "chose the first track".
        o.required && o.validate !== false ? raw("") : html`<option value="">${o.required ? "— choose —" : "— none —"}</option>`
      }
      ${(o.options ?? []).map(
        (opt) =>
          html`<option value="${opt.value}"${String(o.value ?? "") === opt.value ? raw(" selected") : raw("")}>${opt.label}</option>`,
      )}
    </select>`;
  } else if (o.type === "multi_select") {
    control = html`<select id="${id}" name="${o.name}" multiple size="${Math.min(6, (o.options ?? []).length || 3)}"${extra}>
      ${(o.options ?? []).map((opt) => {
        const selected = Array.isArray(o.value) ? (o.value as string[]).includes(opt.value) : false;
        return html`<option value="${opt.value}"${selected ? raw(" selected") : raw("")}>${opt.label}</option>`;
      })}
    </select>`;
  } else if (o.type === "checkbox") {
    return html`<div class="field">
      <div class="checkline">
        <input type="checkbox" id="${id}" name="${o.name}" value="1"${o.value ? raw(" checked") : raw("")}${extra}>
        <label for="${id}">${o.label}${o.required ? html` <span class="req">*</span>` : raw("")}</label>
      </div>
      ${o.help ? html`<span class="help">${o.help}</span>` : raw("")}
      ${o.error ? html`<span class="field-error">${o.error}</span>` : raw("")}
    </div>`;
  } else if (o.type === "radio") {
    return html`<fieldset class="field">
      <legend>${o.label}${o.required ? html` <span class="req">*</span>` : raw("")}</legend>
      ${o.help ? html`<span class="help">${o.help}</span>` : raw("")}
      ${(o.options ?? []).map((opt, i) => {
        const rid = `${id}_${i}`;
        return html`<div class="checkline">
          <input type="radio" id="${rid}" name="${o.name}" value="${opt.value}"${String(o.value ?? "") === opt.value ? raw(" checked") : raw("")}>
          <label for="${rid}">${opt.label}${opt.description ? html` <span class="muted small">— ${opt.description}</span>` : raw("")}</label>
        </div>`;
      })}
      ${o.error ? html`<span class="field-error">${o.error}</span>` : raw("")}
    </fieldset>`;
  } else {
    const attrs: string[] = [];
    if (o.min !== undefined) attrs.push(`min="${escapeHtml(o.min)}"`);
    if (o.max !== undefined) attrs.push(`max="${escapeHtml(o.max)}"`);
    if (o.step !== undefined) attrs.push(`step="${escapeHtml(o.step)}"`);
    if (o.accept) attrs.push(`accept="${escapeHtml(o.accept)}"`);
    if (o.multiple) attrs.push("multiple");
    control = html`<input id="${id}" type="${o.type ?? "text"}" name="${o.name}" value="${o.value ?? ""}" placeholder="${o.placeholder ?? ""}"${raw(attrs.length ? " " + attrs.join(" ") : "")}${req}${extra}>`;
  }
  return html`<div class="field">
    <label for="${id}">${o.label}${o.required ? html` <span class="req">*</span>` : raw("")}</label>
    ${o.help ? html`<span class="help">${o.help}</span>` : raw("")}
    ${control}
    ${o.error ? html`<span class="field-error">${o.error}</span>` : raw("")}
  </div>`;
}

export function submitButton(label: string, className = ""): SafeHtml {
  return html`<button type="submit" class="${className}">${label}</button>`;
}

/**
 * The "add one of these" form under a table on a setup screen. Closed by
 * default: four of them permanently expanded is what made `/admin/events/:id/setup`
 * read as one endless form with tables interleaved rather than as four lists
 * you can add to.
 */
export function addForm(label: string, body: SafeHtml): SafeHtml {
  return html`<details class="disclosure row-form"><summary>${label}</summary>${body}</details>`;
}

/** A one-button POST, for state transitions that need no form. */
export function actionForm(action: string, label: string, opts: { className?: string; confirm?: string; hidden?: Record<string, string> } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="inline-form"${opts.confirm ? raw(` data-confirm="${escapeHtml(opts.confirm)}"`) : raw("")}>
    ${Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button type="submit" class="small ${opts.className ?? "secondary"}">${label}</button>
  </form>`;
}
