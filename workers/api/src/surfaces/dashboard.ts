/**
 * The event dashboard — a cross-context read model.
 *
 * It sits in `surfaces/` beside `admin-home.ts` for the same reason that one
 * does: an organizer's "what needs me today" spans submissions, review,
 * program, onboarding, scheduling and sponsorship, and a read that spans six
 * contexts belongs to none of them. Nothing here writes, and nothing here is
 * stored — every number is computed at read time from the rows that produce it,
 * because a stored counter is a counter that will disagree with them (11,
 * "Derived fields", and R8).
 *
 * The rule the numbers follow: **every count is something a person could act
 * on**, and every one of them names the screen where the action lives. A
 * dashboard that reports totals nobody can move is a dashboard people stop
 * opening — which is what the old overview screen was, five counts of
 * configuration rows above a settings form.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { activationCheck } from "../contexts/event-config/service.js";
import { derivedCfpStatus } from "../contexts/event-config/views.js";
import { pendingChanges } from "../contexts/scheduling/publication.js";

export interface DashboardCounts {
  [key: string]: number;
}

export interface DashboardDeadline {
  label: string;
  at: string;
  kind: "cfp" | "review" | "confirmation" | "event";
  href: string | null;
}

export interface EventDashboard {
  event: { id: string; name: string; slug: string; status: string; timezone: string; starts_on: string; ends_on: string };
  funnel: { key: string; label: string; count: number; href: string }[];
  submissions_by_day: { date: string; count: number }[];
  cfps: { id: string; name: string; status: string; closes_at: string; submissions: number }[];
  review: {
    rounds: {
      id: string;
      name: string;
      status: string;
      target: number;
      assignments: number;
      submitted: number;
      declined: number;
      below_quorum: number;
    }[];
    reviewers_behind: { person_id: string; name: string; outstanding: number; overdue: number }[];
  };
  decisions: DashboardCounts;
  onboarding: {
    open: number;
    blocking_open: number;
    overdue: number;
    awaiting_review: number;
    by_status: { status: string; count: number }[];
  };
  schedule: DashboardCounts;
  sponsorship: { sponsorships: number; entitlements_granted: number; entitlements_consumed: number; holds_expiring: number };
  readiness: { ready: boolean; blockers: string[] };
  deadlines: DashboardDeadline[];
}

const OPEN_TASK_STATES = "('blocked','not_started','in_progress','submitted','changes_requested')";

async function one(app: AppContext, sql: string, params: unknown[]): Promise<number> {
  const rows = await app.db.raw<{ n: number }>(sql, params);
  return rows[0] ? num(rows[0].n) : 0;
}

/** Reads one status out of a `GROUP BY status` result. Absent means zero. */
function tally(rows: { status: string; n: number }[]): (status: string) => number {
  const map = new Map(rows.map((r) => [str(r.status), num(r.n)]));
  return (status: string) => map.get(status) ?? 0;
}

/** Adds up the statuses a partition covers, from the same grouped result. */
function sum(rows: { status: string; n: number }[], keep: (status: string) => boolean): number {
  return rows.reduce((total, r) => (keep(str(r.status)) ? total + num(r.n) : total), 0);
}

/**
 * Which parts of the read model a caller actually renders.
 *
 * `today` is `/admin`: the funnel, the five queues that need a person, one
 * round, and the deadlines. It renders no submission chart, no per-call table,
 * no sponsorship totals and no activation checklist — so it should not pay for
 * them. "Ship the fields the widget renders" (implementer.md, G) is a rule
 * about queries as much as about payloads.
 *
 * The skipped sections come back empty rather than absent, so the shape is one
 * type and a caller that asks for `today` and then reads `sponsorship` gets
 * zeroes rather than a crash. A screen that needs a section asks for `all`.
 */
export type DashboardSections = "today" | "all";

