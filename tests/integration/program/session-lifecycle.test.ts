import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { deliverEvent } from "@podiumconf/web/consumers/dispatch.js";
import {
  createSessionFromProposal,
  getSession,
  restoreRevision,
  updateSessionContent,
} from "@podiumconf/web/contexts/program/service.js";

/**
 * `Session` (06-program.md) end to end, against real D1 — INV-06-1, INV-06-12
 * and INV-06-13.
 */

const ORG = "org_prog_test";
const now = () => new Date().toISOString();

function fakeDecisionPublished(overrides: Partial<DomainEvent> & { data: Record<string, unknown> }): DomainEvent {
  return {
    id: newId("DomainEventRecord"),
    type: "decision.published",
    version: 1,
    occurred_at: now(),
    org_id: ORG,
    event_id: overrides.event_id ?? null,
    actor: SYSTEM_ACTOR,
    subject: { type: "decision", id: "dec_test" },
    correlation_id: null,
    causation_id: null,
    ...overrides,
  } as DomainEvent;
}

async function seedFixtures() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Program Test Org", "program-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();

  const eventId = "evt_prog_test";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, status, visibility, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(eventId, ORG, "Program Test Conf", "program-test-conf", "UTC", "2027-05-01", "2027-05-02", "active", "public", now(), now())
    .run();

  const formatId = "fmt_prog_test";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, capacity_policy, is_public) VALUES (?,?,?,?,?,?,?,?,?,1)",
  )
    .bind(formatId, eventId, "Talk", "talk", 30, 1, '["cfp"]', 1, "open")
    .run();

  const cfpId = "cfp_prog_test";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, audience, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(cfpId, eventId, "Main CFP", "main", "public", "2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", now(), now())
    .run();

  const speakerId = "per_prog_speaker";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(speakerId, ORG, "speaker@example.com", "Sasha Speaker", "active", now(), now())
    .run();

  return { eventId, formatId, cfpId, speakerId };
}

