import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * INV-09-7 — every mutating request accepts `Idempotency-Key`; a repeat within
 * 24h replays the stored response and performs **no new writes**. Retries are a
 * normal part of a Workers runtime, so this is not an optional nicety.
 */

async function seedOrg() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("org_idem", "Idem Org", "idem-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now)
    .run();
}

describe("idempotency", () => {
  beforeAll(seedOrg);

  it("INV-09-7: the same Idempotency-Key twice writes once and replays the stored response", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const body = new URLSearchParams({
      full_name: "Idempotent Ida",
      email: "ida@example.com",
      password: "a-long-enough-password",
    });

    const first = await SELF.fetch("http://localhost/signup", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": key },
      redirect: "manual",
    });

    const second = await SELF.fetch("http://localhost/signup", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": key },
      redirect: "manual",
    });

    expect(second.status).toBe(first.status);
    expect(second.headers.get("idempotent-replay")).toBe("true");

    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM person WHERE email = ?")
      .bind("ida@example.com")
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("treats a different key as a different request", async () => {
    const body = new URLSearchParams({
      full_name: "Second Person",
      email: "second@example.com",
      password: "a-long-enough-password",
    });
    await SELF.fetch("http://localhost/signup", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": "key-a" },
      redirect: "manual",
    });
    const res = await SELF.fetch("http://localhost/signup", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": "key-b" },
      redirect: "manual",
    });
    expect(res.headers.get("idempotent-replay")).toBeNull();
  });
});
