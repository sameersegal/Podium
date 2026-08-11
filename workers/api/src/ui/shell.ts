/**
 * Page shells. Every admin and portal screen renders through one of these so
 * navigation is identical everywhere and an event's context never disappears.
 */

import { str, type Row } from "@podiumconf/data/db.js";
import type { RequestContext } from "../http/context.js";
import { html, type SafeHtml } from "./html.js";
import { page, type NavItem } from "./layout.js";

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

export function adminNav(ev: EventRef | null, active: string): NavItem[] {
  if (!ev)
    return [
      { href: "/admin/events", label: "Events", current: active === "events" },
      { href: "/admin/contacts", label: "Contacts", current: active === "contacts" },
      { href: "/admin/sponsors", label: "Sponsors", current: active === "sponsors" },
      { href: "/admin/team", label: "Team", current: active === "team" },
      { href: "/admin/settings", label: "Settings", current: active === "settings" },
    ];
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

export interface ShellOptions {
  title: string;
  event?: EventRef | null;
  active?: string;
  width?: "narrow" | "default" | "wide";
}

export function adminPage(ctx: RequestContext, opts: ShellOptions, body: SafeHtml): SafeHtml {
  return page(
    {
      title: opts.title,
      surface: "admin",
      who: ctx.person ? `${ctx.person.display_name ?? ctx.person.full_name}` : null,
      width: opts.width,
      flash: ctx.flash,
      nav: [
        { href: "/admin", label: "Podium admin" },
        { href: "/admin/events", label: "Events" },
        { href: "/admin/contacts", label: "Contacts" },
        { href: "/admin/sponsors", label: "Sponsors" },
        { href: "/admin/team", label: "Team" },
        { href: "/admin/settings", label: "Settings" },
        { href: "/portal", label: "My portal" },
      ],
      subnav: adminNav(opts.event ?? null, opts.active ?? ""),
    },
    opts.event
      ? html`<p class="small muted" style="margin:-.5rem 0 1rem">
          Event: <strong>${opts.event.name}</strong> · ${opts.event.starts_on} → ${opts.event.ends_on} ·
          <span class="mono">${opts.event.timezone}</span> ·
          <a href="/e/${opts.event.slug}">public page</a>
        </p>${body}`
      : body,
  );
}

export function portalPage(ctx: RequestContext, opts: { title: string; width?: "narrow" | "default" | "wide"; active?: string }, body: SafeHtml): SafeHtml {
  const nav: NavItem[] = [
    { href: "/portal", label: "My dashboard", current: opts.active === "dashboard" },
    { href: "/portal/proposals", label: "My proposals", current: opts.active === "proposals" },
    { href: "/portal/sessions", label: "My sessions", current: opts.active === "sessions" },
    { href: "/portal/tasks", label: "My tasks", current: opts.active === "tasks" },
    { href: "/portal/profile", label: "My profile", current: opts.active === "profile" },
  ];
  if (ctx.isStaff()) nav.push({ href: "/admin", label: "Admin" });
  return page(
    {
      title: opts.title,
      surface: "portal",
      who: ctx.person ? `${ctx.person.display_name ?? ctx.person.full_name}` : null,
      width: opts.width,
      flash: ctx.flash,
      nav,
    },
    body,
  );
}

export function publicPage(ctx: RequestContext, opts: { title: string; event?: EventRef | null; width?: "narrow" | "default" | "wide"; head?: SafeHtml }, body: SafeHtml): SafeHtml {
  const nav: NavItem[] = opts.event
    ? [
        { href: `/e/${opts.event.slug}`, label: opts.event.name },
        { href: `/e/${opts.event.slug}/schedule`, label: "Schedule" },
        { href: `/e/${opts.event.slug}/speakers`, label: "Speakers" },
      ]
    : [{ href: "/", label: "Home" }];
  return page(
    {
      title: opts.title,
      surface: "public",
      who: ctx.person ? `${ctx.person.display_name ?? ctx.person.full_name}` : null,
      width: opts.width,
      flash: ctx.flash,
      nav,
      head: opts.head,
    },
    body,
  );
}