async function seedProposal(id: string, fixtures: Awaited<ReturnType<typeof seedFixtures>>, title: string) {
  await env.DB.prepare(
    `INSERT INTO proposal (id, org_id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, title, abstract,
        session_format_id, status, last_activity_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, ORG, fixtures.eventId, fixtures.cfpId, "frm_test", `PT-${id}`, "cfp", fixtures.speakerId, title, "An abstract.", fixtures.formatId, "accepted", now(), now(), now())
    .run();
  await env.DB.prepare(
    `INSERT INTO proposal_speaker (id, proposal_id, person_id, speaker_role, sort_order, participation_status, added_by_person_id, added_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(newId("ProposalSpeaker"), id, fixtures.speakerId, "primary", 0, "accepted", fixtures.speakerId, now())
    .run();
}

async function seedDecision(id: string, proposalId: string, fixtures: Awaited<ReturnType<typeof seedFixtures>>) {
  await env.DB.prepare(
    `INSERT INTO decision (id, proposal_id, outcome, assigned_track_id, assigned_format_id, decided_by_person_id, decided_at, status, published_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, proposalId, "accept", null, fixtures.formatId, fixtures.speakerId, now(), "published", now())
    .run();
}

describe("Session creation from an accepted proposal (INV-06-1)", () => {
  let fixtures: Awaited<ReturnType<typeof seedFixtures>>;

  beforeAll(async () => {
    fixtures = await seedFixtures();
  });

  it("INV-06-1: decision.published delivered twice creates exactly one session", async () => {
    const proposalId = "prp_double_delivery";
    const decisionId = "dec_double_delivery";
    await seedProposal(proposalId, fixtures, "A Talk About Idempotency");
    await seedDecision(decisionId, proposalId, fixtures);

    const ev = fakeDecisionPublished({
      event_id: fixtures.eventId,
      data: { decision_id: decisionId, proposal_id: proposalId, outcome: "accept" },
    });

    const firstRun = await deliverEvent(env as never, ev);
    const secondRun = await deliverEvent(env as never, ev); // same DomainEvent.id — must be a no-op

    expect(firstRun).toContain("program.create_session_from_decision");
    // The dispatcher's own idempotency (event_reaction_log) makes the second
    // delivery a no-op before the handler even runs again.
    expect(secondRun).not.toContain("program.create_session_from_decision");

    const { results } = await env.DB.prepare("SELECT id, status FROM session WHERE proposal_id = ?").bind(proposalId).all();
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("pending_confirmation");
  });

  it("INV-06-1: the underlying command is itself idempotent, independent of the dispatcher's log", async () => {
    // Belt and braces — 06 says "this is also a unique index, but the
    // friendly error belongs here, and it is what makes a redelivered
    // decision.published a no-op rather than a duplicate."
    const proposalId = "prp_command_idempotent";
    const decisionId = "dec_command_idempotent";
    await seedProposal(proposalId, fixtures, "A Talk About Idempotency, Take Two");
    await seedDecision(decisionId, proposalId, fixtures);

    const app = new AppContext({ env: env as never, orgId: ORG, eventId: fixtures.eventId, actor: SYSTEM_ACTOR });
    const first = await createSessionFromProposal(app, { proposal_id: proposalId, decision_id: decisionId });
    const second = await createSessionFromProposal(app, { proposal_id: proposalId, decision_id: decisionId });
    await app.flush();

    expect(second.id).toBe(first.id);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM session WHERE proposal_id = ?").bind(proposalId).all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });
});

describe("Content editing and approval (INV-06-12, INV-06-13)", () => {
  let fixtures: Awaited<ReturnType<typeof seedFixtures>>;
  let sessionId: string;

  beforeAll(async () => {
    fixtures = await seedFixtures();
    const proposalId = "prp_content_flow";
    const decisionId = "dec_content_flow";
    await seedProposal(proposalId, fixtures, "Original Title");
    await seedDecision(decisionId, proposalId, fixtures);
    const app = new AppContext({ env: env as never, orgId: ORG, eventId: fixtures.eventId, actor: SYSTEM_ACTOR });
    const session = await createSessionFromProposal(app, { proposal_id: proposalId, decision_id: decisionId });
    await app.flush();
    sessionId = session.id;
    // Approve it so INV-06-12 has something to revoke.
    await env.DB.prepare("UPDATE session SET content_status = 'approved', content_approved_by_person_id = ?, content_approved_at = ? WHERE id = ?")
      .bind(fixtures.speakerId, now(), sessionId)
      .run();
  });

  it("INV-06-12: editing an approved session's title returns it to draft and clears the approver", async () => {
    const app = new AppContext({ env: env as never, orgId: ORG, eventId: fixtures.eventId, actor: SYSTEM_ACTOR });
    const before = await getSession(app, sessionId);
    expect(before.content_status).toBe("approved");

    const { session } = await updateSessionContent(app, sessionId, { title: "A Rewritten Title" });
    await app.flush();

    expect(session.content_status).toBe("draft");
    const row = await env.DB.prepare("SELECT content_approved_by_person_id, content_approved_at FROM session WHERE id = ?").bind(sessionId).first<{ content_approved_by_person_id: string | null; content_approved_at: string | null }>();
    expect(row?.content_approved_by_person_id).toBeNull();
    expect(row?.content_approved_at).toBeNull();
  });

  it("INV-06-13: every content edit writes exactly one revision, with a full snapshot", async () => {
    const { results } = await env.DB.prepare("SELECT revision_number, snapshot FROM session_revision WHERE session_id = ? ORDER BY revision_number").bind(sessionId).all<{ revision_number: number; snapshot: string }>();
    // decision_import (revision 1) + the INV-06-12 edit above (revision 2).
    expect(results.length).toBe(2);
    const snapshot = JSON.parse(results[results.length - 1].snapshot);
    expect(snapshot.title).toBe("A Rewritten Title");
  });

  it("INV-06-13: restore is a forward operation — it writes a new revision rather than rewinding", async () => {
    const app = new AppContext({ env: env as never, orgId: ORG, eventId: fixtures.eventId, actor: SYSTEM_ACTOR });
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_revision WHERE session_id = ?").bind(sessionId).first<{ n: number }>();
    const firstRevision = await env.DB.prepare("SELECT id, revision_number FROM session_revision WHERE session_id = ? ORDER BY revision_number LIMIT 1").bind(sessionId).first<{ id: string; revision_number: number }>();

    const newRevisionNumber = await restoreRevision(app, sessionId, firstRevision!.id);
    await app.flush();

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_revision WHERE session_id = ?").bind(sessionId).first<{ n: number }>();
    expect(after!.n).toBe(before!.n + 1); // extended, never rewound
    expect(newRevisionNumber).toBeGreaterThan(firstRevision!.revision_number);

    const restored = await env.DB.prepare("SELECT restored_from_revision_id, revision_number FROM session_revision WHERE session_id = ? ORDER BY revision_number DESC LIMIT 1").bind(sessionId).first<{ restored_from_revision_id: string; revision_number: number }>();
    expect(restored?.restored_from_revision_id).toBe(firstRevision!.id);

    // The original revision itself is untouched — restore never mutates history.
    const original = await env.DB.prepare("SELECT id FROM session_revision WHERE id = ?").bind(firstRevision!.id).first();
    expect(original).toBeTruthy();

    const session = await getSession(app, sessionId);
    expect(session.title).toBe("Original Title"); // content reverted to the restored snapshot
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP surface + PII redaction                                               */
/* -------------------------------------------------------------------------- */

async function signUpStaff(email: string): Promise<{ cookie: string; personId: string }> {
  const res = await SELF.fetch("http://localhost/signup", {
    method: "POST",
    body: new URLSearchParams({ full_name: "Staff Person", email, password: "a-long-enough-password" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  const person = await env.DB.prepare("SELECT id FROM person WHERE email = ?").bind(email).first<{ id: string }>();
  await env.DB.prepare(
    "INSERT INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(newId("RoleGrant"), ORG, person!.id, "admin", "org", ORG, person!.id, now())
    .run();
  return { cookie, personId: person!.id };
}

async function apiKeyWithScopes(scopes: string[]): Promise<string> {
  const { hashToken, newToken } = await import("@podiumconf/domain/identity/credentials.js");
  const secret = newToken();
  await env.DB.prepare(
    "INSERT INTO api_key (id, org_id, name, prefix, secret_hash, scopes, created_by_person_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(newId("ApiKey"), ORG, "test key", secret.slice(0, 6), hashToken(secret), JSON.stringify(scopes), "system", now())
    .run();
  return secret;
}

describe("Program HTTP surface", () => {
  let fixtures: Awaited<ReturnType<typeof seedFixtures>>;
  let sessionId: string;
  let staffCookie: string;

  beforeAll(async () => {
    fixtures = await seedFixtures();
    const proposalId = "prp_http_surface";
    const decisionId = "dec_http_surface";
    await seedProposal(proposalId, fixtures, "An HTTP-Visible Talk");
    await seedDecision(decisionId, proposalId, fixtures);
    const app = new AppContext({ env: env as never, orgId: ORG, eventId: fixtures.eventId, actor: SYSTEM_ACTOR });
    const session = await createSessionFromProposal(app, { proposal_id: proposalId, decision_id: decisionId });
    await app.flush();
    sessionId = session.id;
    await env.DB.prepare("UPDATE session_speaker SET travel_status = 'booked' WHERE session_id = ?").bind(sessionId).run();

    const staff = await signUpStaff("program-staff@example.com");
    staffCookie = staff.cookie;
  });

  it("renders the programme board for staff", async () => {
    const res = await SELF.fetch(`http://localhost/admin/events/${fixtures.eventId}/sessions`, { headers: { cookie: staffCookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("An HTTP-Visible Talk");
    // The program-health tiles, sponsor_session_share included.
    expect(body).toContain("sponsor share");
  });

  it("renders the session detail page", async () => {
    const res = await SELF.fetch(`http://localhost/admin/sessions/${sessionId}`, { headers: { cookie: staffCookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("An HTTP-Visible Talk");
  });

  it("INV-09-5 / INV-11-4: SessionSpeaker.travel_status is redacted from /v1/sessions/:id/speakers without pii:read, and present with it", async () => {
    // Every *person* role that can reach this endpoint also holds `pii.read`
    // (11-cross-cutting.md's matrix), so the with/without contrast is only
    // reachable through an API key, whose `includePii` follows its scopes
    // directly rather than the role matrix (`http/context.ts`).
    const withoutPii = await apiKeyWithScopes(["sessions:write"]);
    const withPii = await apiKeyWithScopes(["sessions:write", "pii:read"]);

    const redacted = await SELF.fetch(`http://localhost/v1/sessions/${sessionId}/speakers`, {
      headers: { authorization: `Bearer ${withoutPii}` },
    });
    expect(redacted.status).toBe(200);
    const redactedBody = await redacted.json<{ data: { travel_status: string | null }[] }>();
    expect(redactedBody.data.length).toBeGreaterThan(0);
    expect(redactedBody.data.some((s) => s.travel_status === "[redacted]")).toBe(true);
    expect(redactedBody.data.some((s) => s.travel_status === "booked")).toBe(false);

    const visible = await SELF.fetch(`http://localhost/v1/sessions/${sessionId}/speakers`, {
      headers: { authorization: `Bearer ${withPii}` },
    });
    expect(visible.status).toBe(200);
    const visibleBody = await visible.json<{ data: { travel_status: string | null }[] }>();
    expect(visibleBody.data.some((s) => s.travel_status === "booked")).toBe(true);
  });

  it("a request with no session cookie is turned away", async () => {
    const res = await SELF.fetch(`http://localhost/admin/events/${fixtures.eventId}/sessions`);
    expect([401, 403]).toContain(res.status);
  });
});
