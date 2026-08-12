/**
 * `podium-dlq` — the dead-letter queue for both `podium-events` and
 * `podium-delivery` (wrangler.jsonc). A message that reaches it has already
 * exhausted `max_retries` on its home queue: `deliverEvent` or `runDelivery`
 * kept failing, and the queue has given up retrying it. That makes this the
 * last chance to know the reaction was abandoned at all — the repo's own
 * guidance is "log DLQ arrivals loudly" (.claude/agents/implementer.md).
 *
 * Cloudflare does not tell a DLQ consumer which queue a message came from:
 * `MessageBatch.queue` is `"podium-dlq"` for the whole batch, not per message.
 * The body shape is therefore the only signal, and it is discriminated
 * carefully rather than guessed — an unrecognised shape is recorded as
 * `"unknown"`, never thrown on, because a DLQ handler that throws sends the
 * message right back into a retry loop with no further queue to catch it.
 */

import { D1Db } from "@podiumstack/data/db.js";
import type { Env } from "@podiumstack/data/context.js";
import type { DomainEvent } from "@podiumstack/domain/events/envelope.js";
import type { DeliveryMessage } from "./delivery.js";

const DELIVERY_KINDS = new Set(["webhook", "notification", "campaign"]);

function isDomainEvent(body: unknown): body is DomainEvent {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.type === "string" &&
    typeof b.occurred_at === "string" &&
    !!b.subject &&
    typeof b.subject === "object"
  );
}

function isDeliveryMessage(body: unknown): body is DeliveryMessage {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.kind === "string" && DELIVERY_KINDS.has(b.kind);
}

/**
 * Record one dead-letter arrival and log it loudly. Never throws — the
 * `dead_letter` insert is the point, not a guarantee, and a caller that
 * cannot write it should still be able to `ack()` the message rather than
 * requeue a message this handler cannot make progress on either way.
 */
export async function recordDeadLetter(env: Env, body: unknown, arrivedAt: string): Promise<void> {
  let sourceQueue = "unknown";
  let messageKind = "unknown";
  let eventId: string | null = null;
  let eventType: string | null = null;
  let orgId: string | null = null;

  if (isDomainEvent(body)) {
    sourceQueue = "podium-events";
    messageKind = "domain_event";
    eventId = body.id;
    eventType = body.type;
    orgId = body.org_id ?? null;
  } else if (isDeliveryMessage(body)) {
    sourceQueue = "podium-delivery";
    messageKind = "delivery";
    orgId = "org_id" in body ? (body as { org_id?: string }).org_id ?? null : null;
    if (body.kind === "webhook") eventId = body.event_id;
  }

  console.error("dead letter arrived", {
    source_queue: sourceQueue,
    message_kind: messageKind,
    event_id: eventId,
    event_type: eventType,
    org_id: orgId,
  });

  try {
    const db = new D1Db(env.DB, "");
    await db.rawRun(
      `INSERT INTO dead_letter (source_queue, message_kind, event_id, event_type, org_id, body, arrived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sourceQueue, messageKind, eventId, eventType, orgId, JSON.stringify(body ?? null), arrivedAt],
    );
  } catch (err) {
    // Logging above already happened, so the arrival is not silent even if
    // the write itself fails (e.g. D1 is down, which is plausibly why the
    // original message ended up here in the first place).
    console.error("failed to record dead letter", { error: String(err) });
  }
}
