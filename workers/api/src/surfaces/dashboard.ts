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

/**
 * `GROUP BY` rather than one query per value.
 *
 * Eight `COUNT(*) WHERE status = …` over the same table is eight round trips to
 * count one table, and the version that asks per call or per round is worse
 * still: it grows with the event. This turns a grouped result into the lookup
 * the caller wanted, defaulting to zero for a group with no rows — which the
 * per-value queries returned for free and a `GROUP BY` silently omits.
 */
async function tally(app: AppContext, sql: string, params: unknown[]): Promise<Record<string, number>> {
  const rows = await app.db.raw<{ k: string; n: number }>(sql, params);
  const out: Record<string, number> = {};
  for (const row of rows) out[str(row.k)] = num(row.n);
  return out;
}

const at = (counts: Record<string, number>, key: string): number => counts[key] ?? 0;

export async function eventDashboard(app: AppContext, eventId: string, now: string): Promise<EventDashboard> {
  const event = await app.db.byId<Row>("event", eventId);
  if (!event) throw new Error("no such event");
  const base = `/admin/events/${eventId}`;

  /**
   * Everything below reads; nothing depends on anything else here except
   * through `event`, which is already in hand. So it all goes out at once, and
   * each group inside is a `GROUP BY` rather than a query per value — this read
   * was thirty-odd sequential round trips, several of them per call and per
   * round, which is a shape that gets slower as the event gets bigger.
   */
  const [
    proposalsByStatus,
    sessionsByStatus,
    placed,
    byDay,
    calls,
    review,
    decisionCounts,
    onboardingCounts,
    taskByStatus,
    conflictsBySeverity,
    pending,
    sponsorshipCounts,
    check,
    nextConfirmation,
  ] = await Promise.all([
    tally(
      app,
      "SELECT status AS k, COUNT(*) AS n FROM proposal WHERE event_id = ? AND deleted_at IS NULL GROUP BY status",
      [eventId],
    ),
    tally(
      app,
      "SELECT status AS k, COUNT(*) AS n FROM session WHERE event_id = ? AND deleted_at IS NULL GROUP BY status",
      [eventId],
    ),
    one(
      app,
      `SELECT COUNT(DISTINCT p.session_id) AS n FROM placement p
         JOIN session s ON s.id = p.session_id
        WHERE p.event_id = ? AND s.deleted_at IS NULL AND s.status != 'cancelled'`,
      [eventId],
    ),
    /** Thirty days of submission volume — the only reliable read on whether a call is landing. */
    app.db.raw<{ date: string; n: number }>(
      `SELECT substr(submitted_at, 1, 10) AS date, COUNT(*) AS n
         FROM proposal
        WHERE event_id = ? AND deleted_at IS NULL AND submitted_at IS NOT NULL AND submitted_at >= ?
        GROUP BY date ORDER BY date`,
      [eventId, isoDaysAgo(now, 30)],
    ),
    callsWithSubmissions(app, eventId, event),
    reviewProgress(app, eventId, now),
    decisionsPending(app, eventId, now),
    tally(
      app,
      `SELECT k, COUNT(*) AS n FROM (
         SELECT 'open' AS k FROM task_instance WHERE event_id = ?1 AND status IN ${OPEN_TASK_STATES}
         UNION ALL
         SELECT 'blocking' FROM task_instance WHERE event_id = ?1 AND is_blocking = 1 AND status IN ${OPEN_TASK_STATES}
         UNION ALL
         SELECT 'overdue' FROM task_instance WHERE event_id = ?1 AND due_at IS NOT NULL AND due_at < ?2 AND status IN ${OPEN_TASK_STATES}
         UNION ALL
         SELECT 'awaiting_review' FROM task_instance WHERE event_id = ?1 AND status = 'submitted' AND requires_review = 1
       ) GROUP BY k`,
      [eventId, now],
    ),
    app.db.raw<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM task_instance WHERE event_id = ? GROUP BY status",
      [eventId],
    ),
    tally(
      app,
      `SELECT severity AS k, COUNT(*) AS n FROM schedule_conflict
        WHERE event_id = ? AND acknowledged_reason IS NULL GROUP BY severity`,
      [eventId],
    ),
    pendingChanges(app, eventId),
    sponsorshipTotals(app, eventId, now),
    activationCheck(app, eventId),
    app.db.raw<{ at: string }>(
      `SELECT MIN(confirmation_deadline) AS at FROM proposal
        WHERE event_id = ? AND deleted_at IS NULL AND status = 'accepted' AND confirmation_deadline > ?`,
      [eventId, now],
    ),
  ]);

  const accepted = at(proposalsByStatus, "accepted");
  const waitlisted = at(proposalsByStatus, "waitlisted");
  const rejected = at(proposalsByStatus, "rejected");
  const changesRequested = at(proposalsByStatus, "changes_requested");
  const withdrawn = at(proposalsByStatus, "withdrawn");
  // "Sessions" is everything not cancelled; "confirmed" is the four states that
  // mean a session is really happening. Both fall out of one grouped count.
  const sessions = Object.entries(sessionsByStatus).reduce((total, [status, n]) => (status === "cancelled" ? total : total + n), 0);
  const confirmed = ["confirmed", "scheduled", "published", "delivered"].reduce((total, s) => total + at(sessionsByStatus, s), 0);

  /**
   * The funnel is the shape of the round: how many came in, how many are being
   * looked at, how many were decided, how many turned into a session, how many
   * of those have a room and a time. Each step links to the screen that moves
   * proposals out of it.
   */
  const funnel = [
    { key: "draft", label: "Drafts", count: at(proposalsByStatus, "draft"), href: `${base}/proposals?status=draft` },
    { key: "submitted", label: "Awaiting review", count: at(proposalsByStatus, "submitted"), href: `${base}/proposals?status=submitted` },
    { key: "in_review", label: "In review", count: at(proposalsByStatus, "in_review"), href: `${base}/review` },
    { key: "accepted", label: "Accepted", count: accepted, href: `${base}/decisions` },
    { key: "confirmed", label: "Confirmed sessions", count: confirmed, href: `${base}/sessions` },
    { key: "placed", label: "On the schedule", count: placed, href: `${base}/schedule` },
  ];

  /* deadlines --------------------------------------------------------------- */

  const deadlines: DashboardDeadline[] = [];
  for (const c of calls.rows) {
    const closes = strOrNull(c.closes_at);
    if (closes && closes > now) {
      deadlines.push({ label: `${str(c.name)} closes`, at: closes, kind: "cfp", href: `/admin/cfps/${str(c.id)}` });
    }
  }
  for (const r of review.rows) {
    const closes = strOrNull(r.closes_at);
    if (closes && closes > now) {
      deadlines.push({ label: `${str(r.name)} review closes`, at: closes, kind: "review", href: `${base}/review` });
    }
  }
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
    cfps: calls.cfps,
    review: { rounds: review.rounds, reviewers_behind: review.behind },
    decisions: {
      provisional: at(decisionCounts, "provisional"),
      accepted,
      waitlisted,
      rejected,
      changes_requested: changesRequested,
      withdrawn,
      awaiting_confirmation: at(decisionCounts, "awaiting_confirmation"),
      confirmation_overdue: at(decisionCounts, "confirmation_overdue"),
    },
    onboarding: {
      open: at(onboardingCounts, "open"),
      blocking_open: at(onboardingCounts, "blocking"),
      overdue: at(onboardingCounts, "overdue"),
      awaiting_review: at(onboardingCounts, "awaiting_review"),
      by_status: taskByStatus.map((r) => ({ status: str(r.status), count: num(r.n) })),
    },
    schedule: {
      sessions,
      placed,
      unplaced: Math.max(0, confirmed - placed),
      conflict_errors: at(conflictsBySeverity, "error"),
      conflict_warnings: at(conflictsBySeverity, "warning"),
      pending_publication_changes: pending.count,
    },
    sponsorship: {
      sponsorships: at(sponsorshipCounts, "sponsorships"),
      entitlements_granted: at(sponsorshipCounts, "granted"),
      entitlements_consumed: at(sponsorshipCounts, "consumed"),
      holds_expiring: at(sponsorshipCounts, "holds_expiring"),
    },
    readiness: { ready: check.ready, blockers: check.blockers },
    deadlines,
  };
}

