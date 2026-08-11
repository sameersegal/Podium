import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumconf/domain/identity/credentials.js";

/**
 * 11-cross-cutting.md, "Concurrency" — INV-11-14: *a field edit submitted
 * against a stale version of an aggregate root is refused with 409 and the
 * current state. It is never silently applied.*
 *
 * `Db.updateVersioned` has always implemented the compare-and-set. What it
 * could not do on its own is notice that no HTML form sent the version back,
 * so every organizer edit fell through to a plain `UPDATE` and the second
 * writer won silently. These tests drive the real admin screens: load the
 * form, take the version it rendered, and submit twice against it.
 */

const ORG = "org_conc";
const EVENT = "evt_conc";
const CFP = "cfp_conc";
const FORMAT = "fmt_conc";
const SESSION = "ses_conc";

const ADMIN = "per_conc_admin";
const ADMIN_EMAIL = "conc-admin@example.com";
const ADMIN_PASSWORD = "concurrency-admin-password";

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();

  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Concurrency Org", "concurrency-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Concurrency Conf", "concurrency-conf", "UTC", "2027-09-01", "2027-09-03", "in_person", "active", "public", "{}", now, now],
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
    ["rg_conc_admin", ORG, ADMIN, "admin", "org", ORG, ADMIN, now],
  );
  await run(
    `INSERT OR IGNORE INTO call_for_proposals
       (id, event_id, name, slug, audience, opens_at, closes_at, grace_period_minutes, late_submission_policy,
        allow_edit_after_submit, withdraw_allowed_until, notify_on_submit, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [CFP, EVENT, "Main CFP", "main-cfp", "public", "2027-01-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z", 0, "reject", 1, "decision", 1, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, requires_recording_consent, capacity_policy, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 1, JSON.stringify(["cfp"]), 1, 0, "open", 0, 1],
  );
  await run(
    `INSERT OR IGNORE INTO session
       (id, org_id, event_id, reference, origin, title, abstract, session_format_id, duration_minutes, status, content_status, visibility, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [SESSION, ORG, EVENT, "T-9001", "cfp", "Original title", "An abstract.", FORMAT, 30, "confirmed", "draft", "public", now, now],
  );
}

async function signIn(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    headers: FORM_HEADERS,
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const match = /podium_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("sign-in set no session cookie");
  return `podium_session=${match[1]}`;
}

