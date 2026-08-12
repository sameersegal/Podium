/**
 * The public surface (08, "The embed (J10)") — everything an anonymous
 * visitor reads: an event's landing page, its calls for proposals, the
 * published schedule (agenda grid + itinerary + search, client-side, over the
 * snapshot), speakers, session detail, ICS, and the embed in its six widget
 * types and seven formats.
 *
 * Anonymous and complete, always (INV-08-13) — nothing here calls
 * `ctx.requireRead`/`requirePerson`. Program data comes only from the `live`
 * publication, served from the KV snapshot cache (INV-09-6); `event`,
 * `call_for_proposals` and `venue` are Event Configuration's own tables, not
 * "live program tables", and are read directly the same way
 * `publicCfpView` already does.
 */

import { str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { derivedCfpStatus, publicCfpView, renderPublicForm, withDuration } from "../contexts/event-config/views.js";
import { buildIcs } from "../contexts/scheduling/ics.js";
import { embedByKey, type EmbedConfigRow } from "../contexts/scheduling/views.js";
import { buildSnapshot, liveSnapshot, snapshotById } from "../contexts/scheduling/publication.js";
import type { ScheduleSnapshot } from "@podiumconf/domain/scheduling/publication.js";
import {
  applyFieldAllowlist,
  applyFilters,
  corsHeaders,
  frameAncestorsHeader,
  renderAgendaGrid,
  renderItinerary,
  renderSessionDetail,
  renderSessionsList,
  renderSpeakerDetail,
  renderSpeakerGallery,
  renderSpeakersList,
  renderWidgetHtml,
  widgetRss,
  widgetXml,
  type RenderOptions,
} from "../contexts/scheduling/widgets.js";
import { calendarDateInZone, formatDateInZone, formatInZone } from "@podiumconf/domain/shared/time.js";
import type { RequestContext } from "../http/context.js";
import { htmlResponse, json, text } from "../http/responses.js";
import type { Router } from "../http/router.js";
import { html, jsonScript, prose, raw, type SafeHtml } from "../ui/html.js";
import { card, dayBar, empty, pageHead } from "../ui/layout.js";
import { publicPage, type EventRef } from "../ui/shell.js";

/* -------------------------------------------------------------------------- */
/* Shared lookups                                                              */
/* -------------------------------------------------------------------------- */

function baseUrl(ctx: RequestContext): string {
  return str(ctx.env.PUBLIC_BASE_URL) || ctx.url.origin;
}

/** A `draft` or `private` event has no public surface at all. */
function isPubliclyVisible(row: Row): boolean {
  return str(row.visibility) === "public" && str(row.status) !== "draft";
}

async function resolvePublicEvent(ctx: RequestContext, slug: string): Promise<Row | null> {
  const row = await ctx.app().db.first<Row>("event", { slug });
  if (!row || !isPubliclyVisible(row)) return null;
  return row;
}

function toRef(row: Row): EventRef {
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

async function assetUrl(ctx: RequestContext, assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const asset = await ctx.app().db.byId<Row>("asset", assetId);
  // `/assets/:assetId` — keyed by id, not by the R2 `storage_key`, which is
  // where the bytes live and was never itself a routable path.
  return asset ? `/assets/${str(asset.id)}` : null;
}

export function registerPublicRoutes(router: Router<RequestContext>): void {
  registerLandingRoutes(router);
  registerScheduleRoutes(router);
  registerEmbedRoutes(router);
  registerPublicApiRoutes(router);
}

/* -------------------------------------------------------------------------- */
/* Landing + CFP                                                              */
/* -------------------------------------------------------------------------- */

function registerLandingRoutes(router: Router<RequestContext>): void {
  router.get("/e/:eventSlug", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    return htmlResponse(await renderEventLanding(ctx, row));
  });

  router.get("/e/:eventSlug/cfp/:cfpSlug", async (_req, ctx, params) => {
    const view = await publicCfpView(ctx.app(), params.cfpSlug, { eventSlug: params.eventSlug });
    // INV-02-12 — every derived status including `closed` renders; never 404
    // a link that once worked.
    if (!view) return notFoundPage(ctx, "No such call for proposals.");
    const ref: EventRef = { id: "", name: view.event.name, slug: view.event.slug, timezone: view.event.timezone, status: "active", starts_on: view.event.starts_on, ends_on: view.event.ends_on };
    const deadline = view.cfp.status === "open" ? html`<p class="notice info">Open — closes ${formatInZone(view.cfp.closes_at, view.event.timezone)} (${view.event.timezone}).</p>` : raw("");
    const closed = view.cfp.status === "closed" ? html`<p class="notice warn">This call closed ${formatInZone(view.cfp.closes_at, view.event.timezone)}. Thanks to everyone who submitted.</p>` : raw("");
    const notYetOpen = view.cfp.status === "scheduled" ? html`<p class="notice info">Opens ${formatInZone(view.cfp.opens_at, view.event.timezone)} (${view.event.timezone}).</p>` : raw("");

    return htmlResponse(
      publicPage(
        ctx,
        { title: view.cfp.name, event: ref, width: "narrow" },
        html`${pageHead(view.cfp.name, view.event.tagline)}
          ${deadline}${closed}${notYetOpen}
          ${view.cfp.intro_markdown ? card(prose(view.cfp.intro_markdown)) : raw("")}
          ${view.tracks.length || view.formats.length
            ? card(
                html`${view.tracks.length ? html`<p><strong>Tracks:</strong> ${view.tracks.map((t) => t.name).join(", ")}</p>` : raw("")}
                  ${view.formats.length ? html`<p><strong>Formats:</strong> ${view.formats.map((f) => withDuration(f.name, f.default_duration_minutes)).join(", ")}</p>` : raw("")}
                  ${view.cfp.guidelines_url ? html`<p><a href="${view.cfp.guidelines_url}">Submission guidelines</a></p>` : raw("")}`,
                "What we're looking for",
              )
            : raw("")}
          ${view.form
            ? card(
                html`<p class="muted small">
                    The form, inspectable before you sign up — try the dropdowns; nothing here is saved until you start a
                    submission.
                  </p>
                  ${
                    // No tracks/formats passed: `publicCfpView` already resolved every
                    // picker against the real ids, and the conditional rules are keyed to
                    // those same ids, so re-resolving here against a synthetic list would
                    // stop "show when format is Workshop" from ever matching.
                    renderPublicForm(view.form, {})
                  }
                  ${view.cfp.status === "open"
                    ? html`<a class="btn" href="/login?next=${encodeURIComponent(`/portal/proposals/new?cfp=${view.cfp.slug}`)}">Start a submission</a>`
                    : raw("")}`,
                "Submission form",
              )
            : raw("")}`,
      ),
    );
  });
}

/** Shared by `GET /e/:slug` and `GET /` when exactly one public event exists. */
export async function renderEventLanding(ctx: RequestContext, row: Row): Promise<SafeHtml> {
  const ref = toRef(row);
  const app = ctx.app();
  const [cfps, venue, logoUrl] = await Promise.all([
    app.db.select<Row>("call_for_proposals", { event_id: ref.id }, { orderBy: "opens_at" }),
    row.venue_id ? app.db.byId<Row>("venue", str(row.venue_id)) : Promise.resolve(null),
    assetUrl(ctx, strOrNull(row.logo_asset_id)),
  ]);

  const openCfps: SafeHtml[] = [];
  for (const c of cfps) {
    const status = await derivedCfpStatus(app, c, row);
    if (status !== "open" && status !== "scheduled") continue;
    openCfps.push(html`<li>
      <a href="/e/${ref.slug}/cfp/${str(c.slug)}"><strong>${str(c.name)}</strong></a>
      — ${status === "open" ? html`closes ${formatInZone(str(c.closes_at), ref.timezone)}` : html`opens ${formatInZone(str(c.opens_at), ref.timezone)}`}
    </li>`);
  }

  const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);

  return publicPage(
    ctx,
    { title: ref.name, event: ref },
    // `.bleed` cancels `main`'s gutter so the hero is a band across the window.
    // It used to open a second `<main>` for the body under it, which is invalid
    // — the shell already opened one — and rendered the hero as a boxed panel
    // floating inside the page rather than as the top of it.
    html`<section class="hero bleed"><div class="inner">
        ${logoUrl ? html`<img src="${logoUrl}" alt="${ref.name}" style="height:48px;margin-bottom:1rem">` : raw("")}
        <h1>${ref.name}</h1>
        ${row.tagline ? html`<p>${str(row.tagline)}</p>` : raw("")}
        <p>${formatDateInZone(new Date(`${ref.starts_on}T00:00:00Z`).toISOString(), ref.timezone)} – ${formatDateInZone(new Date(`${ref.ends_on}T00:00:00Z`).toISOString(), ref.timezone)}${venue ? html` · ${str(venue.name)}` : raw("")}</p>
        <p class="actions">
          <a class="btn" href="/e/${ref.slug}/schedule">Schedule</a>
          <a class="btn secondary" href="/e/${ref.slug}/sessions">Sessions</a>
          <a class="btn secondary" href="/e/${ref.slug}/speakers">Speakers</a>
          <a class="btn secondary" href="/e/${ref.slug}/gallery">Speaker gallery</a>
          ${openCfps.length ? html`<a class="btn secondary" href="#cfps">Submit a talk</a>` : raw("")}
          <a class="btn secondary" href="/login">Sign in</a>
        </p>
      </div></section>
      <div class="grid two">
        <div>
          ${row.description ? card(prose(str(row.description))) : raw("")}
          ${snapshot
            ? card(html`<p>${snapshot.sessions.length} sessions across ${snapshot.event.days.length} day${snapshot.event.days.length === 1 ? "" : "s"}.</p>
                <p class="actions"><a class="btn secondary" href="/e/${ref.slug}/schedule">View the schedule</a><a class="btn secondary" href="/e/${ref.slug}/speakers">Meet the speakers</a></p>`, "Schedule")
            : raw("")}
        </div>
        <div>
          ${openCfps.length ? card(html`<ul id="cfps" class="notes">${openCfps}</ul>`, "Open calls for proposals") : raw("")}
        </div>
      </div>`,
  );
}