/**
 * The calls, with how many proposals each has taken.
 *
 * One grouped count for every call rather than one count per call: an event
 * with a call per track paid a round trip per track for a number that is one
 * `GROUP BY` away. `derivedCfpStatus` is given the event it already has, so it
 * stays the pure computation it is rather than fetching one per call too.
 */
async function callsWithSubmissions(app: AppContext, eventId: string, event: Row) {
  const rows = await app.db.select<Row>("call_for_proposals", { event_id: eventId }, { orderBy: "closes_at" });
  const submissions = await tally(
    app,
    `SELECT cfp_id AS k, COUNT(*) AS n FROM proposal
      WHERE event_id = ? AND deleted_at IS NULL AND status != 'draft' GROUP BY cfp_id`,
    [eventId],
  );
  const cfps = await Promise.all(
    rows.map(async (c) => ({
      id: str(c.id),
      name: str(c.name),
      status: await derivedCfpStatus(app, c, event),
      closes_at: str(c.closes_at),
      submissions: at(submissions, str(c.id)),
    })),
  );
  return { rows, cfps };
}

/**
 * Every round's progress, and who is holding one up.
 *
 * The per-round counts are two grouped queries across the event's rounds rather
 * than four per round. `below_quorum` has to stay its own query because the
 * target it compares against is per round: the inner group counts submitted
 * reviews per proposal, and the outer one keeps the proposals short of the
 * round that owns them (INV-05-11) — the number a chair is looking for, because
 * a proposal below quorum is one the committee cannot decide yet.
 */
