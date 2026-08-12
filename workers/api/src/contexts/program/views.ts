/**
 * Program — read models and HTML for the admin board, the session detail
 * screen and the speaker's own `/portal/sessions`.
 *
 * The health signals (06, "Program health read model") are split in two: a
 * pure aggregator per signal, unit-tested against plain arrays, and a loader
 * that fetches the rows and calls them. `sponsor_session_share` in particular
 * is "the number a programme chair is judged on, and it is invisible until
 * someone counts" — so it gets its own function rather than being folded into
 * a generic counter.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { isNonTerminalTask, onboardingProgress, type TaskInstanceStatus } from "@podiumconf/domain/onboarding/types.js";
import { contentDiverged, type ContentSnapshot } from "@podiumconf/domain/program/types.js";
import { addDays } from "@podiumconf/domain/shared/time.js";
import { versionField } from "../../http/concurrency.js";
import { badge, card, empty, field, humanise, pageHead, progressBar, stat, table } from "../../ui/layout.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import type { EventRef } from "../../ui/shell.js";
import { withDuration } from "../event-config/views.js";
import { blockingTasksByEvent, readinessByEvent } from "../scheduling/program-link.js";
import { sessionContent } from "./service.js";

/* -------------------------------------------------------------------------- */
/* Pure health aggregators — no I/O, unit-tested directly                     */
/* -------------------------------------------------------------------------- */

export interface HealthSessionInput {
  id: string;
  status: string;
  session_format_id: string;
  track_id: string | null;
  sponsor_id: string | null;
}

/** `sessions_by_status` — count per status. */
export function sessionsByStatus(sessions: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) out[s.status] = (out[s.status] ?? 0) + 1;
  return out;
}

/** `format_mix` — count per format. */
export function formatMixOf(sessions: { session_format_id: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) out[s.session_format_id] = (out[s.session_format_id] ?? 0) + 1;
  return out;
}

