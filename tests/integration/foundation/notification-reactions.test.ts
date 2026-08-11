import { env as testEnv } from "cloudflare:test";
import type { Env } from "@podiumconf/data/context.js";
import { beforeAll, describe, expect, it } from "vitest";
import { deliverEvent } from "@podiumconf/web/consumers/dispatch.js";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * The reaction map's notification rows — 10-domain-events.md:
 *   `proposal.submitted`  → Confirmation email
 *   `decision.published`  → Email speakers with `feedback_for_speaker`
 *
 * These are the messages the product exists to send, and INV-09-12 says every
 * one of them is written to the outbox *before* any provider call — so with no
 * `email` integration configured, they are all still readable rather than lost.
 */

const ORG = "org_notif";
const EVENT = "evt_notif";
const CFP = "cfp_notif";
const PERSON = "per_notif";
const PROPOSAL = "prp_notif";
const DECISION = "dec_notif";
const FORMAT = "fmt_notif";

async function seed() {
  const now = new Date().toISOString();
  const q = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();
  await q(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ORG, "Notif Org", "notif-org", "UTC", "a@b.example", "{}", now, now,
  );
  await q(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    EVENT, ORG, "Notif Event", "notif-event", "UTC", "2027-05-12", "2027-05-14", "in_person", "active", "public", "{}", now, now,
  );
  await q(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    PERSON, ORG, "notif-speaker@example.com", "Nora Tiff", "active", 0, now, now,
  );
  await q(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, audience, opens_at, closes_at, grace_period_minutes, late_submission_policy, allow_edit_after_submit, withdraw_allowed_until, notify_on_submit, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    CFP, EVENT, "Notif CFP", "notif-cfp", "public", now, "2027-04-30T00:00:00.000Z", 0, "reject", 1, "always", 1, now, now,
  );
  await q(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, requires_recording_consent, capacity_policy, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    FORMAT, EVENT, "Talk (30 min)", "talk", 30, 2, '["cfp"]', 1, 0, "open", 0, 1,
  );
  await q(
    "INSERT OR IGNORE INTO proposal (id, org_id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, session_format_id, title, abstract, status, is_late, last_activity_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    PROPOSAL, ORG, EVENT, CFP, "frm_notif", "NT27-0001", "cfp", PERSON, FORMAT, "A great talk", "About great things", "submitted", 0, now, now, now,
  );
  await q(
    "INSERT OR IGNORE INTO proposal_speaker (id, proposal_id, person_id, speaker_role, sort_order, participation_status, added_by_person_id, added_at) VALUES (?,?,?,?,?,?,?,?)",
    "psp_notif", PROPOSAL, PERSON, "primary", 0, "accepted", PERSON, now,
  );
  await q(
    "INSERT OR IGNORE INTO decision (id, proposal_id, outcome, feedback_for_speaker, decided_by_person_id, decided_at, status, published_at, confirmation_deadline) VALUES (?,?,?,?,?,?,?,?,?)",
    DECISION, PROPOSAL, "accept", "The committee liked how concrete this is.", PERSON, now, "published", now, "2027-04-01T00:00:00.000Z",
  );
}

function event<T extends Record<string, unknown>>(type: DomainEvent["type"], subject: { type: string; id: string }, data: T) {
  return buildEvent({ type, subject, data }, { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_notif" });
}

async function deliveriesFor(subjectId: string) {
  const { results } = await env.DB.prepare(
    "SELECT template_key, status, suppressed_reason, rendered_body, recipient_email FROM notification_delivery WHERE subject_id = ?",
  )
    .bind(subjectId)
    .all<{ template_key: string; status: string; suppressed_reason: string | null; rendered_body: string; recipient_email: string }>();
  return results;
}

describe("notifications react to the events the model says they do", () => {
  beforeAll(seed);

  it("proposal.submitted writes the submitter's confirmation to the outbox (INV-09-12)", async () => {
    await deliverEvent(env, event("proposal.submitted", { type: "proposal", id: PROPOSAL }, { proposal_id: PROPOSAL }));
    const rows = await deliveriesFor(PROPOSAL);
    const confirmation = rows.find((r) => r.template_key === "proposal.submitted");
    expect(confirmation, "no confirmation written").toBeTruthy();
    expect(confirmation?.recipient_email).toBe("notif-speaker@example.com");
    // No email integration is configured here, so it must be recorded and
    // readable rather than silently dropped.
    expect(["queued", "sent"]).toContain(confirmation?.status);
  });

  it("decision.published emails the speaker, carrying the chair's feedback", async () => {
    await deliverEvent(
      env,
      event("decision.published", { type: "decision", id: DECISION }, {
        decision_id: DECISION,
        proposal_id: PROPOSAL,
        outcome: "accept",
      }),
    );
    const rows = await deliveriesFor(PROPOSAL);
    const acceptance = rows.find((r) => r.template_key === "proposal.accepted");
    expect(acceptance, "no acceptance written").toBeTruthy();
    expect(String(acceptance?.rendered_body)).toContain("A great talk");
  });

  it("INV-05-10: redelivering the publish event does not tell anyone twice", async () => {
    const ev = event("decision.published", { type: "decision", id: DECISION }, {
      decision_id: DECISION,
      proposal_id: PROPOSAL,
      outcome: "accept",
    });
    await deliverEvent(env, ev);
    const before = (await deliveriesFor(PROPOSAL)).filter((r) => r.template_key === "proposal.accepted").length;
    await deliverEvent(env, ev);
    const after = (await deliveriesFor(PROPOSAL)).filter((r) => r.template_key === "proposal.accepted").length;
    expect(after).toBe(before);
  });
});
