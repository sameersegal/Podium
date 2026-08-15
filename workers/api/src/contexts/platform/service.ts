/**
 * 09 — API & Integrations: `ApiKey`, `Webhook` (+ `WebhookDelivery`), `Integration`.
 *
 * Aggregate roots: `ApiKey`, `Webhook`, `Integration`, `NotificationTemplate`
 * (the last lives in notifications.ts, next to the delivery it drives).
 */

import type { AppContext, Env } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { hashToken, newToken } from "@podiumstack/domain/identity/credentials.js";
import type { ApiScope } from "@podiumstack/domain/shared/authorization.js";
import { DomainError, invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import {
  CAPABILITIES,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_FAILURE_LIMIT,
  backoffSecondsFor,
  type Capability as PluginCapability,
} from "@podiumstack/domain/platform/types.js";
import { assertDeliverableUrl } from "@podiumstack/domain/platform/webhooks.js";
import { eventTypeMatches } from "@podiumstack/domain/events/catalogue.js";
import { FALLBACK_PLUGINS, pluginFor, pluginsForCapability, type AnyPlugin, type PluginContext } from "@podiumstack/plugins/registry.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";

export { MAX_WEBHOOK_ATTEMPTS, WEBHOOK_FAILURE_LIMIT, backoffSecondsFor, CAPABILITIES };

/* -------------------------------------------------------------------------- */
/* ApiKey                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiScope[];
  event_ids?: string[];
  expires_at?: string | null;
  rate_limit_per_minute?: number | null;
}

/** INV-09-1: the secret is displayed once, in the response to this call, and never again. */
export async function createApiKey(app: AppContext, input: CreateApiKeyInput): Promise<{ row: Row; secret: string }> {
  if (!input.name.trim()) throw new DomainError({ code: "invalid_name", message: "Name the key so it can be told apart later.", status: 422 });
  // INV-09-25 makes scopes the whole permission, which makes a key with none a
  // credential that authenticates and can then do nothing — indistinguishable,
  // from the caller's side, from a revoked one.
  if (!input.scopes?.length) {
    throw new DomainError({
      code: "no_scopes",
      message: "Give the key at least one scope; a key with none can reach nothing.",
      invariant: "INV-09-25",
      status: 422,
    });
  }
  const secret = newToken();
  const id = newId("ApiKey");
  const row: Row = {
    id,
    name: input.name.trim(),
    prefix: secret.slice(0, 8),
    secret_hash: hashToken(secret),
    scopes: JSON.stringify(input.scopes ?? []),
    event_ids: input.event_ids?.length ? JSON.stringify(input.event_ids) : null,
    created_by_person_id: app.actor.id ?? "system",
    expires_at: input.expires_at ?? null,
    rate_limit_per_minute: input.rate_limit_per_minute ?? null,
    created_at: app.now(),
  };
  await app.db.insert("api_key", row);
  app.events.emit({
    type: "api_key.created",
    subject: { type: "api_key", id },
    data: { api_key_id: id, name: row.name, scopes: input.scopes ?? [] },
  });
  app.audit.record({ action: "api_key.create", entity_type: "api_key", entity_id: id, after: { name: row.name, scopes: input.scopes } });
  return { row, secret };
}

export async function revokeApiKey(app: AppContext, id: string, reason?: string | null): Promise<void> {
  const key = await app.db.byId<Row>("api_key", id);
  if (!key) throw notFound("API key", id);
  if (key.revoked_at) return; // INV-09-11: already inert; a repeat call is a no-op.
  await app.db.update("api_key", id, { revoked_at: app.now(), revoked_by_person_id: app.actor.id ?? "system" });
  app.events.emit({
    type: "api_key.revoked",
    subject: { type: "api_key", id },
    data: { api_key_id: id, name: str(key.name), scopes: parseJson<string[]>(key.scopes, []) },
  });
  app.audit.record({ action: "api_key.revoke", entity_type: "api_key", entity_id: id, reason: reason ?? null });
}

/** "Rotation issues a new key; keys are never re-displayed" (09, `ApiKey`). */
export async function rotateApiKey(app: AppContext, id: string): Promise<{ row: Row; secret: string }> {
  const key = await app.db.byId<Row>("api_key", id);
  if (!key) throw notFound("API key", id);
  await revokeApiKey(app, id, "Rotated: replaced by a new key.");
  return createApiKey(app, {
    name: `${str(key.name)} (rotated)`,
    scopes: parseJson<ApiScope[]>(key.scopes, []),
    event_ids: parseJson<string[]>(key.event_ids, []),
    rate_limit_per_minute: key.rate_limit_per_minute === null ? null : num(key.rate_limit_per_minute),
  });
}

export async function listApiKeys(app: AppContext): Promise<Row[]> {
  return app.db.select<Row>("api_key", {}, { orderBy: "created_at DESC" });
}

export async function getApiKey(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("api_key", id);
  if (!row) throw notFound("API key", id);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Webhook                                                                     */
/* -------------------------------------------------------------------------- */

export interface WebhookInput {
  name: string;
  url: string;
  event_types: string[];
  event_id?: string | null;
  include_pii?: boolean;
}

function validateEventTypes(types: string[]): void {
  if (!types.length) {
    throw new DomainError({ code: "no_event_types", message: "Pick at least one event type, or `*` for everything.", status: 422 });
  }
}

export async function createWebhook(app: AppContext, input: WebhookInput): Promise<{ row: Row; secret: string }> {
  assertDeliverableUrl(input.url); // INV-09-2, checked at save time too.
  validateEventTypes(input.event_types);
  const secret = newToken();
  const id = newId("Webhook");
  const row: Row = {
    id,
    event_id: input.event_id ?? null,
    name: input.name.trim() || input.url,
    url: input.url,
    event_types: JSON.stringify(input.event_types),
    secret,
    include_pii: input.include_pii ? 1 : 0,
    status: "active",
    consecutive_failures: 0,
    created_by_person_id: app.actor.id ?? "system",
    created_at: app.now(),
    row_version: 1,
  };
  await app.db.insert("webhook", row);
  app.events.emit({
    type: "webhook.created",
    subject: { type: "webhook", id },
    data: { webhook_id: id, url: input.url, event_types: input.event_types },
  });
  app.audit.record({ action: "webhook.create", entity_type: "webhook", entity_id: id, after: { url: input.url, event_types: input.event_types } });
  return { row, secret };
}

export async function updateWebhook(
  app: AppContext,
  id: string,
  patch: { name?: string; url?: string; event_types?: string[]; include_pii?: boolean },
): Promise<void> {
  const webhook = await app.db.byId<Row>("webhook", id);
  if (!webhook) throw notFound("Webhook", id);
  const update: Row = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.url !== undefined) {
    assertDeliverableUrl(patch.url);
    update.url = patch.url;
  }
  if (patch.event_types !== undefined) {
    validateEventTypes(patch.event_types);
    update.event_types = JSON.stringify(patch.event_types);
  }
  if (patch.include_pii !== undefined) update.include_pii = patch.include_pii ? 1 : 0;
  if (Object.keys(update).length === 0) return;
  await app.db.update("webhook", id, update);
  app.audit.record({ action: "webhook.update", entity_type: "webhook", entity_id: id, after: update });
}

export async function rotateWebhookSecret(app: AppContext, id: string): Promise<{ secret: string }> {
  const webhook = await app.db.byId<Row>("webhook", id);
  if (!webhook) throw notFound("Webhook", id);
  const secret = newToken();
  // "Both the current and previous secrets are accepted during a rotation window" (09).
  await app.db.update("webhook", id, { previous_secret: str(webhook.secret), secret, secret_rotated_at: app.now() });
  app.audit.record({ action: "webhook.rotate_secret", entity_type: "webhook", entity_id: id });
  return { secret };
}

export async function setWebhookStatus(app: AppContext, id: string, status: "active" | "paused", reason?: string | null): Promise<void> {
  const webhook = await app.db.byId<Row>("webhook", id);
  if (!webhook) throw notFound("Webhook", id);
  const update: Row = { status };
  if (status === "active") update.consecutive_failures = 0; // a manual re-enable is a fresh start
  await app.db.update("webhook", id, update);
  app.audit.record({ action: "webhook.set_status", entity_type: "webhook", entity_id: id, after: { status }, reason: reason ?? null });
}

export async function listWebhooks(app: AppContext): Promise<Row[]> {
  return app.db.select<Row>("webhook", {}, { orderBy: "created_at DESC" });
}

export async function getWebhook(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("webhook", id);
  if (!row) throw notFound("Webhook", id);
  return row;
}

export async function listWebhookDeliveries(
  app: AppContext,
  webhookId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: Row[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [webhookId];
  let sql = "SELECT * FROM webhook_delivery WHERE webhook_id = ?";
  if (opts.cursor) {
    sql += " AND id < ?";
    params.push(opts.cursor);
  }
  sql += " ORDER BY id DESC LIMIT " + (limit + 1);
  const rows = await app.db.raw<Row>(sql, params);
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? str(items[items.length - 1]?.id) : null };
}

export async function getWebhookDelivery(app: AppContext, id: string): Promise<Row> {
  const rows = await app.db.raw<Row>("SELECT * FROM webhook_delivery WHERE id = ?", [id]);
  if (!rows[0]) throw notFound("Webhook delivery", id);
  return rows[0];
}

/** The next attempt number to use for a (webhook, domain_event) pair. */
async function nextAttempt(app: AppContext, webhookId: string, domainEventId: string): Promise<number> {
  const rows = await app.db.raw<{ n: number }>(
    "SELECT COALESCE(MAX(attempt), 0) AS n FROM webhook_delivery WHERE webhook_id = ? AND domain_event_id = ?",
    [webhookId, domainEventId],
  );
  return num(rows[0]?.n, 0) + 1;
}

async function enqueueWebhookDelivery(env: Env, deliveryId: string, webhookId: string, domainEventId: string): Promise<void> {
  const message: DeliveryMessage = { kind: "webhook", delivery_id: deliveryId, webhook_id: webhookId, event_id: domainEventId };
  try {
    await env.DELIVERY_QUEUE.send(message);
  } catch (err) {
    console.warn("webhook delivery enqueue failed", { delivery_id: deliveryId, error: String(err) });
  }
}

/** Create a delivery row for the very first attempt and enqueue it immediately. */
export async function scheduleWebhookDelivery(app: AppContext, webhookId: string, domainEventId: string): Promise<string> {
  const id = newId("WebhookDelivery");
  await app.db.insertMany("webhook_delivery", [
    {
      id,
      webhook_id: webhookId,
      domain_event_id: domainEventId,
      attempt: await nextAttempt(app, webhookId, domainEventId),
      status: "pending",
      scheduled_for: app.now(),
    },
  ]);
  await enqueueWebhookDelivery(app.env, id, webhookId, domainEventId);
  return id;
}

/** Manual redelivery of one delivery — "makes a consumer's outage recoverable without a support ticket" (09). */
export async function redeliverWebhookDelivery(app: AppContext, deliveryId: string): Promise<string> {
  const delivery = await getWebhookDelivery(app, deliveryId);
  const webhook = await app.db.byId<Row>("webhook", str(delivery.webhook_id));
  if (!webhook) throw notFound("Webhook", str(delivery.webhook_id));
  const id = newId("WebhookDelivery");
  await app.db.insertMany("webhook_delivery", [
    {
      id,
      webhook_id: str(delivery.webhook_id),
      domain_event_id: str(delivery.domain_event_id),
      attempt: await nextAttempt(app, str(delivery.webhook_id), str(delivery.domain_event_id)),
      status: "pending",
      scheduled_for: app.now(),
    },
  ]);
  await enqueueWebhookDelivery(app.env, id, str(delivery.webhook_id), str(delivery.domain_event_id));
  app.audit.record({ action: "webhook_delivery.redeliver", entity_type: "webhook_delivery", entity_id: id, after: { source: deliveryId } });
  return id;
}

/** Replay every event of a type (wildcards allowed) over a time range — 09, "Manual redelivery". */
export async function replayEventType(
  app: AppContext,
  webhookId: string,
  eventTypePattern: string,
  from: string,
  to: string,
): Promise<number> {
  const webhook = await getWebhook(app, webhookId);
  const rows = await app.db.raw<Row>(
    "SELECT id, type FROM domain_event_record WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at",
    [from, to],
  );
  let count = 0;
  for (const r of rows) {
    if (!eventTypeMatches(eventTypePattern, str(r.type))) continue;
    await scheduleWebhookDelivery(app, str(webhook.id), str(r.id));
    count++;
  }
  app.audit.record({
    action: "webhook.replay",
    entity_type: "webhook",
    entity_id: webhookId,
    after: { event_type: eventTypePattern, from, to, count },
  });
  return count;
}

/* -------------------------------------------------------------------------- */
/* Integration                                                                 */
/* -------------------------------------------------------------------------- */

export interface IntegrationInput {
  plugin_key: string;
  event_id?: string | null;
  display_name?: string | null;
  config?: Record<string, unknown>;
  secret_ref?: string | null;
  is_default_for_capability?: boolean;
}

/** Clears any other default for the same capability + scope before this one claims it (INV-09-4). */
async function clearOtherDefaults(app: AppContext, capability: string, eventId: string | null, exceptId: string): Promise<void> {
  await app.db.rawRun(
    "UPDATE integration SET is_default_for_capability = 0 WHERE capability = ? AND COALESCE(event_id,'') = ? AND id != ?",
    [capability, eventId ?? "", exceptId],
  );
}

export async function installIntegration(app: AppContext, input: IntegrationInput): Promise<Row> {
  const plugin = pluginFor(input.plugin_key);
  if (!plugin) {
    throw new DomainError({ code: "unknown_plugin", message: `"${input.plugin_key}" is not a plugin Podium knows about.`, status: 422 });
  }
  if (plugin.requires_secret && !input.secret_ref) {
    throw new DomainError({
      code: "secret_required",
      message: `${plugin.display_name} needs a secret. Point secret_ref at a Workers Secret holding it.`,
      status: 422,
      invariant: "INV-09-3",
    });
  }
  // INV-09-3: config never holds credentials — a caller passing a `secret_ref`-
  // looking key here is refused outright.
  for (const key of Object.keys(input.config ?? {})) {
    if (/secret|token|password|api_key|apikey/i.test(key)) {
      throw invariantError("INV-09-3", "secret_in_config", `"${key}" looks like a credential. Secrets live behind secret_ref, never in config.`, { key });
    }
  }

  const id = newId("Integration");
  const row: Row = {
    id,
    event_id: input.event_id ?? null,
    plugin_key: plugin.key,
    capability: plugin.capability,
    display_name: input.display_name || plugin.display_name,
    config: JSON.stringify(input.config ?? {}),
    secret_ref: input.secret_ref ?? "",
    is_default_for_capability: input.is_default_for_capability ? 1 : 0,
    status: "active",
    created_at: app.now(),
    row_version: 1,
  };
  if (input.is_default_for_capability) await clearOtherDefaults(app, plugin.capability, input.event_id ?? null, id);
  await app.db.insert("integration", row);
  app.events.emit({
    type: "integration.installed",
    subject: { type: "integration", id },
    data: { integration_id: id, plugin_key: plugin.key, capability: plugin.capability },
  });
  app.audit.record({ action: "integration.install", entity_type: "integration", entity_id: id, after: { plugin_key: plugin.key } });
  return row;
}

export async function updateIntegration(
  app: AppContext,
  id: string,
  patch: { display_name?: string; config?: Record<string, unknown>; secret_ref?: string | null; is_default_for_capability?: boolean; status?: "active" | "disabled" },
): Promise<void> {
  const integration = await app.db.byId<Row>("integration", id);
  if (!integration) throw notFound("Integration", id);
  const update: Row = {};
  if (patch.display_name !== undefined) update.display_name = patch.display_name;
  if (patch.config !== undefined) {
    for (const key of Object.keys(patch.config)) {
      if (/secret|token|password|api_key|apikey/i.test(key)) {
        throw invariantError("INV-09-3", "secret_in_config", `"${key}" looks like a credential. Secrets live behind secret_ref, never in config.`, { key });
      }
    }
    update.config = JSON.stringify(patch.config);
  }
  if (patch.secret_ref !== undefined) update.secret_ref = patch.secret_ref ?? "";
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.is_default_for_capability !== undefined) {
    update.is_default_for_capability = patch.is_default_for_capability ? 1 : 0;
    if (patch.is_default_for_capability) {
      await clearOtherDefaults(app, str(integration.capability), strOrNull(integration.event_id), id);
    }
  }
  if (Object.keys(update).length === 0) return;
  await app.db.update("integration", id, update);
  const statusChanged = patch.status !== undefined && patch.status !== str(integration.status);
  if (statusChanged) {
    // INV-09-11: disabling takes effect immediately — resolvePlugin stops
    // returning this row on the very next call, so nothing new is dispatched
    // through it; nothing already in flight needs draining because sends here
    // are synchronous within one queue message.
    app.events.emit({
      type: "integration.health_changed",
      subject: { type: "integration", id },
      data: { integration_id: id, status: patch.status, last_error: null },
    });
  }
  app.audit.record({ action: "integration.update", entity_type: "integration", entity_id: id, after: update });
}