function notFoundPage(ctx: RequestContext, message: string): Response {
  return htmlResponse(publicPage(ctx, { title: "Not found" }, html`<div class="card"><h1>Not found</h1><p>${message}</p><p><a href="/">Home</a></p></div>`), { status: 404 });
}

/* -------------------------------------------------------------------------- */
/* Schedule, sessions, speakers, ICS                                          */
/* -------------------------------------------------------------------------- */

function renderOpts(ref: EventRef, interactive: boolean): RenderOptions {
  return { timezone: ref.timezone, eventSlug: ref.slug, interactive };
}

function noPublicationYet(ref: EventRef): SafeHtml {
  return html`${pageHead("Schedule", "Not published yet — check back soon.")}
    ${empty("The organizers haven't published a schedule yet.")}
    <p><a href="/e/${ref.slug}">← Back to ${ref.name}</a></p>`;
}

function registerScheduleRoutes(router: Router<RequestContext>): void {
  router.get("/e/:eventSlug/schedule", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    if (!snapshot) return htmlResponse(publicPage(ctx, { title: "Schedule", event: ref, width: "wide" }, noPublicationYet(ref)));

    // Opening on a published day that happens to hold nothing reads as "this
    // conference has no schedule". The day switcher still lists every day; the
    // default is just the first one with something on it.
    const dayWithSessions = snapshot.event.days.find((d) =>
      snapshot.sessions.some((s) => s.starts_at && calendarDateInZone(s.starts_at, ref.timezone) === d.date),
    );
    const dayId = ctx.url.searchParams.get("day") ?? dayWithSessions?.id ?? snapshot.event.days[0]?.id ?? null;
    const opts = renderOpts(ref, true);

    return htmlResponse(
      publicPage(
        ctx,
        { title: `Schedule — ${ref.name}`, event: ref, width: "wide", head: jsonScript("podium-schedule-data", snapshot) },
        html`${pageHead("Schedule", `Published version ${snapshot.version}. All times in ${ref.timezone} — toggle to your local time below.`)}
          ${scheduleControls(ref, snapshot)}
          ${daySwitcher(ref, snapshot, dayId)}
          <div class="grid two">
            <section>
              <h2>Itinerary</h2>
              ${
                // The day's `date` is a calendar date in the event's timezone;
                // `starts_at` is an instant. Comparing the two by string slice
                // buckets an evening session onto the following day.
                dayId
                  ? renderItinerary(
                      {
                        ...snapshot,
                        sessions: snapshot.sessions.filter(
                          (s) =>
                            s.starts_at &&
                            calendarDateInZone(s.starts_at, ref.timezone) === snapshot.event.days.find((d) => d.id === dayId)?.date,
                        ),
                      },
                      opts,
                    )
                  : renderItinerary(snapshot, opts)
              }
            </section>
            <section>
              <h2>Grid</h2>
              ${dayId ? renderAgendaGrid(snapshot, dayId, opts) : empty("No days published yet.")}
            </section>
          </div>
          ${scheduleClientScript(ref.slug)}`,
      ),
    );
  });

  router.get("/e/:eventSlug/sessions/:sessionId", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    // INV-08-10 — a cancelled or since-removed session does not 404; it says
    // plainly that it is no longer part of the published schedule.
    const body = snapshot ? renderSessionDetail(snapshot, params.sessionId, renderOpts(ref, false)) : html`<p class="empty">This session is not part of the published schedule.</p>`;
    return htmlResponse(publicPage(ctx, { title: "Session", event: ref, width: "narrow" }, html`${body}<p><a href="/e/${ref.slug}/schedule">← Back to the schedule</a></p>`));
  });

  // 08, "Every type is also a page on the first-party site": `sessions_list`
  // hosted under the event's own slug, with the search and facet controls the
  // visitor drives (an embed's filters are fixed by the organizer instead).
  router.get("/e/:eventSlug/sessions", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    if (!snapshot) return htmlResponse(publicPage(ctx, { title: "Sessions", event: ref, width: "wide" }, noPublicationYet(ref)));
    return htmlResponse(
      publicPage(
        ctx,
        { title: `Sessions — ${ref.name}`, event: ref, width: "wide" },
        html`${pageHead("Sessions", `${snapshot.sessions.length} session${snapshot.sessions.length === 1 ? "" : "s"}. Search by title or speaker, or filter by track, format and room.`)}
          ${scheduleControls(ref, snapshot)}
          ${renderSessionsList(snapshot, renderOpts(ref, true))}
          ${scheduleClientScript(ref.slug)}`,
      ),
    );
  });

  router.get("/e/:eventSlug/speakers", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    return htmlResponse(
      publicPage(
        ctx,
        { title: `Speakers — ${ref.name}`, event: ref, width: "wide" },
        html`${pageHead("Speakers", "Ordered by surname.")}
          ${snapshot ? html`${speakerSearchControl()}${renderSpeakersList(snapshot, renderOpts(ref, false))}${speakerSearchScript()}` : noPublicationYet(ref)}`,
      ),
    );
  });

  // 08: `speaker_gallery` — the same directory photo-first, each card opening
  // to a detail panel.
  router.get("/e/:eventSlug/gallery", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    return htmlResponse(
      publicPage(
        ctx,
        { title: `Speaker gallery — ${ref.name}`, event: ref, width: "wide" },
        html`${pageHead("Speaker gallery", "Tap a speaker for their bio and sessions.")}
          ${snapshot ? html`${speakerSearchControl()}${renderSpeakerGallery(snapshot, renderOpts(ref, false))}${speakerSearchScript()}` : noPublicationYet(ref)}`,
      ),
    );
  });

  router.get("/e/:eventSlug/speakers/:personId", async (_req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return notFoundPage(ctx, "No such event.");
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    const body = snapshot ? renderSpeakerDetail(snapshot, params.personId, renderOpts(ref, false)) : html`<p class="empty">This speaker is not part of the published schedule.</p>`;
    return htmlResponse(publicPage(ctx, { title: "Speaker", event: ref, width: "narrow" }, html`${body}<p><a href="/e/${ref.slug}/speakers">← Back to speakers</a></p>`));
  });

  router.get("/e/:eventSlug/schedule.ics", async (req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return text("No such event.", { status: 404 });
    const ref = toRef(row);
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, ref.id);
    if (!snapshot) return text("No published schedule yet.", { status: 404 });
    const track = ctx.url.searchParams.get("track");
    const sessionIds = ctx.url.searchParams.get("sessions")?.split(",").filter(Boolean);
    let sessions = snapshot.sessions;
    if (track) sessions = sessions.filter((s) => s.track?.slug === track);
    if (sessionIds?.length) sessions = sessions.filter((s) => sessionIds.includes(s.session_id));
    const body = buildIcs(snapshot.event, sessions, snapshot.speakers, { baseUrl: baseUrl(ctx), eventSlug: ref.slug, generatedAt: ctx.now });
    const etag = `W/"ics-${snapshot.content_etag.replace(/"/g, "")}-${track ?? ""}-${(sessionIds ?? []).join(",")}"`;
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `inline; filename="${ref.slug}.ics"`, etag, "cache-control": "public, max-age=300" } });
  });
}

