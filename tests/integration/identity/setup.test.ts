import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { str, type Row } from "@podiumstack/data/db.js";

/**
 * First-run setup on a genuinely empty deployment — 01, "First-run setup".
 *
 * `tests/integration/setup.ts` applies every migration from scratch before
 * this file's tests run, so `organization` starts with zero rows — the state a
 * freshly deployed instance is actually in, migrations applied and nothing
 * seeded (`resolveOrgId` in `http/context.ts` resolving to "").
 *
 * Storage isolation in `@cloudflare/vitest-pool-workers` is per test *file*,
 * not per `describe` — so the tests below run in file order, on purpose: the
 * ones that must see an empty deployment come first, and only the final
 * describe block creates the Organization, once, as the thing it is testing.
 * `setup-refusal.test.ts` and `setup-race.test.ts` cover what happens once
 * one exists, each starting from their own fresh, empty database.
 */

async function orgCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM organization").first<{ n: number }>();
  return row?.n ?? 0;
}

const VALID_FORM = {
  org_name: "AI Engineer",
  org_slug: "",
  default_timezone: "America/Los_Angeles",
  contact_email: "hello@example.com",
  owner_full_name: "Ada Owner",
  owner_email: "ada@example.com",
  owner_password: "a-long-enough-password-1",
};

async function postSetup(form: Record<string, string> = VALID_FORM) {
  return SELF.fetch("http://localhost/setup", {
    method: "POST",
    body: new URLSearchParams(form),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
}

describe("a freshly migrated deployment with no Organization row", () => {
  it("redirects every other page to /setup rather than rendering 'not found'", async () => {
    const home = await SELF.fetch("http://localhost/", { redirect: "manual" });
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/setup");

    const admin = await SELF.fetch("http://localhost/admin", { redirect: "manual" });
    expect(admin.status).toBe(303);
    expect(admin.headers.get("location")).toBe("/setup");

    const login = await SELF.fetch("http://localhost/login", { redirect: "manual" });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/setup");
  });

  it("answers a JSON-preferring request with a 503, not a redirect into an HTML page", async () => {
    const res = await SELF.fetch("http://localhost/v1/events", { redirect: "manual" });
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("not_configured");
  });

  it("GET /setup renders the form directly, with no redirect", async () => {
    const res = await SELF.fetch("http://localhost/setup", { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Set up this Podium");
    expect(body).toContain("Organization name");
    expect(body).toContain("Password");
  });
});

describe("POST /setup — validation", () => {
  it("rejects an invalid timezone with a 422, re-renders the form with what was typed, and creates nothing", async () => {
    const res = await postSetup({ ...VALID_FORM, default_timezone: "Not/A/Zone" });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("Not/A/Zone");
    expect(body).toContain("recognised IANA timezone");
    expect(await orgCount()).toBe(0);
  });

  it("rejects a short password without creating anything", async () => {
    const res = await postSetup({ ...VALID_FORM, owner_password: "short" });
    expect(res.status).toBe(422);
    expect(await orgCount()).toBe(0);
  });

  it("rejects a missing organization name without creating anything", async () => {
    const res = await postSetup({ ...VALID_FORM, org_name: "  " });
    expect(res.status).toBe(422);
    expect(await orgCount()).toBe(0);
  });
});

describe("POST /setup — success path", () => {
  it("creates the Organization, the owner Person, their password AuthIdentity and an owner RoleGrant, and signs them in", async () => {
    const res = await postSetup();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("podium_session=");

    const org = await env.DB.prepare("SELECT * FROM organization").first<Row>();
    expect(org).toBeTruthy();
    expect(str(org!.name)).toBe("AI Engineer");
    expect(str(org!.contact_email)).toBe("hello@example.com");
    expect(str(org!.default_timezone)).toBe("America/Los_Angeles");

    const person = await env.DB.prepare("SELECT * FROM person WHERE email = ?").bind("ada@example.com").first<Row>();
    expect(person).toBeTruthy();
    expect(str(person!.org_id)).toBe(str(org!.id));
    expect(str(person!.status)).toBe("active");

    const identity = await env.DB.prepare("SELECT * FROM auth_identity WHERE person_id = ? AND provider = 'password'").bind(person!.id).first<Row>();
    expect(identity).toBeTruthy();
    expect(identity!.credential_hash).toBeTruthy();

    const grant = await env.DB.prepare("SELECT * FROM role_grant WHERE person_id = ?").bind(person!.id).first<Row>();
    expect(grant).toBeTruthy();
    expect(str(grant!.role)).toBe("owner");
    expect(str(grant!.scope_type)).toBe("org");
    expect(str(grant!.scope_id)).toBe(str(org!.id));

    const event = await env.DB.prepare("SELECT * FROM domain_event_record WHERE type = 'organization.created'").first<Row>();
    expect(event).toBeTruthy();
    expect(str(event!.subject_id)).toBe(str(org!.id));

    // The claim table this endpoint's one-time guarantee rests on.
    const claim = await env.DB.prepare("SELECT * FROM bootstrap_state").first<Row>();
    expect(claim).toBeTruthy();
    expect(str(claim!.organization_id)).toBe(str(org!.id));
  });

  it("R23: the new owner can sign in again with the password they just chose — no lock-out", async () => {
    const login = await SELF.fetch("http://localhost/login", {
      method: "POST",
      body: new URLSearchParams({ email: "ada@example.com", password: "a-long-enough-password-1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("set-cookie") ?? "").toContain("podium_session=");
  });
});
