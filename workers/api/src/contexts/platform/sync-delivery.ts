/**
 * The delivery-queue half of the two-way sync — 09.
 *
 * The reaction marks links dirty and enqueues *one* message per mapping; the
 * provider calls happen here. That split is the same one webhooks already use,
 * and it exists for the same reason: a `decision.published` sweep over four
 * hundred proposals is four hundred events, and four hundred provider calls
 * fired from a reaction would earn a rate-limit lockout instead of a sync.
 *
 * Enqueuing is **debounced per mapping**. A message already in flight for a
 * mapping does the work of every event that arrives while it waits, because it
 * drains whatever is `pending_push` when it runs rather than a list captured
 * when it was scheduled.
 */

import type { AppContext, Env } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import type { SyncRunTrigger } from "@podiumstack/domain/platform/sync.js";

import type { DeliveryMessage } from "../../consumers/delivery.js";
import { erasePersonEverywhere, getMapping, runPull, runPush, syncContext } from "./sync.js";

/**
 * How long a push waits for more events before it runs.
 *
 * Long enough that a decision batch coalesces into one sweep, short enough that
 * an organizer editing one session sees it appear in the grid while they are
 * still looking at the tab.
 */
export const PUSH_DEBOUNCE_SECONDS = 20;

/** Enqueue a debounced push for one mapping, ignoring a queue that is unavailable. */
export async function schedulePush(env: Env, mappingId: string, trigger: SyncRunTrigger): Promise<void> {
  const message: DeliveryMessage = { kind: "sync_push", mapping_id: mappingId, trigger };
  try {
    await env.DELIVERY_QUEUE.send(message, { delaySeconds: PUSH_DEBOUNCE_SECONDS });
  } catch (err) {
    // The link is already `pending_push` in the database, so a queue outage
    // costs latency, not the change: `platform.sweep_sync` picks it up.
    console.warn("sync push enqueue failed", { mapping_id: mappingId, error: String(err) });
  }
}

export async function schedulePull(env: Env, mappingId: string, trigger: SyncRunTrigger): Promise<void> {
  const message: DeliveryMessage = { kind: "sync_pull", mapping_id: mappingId, trigger };
  try {
    await env.DELIVERY_QUEUE.send(message);
  } catch (err) {
    console.warn("sync pull enqueue failed", { mapping_id: mappingId, error: String(err) });
  }
}

export async function scheduleErase(env: Env, personId: string): Promise<void> {
  const message: DeliveryMessage = { kind: "sync_erase", person_id: personId };
  try {
    await env.DELIVERY_QUEUE.send(message);
  } catch (err) {
    // Worth shouting about: this one is INV-09-22, and a lost message means
    // personal data stays in a system this one does not control.
    console.error("sync erase enqueue failed", { person_id: personId, error: String(err) });
    throw err;
  }
}

export async function deliverSyncPush(env: Env, msg: Extract<DeliveryMessage, { kind: "sync_push" }>): Promise<void> {
  const app = await syncContext(env, null);
  const mapping = await loadActiveMapping(app, msg.mapping_id);
  if (!mapping) return;
  app.eventId = str(mapping.event_id) || null;
  await runPush(app, mapping, msg.trigger);
  await app.flush();
}

export async function deliverSyncPull(env: Env, msg: Extract<DeliveryMessage, { kind: "sync_pull" }>): Promise<void> {
  // Built with the `system` actor first, only to read the mapping; the run
  // itself gets a context attributed to the integration (INV-09-20).
  const reader = await syncContext(env, null);
  const mapping = await loadActiveMapping(reader, msg.mapping_id);
  if (!mapping) return;

  const integration = await reader.db.byId<Row>("integration", str(mapping.integration_id));
  const app = await syncContext(env, str(mapping.event_id) || null, { integration });
  await runPull(app, mapping, msg.trigger);
  await app.flush();

  // A pull that accepted anything left those links `pending_push`, so Podium's
  // stored value — not the spreadsheet's proposal — goes back out.
  const dirty = await app.db.count("external_record_link", { mapping_id: str(mapping.id), status: "pending_push" });
  if (dirty > 0) await schedulePush(env, str(mapping.id), "event");
}

export async function deliverSyncErase(env: Env, msg: Extract<DeliveryMessage, { kind: "sync_erase" }>): Promise<void> {
  const app = await syncContext(env, null);
  const result = await erasePersonEverywhere(app, msg.person_id);
  await app.flush();
  if (result.failed > 0) {
    // Thrown so the queue retries: INV-09-22 is not satisfied by an attempt.
    throw new Error(`Erasure could not remove ${result.failed} external record(s) for ${msg.person_id}.`);
  }
}

async function loadActiveMapping(app: AppContext, mappingId: string): Promise<Row | null> {
  let mapping: Row;
  try {
    mapping = await getMapping(app, mappingId);
  } catch {
    // Deleted between enqueue and delivery. Nothing to do, and nothing wrong.
    return null;
  }
  return Number(mapping.is_active) === 1 ? mapping : null;
}
