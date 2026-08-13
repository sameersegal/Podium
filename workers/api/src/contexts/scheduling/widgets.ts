/**
 * The embed (08, "The embed (J10)") — filtering, layout and rendering shared
 * by every `widget_type` × `format` pair, and by the public schedule page's
 * agenda grid and itinerary (the same layout code, not a second copy).
 *
 * Nothing here reads a binding: it operates on an already-loaded
 * `ScheduleSnapshot` (INV-09-6 — the embed never touches the database on a
 * warm read; `surfaces/public.ts` and `contexts/scheduling/routes.ts` are the
 * only callers that fetch one).
 */

import type {
  PublishedFormatRef,
  PublishedRoomRef,
  PublishedSessionSnapshot,
  PublishedSpeakerSnapshot,
  PublishedTrackRef,
  ScheduleSnapshot,
} from "@podiumstack/domain/scheduling/publication.js";
import { isSpeakerWidget, WIDGET_LABELS, type EmbedFormat, type WidgetType } from "@podiumstack/domain/scheduling/types.js";
import { calendarDateInZone, formatInZone, formatTimeInZone } from "@podiumstack/domain/shared/time.js";
import { escapeHtml, html, joinHtml, raw, type SafeHtml } from "../../ui/html.js";
import { avatar, badge } from "../../ui/layout.js";

/* -------------------------------------------------------------------------- */
/* CORS / frame-ancestors — INV-08-6                                          */
/* -------------------------------------------------------------------------- */

/**
 * INV-08-6 — an unlisted origin gets no CORS headers and no frame permission.
 * `allowed_origins` is an exact-match allowlist; there is no wildcard in the
 * model, so none is honoured here.
 */
export function corsHeaders(requestOrigin: string | null, allowedOrigins: string[]): Record<string, string> {
  if (!requestOrigin || !allowedOrigins.includes(requestOrigin)) return {};
  return {
    "access-control-allow-origin": requestOrigin,
    "access-control-allow-methods": "GET, OPTIONS",
    vary: "origin",
  };
}

/** A CSP `frame-ancestors` value naming every allowed origin, for `iframe`. */
export function frameAncestorsHeader(allowedOrigins: string[]): string {
  if (allowedOrigins.length === 0) return "frame-ancestors 'none'";
  return `frame-ancestors ${allowedOrigins.join(" ")}`;
}

/* -------------------------------------------------------------------------- */
/* Filters — EmbedConfig.filters                                              */
/* -------------------------------------------------------------------------- */

export interface WidgetFilters {
  event_day_ids?: string[];
  track_ids?: string[];
  format_ids?: string[];
  sponsor_only?: boolean;
}

export interface FieldAllowlist {
  show?: string[];
  hide?: string[];
}

/**
 * An `EventDay.date` is a calendar date in the event's own timezone; a
 * session's `starts_at` is an instant. Slicing the instant compares a UTC date
 * to a local one, which silently moves every session after the day's UTC
 * midnight onto the next day — a 6pm Pacific workshop lands on day 2, and day 1
 * renders empty.
 */
function dayOf(snapshot: ScheduleSnapshot, instant: string | null): string | null {
  if (!instant) return null;
  const cal = calendarDateInZone(instant, snapshot.event.timezone);
  return snapshot.event.days.find((d) => d.date === cal)?.id ?? null;
}

/**
 * A trimmed, self-contained `ScheduleSnapshot` — the payload a single embed
 * actually renders, not the whole publication. Keeps the JSON/XML/RSS/ICS
 * outputs narrow (G: "ship the fields the widget renders, not the whole
 * entity") and gives every format (server HTML, `embed.js`, JSON) the same
 * shape to work from.
 */
