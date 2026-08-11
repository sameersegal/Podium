import { html, raw, type SafeHtml, escapeHtml } from "./html.js";

export interface NavItem {
  href: string;
  label: string;
  current?: boolean;
}

export interface PageOptions {
  title: string;
  /** `admin` · `portal` · `public` — drives the top bar. */
  surface?: "admin" | "portal" | "public" | "auth";
  subnav?: NavItem[];
  nav?: NavItem[];
  who?: string | null;
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
  ${opts.subnav?.length ? subnav(opts.subnav) : raw("")}
  <main class="${width}">
    ${opts.flash ? html`<div class="flash ${opts.flash.kind}" role="status">${opts.flash.message}</div>` : raw("")}
    ${body}
  </main>
</body>
</html>`;
}

function topbar(opts: PageOptions): SafeHtml {
  const nav = opts.nav ?? defaultNav(opts.surface ?? "public");
  return html`<header class="topbar">
    <a class="brand" href="/"><img src="/podium-logo-horizontal-light.png" alt="Podium"></a>
    ${nav.map((n) => html`<a href="${n.href}"${n.current ? raw(' aria-current="page"') : raw("")}>${n.label}</a>`)}
    <span class="spacer"></span>
    ${opts.who
      ? html`<span class="who">${opts.who}</span>
          <form method="post" action="/logout" class="inline-form"><button class="secondary small" type="submit">Sign out</button></form>`
      : html`<a href="/login">Sign in</a>`}
  </header>`;
}

function subnav(items: NavItem[]): SafeHtml {
  return html`<nav class="subnav">${items.map(
    (n) => html`<a href="${n.href}"${n.current ? raw(' aria-current="page"') : raw("")}>${n.label}</a>`,
  )}</nav>`;
}

function defaultNav(surface: PageOptions["surface"]): NavItem[] {
  if (surface === "admin")
    return [
      { href: "/admin", label: "Dashboard" },
      { href: "/portal", label: "Speaker portal" },
    ];
  if (surface === "portal")
    return [
      { href: "/portal", label: "My dashboard" },
      { href: "/portal/profile", label: "My profile" },
    ];
  return [{ href: "/", label: "Home" }];
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
