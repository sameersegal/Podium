import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import {
  createPipeline,
  enrol,
  getCard,
  moveCard,
  pushToEvent,
} from "@podiumconf/web/contexts/crm/service.js";

/**
 * 14-speaker-crm.md, "Conversion — from database to event" — INV-14-5.
 */

const ORG = "org_crm_test";
const now = () => new Date().toISOString();

async function seedFixtures() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "CRM Test Org", "crm-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();

  const eventId = "evt_crm_test";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, status, visibility, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(eventId, ORG, "CRM Test Conf", "crm-test-conf", "UTC", "2028-05-01", "2028-05-02", "active", "public", now(), now())
    .run();

  const personId = "per_crm_prospect";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(personId, ORG, "prospect@example.com", "Priya Prospect", "active", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO speaker_profile (id, person_id, org_id, job_title, company, bio, visibility, last_edited_by_person_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(newId("SpeakerProfile"), personId, ORG, "Staff Engineer", "Northwind", "Bio.", "{}", personId, now())
    .run();

  return { eventId, personId };
}

describe("Prospect conversion (INV-14-5)", () => {
  let fixtures: Awaited<ReturnType<typeof seedFixtures>>;
  let app: AppContext;

  beforeAll(async () => {
    fixtures = await seedFixtures();
    app = new AppContext({ env: env as never, orgId: ORG, actor: SYSTEM_ACTOR });
  });

  it("pushing a contact to an event creates an EventParticipant with source = crm_push, copying no profile data", async () => {
    const pipelineId = await createPipeline(app, { name: "Test pipeline" });
    await app.flush();
    const cardId = await enrol(app, { pipeline_id: pipelineId, person_id: fixtures.personId, topic: "The eval harness talk" });
    await app.flush();

    const participantId = await pushToEvent(app, { person_id: fixtures.personId, event_id: fixtures.eventId, card_id: cardId });
    await app.flush();

    const participant = await env.DB.prepare("SELECT * FROM event_participant WHERE id = ?").bind(participantId).first<Record<string, unknown>>();
    expect(participant).toBeTruthy();
    expect(participant!.source).toBe("crm_push");
    expect(participant!.person_id).toBe(fixtures.personId);
    expect(participant!.event_id).toBe(fixtures.eventId);

    // The schema itself enforces "nothing is copied": EventParticipant has no
    // name/email/company columns to copy into (14, "Conversion").
    const { results: columns } = await env.DB.prepare("PRAGMA table_info(event_participant)").all<{ name: string }>();
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain("full_name");
    expect(columnNames).not.toContain("email");
    expect(columnNames).not.toContain("company");
    expect(columnNames).not.toContain("bio");

    // The card records the outcome, and the fact is on the event log.
    const card = await getCard(app, cardId);
    expect(card.outcome_participant_id).toBe(participantId);
    const emitted = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'prospect.converted' AND subject_id = ?").bind(cardId).first<{ n: number }>();
    expect(emitted!.n).toBeGreaterThan(0);
  });

  it("INV-14-3: enrolling somebody already on the board moves the existing card rather than creating a second one", async () => {
    const pipelineId = await createPipeline(app, { name: "Second pipeline" });
    await app.flush();
    const first = await enrol(app, { pipeline_id: pipelineId, person_id: fixtures.personId });
    await app.flush();
    const second = await enrol(app, { pipeline_id: pipelineId, person_id: fixtures.personId, topic: "Re-enrolled" });
    await app.flush();

    expect(second).toBe(first);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM prospect_card WHERE pipeline_id = ? AND person_id = ?").bind(pipelineId, fixtures.personId).all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("INV-14-4: every stage change writes a transition, and entered_stage_at tracks the latest one", async () => {
    const pipelineId = await createPipeline(app, { name: "Transition pipeline" });
    await app.flush();
    const cardId = await enrol(app, { pipeline_id: pipelineId, person_id: fixtures.personId });
    await app.flush();
    const stages = await env.DB.prepare("SELECT id, kind FROM pipeline_stage WHERE pipeline_id = ? ORDER BY sort_order").bind(pipelineId).all<{ id: string; kind: string }>();
    const wonStage = stages.results.find((s) => s.kind === "won")!;

    await moveCard(app, cardId, wonStage.id, "Confirmed for the keynote.");
    await app.flush();

    const { results: transitions } = await env.DB.prepare("SELECT * FROM prospect_stage_transition WHERE card_id = ? ORDER BY created_at").bind(cardId).all<Record<string, unknown>>();
    expect(transitions.length).toBe(2); // enrolment + the move
    expect(transitions[0].from_stage_id).toBeNull();
    expect(transitions[1].to_stage_id).toBe(wonStage.id);

    const card = await env.DB.prepare("SELECT entered_stage_at FROM prospect_card WHERE id = ?").bind(cardId).first<{ entered_stage_at: string }>();
    expect(card!.entered_stage_at).toBe(transitions[1].created_at);
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP surface + authorization                                               */
/* -------------------------------------------------------------------------- */

async function signUpStaff(email: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/signup", {
    method: "POST",
    body: new URLSearchParams({ full_name: "Staff Person", email, password: "a-long-enough-password" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const person = await env.DB.prepare("SELECT id FROM person WHERE email = ?").bind(email).first<{ id: string }>();
  await env.DB.prepare(
    "INSERT INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(newId("RoleGrant"), ORG, person!.id, "admin", "org", ORG, person!.id, now())
    .run();
  return cookie;
}

describe("CRM HTTP surface", () => {
  let staffCookie: string;
  let fixtures: Awaited<ReturnType<typeof seedFixtures>>;

  beforeAll(async () => {
    fixtures = await seedFixtures();
    staffCookie = await signUpStaff("crm-staff@example.com");
  });

  it("the directory lists contacts and search finds the seeded prospect", async () => {
    const res = await SELF.fetch("http://localhost/admin/contacts?q=Priya", { headers: { cookie: staffCookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Priya Prospect");
  });

  it("the dashboard renders and drills through to the directory", async () => {
    const res = await SELF.fetch("http://localhost/admin/contacts/dashboard", { headers: { cookie: staffCookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/admin/contacts");
  });

  it("segments enforce INV-14-1 end to end: a dynamic segment with no criteria is rejected", async () => {
    const res = await SELF.fetch("http://localhost/admin/segments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: staffCookie },
      body: new URLSearchParams({ name: "Empty dynamic segment", kind: "dynamic" }),
      redirect: "manual",
    });
    expect(res.status).toBe(422);
  });

  it("an anonymous caller cannot see the contacts directory", async () => {
    const res = await SELF.fetch("http://localhost/admin/contacts");
    expect([401, 403]).toContain(res.status);
  });

  it("INV-14-6: /v1/prospects is staff-only and never reachable without authentication", async () => {
    const res = await SELF.fetch("http://localhost/v1/prospects");
    expect([401, 403]).toContain(res.status);
    const authed = await SELF.fetch("http://localhost/v1/prospects", { headers: { cookie: staffCookie } });
    expect(authed.status).toBe(200);
  });

  it("pushing a contact to an event from the directory's bulk action creates one EventParticipant", async () => {
    const res = await SELF.fetch("http://localhost/admin/contacts/bulk", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: staffCookie },
      body: new URLSearchParams({ person_id: fixtures.personId, action: "push_to_event", event_id: fixtures.eventId }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM event_participant WHERE person_id = ? AND event_id = ?").bind(fixtures.personId, fixtures.eventId).all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });
});
