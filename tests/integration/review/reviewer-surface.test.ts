import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumconf/domain/identity/credentials.js";

/**
 * INV-05-18 — "A reviewer may read only the proposals assigned to them in a
 * round whose pool they belong to. Enumerating, searching or fetching any
 * other proposal — including by guessing an identifier — is denied, not
 * merely unlinked."
 */

const ORG = "org_revsurf";
const EVENT = "evt_revsurf";
const CFP = "cfp_revsurf";
const RUBRIC = "rub_revsurf";
const CRITERION = "crt_revsurf";
const ROUND = "rnd_revsurf";

const REVIEWER_EMAIL = "revsurf-reviewer@example.com";
const REVIEWER_PASSWORD = "a-long-enough-password-1";
const OTHER_REVIEWER_EMAIL = "revsurf-other@example.com";

const REVIEWER_PERSON = "per_revsurf_reviewer";
const OTHER_REVIEWER_PERSON = "per_revsurf_other";
const SUBMITTER_PERSON = "per_revsurf_submitter";

const PROPOSAL_ASSIGNED = "prp_revsurf_a";
const PROPOSAL_ALSO_ASSIGNED = "prp_revsurf_b";
const PROPOSAL_NOT_ASSIGNED = "prp_revsurf_c";

const ASSIGNMENT_A = "asg_revsurf_a";
const ASSIGNMENT_B = "asg_revsurf_b";
const ASSIGNMENT_C = "asg_revsurf_c"; // held by the *other* reviewer

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();

  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Revsurf Org", "revsurf-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Revsurf Conf", "revsurf-conf", "UTC", "2027-06-01", "2027-06-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2027-01-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", now, now],
  );

  for (const [id, email, name] of [
    [REVIEWER_PERSON, REVIEWER_EMAIL, "Rev Surface"],
    [OTHER_REVIEWER_PERSON, OTHER_REVIEWER_EMAIL, "Other Reviewer"],
    [SUBMITTER_PERSON, "revsurf-submitter@example.com", "Sub Mitter"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, ORG, email, name, "active", 0, now, now],
    );
  }

  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_revsurf_reviewer", REVIEWER_PERSON, "password", REVIEWER_EMAIL, hashPassword(REVIEWER_PASSWORD), now, REVIEWER_EMAIL, now],
  );

  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_revsurf_reviewer", ORG, REVIEWER_PERSON, "reviewer", "event", EVENT, SUBMITTER_PERSON, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_revsurf_other", ORG, OTHER_REVIEWER_PERSON, "reviewer", "event", EVENT, SUBMITTER_PERSON, now],
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
    [ROUND, EVENT, "Screening", 1, RUBRIC, "open", "2027-01-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z", 1, 0, 0, 1, "open", now, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO review_round_reviewer (id, round_id, person_id, pool_role, added_by_person_id, status, created_at) VALUES (?,?,?,?,?,?,?)",
    ["rrv_revsurf_reviewer", ROUND, REVIEWER_PERSON, "reviewer", SUBMITTER_PERSON, "active", now],
  );
  await run(
    "INSERT OR IGNORE INTO review_round_reviewer (id, round_id, person_id, pool_role, added_by_person_id, status, created_at) VALUES (?,?,?,?,?,?,?)",
    ["rrv_revsurf_other", ROUND, OTHER_REVIEWER_PERSON, "reviewer", SUBMITTER_PERSON, "active", now],
  );

  for (const [id, ref, title] of [
    [PROPOSAL_ASSIGNED, "REVSURF-0001", "Assigned Proposal One"],
    [PROPOSAL_ALSO_ASSIGNED, "REVSURF-0002", "Assigned Proposal Two"],
    [PROPOSAL_NOT_ASSIGNED, "REVSURF-0003", "Not Assigned To Our Reviewer"],
  ]) {
    await run(
      `INSERT OR IGNORE INTO proposal
         (id, org_id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, ORG, EVENT, CFP, "frm_revsurf", ref, SUBMITTER_PERSON, title, "An abstract.", "in_review", now, now, now, 1],
    );
  }

  await run(
    "INSERT OR IGNORE INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [ASSIGNMENT_A, ROUND, PROPOSAL_ASSIGNED, REVIEWER_PERSON, "chair", "assigned", "2027-04-01T00:00:00.000Z", 0, now],
  );
  await run(
    "INSERT OR IGNORE INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [ASSIGNMENT_B, ROUND, PROPOSAL_ALSO_ASSIGNED, REVIEWER_PERSON, "chair", "assigned", "2027-04-01T00:00:00.000Z", 0, now],
  );
  await run(
    "INSERT OR IGNORE INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [ASSIGNMENT_C, ROUND, PROPOSAL_NOT_ASSIGNED, OTHER_REVIEWER_PERSON, "chair", "assigned", "2027-04-01T00:00:00.000Z", 0, now],
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

describe("the reviewer surface (INV-05-18)", () => {
  beforeAll(seed);

  it("sees exactly the proposals assigned to them, across the round, and no others", async () => {
    const cookie = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
    const res = await SELF.fetch("http://localhost/review", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("REVSURF-0001");
    expect(body).toContain("REVSURF-0002");
    expect(body).not.toContain("REVSURF-0003");
  });

  it("opens their own assignment", async () => {
    const cookie = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/review/${ASSIGNMENT_A}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Assigned Proposal One");
  });

  it("is denied — not merely unlinked — when fetching another reviewer's assignment by id", async () => {
    const cookie = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/review/${ASSIGNMENT_C}`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("is denied when guessing an identifier that does not exist at all", async () => {
    const cookie = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
    const res = await SELF.fetch("http://localhost/review/asg_does_not_exist", { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("requires sign-in at all — an anonymous request is not a reviewer request", async () => {
    const res = await SELF.fetch("http://localhost/review", { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});
