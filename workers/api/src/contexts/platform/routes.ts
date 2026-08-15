/**
 * 09 — API & Integrations: admin UI + management API.
 *
 * Admin (server-rendered): /admin/settings, /admin/api-keys, /admin/webhooks(/:id/deliveries),
 *   /admin/integrations, /admin/templates, /admin/events/:eventId/campaigns (+ compose),
 *   /admin/campaigns/new (org-level, from a CRM contact selection or segment — no event on
 *   the audience), /admin/campaigns/:id, /admin/outbox, /admin/audit, /admin/event-log(/:id).
 * Management API: /v1/api-keys, /v1/webhooks, /v1/integrations, /v1/campaigns, /v1/notifications.
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { PII_EVENT_TYPES, type DomainEventType } from "@podiumstack/domain/events/catalogue.js";
import { API_SCOPES, type ApiScope } from "@podiumstack/domain/shared/authorization.js";
import { DomainError, notFound } from "@podiumstack/domain/shared/errors.js";
import { CAMPAIGN_STATUSES, CAPABILITIES } from "@podiumstack/domain/platform/types.js";
import type { AudienceCriteria } from "@podiumstack/domain/platform/types.js";
import { writableFields } from "@podiumstack/domain/platform/sync.js";
import { activeMappings } from "./sync.js";
import { schedulePull } from "./sync-delivery.js";
import { registerSyncRoutes } from "./sync-routes.js";
import {
  applyDeliveryStatusUpdates,
  inboundWebhookUrl,
  recordSuppression,
  verifyInboundWebhookSignature,
  verifyUnsubscribeSignature,
} from "./notifications.js";
import { formatInZone } from "@podiumstack/domain/shared/time.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { collectPrefixed, readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, stat, table } from "../../ui/layout.js";
import { adminPage, toEventRef, type EventRef } from "../../ui/shell.js";
import {
  createApiKey,
  createWebhook,
  getApiKey,
  getIntegration,
  getWebhook,
  getWebhookDelivery,
  healthCheckIntegration,
  installIntegration,
  listApiKeys,
  listIntegrations,
  listWebhookDeliveries,
  listWebhooks,
  availablePlugins,
  redeliverWebhookDelivery,
  replayEventType,
  resolvePluginForIntegration,
  revokeApiKey,
  rotateApiKey,
  rotateWebhookSecret,
  setWebhookStatus,
  updateIntegration,
  updateWebhook,
} from "./service.js";
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  previewAudience,
  campaignStats,
  scheduleCampaign,
  sendCampaignNow,
  updateCampaign,
} from "./campaigns.js";
import {
  createTemplate,
  getTemplateRow,
  knownTemplateKeys,
  listTemplates,
  previewTemplate,
  templateVariableChoices,
  updateTemplate,
} from "./notifications.js";
import {
  apiKeyJson,
  campaignJson,
  childEventsOf,
  communicationsHistory,
  domainEventPayload,
  getDomainEventRow,
  integrationJson,
  listDomainEvents,
  notificationJson,
  pluginOptionsJson,
  reactionStatusFor,
  templateJson,
  webhookDeliveryJson,
  webhookJson,
} from "./views.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

async function currentEventRef(ctx: RequestContext): Promise<EventRef | null> {
  const rows = await ctx.app().db.select<Row>("event", {}, { orderBy: "created_at DESC", limit: 1 });
  return rows[0] ? toEventRef(rows[0]) : null;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerPlatformRoutes(router: Router<RequestContext>): void {
  registerSettingsRoutes(router);
  registerApiKeyRoutes(router);
  registerWebhookRoutes(router);
  registerIntegrationRoutes(router);
  registerTemplateRoutes(router);
  registerCampaignRoutes(router);
  registerOutboxRoutes(router);
  registerAuditRoutes(router);
  registerEventLogRoutes(router);
  registerUnsubscribeRoutes(router);
  registerInboundWebhookRoutes(router);
  // Before the management API, so `/admin/sync/:mappingId` is matched by its own
  // handler rather than by a broader pattern registered later.
  registerSyncRoutes(router);
  registerManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* Organization settings                                                      */
/* -------------------------------------------------------------------------- */

function registerSettingsRoutes(router: Router<RequestContext>): void {
  router.get("/admin/settings", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const org = await app.db.byId<Row>("organization", app.orgId);
    if (!org) throw notFound("Organization");
    const settings = parseJson<Record<string, unknown>>(org.settings, {});
    const auth = (settings.auth ?? {}) as Record<string, unknown>;
    const review = (settings.review ?? {}) as Record<string, unknown>;
    const privacy = (settings.privacy ?? {}) as Record<string, unknown>;
    const canWrite = ctx.canWrite("org.configure");

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Settings", active: "settings", width: "narrow" },
        html`${pageHead("Organization settings", "Applies across every event in this deployment.")}
          ${card(
            html`<form method="post" action="/admin/settings" class="stack">
              ${field({
                name: "name",
                label: "Organization name",
                required: true,
                value: str(org.name),
              })}
              ${field({ name: "contact_email", label: "Contact email", type: "email", required: true, value: str(org.contact_email) })}
              ${field({
                name: "postal_address",
                label: "Mailing address",
                type: "textarea",
                rows: 2,
                value: strOrNull(org.postal_address) ?? "",
                help: "Appears in the footer of every email this deployment sends.",
                attrs: 'autocomplete="street-address"',
              })}
              ${field({ name: "primary_domain", label: "Primary domain", value: str(org.primary_domain) })}
              <h3>Access</h3>
              ${field({
                name: "password_login_enabled",
                label: "Allow password sign-in",
                type: "checkbox",
                value: auth.password_login_enabled === true,
                help: "Off by default in production; on automatically wherever no email provider is configured, so a deployment can never lock itself out.",
              })}
              <h3>Review</h3>
              ${field({
                name: "ai_evaluation_enabled",
                label: "AI first-pass review",
                type: "checkbox",
                value: review.ai_evaluation_enabled === true,
                help: "Off by default. Never counts toward quorum; always labelled and overridable.",
              })}
              <h3>Privacy</h3>
              ${field({
                name: "retention_days",
                label: "Draft retention (days)",
                type: "number",
                min: 1,
                value: num(privacy.retention_days, 730),
                help: "Draft proposals abandoned this long after an event closes are purged (default 730).",
              })}
              ${canWrite ? html`<button type="submit">Save settings</button>` : html`<p class="muted small">Read-only.</p>`}
            </form>`,
          )}`,
      ),
    );
  });

  router.post("/admin/settings", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const org = await app.db.byId<Row>("organization", app.orgId);
    if (!org) throw notFound("Organization");
    const settings = parseJson<Record<string, unknown>>(org.settings, {});
    settings.auth = { ...(settings.auth as object), password_login_enabled: input.bool("password_login_enabled") };
    settings.review = { ...(settings.review as object), ai_evaluation_enabled: input.bool("ai_evaluation_enabled") };
    settings.privacy = { ...(settings.privacy as object), retention_days: input.int("retention_days", 730) ?? 730 };
    await app.db.update("organization", app.orgId, {
      name: input.str("name", str(org.name)),
      contact_email: input.str("contact_email", str(org.contact_email)),
      postal_address: input.optional("postal_address"),
      primary_domain: input.optional("primary_domain"),
      settings: JSON.stringify(settings),
      updated_at: app.now(),
    });
    app.audit.record({ action: "organization.settings_update", entity_type: "organization", entity_id: app.orgId, after: settings });
    await app.flush();
    return redirect("/admin/settings", 303, OK("Settings saved."));
  });
}

/* -------------------------------------------------------------------------- */
/* ApiKey                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * INV-09-26 — a key may not mint, rotate or revoke a key.
 *
 * Scopes bound what a key can reach (INV-09-25), but a key that can create
 * another key can hand itself scopes it was never granted, and a key that can
 * rotate another key can take that key's secret. Both are escalations that no
 * scope table can express, because the object being administered is the scope
 * system itself. So the rule is about the caller, not the permission: key
 * administration is a person's job. Reads are deliberately still allowed — the
 * list carries prefixes and scopes, never a secret, and it is how a client
 * answers "what am I allowed to do".
 */
function refuseApiKeyActor(ctx: RequestContext): void {
  if (!ctx.apiKeyId) return;
  throw new DomainError({
    code: "api_key_cannot_administer_keys",
    message: "An API key cannot create, rotate or revoke API keys. Sign in and do it at /admin/api-keys.",
    invariant: "INV-09-26",
    status: 403,
  });
}

/**
 * What each scope actually reaches, next to the scope itself on the form.
 * `events:read` does not obviously mean "and the tracks, rooms, formats and
 * CFP configuration", and picking scopes from names alone is how a key ends up
 * either useless or far wider than the job needed.
 */