export function applyFilters(snapshot: ScheduleSnapshot, widget: WidgetType, filters: WidgetFilters = {}): ScheduleSnapshot {
  let sessions = snapshot.sessions;
  if (filters.event_day_ids?.length) sessions = sessions.filter((s) => { const d = dayOf(snapshot, s.starts_at); return d && filters.event_day_ids!.includes(d); });
  if (filters.track_ids?.length) sessions = sessions.filter((s) => s.track && filters.track_ids!.includes(s.track.id));
  if (filters.format_ids?.length) sessions = sessions.filter((s) => s.format && filters.format_ids!.includes(s.format.id));
  if (filters.sponsor_only) sessions = sessions.filter((s) => s.is_sponsored_content);

  const sessionSpeakerIds = new Set(sessions.flatMap((s) => s.speaker_refs));
  const speakers = isSpeakerWidget(widget)
    ? snapshot.speakers // the directory widgets show everyone, not just today's speakers
    : snapshot.speakers.filter((sp) => sessionSpeakerIds.has(sp.person_id));

  const trackIds = new Set(sessions.map((s) => s.track?.id).filter(Boolean) as string[]);
  const formatIds = new Set(sessions.map((s) => s.format?.id).filter(Boolean) as string[]);
  const roomIds = new Set(sessions.map((s) => s.room?.id).filter(Boolean) as string[]);

  return {
    ...snapshot,
    sessions,
    speakers,
    tracks: snapshot.tracks.filter((t) => trackIds.has(t.id)),
    formats: snapshot.formats.filter((f) => formatIds.has(f.id)),
    rooms: snapshot.rooms.filter((r) => roomIds.has(r.id)),
  };
}

function pickFields<T extends object>(row: T, fields?: FieldAllowlist): T {
  if (!fields || (!fields.show?.length && !fields.hide?.length)) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (fields.show?.length && !fields.show.includes(k) && k !== "session_id" && k !== "person_id") continue;
    if (fields.hide?.includes(k)) continue;
    out[k] = v;
  }
  return out as T;
}

export function applyFieldAllowlist(snapshot: ScheduleSnapshot, widget: WidgetType, fields?: FieldAllowlist): ScheduleSnapshot {
  if (!fields) return snapshot;
  if (isSpeakerWidget(widget)) return { ...snapshot, speakers: snapshot.speakers.map((s) => pickFields(s, fields)) };
  return { ...snapshot, sessions: snapshot.sessions.map((s) => pickFields(s, fields)) };
}

/* -------------------------------------------------------------------------- */
/* Grid geometry — shared by the admin agenda builder and `agenda_grid`       */
/* -------------------------------------------------------------------------- */

export interface GridItem {
  id: string;
  room_id: string;
  starts_at: string;
  ends_at: string;
}

export interface GridBlock<T extends GridItem> {
  item: T;
  /** 1-based room column, after the leading time column. */
  column: number;
  /** Position and extent as a fraction of the grid's minute window. */
  top_minutes: number;
  height_minutes: number;
}

export interface GridLayout<T extends GridItem> {
  rooms: { id: string; name: string }[];
  window_start: string;
  window_end: string;
  total_minutes: number;
  hour_marks: { minutes_from_start: number; label: string }[];
  blocks: GridBlock<T>[];
}

/** Rooms that actually have something placed keep the grid from growing unboundedly wide. */
export function layoutGrid<T extends GridItem>(
  items: T[],
  rooms: { id: string; name: string }[],
  windowStart: string,
  windowEnd: string,
  timezone: string,
): GridLayout<T> {
  const start = new Date(windowStart).getTime();
  const end = new Date(windowEnd).getTime();
  const usedRoomIds = new Set(items.map((i) => i.room_id));
  const activeRooms = rooms.filter((r) => usedRoomIds.has(r.id));
  const columnOf = new Map(activeRooms.map((r, i) => [r.id, i + 1]));

  const blocks: GridBlock<T>[] = [];
  for (const item of items) {
    const column = columnOf.get(item.room_id);
    if (!column) continue; // an inactive/unknown room — nothing to draw it against
    const s = Math.max(start, new Date(item.starts_at).getTime());
    const e = Math.min(end, new Date(item.ends_at).getTime());
    if (e <= s) continue;
    blocks.push({ item, column, top_minutes: (s - start) / 60_000, height_minutes: Math.max(5, (e - s) / 60_000) });
  }

  const hourMarks: GridLayout<T>["hour_marks"] = [];
  for (let t = start; t <= end; t += 60 * 60_000) {
    hourMarks.push({ minutes_from_start: (t - start) / 60_000, label: formatTimeInZone(new Date(t).toISOString(), timezone) });
  }

  return { rooms: activeRooms, window_start: windowStart, window_end: windowEnd, total_minutes: Math.max(1, (end - start) / 60_000), hour_marks: hourMarks, blocks };
}

