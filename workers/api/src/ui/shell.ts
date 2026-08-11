/**
 * Page shells. Every admin and portal screen renders through one of these so
 * navigation is identical everywhere and an event's context never disappears.
 */

import { str, type Row } from "@podiumconf/data/db.js";
import type { RequestContext } from "../http/context.js";
import { html, raw, type SafeHtml } from "./html.js";
import { badge, externalLink, page, type NavItem } from "./layout.js";
import type { LiveOptions } from "./live.js";

export interface EventRef {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: string;
  starts_on: string;
  ends_on: string;
}

export function toEventRef(row: Row): EventRef {
  return {
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    timezone: str(row.timezone, "UTC"),
    status: str(row.status),
    starts_on: str(row.starts_on),
    ends_on: str(row.ends_on),
  };
}

export async function loadEvent(ctx: RequestContext, idOrSlug: string): Promise<EventRef | null> {
  const app = ctx.app();
  const byId = idOrSlug.startsWith("evt_") ? await app.db.byId<Row>("event", idOrSlug) : null;
  const row = byId ?? (await app.db.first<Row>("event", { slug: idOrSlug }));
  return row ? toEventRef(row) : null;
}

export async function currentEvent(ctx: RequestContext): Promise<EventRef | null> {
  if (ctx.eventId) return loadEvent(ctx, ctx.eventId);
  const app = ctx.app();
  const rows = await app.db.select<Row>("event", {}, { orderBy: "created_at DESC", limit: 1 });
  return rows[0] ? toEventRef(rows[0]) : null;
}

/**
 * The organization-wide settings screens. They are sections of one area, not
 * ten unrelated pages, so they get a subnav of their own — reaching them by a
 * row of links at the foot of `/admin/settings` left every one of them a
 * dead end.
 */
const SETTINGS_SECTIONS: { key: string; href: string; label: string }[] = [
  { key: "settings", href: "/admin/settings", label: "Organization" },
  { key: "custom-fields", href: "/admin/custom-fields", label: "Custom fields" },
  { key: "templates", href: "/admin/templates", label: "Templates" },
  { key: "integrations", href: "/admin/integrations", label: "Integrations" },
  { key: "api-keys", href: "/admin/api-keys", label: "API keys" },
  { key: "webhooks", href: "/admin/webhooks", label: "Webhooks" },
  { key: "imports", href: "/admin/imports", label: "Imports" },
  { key: "exports", href: "/admin/exports", label: "Exports" },
  { key: "outbox", href: "/admin/outbox", label: "Outbox" },
  { key: "audit", href: "/admin/audit", label: "Audit log" },
  // Read-only over `domain_event_record` + `event_reaction_log` — a sibling
  // of the audit log, not a replacement for it: audit is "what an actor did
  // to an entity", this is "what fact was recorded and what it caused"
  // (10-domain-events.md). Gated on the same `audit.read` permission.
  { key: "event-log", href: "/admin/event-log", label: "Event log" },
];

export function isSettingsSection(active: string): boolean {
  return SETTINGS_SECTIONS.some((s) => s.key === active);
}

export function settingsNav(active: string): NavItem[] {
  return SETTINGS_SECTIONS.map((s) => ({ href: s.href, label: s.label, current: active === s.key }));
}

export function adminNav(ev: EventRef | null, active: string): NavItem[] {
  // A settings section keeps the settings subnav even while an event is in
  // context: these screens are organization-wide, and the event subnav would
  // navigate away from the area the reader is in.
  if (isSettingsSection(active)) return settingsNav(active);
  // Organization-wide screens have no second row: it used to repeat the top
  // bar link for link, which reads as two navigations that disagree.
  if (!ev) return [];
  const e = `/admin/events/${ev.id}`;
  return [
    { href: e, label: "Overview", current: active === "overview" },
    { href: `${e}/setup`, label: "Setup", current: active === "setup" },
    { href: `${e}/cfps`, label: "Call for papers", current: active === "cfp" },
    { href: `${e}/proposals`, label: "Proposals", current: active === "proposals" },
    { href: `${e}/review`, label: "Review", current: active === "review" },
    { href: `${e}/decisions`, label: "Decisions", current: active === "decisions" },
    { href: `${e}/sessions`, label: "Sessions", current: active === "sessions" },
    { href: `${e}/roster`, label: "Speakers", current: active === "roster" },
    { href: `${e}/onboarding`, label: "Onboarding", current: active === "onboarding" },
    { href: `${e}/files`, label: "Files", current: active === "files" },
    { href: `${e}/schedule`, label: "Agenda", current: active === "schedule" },
    { href: `${e}/publications`, label: "Publish", current: active === "publish" },
    { href: `${e}/sponsorships`, label: "Sponsors", current: active === "sponsors" },
    { href: `${e}/campaigns`, label: "Messaging", current: active === "campaigns" },
  ];
}

/**
 * Highlights the item the current path sits under, longest href first, so
 * `/admin/events/:id/proposals` lights up "Events" and not every prefix of it.
 * Explicit `current` flags win; this only fills in what a screen did not say.
 */
