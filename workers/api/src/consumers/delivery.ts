/**
 * The delivery queue: outbound webhook attempts and notification sends.
 *
 * Retries live in the queue (09: 1m, 5m, 30m, 2h, 6h, 24h then `exhausted`),
 * not in a hand-rolled loop in the request path.
 */

import type { Env } from "@podiumstack/data/context.js";

export type DeliveryMessage =
  | { kind: "webhook"; delivery_id: string; webhook_id: string; org_id: string; event_id: string }
  | { kind: "notification"; notification_id: string; org_id: string }
  | { kind: "campaign"; campaign_id: string; org_id: string }
  // Two-way sync (09). The reaction only marks links dirty; the provider call
  // happens here, so batching, rate limits and retries stay in the queue.
  | { kind: "sync_push"; mapping_id: string; org_id: string; trigger: SyncRunTrigger }
  | { kind: "sync_pull"; mapping_id: string; org_id: string; trigger: SyncRunTrigger }
  | { kind: "sync_erase"; person_id: string; org_id: string };

import type { SyncRunTrigger } from "@podiumstack/domain/platform/sync.js";
import { deliverWebhook, deliverNotification, sendCampaign } from "../contexts/platform/delivery.js";
import { deliverSyncErase, deliverSyncPull, deliverSyncPush } from "../contexts/platform/sync-delivery.js";

export async function runDelivery(env: Env, msg: DeliveryMessage): Promise<void> {
  switch (msg.kind) {
    case "webhook":
      return deliverWebhook(env, msg);
    case "notification":
      return deliverNotification(env, msg);
    case "campaign":
      return sendCampaign(env, msg);
    case "sync_push":
      return deliverSyncPush(env, msg);
    case "sync_pull":
      return deliverSyncPull(env, msg);
    case "sync_erase":
      return deliverSyncErase(env, msg);
  }
}
