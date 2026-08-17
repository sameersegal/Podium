import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * The reviewer surface, client-rendered (R30).
 *
 * `/review` and `/review/:assignmentId` are the console's, and since R30's
 * second amendment they are *only* the console's — the server-rendered pages
 * that used to answer `?nojs=1` are gone, and `reviewer-surface.test.ts` with
 * them. This file absorbed what that one uniquely held: the queue's shape, and
 * where an assignment sits in it.
 *
 * What is asserted here is the payload, not the markup, because the payload is
 * how this surface loses a rule — by *sending* something it should not and
 * hiding it in the client:
 *
 * - a reviewer sees exactly their own assignments, and asking for another's by
 *   id is denied rather than empty (INV-05-18);
 * - the boot document declines an assignment that is not theirs, so the denial
 *   comes from the route rather than from a fetch inside a booted shell;
 * - reviewer identity is absent from other people's reviews unless the round is
 *   `open` (05, "Fairness rules made explicit");
 * - other reviews, the aggregate and the discussion are absent — not merely
 *   unrendered — until the reader's own review is in (INV-05-6);
 * - conflicts are counted and never listed (INV-05-18);
 * Writing a review and declining an assignment are the reviewer's own acts and
 * no API key authors either — that pair is asserted where the invariant's other
 * cases live, in `platform/api-key-scopes.test.ts` (INV-09-27).
 */

const ORG = "org_revcon";
const EVENT = "evt_revcon";
const CFP = "cfp_revcon";
const RUBRIC = "rub_revcon";
const CRITERION = "crt_revcon";
const ROUND = "rnd_revcon";

const REVIEWER_EMAIL = "revcon-reviewer@example.com";
const REVIEWER_PASSWORD = "a-long-enough-password-1";
const REVIEWER_PERSON = "per_revcon_reviewer";
const OTHER_PERSON = "per_revcon_other";
const SUBMITTER_PERSON = "per_revcon_submitter";
// Somebody our reviewer has a declared conflict with, credited on nothing here:
// the conflict has to be countable without INV-05-4 refusing the review below.
const CONFLICTED_PERSON = "per_revcon_conflicted";

const PROPOSAL_A = "prp_revcon_a";
const PROPOSAL_B = "prp_revcon_b";
const PROPOSAL_C = "prp_revcon_c";

const ASSIGNMENT_A = "asg_revcon_a";
const ASSIGNMENT_B = "asg_revcon_b";
const ASSIGNMENT_C = "asg_revcon_c"; // the other reviewer's
const ASSIGNMENT_OTHER_ON_A = "asg_revcon_other_a"; // the other reviewer, on proposal A

