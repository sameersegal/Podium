/**
 * Notifications — 09, "Notifications". Templates and delivery are core;
 * transport is a plugin (`resolvePlugin` in service.ts).
 *
 * `queueNotification` is the single entry point every other context calls:
 * every intended message writes a `NotificationDelivery` row with its rendered
 * body **before** any provider call (INV-09-12), and a message that cannot be
 * dispatched — no provider, provider error, suppression — is recorded with its
 * reason and stays readable in the outbox.
 */

import type { AppContext, Env } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { hmacSha256Hex } from "@podiumconf/domain/identity/credentials.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { invariantError, notFound } from "@podiumconf/domain/shared/errors.js";
import { markdown } from "../../ui/html.js";
import {
  categoryOf,
  decideSuppression,
  type SuppressionEntry,
} from "@podiumconf/domain/platform/suppression.js";
import { assertTemplateBody, renderTemplate, toPlainText, flattenVariables } from "@podiumconf/domain/platform/rendering.js";
import { DEFAULT_TEMPLATES, declaredVariables, isTransactionalTemplate, templateSpec } from "@podiumconf/domain/platform/templates.js";
import { DELIVERY_STATUS_RANK, NOTIFICATION_CHANNELS, quietHoursDecision, type NotificationChannel } from "@podiumconf/domain/platform/types.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";
import { hasActiveEmailIntegration, resolvePlugin } from "./service.js";
import { DomainError } from "@podiumconf/domain/shared/errors.js";

/* -------------------------------------------------------------------------- */
/* Template resolution                                                        */
/* -------------------------------------------------------------------------- */

export interface ResolvedTemplate {
  channel: NotificationChannel;
  subject: string;
  body_markdown: string;
  version: number;
  transactional: boolean;
}

/** Event templates override org ones (09, `NotificationTemplate`). */
export async function resolveTemplate(app: AppContext, key: string, locale = "en"): Promise<ResolvedTemplate | null> {
  const eventRow = app.eventId
    ? await app.db.first<Row>("notification_template", { event_id: app.eventId, key, locale, is_active: 1 })
    : null;
  const orgRow = eventRow ? null : await app.db.first<Row>("notification_template", { event_id: null, key, locale, is_active: 1 });
  const row = eventRow ?? orgRow;
  if (row) {
    return {
      channel: str(row.channel) as NotificationChannel,
      subject: str(row.subject),
      body_markdown: str(row.body_markdown),
      version: num(row.version, 1),
      transactional: isTransactionalTemplate(key),
    };
  }
  const spec = templateSpec(key);
  if (!spec) return null;
  return { channel: spec.channel, subject: spec.subject, body_markdown: spec.body_markdown, version: 1, transactional: spec.transactional };
}

/* -------------------------------------------------------------------------- */
/* Variables                                                                   */
/* -------------------------------------------------------------------------- */

export async function baseVariables(app: AppContext, recipient: Row): Promise<Record<string, unknown>> {
  const event = app.eventId ? await app.db.byId<Row>("event", app.eventId) : null;
  const org = await app.db.byId<Row>("organization", app.orgId);
  const baseUrl = app.env.PUBLIC_BASE_URL || "http://localhost:8787";
  const firstName = (str(recipient.display_name) || str(recipient.full_name)).split(/\s+/)[0] || "there";
  return {
    "event.name": event ? str(event.name) : "",
    "event.slug": event ? str(event.slug) : "",
    "event.starts_on": event ? str(event.starts_on) : "",
    "event.ends_on": event ? str(event.ends_on) : "",
    "event.timezone": event ? str(event.timezone) : "UTC",
    "event.url": event ? `${baseUrl}/e/${str(event.slug)}` : baseUrl,
    "org.name": org ? str(org.name) : "",
    "recipient.name": str(recipient.display_name) || str(recipient.full_name),
    "recipient.first_name": firstName,
    "recipient.email": str(recipient.email),
    portal_url: `${baseUrl}/portal`,
    unsubscribe_url: await unsubscribeUrl(app.env, str(recipient.email), "campaign"),
  };
}