export async function healthCheckIntegration(app: AppContext, id: string): Promise<{ ok: boolean; error?: string }> {
  const integration = await app.db.byId<Row>("integration", id);
  if (!integration) throw notFound("Integration", id);
  const plugin = pluginFor(str(integration.plugin_key));
  if (!plugin?.health) return { ok: true };
  const ctx = await pluginContextFor(app.env, integration);
  const result = await plugin.health(ctx);
  const status = result.ok ? "active" : "misconfigured";
  if (status !== str(integration.status) || result.error !== strOrNull(integration.last_error)) {
    await app.db.update("integration", id, { status, last_error: result.error ?? null, last_health_check_at: app.now() });
    app.events.emit({
      type: "integration.health_changed",
      subject: { type: "integration", id },
      data: { integration_id: id, status, last_error: result.error ?? null },
    });
  } else {
    await app.db.update("integration", id, { last_health_check_at: app.now() });
  }
  return result;
}

export async function listIntegrations(app: AppContext): Promise<Row[]> {
  return app.db.select<Row>("integration", {}, { orderBy: "created_at DESC" });
}

export async function getIntegration(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("integration", id);
  if (!row) throw notFound("Integration", id);
  return row;
}

export function availablePlugins(capability?: PluginCapability): AnyPlugin[] {
  return capability ? pluginsForCapability(capability) : [...CAPABILITIES].flatMap((c) => pluginsForCapability(c));
}