export async function eventDashboard(
  app: AppContext,
  eventId: string,
  now: string,
  sections: DashboardSections = "all",
): Promise<EventDashboard> {
  const full = sections === "all";
  const event = await app.db.byId<Row>("event", eventId);
  if (!event) throw new Error("no such event");
  const base = `/admin/events/${eventId}`;

  // One statement per table, grouped, rather than one per status. Eleven
  // `COUNT(*) … WHERE status = ?` round trips answered the same question as a
  // single `GROUP BY status`, and this read model is on the console's hottest
  // route — every dashboard view paid for all of them.
  const [byStatus, sessionsByStatus, placed] = await Promise.all([
    app.db.raw<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM proposal WHERE event_id = ? AND deleted_at IS NULL GROUP BY status",
      [eventId],
    ),
    app.db.raw<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM session WHERE event_id = ? AND deleted_at IS NULL GROUP BY status",
      [eventId],
    ),
    one(
      app,
      `SELECT COUNT(DISTINCT p.session_id) AS n FROM placement p
         JOIN session s ON s.id = p.session_id
        WHERE p.event_id = ? AND s.deleted_at IS NULL AND s.status != 'cancelled'`,
      [eventId],
    ),
  ]);

  const proposalsIn = tally(byStatus);
  const sessionsIn = tally(sessionsByStatus);
  const drafts = proposalsIn("draft");
  const submitted = proposalsIn("submitted");
  const inReview = proposalsIn("in_review");
  const changesRequested = proposalsIn("changes_requested");
  const accepted = proposalsIn("accepted");
  const waitlisted = proposalsIn("waitlisted");
  const rejected = proposalsIn("rejected");
  const withdrawn = proposalsIn("withdrawn");
  // "Cancelled is not a session any more" and "confirmed onwards" are the two
  // partitions every caller wants, so they are derived here rather than asked
  // for separately.
  const sessions = sum(sessionsByStatus, (st) => st !== "cancelled");
  const confirmed = sum(sessionsByStatus, (st) => ["confirmed", "scheduled", "published", "delivered"].includes(st));

  /**
   * The funnel is the shape of the round: how many came in, how many are being
   * looked at, how many were decided, how many turned into a session, how many
   * of those have a room and a time. Each step links to the screen that moves
   * proposals out of it.
   */
  const funnel = [
    { key: "draft", label: "Drafts", count: drafts, href: `${base}/proposals?status=draft` },
    { key: "submitted", label: "Awaiting review", count: submitted, href: `${base}/proposals?status=submitted` },
    { key: "in_review", label: "In review", count: inReview, href: `${base}/review` },
    { key: "accepted", label: "Accepted", count: accepted, href: `${base}/decisions` },
    { key: "confirmed", label: "Confirmed sessions", count: confirmed, href: `${base}/sessions` },
    { key: "placed", label: "On the schedule", count: placed, href: `${base}/schedule` },
  ];

  /** Thirty days of submission volume — the only reliable read on whether a call is landing. */
  const byDay = !full ? [] : await app.db.raw<{ date: string; n: number }>(
    `SELECT substr(submitted_at, 1, 10) AS date, COUNT(*) AS n
       FROM proposal
      WHERE event_id = ? AND deleted_at IS NULL AND submitted_at IS NOT NULL AND submitted_at >= ?
      GROUP BY date ORDER BY date`,
    [eventId, isoDaysAgo(now, 30)],
  );

  // The deadline list needs the calls' close times whatever the caller asked
  // for, so the rows are always read; only the per-call submission counts and
  // derived statuses are skipped.
  const cfpRows = await app.db.select<Row>("call_for_proposals", { event_id: eventId }, { orderBy: "closes_at" });
  // One grouped count for every call, not one per call.
  const submissionRows = full && cfpRows.length
    ? await app.db.raw<{ cfp_id: string; n: number }>(
        `SELECT cfp_id, COUNT(*) AS n FROM proposal
          WHERE event_id = ? AND deleted_at IS NULL AND status != 'draft'
          GROUP BY cfp_id`,
        [eventId],
      )
    : [];
  const submissionsByCfp = new Map(submissionRows.map((r) => [str(r.cfp_id), num(r.n)]));
  const cfps = !full ? [] : await Promise.all(
    cfpRows.map(async (c) => ({
      id: str(c.id),
      name: str(c.name),
      status: await derivedCfpStatus(app, c, event),
      closes_at: str(c.closes_at),
      submissions: submissionsByCfp.get(str(c.id)) ?? 0,
    })),
  );

  /* review ------------------------------------------------------------------ */

  const roundRows = await app.db.select<Row>("review_round", { event_id: eventId }, { orderBy: "sequence" });

  // Four statements per round became two for all of them. The old shape was a
  // textbook N+1: a chair with six rounds paid twenty-four round trips to fill
  // in one card. Both queries are grouped by round, so the cost is flat in the
  // number of rounds.
  const [assignmentRows, quorumRows] = roundRows.length
    ? await Promise.all([
        app.db.raw<{ round_id: string; n: number; submitted: number; declined: number }>(
          `SELECT round_id,
                  COUNT(*)                                                AS n,
                  SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END)   AS submitted,
                  SUM(CASE WHEN status = 'declined'  THEN 1 ELSE 0 END)   AS declined
             FROM review_assignment
            WHERE round_id IN (SELECT id FROM review_round WHERE event_id = ?)
            GROUP BY round_id`,
          [eventId],
        ),
        // A proposal short of its round's target is one the committee cannot
        // decide yet (INV-05-11), which is the number a chair is looking for.
        // The target is joined from the round rather than bound per round, so
        // every round's shortfall comes back in one pass.
        app.db.raw<{ round_id: string; n: number }>(
          `SELECT round_id, COUNT(*) AS n FROM (
             SELECT a.round_id AS round_id, a.proposal_id
               FROM review_assignment a
               JOIN review_round r ON r.id = a.round_id
              WHERE r.event_id = ?
              GROUP BY a.round_id, a.proposal_id
             HAVING SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END)
                    < MAX(COALESCE(NULLIF(r.target_reviews_per_proposal, 0), 1))
           )
           GROUP BY round_id`,
          [eventId],
        ),
      ])
    : [[], []];

  const assignmentsByRound = new Map(assignmentRows.map((r) => [str(r.round_id), r]));
  const quorumByRound = new Map(quorumRows.map((r) => [str(r.round_id), num(r.n)]));

  const rounds = roundRows.map((r) => {
    const roundId = str(r.id);
    const stats = assignmentsByRound.get(roundId);
    return {
      id: roundId,
      name: str(r.name),
      status: str(r.status),
      target: num(r.target_reviews_per_proposal, 1) || 1,
      assignments: stats ? num(stats.n) : 0,
      submitted: stats ? num(stats.submitted) : 0,
      declined: stats ? num(stats.declined) : 0,
      below_quorum: quorumByRound.get(roundId) ?? 0,
    };
  });

  /**
   * Who is holding the round up. Named rather than counted, because "eleven
   * reviews outstanding" is not actionable and "Priya has eleven, four overdue"
   * is a message someone can send.
   */
  const behindRows = await app.db.raw<{ person_id: string; name: string; outstanding: number; overdue: number }>(
    `SELECT a.reviewer_person_id AS person_id,
            COALESCE(pe.display_name, pe.full_name) AS name,
            COUNT(*) AS outstanding,
            SUM(CASE WHEN a.due_at IS NOT NULL AND a.due_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM review_assignment a
       JOIN review_round r ON r.id = a.round_id
       JOIN person pe ON pe.id = a.reviewer_person_id
      WHERE r.event_id = ? AND r.status = 'open' AND a.status IN ('assigned','in_progress')
      GROUP BY a.reviewer_person_id, name
      ORDER BY overdue DESC, outstanding DESC
      LIMIT 8`,
    [now, eventId],
  );

  /* decisions --------------------------------------------------------------- */

  const [provisional, awaitingConfirmation, confirmationOverdue] = await Promise.all([
    // R5 — a decision is provisional until it is explicitly published, and the
    // gap between the two is the "saved a dropdown, emailed 400 rejections"
    // failure this number exists to make visible.
    one(
      app,
      `SELECT COUNT(*) AS n FROM decision d JOIN proposal p ON p.id = d.proposal_id
        WHERE p.event_id = ? AND d.status = 'provisional'`,
      [eventId],
    ),
    one(
      app,
      `SELECT COUNT(*) AS n FROM session
        WHERE event_id = ? AND deleted_at IS NULL AND status = 'pending_confirmation'`,
      [eventId],
    ),
    one(
      app,
      `SELECT COUNT(*) AS n FROM proposal
        WHERE event_id = ? AND deleted_at IS NULL AND status = 'accepted'
          AND confirmation_deadline IS NOT NULL AND confirmation_deadline < ?
          AND session_id IN (SELECT id FROM session WHERE status = 'pending_confirmation')`,
      [eventId, now],
    ),
  ]);

  /* onboarding -------------------------------------------------------------- */

  // One pass over `task_instance`, with the four partitions as conditional
  // sums. They are four questions about the same rows, and asking each one
  // separately was four scans of the same index.
  const taskRows = await app.db.raw<{ status: string; n: number; blocking: number; overdue: number; awaiting: number }>(
    `SELECT status,
            COUNT(*)                                                                     AS n,
            SUM(CASE WHEN is_blocking = 1 THEN 1 ELSE 0 END)                             AS blocking,
            SUM(CASE WHEN due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END)            AS overdue,
            SUM(CASE WHEN requires_review = 1 THEN 1 ELSE 0 END)                          AS awaiting
       FROM task_instance
      WHERE event_id = ?
      GROUP BY status`,
    [now, eventId],
  );
  const isOpenTask = (status: string) =>
    ["blocked", "not_started", "in_progress", "submitted", "changes_requested"].includes(status);
  const openTasks = taskRows.reduce((t, r) => (isOpenTask(str(r.status)) ? t + num(r.n) : t), 0);
  const blockingOpen = taskRows.reduce((t, r) => (isOpenTask(str(r.status)) ? t + num(r.blocking) : t), 0);
  const overdueTasks = taskRows.reduce((t, r) => (isOpenTask(str(r.status)) ? t + num(r.overdue) : t), 0);
  const awaitingReview = taskRows.reduce((t, r) => (str(r.status) === "submitted" ? t + num(r.awaiting) : t), 0);
  const taskByStatus = taskRows.map((r) => ({ status: str(r.status), n: num(r.n) }));

  /* schedule ---------------------------------------------------------------- */

  const conflictRows = await app.db.raw<{ severity: string; n: number }>(
    `SELECT severity, COUNT(*) AS n FROM schedule_conflict
      WHERE event_id = ? AND acknowledged_reason IS NULL GROUP BY severity`,
    [eventId],
  );
  const conflictsBy = tally(conflictRows.map((r) => ({ status: str(r.severity), n: num(r.n) })));
  const conflictErrors = conflictsBy("error");
  const conflictWarnings = conflictsBy("warning");

  const pending = await pendingChanges(app, eventId);

  /* sponsorship ------------------------------------------------------------- */

  // Four counts over the same two joined tables, in one statement.
  const sponsorRows = !full ? [] : await app.db.raw<{ sponsorships: number; granted: number; consumed: number; holds: number }>(
    `SELECT
       (SELECT COUNT(*) FROM sponsorship WHERE event_id = ? AND status != 'cancelled')             AS sponsorships,
       (SELECT COALESCE(SUM(e.quantity), 0) FROM entitlement e
          JOIN sponsorship sp ON sp.id = e.sponsorship_id
         WHERE sp.event_id = ? AND sp.status != 'cancelled'
           AND e.entitlement_type IN ('session_slot','workshop_slot','lightning_slot','keynote_slot')) AS granted,
       -- \`consumed_count\` is derived (R8) — counted from the proposals that hold
       -- the entitlement, never from a stored counter, because a sponsor losing
       -- a slot they paid for is what drift costs here.
       (SELECT COUNT(*) FROM proposal p
          JOIN entitlement e ON e.id = p.entitlement_id
          JOIN sponsorship sp ON sp.id = e.sponsorship_id
         WHERE sp.event_id = ? AND p.deleted_at IS NULL
           AND p.status NOT IN ('withdrawn','rejected','expired'))                                 AS consumed,
       (SELECT COUNT(*) FROM entitlement e
          JOIN sponsorship sp ON sp.id = e.sponsorship_id
         WHERE sp.event_id = ? AND e.expires_at IS NOT NULL AND e.expires_at < ?)                  AS holds`,
    // Positional `?` throughout, matching every other raw query here — D1
    // binds by position, and one statement that binds by name is one
    // somebody copies wrong.
    [eventId, eventId, eventId, eventId, isoDaysAhead(now, 14)],
  );
  const sponsorships = num(sponsorRows[0]?.sponsorships);
  const granted = num(sponsorRows[0]?.granted);
  const consumed = num(sponsorRows[0]?.consumed);
  const holdsExpiring = num(sponsorRows[0]?.holds);

  // The activation checklist is a dozen reads of the event's configuration —
  // days, rooms, formats, tracks, sessions — and Today does not draw it.
  const check = full ? await activationCheck(app, eventId) : { ready: true, blockers: [] as string[] };

  /* deadlines --------------------------------------------------------------- */

  const deadlines: DashboardDeadline[] = [];
  for (const c of cfpRows) {
    const closes = strOrNull(c.closes_at);
    if (closes && closes > now) {
      deadlines.push({ label: `${str(c.name)} closes`, at: closes, kind: "cfp", href: `/admin/cfps/${str(c.id)}` });
    }
  }
  for (const r of roundRows) {
    const closes = strOrNull(r.closes_at);
    if (closes && closes > now) {
      deadlines.push({ label: `${str(r.name)} review closes`, at: closes, kind: "review", href: `${base}/review` });
    }
  }
  const nextConfirmation = await app.db.raw<{ at: string }>(
    `SELECT MIN(confirmation_deadline) AS at FROM proposal
      WHERE event_id = ? AND deleted_at IS NULL AND status = 'accepted' AND confirmation_deadline > ?`,
    [eventId, now],
  );
  if (nextConfirmation[0] && nextConfirmation[0].at) {
    deadlines.push({
      label: "First confirmation deadline",
      at: str(nextConfirmation[0].at),
      kind: "confirmation",
      href: `${base}/sessions`,
    });
  }
  // `starts_on` is a calendar date in the event's zone and is never converted
  // (11, "Time"), so it joins the list as UTC midnight rather than being
  // shifted into one.
  deadlines.push({ label: "Event starts", at: `${str(event.starts_on)}T00:00:00Z`, kind: "event", href: `${base}/schedule` });
  deadlines.sort((a, b) => a.at.localeCompare(b.at));

  return {
    event: {
      id: eventId,
      name: str(event.name),
      slug: str(event.slug),
      status: str(event.status),
      timezone: str(event.timezone, "UTC"),
      starts_on: str(event.starts_on),
      ends_on: str(event.ends_on),
    },
    funnel,
    submissions_by_day: byDay.map((r) => ({ date: str(r.date), count: num(r.n) })),
    cfps,
    review: {
      rounds,
      reviewers_behind: behindRows.map((r) => ({
        person_id: str(r.person_id),
        name: str(r.name),
        outstanding: num(r.outstanding),
        overdue: num(r.overdue),
      })),
    },
    decisions: {
      provisional,
      accepted,
      waitlisted,
      rejected,
      changes_requested: changesRequested,
      withdrawn,
      awaiting_confirmation: awaitingConfirmation,
      confirmation_overdue: confirmationOverdue,
    },
    onboarding: {
      open: openTasks,
      blocking_open: blockingOpen,
      overdue: overdueTasks,
      awaiting_review: awaitingReview,
      by_status: taskByStatus.map((r) => ({ status: str(r.status), count: num(r.n) })),
    },
    schedule: {
      sessions,
      placed,
      unplaced: Math.max(0, confirmed - placed),
      conflict_errors: conflictErrors,
      conflict_warnings: conflictWarnings,
      pending_publication_changes: pending.count,
    },
    sponsorship: {
      sponsorships,
      entitlements_granted: granted,
      entitlements_consumed: consumed,
      holds_expiring: holdsExpiring,
    },
    readiness: { ready: check.ready, blockers: check.blockers },
    deadlines,
  };
}

function isoDaysAgo(now: string, days: number): string {
  return new Date(new Date(now).getTime() - days * 86400000).toISOString();
}

function isoDaysAhead(now: string, days: number): string {
  return new Date(new Date(now).getTime() + days * 86400000).toISOString();
}
