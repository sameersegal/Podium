/**
 * The delivery queue: outbound webhook attempts and notification sends.
 *
 * Retries live in the queue (09: 1m, 5m, 30m, 2h, 6h, 24h then `exhausted`),
 * not in a hand-rolled loop in the request path.
 */

import type { Env } from "@podiumconf/data/context.js";

export type DeliveryMessage =
  | { kind: "webhook"; delivery_id: string; webhook_id: string; org_id: string; event_id: string }
  | { kind: "notification"; notification_id: string; org_id: string }
  | { kind: "campaign"; campaign_id: string; org_id: string };

import { deliverWebhook, deliverNotification, sendCampaign } from "../contexts/platform/delivery.js";

export async function runDelivery(env: Env, msg: DeliveryMessage): Promise<void> {
  switch (msg.kind) {
    case "webhook":
      return deliverWebhook(env, msg);
    case "notification":
      return deliverNotification(env, msg);
    case "campaign":
      return sendCampaign(env, msg);
  }
}