/** `track_balance` — confirmed-or-later count per track, compared to target elsewhere. */
export function trackBalanceOf(sessions: { track_id: string | null; status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const counts = new Set(["confirmed", "scheduled", "published", "delivered"]);
  for (const s of sessions) {
    if (!s.track_id || !counts.has(s.status)) continue;
    out[s.track_id] = (out[s.track_id] ?? 0) + 1;
  }
  return out;
}

export interface SponsorShareBucket {
  published: number;
  sponsored: number;
  share: number;
}

export interface SponsorSessionShare {
  overall: SponsorShareBucket;
  by_day: Record<string, SponsorShareBucket>;
}

function bucket(rows: { sponsor_id: string | null }[]): SponsorShareBucket {
  const sponsored = rows.filter((r) => r.sponsor_id).length;
  return { published: rows.length, sponsored, share: rows.length ? sponsored / rows.length : 0 };
}

/**
 * `sponsor_session_share` — "sponsored sessions / total published, per day and
 * overall." The ratio a program chair is judged on. `day_id` is `Placement`'s
 * `event_day_id`, or `"unscheduled"` for a published session with no placement.
 */
export function sponsorSessionShare(rows: { status: string; sponsor_id: string | null; day_id?: string | null }[]): SponsorSessionShare {
  const published = rows.filter((r) => r.status === "published" || r.status === "delivered");
  const byDay = new Map<string, { sponsor_id: string | null }[]>();
  for (const r of published) {
    const key = r.day_id ?? "unscheduled";
    const list = byDay.get(key) ?? [];
    list.push(r);
    byDay.set(key, list);
  }
  const by_day: Record<string, SponsorShareBucket> = {};
  for (const [key, list] of byDay) by_day[key] = bucket(list);
  return { overall: bucket(published), by_day };
}

/** Sessions still waiting on their speakers to confirm. */
export function unconfirmedSpeakerCount(sessions: { status: string }[]): number {
  return sessions.filter((s) => s.status === "pending_confirmation").length;
}

/** Distinct sessions with a blocking task overdue or due within `windowDays`. */
export function onboardingAtRiskSessionIds(
  tasks: { session_id: string | null; is_blocking: boolean; status: string; due_at: string | null }[],
  now: string,
  windowDays = 7,
): Set<string> {
  const horizon = addDays(now, windowDays);
  const out = new Set<string>();
  for (const t of tasks) {
    if (!t.session_id || !t.is_blocking) continue;
    if (!isNonTerminalTask(t.status as TaskInstanceStatus)) continue;
    if (!t.due_at || t.due_at > horizon) continue;
    out.add(t.session_id);
  }
  return out;
}

/** Confirmed sessions nobody has put in a room yet. */
export function unplacedConfirmedCount(sessions: { id: string; status: string }[], placedSessionIds: Set<string>): number {
  return sessions.filter((s) => s.status === "confirmed" && !placedSessionIds.has(s.id)).length;
}

export interface ProgramHealth {
  sessions_by_status: Record<string, number>;
  format_mix: { format_id: string; name: string; n: number }[];
  track_balance: { track_id: string; name: string; confirmed: number; target: number | null }[];
  sponsor_session_share: SponsorSessionShare;
  unconfirmed_speakers: number;
  onboarding_at_risk: number;
  unplaced_confirmed: number;
  unpublishable: number;
}

/**
 * The chair's dashboard (06, "Program health read model"). Derived, recomputed
 * on read (INV-11-6) — nothing here is a stored counter.
 */
export async function loadProgramHealth(
  app: AppContext,
  eventId: string,
  sessions: Row[],
  tracks: Row[],
  formats: Row[],
): Promise<ProgramHealth> {
  const sessionIds = sessions.map((s) => str(s.id));
  const [placements, tasks, readiness, blocking] = await Promise.all([
    sessionIds.length
      ? app.db.raw<Row>(
          `SELECT session_id, event_day_id FROM placement WHERE event_id = ?`,
          [eventId],
        )
      : Promise.resolve([]),
    app.db.raw<Row>(`SELECT session_id, is_blocking, status, due_at FROM task_instance WHERE event_id = ? AND session_id IS NOT NULL`, [eventId]),
    readinessByEvent(app, eventId),
    blockingTasksByEvent(app, eventId),
  ]);
  void blocking;

  const placedIds = new Set(placements.map((p) => str(p.session_id)));
  const dayBySession = new Map(placements.map((p) => [str(p.session_id), str(p.event_day_id)]));

  const shareRows = sessions.map((s) => ({
    status: str(s.status),
    sponsor_id: strOrNull(s.sponsor_id),
    day_id: dayBySession.get(str(s.id)) ?? null,
  }));

  const atRisk = onboardingAtRiskSessionIds(
    tasks.map((t) => ({
      session_id: strOrNull(t.session_id),
      is_blocking: bool(t.is_blocking),
      status: str(t.status),
      due_at: strOrNull(t.due_at),
    })),
    app.now(),
  );

  const statusCounts = sessionsByStatus(sessions.map((s) => ({ status: str(s.status) })));
  const formatCounts = formatMixOf(sessions.map((s) => ({ session_format_id: str(s.session_format_id) })));
  const trackCounts = trackBalanceOf(sessions.map((s) => ({ track_id: strOrNull(s.track_id), status: str(s.status) })));

  let unpublishable = 0;
  for (const s of sessions) {
    if (str(s.status) !== "scheduled") continue;
    if (!readiness.get(str(s.id))?.publishable) unpublishable++;
  }

  return {
    sessions_by_status: statusCounts,
    format_mix: formats.map((f) => ({ format_id: str(f.id), name: str(f.name), n: formatCounts[str(f.id)] ?? 0 })),
    track_balance: tracks.map((t) => ({
      track_id: str(t.id),
      name: str(t.name),
      confirmed: trackCounts[str(t.id)] ?? 0,
      target: t.target_session_count === null ? null : num(t.target_session_count),
    })),
    sponsor_session_share: sponsorSessionShare(shareRows),
    unconfirmed_speakers: unconfirmedSpeakerCount(sessions.map((s) => ({ status: str(s.status) }))),
    onboarding_at_risk: atRisk.size,
    unplaced_confirmed: unplacedConfirmedCount(sessions.map((s) => ({ id: str(s.id), status: str(s.status) })), placedIds),
    unpublishable,
  };
}

/* -------------------------------------------------------------------------- */
/* The board — GET /admin/events/:eventId/sessions                            */
/* -------------------------------------------------------------------------- */

export interface BoardFilters {
  q: string | null;
  status: string | null;
  track_id: string | null;
  format_id: string | null;
  origin: string | null;
  content_status: string | null;
  content_diverged: boolean | null;
}

export function boardFiltersFrom(url: URL): BoardFilters {
  const diverged = url.searchParams.get("content_diverged");
  return {
    q: url.searchParams.get("q"),
    status: url.searchParams.get("status") || null,
    track_id: url.searchParams.get("track_id") || null,
    format_id: url.searchParams.get("format_id") || null,
    origin: url.searchParams.get("origin") || null,
    content_status: url.searchParams.get("content_status") || null,
    content_diverged: diverged === "1" ? true : diverged === "0" ? false : null,
  };
}

export interface BoardSpeaker {
  person_id: string;
  name: string;
  role: string;
  confirmation_status: string;
}

export interface BoardPlacement {
  room_name: string;
  day_label: string;
  starts_at: string;
}

export interface BoardRow {
  id: string;
  reference: string;
  title: string;
  status: string;
  content_status: string;
  content_diverged: boolean;
  origin: string;
  sponsor_name: string | null;
  track_name: string | null;
  format_name: string;
  duration_minutes: number;
  onboarding_progress: number;
  blocking_tasks_outstanding: number;
  speakers: BoardSpeaker[];
  placement: BoardPlacement | null;
}

/**
 * Every matching session's content is compared against the decision snapshot
 * it was created from, in two batched queries rather than two-per-session
 * (06, `content_diverged`; the per-session version — `isContentDiverged` in
 * `service.ts` — is what the detail page uses).
 */
/** The accepted duration, or the session's own where the proposal named none. */
function baselineDuration(requested: unknown, sessionDuration: unknown): number {
  return requested === null || requested === undefined ? num(sessionDuration) : num(requested);
}

async function divergenceSet(app: AppContext, sessions: Row[]): Promise<Set<string>> {
  const proposalIds = sessions.filter((s) => s.proposal_id).map((s) => str(s.proposal_id));
  if (proposalIds.length === 0) return new Set();
  const [proposals, decisions] = await Promise.all([
    app.db.select<Row>("proposal", { id: proposalIds }, { includeDeleted: true }),
    app.db.select<Row>("decision", { proposal_id: proposalIds, status: "published" }, { orderBy: "decided_at DESC" }),
  ]);
  const proposalById = new Map(proposals.map((p) => [str(p.id), p]));
  const decisionByProposal = new Map<string, Row>();
  for (const d of decisions) {
    const pid = str(d.proposal_id);
    if (!decisionByProposal.has(pid)) decisionByProposal.set(pid, d); // first = latest, given the ORDER BY
  }

  const out = new Set<string>();
  for (const s of sessions) {
    if (!s.proposal_id) continue;
    const proposal = proposalById.get(str(s.proposal_id));
    if (!proposal) continue;
    const decision = decisionByProposal.get(str(s.proposal_id)) ?? null;
    const baseline: ContentSnapshot = {
      title: str(proposal.title),
      abstract: str(proposal.abstract),
      description: strOrNull(proposal.description),
      session_format_id: str(decision?.assigned_format_id ?? proposal.session_format_id ?? ""),
      // `num(null, fallback)` returns 0, not the fallback — `Number(null)` is a
      // finite 0. A proposal that never named a duration therefore produced a
      // baseline of 0, and every session built from one was flagged as edited
      // since acceptance forever, which is how a real signal becomes noise.
      duration_minutes: baselineDuration(decision?.assigned_duration_minutes ?? proposal.requested_duration_minutes, s.duration_minutes),
      track_id: strOrNull(decision?.assigned_track_id ?? proposal.assigned_track_id ?? proposal.track_id),
    };
    if (contentDiverged(sessionContent(s), baseline)) out.add(str(s.id));
  }
  return out;
}

export interface BoardLoad {
  rows: BoardRow[];
  health: ProgramHealth;
  tracks: Row[];
  formats: Row[];
}

export async function loadBoard(app: AppContext, eventId: string, filters: BoardFilters): Promise<BoardLoad> {
  const [sessions, tracks, formats] = await Promise.all([
    app.db.select<Row>("session", { event_id: eventId }, { orderBy: "reference" }),
    app.db.select<Row>("track", { event_id: eventId }, { orderBy: "sort_order, name" }),
    app.db.select<Row>("session_format", { event_id: eventId }, { orderBy: "sort_order, name" }),
  ]);

  const sessionIds = sessions.map((s) => str(s.id));
  const [speakerRows, placementRows, sponsors, divergence, health] = await Promise.all([
    sessionIds.length
      ? app.db.raw<Row>(
          `SELECT ss.session_id, ss.person_id, ss.speaker_role, ss.confirmation_status, p.full_name, p.display_name
             FROM session_speaker ss JOIN person p ON p.id = ss.person_id
            WHERE ss.session_id IN (${sessionIds.map(() => "?").join(",")})
              AND ss.confirmation_status NOT IN ('replaced','withdrawn')
            ORDER BY ss.sort_order`,
          sessionIds,
        )
      : Promise.resolve([]),
    app.db.raw<Row>(
      `SELECT pl.session_id, pl.starts_at, r.name AS room_name, d.label AS day_label, d.date AS day_date
         FROM placement pl JOIN room r ON r.id = pl.room_id JOIN event_day d ON d.id = pl.event_day_id
        WHERE pl.event_id = ?`,
      [eventId],
    ),
    app.db.select<Row>("sponsor", {}),
    divergenceSet(app, sessions),
    loadProgramHealth(app, eventId, sessions, tracks, formats),
  ]);

  const trackName = new Map(tracks.map((t) => [str(t.id), str(t.name)]));
  const formatName = new Map(formats.map((f) => [str(f.id), str(f.name)]));
  const sponsorName = new Map(sponsors.map((s) => [str(s.id), str(s.display_name) || str(s.name)]));

  const speakersBySession = new Map<string, BoardSpeaker[]>();
  for (const r of speakerRows) {
    const sid = str(r.session_id);
    const list = speakersBySession.get(sid) ?? [];
    list.push({
      person_id: str(r.person_id),
      name: str(r.display_name) || str(r.full_name),
      role: str(r.speaker_role),
      confirmation_status: str(r.confirmation_status),
    });
    speakersBySession.set(sid, list);
  }
  const placementBySession = new Map<string, BoardPlacement>();
  for (const p of placementRows) {
    placementBySession.set(str(p.session_id), {
      room_name: str(p.room_name),
      day_label: str(p.day_label) || str(p.day_date),
      starts_at: str(p.starts_at),
    });
  }

  const blocking = await blockingTasksByEvent(app, eventId);
  const taskRows = await app.db.raw<Row>(
    `SELECT session_id, status, is_blocking, is_required FROM task_instance WHERE event_id = ? AND session_id IS NOT NULL`,
    [eventId],
  );
  const tasksBySession = new Map<string, Row[]>();
  for (const t of taskRows) {
    const sid = str(t.session_id);
    const list = tasksBySession.get(sid) ?? [];
    list.push(t);
    tasksBySession.set(sid, list);
  }

  let filtered = sessions;
  if (filters.status) filtered = filtered.filter((s) => str(s.status) === filters.status);
  if (filters.track_id) filtered = filtered.filter((s) => str(s.track_id) === filters.track_id);
  if (filters.format_id) filtered = filtered.filter((s) => str(s.session_format_id) === filters.format_id);
  if (filters.origin) filtered = filtered.filter((s) => str(s.origin) === filters.origin);
  if (filters.content_status) filtered = filtered.filter((s) => str(s.content_status) === filters.content_status);
  if (filters.content_diverged !== null) {
    filtered = filtered.filter((s) => divergence.has(str(s.id)) === filters.content_diverged);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter((s) => {
      if (str(s.title).toLowerCase().includes(q) || str(s.reference).toLowerCase().includes(q)) return true;
      return (speakersBySession.get(str(s.id)) ?? []).some((sp) => sp.name.toLowerCase().includes(q));
    });
  }

  const rows: BoardRow[] = filtered.map((s) => {
    const id = str(s.id);
    const tasks = (tasksBySession.get(id) ?? []).map((t) => ({
      status: str(t.status) as TaskInstanceStatus,
      is_blocking: bool(t.is_blocking),
      is_required: bool(t.is_required),
    }));
    return {
      id,
      reference: str(s.reference),
      title: str(s.title),
      status: str(s.status),
      content_status: str(s.content_status),
      content_diverged: divergence.has(id),
      origin: str(s.origin),
      sponsor_name: s.sponsor_id ? (sponsorName.get(str(s.sponsor_id)) ?? null) : null,
      track_name: s.track_id ? (trackName.get(str(s.track_id)) ?? null) : null,
      format_name: formatName.get(str(s.session_format_id)) ?? "—",
      duration_minutes: num(s.duration_minutes),
      onboarding_progress: onboardingProgress(tasks),
      blocking_tasks_outstanding: blocking.get(id) ?? 0,
      speakers: speakersBySession.get(id) ?? [],
      placement: placementBySession.get(id) ?? null,
    };
  });

  return { rows, health: health, tracks, formats };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function healthTiles(ev: EventRef, health: ProgramHealth): SafeHtml {
  const share = health.sponsor_session_share.overall;
  const sharePct = share.published ? Math.round(share.share * 100) : 0;
  return html`<div class="stats">
    ${stat("confirmed", health.sessions_by_status.confirmed ?? 0, `/admin/events/${ev.id}/sessions?status=confirmed`)}
    ${stat("scheduled", health.sessions_by_status.scheduled ?? 0, `/admin/events/${ev.id}/sessions?status=scheduled`)}
    ${stat("published", health.sessions_by_status.published ?? 0, `/admin/events/${ev.id}/sessions?status=published`)}
    ${stat("unconfirmed speakers", health.unconfirmed_speakers, `/admin/events/${ev.id}/sessions?status=pending_confirmation`)}
    ${stat("onboarding at risk", health.onboarding_at_risk, `/admin/events/${ev.id}/onboarding`)}
    ${stat("unplaced, confirmed", health.unplaced_confirmed, `/admin/events/${ev.id}/sessions?status=confirmed`)}
    ${stat("not publishable", health.unpublishable, `/admin/events/${ev.id}/sessions?status=scheduled`)}
    ${stat(`sponsor share · published (${share.published})`, `${sharePct}%`)}
  </div>`;
}

function filterForm(ev: EventRef, filters: BoardFilters, tracks: Row[], formats: Row[]): SafeHtml {
  const statusOpts = ["pending_confirmation", "confirmed", "scheduled", "published", "cancelled", "delivered"].map((v) => ({ value: v, label: humanise(v) }));
  const originOpts = ["cfp", "sponsor", "invited", "organizer"].map((v) => ({ value: v, label: humanise(v) }));
  const contentOpts = ["draft", "in_review", "approved", "changes_requested"].map((v) => ({ value: v, label: humanise(v) }));
  const trackOpts = tracks.map((t) => ({ value: str(t.id), label: str(t.name) }));
  const formatOpts = formats.map((f) => ({ value: str(f.id), label: str(f.name) }));
  const active = Object.values(filters).filter((v) => v !== null && v !== undefined && v !== "").length;
  return html`<details class="filter-bar"${active > 0 ? raw(" open") : raw("")}>
    <summary>Filters${active > 0 ? html` <span class="badge info">${active}</span>` : raw("")}</summary>
    <form method="get" action="/admin/events/${ev.id}/sessions" class="inline-grid">
    ${field({ name: "q", label: "Search", value: filters.q ?? "", placeholder: "Title, reference or speaker" })}
    ${field({ name: "status", label: "Status", type: "select", value: filters.status ?? "", options: statusOpts })}
    ${field({ name: "track_id", label: "Track", type: "select", value: filters.track_id ?? "", options: trackOpts })}
    ${field({ name: "format_id", label: "Format", type: "select", value: filters.format_id ?? "", options: formatOpts })}
    ${field({ name: "origin", label: "Origin", type: "select", value: filters.origin ?? "", options: originOpts })}
    ${field({ name: "content_status", label: "Content status", type: "select", value: filters.content_status ?? "", options: contentOpts })}
    ${field({
      name: "content_diverged",
      label: "Diverged from decision",
      type: "select",
      value: filters.content_diverged === null ? "" : filters.content_diverged ? "1" : "0",
      options: [
        { value: "1", label: "Diverged" },
        { value: "0", label: "Not diverged" },
      ],
    })}
    <div class="actions">
      <button type="submit">Filter</button>
      ${active > 0 ? html`<a class="btn secondary" href="/admin/events/${ev.id}/sessions">Clear</a>` : raw("")}
    </div>
    </form>
  </details>`;
}

function speakerCell(speakers: BoardSpeaker[]): SafeHtml {
  if (speakers.length === 0) return html`<span class="muted small">No speakers yet</span>`;
  return html`${speakers.map(
    (s, i) => html`${i > 0 ? raw(", ") : raw("")}${s.name}${s.confirmation_status === "pending" ? html` <span class="badge warn">pending</span>` : raw("")}`,
  )}`;
}

function placementCell(p: BoardPlacement | null): SafeHtml {
  if (!p) return html`<span class="muted small">Unplaced</span>`;
  return html`${p.day_label}<br><span class="small muted">${p.room_name}</span>`;
}

export function programBoardView(input: {
  event: EventRef;
  rows: BoardRow[];
  filters: BoardFilters;
  health: ProgramHealth;
  tracks: Row[];
  formats: Row[];
  canWrite: boolean;
}): SafeHtml {
  const { event, rows, filters, health, tracks, formats, canWrite } = input;
  const trs = rows.map(
    (r) => html`<tr>
      <td class="mono small nowrap"><a href="/admin/sessions/${r.id}">${r.reference}</a></td>
      <td style="min-width:16rem"><a href="/admin/sessions/${r.id}"><strong>${r.title}</strong></a>${r.content_diverged ? html` <span class="badge warn" title="The session has been edited since it was accepted">diverged</span>` : raw("")}</td>
      <td>${speakerCell(r.speakers)}</td>
      <td>${r.track_name ?? html`<span class="muted">—</span>`}</td>
      <td class="nowrap">${r.format_name}<br><span class="small muted">${r.duration_minutes} min</span></td>
      <td>${badge(r.origin)}${r.sponsor_name ? html`<br><span class="small muted">${r.sponsor_name}</span>` : raw("")}</td>
      <td>${badge(r.status)}</td>
      <td>${badge(r.content_status)}</td>
      <td style="min-width:7rem">${progressBar(r.onboarding_progress)}${r.blocking_tasks_outstanding > 0 ? html`<span class="small muted">${r.blocking_tasks_outstanding} blocking</span>` : raw("")}</td>
      <td class="nowrap">${placementCell(r.placement)}</td>
    </tr>`,
  );
  return html`${pageHead(
      "Sessions",
      "The programme board — every session in this event, whether it came from the CFP, a sponsor, an invitation, or an organizer.",
      canWrite ? html`<a class="btn" href="/admin/events/${event.id}/sessions/new">New session</a>` : raw(""),
    )}
    ${healthTiles(event, health)}
    ${filterForm(event, filters, tracks, formats)}
    ${table(
      ["Reference", "Title", "Speakers", "Track", "Format", "Origin", "Status", "Content", "Onboarding", "Placement"],
      trs,
      "No sessions match these filters.",
    )}`;
}

export function newSessionFormView(input: { event: EventRef; tracks: Row[]; formats: Row[]; sponsors: Row[] }): SafeHtml {
  const { event, tracks, formats, sponsors } = input;
  const trackOpts = tracks.map((t) => ({ value: str(t.id), label: str(t.name) }));
  const formatOpts = formats.map((f) => ({ value: str(f.id), label: withDuration(str(f.name), num(f.default_duration_minutes)) }));
  const sponsorOpts = sponsors.map((s) => ({ value: str(s.id), label: str(s.display_name) || str(s.name) }));
  return html`${pageHead("New session", "Breaks, keynotes and registration blocks are sessions too — origin decides which rules apply.")}
    ${card(html`<form method="post" action="/admin/events/${event.id}/sessions/new" class="stack">
      ${field({
        name: "origin",
        label: "Origin",
        type: "select",
        required: true,
        value: "organizer",
        options: [
          { value: "organizer", label: "Organizer item (break, keynote, registration)" },
          { value: "sponsor", label: "Sponsor session" },
        ],
        help: "CFP and invited sessions come from an accepted proposal, not this form.",
      })}
      ${field({ name: "sponsor_id", label: "Sponsor", type: "select", options: sponsorOpts, help: "Required for a sponsor session; must have a confirmed sponsorship." })}
      ${field({ name: "title", label: "Title", required: true })}
      ${field({ name: "subtitle", label: "Subtitle" })}
      ${field({ name: "abstract", label: "Abstract", type: "textarea", rows: 4 })}
      ${field({ name: "session_format_id", label: "Format", type: "select", required: true, options: formatOpts })}
      ${field({ name: "track_id", label: "Track", type: "select", options: trackOpts })}
      ${field({ name: "duration_minutes", label: "Duration (minutes)", type: "number", required: true, min: 1, value: 30 })}
      ${field({ name: "speaker_full_name", label: "Speaker name" })}
      ${field({ name: "speaker_email", label: "Speaker email", type: "email", help: "Leave both blank to add speakers later." })}
      <button type="submit">Create session</button>
    </form>`)}`;
}

/* -------------------------------------------------------------------------- */
/* Session detail — GET /admin/sessions/:sessionId                            */
/* -------------------------------------------------------------------------- */

export interface DetailInput {
  event: EventRef;
  session: Row;
  content_diverged: boolean;
  track: Row | null;
  format: Row | null;
  sponsor: Row | null;
  tracks: Row[];
  formats: Row[];
  speakers: (Row & { name: string })[];
  relations: (Row & { related_title: string })[];
  otherSessions: Row[];
  assets: Row[];
  revisions: Row[];
  onboarding_progress: number;
  blocking_tasks_outstanding: number;
  placement: Row | null;
  canWrite: boolean;
  canApprove: boolean;
  canRestore: boolean;
}

/**
 * `submit-for-review` is gated by `session.manage` write (whoever may edit
 * content may send it on); `approve-content` / `request-content-changes` are
 * gated by `session.approve_content` write, which `track_lead` only reads and
 * `sponsor_manager` does not hold — the model's "have we done ours" gate is
 * narrower than "may edit this session's words".
 */
function contentApprovalPanel(session: Row, canWrite: boolean, canApprove: boolean): SafeHtml {
  const status = str(session.content_status);
  const forms: SafeHtml[] = [];
  if (canWrite && (status === "draft" || status === "changes_requested")) {
    forms.push(html`<form method="post" action="/admin/sessions/${str(session.id)}/submit-for-review" class="inline-form">
      <button type="submit" class="small">Submit for review</button>
    </form>`);
  }
  if (canApprove && status === "in_review") {
    forms.push(html`<form method="post" action="/admin/sessions/${str(session.id)}/approve-content" class="inline-form">
      <button type="submit" class="small">Approve content</button>
    </form>`);
    forms.push(html`<details class="row-edit"><summary>Request changes</summary>
      <form method="post" action="/admin/sessions/${str(session.id)}/request-content-changes" class="inline-grid">
        ${field({ name: "note", label: "What needs to change", type: "textarea", rows: 3, required: true })}
        <button type="submit" class="small">Request changes</button>
      </form>
    </details>`);
  }
  if (canWrite && status === "approved") {
    forms.push(html`<form method="post" action="/admin/sessions/${str(session.id)}/submit-for-review" class="inline-form">
      <button type="submit" class="small secondary">Send for re-review</button>
    </form>`);
  }
  return html`<p>${badge(status)} ${status === "draft" ? html`<span class="small muted">Not submitted for editorial review yet — <span class="mono">draft → approved</span> has no shortcut.</span>` : raw("")}</p>
    <div class="actions">${forms}</div>`;
}

function revisionsPanel(session: Row, revisions: Row[], canRestore: boolean): SafeHtml {
  const rows = revisions.map((r) => {
    const diff = (() => {
      try {
        return JSON.parse(str(r.diff, "{}")) as Record<string, { from: unknown; to: unknown }>;
      } catch {
        return {};
      }
    })();
    const fields = Object.keys(diff);
    return html`<tr>
      <td>#${num(r.revision_number)}</td>
      <td>${humanise(str(r.change_kind))}${r.restored_from_revision_id ? html` <span class="small muted">from #${(() => {
              const src = revisions.find((x) => str(x.id) === str(r.restored_from_revision_id));
              return src ? num(src.revision_number) : "?";
            })()}</span>` : raw("")}</td>
      <td>${str(r.created_at).slice(0, 19).replace("T", " ")}</td>
      <td>${fields.length === 0
        ? html`<span class="muted small">No content fields changed</span>`
        : html`<ul class="diff-list">${fields.map((f) => html`<li><span class="mono small">${f}</span>: <span class="small">${diffValue(diff[f].from)}</span> → <span class="small">${diffValue(diff[f].to)}</span></li>`)}</ul>`}</td>
      <td class="right">
        ${canRestore
          ? html`<form method="post" action="/admin/sessions/${str(session.id)}/restore/${str(r.id)}" class="inline-form" onsubmit="return confirm('Restore this revision? A new revision is written forward — nothing is rewound.')">
              <button type="submit" class="small secondary">Restore</button>
            </form>`
          : raw("")}
      </td>
    </tr>`;
  });
  return table(["#", "Kind", "When", "What changed", ""], rows, "No revisions yet.");
}

function diffValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ") || "—";
  return String(v);
}

function speakerRow(session: Row, s: Row & { name: string }, canWrite: boolean): SafeHtml {
  const personId = str(s.person_id);
  return html`<tr>
    <td>${s.name}${bool(s.is_public) ? raw("") : html` <span class="badge">not public</span>`}</td>
    <td>${badge(str(s.speaker_role))}</td>
    <td>${badge(str(s.confirmation_status))}</td>
    <td>${str(s.attendance_mode) ? humanise(str(s.attendance_mode)) : html`<span class="muted">—</span>`}</td>
    <td class="right">
      ${canWrite
        ? html`<details class="row-edit"><summary>Manage</summary>
            <form method="post" action="/admin/sessions/${str(session.id)}/speakers/${personId}/confirm" class="inline-form">
              <button type="submit" class="small">Confirm on their behalf</button>
            </form>
            <form method="post" action="/admin/sessions/${str(session.id)}/speakers/${personId}/replace" class="inline-grid">
              ${field({ name: "full_name", label: "Replacement name" })}
              ${field({ name: "email", label: "Replacement email", type: "email" })}
              <button type="submit" class="small">Replace</button>
            </form>
            <form method="post" action="/admin/sessions/${str(session.id)}/speakers/${personId}/remove" class="inline-grid" onsubmit="return confirm('Remove this speaker?')">
              ${field({ name: "reason", label: "Reason", required: true })}
              <button type="submit" class="small danger">Remove</button>
            </form>
          </details>`
        : raw("")}
    </td>
  </tr>`;
}