const SCOPE_HELP: Record<ApiScope, string> = {
  "events:read": "events, days, rooms, tracks, formats, CFPs and forms",
  "events:write": "configure all of the above; run imports and exports; resolve sync conflicts",
  "proposals:read": "the submission pile",
  "proposals:write": "edit, submit and withdraw proposals",
  "reviews:read": "reviews and scores",
  "reviews:write": "post reviews and assignments",
  "decisions:read": "accept/reject/waitlist decisions",
  "decisions:write": "record decisions and open review rounds",
  "sessions:read": "the programme, its speakers and uploaded files",
  "sessions:write": "edit sessions, approve content, add speakers",
  "speakers:read": "the speaker directory, segments, pipelines and sent mail",
  "speakers:write": "rosters, profiles, notes, segments — and sending campaigns",
  "sponsors:read": "sponsors and sponsorships",
  "sponsors:write": "create and confirm sponsorships",
  "entitlements:read": "sponsor entitlements and what has been consumed",
  "entitlements:write": "grant and adjust entitlements",
  "tasks:read": "onboarding task definitions and instances",
  "tasks:write": "define, remind, approve and waive tasks",
  "schedule:read": "the agenda grid, conflicts and publication history",
  "schedule:publish": "place sessions and publish the schedule",
  "webhooks:manage": "platform administration — webhooks, integrations, templates, audit log",
  "pii:read": "additive: unredact email, phone, dietary, accessibility and travel data",
};

