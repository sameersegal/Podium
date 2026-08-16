/**
 * Page shells. Every screen renders through one of these, so navigation is
 * identical everywhere and an event's context never disappears.
 *
 * There are two design languages here and they share nothing on purpose:
 *
 * - `adminPage` and `reviewerPage` are the **console** — a dark rail, phase-
 *   grouped navigation, mono numerals, keyboard accelerators. Two or three
 *   people are in it all day.
 * - `portalPage` and `publicPage` are the **program book** — serif, spacious,
 *   one job per page. A speaker visits three times a year; a reader once.
 *
 * The reviewer surface moved from the second to the first. It used to render
 * through `portalPage`, which made a reviewer's queue a tab of the speaker
 * portal — but a reviewer is doing operations work on a deadline, and the two
 * roles are frequently the *same person* wearing different hats. Sharing chrome
 * meant the hat was never stated. `/review` now has the console's rail and the
 * console's keyboard, and reaches the portal only through one quiet link that
 * says it is leaving.
 */

import { str, type Row } from "@podiumstack/data/db.js";
import { formatInZone } from "@podiumstack/domain/shared/time.js";
import type { RequestContext } from "../http/context.js";
import { html, raw, type SafeHtml } from "./html.js";
import { page, type ConsoleChrome, type Crumb, type KeyHint, type NavItem, type RailGroup, type RailItem } from "./layout.js";
import type { LiveOptions } from "./live.js";
import type { RailCounts } from "./rail-counts.js";

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

/* -------------------------------------------------------------------------- */
/* the rail                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The organization-wide settings screens. They are sections of one area, not
 * ten unrelated pages, so they get their own rail group — reaching them by a
 * row of links at the foot of `/admin/settings` left every one of them a dead
 * end.
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

/**
 * The settings area, as a column of its own between the rail and the form.
 *
 * These eleven screens are one area with eleven sections, so they need a
 * navigation — but taking the rail for it cost the reader everything else.
 * Opening a webhook should not remove Sessions, Speakers and the agenda from
 * the screen; the event you are running does not stop existing because you
 * went to look at an API key.
 *
 * So the rail stays the rail, and the sections become the second of three
 * columns. Below `64rem` it collapses to a `<details>` above the form, the
 * same pattern and the same reason as the rail's own drawer.
 */
function settingsShell(active: string, body: SafeHtml): SafeHtml {
  const current = SETTINGS_SECTIONS.find((s) => s.key === active);
  return html`<div class="settings-split">
    <details class="settings-nav">
      <summary><span class="sr-only">Settings section: </span>${current ? current.label : "Settings"}</summary>
      <nav aria-label="Settings sections">
        <p class="rail-group-label">Settings</p>
        ${SETTINGS_SECTIONS.map(
          (s) =>
            html`<a href="${s.href}"${s.key === active ? raw(' aria-current="page"') : raw("")}>${s.label}</a>`,
        )}
      </nav>
    </details>
    <div class="settings-body">${body}</div>
  </div>`;
}

/** Zero and null are different: a count of 0 is noise, so it is not drawn. */
function count(n: number | undefined, urgency: RailItem["urgency"] = "quiet"): Partial<RailItem> {
  if (!n) return {};
  return { count: n, urgency };
}

/**
 * The event's own workflow, in the order it happens.
 *
 * This replaces a flat row of fourteen section tabs. The destinations are the
 * same screens — nothing was dropped to make the grouping tidy — but they are
 * now ordered by phase of the event rather than alphabetically by whoever added
 * one last, so "where does this go next" is answerable by reading downwards.
 *
 * Two deliberate departures from the design handoff, both because the prototype
 * assumed a screen list this product does not have:
 *
 * - There is no **Inbox**. The prototype draws one with a count of 4; nothing in
 *   this application is an inbox, and inventing a screen to match a mock is the
 *   wrong direction for the arrow. The slot went to the event's own overview.
 * - **Sessions** and **Speakers** are two screens here, not the prototype's
 *   single "Sessions & speakers". A label promising both while linking to one
 *   is worse than two honest labels.
 */
