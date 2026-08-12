/**
 * The delivery queue consumer bodies — 09, "Delivery contract" and
 * "Notifications". Retries live in the queue schedule (1m, 5m, 30m, 2h, 6h,
 * 24h, then `exhausted`), never a hand-rolled loop in the request path.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { WEBHOOK_FAILURE_LIMIT, backoffSecondsFor } from "@podiumstack/domain/platform/types.js";
import { checkWebhookUrl, signPayload } from "@podiumstack/domain/platform/webhooks.js";
import { excerpt, webhookBody } from "@podiumstack/domain/platform/payload.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";
import { attemptSend, queueNotification } from "./notifications.js";
import { runCampaignSend } from "./campaigns.js";

function contextFor(env: Env, orgId: string, eventId?: string | null): AppContext {
  return new AppContext({ env, orgId, eventId: eventId ?? null, actor: SYSTEM_ACTOR });
}

function loadDomainEvent(row: Row): DomainEvent {
  return {
    id: str(row.id),
    type: str(row.type) as DomainEvent["type"],
    version: num(row.version, 1),
    occurred_at: str(row.occurred_at),
    org_id: str(row.org_id),
    event_id: strOrNull(row.event_id),
    actor: { type: str(row.actor_type) as DomainEvent["actor"]["type"], id: strOrNull(row.actor_id), display_name: strOrNull(row.actor_display) },
    subject: { type: str(row.subject_type), id: str(row.subject_id) },
    data: JSON.parse(str(row.data, "{}")),
    correlation_id: strOrNull(row.correlation_id),
    causation_id: strOrNull(row.causation_id),
  };
}

/* -------------------------------------------------------------------------- */
/* webhook                                                                     */
/* -------------------------------------------------------------------------- */

export async function deliverWebhook(env: Env, msg: Extract<DeliveryMessage, { kind: "webhook" }>): Promise<void> {
  const app = contextFor(env, msg.org_id);
  const delivery = await app.db.byId<Row>("webhook_delivery", msg.delivery_id, { includeDeleted: true });
  // Idempotent: a delivery no longer `pending` has already been resolved by an
  // earlier attempt at processing this same at-least-once message.
  if (!delivery || str(delivery.status) !== "pending") return;

  const webhook = await app.db.byId<Row>("webhook", str(delivery.webhook_id));
  if (!webhook || str(webhook.status) !== "active") {
    await app.db.rawRun("UPDATE webhook_delivery SET status = 'skipped' WHERE id = ?", [msg.delivery_id]);
    return;
  }

  const eventRows = await app.db.raw<Row>("SELECT * FROM domain_event_record WHERE id = ?", [str(delivery.domain_event_id)]);
  if (!eventRows[0]) {
    await app.db.rawRun("UPDATE webhook_delivery SET status = 'skipped' WHERE id = ?", [msg.delivery_id]);
    return;
  }
  const domainEvent = loadDomainEvent(eventRows[0]);

  const attempt = num(delivery.attempt, 1);
  const started = Date.now();

  const urlCheck = checkWebhookUrl(str(webhook.url)); // INV-09-2, re-checked at delivery time (SSRF)
  if (!urlCheck.ok) {
    await finishFailure(app, str(webhook.id), msg.delivery_id, attempt, str(domainEvent.id), { response_status: null, error: urlCheck.reason ?? "URL refused", duration_ms: Date.now() - started });
    return;
  }

  const body = webhookBody(domainEvent, { includePii: !!webhook.include_pii });
  const signature = await signPayload([str(webhook.secret), strOrNull(webhook.previous_secret)], body, started);

  let responseStatus: number | null = null;
  let responseExcerpt = "";
  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetch(str(webhook.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-id": domainEvent.id, // INV-09-8: consumers are told delivery is at-least-once.
        "x-signature": signature,
      },
      body,
    });
    responseStatus = res.status;
    responseExcerpt = excerpt(await res.text().catch(() => ""));
    ok = res.status >= 200 && res.status < 300;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const duration_ms = Date.now() - started;

  if (ok) {
    await app.db.rawRun(
      "UPDATE webhook_delivery SET status = 'delivered', response_status = ?, response_body_excerpt = ?, delivered_at = ?, duration_ms = ? WHERE id = ?",
      [responseStatus, responseExcerpt, app.now(), duration_ms, msg.delivery_id],
    );
    if (num(webhook.consecutive_failures) > 0) await app.db.update("webhook", str(webhook.id), { consecutive_failures: 0 });
    console.log(JSON.stringify({ level: "info", event: "webhook.delivered", webhook_id: webhook.id, delivery_id: msg.delivery_id, domain_event_id: domainEvent.id, attempt, duration_ms }));
    return;
  }

  await finishFailure(app, str(webhook.id), msg.delivery_id, attempt, domainEvent.id, {
    response_status: responseStatus,
    response_body_excerpt: responseExcerpt,
    error,
    duration_ms,
  });
}