/** The version the screen actually rendered — the whole point is not to read it from the database. */
async function renderedVersion(cookie: string, path: string): Promise<string> {
  const res = await SELF.fetch(`http://localhost${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  const match = /name="row_version" value="(\d+)"/.exec(html);
  if (!match) throw new Error(`${path} rendered no row_version field — INV-11-14 cannot hold for that form`);
  return match[1];
}

function post(cookie: string, path: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: { ...FORM_HEADERS, cookie },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

/** The flash cookie carries the outcome as JSON; `warn` is how a refused write announces itself. */
function flashKind(res: Response): string {
  const match = /podium_flash=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) return "";
  try {
    return String((JSON.parse(decodeURIComponent(match[1])) as { kind?: unknown }).kind ?? "");
  } catch {
    return "";
  }
}

async function columnOf(table: string, id: string, column: string): Promise<unknown> {
  const row = await env.DB.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).bind(id).first<{ v: unknown }>();
  return row?.v;
}

describe("compare-and-set on aggregate roots (INV-11-14)", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signIn();
  });

  it("refuses the second of two event edits made against the same version, and keeps the first", async () => {
    const version = await renderedVersion(cookie, `/admin/events/${EVENT}`);
    const settings = {
      row_version: version,
      name: "Concurrency Conf",
      timezone: "UTC",
      starts_on: "2027-09-01",
      ends_on: "2027-09-03",
      mode: "in_person",
      visibility: "public",
    };

    const first = await post(cookie, `/admin/events/${EVENT}`, { ...settings, tagline: "First writer wins" });
    expect(first.status).toBe(303);
    expect(flashKind(first)).toBe("ok");

    // Same version, as a second organizer's browser would still be holding it.
    const second = await post(cookie, `/admin/events/${EVENT}`, { ...settings, tagline: "Second writer clobbers" });
    expect(second.status).toBe(303);
    expect(flashKind(second)).toBe("warn");

    expect(await columnOf("event", EVENT, "tagline")).toBe("First writer wins");
  });

  it("moves row_version on an unversioned write too, so the next check sees it", async () => {
    // A status transition goes through the plain `update` path. If that did not
    // bump the counter, a form loaded before the transition would still compare
    // clean afterwards — a check that passes for a genuinely stale edit.
    const before = Number(await columnOf("event", EVENT, "row_version"));
    await run("UPDATE event SET tagline = ? WHERE id = ?", ["direct", EVENT]);
    const untouched = Number(await columnOf("event", EVENT, "row_version"));
    expect(untouched).toBe(before); // raw SQL is not the repository layer

    const stale = await post(cookie, `/admin/events/${EVENT}`, {
      row_version: String(before - 1),
      name: "Concurrency Conf",
      timezone: "UTC",
      starts_on: "2027-09-01",
      ends_on: "2027-09-03",
      mode: "in_person",
      visibility: "public",
      tagline: "From a stale form",
    });
    expect(flashKind(stale)).toBe("warn");
    expect(await columnOf("event", EVENT, "tagline")).toBe("direct");
  });

  it("refuses a stale call-for-proposals edit", async () => {
    const version = await renderedVersion(cookie, `/admin/cfps/${CFP}`);
    const base = {
      row_version: version,
      name: "Main CFP",
      audience: "public",
      opens_at: "2027-01-01T00:00",
      closes_at: "2027-04-01T00:00",
      late_submission_policy: "reject",
      withdraw_allowed_until: "decision",
    };

    const first = await post(cookie, `/admin/cfps/${CFP}`, { ...base, name: "Renamed by the first" });
    expect(first.status).toBe(303);
    expect(flashKind(first)).toBe("ok");

    const second = await post(cookie, `/admin/cfps/${CFP}`, { ...base, name: "Renamed by the second" });
    expect(flashKind(second)).toBe("warn");
    expect(await columnOf("call_for_proposals", CFP, "name")).toBe("Renamed by the first");
  });

  /**
   * INV-02-4 — a per-format deadline may only bring the call's own deadline
   * forward. Closing the call early therefore strands any override behind it,
   * and refusing the chair's edit over data they never touched is the wrong
   * answer: closing a call is exactly what a chair does at the deadline.
   */
  it("closing a call early pulls its format overrides in with it, rather than refusing the edit", async () => {
    await run("INSERT OR IGNORE INTO cfp_format_option (id, cfp_id, session_format_id, is_available, closes_at_override, sort_order) VALUES (?,?,?,?,?,?)", [
      "cfo_conc",
      CFP,
      FORMAT,
      1,
      "2027-03-15T00:00:00.000Z",
      0,
    ]);

    const version = await renderedVersion(cookie, `/admin/cfps/${CFP}`);
    const res = await post(cookie, `/admin/cfps/${CFP}`, {
      row_version: version,
      name: "Main CFP",
      audience: "public",
      opens_at: "2027-01-01T00:00",
      closes_at: "2027-02-01T00:00",
      late_submission_policy: "reject",
      withdraw_allowed_until: "decision",
    });
    expect(flashKind(res)).toBe("ok");

    expect(await columnOf("call_for_proposals", CFP, "closes_at")).toBe("2027-02-01T00:00:00.000Z");
    expect(await columnOf("cfp_format_option", "cfo_conc", "closes_at_override")).toBe("2027-02-01T00:00:00.000Z");
  });

  it("refuses a stale session content edit — the abstract nobody can reconstruct", async () => {
    const version = await renderedVersion(cookie, `/admin/sessions/${SESSION}`);

    const first = await post(cookie, `/admin/sessions/${SESSION}`, {
      row_version: version,
      title: "Edited by the organizer",
      abstract: "The organizer's abstract.",
    });
    expect(first.status).toBe(303);
    expect(flashKind(first)).toBe("ok");

    const second = await post(cookie, `/admin/sessions/${SESSION}`, {
      row_version: version,
      title: "Edited by the speaker",
      abstract: "The speaker's abstract.",
    });
    expect(flashKind(second)).toBe("warn");
    expect(await columnOf("session", SESSION, "title")).toBe("Edited by the organizer");
    expect(await columnOf("session", SESSION, "abstract")).toBe("The organizer's abstract.");
  });
});
