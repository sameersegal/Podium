import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * R24 / 05, "AI first-pass evaluation" — `generateAiReview` and
 * `overrideAiReview` were fully built to spec but unreachable from anything
 * (no route, cron or reaction), which left
 * `Organization.settings.review.ai_evaluation_enabled` a toggle that changed
 * nothing when switched on. This exercises the trigger the fix adds:
 * `POST /admin/rounds/:roundId/ai-evaluate` (bulk, behind the setting) and
 * `POST /v1/reviews/:reviewId/override` (a chair overriding one).
 */

const ORG = "org_aifp";
const EVENT = "evt_aifp";
const CFP = "cfp_aifp";
const RUBRIC = "rub_aifp";
const CRITERION = "crt_aifp";
const ROUND = "rnd_aifp";
const CHAIR_EMAIL = "aifp-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-3";
const CHAIR_PERSON = "per_aifp_chair";
const SUBMITTER = "per_aifp_submitter";
const PROPOSAL_A = "prp_aifp_a";
const PROPOSAL_B = "prp_aifp_b";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed(aiEnabled: boolean) {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      ORG,
      "AI First Pass Org",
      "aifp-org",
      "UTC",
      "a@b.example",
      JSON.stringify({ auth: { password_login_enabled: true }, review: { ai_evaluation_enabled: aiEnabled } }),
      now,
      now,
    ],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "AI First Pass Conf", "aifp-conf", "UTC", "2028-02-01", "2028-02-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2027-10-01T00:00:00.000Z", "2027-12-01T00:00:00.000Z", now, now],
  );
  for (const [id, email] of [
    [CHAIR_PERSON, CHAIR_EMAIL],
    [SUBMITTER, "aifp-submitter@example.com"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [id, email, "Someone", "active", 0, now, now],
    );
  }
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_aifp_chair", CHAIR_PERSON, "password", CHAIR_EMAIL, hashPassword(CHAIR_PASSWORD), now, CHAIR_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
    ["rg_aifp_chair", CHAIR_PERSON, "program_chair", "event", EVENT, CHAIR_PERSON, now],
  );
  await run(
    "INSERT OR IGNORE INTO rubric (id, event_id, name, version, overall_scale, requires_comment, created_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [RUBRIC, EVENT, "Screening", 1, "recommendation", 0, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO rubric_criterion (id, rubric_id, key, label, type, scale_min, scale_max, weight, is_required, allows_na, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [CRITERION, RUBRIC, "depth", "Depth", "numeric", 1, 5, 1, 1, 0, 0],
  );
  await run(
    `INSERT OR IGNORE INTO review_round
       (id, event_id, name, sequence, rubric_id, anonymity, opens_at, closes_at, target_reviews_per_proposal,
        allow_self_assignment, show_other_reviews_before_submit, discussion_enabled, status, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ROUND, EVENT, "Screening", 1, RUBRIC, "open", "2027-10-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z", 1, 0, 0, 1, "open", now, now, 1],
  );
  for (const [id, ref, title] of [
    [PROPOSAL_A, "AIFP-0001", "Proposal A"],
    [PROPOSAL_B, "AIFP-0002", "Proposal B"],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO proposal
         (id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, EVENT, CFP, "frm_aifp", ref, SUBMITTER, title, "An abstract.", "in_review", now, now, now, 1],
    );
  }
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

describe("AI first-pass review has a real trigger (R24)", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed(true);
    cookie = await signInChair();
  });

  it("is refused (403) while the org setting is off", async () => {
    await run("UPDATE organization SET settings = ? WHERE id = ?", [
      JSON.stringify({ auth: { password_login_enabled: true }, review: { ai_evaluation_enabled: false } }),
      ORG,
    ]);
    const res = await SELF.fetch(`http://localhost/admin/rounds/${ROUND}/ai-evaluate`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM review WHERE round_id = ? AND author_kind = 'ai'").bind(ROUND).first<{ n: number }>();
    expect(count?.n).toBe(0);

    // Turn it back on for the rest of the suite.
    await run("UPDATE organization SET settings = ? WHERE id = ?", [
      JSON.stringify({ auth: { password_login_enabled: true }, review: { ai_evaluation_enabled: true } }),
      ORG,
    ]);
  });

  it("POST /admin/rounds/:roundId/ai-evaluate generates one AI review per in-scope proposal without one", async () => {
    const res = await SELF.fetch(`http://localhost/admin/rounds/${ROUND}/ai-evaluate`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const rows = await env.DB.prepare(
      "SELECT proposal_id, author_kind, ai_evaluator_key, ai_model, ai_rationale, status FROM review WHERE round_id = ?",
    )
      .bind(ROUND)
      .all<{ proposal_id: string; author_kind: string; ai_evaluator_key: string; ai_model: string; ai_rationale: string; status: string }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      // INV-05-16: labelled, with an evaluator key, model and rationale.
      expect(row.author_kind).toBe("ai");
      expect(row.ai_evaluator_key).toBeTruthy();
      expect(row.ai_model).toBeTruthy();
      expect(row.ai_rationale).toBeTruthy();
      expect(row.status).toBe("submitted");
    }
  });

  it("running it again does not duplicate — already-covered proposals are skipped", async () => {
    const res = await SELF.fetch(`http://localhost/admin/rounds/${ROUND}/ai-evaluate`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM review WHERE round_id = ? AND author_kind = 'ai' AND status != 'superseded'")
      .bind(ROUND)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("has_quorum stays false — an AI review never counts (INV-05-17)", async () => {
    const res = await SELF.fetch(`http://localhost/v1/proposals/${PROPOSAL_A}/score?round_id=${ROUND}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{ score: { has_quorum: boolean; human_review_count: number; ai_review_count: number } }>();
    expect(body.score.has_quorum).toBe(false);
    expect(body.score.human_review_count).toBe(0);
    expect(body.score.ai_review_count).toBe(1);
  });

  it("POST /v1/reviews/:reviewId/override supersedes the AI review with a human one (05, 'A human can override it')", async () => {
    const ai = await env.DB.prepare("SELECT id FROM review WHERE proposal_id = ? AND author_kind = 'ai'").bind(PROPOSAL_A).first<{ id: string }>();
    expect(ai).toBeTruthy();

    const res = await SELF.fetch(`http://localhost/v1/reviews/${ai!.id}/override`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [`score_number_${CRITERION}`]: "4",
        recommendation: "accept",
        comments_for_committee: "I read it myself; the AI's read was thin.",
        reason: "Chair review — the automated pass under-weighted the novelty.",
      }),
    });
    expect(res.status).toBe(201);

    const superseded = await env.DB.prepare("SELECT status, overridden_by_person_id FROM review WHERE id = ?")
      .bind(ai!.id)
      .first<{ status: string; overridden_by_person_id: string | null }>();
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.overridden_by_person_id).toBe(CHAIR_PERSON);

    const human = await env.DB.prepare("SELECT author_kind, recommendation FROM review WHERE proposal_id = ? AND author_kind = 'human'")
      .bind(PROPOSAL_A)
      .first<{ author_kind: string; recommendation: string }>();
    expect(human?.author_kind).toBe("human");
    expect(human?.recommendation).toBe("accept");
  });

  it("the chair's own screen shows the machine's score and rationale, labelled as a machine's", async () => {
    const res = await SELF.fetch(`http://localhost/admin/proposals/${PROPOSAL_B}/review`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("AI first-pass");
    // INV-05-17 is the guardrail a chair most needs to see, so it is on the page.
    expect(body).toContain("INV-05-17");
    expect(body).toContain("Override with my own review");
  });

  it("POST /admin/reviews/:reviewId/override is the HTML twin of the /v1 route, and needs a reason", async () => {
    const ai = await env.DB.prepare("SELECT id FROM review WHERE proposal_id = ? AND author_kind = 'ai'").bind(PROPOSAL_B).first<{ id: string }>();
    expect(ai).toBeTruthy();

    const res = await SELF.fetch(`http://localhost/admin/reviews/${ai!.id}/override`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [`score_number_${CRITERION}`]: "2",
        recommendation: "reject",
        comments_for_committee: "Read it myself.",
        reason: "Chair override from the proposal screen.",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const superseded = await env.DB.prepare("SELECT status FROM review WHERE id = ?").bind(ai!.id).first<{ status: string }>();
    expect(superseded?.status).toBe("superseded");

    const human = await env.DB.prepare("SELECT author_kind, recommendation FROM review WHERE proposal_id = ? AND author_kind = 'human'")
      .bind(PROPOSAL_B)
      .first<{ author_kind: string; recommendation: string }>();
    expect(human?.recommendation).toBe("reject");
  });
});