function registerApiKeyRoutes(router: Router<RequestContext>): void {
  router.get("/admin/api-keys", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const keys = await listApiKeys(app);
    const canWrite = ctx.canWrite("org.configure");
    const rows = keys.map(
      (k) => html`<tr>
        <td><strong>${str(k.name)}</strong><br><span class="mono small muted">${str(k.prefix)}…</span></td>
        <td>${parseJson<string[]>(k.scopes, []).map((s) => badge(s))}</td>
        <td class="small">${k.last_used_at ? str(k.last_used_at) : "never"}</td>
        <td>${k.revoked_at ? badge("revoked", "err") : k.expires_at && str(k.expires_at) < ctx.now ? badge("expired", "err") : badge("active", "ok")}</td>
        <td class="right">
          ${canWrite && !k.revoked_at
            ? html`${actionForm(`/admin/api-keys/${str(k.id)}/rotate`, "Rotate", { confirm: "Rotate this key? The old one stops working immediately." })}
                ${actionForm(`/admin/api-keys/${str(k.id)}/revoke`, "Revoke", { className: "danger", confirm: "Revoke this key now?" })}`
            : raw("")}
        </td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: "API keys", active: "api-keys", width: "wide" },
        html`${pageHead(
            "API keys",
            "Scoped credentials for the management API. The secret is shown once, here, and never again.",
            canWrite ? html`<a class="btn" href="/admin/api-keys/new">New API key</a>` : raw(""),
          )}
          ${ctx.flash?.kind === "ok" && ctx.flash.message.startsWith("secret:")
            ? html`<p class="notice ok">Secret (copy it now — it will not be shown again): <span class="mono">${ctx.flash.message.slice(7)}</span></p>`
            : raw("")}
          ${table(["Key", "Scopes", "Last used", "Status", ""], rows, "No API keys yet.")}`,
      ),
    );
  });

  router.get("/admin/api-keys/new", async (_req, ctx) => {
    ctx.requireWrite("org.configure");
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New API key", active: "api-keys", width: "narrow" },
        html`${pageHead("New API key", "A key reaches exactly what its scopes name and nothing else, so the scopes chosen here are the whole permission.")}
          ${card(html`<form method="post" action="/admin/api-keys/new" class="stack">
            ${field({ name: "name", label: "Name", required: true, placeholder: "Marketing site" })}
            ${field({
              name: "scopes",
              label: "Scopes",
              type: "multi_select",
              required: true,
              options: API_SCOPES.map((s) => ({ value: s, label: `${s} — ${SCOPE_HELP[s]}` })),
              help: "Pick at least one; a key with none can do nothing. Read scopes work on their own — a read-only key reads the event but never reviews, scores or personal data. pii:read is additive: without it, personal data is redacted everywhere, including inside proposals:read. webhooks:manage is the platform-administration scope, and no key of any kind may create or rotate API keys.",
            })}
            ${field({ name: "event_ids", label: "Restrict to event ids (comma-separated)", help: "Leave blank for every event." })}
            <button type="submit">Create key</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/api-keys/new", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    refuseApiKeyActor(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const { secret } = await createApiKey(app, {
      name: input.str("name"),
      scopes: input.list("scopes") as ApiScope[],
      event_ids: input.str("event_ids").split(",").map((s) => s.trim()).filter(Boolean),
    });
    await app.flush();
    return redirect("/admin/api-keys", 303, OK(`secret:${secret}`));
  });

  router.post("/admin/api-keys/:id/revoke", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    refuseApiKeyActor(ctx);
    const app = ctx.app();
    await revokeApiKey(app, params.id, "Revoked from the admin API keys screen.");
    await app.flush();
    return redirect("/admin/api-keys", 303, OK("Key revoked."));
  });

  router.post("/admin/api-keys/:id/rotate", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    refuseApiKeyActor(ctx);
    const app = ctx.app();
    const { secret } = await rotateApiKey(app, params.id);
    await app.flush();
    return redirect("/admin/api-keys", 303, OK(`secret:${secret}`));
  });
}

/* -------------------------------------------------------------------------- */
/* Webhook                                                                     */
/* -------------------------------------------------------------------------- */

function webhookForm(w: Row | null, events: Row[]): SafeHtml {
  return html`
    ${field({ name: "name", label: "Name", required: true, value: w ? str(w.name) : "" })}
    ${field({ name: "url", label: "URL", type: "url", required: true, value: w ? str(w.url) : "", help: "Absolute https only." })}
    ${field({
      name: "event_types",
      label: "Event types",
      value: w ? parseJson<string[]>(w.event_types, []).join(", ") : "*",
      help: "Comma-separated. `*` for everything, or a `noun.*` wildcard.",
    })}
    ${field({ name: "event_id", label: "Restrict to one event", type: "select", value: w ? str(w.event_id) : "", options: events.map((e) => ({ value: str(e.id), label: str(e.name) })) })}
    ${field({ name: "include_pii", label: "Include personal data in payloads", type: "checkbox", value: w ? bool(w.include_pii) : false })}
  `;
}

function registerWebhookRoutes(router: Router<RequestContext>): void {
  router.get("/admin/webhooks", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const webhooks = await listWebhooks(app);
    const canWrite = ctx.canWrite("org.configure");
    const rows = webhooks.map(
      (w) => html`<tr>
        <td><a href="/admin/webhooks/${str(w.id)}"><strong>${str(w.name)}</strong></a><br><span class="mono small muted">${str(w.url)}</span></td>
        <td>${parseJson<string[]>(w.event_types, []).map((t) => badge(t))}</td>
        <td>${badge(str(w.status), str(w.status) === "active" ? "ok" : "err")}</td>
        <td>${num(w.consecutive_failures)}</td>
        <td class="right">
          <a class="btn secondary small" href="/admin/webhooks/${str(w.id)}/deliveries">Deliveries</a>
          ${canWrite && str(w.status) !== "active"
            ? actionForm(`/admin/webhooks/${str(w.id)}/resume`, "Resume")
            : canWrite
              ? actionForm(`/admin/webhooks/${str(w.id)}/pause`, "Pause")
              : raw("")}
        </td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Webhooks", active: "webhooks", width: "wide" },
        html`${pageHead(
            "Webhooks",
            "Push domain events to another system, signed with HMAC-SHA256.",
            canWrite ? html`<a class="btn" href="/admin/webhooks/new">New webhook</a>` : raw(""),
          )}
          ${table(["Webhook", "Event types", "Status", "Consecutive failures", ""], rows, "No webhooks yet.")}`,
      ),
    );
  });

  router.get("/admin/webhooks/new", async (_req, ctx) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New webhook", active: "webhooks", width: "narrow" },
        html`${pageHead("New webhook")}
          ${card(html`<form method="post" action="/admin/webhooks/new" class="stack">${webhookForm(null, events)}<button type="submit">Create webhook</button></form>`)}`,
      ),
    );
  });

  router.post("/admin/webhooks/new", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const { row, secret } = await createWebhook(app, {
      name: input.str("name"),
      url: input.str("url"),
      event_types: input.str("event_types", "*").split(",").map((s) => s.trim()).filter(Boolean),
      event_id: input.optional("event_id"),
      include_pii: input.bool("include_pii"),
    });
    await app.flush();
    return redirect(`/admin/webhooks/${str(row.id)}`, 303, OK(`Webhook created. Signing secret (shown once): ${secret}`));
  });

  router.get("/admin/webhooks/:id", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const webhook = await getWebhook(app, params.id);
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    const canWrite = ctx.canWrite("org.configure");
    const recentDeliveries = await listWebhookDeliveries(app, params.id, { limit: 5 });
    return htmlResponse(
      adminPage(
        ctx,
        { title: str(webhook.name), active: "webhooks", width: "narrow" },
        html`${pageHead(str(webhook.name), str(webhook.url))}
          ${canWrite
            ? card(html`<form method="post" action="/admin/webhooks/${params.id}" class="stack">${webhookForm(webhook, events)}<button type="submit">Save</button></form>`)
            : raw("")}
          ${canWrite
            ? card(
                html`<p class="muted">Both the current and previous secret verify signatures during a rotation window.</p>
                  ${actionForm(`/admin/webhooks/${params.id}/rotate-secret`, "Rotate signing secret", { confirm: "Rotate the secret? Update the receiver before the previous one stops being accepted." })}`,
                "Signing secret",
              )
            : raw("")}
          ${card(
              html`<p>Recent deliveries — <a href="/admin/webhooks/${params.id}/deliveries">see all</a></p>
                ${table(
                  ["Attempt", "Status", "Response", ""],
                  recentDeliveries.items.map(
                    (d) => html`<tr><td>${num(d.attempt)}</td><td>${badge(str(d.status))}</td><td>${d.response_status ?? "—"}</td>
                      <td class="right">${canWrite ? actionForm(`/admin/webhooks/${params.id}/deliveries/${str(d.id)}/redeliver`, "Redeliver") : raw("")}</td></tr>`,
                  ),
                  "No deliveries yet.",
                )}`,
              "Deliveries",
            )}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/webhooks/${params.id}/replay" class="inline-grid">
                  ${field({ name: "event_type", label: "Event type", value: "*", help: "`*` or a `noun.*` wildcard." })}
                  ${field({ name: "from", label: "From", type: "datetime-local", required: true })}
                  ${field({ name: "to", label: "To", type: "datetime-local", required: true })}
                  <button type="submit">Replay</button>
                </form>`,
                "Replay a time range",
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/admin/webhooks/:id", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    await updateWebhook(app, params.id, {
      name: input.str("name"),
      url: input.str("url"),
      event_types: input.str("event_types", "*").split(",").map((s) => s.trim()).filter(Boolean),
      include_pii: input.bool("include_pii"),
    });
    await app.flush();
    return redirect(`/admin/webhooks/${params.id}`, 303, OK("Webhook updated."));
  });

  router.post("/admin/webhooks/:id/rotate-secret", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const { secret } = await rotateWebhookSecret(app, params.id);
    await app.flush();
    return redirect(`/admin/webhooks/${params.id}`, 303, OK(`New signing secret (shown once): ${secret}`));
  });

  router.post("/admin/webhooks/:id/pause", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    await setWebhookStatus(app, params.id, "paused", "Paused from the admin webhooks screen.");
    await app.flush();
    return redirect("/admin/webhooks", 303, OK("Webhook paused."));
  });

  router.post("/admin/webhooks/:id/resume", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    await setWebhookStatus(app, params.id, "active", "Resumed from the admin webhooks screen.");
    await app.flush();
    return redirect("/admin/webhooks", 303, OK("Webhook resumed."));
  });

  router.post("/admin/webhooks/:id/replay", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const count = await replayEventType(
      app,
      params.id,
      input.str("event_type", "*"),
      new Date(input.str("from")).toISOString(),
      new Date(input.str("to")).toISOString(),
    );
    await app.flush();
    return redirect(`/admin/webhooks/${params.id}`, 303, OK(`Replaying ${count} event(s).`));
  });

  router.get("/admin/webhooks/:id/deliveries", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const webhook = await getWebhook(app, params.id);
    const canWrite = ctx.canWrite("org.configure");
    const cursor = ctx.url.searchParams.get("cursor");
    const page = await listWebhookDeliveries(app, params.id, { cursor });
    const rows = page.items.map(
      (d) => html`<tr>
        <td class="mono small">${str(d.id)}</td>
        <td>${num(d.attempt)}</td>
        <td>${badge(str(d.status), str(d.status) === "delivered" ? "ok" : str(d.status) === "pending" ? "" : "err")}</td>
        <td>${d.response_status ?? "—"}</td>
        <td class="small">${str(d.scheduled_for) || "—"}</td>
        <td class="small">${str(d.delivered_at) || "—"}</td>
        <td class="right">${canWrite && str(d.status) !== "pending" ? actionForm(`/admin/webhooks/${params.id}/deliveries/${str(d.id)}/redeliver`, "Redeliver") : raw("")}</td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: `${str(webhook.name)} — deliveries`, active: "webhooks", width: "wide" },
        html`${pageHead(`Deliveries for ${str(webhook.name)}`, "At-least-once, ordered per subject.")}
          ${table(["Delivery", "Attempt", "Status", "HTTP", "Scheduled", "Delivered", ""], rows, "No deliveries yet.")}
          ${page.next_cursor ? html`<p><a href="/admin/webhooks/${params.id}/deliveries?cursor=${page.next_cursor}">Older →</a></p>` : raw("")}`,
      ),
    );
  });

  router.post("/admin/webhooks/:id/deliveries/:deliveryId/redeliver", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    await redeliverWebhookDelivery(app, params.deliveryId);
    await app.flush();
    return redirect(`/admin/webhooks/${params.id}/deliveries`, 303, OK("Redelivering now."));
  });
}

/* -------------------------------------------------------------------------- */
/* Integration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * INV-09-3: the secret itself is never asked for here, only the *name* of the
 * Workers Secret holding it. `requires_secret` plugins mark it required, which
 * is the difference between a failed install and an integration that looks
 * installed and fails on first send.
 */
function integrationSecretField(plugin: { requires_secret?: boolean }, value: string): SafeHtml {
  if (!plugin.requires_secret) return raw("");
  return field({
    name: "secret_ref",
    label: "Secret ref",
    required: true,
    value,
    help: "The name of a Workers Secret holding the credential — never the secret itself. Set it with `wrangler secret put <NAME>`.",
  });
}

/** A plugin's declared `config_fields`, namespaced so `collectPrefixed` can lift them back out. */
function integrationConfigFields(plugin: { config_fields?: { key: string; label: string; required?: boolean; help?: string }[] }, config: Record<string, unknown>): SafeHtml {
  const fields = plugin.config_fields ?? [];
  if (fields.length === 0) return raw("");
  return html`${fields.map((f) =>
    field({
      name: `config.${f.key}`,
      label: f.label,
      required: f.required,
      help: f.help,
      value: config[f.key] === undefined || config[f.key] === null ? "" : String(config[f.key]),
    }),
  )}`;
}

function registerIntegrationRoutes(router: Router<RequestContext>): void {
  router.get("/admin/integrations", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const installed = await listIntegrations(app);
    const canWrite = ctx.canWrite("org.configure");
    const rows = installed.map(
      (i) => html`<tr>
        <td><a href="/admin/integrations/${str(i.id)}"><strong>${str(i.display_name)}</strong></a><br><span class="mono small muted">${str(i.plugin_key)}</span></td>
        <td>${badge(str(i.capability))}</td>
        <td>
          ${badge(str(i.status), str(i.status) === "active" ? "ok" : "err")}
          ${i.last_error ? html`<br><span class="small muted">${str(i.last_error)}</span>` : raw("")}
        </td>
        <td>${bool(i.is_default_for_capability) ? badge("default", "ok") : raw("")}</td>
        <td class="right">
          ${canWrite
            ? html`<a class="button" href="/admin/integrations/${str(i.id)}">Configure</a>
                ${actionForm(`/admin/integrations/${str(i.id)}/health-check`, "Check health")}
                ${actionForm(`/admin/integrations/${str(i.id)}/disable`, str(i.status) === "disabled" ? "Enable" : "Disable", {
                  className: str(i.status) === "disabled" ? "" : "danger",
                  hidden: { status: str(i.status) === "disabled" ? "active" : "disabled" },
                })}`
            : raw("")}
        </td>
      </tr>`,
    );
    const plugins = pluginOptionsJson();
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Integrations", active: "integrations", width: "wide" },
        html`${pageHead("Integrations", "Capability contracts — the core never imports a vendor SDK.")}
          ${table(["Integration", "Capability", "Status", "Default", ""], rows, "Nothing installed. Without an active email integration, mail is recorded in the outbox and never sent.")}
          ${canWrite
            ? card(
                // Choosing the plugin is its own step because each one asks for
                // different `config_fields`, and this surface is server-rendered
                // with no client framework to swap the form in place.
                html`<form method="get" action="/admin/integrations/new" class="stack">
                  ${field({
                    name: "plugin_key",
                    label: "Plugin",
                    type: "select",
                    required: true,
                    options: plugins.map((p) => ({ value: String(p.key), label: `${String(p.display_name)} (${String(p.capability)})` })),
                  })}
                  <button type="submit">Continue</button>
                </form>`,
                "Install a plugin",
              )
            : raw("")}`,
      ),
    );
  });

  // Registered before `/admin/integrations/:id` — the router takes the first
  // pattern that matches, and `new` is not an integration id.
  router.get("/admin/integrations/new", async (_req, ctx) => {
    ctx.requireWrite("org.configure");
    const pluginKey = ctx.url.searchParams.get("plugin_key") ?? "";
    const plugin = availablePlugins().find((p) => p.key === pluginKey);
    if (!plugin) throw notFound("Plugin", pluginKey);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Install ${plugin.display_name}`, active: "integrations", width: "narrow" },
        html`${pageHead(`Install ${plugin.display_name}`, `${humanise(plugin.capability)} — configure it before it goes live.`)}
          ${card(
            html`<form method="post" action="/admin/integrations/new" class="stack">
              <input type="hidden" name="plugin_key" value="${plugin.key}">
              ${field({ name: "display_name", label: "Display name", value: plugin.display_name })}
              ${integrationSecretField(plugin, "")} ${integrationConfigFields(plugin, {})}
              ${field({ name: "is_default_for_capability", label: `Make this the default for ${plugin.capability}`, type: "checkbox", value: true })}
              <button type="submit">Install</button>
            </form>`,
            "Settings",
          )}`,
      ),
    );
  });

  router.post("/admin/integrations/new", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const created = await installIntegration(app, {
      plugin_key: input.str("plugin_key"),
      display_name: input.optional("display_name"),
      secret_ref: input.optional("secret_ref"),
      // Without this the install form could never satisfy a plugin's required
      // `config_fields` — `email.sendgrid` has no `from_email` and fails every
      // send with "No from address is configured."
      config: collectPrefixed(input, "config."),
      is_default_for_capability: input.bool("is_default_for_capability"),
    });
    await app.flush();
    return redirect(`/admin/integrations/${str(created.id)}`, 303, OK("Integration installed."));
  });

  router.get("/admin/integrations/:id", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const integration = await getIntegration(app, params.id);
    const plugin = availablePlugins().find((p) => p.key === str(integration.plugin_key));
    if (!plugin) throw notFound("Plugin", str(integration.plugin_key));
    const config = parseJson<Record<string, unknown>>(integration.config, {});
    const canWrite = ctx.canWrite("org.configure");
    // `email` receives delivery-status callbacks; `sync` receives a change ping
    // (09). Nothing else in the contract set has an inbound side.
    const hasInbound = plugin.capability === "email" || plugin.capability === "sync";
    const inbound = hasInbound ? await inboundWebhookUrl(ctx.env, str(integration.id)) : null;
    const isSync = plugin.capability === "sync";
    const mappingCount = isSync ? await app.db.count("sync_mapping", { integration_id: str(integration.id) }) : 0;
    return htmlResponse(
      adminPage(
        ctx,
        { title: str(integration.display_name), active: "integrations", width: "narrow" },
        html`${pageHead(str(integration.display_name), `${str(integration.plugin_key)} — ${humanise(str(integration.capability))}`)}
          ${integration.last_error ? card(html`<p class="small">${str(integration.last_error)}</p>`, "Last error") : raw("")}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/integrations/${str(integration.id)}" class="stack">
                  ${field({ name: "display_name", label: "Display name", value: str(integration.display_name) })}
                  ${integrationSecretField(plugin, str(integration.secret_ref))} ${integrationConfigFields(plugin, config)}
                  ${field({
                    name: "is_default_for_capability",
                    label: `Make this the default for ${str(integration.capability)}`,
                    type: "checkbox",
                    value: bool(integration.is_default_for_capability),
                  })}
                  <button type="submit">Save</button>
                </form>`,
                "Settings",
              )
            : raw("")}
          ${isSync
            ? card(
                html`<p class="small muted">
                    ${mappingCount === 0
                      ? "Nothing is mirrored yet. A mapping points one kind of record at one table in the base."
                      : `${mappingCount} table(s) mapped.`}
                  </p>
                  <p><a class="button" href="/admin/integrations/${str(integration.id)}/sync">Tables and fields</a>
                    <a class="button secondary" href="/admin/sync">Conflicts</a></p>`,
                "Two-way sync",
              )
            : raw("")}
          ${inbound
            ? card(
                html`<p class="small muted">
                    ${isSync
                      ? "Call this from an automation in the base whenever a record changes. It is only a hint that makes the sync feel live — a scheduled sweep runs either way, so a ping that never arrives costs a few minutes, not a change."
                      : "Paste this into the provider's delivery-event webhook setting. Bounces and complaints arriving here move the outbox row past `sent` and put a hard bounce on the suppression list."}
                  </p>
                  <p class="mono small">${inbound}</p>
                  <p class="small muted">The signature in the URL is what authenticates the provider, so treat it as a credential.</p>`,
                isSync ? "Change ping" : "Delivery events webhook",
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/admin/integrations/:id", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const integration = await getIntegration(app, params.id);
    // The form only renders the plugin's declared `config_fields`, so it merges
    // over the stored config rather than replacing it — a key set through
    // `POST /v1/integrations` that this plugin does not declare survives a save
    // here instead of being silently dropped.
    const config = { ...parseJson<Record<string, unknown>>(integration.config, {}), ...collectPrefixed(input, "config.") };
    await updateIntegration(app, params.id, {
      display_name: input.str("display_name"),
      secret_ref: input.optional("secret_ref"),
      config,
      is_default_for_capability: input.bool("is_default_for_capability"),
    });
    await app.flush();
    return redirect(`/admin/integrations/${params.id}`, 303, OK("Saved."));
  });

  router.post("/admin/integrations/:id/health-check", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const result = await healthCheckIntegration(app, params.id);
    await app.flush();
    return redirect("/admin/integrations", 303, result.ok ? OK("Healthy.") : { "set-cookie": flashCookie("warn", result.error ?? "Health check failed.") });
  });

  router.post("/admin/integrations/:id/disable", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    await updateIntegration(app, params.id, { status: (input.str("status", "disabled") as "active" | "disabled") });
    await app.flush();
    return redirect("/admin/integrations", 303, OK("Updated."));
  });
}

