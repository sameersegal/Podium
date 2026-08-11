import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumconf/domain/identity/credentials.js";

/**
 * `/admin/integrations` — installing a plugin through the admin console.
 *
 * The install form used to submit only `plugin_key`, `display_name`,
 * `secret_ref` and `is_default_for_capability`, never `config`, while
 * `email.sendgrid` declares `from_email` as a required config field. The result
 * was an integration that installed cleanly, reported healthy, and failed every
 * send with "No from address is configured." — so the assertion that matters
 * here is that `config` survives the round trip.
 *
 * INV-09-3: `config` never holds credentials; the form asks only for the *name*
 * of the secret.
 */

const ORG = "org_install_test";
const ADMIN = "per_install_admin";
const ADMIN_EMAIL = "install-admin@example.com";
const ADMIN_PASSWORD = "install-admin-password";

/** `resolveOrgId` takes the earliest-created organization, so this one must sort first. */
const EPOCH = "2000-01-01T00:00:00.000Z";

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await run("INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
    ORG,
    "Install Test Org",
    "install-test-org",
    "UTC",
    "a@b.example",
    JSON.stringify({ auth: { password_login_enabled: true } }),
    EPOCH,
    EPOCH,
  ]);
  await run("INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
    ADMIN,
    ORG,
    ADMIN_EMAIL,
    "Install Admin",
    "active",
    0,
    now,
    now,
  ]);
  await run("INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)", [
    `aid_${ADMIN}`,
    ADMIN,
    "password",
    ADMIN_EMAIL,
    hashPassword(ADMIN_PASSWORD),
    now,
    ADMIN_EMAIL,
    now,
  ]);
  await run("INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)", [
    "rg_install_admin",
    ORG,
    ADMIN,
    "owner",
    "org",
    ORG,
    ADMIN,
    now,
  ]);
}

async function signIn(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const match = /podium_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("sign-in set no cookie");
  return `podium_session=${match[1]}`;
}

function form(cookie: string, path: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    redirect: "manual",
  });
}

describe("installing an email integration through the admin console", () => {
  let cookie = "";

  beforeAll(async () => {
    await seed();
    cookie = await signIn();
  });

  it("renders the chosen plugin's declared config fields on the install form", async () => {
    const res = await SELF.fetch("http://localhost/admin/integrations/new?plugin_key=email.sendgrid", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // `from_email` is declared required by the plugin, so the form must both
    // render it and mark it required.
    expect(body).toContain('name="config.from_email"');
    expect(body).toContain('name="config.from_name"');
    expect(body).toContain('name="secret_ref"');
  });

  it("carries config through the install so the plugin has its from address", async () => {
    const res = await form(cookie, "/admin/integrations/new", {
      plugin_key: "email.sendgrid",
      display_name: "SendGrid",
      secret_ref: "SENDGRID_API_KEY",
      "config.from_email": "hello@example.com",
      "config.from_name": "Podium",
      is_default_for_capability: "1",
    });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare("SELECT config, secret_ref FROM integration WHERE org_id = ? AND plugin_key = 'email.sendgrid'")
      .bind(ORG)
      .first<Record<string, unknown>>();
    expect(JSON.parse(String(row?.config))).toEqual({ from_email: "hello@example.com", from_name: "Podium" });
    expect(row?.secret_ref).toBe("SENDGRID_API_KEY");
  });

  it("edits config after install without losing keys the plugin does not declare", async () => {
    const before = await env.DB.prepare("SELECT id FROM integration WHERE org_id = ? AND plugin_key = 'email.sendgrid'").bind(ORG).first<Record<string, unknown>>();
    const id = String(before?.id);
    // A key only `POST /v1/integrations` could have set.
    await run("UPDATE integration SET config = ? WHERE id = ?", [JSON.stringify({ from_email: "hello@example.com", from_name: "Podium", ip_pool: "transactional" }), id]);

    const res = await form(cookie, `/admin/integrations/${id}`, {
      display_name: "SendGrid",
      secret_ref: "SENDGRID_API_KEY",
      "config.from_email": "changed@example.com",
      "config.from_name": "Podium",
      is_default_for_capability: "1",
    });
    expect(res.status).toBe(303);

    const after = await env.DB.prepare("SELECT config FROM integration WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(JSON.parse(String(after?.config))).toEqual({ from_email: "changed@example.com", from_name: "Podium", ip_pool: "transactional" });
  });

  it("INV-09-3: refuses a config key that looks like a credential", async () => {
    const res = await form(cookie, "/admin/integrations/new", {
      plugin_key: "email.resend",
      display_name: "Resend",
      secret_ref: "RESEND_API_KEY",
      "config.api_key": "re_livekey",
    });
    // 422, not merely "some error" — a 403 from a mis-seeded role would
    // otherwise pass this test while proving nothing about INV-09-3.
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("credential");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM integration WHERE org_id = ? AND plugin_key = 'email.resend'").bind(ORG).first<Record<string, unknown>>();
    expect(Number(row?.n)).toBe(0);
  });

  it("shows the signed inbound webhook URL on an email integration's page", async () => {
    const row = await env.DB.prepare("SELECT id FROM integration WHERE org_id = ? AND plugin_key = 'email.sendgrid'").bind(ORG).first<Record<string, unknown>>();
    const res = await SELF.fetch(`http://localhost/admin/integrations/${String(row?.id)}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/integrations/${String(row?.id)}/inbound?sig=`);
  });
});
