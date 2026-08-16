import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR, buildEvent } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";
import { createWebhook } from "@podiumstack/web/contexts/platform/service.js";
import { deliverWebhook } from "@podiumstack/web/contexts/platform/delivery.js";
import { verifySignature } from "@podiumstack/domain/platform/webhooks.js";

/**
 * "`PLATFORM_REACTIONS` includes a `*` reaction fanning every domain event out
 * to matching webhooks by enqueuing a delivery" (the task brief), and
 * INV-09-8: consumers are told delivery is at-least-once — every reaction
 * (including this fan-out) is idempotent on `DomainEvent.id`.
 */

const ORG = "org_webhook_test";
const now = () => new Date().toISOString();

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Webhook Test Org", "webhook-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("per_webhook_owner", "owner@example.com", "Web Hooker", "active", 0, now(), now())
    .run();
}

function appFor() {
  return new AppContext({ env, orgId: ORG, actor: { type: "person", id: "per_webhook_owner", display_name: "Web Hooker" } });
}

describe("webhook fan-out and delivery", () => {
  beforeAll(seed);
  afterEach(() => vi.unstubAllGlobals());

  it("the `*` reaction schedules exactly one delivery per matching webhook, and is idempotent on DomainEvent.id", async () => {
    const app = appFor();
    const { row: webhook } = await createWebhook(app, { name: "Everything", url: "https://receiver.example.com/hooks", event_types: ["*"] });
    const { row: scoped } = await createWebhook(app, { name: "Proposals only", url: "https://receiver.example.com/proposals", event_types: ["proposal.*"] });
    const { row: irrelevant } = await createWebhook(app, { name: "Tasks only", url: "https://receiver.example.com/tasks", event_types: ["task_instance.*"] });
    await app.flush();

    const ev = buildEvent(
      { type: "proposal.submitted", subject: { type: "proposal", id: "prp_webhook_test" }, data: { proposal_id: "prp_webhook_test" } },
      { org_id: ORG, actor: SYSTEM_ACTOR, correlation_id: "req_webhook_test" },
    );

    const first = await deliverEvent(env, ev);
    expect(first).toContain("platform.webhook_fanout");
    // Redelivery of the same DomainEvent.id: the dispatcher's own guard makes
    // this a no-op before the reaction body runs a second time.
    const second = await deliverEvent(env, ev);
    expect(second).toEqual([]);

    const everythingDeliveries = await env.DB.prepare("SELECT * FROM webhook_delivery WHERE webhook_id = ?").bind(webhook.id).all();
    expect(everythingDeliveries.results).toHaveLength(1);
    const scopedDeliveries = await env.DB.prepare("SELECT * FROM webhook_delivery WHERE webhook_id = ?").bind(scoped.id).all();
    expect(scopedDeliveries.results).toHaveLength(1);
    const irrelevantDeliveries = await env.DB.prepare("SELECT * FROM webhook_delivery WHERE webhook_id = ?").bind(irrelevant.id).all();
    expect(irrelevantDeliveries.results).toHaveLength(0);
  });

  it("signs the request as X-Signature: t=<unix>,v1=<hmac>, carries X-Event-Id, and marks the delivery `delivered` on 2xx (INV-09-8)", async () => {
    const app = appFor();
    const { row: webhook, secret } = await createWebhook(app, { name: "Signed", url: "https://receiver.example.com/signed", event_types: ["*"] });
    await app.flush();

    let seenHeaders: Headers | null = null;
    let seenBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      seenHeaders = new Headers(init.headers as HeadersInit);
      seenBody = String(init.body);
      return new Response("ok", { status: 200 });
    }));

    const ev = buildEvent(
      { type: "webhook.created", subject: { type: "webhook", id: String(webhook.id) }, data: { webhook_id: String(webhook.id), url: "https://x", event_types: ["*"] } },
      { org_id: ORG, actor: SYSTEM_ACTOR },
    );
    await env.DB.prepare(
      "INSERT INTO domain_event_record (id, type, version, occurred_at, org_id, actor_type, actor_id, actor_display, subject_type, subject_id, data, correlation_id, causation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(ev.id, ev.type, ev.version, ev.occurred_at, ev.org_id, ev.actor.type, ev.actor.id, ev.actor.display_name, ev.subject.type, ev.subject.id, JSON.stringify(ev.data), ev.correlation_id, ev.causation_id)
      .run();
    const deliveryId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO webhook_delivery (id, webhook_id, domain_event_id, attempt, status, scheduled_for) VALUES (?,?,?,?,?,?)")
      .bind(deliveryId, webhook.id, ev.id, 1, "pending", now())
      .run();

    await deliverWebhook(env, { kind: "webhook", delivery_id: deliveryId, webhook_id: String(webhook.id), event_id: ev.id });

    expect(seenHeaders).not.toBeNull();
    expect(seenHeaders!.get("x-event-id")).toBe(ev.id);
    const sig = seenHeaders!.get("x-signature") ?? "";
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(seenBody).toContain(ev.id === "" ? "" : "webhook.created");

    const delivery = await env.DB.prepare("SELECT * FROM webhook_delivery WHERE id = ?").bind(deliveryId).first<Record<string, unknown>>();
    expect(delivery?.status).toBe("delivered");
    expect(delivery?.response_status).toBe(200);

    // The signature verifies against the secret shown once at creation.
    expect(await verifySignature(sig, secret, seenBody, Date.now())).toBe(true);
  });

  it("INV-09-2: refuses to deliver to a private address at delivery time, even if it slipped past save-time validation", async () => {
    // Written directly to bypass `assertDeliverableUrl` at save time, the way
    // a DNS rebind could after the fact.
    const webhookId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO webhook (id, name, url, event_types, secret, include_pii, status, consecutive_failures, created_by_person_id, created_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(webhookId, "Rebound", "https://169.254.169.254/hooks", "[\"*\"]", "s3cr3t", 0, "active", 0, "per_webhook_owner", now(), 1)
      .run();
    const ev = buildEvent({ type: "person.created", subject: { type: "person", id: "per_x" }, data: { person_id: "per_x" } }, { org_id: ORG, actor: SYSTEM_ACTOR });
    await env.DB.prepare(
      "INSERT INTO domain_event_record (id, type, version, occurred_at, org_id, actor_type, actor_id, actor_display, subject_type, subject_id, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(ev.id, ev.type, ev.version, ev.occurred_at, ev.org_id, ev.actor.type, ev.actor.id, ev.actor.display_name, ev.subject.type, ev.subject.id, JSON.stringify(ev.data))
      .run();
    const deliveryId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO webhook_delivery (id, webhook_id, domain_event_id, attempt, status, scheduled_for) VALUES (?,?,?,?,?,?)")
      .bind(deliveryId, webhookId, ev.id, 1, "pending", now())
      .run();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await deliverWebhook(env, { kind: "webhook", delivery_id: deliveryId, webhook_id: webhookId, event_id: ev.id });

    expect(fetchSpy).not.toHaveBeenCalled();
    const delivery = await env.DB.prepare("SELECT * FROM webhook_delivery WHERE id = ?").bind(deliveryId).first<Record<string, unknown>>();
    expect(delivery?.status).not.toBe("delivered");
    expect(String(delivery?.error)).toMatch(/private|link-local/);
  });
});