/**
 * Secrets live behind `secret_ref`, "never the secret itself" (INV-09-3).
 * `secret_ref` names a Workers Secret binding on this deployment; resolving it
 * is an environment lookup, never a database read.
 */
export function resolveSecret(env: Env, secretRef: string | null | undefined): string | null {
  if (!secretRef) return null;
  const v = (env as unknown as Record<string, string | undefined>)[secretRef];
  return v ?? null;
}

async function pluginContextFor(env: Env, integration: Row | null, pluginKey?: string): Promise<PluginContext> {
  const key = integration ? str(integration.plugin_key) : (pluginKey ?? "");
  return {
    integration_id: integration ? str(integration.id) : null,
    plugin_key: key,
    config: integration ? parseJson<Record<string, unknown>>(integration.config, {}) : {},
    secret: integration ? resolveSecret(env, str(integration.secret_ref)) : null,
    base_url: env.PUBLIC_BASE_URL || "http://localhost:8787",
    bindings: { bucket: env.ASSETS_BUCKET },
    now: () => new Date().toISOString(),
  };
}

export interface ResolvedPlugin {
  plugin: AnyPlugin;
  integration: Row | null;
  ctx: PluginContext;
}

/**
 * `Integration.plugin_key` → the adapter — 09, "Integration (plugins)".
 * INV-09-4: at most one default per capability per scope, event overriding org.
 * Falls back to the capability's default plugin (`FALLBACK_PLUGINS`) when
 * nothing is installed, **except** for `email`: the caller (notifications.ts)
 * decides `no_provider` itself so INV-09-12's outbox path stays the default
 * rather than a silent `email.log` "success".
 */
