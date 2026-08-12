import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";
import { REDACTED } from "@podiumstack/domain/shared/pii.js";
import { domainEventPayload } from "@podiumstack/web/contexts/platform/views.js";

/**
 * `/admin/event-log` — 10-domain-events.md's promise that the log answers
 * "why did this speaker get that email", which had no admin screen before
 * this (finding #11). Gated on `audit.read`, the permission
 * `packages/domain/src/shared/authorization.ts` already grants to exactly
 * the roles `/admin/audit` trusts (`owner`, `admin`, `program_chair`) — every
 * one of which also holds `pii.read`, so the redaction path is exercised
 * directly against `domainEventPayload` below rather than through a second
 * admin persona the matrix does not actually have.
 */

const ORG = "org_evlog";
const EVENT = "evt_evlog";
const CHAIR_EMAIL = "evlog-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-4";
const CHAIR = "per_evlog_chair";
const REVIEWER_EMAIL = "evlog-reviewer@example.com";
const REVIEWER_PASSWORD = "a-long-enough-password-5";
const REVIEWER = "per_evlog_reviewer";

// `draft.abandoned` has exactly two subscribers (sponsorship.release_entitlement,
// platform.webhook_fanout — consumers/reactions.ts) — enough to show one
// "ran" and one "missing" row without a large fixture.
const PARENT_EVENT_ID = "evn_evlog_parent";
const CHILD_EVENT_ID = "evn_evlog_child";
const CORRELATION_ID = "req_evlog_correlation";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Event Log Org", "evlog-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Event Log Conf", "evlog-conf", "UTC", "2028-07-01", "2028-07-01", "in_person", "active", "public", "{}", now, now],
  );
  for (const [id, email, name] of [
    [CHAIR, CHAIR_EMAIL, "Chair Person"],
    [REVIEWER, REVIEWER_EMAIL, "Reviewer Person"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, ORG, email, name, "active", 0, now, now],
    );
  }
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_evlog_chair", CHAIR, "password", CHAIR_EMAIL, hashPassword(CHAIR_PASSWORD), now, CHAIR_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_evlog_reviewer", REVIEWER, "password", REVIEWER_EMAIL, hashPassword(REVIEWER_PASSWORD), now, REVIEWER_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_evlog_chair", ORG, CHAIR, "program_chair", "org", ORG, CHAIR, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_evlog_reviewer", ORG, REVIEWER, "reviewer", "event", EVENT, CHAIR, now],
  );

  await run(
    `INSERT INTO domain_event_record
       (id, type, version, occurred_at, org_id, event_id, actor_type, actor_id, actor_display, subject_type, subject_id, data, correlation_id, causation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PARENT_EVENT_ID, "draft.abandoned", 1, now, ORG, EVENT, "system", null, "system", "proposal", "prp_evlog", JSON.stringify({ proposal_id: "prp_evlog", last_activity_at: now, percent_complete: 20 }), CORRELATION_ID, null],
  );
  await run(
    `INSERT INTO domain_event_record
       (id, type, version, occurred_at, org_id, event_id, actor_type, actor_id, actor_display, subject_type, subject_id, data, correlation_id, causation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [CHILD_EVENT_ID, "entitlement.released", 1, now, ORG, EVENT, "system", null, "system", "entitlement", "ent_evlog", JSON.stringify({ entitlement_id: "ent_evlog", proposal_id: "prp_evlog", reason: "abandoned", remaining: 1 }), CORRELATION_ID, PARENT_EVENT_ID],
  );
  // Only the wildcard fan-out completed — the scenario the screen exists to
  // make visible: one handler ran, one is missing, for a fact anyone with
  // `audit.read` can see.
  await run("INSERT INTO event_reaction_log (event_id, handler, processed_at) VALUES (?,?,?)", [PARENT_EVENT_ID, "platform.webhook_fanout", now]);

  await run(
    "INSERT INTO audit_log (id, org_id, event_id, actor_type, actor_id, actor_display, action, entity_type, entity_id, reason, correlation_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ["aud_evlog_1", ORG, EVENT, "system", null, "system", "entitlement.release", "entitlement", "ent_evlog", "abandoned", CORRELATION_ID, now],
  );
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email, password }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /podium_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Sign-in for ${email} did not set a session cookie: ${setCookie}`);
  return `podium_session=${match[1]}`;
}

describe("/admin/event-log", () => {
  let chairCookie: string;
  let reviewerCookie: string;

  beforeAll(async () => {
    await seed();
    chairCookie = await signIn(CHAIR_EMAIL, CHAIR_PASSWORD);
    reviewerCookie = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
  });

  it("is denied to a role the authorization matrix does not grant audit.read", async () => {
    const res = await SELF.fetch("http://localhost/admin/event-log", { headers: { cookie: reviewerCookie }, redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("requires sign-in at all — an anonymous request is not an audit.read request", async () => {
    const res = await SELF.fetch("http://localhost/admin/event-log", { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("lists events, filterable by exact type and by subject id", async () => {
    const res = await SELF.fetch("http://localhost/admin/event-log", { headers: { cookie: chairCookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("draft.abandoned");
    expect(body).toContain("entitlement.released");

    const byType = await SELF.fetch("http://localhost/admin/event-log?type=draft.abandoned", { headers: { cookie: chairCookie } });
    const byTypeBody = await byType.text();
    expect(byTypeBody).toContain("draft.abandoned");
    expect(byTypeBody).not.toContain("entitlement.released");

    const bySubject = await SELF.fetch("http://localhost/admin/event-log?subject_id=ent_evlog", { headers: { cookie: chairCookie } });
    const bySubjectBody = await bySubject.text();
    expect(bySubjectBody).toContain("entitlement.released");
    expect(bySubjectBody).not.toContain("draft.abandoned");
  });

  it("shows which handlers ran and which are still missing, and walks the causation chain forward", async () => {
    const res = await SELF.fetch(`http://localhost/admin/event-log/${PARENT_EVENT_ID}`, { headers: { cookie: chairCookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("platform.webhook_fanout");
    expect(body).toContain("sponsorship.release_entitlement");
    // Reaction status renders as a Ran/Missing badge (`ui/layout.ts`
    // `badge`, which title-cases the value it is given).
    expect(body).toContain("Ran");
    expect(body).toContain("Missing");
    // "What this caused" lists the child by causation_id.
    expect(body).toContain("entitlement.released");
    expect(body).toContain(CHILD_EVENT_ID);
    // Neither fixture event is in `PII_EVENT_TYPES` (catalogue.ts) — the
    // redaction notice is scoped to event types that actually carry personal
    // fields, not shown on every non-`pii:read` view regardless of content.
    expect(body).not.toContain("Personal fields are hidden");
  });

  it("shows what caused it, from the child's side", async () => {
    const res = await SELF.fetch(`http://localhost/admin/event-log/${CHILD_EVENT_ID}`, { headers: { cookie: chairCookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(PARENT_EVENT_ID);
    expect(body).toContain("draft.abandoned");
  });

  it("a bad id is a clean 404, not a leak", async () => {
    const res = await SELF.fetch("http://localhost/admin/event-log/evn_does_not_exist", { headers: { cookie: chairCookie }, redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("the audit log ties a row back to its events by correlation id", async () => {
    const res = await SELF.fetch("http://localhost/admin/audit", { headers: { cookie: chairCookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/admin/event-log?correlation_id=${CORRELATION_ID}`);

    const filtered = await SELF.fetch(`http://localhost/admin/event-log?correlation_id=${CORRELATION_ID}`, { headers: { cookie: chairCookie } });
    const filteredBody = await filtered.text();
    expect(filteredBody).toContain("draft.abandoned");
    expect(filteredBody).toContain("entitlement.released");
  });
});

/**
 * INV-09-5 / INV-11-4 — personal fields are absent from a redacted payload,
 * present with `pii:read`. `domainEventPayload` (`contexts/platform/views.ts`)
 * is the one place `/admin/event-log` renders `data` in full, so it is what
 * carries the rule; exercised directly because every role the matrix grants
 * `audit.read` also holds `pii.read` (there is no "sees the log but not the
 * PII in it" admin persona to drive this through HTTP with).
 */
describe("domainEventPayload redaction", () => {
  const row = {
    id: "evn_evlog_person",
    type: "person.created",
    version: 1,
    occurred_at: new Date().toISOString(),
    org_id: ORG,
    event_id: null,
    actor_type: "system",
    actor_id: null,
    actor_display: "system",
    subject_type: "person",
    subject_id: "per_evlog_pii",
    data: JSON.stringify({ person_id: "per_evlog_pii", full_name: "Pat PII", email: "pat@example.com", source: "manual" }),
    correlation_id: null,
    causation_id: null,
  };

  it("strips full_name and email without pii:read", () => {
    const ev = domainEventPayload(row, false);
    expect((ev.data as Record<string, unknown>).full_name).toBe(REDACTED);
    expect((ev.data as Record<string, unknown>).email).toBe(REDACTED);
    expect((ev.data as Record<string, unknown>).person_id).toBe("per_evlog_pii"); // an id, not a value — fine to keep
  });

  it("includes them with pii:read", () => {
    const ev = domainEventPayload(row, true);
    expect((ev.data as Record<string, unknown>).full_name).toBe("Pat PII");
    expect((ev.data as Record<string, unknown>).email).toBe("pat@example.com");
  });
});
