import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumconf/domain/identity/credentials.js";

/**
 * INV-05-11 — "`outcome = accept` requires `has_quorum`, unless … the chair
 * records an explicit `quorum_waived` reason on the decision."
 * INV-05-10 — "Publishing a decision batch sends at most one speaker
 * notification per proposal, and is idempotent on decision id."
 */

const ORG = "org_revdec";
const EVENT = "evt_revdec";
const CFP = "cfp_revdec";
const RUBRIC = "rub_revdec";
const CRITERION = "crt_revdec";
const ROUND = "rnd_revdec";

const CHAIR_EMAIL = "revdec-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-2";
const CHAIR_PERSON = "per_revdec_chair";
const SUBMITTER_SHORT = "per_revdec_sub_short";
const SUBMITTER_FULL = "per_revdec_sub_full";
const REVIEWER_1 = "per_revdec_r1";
const REVIEWER_2 = "per_revdec_r2";

const PROPOSAL_SHORT = "prp_revdec_short"; // one submitted human review — short of quorum (target 2)
const PROPOSAL_FULL = "prp_revdec_full"; // two submitted human reviews — quorum met

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();

  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Revdec Org", "revdec-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Revdec Conf", "revdec-conf", "UTC", "2027-06-01", "2027-06-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2027-01-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", now, now],
  );

  for (const [id, email, name] of [
    [CHAIR_PERSON, CHAIR_EMAIL, "Chair Person"],
    [SUBMITTER_SHORT, "revdec-sub-short@example.com", "Short Submitter"],
    [SUBMITTER_FULL, "revdec-sub-full@example.com", "Full Submitter"],
    [REVIEWER_1, "revdec-r1@example.com", "Reviewer One"],
    [REVIEWER_2, "revdec-r2@example.com", "Reviewer Two"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, ORG, email, name, "active", 0, now, now],
    );
  }

  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_revdec_chair", CHAIR_PERSON, "password", CHAIR_EMAIL, hashPassword(CHAIR_PASSWORD), now, CHAIR_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_revdec_chair", ORG, CHAIR_PERSON, "program_chair", "event", EVENT, CHAIR_PERSON, now],
  );

  await run(
    "INSERT OR IGNORE INTO rubric (id, event_id, name, version, overall_scale, requires_comment, created_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [RUBRIC, EVENT, "Screening rubric", 1, "none", 0, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO rubric_criterion (id, rubric_id, key, label, type, scale_min, scale_max, weight, is_required, allows_na, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [CRITERION, RUBRIC, "depth", "Technical depth", "numeric", 1, 5, 1, 1, 0, 0],
  );
  await run(
    `INSERT OR IGNORE INTO review_round
       (id, event_id, name, sequence, rubric_id, anonymity, opens_at, closes_at, target_reviews_per_proposal,
        allow_self_assignment, show_other_reviews_before_submit, discussion_enabled, status, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ROUND, EVENT, "Screening", 1, RUBRIC, "open", "2027-01-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z", 2, 0, 0, 1, "open", now, now, 1],
  );

  await run(
    `INSERT OR IGNORE INTO proposal
       (id, org_id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL_SHORT, ORG, EVENT, CFP, "frm_revdec", "REVDEC-0001", SUBMITTER_SHORT, "Short of Quorum", "An abstract.", "in_review", now, now, now, 1],
  );
  await run(
    `INSERT OR IGNORE INTO proposal
       (id, org_id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL_FULL, ORG, EVENT, CFP, "frm_revdec", "REVDEC-0002", SUBMITTER_FULL, "Has Quorum", "An abstract.", "in_review", now, now, now, 1],
  );

  // One submitted human review on the short proposal — one short of the round's quorum of two.
  await run(
    "INSERT INTO review (id, assignment_id, proposal_id, round_id, reviewer_person_id, author_kind, status, reviewed_content_hash, submitted_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ["rvw_revdec_short_1", null, PROPOSAL_SHORT, ROUND, REVIEWER_1, "human", "submitted", "hash1", now, now, now, 1],
  );

  // Two submitted human reviews on the full proposal — quorum met.
  await run(
    "INSERT INTO review (id, assignment_id, proposal_id, round_id, reviewer_person_id, author_kind, status, reviewed_content_hash, submitted_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ["rvw_revdec_full_1", null, PROPOSAL_FULL, ROUND, REVIEWER_1, "human", "submitted", "hash2", now, now, now, 1],
  );
  await run(
    "INSERT INTO review (id, assignment_id, proposal_id, round_id, reviewer_person_id, author_kind, status, reviewed_content_hash, submitted_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ["rvw_revdec_full_2", null, PROPOSAL_FULL, ROUND, REVIEWER_2, "human", "submitted", "hash3", now, now, now, 1],
  );

  // `latestRoundFor` (service.ts) checks assignments first, then reviews — an
  // assignment row on each proposal is what lets the decision resolve the round.
  await run(
    "INSERT INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["asg_revdec_short_1", ROUND, PROPOSAL_SHORT, REVIEWER_1, "chair", "submitted", "2027-04-01T00:00:00.000Z", 0, now, now],
  );
  await run(
    "INSERT INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["asg_revdec_full_1", ROUND, PROPOSAL_FULL, REVIEWER_1, "chair", "submitted", "2027-04-01T00:00:00.000Z", 0, now, now],
  );
  await run(
    "INSERT INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["asg_revdec_full_2", ROUND, PROPOSAL_FULL, REVIEWER_2, "chair", "submitted", "2027-04-01T00:00:00.000Z", 0, now, now],
  );
}

async function signInChair(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: CHAIR_EMAIL, password: CHAIR_PASSWORD }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /podium_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Sign-in did not set a session cookie: ${setCookie}`);
  return `podium_session=${match[1]}`;
}