export function adminRail(ev: EventRef | null, active: string, counts: RailCounts = {}): RailGroup[] {
  if (!ev) {
    return [
      {
        label: "Organization",
        items: [
          { href: "/admin", label: "Today", current: active === "today" },
          { href: "/admin/events", label: "Events", current: active === "events" },
          { href: "/admin/contacts", label: "Contacts", current: active === "contacts" },
          { href: "/admin/sponsors", label: "Sponsors", current: active === "sponsors" },
          { href: "/admin/team", label: "Team", current: active === "team" },
        ],
      },
    ];
  }
  const e = `/admin/events/${ev.id}`;
  return [
    {
      label: "Now",
      items: [
        { href: "/admin", label: "Today", current: active === "today", ...count(counts.today, "warn") },
        { href: e, label: "Overview", current: active === "overview" },
      ],
    },
    {
      label: "Intake",
      items: [
        { href: `${e}/cfps`, label: "Calls for papers", current: active === "cfp", ...count(counts.cfps) },
        { href: `${e}/proposals`, label: "Proposals", current: active === "proposals", ...count(counts.proposals) },
      ],
    },
    {
      label: "Decide",
      items: [
        { href: `${e}/review`, label: "Review", current: active === "review", ...count(counts.review) },
        { href: `${e}/decisions`, label: "Decisions", current: active === "decisions", ...count(counts.decisions, "warn") },
      ],
    },
    {
      label: "Program",
      items: [
        { href: `${e}/sessions`, label: "Sessions", current: active === "sessions", ...count(counts.sessions) },
        { href: `${e}/roster`, label: "Speakers", current: active === "roster" },
        { href: `${e}/onboarding`, label: "Onboarding", current: active === "onboarding", ...count(counts.onboarding, "danger") },
        {
          href: `${e}/schedule`,
          label: "Agenda",
          current: active === "schedule",
          ...(counts.agenda ? { count: counts.agenda } : {}),
        },
        {
          href: `${e}/publications`,
          label: "Publish",
          current: active === "publish",
          ...(counts.publish ? { count: counts.publish } : {}),
        },
      ],
    },
    {
      label: "Around it",
      items: [
        { href: `${e}/sponsorships`, label: "Sponsors", current: active === "sponsors" },
        { href: `${e}/campaigns`, label: "Messaging", current: active === "campaigns" },
        { href: `${e}/files`, label: "Files", current: active === "files" },
        { href: `${e}/setup`, label: "Setup", current: active === "setup" },
        { href: "/admin/contacts", label: "Contacts", current: active === "contacts" },
      ],
    },
  ];
}

/**
 * Marks the rail item the current path sits under, longest href first, so
 * `/admin/events/:id/proposals` lights up Proposals and not every prefix of it.
 * Explicit `current` flags win; this only fills in what a screen did not say.
 */
function markCurrent(path: string, groups: RailGroup[], stated: boolean): RailGroup[] {
  if (stated || groups.some((g) => g.items.some((i) => i.current))) return groups;
  let best: RailItem | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.external) continue;
      if (path !== item.href && !path.startsWith(item.href + "/")) continue;
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  if (!best) return groups;
  const winner = best;
  return groups.map((g) => ({ ...g, items: g.items.map((i) => (i === winner ? { ...i, current: true } : i)) }));
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function who(ctx: RequestContext): string | null {
  if (!ctx.person) return null;
  return ctx.person.display_name ?? ctx.person.full_name;
}

/** The rail's foot: the person, and the way out of the mode they are in. */
function railFooter(ctx: RequestContext, extra: RailItem[] = []): RailItem[] {
  const name = who(ctx);
  const items = [...extra];
  if (name) items.push({ href: "/portal/profile", label: name, external: true });
  return items;
}

/**
 * `14–16 Apr · 61 days out`, and the timezone under it.
 *
 * `starts_on` / `ends_on` are calendar dates in the event's own timezone and are
 * never converted (11, "Time"), so they are formatted from UTC midnight. "Days
 * out" is counted the same way, in whole days, because an organizer counting
 * down does not think in hours.
 */
function eventLines(ev: EventRef, now: string): string[] {
  // `12–14 May`, not `Wed, 12 May 2027 – Fri, 14 May 2027`. The rail is 244px
  // wide and this line sits under the event's own name, which has already said
  // which year it is; the long form wrapped to three lines and pushed the
  // navigation down by a row of chrome.
  const at = (d: string, opts: Intl.DateTimeFormatOptions) => formatInZone(`${d}T00:00:00Z`, "UTC", opts);
  const dayOnly: Intl.DateTimeFormatOptions = { day: "numeric" };
  const dayMonth: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const sameMonth = ev.starts_on.slice(0, 7) === ev.ends_on.slice(0, 7);
  const span =
    ev.starts_on === ev.ends_on
      ? at(ev.starts_on, dayMonth)
      : sameMonth
        ? `${at(ev.starts_on, dayOnly)}–${at(ev.ends_on, dayMonth)}`
        : `${at(ev.starts_on, dayMonth)} – ${at(ev.ends_on, dayMonth)}`;
  const days = Math.round((Date.parse(`${ev.starts_on}T00:00:00Z`) - Date.parse(now)) / 86_400_000);
  const distance = days > 0 ? `${days} days out` : days === 0 ? "today" : `${Math.abs(days)} days ago`;
  return [`${span} · ${distance}`, ev.timezone];
}