function daySwitcher(ref: EventRef, snapshot: ScheduleSnapshot, activeDayId: string | null): SafeHtml {
  return dayBar(
    snapshot.event.days.map((d) => ({ id: d.id, label: d.label ?? d.date })),
    (id) => `/e/${ref.slug}/schedule?day=${id}`,
    activeDayId,
  );
}

/**
 * 08 describes both `speakers_list` and `speaker_gallery` as name-searchable.
 * The control is shared; the script below filters whichever of the two is on
 * the page, since both render cards carrying `data-name`.
 */
function speakerSearchControl(): SafeHtml {
  return card(
    html`<div class="row">
      <div><label for="podium-speaker-search">Search speakers</label><input id="podium-speaker-search" type="search" placeholder="Name…" aria-label="Search speakers by name"></div>
      <div class="shrink" style="margin-top:1.6rem"><span class="small muted" id="podium-speaker-count" aria-live="polite"></span></div>
    </div>
    <p class="small muted">Search needs JavaScript; the full directory below works without it.</p>`,
  );
}

function speakerSearchScript(): SafeHtml {
  return raw(`<script>
(function(){
  var box = document.getElementById("podium-speaker-search");
  if (!box) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll("[data-person-id][data-name]"));
  var count = document.getElementById("podium-speaker-count");
  box.addEventListener("input", function(){
    var q = box.value.toLowerCase().trim();
    var shown = 0;
    cards.forEach(function(el){
      var show = !q || (el.getAttribute("data-name")||"").indexOf(q) >= 0;
      el.style.display = show ? "" : "none";
      if (show) shown++;
    });
    if (count) count.textContent = shown + " of " + cards.length + " speakers";
  });
})();
</script>`);
}

