import { env as testEnv } from "cloudflare:test";
import type { Env } from "@podiumstack/data/context.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * `REVIEW_REACTIONS` — 10-domain-events.md's reaction map.
 *
 * INV-05-8 — "divergence between a submitted review's
 * `reviewed_content_hash` and the proposal's current `content_hash` sets
 * `status = stale`" — was unenforced before this fix: `sweepStaleReviews`
 * was fully implemented but reachable from nothing (no route, cron or
 * reaction), so an organizer editing a proposal's reviewable content after
 * it had been scored left every existing review reporting itself current
 * forever. `review.mark_stale_on_proposal_change` is what makes the
 * invariant real, reacting to `proposal.resubmitted` and `proposal.updated`.
 */

const ORG = "org_rvreact";
const EVENT = "evt_rvreact";
const CFP = "cfp_rvreact";
const RUBRIC = "rub_rvreact";
const CRITERION = "crt_rvreact";
const ROUND = "rnd_rvreact";
const REVIEWER = "per_rvreact_reviewer";
const SUBMITTER = "per_rvreact_submitter";
const OTHER_SUBMITTER = "per_rvreact_other_submitter";
const PROPOSAL = "prp_rvreact"; // the one whose content changes
const OTHER_PROPOSAL = "prp_rvreact_other"; // untouched — proves the sweep is scoped, not event-wide
const ASSIGNMENT = "asg_rvreact";
const OTHER_ASSIGNMENT = "asg_rvreact_other";
const REVIEW = "rvw_rvreact";
const OTHER_REVIEW = "rvw_rvreact_other";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

function ev<T extends Record<string, unknown>>(type: DomainEvent["type"], subject: { type: string; id: string }, data: T): DomainEvent<T> {
  return buildEvent({ type, subject, data }, { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_rvreact" });
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Review React Org", "rvreact-org", "UTC", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "React Conf", "rvreact-conf", "UTC", "2028-01-01", "2028-01-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2027-10-01T00:00:00.000Z", "2027-12-01T00:00:00.000Z", now, now],
  );
  for (const [id, email] of [
    [REVIEWER, "rvreact-reviewer@example.com"],
    [SUBMITTER, "rvreact-submitter@example.com"],
    [OTHER_SUBMITTER, "rvreact-other-submitter@example.com"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [id, email, "Someone", "active", 0, now, now],
    );
  }
  await run(
    "INSERT OR IGNORE INTO rubric (id, event_id, name, version, overall_scale, requires_comment, created_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [RUBRIC, EVENT, "Screening", 1, "none", 0, now, 1],
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

  for (const [id, submitter, ref, title] of [
    [PROPOSAL, SUBMITTER, "RVREACT-0001", "Original Title"],
    [OTHER_PROPOSAL, OTHER_SUBMITTER, "RVREACT-0002", "A Different Talk"],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO proposal
         (id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, EVENT, CFP, "frm_rvreact", ref, submitter, title, "An abstract.", "in_review", now, now, now, 1],
    );
  }

  await run(
    "INSERT INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, reminder_count, assigned_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [ASSIGNMENT, ROUND, PROPOSAL, REVIEWER, "chair", "submitted", 0, now, now],
  );
  await run(
    "INSERT INTO review_assignment (id, round_id, proposal_id, reviewer_person_id, assigned_by, status, reminder_count, assigned_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [OTHER_ASSIGNMENT, ROUND, OTHER_PROPOSAL, REVIEWER, "chair", "submitted", 0, now, now],
  );
  // Both reviews are submitted with a `reviewed_content_hash` that will never
  // match a freshly computed hash — the fixture does not need to reproduce
  // the real hashing algorithm, only prove that a mismatch is detected for
  // the changed proposal and left alone for the untouched one.
  await run(
    "INSERT INTO review (id, assignment_id, proposal_id, round_id, reviewer_person_id, author_kind, status, reviewed_content_hash, submitted_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [REVIEW, ASSIGNMENT, PROPOSAL, ROUND, REVIEWER, "human", "submitted", "stale-marker-hash", now, now, now, 1],
  );
  await run(
    "INSERT INTO review (id, assignment_id, proposal_id, round_id, reviewer_person_id, author_kind, status, reviewed_content_hash, submitted_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [OTHER_REVIEW, OTHER_ASSIGNMENT, OTHER_PROPOSAL, ROUND, REVIEWER, "human", "submitted", "stale-marker-hash", now, now, now, 1],
  );
}

describe("review.mark_stale_on_proposal_change (INV-05-8)", () => {
  beforeAll(seed);

  it("proposal.updated marks that proposal's submitted reviews stale and emits review.stale", async () => {
    const handled = await deliverEvent(env, ev("proposal.updated", { type: "proposal", id: PROPOSAL }, { proposal_id: PROPOSAL, changed_fields: ["abstract"], change_kind: "organizer_edit" }));
    expect(handled).toContain("review.mark_stale_on_proposal_change");

    const row = await env.DB.prepare("SELECT status FROM review WHERE id = ?").bind(REVIEW).first<{ status: string }>();
    expect(row?.status).toBe("stale");

    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'review.stale' AND subject_id = ?")
      .bind(REVIEW)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it("does not touch another proposal's reviews — the sweep is scoped to the proposal named in the event", async () => {
    const row = await env.DB.prepare("SELECT status FROM review WHERE id = ?").bind(OTHER_REVIEW).first<{ status: string }>();
    expect(row?.status).toBe("submitted");
  });
});
