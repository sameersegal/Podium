import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { attemptSend, queueNotification } from "@podiumstack/web/contexts/platform/notifications.js";
import { resolveSecret } from "@podiumstack/web/contexts/platform/service.js";
import { deliverWebhook } from "@podiumstack/web/contexts/platform/delivery.js";

/**
 * The demonstration deployment — INV-09-28 (nothing reaches anybody outside it)
 * and INV-01-19 (credential-free sign-in as the fixture people), against the
 * real Worker and real bindings.
 *
 * Every assertion here is made twice: once with `DEMO_MODE` on and once with it
 * off. The defect worth catching is not "the rule does not work on the
 * demonstration site" — it is "the rule leaked onto every other deployment", in
 * which case a real conference silently stops sending its acceptance emails and
 * anybody can sign in as its owner.
 */

const ORG = "org_demo_test";
const EVENT = "evt_demo_test";
const ORGANIZER = "per_demo_organizer";
const OUTSIDER = "per_demo_outsider";
const ORGANIZER_EMAIL = "demo-organizer@example.com";
// A real domain, standing in for the person a visitor could create: everything
// about them is identical except that mail could actually be delivered to them,
// which is the whole of the check in INV-01-19.
const OUTSIDER_EMAIL = "someone@podiumstack.com";

const now = () => new Date().toISOString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

beforeAll(async () => {
  const t = now();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Demo Org", "demo-org", "UTC", "a@b.example", "{}", t, t],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Demo Conf", "demo-conf", "UTC", "2028-06-01", "2028-06-02", "in_person", "active", "public", "{}", t, t],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORGANIZER, ORG, ORGANIZER_EMAIL, "Demo Organizer", "active", 0, t, t],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [OUTSIDER, ORG, OUTSIDER_EMAIL, "Somebody Real", "active", 0, t, t],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    [`rgt_${ORGANIZER}`, ORG, ORGANIZER, "owner", "org", ORG, ORGANIZER, t],
  );
});

function demoMode(on: boolean): void {
  (env as unknown as Record<string, string>).DEMO_MODE = on ? "true" : "false";
}

afterEach(() => demoMode(false));

/* -------------------------------------------------------------------------- */
/* INV-09-28 — nothing leaves                                                  */
/* -------------------------------------------------------------------------- */

