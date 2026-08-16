import { env as testEnv } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "@podiumstack/data/context.js";
import { AppContext } from "@podiumstack/data/context.js";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { createTaskDefinition, activateTaskDefinition } from "@podiumstack/web/contexts/onboarding/service.js";
import { drain, handlerRan, stepsOfType } from "../helpers/events.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * The README's flagship claim, walked for real: `decision.published`
 * (accept) fans out into a session, a roster entry and two independent
 * onboarding materialisations — three and four hops deep, none of which any
 * test exercised before `drain` (`tests/integration/helpers/events.ts`)
 * existed, because `deliverEvent` on its own only ever delivers one hop.
 *
 * The cascade under test (10-domain-events.md, "Reactions — dispatched from
 * the queue"):
 *
 *   decision.published (accept)
 *     -> program.create_session_from_decision   => session.created
 *          -> onboarding.materialise_on_session_created   => task_instance.created
 *          -> sponsorship.spend_entitlement               => entitlement.spent
 *     -> identity.roster_from_decision           => event_participant.added
 *          -> onboarding.materialise_on_participant_added => task_instance.created
 */

const ORG = "org_dpcasc";
const EVENT = "evt_dpcasc";
const CFP = "cfp_dpcasc";
const FORMAT = "fmt_dpcasc";
const SPONSOR = "spo_dpcasc";
const SPONSORSHIP = "snp_dpcasc";
const ENTITLEMENT = "ent_dpcasc";
const SUBMITTER = "per_dpcasc_sub";
const SPEAKER = "per_dpcasc_speaker";
const PROPOSAL = "prp_dpcasc";
const DECISION = "dec_dpcasc";

const SESSION_CREATED_TASK_KEY = "dpcasc-on-session-created";
const PARTICIPANT_ADDED_TASK_KEY = "dpcasc-on-participant-added";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Decision Cascade Org", "dpcasc-org", "UTC", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Cascade Conf", "dpcasc-conf", "UTC", "2028-04-01", "2028-04-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2028-01-01T00:00:00.000Z", "2028-02-01T00:00:00.000Z", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, requires_recording_consent, capacity_policy, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 2, '["cfp","sponsor"]', 0, 0, "open", 0, 1],
  );
  await run(
    "INSERT OR IGNORE INTO sponsor (id, name, slug, status, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?)",
    [SPONSOR, "Acme", "acme-dpcasc", "active", now, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO sponsorship (id, sponsor_id, event_id, status, confirmed_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [SPONSORSHIP, SPONSOR, EVENT, "confirmed", now, now, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO entitlement (id, sponsorship_id, entitlement_type, quantity, source, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [ENTITLEMENT, SPONSORSHIP, "session_slot", 1, "manual", now, now, 1],
  );
  for (const [id, email, name] of [
    [SUBMITTER, "dpcasc-submitter@example.com", "Sam Submitter"],
    [SPEAKER, "dpcasc-speaker@example.com", "Sasha Speaker"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [id, email, name, "active", 0, now, now],
    );
  }
  await run(
    `INSERT OR IGNORE INTO proposal
       (id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, sponsor_id, entitlement_id, session_format_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL, EVENT, CFP, "frm_dpcasc", "DPCASC-0001", "sponsor", SUBMITTER, SPONSOR, ENTITLEMENT, FORMAT, "A sponsor talk", "An abstract.", "accepted", now, now, now, 1],
  );
  await run(
    "INSERT INTO proposal_speaker (id, proposal_id, person_id, speaker_role, sort_order, participation_status, added_by_person_id, added_at) VALUES (?,?,?,?,?,?,?,?)",
    ["psp_dpcasc", PROPOSAL, SPEAKER, "primary", 0, "accepted", SUBMITTER, now],
  );
  await run(
    `INSERT OR IGNORE INTO decision
       (id, proposal_id, outcome, decided_by_person_id, decided_at, status, published_at, confirmation_deadline, row_version)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [DECISION, PROPOSAL, "accept", SUBMITTER, now, "published", now, "2028-04-15T10:00:00.000Z", 1],
  );

  // Two custom TaskDefinitions, one per hop the plan names — the shipped
  // defaults (`onboarding/defaults.ts`) all trigger on `on_session_confirmed`
  // and `on_participant_confirmed`, neither of which this cascade reaches, so
  // reusing them would silently exercise zero materialisation and prove
  // nothing about the `on_session_created` / `on_participant_added` rows the
  // reaction map actually promises for this fact.
  const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
  const sessionCreatedDef = await createTaskDefinition(app, EVENT, {
    key: SESSION_CREATED_TASK_KEY,
    title: "Confirm you're speaking",
    category: "logistics",
    requirement_type: "acknowledgement",
    config: {},
    subject_type: "session",
    assignee_rule: "primary_speaker_only",
    trigger: "on_session_created",
    due_rule: "none",
    is_blocking: true,
  });
  await activateTaskDefinition(app, String(sessionCreatedDef.id));
  const participantAddedDef = await createTaskDefinition(app, EVENT, {
    key: PARTICIPANT_ADDED_TASK_KEY,
    title: "Welcome to the roster",
    category: "other",
    requirement_type: "acknowledgement",
    config: {},
    subject_type: "speaker",
    assignee_rule: "each_participant",
    trigger: "on_participant_added",
    due_rule: "none",
    is_blocking: false,
  });
  await activateTaskDefinition(app, String(participantAddedDef.id));
  await app.flush();
}

describe("decision.published (accept) — the full session/onboarding/roster cascade", () => {
  beforeAll(seed);

  // Built once and reused by the redelivery test below: idempotency is a
  // claim about the *same* `DomainEvent.id` arriving twice (an at-least-once
  // queue redelivery), not about the same fact happening again with a fresh
  // id — reusing the object is what keeps the second test honest about that.
  let publishedEvent: DomainEvent;

  it("creates the session, spends the entitlement, rosters the speaker and materialises both onboarding tasks", async () => {
    publishedEvent = buildEvent(
      {
        type: "decision.published",
        subject: { type: "decision", id: DECISION },
        data: { decision_id: DECISION, proposal_id: PROPOSAL, outcome: "accept", confirmation_deadline: "2028-04-15T10:00:00.000Z" },
      },
      { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_dpcasc_publish" },
    ) as DomainEvent;
    const ev = publishedEvent;

    const result = await drain(env, [ev]);

    // Hop 1: decision.published ran both Program's and Identity's reactions.
    expect(handlerRan(result, "program.create_session_from_decision")).toBe(true);
    expect(handlerRan(result, "identity.roster_from_decision")).toBe(true);

    // Hop 2a: session.created ran Onboarding's and Sponsorship's reactions.
    const sessionCreatedSteps = stepsOfType(result, "session.created");
    expect(sessionCreatedSteps).toHaveLength(1);
    expect(sessionCreatedSteps[0].handlers).toContain("onboarding.materialise_on_session_created");
    expect(sessionCreatedSteps[0].handlers).toContain("sponsorship.spend_entitlement");

    // Hop 2b: event_participant.added ran Onboarding's participant-level reaction.
    const participantAddedSteps = stepsOfType(result, "event_participant.added");
    expect(participantAddedSteps).toHaveLength(1);
    expect(participantAddedSteps[0].handlers).toContain("onboarding.materialise_on_participant_added");
    expect(participantAddedSteps[0].event.subject).toEqual({ type: "person", id: SPEAKER });

    // Downstream state, not just "an event fired": a real session exists,
    // linked back to the proposal (INV-06-1).
    const sessionRows = await env.DB.prepare("SELECT * FROM session WHERE proposal_id = ?").bind(PROPOSAL).all<Record<string, unknown>>();
    expect(sessionRows.results).toHaveLength(1);
    const session = sessionRows.results[0];
    expect(session.status).toBe("pending_confirmation"); // [*] --> pending_confirmation: created from accepted proposal (06)
    expect(session.origin).toBe("sponsor");
    const sessionId = String(session.id);

    // Speakers copied from the proposal as `pending` — acceptance is the
    // committee's decision, confirmation is the speaker's.
    const speakerRows = await env.DB.prepare("SELECT * FROM session_speaker WHERE session_id = ?").bind(sessionId).all<Record<string, unknown>>();
    expect(speakerRows.results).toHaveLength(1);
    expect(speakerRows.results[0].person_id).toBe(SPEAKER);
    expect(speakerRows.results[0].confirmation_status).toBe("pending");

    // Entitlement.spent — the derived consumed_count already reflects the
    // session's existence (03: "consumed_count is derived from the proposals
    // pointing at the entitlement"), and the reaction's job is the fact and
    // the audit trail, not the count.
    const spentEvents = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'entitlement.spent' AND subject_id = ?")
      .bind(ENTITLEMENT)
      .first<{ n: number }>();
    expect(spentEvents?.n).toBe(1);
    const spendAudit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'entitlement.spend' AND entity_id = ?")
      .bind(ENTITLEMENT)
      .first<{ n: number }>();
    expect(spendAudit?.n).toBe(1);

    // The roster row — "is this human coming to our conference" — confirmed
    // by the decision, distinct from SessionSpeaker's "is this human giving
    // that talk" (identity/reactions.ts).
    const participantRows = await env.DB.prepare("SELECT * FROM event_participant WHERE event_id = ? AND person_id = ?")
      .bind(EVENT, SPEAKER)
      .all<Record<string, unknown>>();
    expect(participantRows.results).toHaveLength(1);
    expect(participantRows.results[0].status).toBe("confirmed");
    expect(participantRows.results[0].source).toBe("decision");

    // Both onboarding materialisations actually produced a task, not just an
    // event that nothing consumed.
    const sessionTask = await env.DB.prepare("SELECT * FROM task_instance WHERE definition_key = ? AND session_id = ?")
      .bind(SESSION_CREATED_TASK_KEY, sessionId)
      .first<Record<string, unknown>>();
    expect(sessionTask).toBeTruthy();
    expect(sessionTask?.assignee_person_id).toBe(SPEAKER);
    expect(sessionTask?.is_blocking).toBe(1);

    const participantTask = await env.DB.prepare("SELECT * FROM task_instance WHERE definition_key = ? AND assignee_person_id = ?")
      .bind(PARTICIPANT_ADDED_TASK_KEY, SPEAKER)
      .first<Record<string, unknown>>();
    expect(participantTask).toBeTruthy();
    expect(participantTask?.subject_type).toBe("speaker");
    expect(participantTask?.subject_id).toBe(SPEAKER);

    // causation_id chains all the way from the fact that started this: every
    // hop's events carry the id of the event that caused them
    // (10-domain-events.md, "Envelope").
    const created = sessionCreatedSteps[0].event;
    expect(created.causation_id).toBe(ev.id);
    const materialised = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'task_instance.created' AND causation_id = ?")
      .bind(created.id)
      .first<{ n: number }>();
    expect(materialised?.n).toBeGreaterThan(0);
  });

  it("redelivering the same decision.published cascade end to end is a no-op (idempotent on (event id, handler))", async () => {
    // The same `DomainEvent`, same id — the "the queue redelivered the same
    // fact" case, not "the same thing happened twice".
    const ev = publishedEvent;

    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM session WHERE proposal_id = ?").bind(PROPOSAL).first<{ n: number }>();
    const beforeSpent = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'entitlement.spent' AND subject_id = ?").bind(ENTITLEMENT).first<{ n: number }>();

    const result = await drain(env, [ev]);
    // Every handler at every hop already has a logged (event_id, handler)
    // row from the first test, so nothing runs the second time — the whole
    // cascade collapses to a single no-op delivery of the seed.
    expect(result.steps.every((s) => s.handlers.length === 0)).toBe(true);

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM session WHERE proposal_id = ?").bind(PROPOSAL).first<{ n: number }>();
    const afterSpent = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'entitlement.spent' AND subject_id = ?").bind(ENTITLEMENT).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(afterSpent?.n).toBe(beforeSpent?.n);
  });
});
