import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * `/admin/settings` — `Organization.postal_address` (01), editable after
 * first-run setup so a deployment whose Organization row predates the field
 * (the column is nullable for exactly this reason — 09, "Notifications") can
 * fill it in, and so it can be changed later without a database console.
 */

const ORG = "org_settings_test";
const ADMIN = "per_settings_admin";
const ADMIN_EMAIL = "settings-admin@example.com";
const ADMIN_PASSWORD = "settings-admin-password";

/** `resolveOrgId` takes the earliest-created organization, so this one must sort first. */
const EPOCH = "2000-01-01T00:00:00.000Z";

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  // No postal_address at all — the pre-migration shape this screen exists for.
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Settings Test Org", "settings-test-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), EPOCH, EPOCH],
  );
  await run("INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [
    ADMIN,
    ADMIN_EMAIL,
    "Settings Admin",
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
  await run("INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)", [
    "rg_settings_admin",
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

describe("organization settings — filling in the mailing address after the fact", () => {
  let cookie = "";

  beforeAll(async () => {
    await seed();
    cookie = await signIn();
  });

  it("renders the settings form with an empty mailing address for an org that predates the field", async () => {
    const res = await SELF.fetch("http://localhost/admin/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="postal_address"');
  });

  it("saves the address, and it round-trips back onto the form", async () => {
    const res = await SELF.fetch("http://localhost/admin/settings", {
      method: "POST",
      body: new URLSearchParams({
        name: "Settings Test Org",
        contact_email: "a@b.example",
        postal_address: "221B Baker Street, London",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare("SELECT postal_address FROM organization WHERE id = ?").bind(ORG).first<{ postal_address: string }>();
    expect(row?.postal_address).toBe("221B Baker Street, London");

    const rendered = await SELF.fetch("http://localhost/admin/settings", { headers: { cookie } });
    expect(await rendered.text()).toContain("221B Baker Street, London");
  });
});