/**
 * The HMAC key for every signed, no-login URL this platform mints (INV-09-15) —
 * the unsubscribe link, and the inbound provider-callback URL below.
 *
 * The two sign different message shapes (`${email}.${category}` versus
 * `inbound-webhook:${integration_id}`), which is what stops a signature minted
 * for one being replayed against the other. The unsubscribe shape is
 * deliberately left un-prefixed: every unsubscribe link already sitting in
 * someone's inbox was signed with it, and prefixing it now would silently
 * invalidate all of them.
 *
 * Previously this was
 * `env.ENVIRONMENT` itself — in production the literal, publicly-known string
 * "production" — which let anyone forge an unsubscribe link for any address in
 * any org. It is not routed through `resolveSecret`'s `Integration.secret_ref`
 * indirection (`./service.js`): that exists so an admin can *choose* which
 * Workers Secret an installed `Integration` points at, and there is no
 * `Integration` row here to point from — this key protects a core platform
 * mechanism, not a plugin credential. So it is typed directly on `Env`
 * (`UNSUBSCRIBE_SECRET`) and set with `wrangler secret put`.
 *
 * Fails closed in production: `ENVIRONMENT === "production"` with no secret
 * configured throws rather than silently signing with a guessable value —
 * that silent fallback was the defect. Outside production (dev, test) a
 * fixed, clearly-insecure default keeps `npm run dev` and the test suite
 * working with no setup, per the project's rule that local dev needs none.
 */
function platformSigningKey(env: Env): string {
  if (env.UNSUBSCRIBE_SECRET) return env.UNSUBSCRIBE_SECRET;
  if (env.ENVIRONMENT === "production") {
    throw invariantError(
      "INV-09-15",
      "unsubscribe_secret_missing",
      "UNSUBSCRIBE_SECRET is not configured for this deployment. Set it with " +
        "`wrangler secret put UNSUBSCRIBE_SECRET -c wrangler.production.jsonc` before any " +
        "unsubscribe link can be generated or verified.",
      undefined,
      500,
    );
  }
  return "podium-dev-unsubscribe-secret-insecure-do-not-use-in-production";
}

/** Signed, no-login link — 09: the exemption is for the message, not the click. */
export async function unsubscribeUrl(env: Env, email: string, category: string): Promise<string> {
  const baseUrl = env.PUBLIC_BASE_URL || "http://localhost:8787";
  const sig = await hmacSha256Hex(platformSigningKey(env), `${email}.${category}`);
  const url = new URL(`${baseUrl}/unsubscribe`);
  url.searchParams.set("email", email);
  url.searchParams.set("category", category);
  url.searchParams.set("sig", sig);
  return url.toString();
}

export async function verifyUnsubscribeSignature(env: Env, email: string, category: string, sig: string): Promise<boolean> {
  const expected = await hmacSha256Hex(platformSigningKey(env), `${email}.${category}`);
  return expected === sig;
}

/**
 * The URL an email provider posts delivery events back to, for one installed
 * `Integration` — 09, `email`: `handle_inbound_webhook(payload)`.
 *
 * A provider callback carries no session and no API key: the sender is
 * SendGrid, not a person. So the URL *is* the credential, HMAC-signed exactly
 * like the unsubscribe link (INV-09-15) and scoped to a single integration id.
 * That is weaker than verifying a provider's own request signature, and
 * deliberately so: every provider signs differently (SendGrid ECDSA over
 * timestamp+body, Resend via Svix), while `handle_inbound_webhook(payload)`
 * takes a parsed payload and no headers. One signed URL is a check the core
 * can make for every provider without the contract growing a
 * provider-shaped hole. An operator who leaks the URL should rotate it by
 * reinstalling the integration, which mints a new id.
 */
export async function inboundWebhookUrl(env: Env, integrationId: string): Promise<string> {
  const baseUrl = env.PUBLIC_BASE_URL || "http://localhost:8787";
  const sig = await hmacSha256Hex(platformSigningKey(env), `inbound-webhook:${integrationId}`);
  return `${baseUrl}/integrations/${integrationId}/inbound?sig=${sig}`;
}

export async function verifyInboundWebhookSignature(env: Env, integrationId: string, sig: string): Promise<boolean> {
  const expected = await hmacSha256Hex(platformSigningKey(env), `inbound-webhook:${integrationId}`);
  return expected === sig;
}

/* -------------------------------------------------------------------------- */
/* The single entry point                                                      */
/* -------------------------------------------------------------------------- */