function markCurrent(path: string, items: NavItem[], stated = false): NavItem[] {
  // `stated` means the screen named its own tab. If it named one that is not in
  // this row — the profile, which lives in the account menu — no tab is current,
  // and guessing from the path would light up the row's shortest prefix.
  if (stated || items.some((n) => n.current)) return items;
  let best: NavItem | null = null;
  for (const n of items) {
    if (n.external) continue;
    if (path !== n.href && !path.startsWith(n.href + "/")) continue;
    if (!best || n.href.length > best.href.length) best = n;
  }
  return best ? items.map((n) => (n === best ? { ...n, current: true } : n)) : items;
}

/** The event every event-scoped admin screen is acting on, stated once. */
function eventBar(ev: EventRef): SafeHtml {
  return html`<div class="eventbar">
    <a class="name" href="/admin/events/${ev.id}">${ev.name}</a>
    ${badge(ev.status)}
    <span class="meta">${ev.starts_on} → ${ev.ends_on} · <span class="mono">${ev.timezone}</span></span>
    <span class="spacer"></span>
    ${externalLink(`/e/${ev.slug}`, "Public page")}
  </div>`;
}

export interface ShellOptions {
  title: string;
  event?: EventRef | null;
  active?: string;
  width?: "narrow" | "default" | "wide";
  /** Opt this screen into live updates — `ui/live.ts`. */
  live?: LiveOptions;
}

export function adminPage(ctx: RequestContext, opts: ShellOptions, body: SafeHtml): SafeHtml {
  // A settings screen is organization-wide even when an event is loaded, so it
  // neither claims the Events tab nor flies an event's banner.
  const ev = isSettingsSection(opts.active ?? "") ? null : (opts.event ?? null);
  return page(
    {
      // The event is in the tab title too — admin and the portal are now two
      // open tabs, and "Proposals · Podium" twice over tells you nothing.
      title: ev ? `${opts.title} · ${ev.name}` : opts.title,
      surface: "admin",
      who: ctx.person ? `${ctx.person.display_name ?? ctx.person.full_name}` : null,
      // The profile lives in the portal, so reaching it from admin is a mode
      // switch like any other and gets the same new-tab treatment.
      profile: { href: "/portal/profile", label: "Profile", external: true },
      width: opts.width,
      flash: ctx.flash,
      nav: markCurrent(ctx.url.pathname, [
        // An event-scoped screen belongs to Events however flat its own URL is
        // (`/admin/proposals/:id` is one), so the event decides the tab.
        { href: "/admin/events", label: "Events", current: ev ? true : undefined },
        { href: "/admin/contacts", label: "Contacts" },
        { href: "/admin/sponsors", label: "Sponsors" },
        { href: "/admin/team", label: "Team" },
        { href: "/admin/settings", label: "Settings" },
        { href: "/portal", label: "Speaker portal", external: true },
      ]),
      banner: ev ? eventBar(ev) : raw(""),
      subnav: markCurrent(ctx.url.pathname, adminNav(ev, opts.active ?? ""), Boolean(opts.active)),
      // The room defaults to the event this screen is already on, so a caller
      // opting in rarely has to name it.
      live: opts.live ? { eventId: opts.event?.id ?? null, ...opts.live } : undefined,
    },
    body,
  );
}

export function portalPage(ctx: RequestContext, opts: { title: string; width?: "narrow" | "default" | "wide"; active?: string }, body: SafeHtml): SafeHtml {
  const nav: NavItem[] = [
    { href: "/portal", label: "Dashboard", current: opts.active === "dashboard" },
    { href: "/portal/proposals", label: "Proposals", current: opts.active === "proposals" },
    { href: "/portal/sessions", label: "Sessions", current: opts.active === "sessions" },
    { href: "/portal/tasks", label: "Tasks", current: opts.active === "tasks" },
  ];
  // The reviewer surface is part of the portal, not a separate mode: without a
  // tab, a reviewer could only reach their queue from the email that sent them.
  if (ctx.canWrite("review.submit")) nav.push({ href: "/review", label: "Reviews", current: opts.active === "reviews" });
  if (ctx.isStaff()) nav.push({ href: "/admin", label: "Admin", external: true });
  return page(
    {
      title: opts.title,
      surface: "portal",
      who: ctx.person ? `${ctx.person.display_name ?? ctx.person.full_name}` : null,
      profile: { href: "/portal/profile", label: "Profile" },
      width: opts.width,
      flash: ctx.flash,
      nav: markCurrent(ctx.url.pathname, nav, Boolean(opts.active)),
    },
    body,
  );
}

export function publicPage(ctx: RequestContext, opts: { title: string; event?: EventRef | null; width?: "narrow" | "default" | "wide"; head?: SafeHtml }, body: SafeHtml): SafeHtml {
  // No "Home" item: the logo is the way home on every surface, and two links
  // to the same page in one bar is one link too many.
  const nav: NavItem[] = opts.event
    ? markCurrent(ctx.url.pathname, [
        { href: `/e/${opts.event.slug}`, label: opts.event.name },
        { href: `/e/${opts.event.slug}/schedule`, label: "Schedule" },
        { href: `/e/${opts.event.slug}/speakers`, label: "Speakers" },
      ])
    : [];
  return page(
    {
      title: opts.title,
      surface: "public",
      who: ctx.person ? `${ctx.person.display_name ?? ctx.person.full_name}` : null,
      profile: { href: "/portal/profile", label: "Profile" },
      width: opts.width,
      flash: ctx.flash,
      nav,
      head: opts.head,
    },
    body,
  );
}