/**
 * One facet select, populated from the snapshot. Dropped entirely when there is
 * nothing to choose between — a "Track" filter over one track is furniture.
 */
function facet(id: string, label: string, all: string, options: { id: string; name: string }[]): SafeHtml {
  if (options.length < 2) return raw("");
  return html`<div>
    <label for="${id}">${label}</label>
    <select id="${id}" data-podium-facet>
      <option value="">${all}</option>
      ${options.map((o) => html`<option value="${o.id}">${o.name}</option>`)}
    </select>
  </div>`;
}

function scheduleControls(ref: EventRef, snapshot: ScheduleSnapshot): SafeHtml {
  return card(
    html`<div class="row">
      <div><label for="podium-search">Search</label><input id="podium-search" type="search" placeholder="Title or speaker…" aria-label="Search sessions and speakers"></div>
      ${facet("podium-track", "Track", "All tracks", snapshot.tracks)}
      ${facet("podium-format", "Format", "All formats", snapshot.formats)}
      ${facet("podium-room", "Room", "All rooms", snapshot.rooms)}
      <div class="shrink checkline" style="margin-top:1.6rem"><input type="checkbox" id="podium-my-schedule"><label for="podium-my-schedule">My schedule only</label></div>
      <div class="shrink" style="margin-top:1.6rem"><a class="btn secondary" id="podium-ics-link" href="/e/${ref.slug}/schedule.ics">Add to calendar</a></div>
      <div class="shrink" style="margin-top:1.6rem"><span class="small muted" id="podium-session-count" aria-live="polite"></span></div>
    </div>
    <p class="small muted">Starring works without an account — it lives in this browser only (localStorage). Search, filters and starring need JavaScript; the full schedule below works without them.</p>`,
  );
}