/** An event is "live" — the dot — on any day between its first and its last. */
function isRunning(ev: EventRef, now: string): boolean {
  const today = now.slice(0, 10);
  return today >= ev.starts_on && today <= ev.ends_on;
}

/* -------------------------------------------------------------------------- */
/* the shells                                                                  */
/* -------------------------------------------------------------------------- */

export interface ShellOptions {
  title: string;
  event?: EventRef | null;
  active?: string;
  width?: "narrow" | "default" | "wide";
  /** The breadcrumb, after the event's own name. Defaults to the page title. */
  crumbs?: Crumb[];
  /** The one piece of state worth the top bar's right edge. */
  status?: ConsoleChrome["status"];
  hints?: KeyHint[];
  /** Opt this screen into live updates — `ui/live.ts`. */
  live?: LiveOptions;
}

export function adminPage(ctx: RequestContext, opts: ShellOptions, body: SafeHtml): SafeHtml {
  const settings = isSettingsSection(opts.active ?? "");
  // The rail is drawn around an event even on the organization-wide screens.
  // A screen that names one wins; anything else falls back to the event the
  // request already resolved for the rail's counts, so Sessions and Speakers
  // do not vanish because the reader opened a webhook.
  const ev = opts.event ?? ctx.railEvent ?? null;
  // A settings screen is still organization-wide, so no event phase is current
  // in the rail and the event does not lead the breadcrumb.
  const groups = markCurrent(
    ctx.url.pathname,
    adminRail(ev, settings ? "" : (opts.active ?? ""), ctx.rail ?? {}),
    settings || Boolean(opts.active),
  );
  // The event no longer leads the trail. It is named in the rail's context card
  // — the first thing in the sidebar — and repeating it in the bar made "DevFlow
  // Conf 2027 / Review" out of a path with one real step in it. What is left is
  // a real parent or nothing, and `crumbs()` in `ui/layout.ts` draws nothing for
  // a trail of one: the `<h1>` under it already names the screen.
  const crumbs: Crumb[] = opts.crumbs ?? [
    // "Settings / Settings" is what a naive prefix produces on the area's own
    // landing screen, so the parent is dropped when the section is it.
    ...(settings && opts.title !== "Settings" ? [{ label: "Settings", href: "/admin/settings" }] : []),
    { label: opts.title },
  ];
  return page(
    {
      // The event is in the tab title too — admin and the portal are now two
      // open tabs, and "Proposals · Podium" twice over tells you nothing.
      title: !settings && ev ? `${opts.title} · ${ev.name}` : opts.title,
      surface: "admin",
      width: opts.width,
      flash: ctx.flash,
      console: {
        home: "/admin",
        // What the drawer's header says on a phone. See `rail()` in `layout.ts`.
        brand: ev?.name ?? null,
        context: ev
          ? {
              name: ev.name,
              href: `/admin/events/${ev.id}`,
              lines: eventLines(ev, ctx.now),
              live: isRunning(ev, ctx.now),
              // Every event the request already loaded for the rail. One event
              // is not a choice, so the switcher only appears when there is
              // something to switch to.
              switchTo: (ctx.railEvents ?? []).map((e) => ({
                id: e.id,
                name: e.name,
                status: e.status,
                current: e.id === ev.id,
              })),
            }
          : null,
        groups,
        // The footer names its own current item. Path matching is switched off
        // for these screens (`markCurrent`'s `stated`), so an org-wide screen
        // that did not say so lit nothing at all and the rail stopped answering
        // "where am I".
        footer: railFooter(ctx, [
          { href: "/admin/events", label: "All events", current: opts.active === "events" || undefined },
          { href: "/admin/team", label: "Team", current: opts.active === "team" || undefined },
          { href: "/admin/settings", label: "Settings", current: settings || undefined },
        ]),
        crumbs,
        status: opts.status ?? null,
        hints: opts.hints,
      },
      live: opts.live ? { eventId: opts.event?.id ?? null, ...opts.live } : undefined,
    },
    settings ? settingsShell(opts.active ?? "", body) : body,
  );
}

export interface ReviewerShellOptions {
  title: string;
  /** The round the reviewer is working in, named in the rail's context card. */
  round?: { name: string; lines: string[] } | null;
  active?: "queue" | "submitted" | "declined";
  counts?: { queue?: number; submitted?: number; declined?: number };
  crumbs?: Crumb[];
  hints?: KeyHint[];
  width?: "narrow" | "default" | "wide";
}

