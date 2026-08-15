/**
 * Recovery for the gap `publishEvents` (packages/data/src/context.ts) leaves
 * on purpose: a queue-send failure there logs and moves on rather than losing
 * the fact, because the event log row is already committed by the time it can
 * fail. Something has to re-publish what never made it to a consumer — this
 * is that something, run as the `platform.replay_unprocessed_events` cron job
 * (contexts/platform/cron.ts) and, on demand, from `POST /dev/drain`.
 *
 * The obvious query — "no `event_reaction_log` row at all" — misses the case
 * this exists for. `platform.webhook_fanout` subscribes to `*` and is
 * imported last into `REACTIONS` (reactions.ts), so it runs after every other
 * reaction for the same event. An event whose
 * `program.create_session_from_decision` handler failed but whose fan-out
 * succeeded already has one log row and would be excluded forever by that
 * query — exactly the partial failure recovery is for. Correctness means
 * comparing against the *set* of handlers the event actually subscribes to
 * (`reactionsFor`), not against "any log row exists".
 */

import { D1Db, num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import type { Env } from "@podiumstack/data/context.js";
import type { DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent, reactionsFor } from "./dispatch.js";

/**
 * Exported so callers that already hold a `domain_event_record` row (the
 * `/admin/event-log` read model, and `tests/integration/helpers/events.ts`'s
 * cascade walker) can hydrate it into the same `DomainEvent` shape this file
 * re-delivers, instead of a fourth copy of this mapping alongside this one
 * and `platform/delivery.ts`'s `loadDomainEvent`.
 */
export function rowToEvent(row: Row): DomainEvent {
  return {
    id: str(row.id),
    type: str(row.type) as DomainEvent["type"],
    version: num(row.version, 1),
    occurred_at: str(row.occurred_at),
    org_id: str(row.org_id),
    event_id: strOrNull(row.event_id),
    actor: {
      type: str(row.actor_type) as DomainEvent["actor"]["type"],
      id: strOrNull(row.actor_id),
      display_name: strOrNull(row.actor_display),
    },
    subject: { type: str(row.subject_type), id: str(row.subject_id) },
    data: JSON.parse(str(row.data, "{}")),
    correlation_id: strOrNull(row.correlation_id),
    causation_id: strOrNull(row.causation_id),
  };
}

export interface ReplayOptions {
  /** Defaults to "now"; a fixed value makes the sweep deterministic in tests. */
  now?: string;
  /**
   * Only consider events at least this old. An event published moments ago
   * may simply be mid-delivery on its first attempt — replaying it
   * concurrently would not be incorrect (every reaction is idempotent on
   * `(event_id, handler)`) but it is wasted work on the overwhelmingly common
   * case where the first attempt was going to succeed anyway.
   */
  graceMinutes?: number;
  /**
   * Bound the scan to events at most this old. A fully-processed event stays
   * in the append-only log forever (10-domain-events.md), so an unbounded
   * `WHERE occurred_at <= <grace cutoff>` matches essentially every event
   * this deployment has ever recorded, on every single tick — a full scan
   * the "single digits of D1 queries" budget was never meant to survive at
   * real event volume. Left undefined, the scan is unbounded; only the
   * manual `/dev/drain` trigger asks for that, where an operator has decided
   * to pay the cost once to be sure nothing is missed.
   */
  lookbackHours?: number;
  /** Cloudflare-side cost control, matching the previous `/dev/drain` limit. */
  limit?: number;
}

export interface ReplayResult {
  scanned: number;
  replayed: number;
}

export async function replayUnprocessedEvents(env: Env, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const now = opts.now ?? new Date().toISOString();
  const graceMinutes = opts.graceMinutes ?? 5;
  const limit = opts.limit ?? 200;
  const graceCutoff = new Date(new Date(now).getTime() - graceMinutes * 60_000).toISOString();

  // Unscoped by org on purpose: this is an operational sweep over the whole
  // deployment's event log, the same posture the other cron sweeps take when
  // they iterate every Organization (e.g. onboarding/cron.ts's `orgIds`).
  const db = new D1Db(env.DB);

  const params: unknown[] = [graceCutoff];
  let lookbackClause = "";
  if (opts.lookbackHours != null) {
    lookbackClause = " AND occurred_at >= ?";
    params.push(new Date(new Date(now).getTime() - opts.lookbackHours * 3_600_000).toISOString());
  }
  const rows = await db.raw<Row>(
    `SELECT * FROM domain_event_record WHERE occurred_at <= ?${lookbackClause} ORDER BY occurred_at LIMIT ?`,
    [...params, limit],
  );
  if (rows.length === 0) return { scanned: 0, replayed: 0 };

  // One grouped query for the whole batch's log rows, rather than one query
  // per candidate event — the set of handlers that actually ran per event,
  // keyed by event id, so completeness can be checked in memory below.
  const ids = rows.map((r) => str(r.id));
  const placeholders = ids.map(() => "?").join(",");
  const logRows = await db.raw<{ event_id: string; handler: string }>(
    `SELECT event_id, handler FROM event_reaction_log WHERE event_id IN (${placeholders})`,
    ids,
  );
  const done = new Map<string, Set<string>>();
  for (const r of logRows) {
    const set = done.get(r.event_id) ?? new Set<string>();
    set.add(r.handler);
    done.set(r.event_id, set);
  }

  let replayed = 0;
  for (const row of rows) {
    const ev = rowToEvent(row);
    const expected = reactionsFor(ev.type);
    if (expected.length === 0) continue; // nothing subscribes; no log row would ever appear
    const ran = done.get(ev.id) ?? new Set<string>();
    const missing = expected.some((r) => !ran.has(r.name));
    if (!missing) continue;

    console.warn("replaying event with an incomplete reaction map", {
      event_id: ev.id,
      type: ev.type,
      expected: expected.length,
      done: ran.size,
    });
    // deliverEvent re-checks event_reaction_log per handler and only runs
    // what is actually missing — safe even though this query already
    // established that at least one handler is outstanding.
    await deliverEvent(env, ev);
    replayed++;
  }
  return { scanned: rows.length, replayed };
}
