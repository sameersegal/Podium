import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { installIntegration } from "@podiumstack/web/contexts/platform/service.js";
import { inboundWebhookUrl, writeNotification } from "@podiumstack/web/contexts/platform/notifications.js";

/**
 * 09, `email`: `handle_inbound_webhook(payload) -> DeliveryStatusUpdate[]`.
 *
 * The contract was implemented on every email plugin and called from nowhere,
 * so a `NotificationDelivery` never moved past `sent` and the "hard bounces and
 * complaints are suppressed globally" rule had no way to fire. These cover the
 * route that closes that loop.
 *
 * INV-09-15 — the callback carries no session and no API key, so the signed URL
 * is what authenticates it.
 */

const ORG = "org_inbound_test";
const EVENT = "evt_inbound_test";
const PERSON = "per_inbound_test";
const now = () => new Date().toISOString();

/** `resolveOrg` takes the earliest-created organization, so this one must sort first. */
const EPOCH = "2000-01-01T00:00:00.000Z";

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Inbound Test Org", "inbound-test-org", "UTC", "test@example.com", "{}", EPOCH, EPOCH)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "Inbound Test Conf", "inbound-test-conf", "UTC", "2028-08-01", "2028-08-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(PERSON, ORG, "bouncer@example.com", "Bounce E. Person", "active", 0, now(), now())
    .run();
}

function appFor() {
  return new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
}

/** A `sent` delivery with a known provider message id for a callback to land on. */
async function sentDelivery(providerMessageId: string, email = "bouncer@example.com"): Promise<string> {
  const app = appFor();
  const id = await writeNotification(app, {
    recipient_person_id: PERSON,
    recipient_email: email,
    channel: "email",
    subject_type: "proposal",
    subject_id: "prp_inbound_test",
    subject: "A message that will bounce",
    rendered_body: "Body.",
    transactional: true,
    template_key: "proposal.submitted",
  });
  await app.flush();
  await env.DB.prepare("UPDATE notification_delivery SET status = 'sent', provider_message_id = ?, sent_at = ? WHERE id = ?")
    .bind(providerMessageId, now(), id)
    .run();
  return id;
}

function sendgridEvent(email: string, event: string, messageId: string, extra: Record<string, unknown> = {}) {
  return [{ email, event, sg_message_id: messageId, timestamp: Math.floor(Date.parse(now()) / 1000), ...extra }];
}

async function post(url: string, body: unknown): Promise<Response> {
  return SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("inbound provider callbacks (09, email: handle_inbound_webhook)", () => {
  let integrationId = "";
  let url = "";

  beforeAll(async () => {
    await seed();
    const app = appFor();
    const row = await installIntegration(app, {
      plugin_key: "email.sendgrid",
      config: { from_email: "hello@example.com" },
      secret_ref: "SENDGRID_API_KEY",
      is_default_for_capability: true,
    });
    await app.flush();
    integrationId = String(row.id);
    url = await inboundWebhookUrl(env, integrationId);
  });

  it("INV-09-15: refuses a callback whose signature does not verify", async () => {
    const res = await post(`http://localhost/integrations/${integrationId}/inbound?sig=deadbeef`, sendgridEvent("bouncer@example.com", "delivered", "msg_sig"));
    expect(res.status).toBe(401);
  });

  it("INV-09-15: refuses a callback carrying no signature at all", async () => {
    const res = await post(`http://localhost/integrations/${integrationId}/inbound`, sendgridEvent("bouncer@example.com", "delivered", "msg_nosig"));
    expect(res.status).toBe(401);
  });

  it("answers an unknown integration exactly as it answers a bad signature, so installs cannot be enumerated", async () => {
    const unknown = await post("http://localhost/integrations/itg_does_not_exist/inbound?sig=deadbeef", []);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "invalid_signature" });
  });

  it("moves a delivery to delivered on a signed callback", async () => {
    const id = await sentDelivery("msg_delivered");
    const res = await post(url, sendgridEvent("bouncer@example.com", "delivered", "msg_delivered"));
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, delivered_at FROM notification_delivery WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row?.status).toBe("delivered");
    expect(row?.delivered_at).toBeTruthy();
  });

  it("puts a hard bounce on the global suppression list (09, 'Suppression')", async () => {
    const id = await sentDelivery("msg_hard", "hard-bounce@example.com");
    const res = await post(url, sendgridEvent("hard-bounce@example.com", "bounce", "msg_hard", { type: "bounce", reason: "550 no such mailbox" }));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT status, error FROM notification_delivery WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row?.status).toBe("bounced");
    expect(String(row?.error)).toContain("550");

    const suppression = await env.DB.prepare("SELECT reason FROM notification_suppression WHERE org_id = ? AND email = ?")
      .bind(ORG, "hard-bounce@example.com")
      .first<Record<string, unknown>>();
    expect(suppression?.reason).toBe("hard_bounce");
  });

  it("leaves a soft bounce off the suppression list", async () => {
    await sentDelivery("msg_soft", "soft-bounce@example.com");
    // SendGrid spells a soft bounce `type: "blocked"`.
    await post(url, sendgridEvent("soft-bounce@example.com", "bounce", "msg_soft", { type: "blocked", reason: "mailbox full" }));
    const suppression = await env.DB.prepare("SELECT reason FROM notification_suppression WHERE org_id = ? AND email = ?")
      .bind(ORG, "soft-bounce@example.com")
      .first<Record<string, unknown>>();
    expect(suppression).toBeNull();
  });

  it("INV-09-16: a replayed bounce emits notification.bounced once, under at-least-once redelivery", async () => {
    const id = await sentDelivery("msg_replay", "replay@example.com");
    const payload = sendgridEvent("replay@example.com", "bounce", "msg_replay", { type: "bounce", reason: "550 gone" });
    await post(url, payload);
    await post(url, payload);
    await post(url, payload);

    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'notification.bounced' AND json_extract(data, '$.notification_id') = ?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
    expect(Number(events?.n)).toBe(1);
  });

  it("INV-09-16: a late `delivered` does not erase a recorded bounce", async () => {
    const id = await sentDelivery("msg_unordered", "unordered@example.com");
    await post(url, sendgridEvent("unordered@example.com", "bounce", "msg_unordered", { type: "bounce", reason: "550 gone" }));
    await post(url, sendgridEvent("unordered@example.com", "delivered", "msg_unordered"));

    const row = await env.DB.prepare("SELECT status FROM notification_delivery WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row?.status).toBe("bounced");
  });

  it("INV-09-11: a disabled integration stops accepting callbacks immediately", async () => {
    await env.DB.prepare("UPDATE integration SET status = 'disabled' WHERE id = ?").bind(integrationId).run();
    const res = await post(url, sendgridEvent("bouncer@example.com", "delivered", "msg_disabled"));
    expect(res.status).toBe(409);
    await env.DB.prepare("UPDATE integration SET status = 'active' WHERE id = ?").bind(integrationId).run();
  });
});
