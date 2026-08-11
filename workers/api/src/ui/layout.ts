import { html, raw, type SafeHtml, escapeHtml } from "./html.js";

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
}

const HEAD_ICONS = raw(`
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="stylesheet" href="/app.css">
`);

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
</body>
</html>`;
}

/** The "leaves this tab" marker. Decorative — the label carries the meaning. */
const EXTERNAL_ICON = raw(
  `<svg class="ext" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H14v4.5"/><path d="M14 2 7.5 8.5"/><path d="M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/></svg>`,
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

function topbar(opts: PageOptions): SafeHtml {
  const nav = opts.nav ?? defaultNav(opts.surface ?? "public");
  const profile = opts.profile ?? { href: "/portal/profile", label: "Profile" };
  return html`<header class="topbar">
    <a class="brand" href="${homeHref(opts)}"><img src="/podium-logo-horizontal-light.png" alt="Podium"></a>
    ${nav.length ? html`<nav class="tabs">${nav.map(navLink)}</nav>` : raw("")}
    <span class="spacer"></span>
    ${opts.who
      ? html`<details class="usermenu">
          <summary aria-haspopup="menu"><span class="who">${opts.who}</span></summary>
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

function subnav(items: NavItem[]): SafeHtml {
  return html`<nav class="subnav">${items.map(navLink)}</nav>`;
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

export function card(body: SafeHtml, title?: string): SafeHtml {
  return html`<section class="card">${title ? html`<h2>${title}</h2>` : raw("")}${body}</section>`;
}

export function stat(label: string, value: unknown, href?: string): SafeHtml {
  const inner = html`<span class="n">${value}</span><span class="l">${label}</span>`;
  return href ? html`<a class="stat" href="${href}" style="text-decoration:none">${inner}</a>` : html`<div class="stat">${inner}</div>`;
}

export function empty(message: string): SafeHtml {
  return html`<p class="empty">${message}</p>`;
}

export function table(headers: (string | SafeHtml)[], rows: SafeHtml[], emptyMessage = "Nothing here yet."): SafeHtml {
  if (rows.length === 0) return empty(emptyMessage);
  return html`<div class="table-wrap"><table>
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
}

export function field(o: FieldOptions): SafeHtml {
  const id = o.id ?? `f_${o.name.replace(/[^\w]/g, "_")}`;
  const req = o.required ? raw(' required aria-required="true"') : raw("");
  const extra = o.attrs ? raw(" " + o.attrs) : raw("");
  let control: SafeHtml;
  if (o.type === "textarea") {
    control = html`<textarea id="${id}" name="${o.name}" rows="${o.rows ?? 6}" placeholder="${o.placeholder ?? ""}"${req}${extra}>${o.value ?? ""}</textarea>`;
  } else if (o.type === "select") {
    control = html`<select id="${id}" name="${o.name}"${req}${extra}>
      ${o.required ? raw("") : html`<option value="">— none —</option>`}
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

/** A one-button POST, for state transitions that need no form. */
export function actionForm(action: string, label: string, opts: { className?: string; confirm?: string; hidden?: Record<string, string> } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="inline-form"${opts.confirm ? raw(` onsubmit="return confirm('${escapeHtml(opts.confirm)}')"`) : raw("")}>
    ${Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button type="submit" class="small ${opts.className ?? "secondary"}">${label}</button>
  </form>`;
}
