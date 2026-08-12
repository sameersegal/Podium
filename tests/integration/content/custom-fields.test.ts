import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * 11-cross-cutting.md, "Custom fields" — the admin flow end to end, against
 * real D1 (implementer.md, D: "real bindings via vitest-pool-workers").
 */

const ORG = "org_cf";
const ADMIN = "per_cf_admin";
const ADMIN_EMAIL = "cf-admin@example.com";
const ADMIN_PASSWORD = "a-long-enough-password-4";

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "CF Org", "cf-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ADMIN, ORG, ADMIN_EMAIL, "Ada Admin", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`aid_${ADMIN}`, ADMIN, "password", ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), now, ADMIN_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_cf_admin", ORG, ADMIN, "admin", "org", ORG, ADMIN, now],
  );
}

async function signIn(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /podium_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Sign-in did not set a session cookie: ${setCookie}`);
  return `podium_session=${match[1]}`;
}

function formHeaders(cookie: string) {
  return { "content-type": "application/x-www-form-urlencoded", cookie };
}

describe("POST /admin/custom-fields/new", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signIn();
  });

  /**
   * The form's own help text says "Leave blank to derive from the label."
   * `createDefinition` validated the raw (blank) key *before* the line that
   * derives one from the label, so doing exactly what the form asked for
   * failed every time with "a key is lowercase letters, digits and hyphens"
   * — the message for a key that was never given the chance to be derived.
   */
  it("derives the key from the label when the key field is left blank, as the form promises", async () => {
    const res = await SELF.fetch("http://localhost/admin/custom-fields/new", {
      method: "POST",
      body: new URLSearchParams({
        subject_type: "person",
        label: "Speaker Type",
        key: "",
        type: "single_select",
        options: "internal|Internal\nexternal|External",
        pii: "false",
        audience: "organizer_only",
      }),
      headers: formHeaders(cookie),
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare("SELECT key, label FROM custom_field_definition WHERE org_id = ? AND subject_type = 'person'")
      .bind(ORG)
      .first<{ key: string; label: string }>();
    expect(row?.label).toBe("Speaker Type");
    expect(row?.key).toBe("speaker-type");
  });

  it("still honours an explicit key when one is given", async () => {
    const res = await SELF.fetch("http://localhost/admin/custom-fields/new", {
      method: "POST",
      body: new URLSearchParams({
        subject_type: "person",
        label: "Region",
        key: "region-code",
        type: "short_text",
        pii: "false",
        audience: "organizer_only",
      }),
      headers: formHeaders(cookie),
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare("SELECT key FROM custom_field_definition WHERE org_id = ? AND label = 'Region'").bind(ORG).first<{ key: string }>();
    expect(row?.key).toBe("region-code");
  });

  it("still refuses a field with no label at all — blank key is not the only shape check", async () => {
    const res = await SELF.fetch("http://localhost/admin/custom-fields/new", {
      method: "POST",
      body: new URLSearchParams({ subject_type: "person", label: "", key: "", type: "short_text", pii: "false", audience: "organizer_only" }),
      headers: formHeaders(cookie),
      redirect: "manual",
    });
    expect(res.status).toBe(422);
  });
});