async function reviewProgress(app: AppContext, eventId: string, now: string) {
  const rows = await app.db.select<Row>("review_round", { event_id: eventId }, { orderBy: "sequence" });
  if (rows.length === 0) return { rows, rounds: [], behind: [] };

  const [byRoundStatus, belowQuorum, behindRows] = await Promise.all([
    app.db.raw<{ round_id: string; status: string; n: number }>(
      `SELECT a.round_id, a.status, COUNT(*) AS n FROM review_assignment a
         JOIN review_round r ON r.id = a.round_id
        WHERE r.event_id = ? GROUP BY a.round_id, a.status`,
      [eventId],
    ),
    tally(
      app,
      `SELECT round_id AS k, COUNT(*) AS n FROM (
         SELECT a.round_id AS round_id, a.proposal_id
           FROM review_assignment a
           JOIN review_round r ON r.id = a.round_id
          WHERE r.event_id = ?
          GROUP BY a.round_id, a.proposal_id
         HAVING SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END)
              < MAX(COALESCE(NULLIF(r.target_reviews_per_proposal, 0), 1))
       ) GROUP BY round_id`,
      [eventId],
    ),
    /**
     * Who is holding the round up. Named rather than counted, because "eleven
     * reviews outstanding" is not actionable and "Priya has eleven, four
     * overdue" is a message someone can send.
     */
    app.db.raw<{ person_id: string; name: string; outstanding: number; overdue: number }>(
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
    ),
  ]);

  const perRound = new Map<string, { total: number; submitted: number; declined: number }>();
  for (const r of byRoundStatus) {
    const key = str(r.round_id);
    const entry = perRound.get(key) ?? { total: 0, submitted: 0, declined: 0 };
    const n = num(r.n);
    entry.total += n;
    if (str(r.status) === "submitted") entry.submitted += n;
    if (str(r.status) === "declined") entry.declined += n;
    perRound.set(key, entry);
  }

  const rounds = rows.map((r) => {
    const roundId = str(r.id);
    const counts = perRound.get(roundId) ?? { total: 0, submitted: 0, declined: 0 };
    return {
      id: roundId,
      name: str(r.name),
      status: str(r.status),
      target: num(r.target_reviews_per_proposal, 1) || 1,
      assignments: counts.total,
      submitted: counts.submitted,
      declined: counts.declined,
      below_quorum: at(belowQuorum, roundId),
    };
  });

  return {
    rows,
    rounds,
    behind: behindRows.map((r) => ({
      person_id: str(r.person_id),
      name: str(r.name),
      outstanding: num(r.outstanding),
      overdue: num(r.overdue),
    })),
  };
}