/** Render a `GridLayout` as the `.agenda` CSS grid — no JS required. */
export function renderGrid<T extends GridItem>(layout: GridLayout<T>, blockContent: (b: GridBlock<T>) => SafeHtml, minutesPerRow = 5, rowPx = 5): SafeHtml {
  if (layout.rooms.length === 0) return html`<p class="empty">Nothing placed in a public room on this day yet.</p>`;
  const totalRows = Math.ceil(layout.total_minutes / minutesPerRow);
  const style = `grid-template-columns: 64px repeat(${layout.rooms.length}, minmax(150px, 1fr)); grid-template-rows: 2.2rem repeat(${totalRows}, ${rowPx}px);`;
  return html`<div class="agenda" style="${style}" role="table" aria-label="Schedule grid">
    <div class="cell head" role="columnheader"></div>
    ${layout.rooms.map((r) => html`<div class="cell head" role="columnheader">${r.name}</div>`)}
    ${layout.hour_marks.map(
      (h) => raw(`<div class="cell time" style="grid-column:1; grid-row:${Math.round(h.minutes_from_start / minutesPerRow) + 2}">${escapeHtml(h.label)}</div>`),
    )}
    ${layout.blocks.map((b) => {
      const rowStart = Math.max(1, Math.round(b.top_minutes / minutesPerRow)) + 2;
      const rowEnd = Math.max(rowStart + 1, Math.round((b.top_minutes + b.height_minutes) / minutesPerRow) + 2);
      return html`${raw(`<div class="cell session-block" style="grid-column:${b.column + 1}; grid-row:${rowStart} / ${rowEnd}">`)}${blockContent(b)}${raw("</div>")}`;
    })}
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* HTML rendering per widget type                                             */
/* -------------------------------------------------------------------------- */

export interface RenderOptions {
  timezone: string;
  eventSlug: string;
  /** `EmbedConfig.theme` — cosmetic only, never gates the disclosure label. */
  theme?: { show_speakers?: boolean; show_rooms?: boolean; density?: "compact" | "comfortable" } | null;
  /** Search box / facet filters, for the interactive surfaces. */
  interactive?: boolean;
}

function speakersOf(session: PublishedSessionSnapshot, speakers: PublishedSpeakerSnapshot[]): PublishedSpeakerSnapshot[] {
  const byId = new Map(speakers.map((s) => [s.person_id, s]));
  return session.speaker_refs.map((id) => byId.get(id)).filter((s): s is PublishedSpeakerSnapshot => !!s);
}

/** INV-08-7 — rendered whenever `is_sponsored_content`, in every format, never themeable. */
export function sponsorDisclosure(session: PublishedSessionSnapshot): SafeHtml {
  return session.is_sponsored_content
    ? html`<span class="badge warn" data-sponsored-disclosure>Sponsored content${session.sponsor ? html` — ${session.sponsor.name}` : raw("")}</span>`
    : raw("");
}

/**
 * 08 asks `session_detail` for the "full time range", not just a start — a
 * schedule you have to do arithmetic against is the thing attendees complain
 * about. The end is rendered as a bare time because the date is already in the
 * start.
 */
function timeRange(s: PublishedSessionSnapshot, timezone: string): SafeHtml {
  if (!s.starts_at) return html`Time to be announced`;
  const start = formatInZone(s.starts_at, timezone);
  return s.ends_at ? html`${start} – ${formatTimeInZone(s.ends_at, timezone)}` : html`${start}`;
}

function sessionMeta(s: PublishedSessionSnapshot, opts: RenderOptions): SafeHtml {
  return html`<p class="small muted">
    ${timeRange(s, opts.timezone)}
    ${s.room && opts.theme?.show_rooms !== false ? html` · ${s.room.name}` : raw("")}
    ${s.track ? html` · ${badge(s.track.name, "info")}` : raw("")}
    ${s.format ? html` · ${s.format.name}` : raw("")}
  </p>`;
}

/** How much of the abstract a card shows before `<details>` takes over. */
const SNIPPET_CHARS = 180;

/**
 * 08 specifies `sessions_list` as "title, **snippet**, day/time, room…" — the
 * card carries the description, truncated, and expands in place.
 *
 * `<details>` rather than a script: public surfaces must render fully with
 * scripts blocked (08, "Degrade gracefully"), and a "Show more" that needs
 * JavaScript to reveal text is exactly the account-wall-shaped failure that
 * requirement exists to prevent.
 */
export function snippet(text: string | null | undefined): SafeHtml {
  const full = (text ?? "").trim();
  if (!full) return raw("");
  if (full.length <= SNIPPET_CHARS) return html`<p>${full}</p>`;
  const cut = full.slice(0, SNIPPET_CHARS);
  const space = cut.lastIndexOf(" ");
  const head = (space > SNIPPET_CHARS - 40 ? cut.slice(0, space) : cut).trimEnd();
  return html`<details class="snippet">
    <summary>${head}… <span class="more">Show more</span></summary>
    <p>${full}</p>
  </details>`;
}

export function sessionSnippet(s: PublishedSessionSnapshot): SafeHtml {
  const full = (s.abstract ?? s.description ?? "").trim();
  const lede = (s.subtitle ?? "").trim();
  if (!full) return lede ? html`<p>${lede}</p>` : raw("");
  return snippet(full);
}

function sessionDataAttrs(s: PublishedSessionSnapshot, speakers: PublishedSpeakerSnapshot[], timezone: string): string {
  const names = speakersOf(s, speakers).map((sp) => sp.display_name).join(", ");
  return [
    `data-session-id="${escapeHtml(s.session_id)}"`,
    `data-title="${escapeHtml(s.title.toLowerCase())}"`,
    `data-speakers="${escapeHtml(names.toLowerCase())}"`,
    `data-track="${escapeHtml(s.track?.id ?? "")}"`,
    `data-format="${escapeHtml(s.format?.id ?? "")}"`,
    `data-room="${escapeHtml(s.room?.id ?? "")}"`,
    `data-day="${escapeHtml(s.starts_at ? calendarDateInZone(s.starts_at, timezone) : "")}"`,
    `data-starts="${escapeHtml(s.starts_at ?? "")}"`,
  ].join(" ");
}

/** `sessions_list` — a searchable, filterable card per session. */
export function renderSessionsList(snapshot: ScheduleSnapshot, opts: RenderOptions): SafeHtml {
  if (snapshot.sessions.length === 0) return html`<p class="empty">No sessions to show yet.</p>`;
  return html`<div class="grid two" data-podium-list>
    ${snapshot.sessions.map((s) => sessionCard(s, snapshot.speakers, opts))}
  </div>`;
}

function sessionCard(s: PublishedSessionSnapshot, speakers: PublishedSpeakerSnapshot[], opts: RenderOptions): SafeHtml {
  const people = speakersOf(s, speakers);
  return html`${raw(`<article class="session-card" ${sessionDataAttrs(s, speakers, opts.timezone)}>`)}
    <h3><a href="/e/${opts.eventSlug}/sessions/${s.session_id}">${s.title}</a></h3>
    ${sponsorDisclosure(s)}
    ${sessionMeta(s, opts)}
    ${sessionSnippet(s)}
    ${people.length && opts.theme?.show_speakers !== false
      ? html`<p class="small">${joinHtml(
          people.map((p) => `${p.display_name}${p.job_title || p.company ? ` — ${[p.job_title, p.company].filter(Boolean).join(", ")}` : ""}`),
          " · ",
        )}</p>`
      : raw("")}
    ${opts.interactive ? html`<label class="checkline small"><input type="checkbox" data-star-session="${s.session_id}"> Add to my schedule</label>` : raw("")}
    ${raw("</article>")}`;
}

/** `schedule_itinerary` — the chronological, mobile-shaped view of `agenda_grid`. */
export function renderItinerary(snapshot: ScheduleSnapshot, opts: RenderOptions): SafeHtml {
  const sorted = [...snapshot.sessions].filter((s) => s.starts_at).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!));
  if (sorted.length === 0) return html`<p class="empty">Nothing scheduled yet.</p>`;
  const groups = new Map<string, PublishedSessionSnapshot[]>();
  for (const s of sorted) {
    const key = formatTimeInZone(s.starts_at!, opts.timezone);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return html`<ol class="timeline" data-podium-itinerary>
    ${[...groups.entries()].map(
      ([time, items]) => html`<li>
        <strong>${time}</strong>
        <div class="grid two">${items.map((s) => sessionCard(s, snapshot.speakers, opts))}</div>
      </li>`,
    )}
  </ol>`;
}

/** `agenda_grid` — rooms across, time down, one day at a time. */
export function renderAgendaGrid(snapshot: ScheduleSnapshot, dayId: string, opts: RenderOptions): SafeHtml {
  const day = snapshot.event.days.find((d) => d.id === dayId);
  if (!day) return html`<p class="empty">No such day.</p>`;
  const daySessions = snapshot.sessions.filter((s) => s.starts_at && calendarDateInZone(s.starts_at, opts.timezone) === day.date && s.room);
  if (daySessions.length === 0) return html`<p class="empty">Nothing placed in a public room on ${day.label ?? day.date}.</p>`;

  const items: GridItem[] = daySessions.map((s) => ({ id: s.session_id, room_id: s.room!.id, starts_at: s.starts_at!, ends_at: s.ends_at! }));
  const times = daySessions.map((s) => [new Date(s.starts_at!).getTime(), new Date(s.ends_at!).getTime()]).flat();
  const windowStart = new Date(Math.min(...times)).toISOString();
  const windowEnd = new Date(Math.max(...times)).toISOString();
  const layout = layoutGrid(items, snapshot.rooms, windowStart, windowEnd, opts.timezone);
  const byId = new Map(daySessions.map((s) => [s.session_id, s]));

  return renderGrid(layout, (b) => {
    const s = byId.get(b.item.id)!;
    return html`<a href="/e/${opts.eventSlug}/sessions/${s.session_id}" ${raw(sessionDataAttrs(s, snapshot.speakers, opts.timezone))}>
      <span class="t">${s.title}</span>
      ${sponsorDisclosure(s)}
    </a>`;
  });
}

function speakerCard(p: PublishedSpeakerSnapshot, opts: RenderOptions): SafeHtml {
  return html`<article class="speaker-card" data-person-id="${p.person_id}" data-name="${p.display_name.toLowerCase()}">
    <a href="/e/${opts.eventSlug}/speakers/${p.person_id}">
      ${avatar(p.display_name, p.headshot_url, 84)}
      <h3>${p.display_name}</h3>
    </a>
    ${p.job_title || p.company ? html`<p class="small muted">${[p.job_title, p.company].filter(Boolean).join(", ")}</p>` : raw("")}
  </article>`;
}

/** `speakers_list` — a directory ordered by surname (the snapshot is already sorted). */
export function renderSpeakersList(snapshot: ScheduleSnapshot, opts: RenderOptions): SafeHtml {
  if (snapshot.speakers.length === 0) return html`<p class="empty">No speakers announced yet.</p>`;
  return html`<div class="grid four" data-podium-list>${snapshot.speakers.map((p) => speakerCard(p, opts))}</div>`;
}

/** One line per session on a speaker's card: what it is, when, and where. */
function speakerSessionLine(s: PublishedSessionSnapshot, opts: RenderOptions): SafeHtml {
  return html`<li>
    <a href="/e/${opts.eventSlug}/sessions/${s.session_id}">${s.title}</a>
    <span class="small muted"> — ${timeRange(s, opts.timezone)}${s.room ? html` · ${s.room.name}` : raw("")}</span>
  </li>`;
}

/**
 * `speaker_gallery` — 08: "A photo grid of speakers, name-searchable, **opening
 * to a detail panel**".
 *
 * The panel is a native `<details>`, not a scripted modal, for the same reason
 * the session snippet is: public surfaces must render fully with scripts
 * blocked (08, "Degrade gracefully"). Closing it restores the grid because the
 * grid was never replaced — this is `speakers_list` plus drill-down, which is
 * the difference 08 draws between the two types.
 */
export function renderSpeakerGallery(snapshot: ScheduleSnapshot, opts: RenderOptions): SafeHtml {
  if (snapshot.speakers.length === 0) return html`<p class="empty">No speakers announced yet.</p>`;
  return html`<div class="grid four" data-podium-gallery>
    ${snapshot.speakers.map((p) => {
      const sessions = snapshot.sessions.filter((s) => p.session_refs.includes(s.session_id));
      return html`<details class="speaker-card gallery-card" data-person-id="${p.person_id}" data-name="${p.display_name.toLowerCase()}">
        <summary>
          ${avatar(p.display_name, p.headshot_url, 84)}
          <h3>${p.display_name}</h3>
          ${p.job_title || p.company ? html`<p class="small muted">${[p.job_title, p.company].filter(Boolean).join(", ")}</p>` : raw("")}
        </summary>
        <div class="panel">
          ${snippet(p.bio ?? p.short_bio ?? p.headline)}
          ${sessions.length ? html`<ul class="small">${sessions.map((s) => speakerSessionLine(s, opts))}</ul>` : raw("")}
          <p class="small"><a href="/e/${opts.eventSlug}/speakers/${p.person_id}">Full profile →</a></p>
        </div>
      </details>`;
    })}
  </div>`;
}


/** `session_detail` — one session in full. */
export function renderSessionDetail(snapshot: ScheduleSnapshot, sessionId: string, opts: RenderOptions): SafeHtml {
  const s = snapshot.sessions.find((x) => x.session_id === sessionId);
  if (!s) return html`<p class="empty">This session is not part of the published schedule.</p>`;
  const people = speakersOf(s, snapshot.speakers);
  return html`<article class="session-card" ${raw(sessionDataAttrs(s, snapshot.speakers, opts.timezone))}>
    <h2>${s.title}</h2>
    ${s.subtitle ? html`<p class="lede">${s.subtitle}</p>` : raw("")}
    ${sponsorDisclosure(s)}
    ${sessionMeta(s, opts)}
    ${s.abstract ? html`<p>${s.abstract}</p>` : raw("")}
    ${people.length
      ? html`<h3>Speakers</h3>
          <div class="grid three">${people.map((p) => speakerCard(p, opts))}</div>`
      : raw("")}
    ${s.assets.length
      ? html`<h3>Materials</h3>
          <ul>${s.assets.map((a) => html`<li><a href="${a.url}">${a.label ?? a.kind}</a></li>`)}</ul>`
      : raw("")}
  </article>`;
}

/** A speaker's own page — full bio, links, and the sessions they are on. */
export function renderSpeakerDetail(snapshot: ScheduleSnapshot, personId: string, opts: RenderOptions): SafeHtml {
  const p = snapshot.speakers.find((x) => x.person_id === personId);
  if (!p) return html`<p class="empty">This speaker is not part of the published schedule.</p>`;
  const sessions = snapshot.sessions.filter((s) => p.session_refs.includes(s.session_id));
  return html`<article>
    <div class="row">
      ${avatar(p.display_name, p.headshot_url, 120)}
      <div>
        <h2>${p.display_name}${p.pronouns ? html` <span class="small muted">(${p.pronouns})</span>` : raw("")}</h2>
        ${p.job_title || p.company ? html`<p class="muted">${[p.job_title, p.company].filter(Boolean).join(", ")}</p>` : raw("")}
        ${p.headline ? html`<p>${p.headline}</p>` : raw("")}
      </div>
    </div>
    ${p.bio ? html`<p>${p.bio}</p>` : p.short_bio ? html`<p>${p.short_bio}</p>` : raw("")}
    ${p.links.length ? html`<p>${joinHtml(p.links.map((l) => html`<a href="${l.url}">${l.label ?? l.kind}</a>`), " · ")}</p>` : raw("")}
    ${sessions.length
      ? html`<h3>Sessions</h3>
          <div class="grid two">${sessions.map((s) => sessionCard(s, snapshot.speakers, opts))}</div>`
      : raw("")}
  </article>`;
}

export function renderWidgetHtml(widget: WidgetType, snapshot: ScheduleSnapshot, opts: RenderOptions, extra: { dayId?: string; sessionId?: string } = {}): SafeHtml {
  switch (widget) {
    case "sessions_list":
      return renderSessionsList(snapshot, opts);
    case "schedule_itinerary":
      return renderItinerary(snapshot, opts);
    case "agenda_grid": {
      const dayId = extra.dayId ?? snapshot.event.days[0]?.id;
      return dayId ? renderAgendaGrid(snapshot, dayId, opts) : html`<p class="empty">No days published yet.</p>`;
    }
    case "speakers_list":
      return renderSpeakersList(snapshot, opts);
    case "speaker_gallery":
      return renderSpeakerGallery(snapshot, opts);
    case "session_detail":
      return extra.sessionId ? renderSessionDetail(snapshot, extra.sessionId, opts) : html`<p class="empty">No session specified.</p>`;
  }
}

export { WIDGET_LABELS };
export type { EmbedFormat, WidgetType, PublishedTrackRef, PublishedFormatRef, PublishedRoomRef };

/* -------------------------------------------------------------------------- */
/* XML / RSS                                                                   */
/* -------------------------------------------------------------------------- */

function xmlEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toXmlNode(tag: string, value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);
  if (value === null || value === undefined) return `${indent}<${tag}/>`;
  if (Array.isArray(value)) return value.map((v) => toXmlNode(tag.replace(/s$/, "") || "item", v, depth)).join("\n");
  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => toXmlNode(k, v, depth + 1))
      .join("\n");
    return `${indent}<${tag}>\n${inner}\n${indent}</${tag}>`;
  }
  return `${indent}<${tag}>${xmlEscape(value)}</${tag}>`;
}

/** A minimal, deterministic XML serialisation of the same payload the JSON format returns. */
export function widgetXml(widget: WidgetType, snapshot: ScheduleSnapshot): string {
  const root = isSpeakerWidget(widget) ? { speakers: snapshot.speakers } : { sessions: snapshot.sessions, speakers: snapshot.speakers };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<schedule event="${xmlEscape(snapshot.event.slug)}" version="${snapshot.version}">\n${Object.entries(root)
    .map(([k, v]) => toXmlNode(k, v, 1))
    .join("\n")}\n</schedule>\n`;
}

/** RSS 2.0 — for `sessions_list` and `schedule_itinerary` only (WIDGET_FORMATS). */
export function widgetRss(snapshot: ScheduleSnapshot, opts: RenderOptions): string {
  const items = [...snapshot.sessions]
    .filter((s) => s.starts_at)
    .sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
    .map(
      (s) => `  <item>
    <title>${xmlEscape(s.title)}</title>
    <link>${xmlEscape(`${opts.eventSlug ? "/e/" + opts.eventSlug : ""}/sessions/${s.session_id}`)}</link>
    <guid isPermaLink="false">${xmlEscape(s.session_id)}</guid>
    <pubDate>${new Date(s.starts_at!).toUTCString()}</pubDate>
    <description>${xmlEscape(s.subtitle ?? s.abstract ?? "")}</description>
  </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${xmlEscape(snapshot.event.name)} — schedule</title>
  <link>${xmlEscape(opts.eventSlug ? "/e/" + opts.eventSlug + "/schedule" : "")}</link>
  <description>Session schedule for ${xmlEscape(snapshot.event.name)}</description>
${items}
</channel></rss>
`;
}