export interface QueueNotificationInput {
  template_key: string;
  recipient_person_id: string;
  subject_type: string;
  subject_id: string;
  variables?: Record<string, unknown>;
  /** Overrides `isTransactionalTemplate(template_key)` when a caller knows better. */
  transactional?: boolean;
  channel?: NotificationChannel;
  campaign_id?: string | null;
}

/**
 * The single entry point every other context calls to send a system-triggered
 * message. Writes the `NotificationDelivery` row (INV-09-12) and enqueues the
 * delivery attempt; suppression and provider resolution happen there, not here,
 * so the write is never blocked on either.
 */
export async function queueNotification(app: AppContext, input: QueueNotificationInput): Promise<string | null> {
  const recipient = await app.db.byId<Row>("person", input.recipient_person_id);
  if (!recipient || !recipient.email) return null;

  const template = await resolveTemplate(app, input.template_key);
  const vars = flattenVariables({ ...(await baseVariables(app, recipient)), ...(input.variables ?? {}) });
  const subjectText = template ? renderTemplate(template.subject, vars).text : input.template_key;
  const bodyText = template ? renderTemplate(template.body_markdown, vars).text : "";
  const channel = input.channel ?? template?.channel ?? "email";
  const transactional = input.transactional ?? template?.transactional ?? isTransactionalTemplate(input.template_key);

  return writeNotification(app, {
    template_key: input.template_key,
    template_version: template?.version ?? null,
    recipient_person_id: recipient.id as string,
    recipient_email: str(recipient.email),
    channel,
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    subject: subjectText,
    rendered_body: bodyText,
    transactional,
    campaign_id: input.campaign_id ?? null,
  });
}

export interface WriteNotificationInput {
  template_key?: string | null;
  template_version?: number | null;
  recipient_person_id: string;
  recipient_email: string;
  channel: NotificationChannel;
  subject_type: string;
  subject_id: string;
  subject: string;
  rendered_body: string;
  transactional: boolean;
  campaign_id?: string | null;
}

/**
 * Low-level write: the `NotificationDelivery` row exists — readable in the
 * outbox — before anything is attempted (INV-09-12).
 */