export function sessionDetailView(d: DetailInput): SafeHtml {
  const s = d.session;
  const sid = str(s.id);
  const publishedNotLive = !!s.published_at && str(s.status) !== "published" && str(s.status) !== "delivered";
  const contentEditWarn = str(s.status) === "published"
    ? html`<p class="notice warn">This session is published. Editing its content here will not change what is already live until it is republished.</p>`
    : raw("");

  return html`${pageHead(
      s.title ? str(s.title) : "Untitled session",
      `${str(s.reference)} · ${humanise(str(s.origin))}`,
      d.canWrite && str(s.status) !== "cancelled"
        ? html`<details class="row-edit"><summary class="btn danger small">Cancel</summary>
            <form method="post" action="/admin/sessions/${sid}/cancel" class="inline-grid">
              ${field({ name: "reason", label: "Reason", required: true, help: "Cancellation is audited with a reason." })}
              <button type="submit" class="small danger">Cancel session</button>
            </form>
          </details>`
        : raw(""),
    )}
    <div class="stats">
      ${stat("status", badge(str(s.status)))}
      ${stat("content", badge(str(s.content_status)))}
      ${stat("onboarding", `${d.onboarding_progress}%`)}
      ${stat("blocking tasks", d.blocking_tasks_outstanding)}
      ${d.sponsor ? stat("sponsor", str(d.sponsor.display_name) || str(d.sponsor.name)) : raw("")}
    </div>
    ${publishedNotLive ? html`<p class="notice warn">This has been published before but the current edit has not gone live yet.</p>` : raw("")}
    ${d.content_diverged ? html`<p class="notice warn">This session has been edited since it was accepted, so it no longer matches the proposal the committee decided on. That is normal — the flag is here because nothing else announces it.</p>` : raw("")}

    ${card(
      html`${contentEditWarn}
        <form method="post" action="/admin/sessions/${sid}" class="stack">
          ${versionField(s)}
          ${field({ name: "title", label: "Title", required: true, value: str(s.title), attrs: d.canWrite ? "" : "disabled" })}
          ${field({ name: "subtitle", label: "Subtitle", value: str(s.subtitle) })}
          ${field({ name: "abstract", label: "Abstract", type: "textarea", rows: 4, value: str(s.abstract) })}
          ${field({ name: "description", label: "Description", type: "textarea", rows: 6, value: str(s.description), help: "Long form, for the session page." })}
          ${field({ name: "session_format_id", label: "Format", type: "select", value: str(s.session_format_id), options: d.formats.map((f) => ({ value: str(f.id), label: str(f.name) })) })}
          ${field({ name: "track_id", label: "Track", type: "select", value: str(s.track_id), options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })) })}
          ${field({ name: "duration_minutes", label: "Duration (minutes)", type: "number", required: true, min: 1, value: num(s.duration_minutes) })}
          ${field({ name: "audience_level", label: "Audience level", type: "select", value: str(s.audience_level), options: ["beginner", "intermediate", "advanced", "all"].map((v) => ({ value: v, label: humanise(v) })) })}
          ${field({ name: "language", label: "Language", value: str(s.language) })}
          ${field({ name: "visibility", label: "Visibility", type: "select", value: str(s.visibility), options: [{ value: "public", label: "Public" }, { value: "internal", label: "Internal — never published" }] })}
          ${d.canWrite ? html`<button type="submit">Save content</button>` : raw("")}
        </form>`,
      "Content",
    )}

    ${card(contentApprovalPanel(s, d.canWrite, d.canApprove), "Content approval")}

    ${card(
      html`${table(["Speaker", "Role", "Confirmation", "Attendance", ""], d.speakers.map((sp) => speakerRow(s, sp, d.canWrite)), "No speakers credited yet.")}
        ${d.canWrite
          ? html`<form method="post" action="/admin/sessions/${sid}/speakers" class="inline-grid">
              ${field({ name: "full_name", label: "Name" })}
              ${field({ name: "email", label: "Email", type: "email" })}
              ${field({ name: "speaker_role", label: "Role", type: "select", value: "co_speaker", options: ["primary", "co_speaker", "moderator", "panelist", "host"].map((v) => ({ value: v, label: humanise(v) })) })}
              ${field({ name: "override_reason", label: "Override reason", help: "Only needed past the format's speaker limit." })}
              <button type="submit" class="small">Add speaker</button>
            </form>`
          : raw("")}`,
      "Speakers",
    )}

    ${card(
      html`${d.placement
          ? html`<p><strong>${str(d.placement.room_name ?? "")}</strong> · ${str(d.placement.starts_at).slice(0, 16).replace("T", " ")}</p>`
          : empty("Not placed on the schedule yet.")}`,
      "Placement",
    )}

    ${card(
      html`${table(["File", "Kind", "Public"], d.assets.map((a) => html`<tr><td>${str(a.asset_id)}</td><td>${badge(str(a.kind))}</td><td>${bool(a.is_public) ? badge("public", "ok") : badge("staff only")}</td></tr>`), "No files attached yet.")}
        ${d.canWrite
          ? html`<form method="post" action="/admin/sessions/${sid}/assets" class="inline-grid">
              ${field({ name: "asset_id", label: "Asset id", required: true, help: "Uploaded through the Files tool first." })}
              ${field({ name: "kind", label: "Kind", type: "select", value: "slides", options: ["slides", "cover_image", "handout", "code_repo_link", "recording", "transcript", "other"].map((v) => ({ value: v, label: humanise(v) })) })}
              ${field({ name: "is_public", label: "Public", type: "checkbox" })}
              <button type="submit" class="small">Attach</button>
            </form>`
          : raw("")}`,
      "Assets",
    )}

    ${card(
      html`${d.relations.length
          ? table(["Related session", "Relation"], d.relations.map((r) => html`<tr><td>${r.related_title}</td><td>${badge(str(r.relation).replace(/_/g, " "))}</td></tr>`))
          : empty("No related sessions.")}
        ${d.canWrite
          ? html`<form method="post" action="/admin/sessions/${sid}/relations" class="inline-grid">
              ${field({ name: "related_session_id", label: "Related session", type: "select", options: d.otherSessions.map((o) => ({ value: str(o.id), label: `${str(o.reference)} · ${str(o.title)}` })) })}
              ${field({ name: "relation", label: "Relation", type: "select", options: ["part_of_series", "continues_in", "prerequisite_for", "merged_from", "alternative_to"].map((v) => ({ value: v, label: humanise(v) })) })}
              <button type="submit" class="small">Link</button>
            </form>`
          : raw("")}`,
      "Related sessions",
    )}

    ${card(revisionsPanel(s, d.revisions, d.canRestore), "Revision history")}`;
}