/**
 * The three decision numbers that mean someone has to do something. They span
 * three tables, so this is a union of three counts rather than a `GROUP BY`,
 * but it is still one round trip instead of three.
 */
function decisionsPending(app: AppContext, eventId: string, now: string): Promise<Record<string, number>> {
  return tally(
    app,
    // R5 — a decision is provisional until it is explicitly published, and the
    // gap between the two is the "saved a dropdown, emailed 400 rejections"
    // failure this number exists to make visible.
    `SELECT k, COUNT(*) AS n FROM (
       SELECT 'provisional' AS k FROM decision d JOIN proposal p ON p.id = d.proposal_id
        WHERE p.event_id = ?1 AND d.status = 'provisional'
       UNION ALL
       SELECT 'awaiting_confirmation' FROM session
        WHERE event_id = ?1 AND deleted_at IS NULL AND status = 'pending_confirmation'
       UNION ALL
       SELECT 'confirmation_overdue' FROM proposal
        WHERE event_id = ?1 AND deleted_at IS NULL AND status = 'accepted'
          AND confirmation_deadline IS NOT NULL AND confirmation_deadline < ?2
          AND session_id IN (SELECT id FROM session WHERE status = 'pending_confirmation')
     ) GROUP BY k`,
    [eventId, now],
  );
}

/**
 * Sponsorship totals. `granted` sums a quantity rather than counting rows, so
 * this is a union of sums; `consumed` is derived (R8) — counted from the
 * proposals that hold the entitlement, never from a stored counter, because a
 * sponsor losing a slot they paid for is what drift costs here.
 */
async function sponsorshipTotals(app: AppContext, eventId: string, now: string): Promise<Record<string, number>> {
  const rows = await app.db.raw<{ k: string; n: number }>(
    `SELECT k, SUM(n) AS n FROM (
       SELECT 'sponsorships' AS k, COUNT(*) AS n FROM sponsorship WHERE event_id = ?1 AND status != 'cancelled'
       UNION ALL
       SELECT 'granted', COALESCE(SUM(e.quantity), 0) FROM entitlement e
         JOIN sponsorship sp ON sp.id = e.sponsorship_id
        WHERE sp.event_id = ?1 AND sp.status != 'cancelled'
          AND e.entitlement_type IN ('session_slot','workshop_slot','lightning_slot','keynote_slot')
       UNION ALL
       SELECT 'consumed', COUNT(*) FROM proposal p
         JOIN entitlement e ON e.id = p.entitlement_id
         JOIN sponsorship sp ON sp.id = e.sponsorship_id
        WHERE sp.event_id = ?1 AND p.deleted_at IS NULL AND p.status NOT IN ('withdrawn','rejected','expired')
       UNION ALL
       SELECT 'holds_expiring', COUNT(*) FROM entitlement e
         JOIN sponsorship sp ON sp.id = e.sponsorship_id
        WHERE sp.event_id = ?1 AND e.expires_at IS NOT NULL AND e.expires_at < ?2
     ) GROUP BY k`,
    [eventId, isoDaysAhead(now, 14)],
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[str(row.k)] = num(row.n);
  return out;
}

function isoDaysAgo(now: string, days: number): string {
  return new Date(new Date(now).getTime() - days * 86400000).toISOString();
}

function isoDaysAhead(now: string, days: number): string {
  return new Date(new Date(now).getTime() + days * 86400000).toISOString();
}
