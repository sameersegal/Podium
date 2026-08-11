/**
 * Queue consumers — the reaction map in 10-domain-events.md.
 *
 * "Every reaction must be idempotent on `DomainEvent.id` — the same event may
 * be delivered twice, and 'create session' running twice is exactly the bug
 * this rule exists to prevent."
 *
 * That is enforced here, once, rather than in each handler: a reaction runs
 * only if `(event_id, handler)` is not already in `event_reaction_log`.
 */

import type { Env } from "@podiumconf/data/context.js";
import { D1Db } from "@podiumconf/data/db.js";
import type { DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { eventTypeMatches } from "@podiumconf/domain/events/catalogue.js";
import { nowIso } from "@podiumconf/domain/shared/time.js";
import { REACTIONS, type Reaction } from "./reactions.js";
import { runDelivery, type DeliveryMessage } from "./delivery.js";
import { recordDeadLetter } from "./dead-letter.js";

export function reactionsFor(type: string): Reaction[] {
  return REACTIONS.filter((r) => r.types.some((p) => eventTypeMatches(p, type)));
}

/**
 * Run one event through every matching reaction. Exported so integration tests
 * can drive the reaction map without a queue round-trip.
 */
export async function deliverEvent(env: Env, ev: DomainEvent): Promise<string[]> {
  const started = Date.now();
  const db = new D1Db(env.DB, ev.org_id);
  const ran: string[] = [];
  const failures: { handler: string; error: unknown }[] = [];

  for (const reaction of reactionsFor(ev.type)) {
    const already = await db.raw<{ event_id: string }>(
      "SELECT event_id FROM event_reaction_log WHERE event_id = ? AND handler = ?",
      [ev.id, reaction.name],
    );
    if (already.length > 0) continue;

    try {
      await reaction.handle(ev, env);
    } catch (error) {
      // Reactions are independent. One handler failing must not stop the
      // others from running: `decision.published` creating a session and
      // `decision.published` emailing the speaker are different facts for
      // different consumers, and a bad session should not cost somebody their
      // acceptance email. The failure is collected and rethrown below so the
      // queue retries — and because the log below is per `(event, handler)`,
      // the retry re-runs only what actually failed.
      console.error("reaction failed", { handler: reaction.name, event_id: ev.id, type: ev.type, error: String(error) });
      failures.push({ handler: reaction.name, error });
      continue;
    }

    // Written after the handler: a crash mid-handler retries the whole thing,
    // which is safe precisely because handlers are written to be re-runnable.
    await db.rawRun(
      "INSERT OR IGNORE INTO event_reaction_log (event_id, handler, processed_at) VALUES (?, ?, ?)",
      [ev.id, reaction.name, nowIso()],
    );
    ran.push(reaction.name);
  }

  if (failures.length > 0) {
    const names = failures.map((f) => f.handler).join(", ");
    throw new Error(`${failures.length} reaction(s) failed for ${ev.type} (${names}): ${String(failures[0].error)}`, {
      cause: failures[0].error,
    });
  }

  // The success path used to be silent — only `reaction failed` and the
  // caller's `queue handler failed` existed, so a healthy delivery left no
  // trace to reconstruct a cascade from except the rows themselves. One line
  // per delivered event, including a no-op redelivery (`handler_count: 0`):
  // per (H), "silent idempotency is indistinguishable from a lost event",
  // and it is the event and correlation ids that let one request's cascade
  // be pulled back out of the logs — never the payload (`data`), which may
  // carry PII (catalogue.ts, `PII_EVENT_TYPES`).
  console.log(
    JSON.stringify({
      level: "info",
      event: "domain_event.delivered",
      event_id: ev.id,
      type: ev.type,
      org_id: ev.org_id,
      correlation_id: ev.correlation_id ?? null,
      handler_count: ran.length,
      duration_ms: Date.now() - started,
    }),
  );
  return ran;
}

export async function runQueueBatch(batch: MessageBatch<unknown>, env: Env, execCtx: ExecutionContext): Promise<void> {
  for (const message of batch.messages) {
    // `podium-dlq` is the dead-letter queue for both queues below (wrangler.jsonc)
    // — a message here has already exhausted `max_retries` on its home queue.
    // There is nowhere further to retry it to, so it is always acknowledged:
    // the point is to record it loudly (dead-letter.ts), not to keep looping.
    if (batch.queue === "podium-dlq") {
      await recordDeadLetter(env, message.body, nowIso());
      message.ack();
      continue;
    }
    try {
      if (batch.queue === "podium-delivery") {
        await runDelivery(env, message.body as DeliveryMessage);
      } else {
        await deliverEvent(env, message.body as DomainEvent);
      }
      message.ack();
    } catch (err) {
      console.error("queue handler failed", { queue: batch.queue, error: String(err) });
      message.retry();
    }
  }
}