export async function writeNotification(app: AppContext, input: WriteNotificationInput): Promise<string> {
  const id = newId("NotificationDelivery");
  await app.db.insert("notification_delivery", {
    id,
    org_id: app.orgId,
    event_id: app.eventId,
    campaign_id: input.campaign_id ?? null,
    template_key: input.template_key ?? null,
    template_version: input.template_version ?? null,
    recipient_person_id: input.recipient_person_id,
    recipient_email: input.recipient_email,
    channel: input.channel,
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    subject: input.subject,
    rendered_body: input.rendered_body,
    status: "queued",
    created_at: app.now(),
  });
  const message: DeliveryMessage = { kind: "notification", notification_id: id, org_id: app.orgId };
  try {
    await app.env.DELIVERY_QUEUE.send(message);
  } catch (err) {
    console.warn("notification enqueue failed", { notification_id: id, error: String(err) });
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* Delivery attempt — shared by the delivery consumer and campaign sending    */
/* -------------------------------------------------------------------------- */

async function suppressionEntriesFor(app: AppContext, email: string): Promise<SuppressionEntry[]> {
  const rows = await app.db.raw<Row>("SELECT * FROM notification_suppression WHERE org_id = ? AND email = ?", [app.orgId, email.toLowerCase()]);
  return rows.map((r) => ({ email: str(r.email), category: str(r.category), reason: str(r.reason) }));
}

export async function recordSuppression(app: AppContext, email: string, category: string, reason: string): Promise<void> {
  await app.db.rawRun(
    "INSERT INTO notification_suppression (org_id, email, category, reason, created_at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT (org_id, email, category) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at",
    [app.orgId, email.trim().toLowerCase(), category, reason, app.now()],
  );
}

export async function removeSuppression(app: AppContext, email: string, category: string): Promise<void> {
  await app.db.rawRun("DELETE FROM notification_suppression WHERE org_id = ? AND email = ? AND category = ?", [
    app.orgId,
    email.trim().toLowerCase(),
    category,
  ]);
}

export interface SendOutcome {
  status: string;
  suppressed_reason?: string | null;
}

/**
 * Attempt to dispatch one `NotificationDelivery`. Idempotent: a row that has
 * already left `queued` (sent, suppressed, failed, ...) is a no-op, so
 * redelivery of the same `DeliveryMessage` has effect once.
 */
export async function attemptSend(app: AppContext, notificationId: string): Promise<SendOutcome> {
  const row = await app.db.byId<Row>("notification_delivery", notificationId, { includeDeleted: true });
  if (!row) throw notFound("NotificationDelivery", notificationId);
  if (str(row.status) !== "queued") return { status: str(row.status), suppressed_reason: strOrNull(row.suppressed_reason) };
  // Once already flagged no_provider it stays queued+no_provider until an
  // integration appears and someone redelivers it; a bare "queued" with no
  // reason yet is what falls through below.
  if (str(row.suppressed_reason) === "no_provider") return { status: "queued", suppressed_reason: "no_provider" };

  const templateKey = strOrNull(row.template_key);
  const category = categoryOf(templateKey);
  const transactional = templateKey ? isTransactionalTemplate(templateKey) : false;

  const entries = await suppressionEntriesFor(app, str(row.recipient_email));
  const decision = decideSuppression(entries, { email: str(row.recipient_email), category, transactional });
  if (decision.suppressed) {
    await app.db.update("notification_delivery", notificationId, { status: "suppressed", suppressed_reason: decision.reason });
    return { status: "suppressed", suppressed_reason: decision.reason };
  }

  const channel = str(row.channel) as NotificationChannel;
  if (channel === "email") {
    // Quiet hours defer the send rather than dropping it (09, `email` contract:
    // "quiet hours ... are core concerns"). Computed in the recipient's
    // timezone where known, falling back to the event's (11, "Time").
    const recipient = await app.db.byId<Row>("person", str(row.recipient_person_id));
    const event = app.eventId ? await app.db.byId<Row>("event", app.eventId) : null;
    const timezone = strOrNull(recipient?.timezone) || (event ? str(event.timezone) : null);
    if (timezone) {
      const q = quietHoursDecision(app.now(), timezone);
      if (q.defer) {
        try {
          await app.env.DELIVERY_QUEUE.send(
            { kind: "notification", notification_id: notificationId, org_id: app.orgId } satisfies DeliveryMessage,
            { delaySeconds: Math.min(q.delay_seconds, 43200) },
          );
        } catch (err) {
          console.warn("quiet-hours redelay failed", { notification_id: notificationId, error: String(err) });
        }
        // Record it, or the outbox shows a bare `queued` with no reason — the
        // one state that reads as "we lost it" when the truth is "it goes out
        // at breakfast". Cleared below when the send actually proceeds.
        await app.db.update("notification_delivery", notificationId, { suppressed_reason: "quiet_hours" });
        return { status: "queued", suppressed_reason: "quiet_hours" };
      }
      // Past the quiet window: the deferral no longer explains anything.
      if (str(row.suppressed_reason) === "quiet_hours") {
        await app.db.update("notification_delivery", notificationId, { suppressed_reason: null });
      }
    }
  }

  if (channel === "email") {
    const activeEmail = await hasActiveEmailIntegration(app, app.eventId);
    if (!activeEmail) {
      // INV-09-12: no provider configured — recorded and left readable, never dropped.
      await app.db.update("notification_delivery", notificationId, { suppressed_reason: "no_provider" });
      return { status: "queued", suppressed_reason: "no_provider" };
    }
  }

  const resolved = await resolvePlugin(app, channel === "chat" ? "chat" : "email", app.eventId);
  if (!resolved) {
    await app.db.update("notification_delivery", notificationId, { suppressed_reason: "no_provider" });
    return { status: "queued", suppressed_reason: "no_provider" };
  }

  const bodyMarkdown = str(row.rendered_body);
  let sendResult: { ok: boolean; providerMessageId: string | null; error?: string | null };
  if (channel === "chat" && resolved.plugin.capability === "chat") {
    const res = await resolved.plugin.post("", { text: bodyMarkdown }, resolved.ctx);
    sendResult = { ok: res.ok, providerMessageId: res.id ?? null, error: res.error ?? null };
  } else if (resolved.plugin.capability === "email") {
    const html = markdown(bodyMarkdown).toString();
    const res = await resolved.plugin.send(
      {
        to: [{ email: str(row.recipient_email) }],
        subject: str(row.subject) || "(no subject)",
        html: `<div>${html}</div>`,
        text: toPlainText(bodyMarkdown),
        tags: templateKey ? [templateKey] : undefined,
        idempotency_key: `notification:${notificationId}`,
      },
      resolved.ctx,
    );
    sendResult = { ok: res.status !== "failed", providerMessageId: res.provider_message_id, error: res.error };
  } else {
    sendResult = { ok: false, providerMessageId: null, error: "No matching provider for this channel." };
  }

  if (sendResult.ok) {
    await app.db.update("notification_delivery", notificationId, {
      status: "sent",
      integration_id: resolved.integration?.id ?? null,
      provider_message_id: sendResult.providerMessageId,
      sent_at: app.now(),
    });
    app.events.emit({
      type: "notification.sent",
      subject: { type: "notification", id: notificationId },
      data: {
        notification_id: notificationId,
        template_key: templateKey,
        recipient_person_id: str(row.recipient_person_id),
        channel,
        campaign_id: strOrNull(row.campaign_id),
      },
    });
    return { status: "sent" };
  }

  await app.db.update("notification_delivery", notificationId, { status: "failed", error: sendResult.error ?? "Send failed." });
  return { status: "failed" };
}

/* -------------------------------------------------------------------------- */
/* Inbound provider webhooks — bounces and complaints                         */
/* -------------------------------------------------------------------------- */

/** A hard bounce or complaint joins the global suppression list (09, "Suppression"). */
export async function applyDeliveryStatusUpdates(
  app: AppContext,
  updates: { provider_message_id: string | null; recipient_email: string; status: string; bounce_type?: string | null; error?: string | null }[],
): Promise<void> {
  for (const u of updates) {
    const row = u.provider_message_id
      ? await app.db.first<Row>("notification_delivery", { provider_message_id: u.provider_message_id })
      : null;
    if (row) {
      const current = str(row.status);
      // INV-09-16: provider callbacks are at-least-once and unordered —
      // SendGrid resends an event it did not get a 2xx for, and a `delivered`
      // can arrive after a `bounce` on the same message. So the status only
      // ever moves forward, and a repeat of an event already recorded is a
      // no-op rather than a second `notification.bounced`.
      const advances = (DELIVERY_STATUS_RANK[u.status] ?? 0) > (DELIVERY_STATUS_RANK[current] ?? 0);
      if (advances) {
        const patch: Row = { status: u.status };
        if (u.status === "delivered") patch.delivered_at = app.now();
        if (u.status === "bounced" || u.status === "failed") patch.error = u.error ?? null;
        await app.db.update("notification_delivery", str(row.id), patch);
        if (u.status === "bounced" || u.status === "complained") {
          app.events.emit({
            type: "notification.bounced",
            subject: { type: "notification", id: str(row.id) },
            data: { notification_id: str(row.id), recipient_email: u.recipient_email, bounce_type: u.bounce_type ?? null },
          });
        }
      }
    }
    // Suppression stays unconditional: it is an upsert, and a repeat is the
    // only chance to record one that was missed when the row already moved.
    // Only a hard bounce and a complaint reach the global list.
    if (u.status === "bounced" && u.bounce_type === "hard") {
      await recordSuppression(app, u.recipient_email, "all", "hard_bounce");
    } else if (u.status === "complained") {
      await recordSuppression(app, u.recipient_email, "all", "complaint");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* NotificationTemplate — admin CRUD                                          */
/* -------------------------------------------------------------------------- */

export interface TemplateInput {
  key: string;
  channel?: NotificationChannel;
  subject?: string | null;
  body_markdown: string;
  locale?: string;
  event_id?: string | null;
  is_active?: boolean;
}

export function knownTemplateKeys(): string[] {
  return DEFAULT_TEMPLATES.map((t) => t.key);
}

export async function createTemplate(app: AppContext, input: TemplateInput): Promise<Row> {
  assertTemplateBody(input.key, input.subject ?? null, input.body_markdown); // INV-09-13
  const locale = input.locale ?? "en";
  const existing = await app.db.first<Row>("notification_template", { event_id: input.event_id ?? null, key: input.key, locale });
  if (existing) throw new DomainError({ code: "template_exists", message: `A ${locale} template for "${input.key}" already exists at this scope.`, status: 409 });
  const spec = templateSpec(input.key);
  const id = newId("NotificationTemplate");
  const row: Row = {
    id,
    org_id: app.orgId,
    event_id: input.event_id ?? null,
    key: input.key,
    channel: input.channel ?? spec?.channel ?? "email",
    subject: input.subject ?? null,
    body_markdown: input.body_markdown,
    locale,
    is_active: input.is_active === false ? 0 : 1,
    version: 1,
    created_at: app.now(),
    updated_at: app.now(),
    row_version: 1,
  };
  await app.db.insert("notification_template", row);
  app.audit.record({ action: "notification_template.create", entity_type: "notification_template", entity_id: id, after: { key: input.key } });
  return row;
}

export async function updateTemplate(app: AppContext, id: string, input: Partial<TemplateInput>): Promise<void> {
  const template = await app.db.byId<Row>("notification_template", id);
  if (!template) throw notFound("Notification template", id);
  const subject = input.subject !== undefined ? input.subject : strOrNull(template.subject);
  const body = input.body_markdown !== undefined ? input.body_markdown : str(template.body_markdown);
  assertTemplateBody(str(template.key), subject, body); // INV-09-13
  const update: Row = { updated_at: app.now(), version: num(template.version, 1) + 1 };
  if (input.subject !== undefined) update.subject = input.subject;
  if (input.body_markdown !== undefined) update.body_markdown = input.body_markdown;
  if (input.channel !== undefined) update.channel = input.channel;
  if (input.is_active !== undefined) update.is_active = input.is_active ? 1 : 0;
  await app.db.update("notification_template", id, update);
  app.audit.record({ action: "notification_template.update", entity_type: "notification_template", entity_id: id, after: update });
}

export async function listTemplates(app: AppContext, eventId?: string | null): Promise<Row[]> {
  const where: Row = {};
  if (eventId !== undefined) where.event_id = eventId;
  return app.db.select<Row>("notification_template", where, { orderBy: "key, locale" });
}

/**
 * Copy an event's template overrides onto another event (02, "Cloning an
 * edition").
 *
 * Only the overrides: a key with no row resolves to the shipped default
 * (`resolveTemplate`), and copying one row per key would replace working
 * defaults with copies that stop tracking them. That is also why the starter
 * blueprint writes none at all.
 */
export async function copyTemplatesToEvent(app: AppContext, fromEventId: string, toEventId: string): Promise<Row[]> {
  const source = await app.db.select<Row>("notification_template", { event_id: fromEventId }, { orderBy: "key, locale" });
  const created: Row[] = [];
  for (const t of source) {
    const existing = await app.db.first<Row>("notification_template", { event_id: toEventId, key: str(t.key), locale: str(t.locale, "en") });
    if (existing) continue;
    created.push(
      await createTemplate(app, {
        key: str(t.key),
        channel: str(t.channel, "email") as NotificationChannel,
        subject: strOrNull(t.subject),
        body_markdown: str(t.body_markdown),
        locale: str(t.locale, "en"),
        event_id: toEventId,
        is_active: bool(t.is_active),
      }),
    );
  }
  return created;
}

export async function getTemplateRow(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("notification_template", id);
  if (!row) throw notFound("Notification template", id);
  return row;
}

/**
 * "The compose surface renders the message as one named person will receive
 * it, chosen from the actual recipient set. A preview showing raw tokens
 * proves nothing" (09, "Variables and preview").
 */
export async function previewTemplate(
  app: AppContext,
  input: { key: string; subject?: string | null; body_markdown: string },
  recipientPersonId: string,
): Promise<{ subject: string; html: string; text: string; empty_variables: string[] }> {
  const recipient = await app.db.byId<Row>("person", recipientPersonId);
  if (!recipient) throw notFound("Person", recipientPersonId);
  const vars = await baseVariables(app, recipient);
  const subjectResult = renderTemplate(input.subject ?? "", vars);
  const bodyResult = renderTemplate(input.body_markdown, vars);
  return {
    subject: subjectResult.text,
    html: markdown(bodyResult.text).toString(),
    text: toPlainText(bodyResult.text),
    empty_variables: [...new Set([...subjectResult.empty, ...bodyResult.empty])],
  };
}

export function templateVariableChoices(key: string | null): readonly string[] {
  return declaredVariables(key);
}

export const NOTIFICATION_CHANNEL_OPTIONS = NOTIFICATION_CHANNELS;

export { bool, num, parseJson, str, strOrNull };