/**
 * Progressive enhancement over the server-rendered itinerary and grid: text
 * search across title and speaker names, a "my schedule" filter backed by
 * `localStorage` (R11 — no attendee accounts, no server state), and a
 * per-selection "Add to calendar" link. Every element it touches already
 * carries the `data-session-id` / `data-title` / `data-speakers` attributes
 * `widgets.ts` renders — this walks the DOM rather than re-fetching anything.
 */
function scheduleClientScript(eventSlug: string): SafeHtml {
  const key = `podium:starred:${eventSlug}`;
  return raw(`<script>
(function(){
  var STORE_KEY = ${JSON.stringify(key)};
  function starred(){ try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch(e){ return []; } }
  function setStarred(ids){ try { localStorage.setItem(STORE_KEY, JSON.stringify(ids)); } catch(e){} }
  function cards(){ return Array.prototype.slice.call(document.querySelectorAll("[data-session-id]")); }

  function syncStars(){
    var ids = starred();
    cards().forEach(function(el){
      var box = el.querySelector("[data-star-session]");
      if (box) box.checked = ids.indexOf(el.getAttribute("data-session-id")) >= 0;
    });
  }
  document.addEventListener("change", function(e){
    var box = e.target.closest && e.target.closest("[data-star-session]");
    if (!box) return;
    var id = box.getAttribute("data-star-session");
    var ids = starred();
    var i = ids.indexOf(id);
    if (box.checked && i < 0) ids.push(id);
    if (!box.checked && i >= 0) ids.splice(i, 1);
    setStarred(ids);
    updateIcsLink();
    applyFilters();
  });

  var search = document.getElementById("podium-search");
  var mySchedule = document.getElementById("podium-my-schedule");
  // 08: "faceting by track, format and room". Each select narrows on the
  // data-* attribute widgets.ts already renders, so this walks the DOM rather
  // than refetching the snapshot.
  var FACETS = [["podium-track","data-track"],["podium-format","data-format"],["podium-room","data-room"]];
  function facetValues(){
    return FACETS.map(function(f){
      var el = document.getElementById(f[0]);
      return [f[1], el && el.value || ""];
    }).filter(function(f){ return f[1]; });
  }
  function applyFilters(){
    var q = (search && search.value || "").toLowerCase().trim();
    var onlyStarred = mySchedule && mySchedule.checked;
    var ids = starred();
    var facets = facetValues();
    // The grid and the itinerary render the same session twice on /schedule, so
    // the count is over distinct session ids, not over elements.
    var shown = {}, all = {};
    cards().forEach(function(el){
      var id = el.getAttribute("data-session-id");
      var matchesSearch = !q || (el.getAttribute("data-title")||"").indexOf(q) >= 0 || (el.getAttribute("data-speakers")||"").indexOf(q) >= 0;
      var matchesStar = !onlyStarred || ids.indexOf(id) >= 0;
      var matchesFacets = facets.every(function(f){ return el.getAttribute(f[0]) === f[1]; });
      var show = matchesSearch && matchesStar && matchesFacets;
      all[id] = 1;
      if (show) shown[id] = 1;
      el.style.display = show ? "" : "none";
      if (el.classList.contains("cell")) el.style.visibility = show ? "" : "hidden";
    });
    var count = document.getElementById("podium-session-count");
    if (count) count.textContent = Object.keys(shown).length + " of " + Object.keys(all).length + " sessions";
  }
  function updateIcsLink(){
    var link = document.getElementById("podium-ics-link");
    if (!link) return;
    var ids = starred();
    var base = link.getAttribute("data-base") || link.href.split("?")[0];
    link.setAttribute("data-base", base);
    link.href = ids.length ? base + "?sessions=" + ids.join(",") : base;
    link.textContent = ids.length ? "Add my " + ids.length + " session" + (ids.length === 1 ? "" : "s") + " to calendar" : "Add to calendar";
  }
  if (search) search.addEventListener("input", applyFilters);
  if (mySchedule) mySchedule.addEventListener("change", applyFilters);
  Array.prototype.slice.call(document.querySelectorAll("[data-podium-facet]")).forEach(function(el){
    el.addEventListener("change", applyFilters);
  });
  syncStars();
  updateIcsLink();
  applyFilters();
})();
</script>`);
}

