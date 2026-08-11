import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * INV-01-16 — once an Organization exists, `/setup` is refused on every
 * method, checked fresh against the database on every request (not a cached
 * or in-memory flag: this file's `beforeAll` runs in the same worker
 * lifetime as every `it` below, so a flag set once at startup would still be
 * set could never be re-observed as false — only a real per-request DB read
 * catches that).
 *
 * This file gets its own isolated D1 instance (storage isolation is per test
 * *file*), separate from `setup.test.ts`'s empty-deployment scenarios.
 */

const VALID_FORM = {
  org_name: "AI Engineer",
  default_timezone: "UTC",
  contact_email: "hello@example.com",
  owner_full_name: "Ada Owner",
  owner_email: "ada@example.com",
  owner_password: "a-long-enough-password-1",
};

async function postSetup(form: Record<string, string>, headers: Record<string, string> = {}) {
  return SELF.fetch("http://localhost/setup", {
    method: "POST",
    body: new URLSearchParams(form),
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    redirect: "manual",
  });
}

async function orgCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM organization").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("INV-01-16: /setup is refused once an Organization exists", () => {
  beforeAll(async () => {
    const res = await postSetup(VALID_FORM);
    expect(res.status).toBe(303); // the one legitimate setup for this file
  });

  it("refuses GET /setup for a JSON-preferring caller, naming the invariant", async () => {
    const res = await SELF.fetch("http://localhost/setup", { redirect: "manual", headers: { accept: "application/json" } });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string; invariant: string }>();
    expect(body.invariant).toBe("INV-01-16");
  });

  it("refuses GET /setup for a browser too, with the invariant on the error page", async () => {
    const res = await SELF.fetch("http://localhost/setup", { redirect: "manual" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("INV-01-16");
  });

  it("refuses POST /setup and creates no second organization", async () => {
    const res = await postSetup({ ...VALID_FORM, org_name: "A Second Org", owner_email: "someone-else@example.com" }, { accept: "application/json" });
    expect(res.status).toBe(403);
    const body = await res.json<{ invariant: string }>();
    expect(body.invariant).toBe("INV-01-16");
    expect(await orgCount()).toBe(1);
  });

  it("two POST /setup requests racing on an already-set-up deployment both lose", async () => {
    const [a, b] = await Promise.all([
      postSetup({ ...VALID_FORM, owner_email: "racer-a@example.com" }, { accept: "application/json" }),
      postSetup({ ...VALID_FORM, owner_email: "racer-b@example.com" }, { accept: "application/json" }),
    ]);
    expect([a.status, b.status].every((s) => s === 403)).toBe(true);
    expect(await orgCount()).toBe(1);
  });
});