/* -------------------------------------------------------------------------- */
/* NotificationTemplate                                                       */
/* -------------------------------------------------------------------------- */

function registerTemplateRoutes(router: Router<RequestContext>): void {
  router.get("/admin/templates", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const templates = await listTemplates(app);
    const canWrite = ctx.canWrite("org.configure");
    const rows = templates.map(
      (t) => html`<tr>
        <td><a href="/admin/templates/${str(t.id)}"><strong>${str(t.key)}</strong></a></td>
        <td>${badge(str(t.channel))}</td>
        <td>${str(t.locale)}</td>
        <td>v${num(t.version, 1)}</td>
        <td>${bool(t.is_active) ? badge("active", "ok") : badge("inactive")}</td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Message templates", active: "templates", width: "wide" },
        html`${pageHead(
            "Message templates",
            "System-triggered messages. Unknown variables are rejected at save time.",
            canWrite ? html`<a class="btn" href="/admin/templates/new">New template</a>` : raw(""),
          )}
          ${table(["Key", "Channel", "Locale", "Version", "Status"], rows, "No org-level overrides yet — defaults from the catalogue are used.")}
          <p class="muted small">Known keys: ${knownTemplateKeys().join(", ")}</p>`,
      ),
    );
  });

  router.get("/admin/templates/new", async (_req, ctx) => {
    ctx.requireWrite("org.configure");
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New template", active: "templates", width: "narrow" },
        html`${pageHead("New template")}
          ${card(html`<form method="post" action="/admin/templates/new" class="stack">
            ${field({ name: "key", label: "Key", required: true, help: `One of: ${knownTemplateKeys().join(", ")} — or a custom key for a one-off variable set.` })}
            ${field({ name: "subject", label: "Subject" })}
            ${field({ name: "body_markdown", label: "Body (markdown)", type: "textarea", rows: 10, required: true })}
            ${field({ name: "locale", label: "Locale", value: "en" })}
            <button type="submit">Create</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/templates/new", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const row = await createTemplate(app, {
      key: input.str("key"),
      subject: input.optional("subject"),
      body_markdown: input.str("body_markdown"),
      locale: input.str("locale", "en"),
    });
    await app.flush();
    return redirect(`/admin/templates/${str(row.id)}`, 303, OK("Template created."));
  });

  router.get("/admin/templates/:id", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const t = await getTemplateRow(app, params.id);
    const canWrite = ctx.canWrite("org.configure");
    const people = await app.db.select<Row>("person", {}, { orderBy: "full_name", limit: 100 });
    const previewPersonId = ctx.url.searchParams.get("preview_person_id");
    let preview: SafeHtml = raw("");
    if (previewPersonId) {
      const rendered = await previewTemplate(app, { key: str(t.key), subject: strOrNull(t.subject), body_markdown: str(t.body_markdown) }, previewPersonId);
      preview = html`<div class="card">
        <h3>Preview</h3>
        <p><strong>${rendered.subject}</strong></p>
        <div>${raw(rendered.html)}</div>
        ${rendered.empty_variables.length ? html`<p class="notice warn">Empty for this recipient: ${rendered.empty_variables.join(", ")}</p>` : raw("")}
      </div>`;
    }
    return htmlResponse(
      adminPage(
        ctx,
        { title: str(t.key), active: "templates", width: "narrow" },
        html`${pageHead(str(t.key), `Declared variables: ${templateVariableChoices(str(t.key)).join(", ")}`)}
          ${canWrite
            ? card(html`<form method="post" action="/admin/templates/${params.id}" class="stack">
                ${field({ name: "subject", label: "Subject", value: strOrNull(t.subject) })}
                ${field({ name: "body_markdown", label: "Body (markdown)", type: "textarea", rows: 10, required: true, value: str(t.body_markdown) })}
                ${field({ name: "is_active", label: "Active", type: "checkbox", value: bool(t.is_active) })}
                <button type="submit">Save</button>
              </form>`)
            : raw("")}
          ${card(
              html`<form method="get" action="/admin/templates/${params.id}" class="inline-grid">
                ${field({ name: "preview_person_id", label: "Preview as", type: "select", options: people.map((p) => ({ value: str(p.id), label: `${str(p.display_name) || str(p.full_name)} <${str(p.email)}>` })) })}
                <button type="submit">Preview</button>
              </form>`,
              "Preview against a real recipient",
            )}
          ${preview}`,
      ),
    );
  });

  router.post("/admin/templates/:id", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    await updateTemplate(app, params.id, {
      subject: input.optional("subject"),
      body_markdown: input.str("body_markdown"),
      is_active: input.bool("is_active"),
    });
    await app.flush();
    return redirect(`/admin/templates/${params.id}`, 303, OK("Template saved."));
  });
}

/* -------------------------------------------------------------------------- */
/* Campaign                                                                    */
/* -------------------------------------------------------------------------- */

function readAudience(input: Input): AudienceCriteria {
  return {
    kind: (input.optional("audience_kind") as AudienceCriteria["kind"]) ?? "event_participants",
    event_id: input.optional("event_id"),
    participant_status: input.list("participant_status"),
    track_ids: input.list("track_ids"),
    has_outstanding_tasks: input.has("has_outstanding_tasks") ? input.bool("has_outstanding_tasks") : undefined,
    person_ids: input.str("person_ids").split(",").map((s) => s.trim()).filter(Boolean),
    segment_id: input.optional("segment_id"),
  };
}

function registerCampaignRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/campaigns", async (_req, ctx, params) => {
    ctx.requireRead("campaign.send", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const event = await app.db.byId<Row>("event", params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    const ref = toEventRef(event);
    const campaigns = await listCampaigns(app, params.eventId);
    const canWrite = ctx.canWrite("campaign.send", { event_id: params.eventId });
    const rows = campaigns.map(
      (c) => html`<tr>
        <td><a href="/admin/campaigns/${str(c.id)}"><strong>${str(c.name)}</strong></a></td>
        <td>${badge(str(c.channel))}</td>
        <td>${badge(str(c.status))}</td>
        <td class="small">${str(c.scheduled_for) || str(c.sent_at) || "—"}</td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Campaigns", event: ref, active: "campaigns", width: "wide" },
        html`${pageHead(
            "Campaigns",
            "Organizer-composed bulk messaging — every recipient gets an ordinary notification delivery, tracked in the outbox like any other.",
            canWrite ? html`<a class="btn" href="/admin/events/${params.eventId}/campaigns/new">Compose</a>` : raw(""),
          )}
          ${table(["Name", "Channel", "Status", "Sent / scheduled"], rows, "No campaigns yet.")}`,
      ),
    );
  });

  router.get("/admin/events/:eventId/campaigns/new", async (_req, ctx, params) => {
    ctx.requireWrite("campaign.send", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const event = await app.db.byId<Row>("event", params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    const ref = toEventRef(event);
    const templates = await listTemplates(app, null);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Compose a campaign", event: ref, active: "campaigns", width: "narrow" },
        html`${pageHead("Compose a campaign")}
          ${card(html`<form method="post" action="/admin/events/${params.eventId}/campaigns/new" class="stack">
            ${field({ name: "name", label: "Internal name", required: true, placeholder: "Room change notice" })}
            ${field({ name: "channel", label: "Channel", type: "select", required: true, value: "email", options: [{ value: "email", label: "Email" }, { value: "chat", label: "Chat" }] })}
            ${field({ name: "template_id", label: "Based on template (optional)", type: "select", options: templates.map((t) => ({ value: str(t.id), label: str(t.key) })) })}
            ${field({ name: "subject", label: "Subject" })}
            ${field({ name: "body_markdown", label: "Body (markdown)", type: "textarea", rows: 8, required: true })}
            <h3>Audience</h3>
            ${field({
              name: "audience_kind",
              label: "Who",
              type: "select",
              value: "event_participants",
              options: [
                { value: "event_participants", label: "Event roster" },
                { value: "speakers", label: "Confirmed speakers" },
                { value: "sponsor_contacts", label: "Sponsor contacts" },
                { value: "reviewers", label: "Reviewers" },
              ],
            })}
            ${field({ name: "participant_status", label: "Roster status (event_participants only)", type: "multi_select", options: ["prospect", "invited", "confirmed", "declined", "withdrawn"].map((s) => ({ value: s, label: humanise(s) })) })}
            ${field({ name: "has_outstanding_tasks", label: "Has an outstanding task", type: "checkbox" })}
            <button type="submit">Save as draft</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/campaigns/new", async (req, ctx, params) => {
    ctx.requireWrite("campaign.send", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const audience = readAudience(input);
    audience.event_id = params.eventId;
    const campaign = await createCampaign(app, {
      name: input.str("name"),
      channel: input.str("channel", "email") as "email" | "chat",
      template_id: input.optional("template_id"),
      subject: input.optional("subject"),
      body_markdown: input.str("body_markdown"),
      audience,
      event_id: params.eventId,
    });
    await app.flush();
    return redirect(`/admin/campaigns/${str(campaign.id)}`, 303, OK("Campaign saved as a draft."));
  });

  /**
   * The org-level composer — for an audience that predates any one event, or
   * spans several. `Campaign.event_id` is nullable and `resolveAudience`
   * already handles the `people`/`segment` kinds without an event on the
   * criteria; only the route was missing. Two entry points reach it before
   * this existed and 404'd every time: the contacts directory's bulk
   * "Start a campaign with these contacts" and a segment's "Send a campaign
   * to this segment".
   */
  router.get("/admin/campaigns/new", async (_req, ctx) => {
    ctx.requireWrite("campaign.send", { event_id: null });
    const app = ctx.app();
    const personIds = (ctx.url.searchParams.get("person_ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const segmentId = ctx.url.searchParams.get("segment_id");
    if (!personIds.length && !segmentId) {
      throw notFound("A campaign needs a starting audience — from the contacts directory or a segment");
    }
    const audience: AudienceCriteria = segmentId ? { kind: "segment", segment_id: segmentId } : { kind: "people", person_ids: personIds };
    const [templates, preview] = await Promise.all([listTemplates(app, null), previewAudience(app, audience)]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Compose a campaign", active: "contacts", width: "narrow" },
        html`${pageHead("Compose a campaign", `${preview.total} recipient${preview.total === 1 ? "" : "s"} — ${segmentId ? "this segment" : "the contacts you selected"}.`)}
          ${card(
            html`${preview.sample.map((m) => html`<p class="small muted">${str(m.name)} — ${str(m.email)}</p>`)}${preview.total > preview.sample.length ? html`<p class="small muted">… and ${preview.total - preview.sample.length} more.</p>` : raw("")}`,
            "Who this reaches",
          )}
          ${card(html`<form method="post" action="/admin/campaigns/new" class="stack">
            <input type="hidden" name="audience_kind" value="${segmentId ? "segment" : "people"}">
            ${segmentId ? html`<input type="hidden" name="segment_id" value="${segmentId}">` : html`<input type="hidden" name="person_ids" value="${personIds.join(",")}">`}
            ${field({ name: "name", label: "Internal name", required: true, placeholder: "Speak at DevFlow Conf 2027?" })}
            ${field({ name: "channel", label: "Channel", type: "select", required: true, value: "email", options: [{ value: "email", label: "Email" }, { value: "chat", label: "Chat" }] })}
            ${field({ name: "template_id", label: "Based on template (optional)", type: "select", options: templates.map((t) => ({ value: str(t.id), label: str(t.key) })) })}
            ${field({ name: "subject", label: "Subject", placeholder: "Speak at DevFlow Conf 2027?" })}
            ${field({ name: "body_markdown", label: "Body (markdown)", type: "textarea", rows: 8, required: true, help: "{{recipient.first_name}}, {{event.name}} and the rest of the common set resolve per recipient." })}
            <button type="submit">Save as draft</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/campaigns/new", async (req, ctx) => {
    ctx.requireWrite("campaign.send", { event_id: null });
    const input = await readInput(req);
    const app = ctx.app();
    const audience = readAudience(input);
    const campaign = await createCampaign(app, {
      name: input.str("name"),
      channel: input.str("channel", "email") as "email" | "chat",
      template_id: input.optional("template_id"),
      subject: input.optional("subject"),
      body_markdown: input.str("body_markdown"),
      audience,
      event_id: null,
    });
    await app.flush();
    return redirect(`/admin/campaigns/${str(campaign.id)}`, 303, OK("Campaign saved as a draft."));
  });

  router.get("/admin/campaigns/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const campaign = await getCampaign(app, params.id);
    ctx.eventId = strOrNull(campaign.event_id);
    ctx.requireRead("campaign.send", { event_id: ctx.eventId });
    const canWrite = ctx.canWrite("campaign.send", { event_id: ctx.eventId });
    const audience = parseJson<AudienceCriteria>(campaign.audience, {});
    const preview = await previewAudience(app, audience);
    const stats = await campaignStats(app, params.id);
    const event = ctx.eventId ? await app.db.byId<Row>("event", ctx.eventId) : null;

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(campaign.name), event: event ? toEventRef(event) : null, active: "campaigns", width: "narrow" },
        html`${pageHead(str(campaign.name), `${badge(str(campaign.status))}`)}
          ${card(
            html`<p><strong>${preview.total}</strong> recipient(s) resolved right now — the actual send re-resolves the criteria, so this is a preview, not the final list.</p>
              <ul>${preview.sample.map((m) => html`<li>${m.name} — ${m.email}</li>`)}</ul>`,
            "Audience",
          )}
          ${str(campaign.status) === "sent" || str(campaign.status) === "partially_failed"
            ? card(
                html`<div class="stats">
                  ${stat("sent", stats.sent)} ${stat("suppressed", stats.suppressed)} ${stat("failed", stats.failed)} ${stat("queued", stats.queued)}
                </div>`,
                "Results",
              )
            : raw("")}
          ${canWrite && str(campaign.status) === "draft"
            ? html`${actionForm(`/admin/campaigns/${params.id}/send`, "Send now", { confirm: "Send to everyone matching the audience right now?" })}
                <form method="post" action="/admin/campaigns/${params.id}/schedule" class="inline-grid">
                  ${field({ name: "scheduled_for", label: "Or schedule for", type: "datetime-local", required: true })}
                  <button type="submit" class="secondary">Schedule</button>
                </form>`
            : raw("")}
          ${canWrite && str(campaign.status) === "scheduled" ? actionForm(`/admin/campaigns/${params.id}/cancel`, "Cancel", { className: "danger" }) : raw("")}
          <div class="card"><h2>Message</h2><p><strong>${strOrNull(campaign.subject) ?? "—"}</strong></p><pre>${str(campaign.body_markdown)}</pre></div>`,
      ),
    );
  });

  router.post("/admin/campaigns/:id/send", async (_req, ctx, params) => {
    const app = ctx.app();
    const campaign = await getCampaign(app, params.id);
    ctx.eventId = strOrNull(campaign.event_id);
    ctx.requireWrite("campaign.send", { event_id: ctx.eventId });
    await sendCampaignNow(app, params.id);
    await app.flush();
    return redirect(`/admin/campaigns/${params.id}`, 303, OK("Sending."));
  });

  router.post("/admin/campaigns/:id/schedule", async (req, ctx, params) => {
    const app = ctx.app();
    const campaign = await getCampaign(app, params.id);
    ctx.eventId = strOrNull(campaign.event_id);
    ctx.requireWrite("campaign.send", { event_id: ctx.eventId });
    const input = await readInput(req);
    await scheduleCampaign(app, params.id, new Date(input.str("scheduled_for")).toISOString());
    await app.flush();
    return redirect(`/admin/campaigns/${params.id}`, 303, OK("Scheduled."));
  });

  router.post("/admin/campaigns/:id/cancel", async (_req, ctx, params) => {
    const app = ctx.app();
    const campaign = await getCampaign(app, params.id);
    ctx.eventId = strOrNull(campaign.event_id);
    ctx.requireWrite("campaign.send", { event_id: ctx.eventId });
    await cancelCampaign(app, params.id);
    await app.flush();
    return redirect(`/admin/campaigns/${params.id}`, 303, OK("Cancelled."));
  });
}

/* -------------------------------------------------------------------------- */
/* Outbox — CommunicationsHistory                                             */
/* -------------------------------------------------------------------------- */

function registerOutboxRoutes(router: Router<RequestContext>): void {
  /**
   * `no_provider` is the one reason that reads as a failure and is not one:
   * the message is written and held (INV-09-12), and goes out unchanged the
   * moment an email integration is configured. Say so, rather than leaving a
   * reader to guess whether the platform lost it.
   */
  const reasonText = (reason: string | null): SafeHtml => {
    if (!reason) return html`—`;
    if (reason === "no_provider") return html`No email provider configured — held, not dropped.`;
    if (reason === "quiet_hours") return html`Deferred by the recipient's quiet hours.`;
    return html`${humanise(reason)}`;
  };

  router.get("/admin/outbox", async (_req, ctx) => {
    ctx.requireRead("communications.read");
    const app = ctx.app();
    const cursor = ctx.url.searchParams.get("cursor");
    const status = ctx.url.searchParams.get("status");
    const page = await communicationsHistory(app, { cursor, status, event_id: ctx.eventId });
    const includePii = ctx.includePii();
    const rows = page.items.map((n) => {
      const j = notificationJson(n, includePii);
      // "Did we tell them?" is only half the question — the other half is what
      // we told them. The rendered subject and body are stored before any
      // provider call (INV-09-12), so this screen can answer both without
      // anyone opening an inbox.
      return html`<tr>
        <td class="small">${formatInZone(str(n.created_at), ctx.orgTimezone)}</td>
        <td>${strOrNull(n.template_key) ?? (n.campaign_id ? "campaign" : "—")}</td>
        <td>${String(j.recipient_email ?? "")}</td>
        <td>
          ${strOrNull(n.subject) ?? html`<span class="muted">—</span>`}
          ${j.rendered_body
            ? html`<details class="small">
                <summary>Message</summary>
                <pre class="wrap">${String(j.rendered_body)}</pre>
              </details>`
            : raw("")}
        </td>
        <td>${badge(str(n.status), str(n.status) === "sent" ? "ok" : str(n.status) === "suppressed" ? "warn" : str(n.status) === "failed" ? "err" : "")}</td>
        <td class="small">${reasonText(strOrNull(n.suppressed_reason))}</td>
      </tr>`;
    });
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Outbox", active: "outbox", width: "wide" },
        html`${pageHead("Outbox", "Every message the platform has sent or tried to — the answer to 'did we tell them?'.")}
          ${table(["When", "Template / source", "To", "Subject", "Status", "Reason"], rows, "Nothing sent yet.")}
          ${page.next_cursor ? html`<p><a href="/admin/outbox?cursor=${page.next_cursor}">Older →</a></p>` : raw("")}`,
      ),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Audit log                                                                   */
/* -------------------------------------------------------------------------- */

function registerAuditRoutes(router: Router<RequestContext>): void {
  router.get("/admin/audit", async (_req, ctx) => {
    ctx.requireRead("audit.read");
    const app = ctx.app();
    const cursor = ctx.url.searchParams.get("cursor");
    const limit = 50;
    const params: unknown[] = [app.orgId];
    let sql = "SELECT * FROM audit_log WHERE org_id = ?";
    if (cursor) {
      sql += " AND id < ?";
      params.push(cursor);
    }
    sql += ` ORDER BY id DESC LIMIT ${limit + 1}`;
    const rows = await app.db.raw<Row>(sql, params);
    const items = rows.slice(0, limit);
    const rowsHtml = items.map(
      (a) => html`<tr>
        <td class="small">${formatInZone(str(a.created_at), ctx.orgTimezone)}</td>
        <td>${str(a.action)}</td>
        <td class="mono small">${str(a.entity_type)}/${str(a.entity_id)}</td>
        <td class="small">${str(a.actor_type)}${a.actor_display ? ` · ${str(a.actor_display)}` : ""}</td>
        <td class="small">${strOrNull(a.reason) ?? "—"}</td>
        <td class="small">${
          a.correlation_id
            ? html`<a class="mono" href="/admin/event-log?correlation_id=${encodeURIComponent(str(a.correlation_id))}">${str(a.correlation_id)}</a>`
            : "—"
        }</td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Audit log", active: "audit", width: "wide" },
        html`${pageHead("Audit log", "Append-only, never deleted — even erasure retains the actor id and redacts the payload.")}
          ${table(["When", "Action", "Entity", "Actor", "Reason", "Request"], rowsHtml, "Nothing recorded yet.")}
          ${rows.length > limit ? html`<p><a href="/admin/audit?cursor=${str(items[items.length - 1]?.id)}">Older →</a></p>` : raw("")}`,
      ),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Event log — domain_event_record + event_reaction_log                       */
/* -------------------------------------------------------------------------- */

/**
 * `domain_event_record` had no admin screen before this: the log itself was
 * reachable only from cron dedupe, delivery and the dev routes, so "why did
 * this speaker get that email" — the question 10-domain-events.md says the
 * log exists to answer — had no answer a person could actually reach. Gated
 * on `audit.read`, the same permission `/admin/audit` uses, because this is
 * the same kind of screen: a read-only trace of what the system did and why.
 */
function registerEventLogRoutes(router: Router<RequestContext>): void {
  router.get("/admin/event-log", async (_req, ctx) => {
    ctx.requireRead("audit.read");
    const app = ctx.app();
    const type = ctx.url.searchParams.get("type");
    const subjectId = ctx.url.searchParams.get("subject_id");
    const correlationId = ctx.url.searchParams.get("correlation_id");
    const page = await listDomainEvents(app, {
      type,
      subject_id: subjectId,
      correlation_id: correlationId,
      cursor: ctx.url.searchParams.get("cursor"),
    });
    const rowsHtml = page.items.map(
      (e) => html`<tr>
        <td class="small">${str(e.occurred_at)}</td>
        <td><a href="/admin/event-log/${str(e.id)}">${str(e.type)}</a></td>
        <td class="mono small">${str(e.subject_type)}/${str(e.subject_id)}</td>
        <td class="small">${str(e.actor_type)}${e.actor_display ? ` · ${str(e.actor_display)}` : ""}</td>
        <td class="small">${e.correlation_id ? html`<a class="mono" href="/admin/event-log?correlation_id=${encodeURIComponent(str(e.correlation_id))}">${str(e.correlation_id)}</a>` : "—"}</td>
      </tr>`,
    );
    const qs = (extra: Record<string, string>) => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (subjectId) params.set("subject_id", subjectId);
      if (correlationId) params.set("correlation_id", correlationId);
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    };
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Event log", active: "event-log", width: "wide" },
        html`${pageHead(
            "Event log",
            "Every fact the system has recorded, and what it caused — filter by type or by the id it happened to.",
          )}
          ${card(
              html`<form method="get" action="/admin/event-log" class="inline-grid">
                ${field({ name: "type", label: "Type", value: type ?? "", help: "Exact, or a `noun.*` wildcard." })}
                ${field({ name: "subject_id", label: "Subject id", value: subjectId ?? "" })}
                <button type="submit">Filter</button>
                ${type || subjectId || correlationId ? html`<a class="btn secondary" href="/admin/event-log">Clear</a>` : raw("")}
              </form>`,
            )}
          ${table(["When", "Type", "Subject", "Actor", "Request"], rowsHtml, "No events recorded yet.")}
          ${page.next_cursor ? html`<p><a href="/admin/event-log?${qs({ cursor: page.next_cursor })}">Older →</a></p>` : raw("")}`,
      ),
    );
  });

  router.get("/admin/event-log/:id", async (_req, ctx, params) => {
    ctx.requireRead("audit.read");
    const app = ctx.app();
    const row = await getDomainEventRow(app, params.id);
    if (!row) throw notFound("Domain event", params.id);
    const includePii = ctx.includePii();
    const ev = domainEventPayload(row, includePii);
    const carriesPii = PII_EVENT_TYPES.has(str(row.type) as DomainEventType);
    const reactions = await reactionStatusFor(app, str(row.id), str(row.type));
    const children = await childEventsOf(app, str(row.id));
    const parent = row.causation_id ? await getDomainEventRow(app, str(row.causation_id)) : null;

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(row.type), active: "event-log", width: "wide" },
        html`${pageHead(str(row.type), `${str(row.occurred_at)} · ${str(row.subject_type)}/${str(row.subject_id)}`)}
          ${card(
              html`<dl class="kv">
                <dt>Actor</dt><dd>${str(row.actor_type)}${row.actor_display ? ` · ${str(row.actor_display)}` : ""}</dd>
                <dt>Request</dt><dd>${row.correlation_id ? html`<a class="mono" href="/admin/event-log?correlation_id=${encodeURIComponent(str(row.correlation_id))}">${str(row.correlation_id)}</a>` : "—"}</dd>
                <dt>Caused by</dt><dd>${parent ? html`<a href="/admin/event-log/${str(parent.id)}">${str(parent.type)} · ${str(parent.id)}</a>` : "— (started this cascade)"}</dd>
              </dl>
              <pre class="mono small">${JSON.stringify(ev.data, null, 2)}</pre>
              ${!includePii && carriesPii ? html`<p class="muted small">Personal fields are hidden — this reader does not have access to them.</p>` : raw("")}`,
              "Payload",
            )}
          ${card(
              reactions.length === 0
                ? html`<p class="muted">Nothing subscribes to this event type.</p>`
                : table(
                    ["Handler", "Status"],
                    reactions.map(
                      (r) => html`<tr><td class="mono small">${r.handler}</td><td>${badge(r.ran ? "ran" : "missing", r.ran ? "ok" : "err")}</td></tr>`,
                    ),
                  ),
              "Reactions",
            )}
          ${card(
              children.length === 0
                ? html`<p class="muted">Nothing yet.</p>`
                : table(
                    ["Type", "Subject", "When"],
                    children.map(
                      (c) => html`<tr>
                        <td><a href="/admin/event-log/${str(c.id)}">${str(c.type)}</a></td>
                        <td class="mono small">${str(c.subject_type)}/${str(c.subject_id)}</td>
                        <td class="small">${str(c.occurred_at)}</td>
                      </tr>`,
                    ),
                  ),
              "What this caused",
            )}`,
      ),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Unsubscribe                                                                 */
/* -------------------------------------------------------------------------- */

function registerUnsubscribeRoutes(router: Router<RequestContext>): void {
  router.get("/unsubscribe", async (_req, ctx) => {
    const email = ctx.url.searchParams.get("email") ?? "";
    const category = ctx.url.searchParams.get("category") ?? "campaign";
    const sig = ctx.url.searchParams.get("sig") ?? "";
    const ok = email && (await verifyUnsubscribeSignature(ctx.env, email, category, sig));
    if (!ok) {
      return htmlResponse(
        adminPage(ctx, { title: "Unsubscribe", width: "narrow" }, html`<div class="card"><p>That link is not valid.</p></div>`),
        { status: 400 },
      );
    }
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Unsubscribe", width: "narrow" },
        html`<div class="card">
          <p>Stop marketing messages to <strong>${email}</strong>?</p>
          <p class="muted small">This never affects a message about your own proposal, session or task — those keep coming regardless.</p>
          <form method="post" action="/unsubscribe">
            <input type="hidden" name="email" value="${email}"><input type="hidden" name="category" value="${category}"><input type="hidden" name="sig" value="${sig}">
            <button type="submit">Unsubscribe</button>
          </form>
        </div>`,
      ),
    );
  });

  router.post("/unsubscribe", async (req, ctx) => {
    const input = await readInput(req);
    // RFC 8058 one-click unsubscribe: a mail client's own "Unsubscribe"
    // button POSTs a body of exactly `List-Unsubscribe=One-Click` and no
    // other field, so email/category/sig travel in the URL query string on
    // that path — the same signed link the header carries (`unsubscribeUrl`).
    // The human confirm-page form still posts all three as hidden body
    // fields, which is why the body is checked first and the query string is
    // only the fallback.
    const email = input.optional("email") ?? ctx.url.searchParams.get("email") ?? "";
    const category = input.optional("category") ?? ctx.url.searchParams.get("category") ?? "campaign";
    const sig = input.optional("sig") ?? ctx.url.searchParams.get("sig") ?? "";
    const isOneClick = input.str("List-Unsubscribe") === "One-Click";
    const ok = email && (await verifyUnsubscribeSignature(ctx.env, email, category, sig));
    if (!ok) {
      return isOneClick ? new Response(null, { status: 400 }) : htmlResponse(html`<p>That link is not valid.</p>`, { status: 400 });
    }
    const app = ctx.app();
    await recordSuppression(app, email, category, "unsubscribed");
    await app.flush();
    // A one-click request is deliberately unconfirmed — that is RFC 8058's
    // whole point, a mail client acts with no page load — and it does not
    // reopen the no-mutation-on-GET rule this route otherwise relies on
    // (see the `setCookie` comment in http/context.ts): the signature is
    // still the only credential either way, GET still never mutates, and a
    // link scanner or prefetcher cannot reach this path because it never
    // issues a POST. Do not "fix" this back to a confirmation step.
    if (isOneClick) return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
    return htmlResponse(
      adminPage(ctx, { title: "Unsubscribed", width: "narrow" }, html`<div class="card"><p>You will not receive marketing messages of this kind again.</p></div>`),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Inbound provider callbacks                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where an email provider posts delivery events — 09, `email`:
 * `handle_inbound_webhook(payload) -> DeliveryStatusUpdate[]`. Without this
 * route the method had no caller, so a `NotificationDelivery` never moved past
 * `sent` and a hard bounce never reached the suppression list.
 *
 * Deliberately unauthenticated in the session/API-key sense — the caller is
 * SendGrid, not a person. The signed URL is the credential (INV-09-15); see
 * `inboundWebhookUrl`.
 */
function registerInboundWebhookRoutes(router: Router<RequestContext>): void {
  router.post("/integrations/:id/inbound", async (req, ctx, params) => {
    const sig = ctx.url.searchParams.get("sig") ?? "";
    if (!(await verifyInboundWebhookSignature(ctx.env, params.id, sig))) {
      // Same body whether the signature is wrong or the integration does not
      // exist, so this cannot be used to enumerate installed integrations.
      return json({ error: "invalid_signature" }, { status: 401 });
    }
    const app = ctx.app();
    const integration = await app.db.byId<Row>("integration", params.id);
    if (!integration) return json({ error: "invalid_signature" }, { status: 401 });

    // INV-09-11: a disabled integration stops accepting callbacks immediately.
    const resolved = await resolvePluginForIntegration(app, integration);
    if (!resolved) return json({ error: "integration_unavailable" }, { status: 409 });

    // Dispatched on the installed integration's capability, not on the shape of
    // the payload: two providers can post the same JSON and mean different
    // things, and the URL already names the one installation this concerns.
    const capability = resolved.plugin.capability;
    if (capability !== "email" && capability !== "sync") {
      return json({ error: "capability_has_no_inbound" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid_payload" }, { status: 400 });
    }

    if (capability === "sync") {
      // A ping, not a payload (09). Airtable's automation webhook carries no
      // signature we could verify uniformly and no ordering guarantee, so the
      // only safe reading of it is "something changed, go and look" — and the
      // cron sweep runs regardless, so a ping that never arrives costs latency
      // rather than correctness.
      const hint = (await resolved.plugin.handle_inbound_webhook?.(payload, resolved.ctx)) ?? { external_table_ids: null };
      const wanted = hint.external_table_ids;
      let scheduled = 0;
      for (const mapping of await activeMappings(app, params.id)) {
        if (wanted && !wanted.includes(str(mapping.external_table_id))) continue;
        if (writableFields(str(mapping.subject)).length === 0) continue; // push-only (INV-09-23)
        await schedulePull(ctx.env, app.orgId, str(mapping.id), "inbound");
        scheduled++;
      }
      return json({ received: scheduled });
    }

    const updates = await resolved.plugin.handle_inbound_webhook(payload, resolved.ctx);
    await applyDeliveryStatusUpdates(app, updates);
    await app.flush();
    // `received`, not `applied`: INV-09-16 means a replay of an event already
    // recorded changes nothing, and the provider only needs the 2xx anyway.
    return json({ received: updates.length });
  });
}

/* -------------------------------------------------------------------------- */
/* Management API                                                              */
/* -------------------------------------------------------------------------- */

function registerManagementApi(router: Router<RequestContext>): void {
  // ApiKey
  router.get("/v1/api-keys", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    return json((await listApiKeys(ctx.app())).map(apiKeyJson));
  });
  router.post("/v1/api-keys", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    refuseApiKeyActor(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const { row, secret } = await createApiKey(app, {
      name: input.str("name"),
      scopes: input.list("scopes") as ApiScope[],
      event_ids: input.list("event_ids"),
      expires_at: input.optional("expires_at"),
    });
    await app.flush();
    return json({ ...apiKeyJson(row), secret }, { status: 201 });
  });
  router.post("/v1/api-keys/:id/revoke", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    refuseApiKeyActor(ctx);
    const app = ctx.app();
    await revokeApiKey(app, params.id);
    await app.flush();
    return json(apiKeyJson(await getApiKey(app, params.id)));
  });
  router.post("/v1/api-keys/:id/rotate", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    refuseApiKeyActor(ctx);
    const app = ctx.app();
    const { row, secret } = await rotateApiKey(app, params.id);
    await app.flush();
    return json({ ...apiKeyJson(row), secret });
  });

  // Webhook
  router.get("/v1/webhooks", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    return json((await listWebhooks(ctx.app())).map(webhookJson));
  });
  router.post("/v1/webhooks", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const { row, secret } = await createWebhook(app, {
      name: input.str("name"),
      url: input.str("url"),
      event_types: input.json<string[]>("event_types", ["*"]),
      event_id: input.optional("event_id"),
      include_pii: input.bool("include_pii"),
    });
    await app.flush();
    return json({ ...webhookJson(row), secret }, { status: 201 });
  });
  router.get("/v1/webhooks/:id", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    return json(webhookJson(await getWebhook(ctx.app(), params.id)));
  });
  router.post("/v1/webhooks/:id", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    await updateWebhook(app, params.id, {
      name: input.has("name") ? input.str("name") : undefined,
      url: input.has("url") ? input.str("url") : undefined,
      event_types: input.has("event_types") ? input.json<string[]>("event_types", []) : undefined,
      include_pii: input.has("include_pii") ? input.bool("include_pii") : undefined,
    });
    await app.flush();
    return json(webhookJson(await getWebhook(app, params.id)));
  });
  router.post("/v1/webhooks/:id/rotate-secret", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const { secret } = await rotateWebhookSecret(app, params.id);
    await app.flush();
    return json({ ...webhookJson(await getWebhook(app, params.id)), secret });
  });
  router.get("/v1/webhooks/:id/deliveries", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const page = await listWebhookDeliveries(app, params.id, { cursor: ctx.url.searchParams.get("cursor"), limit: Number(ctx.url.searchParams.get("limit") ?? 50) });
    return json({ items: page.items.map(webhookDeliveryJson), next_cursor: page.next_cursor });
  });
  router.post("/v1/webhooks/:id/deliveries/:deliveryId/redeliver", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const id = await redeliverWebhookDelivery(app, params.deliveryId);
    await app.flush();
    return json(webhookDeliveryJson(await getWebhookDelivery(app, id)), { status: 201 });
  });
  router.post("/v1/webhooks/:id/replay", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const count = await replayEventType(app, params.id, input.str("event_type", "*"), input.str("from"), input.str("to"));
    await app.flush();
    return json({ replayed: count });
  });

  // Integration
  router.get("/v1/integrations", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    return json((await listIntegrations(ctx.app())).map(integrationJson));
  });
  router.post("/v1/integrations", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const row = await installIntegration(app, {
      plugin_key: input.str("plugin_key"),
      event_id: input.optional("event_id"),
      display_name: input.optional("display_name"),
      config: input.json<Record<string, unknown>>("config", {}),
      secret_ref: input.optional("secret_ref"),
      is_default_for_capability: input.bool("is_default_for_capability"),
    });
    await app.flush();
    return json(integrationJson(row), { status: 201 });
  });
  router.post("/v1/integrations/:id", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    await updateIntegration(app, params.id, {
      display_name: input.optional("display_name") ?? undefined,
      config: input.has("config") ? input.json<Record<string, unknown>>("config", {}) : undefined,
      secret_ref: input.has("secret_ref") ? input.optional("secret_ref") : undefined,
      is_default_for_capability: input.has("is_default_for_capability") ? input.bool("is_default_for_capability") : undefined,
      status: input.has("status") ? (input.str("status") as "active" | "disabled") : undefined,
    });
    await app.flush();
    return json(integrationJson(await getIntegration(app, params.id)));
  });
  router.post("/v1/integrations/:id/health-check", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const result = await healthCheckIntegration(app, params.id);
    await app.flush();
    return json(result);
  });

  // Notifications (read-only management surface over the outbox)
  router.get("/v1/notifications", async (_req, ctx) => {
    ctx.requireRead("communications.read");
    const app = ctx.app();
    const page = await communicationsHistory(app, {
      event_id: ctx.url.searchParams.get("event_id"),
      person_id: ctx.url.searchParams.get("person_id"),
      session_id: ctx.url.searchParams.get("session_id"),
      campaign_id: ctx.url.searchParams.get("campaign_id"),
      status: ctx.url.searchParams.get("status"),
      cursor: ctx.url.searchParams.get("cursor"),
    });
    const includePii = ctx.includePii();
    return json({ items: page.items.map((n) => notificationJson(n, includePii)), next_cursor: page.next_cursor });
  });

  // Campaign
  router.get("/v1/campaigns", async (_req, ctx) => {
    ctx.requireRead("campaign.send", { event_id: ctx.url.searchParams.get("event_id") });
    const app = ctx.app();
    const rows = await listCampaigns(app, ctx.url.searchParams.get("event_id"));
    const out = [];
    for (const r of rows) out.push(campaignJson(r, await campaignStats(app, str(r.id)), (await previewAudience(app, parseJson(r.audience, {}))).total));
    return json(out);
  });
  router.post("/v1/campaigns", async (req, ctx) => {
    const input = await readInput(req);
    const eventId = input.optional("event_id");
    ctx.requireWrite("campaign.send", { event_id: eventId });
    const app = ctx.app(eventId);
    const row = await createCampaign(app, {
      name: input.str("name"),
      channel: input.str("channel", "email") as "email" | "chat",
      template_id: input.optional("template_id"),
      subject: input.optional("subject"),
      body_markdown: input.str("body_markdown"),
      audience: input.json<AudienceCriteria>("audience", {}),
      event_id: eventId,
    });
    await app.flush();
    return json(campaignJson(row, await campaignStats(app, str(row.id)), (await previewAudience(app, parseJson(row.audience, {}))).total), { status: 201 });
  });
  router.get("/v1/campaigns/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const row = await getCampaign(app, params.id);
    ctx.requireRead("campaign.send", { event_id: strOrNull(row.event_id) });
    return json(campaignJson(row, await campaignStats(app, params.id), (await previewAudience(app, parseJson(row.audience, {}))).total));
  });
  router.post("/v1/campaigns/:id", async (req, ctx, params) => {
    const app = ctx.app();
    const row = await getCampaign(app, params.id);
    ctx.requireWrite("campaign.send", { event_id: strOrNull(row.event_id) });
    const input = await readInput(req);
    await updateCampaign(app, params.id, {
      name: input.has("name") ? input.str("name") : undefined,
      subject: input.has("subject") ? input.optional("subject") : undefined,
      body_markdown: input.has("body_markdown") ? input.str("body_markdown") : undefined,
      template_id: input.has("template_id") ? input.optional("template_id") : undefined,
      audience: input.has("audience") ? input.json<AudienceCriteria>("audience", {}) : undefined,
    });
    await app.flush();
    return json(campaignJson(await getCampaign(app, params.id), await campaignStats(app, params.id), 0));
  });
  router.get("/v1/campaigns/:id/preview-audience", async (_req, ctx, params) => {
    const app = ctx.app();
    const row = await getCampaign(app, params.id);
    ctx.requireRead("campaign.send", { event_id: strOrNull(row.event_id) });
    const preview = await previewAudience(app, parseJson(row.audience, {}));
    return json(preview);
  });
  router.post("/v1/campaigns/:id/schedule", async (req, ctx, params) => {
    const app = ctx.app();
    const row = await getCampaign(app, params.id);
    ctx.requireWrite("campaign.send", { event_id: strOrNull(row.event_id) });
    const input = await readInput(req);
    await scheduleCampaign(app, params.id, input.str("scheduled_for"));
    await app.flush();
    return json(campaignJson(await getCampaign(app, params.id), await campaignStats(app, params.id), 0));
  });
  router.post("/v1/campaigns/:id/send", async (_req, ctx, params) => {
    const app = ctx.app();
    const row = await getCampaign(app, params.id);
    ctx.requireWrite("campaign.send", { event_id: strOrNull(row.event_id) });
    await sendCampaignNow(app, params.id);
    await app.flush();
    return json(campaignJson(await getCampaign(app, params.id), await campaignStats(app, params.id), 0));
  });
  router.post("/v1/campaigns/:id/cancel", async (_req, ctx, params) => {
    const app = ctx.app();
    const row = await getCampaign(app, params.id);
    ctx.requireWrite("campaign.send", { event_id: strOrNull(row.event_id) });
    await cancelCampaign(app, params.id);
    await app.flush();
    return json(campaignJson(await getCampaign(app, params.id), await campaignStats(app, params.id), 0));
  });
}

export { currentEventRef, CAPABILITIES, CAMPAIGN_STATUSES };
