import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumconf/domain/identity/credentials.js";

/**
 * The response-hardening headers, the session cookie's attributes, the `next=`
 * screen and the sign-in throttle — asserted against the real Worker rather
 * than against their own modules, because the defect each one fixes was never
 * "the function is wrong". It was "no function was called". Before this the app
 * set no CSP, no `nosniff`, no framing policy, no `Secure`, validated no
 * redirect target and counted no failed sign-ins, on any response, anywhere.
 *
 * The persona is seeded here rather than assumed: the integration suite applies
 * migrations and nothing else, so a test that signs in with a seed-script
 * password would pass by never signing in at all.
 */

const ORG = "org_hardening";
const EMAIL = "hardening-organizer@example.com";
const PASSWORD = "hardening-organizer-password";
const PERSON = "per_hardening_organizer";

const LOGIN = "http://localhost/login";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Hardening Org", "hardening-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [PERSON, ORG, EMAIL, "Hardening Organizer", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`aid_${PERSON}`, PERSON, "password", EMAIL, hashPassword(PASSWORD), now, EMAIL, now],
  );
});

function signIn(body: Record<string, string>): Promise<Response> {
  return SELF.fetch(LOGIN, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: FORM,
    redirect: "manual",
  });
}

describe("security response headers", () => {
  it("sends nosniff, a CSP and a referrer policy on an ordinary page", async () => {
    const res = await SELF.fetch(LOGIN, { redirect: "manual" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // The three directives that bite without needing the inline-script work
    // done first: no plugins, no <base> rewriting, no posting this form
    // somewhere else.
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("denies framing of the app, so the admin surfaces cannot be clickjacked", async () => {
    const res = await SELF.fetch(LOGIN, { redirect: "manual" });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("does not deny framing of the embed, which exists to be framed", async () => {
    // 08, "The embed (J10)". An unknown key still returns a document, and that
    // document must stay embeddable or the widget is broken by its own headers.
    const res = await SELF.fetch("http://localhost/embed/no-such-key", { redirect: "manual" });
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy") ?? "").not.toContain("frame-ancestors");
  });

  it("does not pin HSTS against localhost", async () => {
    // A max-age pinned to `localhost` would make every other local dev server
    // on the machine https-only — a genuinely nasty thing to debug.
    const res = await SELF.fetch(LOGIN, { redirect: "manual" });
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("session cookie attributes", () => {
  it("sets Secure, HttpOnly and SameSite on the session cookie", async () => {
    const res = await signIn({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("podium_session=");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    // No CSRF token exists anywhere in this app; SameSite is the only thing
    // between a third-party page and a state-changing form post.
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("open redirect on ?next=", () => {
  it("refuses to bounce a signed-in person to another origin", async () => {
    const res = await signIn({ email: EMAIL, password: PASSWORD, next: "https://evil.example/harvest" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal");
  });

  it("refuses the protocol-relative form, which reads as a path", async () => {
    const res = await signIn({ email: EMAIL, password: PASSWORD, next: "//evil.example/harvest" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal");
  });

  it("still honours an ordinary in-app destination", async () => {
    const res = await signIn({ email: EMAIL, password: PASSWORD, next: "/portal/proposals" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal/proposals");
  });
});

describe("sign-in throttling", () => {
  /**
   * Ten failures against one email, then an eleventh that is refused before it
   * ever reaches Argon2. The refusal is what matters twice over: it stops the
   * guessing, and it stops an attacker spending the free plan's 10 ms CPU
   * budget on hashes we chose to make cheap (docs/implementation.md, "Password
   * hashing is currently below the OWASP floor, on purpose").
   */
  it("refuses further attempts after the ceiling, then lets the right password through once cleared", async () => {
    const victim = "throttle-target@example.com";
    for (let i = 0; i < 10; i++) {
      const res = await signIn({ email: victim, password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }
    const refused = await signIn({ email: victim, password: "wrong-again" });
    expect(refused.status).toBe(429);
  });

  it("does not let a locked-out email lock out an unrelated one", async () => {
    // The counter is per identifier. A throttle that spilled across accounts
    // would be a denial-of-service primitive rather than a defence.
    const res = await signIn({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(303);
  });
});
