import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import { queueNotification } from "@podiumconf/web/contexts/platform/notifications.js";
import { sendgridSigner, type SendgridSigner } from "../../helpers/sendgrid-signature.js";

/**
 * INV-09-16 — the inbound provider callback, end to end over the real route.
 *
 * This is the return path for `email`. Without it a `NotificationDelivery`
 * never leaves `sent` and the global suppression list (09, "Suppression is
 * global per email address") can never be filled by a bounce, so the platform
 * keeps mailing an address that hard-bounced forever.
 *
 * The route is unauthenticated by necessity — SendGrid holds no session and no
 * API key — so the signature is the whole of the authentication, and the
 * rejection cases below matter as much as the accepting one.
 */

const ORG = "org_hook_test";
const EVENT = "evt_hook_test";
const PERSON = "per_hook_test";
const INTEGRATION = "itg_hook_test";
const DISABLED_INTEGRATION = "itg_hook_disabled";
const BOUNCER = "bouncer@example.com";
const now = () => new Date().toISOString();

let signer: SendgridSigner;

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Hook Test Org", "hook-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "Hook Test Conf", "hook-test-conf", "UTC", "2028-06-01", "2028-06-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(PERSON, ORG, BOUNCER, "Bo Uncer", "active", 0, now(), now())
    .run();

  signer = await sendgridSigner();
  // The verification key is a *public* key, so it is ordinary config and not a
  // `secret_ref` — INV-09-3 governs credentials, and this is not one.
  const config = JSON.stringify({ from_email: "cfp@example.com", event_webhook_public_key: signer.publicKeyBase64 });
  for (const [id, status] of [
    [INTEGRATION, "active"],
    [DISABLED_INTEGRATION, "disabled"],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO integration (id, org_id, event_id, plugin_key, capability, display_name, config, secret_ref, webhook_secret_ref, is_default_for_capability, status, created_at, row_version) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(id, ORG, null, "email.sendgrid", "email", "SendGrid", config, "SENDGRID_API_KEY", "", id === INTEGRATION ? 1 : 0, status, now(), 1)
      .run();
  }
}

/** A `NotificationDelivery` in the state a successful `send` leaves it in. */
async function sentDelivery(providerMessageId: string): Promise<string> {
  const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
  const id = await queueNotification(app, {
    template_key: "proposal.submitted",
    recipient_person_id: PERSON,
    subject_type: "proposal",
    // Distinct per delivery: these tests each need their own row, and
    // `queueNotification` is idempotent per (template, subject, recipient).
    subject_id: `prp_hook_${providerMessageId}`,
    variables: {
      "proposal.title": "A talk that bounces",
      "proposal.reference": "HK-0001",
      "proposal.url": "https://example.com",
      "cfp.name": "Main CFP",
      "cfp.closes_at": "2028-05-01",
    },
  });
  await app.flush();
  if (!id) throw new Error("expected queueNotification to write a delivery");
  await env.DB.prepare("UPDATE notification_delivery SET status = 'sent', provider_message_id = ?, sent_at = ? WHERE id = ?")
    .bind(providerMessageId, now(), id)
    .run();
  return id;
}