describe("decisions and publishing", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signInChair();
  });

  it("INV-05-11: refuses to accept a proposal short of quorum without a waiver reason", async () => {
    const res = await SELF.fetch(`http://localhost/admin/proposals/${PROPOSAL_SHORT}/decision`, {
      method: "POST",
      body: new URLSearchParams({ outcome: "accept", confirmation_deadline: "2027-05-01T10:00" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      redirect: "manual",
    });
    expect(res.status).toBe(422);
    const body = await res.json<{ invariant?: string }>();
    expect(body.invariant).toBe("INV-05-11");

    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision WHERE proposal_id = ?").bind(PROPOSAL_SHORT).all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });

  it("INV-05-11: accepts once an explicit quorum_waived_reason is recorded", async () => {
    const res = await SELF.fetch(`http://localhost/admin/proposals/${PROPOSAL_SHORT}/decision`, {
      method: "POST",
      body: new URLSearchParams({
        outcome: "accept",
        confirmation_deadline: "2027-05-01T10:00",
        quorum_waived_reason: "The track lead read it and vouches — the second reviewer bounced.",
      }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const { results } = await env.DB.prepare("SELECT status, quorum_waived_reason FROM decision WHERE proposal_id = ?")
      .bind(PROPOSAL_SHORT)
      .all<{ status: string; quorum_waived_reason: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("provisional");
    expect(results[0].quorum_waived_reason).toBeTruthy();
  });

  it("INV-05-10: publishing a decision batch twice sends exactly one notification per proposal", async () => {
    const record = await SELF.fetch(`http://localhost/admin/proposals/${PROPOSAL_FULL}/decision`, {
      method: "POST",
      body: new URLSearchParams({ outcome: "accept", confirmation_deadline: "2027-05-01T10:00" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(record.status).toBe(303);

    const { results: decisionRows } = await env.DB.prepare("SELECT id FROM decision WHERE proposal_id = ? AND status = 'provisional'")
      .bind(PROPOSAL_FULL)
      .all<{ id: string }>();
    expect(decisionRows).toHaveLength(1);
    const decisionId = decisionRows[0].id;

    const publishOnce = async () =>
      SELF.fetch(`http://localhost/admin/events/${EVENT}/decisions/publish`, {
        method: "POST",
        body: new URLSearchParams({ decision_id: decisionId }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
      });

    const first = await publishOnce();
    expect(first.status).toBe(303);
    const second = await publishOnce();
    expect(second.status).toBe(303);

    const { results: notifications } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_delivery WHERE subject_type = 'decision' AND subject_id = ?",
    )
      .bind(decisionId)
      .all<{ n: number }>();
    expect(notifications[0].n).toBe(1);

    const { results: published } = await env.DB.prepare("SELECT status FROM decision WHERE id = ?").bind(decisionId).all<{ status: string }>();
    expect(published[0].status).toBe("published");
  });
});