describe("INV-09-28: a demonstration deployment sends nothing outward", () => {
  const DAYTIME = "2028-06-01T15:00:00.000Z";
  const appFor = () => new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR, clock: { now: () => DAYTIME } });

  // `queueNotification` answers null for a recipient with no address; this
  // one has one, so a null here is the fixture being wrong rather than the
  // behaviour under test.
  async function queueOne(): Promise<string> {
    const id = await queueNotification(appFor(), {
      template_key: "proposal.submitted",
      recipient_person_id: ORGANIZER,
      subject_type: "proposal",
      subject_id: "prp_demo_test",
      variables: { "proposal.title": "A talk", "proposal.reference": "DT-0001", "proposal.url": "https://example.com", "cfp.name": "CFP", "cfp.closes_at": "2028-05-01" },
    });
    expect(id).not.toBeNull();
    return id!;
  }

  it("INV-09-28: holds an intended message with suppressed_reason = demo, still written and still readable (INV-09-12)", async () => {
    demoMode(true);
    const id = await queueOne();
    const outcome = await attemptSend(appFor(), id);

    expect(outcome).toEqual({ status: "queued", suppressed_reason: "demo" });

    // The point of holding rather than refusing: the letter exists, rendered,
    // for whoever caused it to read in the outbox.
    const row = await env.DB.prepare("SELECT status, suppressed_reason, rendered_body, recipient_email FROM notification_delivery WHERE id = ?").bind(id).first();
    expect(row?.status).toBe("queued");
    expect(row?.suppressed_reason).toBe("demo");
    expect(String(row?.rendered_body ?? "")).not.toBe("");
    expect(row?.recipient_email).toBe(ORGANIZER_EMAIL);
  });

  it("does not touch a deployment that is not a demonstration — the same send records no_provider, as it always has", async () => {
    demoMode(false);
    const id = await queueOne();
    const outcome = await attemptSend(appFor(), id);
    expect(outcome).toEqual({ status: "queued", suppressed_reason: "no_provider" });
  });

  it("INV-09-28: resolves no Integration.secret_ref, so no plugin is handed a credential a visitor could point at", () => {
    const withSecret = { ...env, RESEND_API_KEY: "re_live_not_a_real_key" } as unknown as typeof env;
    (withSecret as unknown as Record<string, string>).DEMO_MODE = "true";
    expect(resolveSecret(withSecret, "RESEND_API_KEY")).toBeNull();

    (withSecret as unknown as Record<string, string>).DEMO_MODE = "false";
    expect(resolveSecret(withSecret, "RESEND_API_KEY")).toBe("re_live_not_a_real_key");
  });

  it("INV-09-28: resolves a webhook delivery as skipped without making the request", async () => {
    demoMode(true);
    const t = now();
    const webhookId = "whk_demo_test";
    const deliveryId = "whd_demo_test";
    const eventId = "evt_domain_demo_test";
    await run(
      "INSERT OR IGNORE INTO webhook (id, org_id, event_id, name, url, event_types, secret, include_pii, status, consecutive_failures, created_by_person_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      // A URL that would be a real request out of this Worker if the guard were
      // missing — and one a visitor to the demonstration could have typed.
      [webhookId, ORG, EVENT, "Visitor's webhook", "https://example.invalid/hook", '["*"]', "whsec_demo", 0, "active", 0, ORGANIZER, t],
    );
    await run(
      "INSERT OR IGNORE INTO domain_event_record (id, org_id, event_id, type, version, occurred_at, actor_type, actor_id, actor_display, subject_type, subject_id, data, correlation_id, causation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [eventId, ORG, EVENT, "proposal.submitted", 1, t, "system", null, "System", "proposal", "prp_demo_test", "{}", "cor_demo", null],
    );
    await run(
      "INSERT OR IGNORE INTO webhook_delivery (id, webhook_id, domain_event_id, attempt, status, scheduled_for) VALUES (?,?,?,?,?,?)",
      [deliveryId, webhookId, eventId, 1, "pending", t],
    );

    await deliverWebhook(env, { kind: "webhook", delivery_id: deliveryId, webhook_id: webhookId, org_id: ORG, event_id: EVENT });

    const row = await env.DB.prepare("SELECT status, response_status FROM webhook_delivery WHERE id = ?").bind(deliveryId).first();
    expect(row?.status).toBe("skipped");
    // Nothing was attempted, so there is no response to have recorded.
    expect(row?.response_status).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* INV-01-19 — credential-free sign-in, and only for the fixture people        */
/* -------------------------------------------------------------------------- */

describe("INV-01-19: sign-in on a demonstration deployment", () => {
  const signIn = (email: string) =>
    SELF.fetch("http://localhost/demo/sign-in", { method: "POST", body: new URLSearchParams({ email }), headers: FORM, redirect: "manual" });

  it("INV-01-19: signs a visitor in as a fixture person with no credential, and sends them where that person works", async () => {
    demoMode(true);
    const res = await signIn(ORGANIZER_EMAIL);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("podium_session=");
    // INV-01-18 still applies to a session started this way.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");

    // And it is a real session: the next request is that person.
    const token = /podium_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    const admin = await SELF.fetch("http://localhost/admin", { headers: { cookie: `podium_session=${token}` }, redirect: "manual" });
    expect(admin.status).toBe(200);
  });

  it("INV-01-19: refuses a person outside the reserved domain, even one this deployment knows", async () => {
    demoMode(true);
    const res = await signIn(OUTSIDER_EMAIL);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("INV-01-19: does not exist on a deployment that is not a demonstration", async () => {
    demoMode(false);
    const res = await signIn(ORGANIZER_EMAIL);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("offers the fixture people on the sign-in page, and offers nobody anywhere else", async () => {
    demoMode(true);
    const on = await (await SELF.fetch("http://localhost/login", { redirect: "manual" })).text();
    expect(on).toContain("/demo/sign-in");
    expect(on).toContain("Demo Organizer");
    // Never the person who is not a fixture, on a page anybody can read.
    expect(on).not.toContain("Somebody Real");

    demoMode(false);
    const off = await (await SELF.fetch("http://localhost/login", { redirect: "manual" })).text();
    expect(off).not.toContain("/demo/sign-in");
  });
});

/* -------------------------------------------------------------------------- */
/* Saying where you are                                                        */
/* -------------------------------------------------------------------------- */

describe("a demonstration deployment says so", () => {
  it("carries the banner on a page, and asks not to be indexed", async () => {
    demoMode(true);
    const res = await SELF.fetch("http://localhost/login", { redirect: "manual" });
    const body = await res.text();
    expect(body).toContain("demo-bar");
    expect(body).toContain("reset every hour");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    demoMode(false);
    const real = await SELF.fetch("http://localhost/login", { redirect: "manual" });
    expect(await real.text()).not.toContain("demo-bar");
    expect(real.headers.get("x-robots-tag")).toBeNull();
  });

  it("answers the restore job's interlock, and answers it honestly when it is not a demonstration", async () => {
    demoMode(true);
    const on = (await (await SELF.fetch("http://localhost/demo/status")).json()) as { demo: boolean; personas: { email: string }[] };
    expect(on.demo).toBe(true);
    expect(on.personas.map((p) => p.email)).toEqual([ORGANIZER_EMAIL]);

    demoMode(false);
    const off = (await (await SELF.fetch("http://localhost/demo/status")).json()) as Record<string, unknown>;
    // Only the answer. A deployment that is not a demonstration says nothing
    // about its people to an unauthenticated caller.
    expect(off).toEqual({ demo: false });
  });

  it("tells crawlers to stay out entirely, and on a real deployment only out of what is somebody's own data", async () => {
    demoMode(true);
    const demo = await (await SELF.fetch("http://localhost/robots.txt")).text();
    expect(demo).toContain("Disallow: /\n");

    demoMode(false);
    const real = await (await SELF.fetch("http://localhost/robots.txt")).text();
    expect(real).toContain("Disallow: /admin");
    expect(real).not.toContain("Disallow: /\n");
  });
});