/** Posts as SendGrid would: the signature covers `timestamp + the exact body`. */
async function postCallback(
  events: unknown[],
  opts: { integrationId?: string; signed?: boolean; timestampOffsetSeconds?: number } = {},
): Promise<Response> {
  const body = JSON.stringify(events);
  const timestamp = String(Math.floor(Date.now() / 1000) + (opts.timestampOffsetSeconds ?? 0));
  const signature = opts.signed === false ? "MEUCIQD0000000000000000000000000000000000000000000000000000" : await signer.sign(timestamp + body);
  return SELF.fetch(`http://localhost:8787/hooks/email/${opts.integrationId ?? INTEGRATION}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-twilio-email-event-webhook-signature": signature,
      "x-twilio-email-event-webhook-timestamp": timestamp,
    },
    body,
  });
}

const deliveryRow = (id: string) =>
  env.DB.prepare("SELECT * FROM notification_delivery WHERE id = ?").bind(id).first<Record<string, unknown>>();

const suppressionRow = (email: string) =>
  env.DB.prepare("SELECT * FROM notification_suppression WHERE org_id = ? AND email = ?").bind(ORG, email).first<Record<string, unknown>>();

const bounceEvents = (notificationId: string) =>
  env.DB.prepare("SELECT * FROM domain_event_record WHERE type = 'notification.bounced' AND subject_id = ?").bind(notificationId).all();

describe("inbound email provider callbacks (INV-09-16)", () => {
  beforeAll(seed);

  it("applies a verified hard bounce: the delivery is marked bounced and the address joins the global suppression list", async () => {
    const notificationId = await sentDelivery("msgHard1");

    const res = await postCallback([
      { event: "bounce", type: "bounce", email: BOUNCER, sg_message_id: "msgHard1.filterdrecv-7c9-1-ABC", timestamp: Math.floor(Date.now() / 1000), reason: "550 unknown recipient" },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1 });

    const row = await deliveryRow(notificationId);
    expect(row?.status).toBe("bounced");
    expect(String(row?.error)).toContain("550");

    // 09, "Suppression": a hard bounce is global, not per-category.
    const suppression = await suppressionRow(BOUNCER);
    expect(suppression?.category).toBe("all");
    expect(suppression?.reason).toBe("hard_bounce");
  });

  it("emits notification.bounced once, and a redelivered identical callback emits no second one", async () => {
    const notificationId = await sentDelivery("msgDup1");
    const event = {
      event: "bounce",
      type: "bounce",
      email: "dup@example.com",
      sg_message_id: "msgDup1.filterdrecv-1-XYZ",
      timestamp: Math.floor(Date.now() / 1000),
    };

    expect((await postCallback([event])).status).toBe(200);
    const first = await bounceEvents(notificationId);
    expect(first.results).toHaveLength(1);

    // At-least-once is the provider's contract, so the same callback arriving
    // twice must be a no-op the second time rather than a second bounce.
    expect((await postCallback([event])).status).toBe(200);
    const second = await bounceEvents(notificationId);
    expect(second.results).toHaveLength(1);
    expect((await deliveryRow(notificationId))?.status).toBe("bounced");
  });

  it("does not put a soft bounce on the global list — only a hard one costs the address its mail", async () => {
    const notificationId = await sentDelivery("msgSoft1");
    const res = await postCallback([
      { event: "bounce", type: "blocked", email: "soft@example.com", sg_message_id: "msgSoft1.filterdrecv-2", timestamp: Math.floor(Date.now() / 1000) },
    ]);
    expect(res.status).toBe(200);
    expect((await deliveryRow(notificationId))?.status).toBe("bounced");
    expect(await suppressionRow("soft@example.com")).toBeNull();
  });

  it("advances a delivery to delivered, which is a state nothing else in the system can reach", async () => {
    const notificationId = await sentDelivery("msgDeliv1");
    const res = await postCallback([
      { event: "delivered", email: "ok@example.com", sg_message_id: "msgDeliv1.filterdrecv-3", timestamp: Math.floor(Date.now() / 1000) },
    ]);
    expect(res.status).toBe(200);
    const row = await deliveryRow(notificationId);
    expect(row?.status).toBe("delivered");
    expect(row?.delivered_at).toBeTruthy();
  });

  it("does not let a late `delivered` resurrect an already-bounced delivery", async () => {
    const notificationId = await sentDelivery("msgOrder1");
    await postCallback([
      { event: "bounce", type: "bounce", email: "order@example.com", sg_message_id: "msgOrder1.filterdrecv-4", timestamp: Math.floor(Date.now() / 1000) },
    ]);
    expect((await deliveryRow(notificationId))?.status).toBe("bounced");

    await postCallback([{ event: "delivered", email: "order@example.com", sg_message_id: "msgOrder1.filterdrecv-4", timestamp: Math.floor(Date.now() / 1000) }]);
    expect((await deliveryRow(notificationId))?.status).toBe("bounced");
  });

  /* ---------------------------------------------------------------------- */
  /* The rejections — this route's only authentication                      */
  /* ---------------------------------------------------------------------- */

  it("rejects an unsigned callback and changes nothing: no status, no suppression", async () => {
    const notificationId = await sentDelivery("msgForged1");
    const res = await postCallback(
      [{ event: "bounce", type: "bounce", email: "forged@example.com", sg_message_id: "msgForged1.filterdrecv-5", timestamp: Math.floor(Date.now() / 1000) }],
      { signed: false },
    );
    expect(res.status).toBe(401);
    expect((await deliveryRow(notificationId))?.status).toBe("sent");
    // The whole point: a stranger must not be able to suppress an address.
    expect(await suppressionRow("forged@example.com")).toBeNull();
  });

  it("rejects a correctly signed but stale callback, so a captured one cannot be replayed later", async () => {
    const notificationId = await sentDelivery("msgStale1");
    const res = await postCallback(
      [{ event: "bounce", type: "bounce", email: "stale@example.com", sg_message_id: "msgStale1.filterdrecv-6", timestamp: Math.floor(Date.now() / 1000) }],
      { timestampOffsetSeconds: -3600 },
    );
    expect(res.status).toBe(401);
    expect((await deliveryRow(notificationId))?.status).toBe("sent");
    expect(await suppressionRow("stale@example.com")).toBeNull();
  });

  it("refuses a callback for a disabled integration — disabling takes effect immediately (INV-09-11)", async () => {
    const notificationId = await sentDelivery("msgDisabled1");
    const res = await postCallback(
      [{ event: "bounce", type: "bounce", email: "disabled@example.com", sg_message_id: "msgDisabled1.filterdrecv-8", timestamp: Math.floor(Date.now() / 1000) }],
      { integrationId: DISABLED_INTEGRATION },
    );
    expect(res.status).toBe(404);
    expect((await deliveryRow(notificationId))?.status).toBe("sent");
    expect(await suppressionRow("disabled@example.com")).toBeNull();
  });

  it("answers an unknown integration id the same way as a disabled one, so ids cannot be probed apart", async () => {
    const res = await postCallback([{ event: "bounce", email: "nobody@example.com" }], { integrationId: "itg_does_not_exist" });
    expect(res.status).toBe(404);
  });

  it("suppresses on a bounce whose message id matches nothing, because the address is what matters", async () => {
    const res = await postCallback([
      { event: "spamreport", email: "complainer@example.com", sg_message_id: "msgUnknown.filterdrecv-9", timestamp: Math.floor(Date.now() / 1000) },
    ]);
    expect(res.status).toBe(200);
    const suppression = await suppressionRow("complainer@example.com");
    expect(suppression?.reason).toBe("complaint");
  });
});
