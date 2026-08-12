import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { createApiKey } from "@podiumstack/web/contexts/platform/service.js";

/**
 * INV-09-25 and INV-09-26 — what a key reaches, and the one thing no key
 * reaches.
 *
 * Both invariants exist because of the same defect, found by driving the
 * management API from outside rather than reading it: scopes were mapped onto
 * a role — `admin` for a key holding any `:write` scope, `viewer` otherwise —
 * and that translation lost information in both directions. `viewer` appeared
 * in no capability, so a read-only key was refused every read it had been
 * granted; and the scope table covered half the capabilities, with the rest
 * falling through to the role, so a key created for `tasks:write` could reach
 * org configuration and mint itself a second key with `pii:read`.
 *
 * These tests are the shape of both halves: a key does everything its scopes
 * name, nothing they do not, and never administers keys.
 */

const ORG = "org_scope_test";
const EVENT = "evt_scope_test";
const now = () => new Date().toISOString();

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Scope Test Org", "scope-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "Scope Test Conf", "scope-test-conf", "UTC", "2028-09-01", "2028-09-02", "in_person", "active", "public", "{}", now(), now())
    .run();
}

const get = (path: string, secret: string) =>
  SELF.fetch(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } });

const post = (path: string, secret: string, body: unknown) =>
  SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("INV-09-25: a key reaches exactly what its scopes name", () => {
  let readOnly = "";
  let narrowWrite = "";
  let platform = "";

  beforeAll(async () => {
    await seed();
    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    readOnly = (await createApiKey(app, { name: "read-only", scopes: ["events:read", "proposals:read", "sessions:read"] })).secret;
    narrowWrite = (await createApiKey(app, { name: "tasks only", scopes: ["tasks:write"] })).secret;
    platform = (await createApiKey(app, { name: "platform", scopes: ["webhooks:manage"] })).secret;
    await app.flush();
  });

  it("lets a key holding only read scopes actually read", async () => {
    expect((await get("/v1/events", readOnly)).status).toBe(200);
    expect((await get(`/v1/proposals?event_id=${EVENT}`, readOnly)).status).toBe(200);
    expect((await get(`/v1/sessions?event_id=${EVENT}`, readOnly)).status).toBe(200);
  });

  it("refuses a read-only key every write", async () => {
    const res = await post(`/v1/events/${EVENT}/rooms`, readOnly, { name: "Hall A" });
    expect(res.status).toBe(403);
  });

  it("refuses a read it was not granted, even to a key that can read something else", async () => {
    // No `reviews:read`, no `webhooks:manage`: the surfaces are absent, not redacted.
    expect((await get(`/v1/reviews?proposal_id=prp_nothing`, readOnly)).status).toBe(403);
    expect((await get("/v1/api-keys", readOnly)).status).toBe(403);
  });

  it("holds a narrow write key to its own subject", async () => {
    expect((await get(`/v1/tasks?event_id=${EVENT}`, narrowWrite)).status).toBe(200);
    expect((await get(`/v1/proposals?event_id=${EVENT}`, narrowWrite)).status).toBe(403);
    // Read guards, deliberately: several write handlers load their subject
    // before checking permission, so a bogus id answers 404 and proves nothing
    // about scope.
    expect((await get(`/v1/decisions?event_id=${EVENT}`, narrowWrite)).status).toBe(403);
    expect((await post("/v1/campaigns", narrowWrite, { event_id: EVENT, name: "x", channel: "email" })).status).toBe(403);
  });

  it("makes webhooks:manage the platform-administration scope", async () => {
    expect((await get("/v1/webhooks", platform)).status).toBe(200);
    expect((await get("/v1/api-keys", platform)).status).toBe(200);
    // …and nothing beyond the platform.
    expect((await get(`/v1/proposals?event_id=${EVENT}`, platform)).status).toBe(403);
  });

  it("refuses a key with no scopes at creation", async () => {
    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    await expect(createApiKey(app, { name: "empty", scopes: [] })).rejects.toThrow(/at least one scope/);
  });
});

describe("INV-09-27: a first-person statement is authored by its person", () => {
  let full = "";

  beforeAll(async () => {
    await seed();
    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    // Every scope these two routes could possibly want, so a refusal is the
    // rule and not a missing permission.
    full = (await createApiKey(app, { name: "everything", scopes: ["proposals:read", "proposals:write", "reviews:read", "reviews:write", "pii:read"] })).secret;
    await app.flush();
  });

  it("refuses a key submitting a proposal, whatever its scopes", async () => {
    const res = await post("/v1/proposals/prp_does_not_exist/submit", full, {});
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; invariant?: string };
    expect(body.error).toBe("authorship_requires_person");
    expect(body.invariant).toBe("INV-09-27");
  });

  it("refuses a key writing a review, whatever its scopes", async () => {
    const res = await post("/v1/reviews", full, { assignment_id: "asg_does_not_exist", recommendation: "accept" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; invariant?: string };
    expect(body.error).toBe("authorship_requires_person");
    expect(body.invariant).toBe("INV-09-27");
  });

  // The ids above are deliberately bogus: the rule is checked before the
  // record is loaded, so the caller is told which rule stopped them rather
  // than whether the id exists. A 404 here would be both a worse answer and a
  // small disclosure.
  it("names the rule before it looks the record up", async () => {
    const res = await post("/v1/proposals/prp_does_not_exist/submit", full, {});
    expect(res.status).not.toBe(404);
  });
});

describe("INV-09-26: no key may administer keys", () => {
  let platform = "";

  beforeAll(async () => {
    await seed();
    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    platform = (await createApiKey(app, { name: "platform admin", scopes: ["webhooks:manage"] })).secret;
    await app.flush();
  });

  it("refuses key creation to the one scope that reaches org configuration", async () => {
    const res = await post("/v1/api-keys", platform, { name: "escalated", scopes: ["pii:read", "decisions:write"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; invariant?: string };
    expect(body.error).toBe("api_key_cannot_administer_keys");
    expect(body.invariant).toBe("INV-09-26");
  });

  it("refuses rotation, which would hand over another key's secret", async () => {
    const list = (await (await get("/v1/api-keys", platform)).json()) as { id: string }[];
    const res = await post(`/v1/api-keys/${list[0].id}/rotate`, platform, {});
    expect(res.status).toBe(403);
  });

  it("still lets a key list keys — the listing carries prefixes, never a secret", async () => {
    const res = await get("/v1/api-keys", platform);
    expect(res.status).toBe(200);
    for (const key of (await res.json()) as Record<string, unknown>[]) {
      expect(key.secret).toBeUndefined();
      expect(typeof key.prefix).toBe("string");
    }
  });
});