/* -------------------------------------------------------------------------- */
/* Portal — the speaker's own sessions                                        */
/* -------------------------------------------------------------------------- */

export function portalSessionListView(sessions: (Row & { reference: string })[]): SafeHtml {
  const rows = sessions.map(
    (s) => html`<tr>
      <td><a href="/portal/sessions/${str(s.id)}"><strong>${str(s.title)}</strong></a><br><span class="small muted mono">${str(s.reference)}</span></td>
      <td>${badge(str(s.status))}</td>
      <td>${badge(str(s.my_confirmation_status ?? ""))}</td>
    </tr>`,
  );
  return html`${pageHead("My sessions", "Everything you are credited on.")}${table(["Session", "Status", "Your confirmation"], rows, "You are not credited on any sessions yet.")}`;
}

export function portalSessionDetailView(input: {
  session: Row;
  myPersonId: string;
  myStatus: string;
  coSpeakers: (Row & { name: string })[];
  tasks: Row[];
  placement: Row | null;
}): SafeHtml {
  const { session: s, myStatus, coSpeakers, tasks, placement } = input;
  const canAnswer = myStatus === "pending";
  return html`${pageHead(str(s.title), humanise(str(s.status)))}
    ${s.abstract ? html`<p>${str(s.abstract)}</p>` : raw("")}
    ${placement
      ? html`<p><strong>${str(placement.room_name ?? "")}</strong> · ${str(placement.starts_at ?? "").slice(0, 16).replace("T", " ")}</p>`
      : html`<p class="muted">Not yet placed on the schedule.</p>`}
    ${card(
      html`<p>Your participation: ${badge(myStatus)}</p>
        ${canAnswer
          ? html`<div class="actions">
              <form method="post" action="/portal/sessions/${str(s.id)}/confirm" class="inline-form"><button type="submit">Confirm I'm speaking</button></form>
              <form method="post" action="/portal/sessions/${str(s.id)}/decline" class="inline-grid">
                ${field({ name: "reason", label: "Reason for declining", required: true })}
                <button type="submit" class="secondary">Decline</button>
              </form>
            </div>`
          : raw("")}`,
      "Confirm your participation",
    )}
    ${card(
      coSpeakers.length ? table(["Co-speaker", "Confirmation"], coSpeakers.map((c) => html`<tr><td>${c.name}</td><td>${badge(str(c.confirmation_status))}</td></tr>`)) : empty("You are the only speaker credited."),
      "Co-speakers",
    )}
    ${card(
      tasks.length
        ? table(["Task", "Status", "Due"], tasks.map((t) => html`<tr><td><a href="/portal/tasks/${str(t.id)}">${str(t.title)}</a></td><td>${badge(str(t.status))}</td><td>${strOrNull(t.due_at)?.slice(0, 10) ?? "—"}</td></tr>`))
        : empty("No tasks yet."),
      "Your tasks",
    )}`;
}