export async function resolvePlugin(app: AppContext, capability: PluginCapability, eventId?: string | null): Promise<ResolvedPlugin | null> {
  const rows = await app.db.select<Row>("integration", { capability, status: "active" });
  const eventScoped = eventId ? rows.find((r) => str(r.event_id) === eventId && bool(r.is_default_for_capability)) : undefined;
  const orgScoped = rows.find((r) => !r.event_id && bool(r.is_default_for_capability));
  const onlyOne = rows.length === 1 ? rows[0] : undefined;
  const chosen = eventScoped ?? orgScoped ?? onlyOne;
  if (chosen) {
    const plugin = pluginFor(str(chosen.plugin_key));
    if (!plugin) return null;
    return { plugin, integration: chosen, ctx: await pluginContextFor(app.env, chosen) };
  }
  const fallbackKey = FALLBACK_PLUGINS[capability];
  if (!fallbackKey) return null;
  const plugin = pluginFor(fallbackKey);
  if (!plugin) return null;
  return { plugin, integration: null, ctx: await pluginContextFor(app.env, null, fallbackKey) };
}

/**
 * The adapter for one named `Integration`, rather than the default for a
 * capability. Inbound provider callbacks arrive addressed to a specific
 * installation — the provider is answering *that* integration's sends — so
 * resolving them through `resolvePlugin` would hand a Resend callback to
 * SendGrid the moment SendGrid held the default.
 *
 * INV-09-11: a disabled integration resolves to `null` here exactly as it does
 * in `resolvePlugin`, so disabling stops inbound traffic on the next call too.
 */
export async function resolvePluginForIntegration(app: AppContext, integration: Row): Promise<ResolvedPlugin | null> {
  if (str(integration.status) === "disabled") return null;
  const plugin = pluginFor(str(integration.plugin_key));
  if (!plugin) return null;
  return { plugin, integration, ctx: await pluginContextFor(app.env, integration) };
}

/** Whether an *active* `email` Integration exists for this scope — INV-09-12's gate. */
export async function hasActiveEmailIntegration(app: AppContext, eventId?: string | null): Promise<boolean> {
  const rows = await app.db.select<Row>("integration", { capability: "email", status: "active" });
  if (rows.length === 0) return false;
  if (!eventId) return rows.some((r) => !r.event_id);
  return rows.some((r) => !r.event_id || str(r.event_id) === eventId);
}