async function finishFailure(
  app: AppContext,
  webhookId: string,
  deliveryId: string,
  attempt: number,
  domainEventId: string,
  outcome: { response_status: number | null; response_body_excerpt?: string; error: string | null; duration_ms: number },
): Promise<void> {
  const nextDelaySeconds = backoffSecondsFor(attempt);
  const exhausted = nextDelaySeconds === null;
  await app.db.rawRun(
    "UPDATE webhook_delivery SET status = ?, response_status = ?, response_body_excerpt = ?, error = ?, duration_ms = ? WHERE id = ?",
    [exhausted ? "exhausted" : "failed", outcome.response_status, outcome.response_body_excerpt ?? null, outcome.error, outcome.duration_ms, deliveryId],
  );

  const webhook = await app.db.byId<Row>("webhook", webhookId);
  const consecutiveFailures = num(webhook?.consecutive_failures, 0) + 1;
  await app.db.update("webhook", webhookId, { consecutive_failures: consecutiveFailures });

  app.events.emit({
    type: "webhook.delivery_failed",
    subject: { type: "webhook", id: webhookId },
    data: { webhook_id: webhookId, delivery_id: deliveryId, attempt, response_status: outcome.response_status, error: outcome.error },
  });
  console.warn(JSON.stringify({ level: "warn", event: "webhook.delivery_failed", webhook_id: webhookId, delivery_id: deliveryId, attempt, error: outcome.error }));

  // 09: "Twenty consecutive failures pauses the webhook and notifies the org
  // owner rather than retrying into the void."
  if (consecutiveFailures >= WEBHOOK_FAILURE_LIMIT) {
    await app.db.update("webhook", webhookId, { status: "disabled_after_failures" });
    app.events.emit({
      type: "webhook.disabled",
      subject: { type: "webhook", id: webhookId },
      data: { webhook_id: webhookId, consecutive_failures: consecutiveFailures },
    });
    await notifyOwnersOfDisabledWebhook(app, webhookId);
  } else if (!exhausted && nextDelaySeconds !== null) {
    // The next attempt is created here and picked up by the retry sweep
    // (`PLATFORM_CRON`) once `scheduled_for` is due — Queue delays do not
    // reliably cover the 24h step of the backoff schedule.
    await app.db.insertMany("webhook_delivery", [
      {
        id: newId("WebhookDelivery"),
        webhook_id: webhookId,
        domain_event_id: domainEventId,
        attempt: attempt + 1,
        status: "pending",
        scheduled_for: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
      },
    ]);
  }
  await app.flush();
}

async function notifyOwnersOfDisabledWebhook(app: AppContext, webhookId: string): Promise<void> {
  const webhook = await app.db.byId<Row>("webhook", webhookId);
  const owners = await app.db.raw<{ person_id: string }>(
    "SELECT person_id FROM role_grant WHERE org_id = ? AND role = 'owner' AND revoked_at IS NULL",
    [app.orgId],
  );
  for (const o of owners) {
    await queueNotification(app, {
      template_key: "webhook.disabled",
      recipient_person_id: o.person_id,
      subject_type: "webhook",
      subject_id: webhookId,
      variables: { "webhook.name": webhook ? str(webhook.name) : webhookId, "webhook.url": webhook ? str(webhook.url) : "" },
      transactional: true,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* notification                                                                */
/* -------------------------------------------------------------------------- */

export async function deliverNotification(env: Env, msg: Extract<DeliveryMessage, { kind: "notification" }>): Promise<void> {
  const app = contextFor(env, msg.org_id);
  const notification = await app.db.byId<Row>("notification_delivery", msg.notification_id, { includeDeleted: true });
  app.eventId = notification ? strOrNull(notification.event_id) : null;
  try {
    const outcome = await attemptSend(app, msg.notification_id);
    console.log(JSON.stringify({ level: "info", event: "notification.attempt", notification_id: msg.notification_id, outcome: outcome.status, reason: outcome.suppressed_reason ?? null }));
  } finally {
    await app.flush();
  }
}

/* -------------------------------------------------------------------------- */
/* campaign                                                                     */
/* -------------------------------------------------------------------------- */

export async function sendCampaign(env: Env, msg: Extract<DeliveryMessage, { kind: "campaign" }>): Promise<void> {
  const app = contextFor(env, msg.org_id);
  try {
    const result = await runCampaignSend(app, msg.campaign_id);
    console.log(JSON.stringify({ level: "info", event: "campaign.send", campaign_id: msg.campaign_id, ...result }));
  } finally {
    await app.flush();
  }
}
