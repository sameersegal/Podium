/**
 * The transitive drain helper — the missing primitive `tests/integration/`
 * has never had. `deliverEvent` (`consumers/dispatch.ts`) delivers exactly
 * one hop: it runs every reaction subscribed to one event and stops. Every
 * event test before this one hand-built a single envelope and called
 * `deliverEvent` once, so no test has ever walked a cascade past its first
 * hop — not `decision.published` all the way to a materialised onboarding
 * task, not `task_instance.completed` all the way to a republished schedule.
 *
 * `drain` closes that gap by delivering breadth-first until nothing new is
 * produced. It does not re-implement dispatch: each reaction still raises
 * its events on its own `AppContext` and calls `app.flush()`, which persists
 * them to `domain_event_record` and publishes to the queue
 * (`packages/data/src/context.ts`). Every reaction context in every
 * context's `reactions.ts` passes `causationId: ev.id` for exactly this
 * reason (10-domain-events.md, "Envelope"), so the practical way to find
 * "what did delivering this event just cause" is to look up
 * `domain_event_record` rows by `causation_id`, not to intercept the emit
 * call.
 */

import { D1Db, type Row } from "@podiumstack/data/db.js";
import type { Env } from "@podiumstack/data/context.js";
import type { DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";
import { rowToEvent } from "@podiumstack/web/consumers/replay.js";

/** One event delivered during a drain, and what ran for it. */
export interface DrainStep {
  event: DomainEvent;
  /** Reaction names `deliverEvent` actually ran on this delivery (already-logged handlers are excluded, same as `deliverEvent`'s own return value). */
  handlers: string[];
}

export interface DrainResult {
  /** Every event delivered, in delivery (breadth-first) order — the seeds first, then each generation of children. */
  events: DomainEvent[];
  /** One entry per delivered event. */
  steps: DrainStep[];
  /** Every reaction name that ran anywhere in the cascade, for a quick "did X run at all" check. */
  ranHandlers: Set<string>;
}

const DEFAULT_MAX_DEPTH = 25;

/**
 * Deliver `seed` and everything it transitively causes, stopping once no
 * delivery produces a new, not-yet-delivered event.
 *
 * Guarded by `maxDepth` (generations of the breadth-first walk, not event
 * count) rather than left unbounded: a reaction that re-emits the event that
 * triggered it — a modelling bug this helper exists to catch, not paper
 * over — would otherwise hang the test instead of failing it.
 *
 * A reaction failure is not swallowed. `deliverEvent` throws an aggregate
 * error when any handler for a hop fails (`consumers/dispatch.ts`), and
 * `drain` lets that propagate rather than silently walking a cascade it
 * knows is incomplete — a cascade test asserting downstream state on a
 * half-run chain would be worse than no test.
 */
export async function drain(env: Env, seed: DomainEvent[], opts: { maxDepth?: number } = {}): Promise<DrainResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const db = new D1Db(env.DB);

  const seen = new Set<string>();
  const events: DomainEvent[] = [];
  const steps: DrainStep[] = [];
  const ranHandlers = new Set<string>();

  let frontier = [...seed];
  let depth = 0;
  while (frontier.length > 0) {
    if (depth++ >= maxDepth) {
      throw new Error(
        `drain: exceeded max depth (${maxDepth}) delivering ${JSON.stringify(frontier.map((e) => e.type))} — ` +
          "either a genuinely deep cascade (raise maxDepth) or a reaction cycle re-emitting an event its own delivery caused.",
      );
    }

    const next: DomainEvent[] = [];
    for (const ev of frontier) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      events.push(ev);

      const handlers = await deliverEvent(env, ev);
      for (const h of handlers) ranHandlers.add(h);
      steps.push({ event: ev, handlers });

      const childRows = await db.raw<Row>("SELECT * FROM domain_event_record WHERE causation_id = ? ORDER BY id", [ev.id]);
      for (const row of childRows) {
        const child = rowToEvent(row);
        if (!seen.has(child.id)) next.push(child);
      }
    }
    frontier = next;
  }

  return { events, steps, ranHandlers };
}

/** Convenience: every step whose event type matches, in delivery order. */
export function stepsOfType(result: DrainResult, type: string): DrainStep[] {
  return result.steps.filter((s) => s.event.type === type);
}

/** Convenience: did `handler` run anywhere in the cascade, for any event? */
export function handlerRan(result: DrainResult, handler: string): boolean {
  return result.ranHandlers.has(handler);
}