/* -------------------------------------------------------------------------- */
/* The embed (J10)                                                            */
/* -------------------------------------------------------------------------- */

async function snapshotForEmbed(ctx: RequestContext, embed: EmbedConfigRow | null): Promise<ScheduleSnapshot | null> {
  if (!embed) return null;
  if (embed.pinned_publication_id) return snapshotById(ctx.env, ctx.orgId, embed.pinned_publication_id);
  if (embed.show_unpublished) {
    // A preview embed for staging sites: intentionally reads the working
    // schedule rather than the cached `live` snapshot, so it is never served
    // from the public KV cache either.
    const app = ctx.app(embed.event_id);
    const build = await buildSnapshot(app, embed.event_id);
    const eventRow = await app.db.byId<Row>("event", embed.event_id);
    if (!eventRow) return null;
    return {
      publication_id: "preview",
      version: 0,
      published_at: ctx.now,
      content_etag: `"preview-${ctx.now}"`,
      event: build.event,
      sessions: build.sessions,
      speakers: build.speakers,
      tracks: build.tracks,
      formats: build.formats,
      rooms: build.rooms,
    };
  }
  return liveSnapshot(ctx.env, ctx.orgId, embed.event_id);
}

function registerEmbedRoutes(router: Router<RequestContext>): void {
  router.get("/embed/:key", async (req, ctx, params) => {
    const embed = await embedByKey(ctx.app(), params.key);
    if (!embed || embed.status !== "active") return text("No such embed.", { status: 404 });

    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin, embed.allowed_origins);
    // Preflight, and a same-origin `<script>`/`<iframe>` load (no Origin
    // header) both proceed; a cross-origin fetch from an unlisted origin gets
    // no CORS header and the browser refuses to read the body (INV-08-6).

    const snapshot = await snapshotForEmbed(ctx, embed);
    const ref: EventRef = snapshot
      ? { id: embed.event_id, name: snapshot.event.name, slug: snapshot.event.slug, timezone: snapshot.event.timezone, status: "active", starts_on: snapshot.event.starts_on, ends_on: snapshot.event.ends_on }
      : { id: embed.event_id, name: "", slug: "", timezone: "UTC", status: "active", starts_on: "", ends_on: "" };

    const etag = snapshot ? `W/"${snapshot.content_etag.replace(/"/g, "")}-${embed.format}-${embed.widget_type}"` : null;
    if (etag && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, ...cors } });

    const cacheControl = `public, max-age=${embed.cache_ttl_seconds}`;
    const commonHeaders: Record<string, string> = { ...cors, "cache-control": cacheControl, ...(etag ? { etag } : {}) };

    if (!snapshot) {
      if (embed.format === "json") return json({ event: null, sessions: [], speakers: [], tracks: [], formats: [], rooms: [] }, { headers: commonHeaders });
      return htmlResponse(html`<p class="empty">Not published yet.</p>`, { headers: commonHeaders });
    }

    const filtered = applyFieldAllowlist(applyFilters(snapshot, embed.widget_type, embed.filters), embed.widget_type, embed.fields ?? undefined);
    const dayId = ctx.url.searchParams.get("day") ?? filtered.event.days[0]?.id;
    const sessionId = ctx.url.searchParams.get("session_id") ?? undefined;
    const opts: RenderOptions = { timezone: filtered.event.timezone, eventSlug: filtered.event.slug, theme: (embed.theme as RenderOptions["theme"]) ?? null, interactive: embed.widget_type === "sessions_list" || embed.widget_type === "schedule_itinerary" };

    switch (embed.format) {
      case "json":
        return json(filtered, { headers: commonHeaders });
      case "xml":
        return new Response(widgetXml(embed.widget_type, filtered), { headers: { ...commonHeaders, "content-type": "application/xml; charset=utf-8" } });
      case "rss":
        return new Response(widgetRss(filtered, opts), { headers: { ...commonHeaders, "content-type": "application/rss+xml; charset=utf-8" } });
      case "ics":
        return new Response(buildIcs(filtered.event, filtered.sessions, filtered.speakers, { baseUrl: baseUrl(ctx), eventSlug: filtered.event.slug, generatedAt: ctx.now }), {
          headers: { ...commonHeaders, "content-type": "text/calendar; charset=utf-8" },
        });
      case "iframe": {
        // Falls back to server-rendered HTML — a full standalone page, framed
        // under the allowed origins' CSP.
        const frameHeaders = { ...commonHeaders, "content-security-policy": frameAncestorsHeader(embed.allowed_origins) };
        return htmlResponse(
          html`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head>
            <body style="margin:0;padding:.75rem">${renderWidgetHtml(embed.widget_type, filtered, opts, { dayId, sessionId })}</body></html>`,
          { headers: frameHeaders },
        );
      }
      case "html":
      case "js_widget":
      default:
        // `js_widget` and `iframe` both fall back to server-rendered HTML; the
        // `js_widget` response is the fragment `embed.js` mounts into the page,
        // and is exactly what renders if the script never loads.
        return htmlResponse(
          html`<div data-podium-embed="${embed.key}" data-podium-widget="${embed.widget_type}">${renderWidgetHtml(embed.widget_type, filtered, opts, { dayId, sessionId })}</div>`,
          { headers: commonHeaders },
        );
    }
  });

  router.get("/embed.js", async (_req, ctx) => {
    return new Response(embedJsSource(baseUrl(ctx)), {
      headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  });
}

/**
 * One script, one global (`window.Podium`), mounting every `widget_type` —
 * "a marketing team that has pasted a script tag into a CMS will not repaste
 * it when a second widget ships" (08). Progressive enhancement only: the
 * server response already contains the rendered widget, so a blocked script
 * leaves a working, static embed (08, "Degrade gracefully").
 */
function embedJsSource(base: string): string {
  return `(function(){
  var BASE = ${JSON.stringify(base)};
  function mount(el){
    var key = el.getAttribute("data-podium-key");
    if (!key || el.getAttribute("data-podium-mounted")) return;
    el.setAttribute("data-podium-mounted", "1");
    var url = BASE + "/embed/" + key;
    fetch(url, { headers: { accept: "text/html" } })
      .then(function(res){ return res.text(); })
      .then(function(html){ el.innerHTML = html; })
      .catch(function(){ /* leave any server-rendered fallback content in place */ });
  }
  function mountAll(){
    var els = document.querySelectorAll("[data-podium-widget][data-podium-key]");
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }
  window.Podium = { mount: mount, mountAll: mountAll };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
`;
}

/* -------------------------------------------------------------------------- */
/* Public API — /v1/public/...                                                */
/* -------------------------------------------------------------------------- */

function registerPublicApiRoutes(router: Router<RequestContext>): void {
  router.get("/v1/public/events/:eventSlug/schedule", async (req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return json({ error: "not_found", message: "No such event." }, { status: 404 });
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, str(row.id));
    if (!snapshot) return json({ event: toRef(row), sessions: [], speakers: [], tracks: [], formats: [], rooms: [] });
    if (req.headers.get("if-none-match") === snapshot.content_etag) return new Response(null, { status: 304, headers: { etag: snapshot.content_etag } });
    return json(snapshot, { headers: { etag: snapshot.content_etag, "cache-control": "public, max-age=60" } });
  });

  router.get("/v1/public/events/:eventSlug/sessions", async (req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return json({ error: "not_found", message: "No such event." }, { status: 404 });
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, str(row.id));
    const data = snapshot?.sessions ?? [];
    const etag = snapshot ? `${snapshot.content_etag}` : null;
    if (etag && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return json({ data }, { headers: etag ? { etag, "cache-control": "public, max-age=60" } : {} });
  });

  router.get("/v1/public/events/:eventSlug/speakers", async (req, ctx, params) => {
    const row = await resolvePublicEvent(ctx, params.eventSlug);
    if (!row) return json({ error: "not_found", message: "No such event." }, { status: 404 });
    const snapshot = await liveSnapshot(ctx.env, ctx.orgId, str(row.id));
    const data = snapshot?.speakers ?? [];
    const etag = snapshot ? `${snapshot.content_etag}` : null;
    if (etag && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return json({ data }, { headers: etag ? { etag, "cache-control": "public, max-age=60" } : {} });
  });
}

export { resolvePublicEvent, toRef as toPublicEventRef };
