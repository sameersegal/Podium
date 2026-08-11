/**
 * The seam between Scheduling and Program.
 *
 * Publication readiness is Program's rule (INV-06-5 blocking onboarding tasks,
 * INV-06-11 editorial approval, INV-06-8 internal sessions). Scheduling asks
 * the question; it does not answer it, and it does not reach into another
 * context's tables to guess.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { num, str, type Row } from "@podiumconf/data/db.js";
import {
  publicationReadinessOf,
  type ContentStatus,
  type PublicationReadiness,
  type SessionStatus,
  type SessionVisibility,
} from "@podiumconf/domain/program/types.js";
import { notFound } from "@podiumconf/domain/shared/errors.js";

/** `blocking_tasks_outstanding` is derived (INV-11-6): counted, never stored. */
export async function blockingTasksOutstanding(app: AppContext, sessionId: string): Promise<number> {
  const rows = await app.db.raw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_instance
      WHERE session_id = ? AND is_blocking = 1
        AND status NOT IN ('completed','waived','cancelled')`,
    [sessionId],
  );
  return num(rows[0]?.n);
}

/** The same count for every session of an event, in one query. */
export async function blockingTasksByEvent(app: AppContext, eventId: string): Promise<Map<string, number>> {
  const rows = await app.db.raw<{ session_id: string; n: number }>(
    `SELECT session_id, COUNT(*) AS n FROM task_instance
      WHERE event_id = ? AND is_blocking = 1 AND session_id IS NOT NULL
        AND status NOT IN ('completed','waived','cancelled')
      GROUP BY session_id`,
    [eventId],
  );
  return new Map(rows.map((r) => [str(r.session_id), num(r.n)]));
}

export function readinessOfRow(session: Row, blocking: number): PublicationReadiness {
  return publicationReadinessOf({
    status: str(session.status) as SessionStatus,
    visibility: str(session.visibility, "public") as SessionVisibility,
    content_status: str(session.content_status, "draft") as ContentStatus,
    blocking_tasks_outstanding: blocking,
    publication_override_reason: session.publication_override_reason ? str(session.publication_override_reason) : null,
  });
}

/** Per-session readiness, for the one-session-in-question case. */
export async function readinessOf(app: AppContext, sessionId: string): Promise<PublicationReadiness> {
  const session = await app.db.byId<Row>("session", sessionId);
  if (!session) throw notFound("Session", sessionId);
  return readinessOfRow(session, await blockingTasksOutstanding(app, sessionId));
}

/** Readiness for every session of an event, for the bulk publish path. */
export async function readinessByEvent(app: AppContext, eventId: string): Promise<Map<string, PublicationReadiness>> {
  const [sessions, blocking] = await Promise.all([
    app.db.select<Row>("session", { event_id: eventId }),
    blockingTasksByEvent(app, eventId),
  ]);
  return new Map(sessions.map((s) => [str(s.id), readinessOfRow(s, blocking.get(str(s.id)) ?? 0)]));
}
