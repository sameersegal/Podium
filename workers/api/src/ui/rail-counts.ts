/**
 * The numbers beside the console rail's destinations.
 *
 * A rail that only says where you can go is a list of links. The counts are
 * what make it a status board: an organizer opening any screen can see, without
 * navigating, that Onboarding has seven things past due and Decisions has
 * twelve nobody has been told about.
 *
 * ## Why it runs here rather than in `adminPage`
 *
 * `adminPage` is synchronous and has a hundred call sites. Threading counts
 * through all of them would mean ninety-nine screens passing numbers about a
 * screen they are not on, and any screen that forgot would draw a different
 * rail from the one beside it — the rail would flicker as you moved through
 * admin, which is worse than a rail with no numbers at all.
 *
 * So it loads once per request, before the router, in the same seam
 * `consoleDocument` already uses, and `adminPage` reads it off the context.
 *
 * ## What it costs
 *
 * One query. Every count is a scalar subselect in a single statement rather
 * than seven round trips, because this runs on every admin page view and D1
 * charges for round trips, not for subselects. Nothing here is stored and
 * nothing is cached: these are derived numbers and a stored counter is a
 * counter that will disagree with the rows that produce it (11, "Derived
 * fields", and R8).
 *
 * Every number below already exists in `surfaces/dashboard.ts` and is computed
 * the same way. Where the two ever disagree, that file is right and this one is
 * the defect — it exists for speed, not as a second definition.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { num, type Row } from "@podiumstack/data/db.js";

export interface RailCounts {
  /** Provisional decisions — the loudest thing on `/admin`, so it labels Today. */
  today?: number;
  cfps?: number;
  proposals?: number;
  review?: number;
  decisions?: number;
  sessions?: number;
  /** Tasks past their due date. Drawn in danger, because they already are. */
  onboarding?: number;
  /** `24/42` — placed against sessions. */
  agenda?: string;
  /** `v7` — the live publication, or nothing if the schedule has never gone out. */
  publish?: string;
}

/**
 * `?` rather than `?1`, and the event id repeated, to match the parameter style
 * every other raw query in this codebase uses. A statement that binds one way
 * here and another way in `dashboard.ts` is a statement somebody will copy
 * wrong.
 */
const SQL = `
  SELECT
    (SELECT COUNT(*) FROM call_for_proposals
      WHERE event_id = ? AND deleted_at IS NULL)                                         AS cfps,
    (SELECT COUNT(*) FROM proposal
      WHERE event_id = ? AND deleted_at IS NULL AND status != 'draft')                   AS proposals,
    (SELECT COUNT(*) FROM proposal
      WHERE event_id = ? AND deleted_at IS NULL AND status = 'in_review')                AS in_review,
    (SELECT COUNT(*) FROM decision d JOIN proposal p ON p.id = d.proposal_id
      WHERE p.event_id = ? AND d.status = 'provisional')                                 AS provisional,
    (SELECT COUNT(*) FROM session
      WHERE event_id = ? AND deleted_at IS NULL AND status != 'cancelled')               AS sessions,
    (SELECT COUNT(*) FROM task_instance
      WHERE event_id = ? AND due_at IS NOT NULL AND due_at < ?
        AND status NOT IN ('completed','waived','cancelled'))                            AS overdue,
    (SELECT COUNT(DISTINCT p.session_id) FROM placement p JOIN session s ON s.id = p.session_id
      WHERE p.event_id = ? AND s.deleted_at IS NULL AND s.status != 'cancelled')         AS placed,
    (SELECT MAX(version) FROM schedule_publication
      WHERE event_id = ? AND status = 'live')                                            AS live_version
`;

export async function loadRailCounts(app: AppContext, eventId: string, now: string): Promise<RailCounts> {
  const rows = await app.db.raw<Row>(SQL, [eventId, eventId, eventId, eventId, eventId, eventId, now, eventId, eventId]);
  const r = rows[0];
  if (!r) return {};
  const sessions = num(r.sessions);
  const placed = num(r.placed);
  const liveVersion = num(r.live_version);
  return {
    today: num(r.provisional),
    cfps: num(r.cfps),
    proposals: num(r.proposals),
    review: num(r.in_review),
    decisions: num(r.provisional),
    sessions,
    onboarding: num(r.overdue),
    // Only worth the space once there is something to place. `0/0` beside
    // Agenda on a brand-new event is a number that means "nothing has happened
    // yet", which the empty rail already says.
    agenda: sessions > 0 ? `${placed}/${sessions}` : undefined,
    publish: liveVersion > 0 ? `v${liveVersion}` : undefined,
  };
}
