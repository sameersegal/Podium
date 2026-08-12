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

export interface PageOptions {
  title: string;
  /** `admin` · `portal` · `public` — drives the top bar. */
  surface?: "admin" | "portal" | "public" | "auth";
  subnav?: NavItem[];
  nav?: NavItem[];
  who?: string | null;
  /** Where the account menu's "Profile" points. Defaults to the portal profile. */
  profile?: NavItem;
  /** The brand link. Defaults to the landing page of the current surface. */
  home?: string;
  /** Rendered between the top bar and the subnav — the admin event bar. */
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
  <link rel="stylesheet" href="/app.css">
`);

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

export function page(opts: PageOptions, body: SafeHtml): SafeHtml {
  const width = opts.width === "narrow" ? "narrow" : opts.width === "wide" ? "wide" : "";
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title} · Podium</title>
  ${HEAD_ICONS}
  ${opts.head ?? raw("")}
</head>
<body class="${opts.bodyClass ?? ""}">
  ${topbar(opts)}
  ${opts.banner ?? raw("")}
  ${opts.subnav?.length ? subnav(opts.subnav) : raw("")}
  <main class="${width}">
    ${opts.flash ? html`<div class="flash ${opts.flash.kind}" role="status">${opts.flash.message}</div>` : raw("")}
    ${body}
  </main>
  ${opts.live ? liveRegion(opts.live) : raw("")}
  ${CONFIRM_SCRIPT}
</body>
</html>`;
}

/** The "leaves this tab" marker. Decorative — the label carries the meaning. */
const EXTERNAL_ICON = raw(
  `<svg class="ext" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H14v4.5"/><path d="M14 2 7.5 8.5"/><path d="M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/></svg>`,
);

/** The collapsed-menu affordance. Decorative — the label carries the meaning. */
const MENU_ICON = raw(
  `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 4h11"/><path d="M2.5 8h11"/><path d="M2.5 12h11"/></svg>`,
);

/**
 * Stands in for the account name once the bar is too narrow to spend a third of
 * itself on it. Decorative: the name stays in the summary as text, hidden the
 * way `.sr-only` hides things, so the button is still called by the person's
 * name when it is read aloud.
 */
const USER_ICON = raw(
  `<svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="5.3" r="2.7"/><path d="M2.9 13.5a5.1 5.1 0 0 1 10.2 0"/></svg>`,
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

/**
 * The primary tabs, behind one button on a small screen. Six tabs, a logo and
 * an account menu do not fit on a phone, and letting them wrap spent three rows
 * of chrome before the page began. A `<details>`, like the account menu, so it
 * opens with scripts blocked (08, "Degrade gracefully"); `app.css` unfolds it
 * back into a row once the row fits.
 *
 * Collapsed, it is labelled with the tab you are on rather than the word
 * "Menu" — the same reason the section menu names its section. A row of tabs
 * says where you are by which one is filled in; a button that says "Menu"
 * throws that away exactly where there is least room to work it out again.
 */
function primaryNav(items: NavItem[]): SafeHtml {
  const current = items.find((n) => n.current);
  return html`<details class="navmenu">
    <summary>${MENU_ICON}${current ? html`<span class="sr-only">Menu: </span><span>${current.label}</span>` : html`<span>Menu</span>`}</summary>
    <nav class="tabs" aria-label="Primary">${items.map(navLink)}</nav>
  </details>`;
}

function topbar(opts: PageOptions): SafeHtml {
  const nav = opts.nav ?? defaultNav(opts.surface ?? "public");
  const profile = opts.profile ?? { href: "/portal/profile", label: "Profile" };
  return html`<header class="topbar">
    <a class="brand" href="${homeHref(opts)}"><img src="/podium-logo-horizontal-light.png" alt="Podium" width="81" height="24"></a>
    ${nav.length ? primaryNav(nav) : raw("")}
    <span class="spacer"></span>
    ${opts.who
      ? html`<details class="usermenu">
          <summary aria-haspopup="menu">${USER_ICON}<span class="who">${opts.who}</span></summary>
          <div class="menu" role="menu">
            <p class="menu-head">${opts.who}</p>
            ${profile.external
              ? externalLink(profile.href, profile.label)
              : html`<a href="${profile.href}">${profile.label}</a>`}
            <form method="post" action="/logout"><button class="secondary small" type="submit">Sign out</button></form>
          </div>
        </details>`
      : html`<a href="/login">Sign in</a>`}
  </header>`;
}

/**
 * The section row, collapsed the same way and for the same reason — an event
 * has fourteen sections, which wrapped to four rows on a phone. The summary
 * names the section you are in, so the collapsed state still answers "where am
 * I" rather than only "there is a menu here".
 */
function subnav(items: NavItem[]): SafeHtml {
  const current = items.find((n) => n.current);
  return html`<details class="subnav">
    <summary><span class="sr-only">Section: </span>${current ? current.label : "Sections"}</summary>
    <nav aria-label="Sections">${items.map(navLink)}</nav>
  </details>`;
}

function defaultNav(surface: PageOptions["surface"]): NavItem[] {
  if (surface === "admin") return [{ href: "/portal", label: "Speaker portal", external: true }];
  if (surface === "portal") return [{ href: "/portal", label: "My dashboard" }];
  return [];
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