/**
 * The reviewer's own shell — the console's language, a rail of its own.
 *
 * Deliberately not `adminPage`: a reviewer is not staff (05 blinds them from
 * their peers, and `live.ts` tags their socket `role:member` for the same
 * reason), so a rail full of an organizer's phases would be a rail of links
 * that 403. Deliberately not `portalPage` either, which is what it was: see the
 * note at the top of this file.
 */
export function reviewerPage(ctx: RequestContext, opts: ReviewerShellOptions, body: SafeHtml): SafeHtml {
  const active = opts.active ?? "queue";
  const items: RailItem[] = [
    { href: "/review", label: "My queue", current: active === "queue", ...count(opts.counts?.queue, "warn") },
    { href: "/review?show=submitted", label: "Submitted", current: active === "submitted", ...count(opts.counts?.submitted) },
    { href: "/review?show=declined", label: "Declined", current: active === "declined", ...count(opts.counts?.declined) },
  ];
  return page(
    {
      title: opts.title,
      surface: "reviewer",
      width: opts.width,
      flash: ctx.flash,
      console: {
        home: "/review",
        context: opts.round ? { name: opts.round.name, lines: opts.round.lines } : null,
        groups: [{ items }, { items: [{ href: "/portal", label: "My speaker portal", external: true }] }],
        footer: railFooter(ctx),
        crumbs: opts.crumbs ?? [{ label: "Review", href: "/review" }, { label: opts.title }],
        // Nothing to search: a reviewer's whole world is the queue in front of
        // them, and a palette over three destinations is a menu pretending to
        // be a search box.
        search: false,
        hints: opts.hints,
      },
    },
    body,
  );
}

/**
 * The speaker portal. One page per talk, in the editorial language.
 *
 * The reviewer tab is gone from here. It used to be added for anyone with
 * `review.submit`, which is how the two surfaces came to share chrome; the way
 * to a reviewer's queue is now the same as the way to anything else you are not
 * currently doing — a link that says it is leaving.
 */
export function portalPage(
  ctx: RequestContext,
  opts: { title: string; width?: "narrow" | "default" | "wide"; active?: string },
  body: SafeHtml,
): SafeHtml {
  // One tab for the reader's talks, not three. R13 keeps `Proposal` and
  // `Session` separate in the model and presents them as one record; a
  // Dashboard that summarised both plus a Proposals tab and a Sessions tab
  // holding the same talks was the leak R13 says must not happen.
  const nav: NavItem[] = [
    {
      href: "/portal",
      label: "Your talks",
      current: opts.active === "sessions" || opts.active === "proposals" || opts.active === "dashboard",
    },
  ];
  if (ctx.canWrite("review.submit")) nav.push({ href: "/review", label: "Reviewing", external: true });
  if (ctx.isStaff()) nav.push({ href: "/admin", label: "Admin", external: true });
  return page(
    {
      title: opts.title,
      surface: "portal",
      brand: "Podium",
      who: who(ctx),
      profile: { href: "/portal/profile", label: "Profile" },
      width: opts.width,
      flash: ctx.flash,
      nav,
    },
    body,
  );
}

export function publicPage(
  ctx: RequestContext,
  opts: {
    title: string;
    event?: EventRef | null;
    width?: "narrow" | "default" | "wide";
    head?: SafeHtml;
    /**
     * Links only some public pages can offer. "Submit a talk" is the one that
     * matters: whether a call is open is a query, and the landing page is the
     * only public screen that has already run it. A bar advertising a closed
     * call is worse than a bar that leaves the reader to the page that knows.
     */
    extraNav?: NavItem[];
  },
  body: SafeHtml,
): SafeHtml {
  // No "Home" item: the wordmark is the way home on every surface, and two
  // links to the same page in one bar is one link too many.
  const nav: NavItem[] = opts.event
    ? [
        { href: `/e/${opts.event.slug}/schedule`, label: "Schedule" },
        { href: `/e/${opts.event.slug}/speakers`, label: "Speakers" },
        ...(opts.extraNav ?? []),
      ]
    : (opts.extraNav ?? []);
  return page(
    {
      title: opts.title,
      surface: "public",
      brand: opts.event ? opts.event.name : "Podium",
      home: opts.event ? `/e/${opts.event.slug}` : "/",
      who: who(ctx),
      profile: { href: "/portal/profile", label: "Profile" },
      width: opts.width ?? "wide",
      flash: ctx.flash,
      nav,
      head: opts.head,
    },
    body,
  );
}

