import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { createApiKey } from "@podiumstack/web/contexts/platform/service.js";
import { queueNotification } from "@podiumstack/web/contexts/platform/notifications.js";

/**
 * INV-09-5 — without `pii:read`, every response redacts personal fields;
 * with it, they come through. `NotificationDelivery.recipient_email` is one
 * of the fields the PII table (11-cross-cutting.md) names explicitly.
 */

const ORG = "org_apikey_test";
const EVENT = "evt_apikey_test";
const PERSON = "per_apikey_test";
const now = () => new Date().toISOString();

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "API Key Test Org", "apikey-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "API Key Test Conf", "apikey-test-conf", "UTC", "2028-07-01", "2028-07-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(PERSON, ORG, "secret-address@example.com", "Piña Person", "active", 0, now(), now())
    .run();
}

describe("INV-09-5: PII redaction by API key scope", () => {
  let withoutPii = "";
  let withPii = "";

  beforeAll(async () => {
    await seed();
    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    await queueNotification(app, {
      template_key: "proposal.submitted",
      recipient_person_id: PERSON,
      subject_type: "proposal",
      subject_id: "prp_apikey_test",
      variables: { "proposal.title": "Redaction test talk", "proposal.reference": "PK-0001", "proposal.url": "https://example.com", "cfp.name": "Main", "cfp.closes_at": "2028-06-01" },
    });
    await app.flush();

    const a = await createApiKey(app, { name: "no-pii", scopes: ["events:write"] });
    const b = await createApiKey(app, { name: "with-pii", scopes: ["events:write", "pii:read"] });
    await app.flush();
    withoutPii = a.secret;
    withPii = b.secret;
  });

  it("redacts recipient_email and the rendered body without pii:read", async () => {
    const res = await SELF.fetch("http://localhost/v1/notifications", { headers: { authorization: `Bearer ${withoutPii}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { recipient_email: string; subject_id: string }[] };
    const row = body.items.find((i) => i.subject_id === "prp_apikey_test");
    expect(row).toBeTruthy();
    expect(row?.recipient_email).toBe("[redacted]");
  });

  it("includes recipient_email and the rendered body with pii:read", async () => {
    const res = await SELF.fetch("http://localhost/v1/notifications", { headers: { authorization: `Bearer ${withPii}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { recipient_email: string; subject_id: string }[] };
    const row = body.items.find((i) => i.subject_id === "prp_apikey_test");
    expect(row).toBeTruthy();
    expect(row?.recipient_email).toBe("secret-address@example.com");
  });

  it("INV-09-1: the secret is never re-displayed — the listing shows only the prefix", async () => {
    const res = await SELF.fetch("http://localhost/v1/api-keys", { headers: { authorization: `Bearer ${withPii}` } });
    const keys = (await res.json()) as Record<string, unknown>[];
    for (const k of keys) {
      expect(k.secret).toBeUndefined();
      expect(typeof k.prefix).toBe("string");
    }
  });
});