const OTHER_REVIEW = "rev_revcon_other";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();

  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Revcon Org", "revcon-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Revcon Conf", "revcon-conf", "UTC", "2027-06-01", "2027-06-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2027-01-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", now, now],
  );

  for (const [id, email, name] of [
    [REVIEWER_PERSON, REVIEWER_EMAIL, "Rev Console"],
    [OTHER_PERSON, "revcon-other@example.com", "Other Reviewer"],
    [SUBMITTER_PERSON, "revcon-submitter@example.com", "Sub Mitter"],
    [CONFLICTED_PERSON, "revcon-conflicted@example.com", "Con Flicted"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [id, email, name, "active", 0, now, now],
    );
  }
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_revcon_reviewer", REVIEWER_PERSON, "password", REVIEWER_EMAIL, hashPassword(REVIEWER_PASSWORD), now, REVIEWER_EMAIL, now],
  );
  for (const [id, person] of [
    ["rg_revcon_reviewer", REVIEWER_PERSON],
    ["rg_revcon_other", OTHER_PERSON],
  ]) {
    await run(
      "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
      [id, person, "reviewer", "event", EVENT, SUBMITTER_PERSON, now],
    );
  }

  await run(
    "INSERT OR IGNORE INTO rubric (id, event_id, name, version, overall_scale, requires_comment, created_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [RUBRIC, EVENT, "Screening rubric", 1, "none", 0, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO rubric_criterion (id, rubric_id, key, label, type, scale_min, scale_max, weight, is_required, allows_na, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [CRITERION, RUBRIC, "depth", "Technical depth", "numeric", 1, 5, 1, 1, 0, 0],
  );

  // `double_blind`, so the payload has to withhold both the speakers and the
  // identity of whoever else reviewed the same proposal.
  await run(
    `INSERT OR IGNORE INTO review_round
       (id, event_id, name, sequence, rubric_id, anonymity, opens_at, closes_at, target_reviews_per_proposal,
        allow_self_assignment, show_other_reviews_before_submit, discussion_enabled, status, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ROUND, EVENT, "Screening", 1, RUBRIC, "double_blind", "2027-01-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z", 2, 0, 0, 1, "open", now, now, 1],
  );
  for (const [id, person] of [
    ["rrv_revcon_reviewer", REVIEWER_PERSON],
    ["rrv_revcon_other", OTHER_PERSON],
  ]) {
    await run(
      "INSERT OR IGNORE INTO review_round_reviewer (id, round_id, person_id, pool_role, added_by_person_id, status, created_at) VALUES (?,?,?,?,?,?,?)",
      [id, ROUND, person, "reviewer", SUBMITTER_PERSON, "active", now],
    );
  }

  for (const [id, ref, title] of [
    [PROPOSAL_A, "REVCON-0001", "Assigned Proposal One"],
    [PROPOSAL_B, "REVCON-0002", "Assigned Proposal Two"],
    [PROPOSAL_C, "REVCON-0003", "Not Assigned To Our Reviewer"],
  ]) {
    await run(
      `INSERT OR IGNORE INTO proposal
         (id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, EVENT, CFP, "frm_revcon", ref, SUBMITTER_PERSON, title, "An abstract.", "in_review", now, now, now, 1],
    );
  }

  for (const [id, proposal, person, status] of [
    [ASSIGNMENT_A, PROPOSAL_A, REVIEWER_PERSON, "assigned"],
    [ASSIGNMENT_B, PROPOSAL_B, REVIEWER_PERSON, "assigned"],
    [ASSIGNMENT_C, PROPOSAL_C, OTHER_PERSON, "assigned"],
    [ASSIGNMENT_OTHER_ON_A, PROPOSAL_A, OTHER_PERSON, "submitted"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, due_at, reminder_count, assigned_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, ROUND, proposal, person, "chair", status, "2027-04-01T00:00:00.000Z", 0, now],
    );
  }

  // The other reviewer's submitted review of proposal A, which our reviewer
  // must not be shown until their own is in.
  await run(
    `INSERT OR IGNORE INTO review
       (id, assignment_id, proposal_id, round_id, reviewer_person_id, author_kind, recommendation, confidence,
        comments_for_committee, flags, status, reviewed_content_hash, submitted_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      OTHER_REVIEW,
      ASSIGNMENT_OTHER_ON_A,
      PROPOSAL_A,
      ROUND,
      OTHER_PERSON,
      "human",
      "accept",
      "high",
      "Strong submission.",
      "[]",
      "submitted",
      "hash-revcon",
      now,
      now,
      now,
      1,
    ],
  );

  await run(
    "INSERT OR IGNORE INTO conflict_of_interest (id, event_id, reviewer_person_id, subject_type, subject_id, reason, source, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["coi_revcon", EVENT, REVIEWER_PERSON, "person", CONFLICTED_PERSON, "colleague", "declared", now],
  );
}

async function signIn(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const match = /podium_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("sign-in set no session cookie");
  return `podium_session=${match[1]}`;
}

function bootPayload(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="console-boot">(.*?)<\/script>/s.exec(html);
  if (!match) throw new Error("no boot payload in the document");
  return JSON.parse(match[1].replace(/<\\\//g, "</")) as Record<string, unknown>;
}

describe("the reviewer surface, client-rendered (R30)", () => {
  beforeAll(seed);

  it("boots the console at /review, with the reviewer's own rail and no event", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch("http://localhost/review", { headers: { cookie, accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="console-boot"');
    expect(html).toContain('<body class="reviewer console">');

    const boot = bootPayload(html) as any;
    expect(boot.surface).toBe("reviewer");
    // A queue crosses rounds and can cross events, so the shell flies no event
    // bar and offers no event switcher.
    expect(boot.event).toBeNull();
    expect(boot.events).toEqual([]);
    // Two outstanding, nothing submitted, nothing declined — the rail's numbers
    // are right on the first frame rather than after the queue arrives.
    expect(boot.reviewer.counts).toEqual({ queue: 2, submitted: 0, declined: 0 });
    expect(boot.reviewer.rounds.map((r: any) => r.name)).toEqual(["Screening"]);
  });


  it("boots the console for an assignment the reader holds", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch(`http://localhost/review/${ASSIGNMENT_A}`, { headers: { cookie, accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="console-boot"');
  });

  /**
   * INV-05-18 — denied, not merely unlinked. A console shell over somebody
   * else's assignment id would be a 200, so the boot document declines the path
   * and the server-rendered route refuses it by name.
   */
  it("refuses to boot over another reviewer's assignment, and denies it instead", async () => {
    const cookie = await signIn();
    for (const id of [ASSIGNMENT_C, "asg_revcon_invented"]) {
      const res = await SELF.fetch(`http://localhost/review/${id}`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
      expect(res.status).toBe(403);
    }
  });

  it("lists exactly the reader's own assignments, and counts their conflicts without naming them", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch("http://localhost/v1/me/assignments", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.rows.map((r: any) => r.proposal.reference).sort()).toEqual(["REVCON-0001", "REVCON-0002"]);
    expect(JSON.stringify(data)).not.toContain("REVCON-0003");
    // Counted, never listed — the subject of a conflict is a person.
    expect(data.conflicts).toBe(1);
    expect(JSON.stringify(data)).not.toContain(CONFLICTED_PERSON);
  });

  /**
   * From `reviewer-surface.test.ts`, which drove the deleted server-rendered
   * pages. The behaviour it proved — "1 of 2 outstanding", and a link straight
   * to the next one — is the console's to render now, but the *data* it renders
   * from is still the server's to get right, and that is what is asserted here.
   * Without `position.next` the console has nothing to hand a reviewer working
   * a queue of seventeen, which is the whole reason this surface was ported.
   */
  it("says where an assignment sits in the outstanding queue, and what comes next", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch(`http://localhost/v1/me/assignments/${ASSIGNMENT_A}`, {
      headers: { cookie, accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.position).toEqual({ index: 0, total: 2, previous: null, next: ASSIGNMENT_B });
  });

  it("denies another reviewer's assignment by id, rather than answering an empty scorecard", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch(`http://localhost/v1/me/assignments/${ASSIGNMENT_C}`, { headers: { cookie } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.invariant).toBe("INV-05-18");
  });

  it("requires sign-in — an anonymous request is not a reviewer request", async () => {
    const res = await SELF.fetch("http://localhost/v1/me/assignments");
    expect(res.status).toBe(401);
  });

  /**
   * INV-05-6 — anchoring is real. Other reviews, the aggregate and the
   * discussion are absent from the payload, not hidden by the client: a client
   * that receives them and does not draw them has already been told.
   */
  it("withholds the other reviews and the aggregate until the reader's own review is in", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch(`http://localhost/v1/me/assignments/${ASSIGNMENT_A}`, { headers: { cookie } });
    const { data } = (await res.json()) as any;
    expect(data.can_see_others).toBe(false);
    expect(data.other_reviews).toEqual([]);
    expect(data.aggregate).toBeNull();
    expect(data.comments).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("Strong submission.");
    // And the round is double-blind, so the speakers are absent rather than
    // masked, and the payload says which rules are in force.
    expect(data.proposal.blinded).toBe(true);
    expect(data.proposal.speakers).toEqual([]);
    // The enums the scorecard is answered with come with it, so the client
    // holds no second copy of a domain enum.
    expect(data.enums.recommendation.map((o: any) => o.value)).toContain("strong_accept");
  });

  it("opens the other reviews once the reader's own is submitted, without naming who wrote them", async () => {
    const cookie = await signIn();
    const post = await SELF.fetch("http://localhost/v1/reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        assignment_id: ASSIGNMENT_A,
        intent: "submit",
        [`score_number_${CRITERION}`]: "4",
        comments_for_committee: "Solid, well scoped.",
      }),
    });
    expect(post.status).toBe(201);

    const res = await SELF.fetch(`http://localhost/v1/me/assignments/${ASSIGNMENT_A}`, { headers: { cookie } });
    const { data } = (await res.json()) as any;
    expect(data.can_see_others).toBe(true);
    expect(data.other_reviews).toHaveLength(1);
    expect(data.other_reviews[0].comments_for_committee).toBe("Strong submission.");
    // 05, "Fairness rules made explicit" — the round is not `open`, so the
    // reader learns what was said and never who said it.
    expect(data.other_reviews[0].reviewer_person_id).toBeNull();
    expect(JSON.stringify(data)).not.toContain(OTHER_PERSON);
    // And the assignment has moved, which is what the queue's counts read.
    expect(data.assignment.status).toBe("submitted");
  });

  it("declines an assignment, and the queue says so on the next read", async () => {
    const cookie = await signIn();
    const res = await SELF.fetch(`http://localhost/v1/me/assignments/${ASSIGNMENT_B}/decline`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "no_capacity", note: "Out of time this round." }),
    });
    expect(res.status).toBe(200);

    const queue = await SELF.fetch("http://localhost/v1/me/assignments", { headers: { cookie } });
    const { data } = (await queue.json()) as any;
    const declined = data.rows.find((r: any) => r.id === ASSIGNMENT_B);
    expect(declined.status).toBe("declined");
  });
});
