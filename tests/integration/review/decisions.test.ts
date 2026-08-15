import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";
import { buildEvent, SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { templateSpec } from "@podiumstack/domain/platform/templates.js";

/**
 * INV-05-11 — "*Publishing* an `outcome = accept` requires `has_quorum`, unless
 * … the chair records an explicit `quorum_waived` reason on the decision.
 * *Recording* one provisionally does not" (R32).
 * INV-05-10 — "Publishing a decision batch sends at most one speaker
 * notification per proposal, and is idempotent on decision id."
 */

const ORG = "org_revdec";
const EVENT = "evt_revdec";
const CFP = "cfp_revdec";
const RUBRIC = "rub_revdec";
const CRITERION = "crt_revdec";
const ROUND = "rnd_revdec";
const FORMAT = "fmt_revdec"; // only PROPOSAL_SPEAKER needs one — it is the only fixture that runs the full decision.published cascade

const CHAIR_EMAIL = "revdec-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-2";
const CHAIR_PERSON = "per_revdec_chair";
const SUBMITTER_SHORT = "per_revdec_sub_short";
const SUBMITTER_FULL = "per_revdec_sub_full";
const SUBMITTER_SPEAKER = "per_revdec_sub_speaker"; // submits their own talk, credited as its speaker
const REVIEWER_1 = "per_revdec_r1";
const REVIEWER_2 = "per_revdec_r2";

const PROPOSAL_SHORT = "prp_revdec_short"; // one submitted human review — short of quorum (target 2)
const PROPOSAL_FULL = "prp_revdec_full"; // two submitted human reviews — quorum met
const PROPOSAL_SPEAKER = "prp_revdec_speaker"; // submitter is also the credited speaker
const DECISION_SPEAKER = "dec_revdec_speaker"; // already published, direct from seed — never touches the real queue

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
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Revdec Conf", "revdec-conf", "UTC", "2027-06-01", "2027-06-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "2027-01-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, requires_recording_consent, capacity_policy, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 2, '["cfp"]', 1, 0, "open", 0, 1],
  );

  for (const [id, email, name] of [
    [CHAIR_PERSON, CHAIR_EMAIL, "Chair Person"],
    [SUBMITTER_SHORT, "revdec-sub-short@example.com", "Short Submitter"],
    [SUBMITTER_FULL, "revdec-sub-full@example.com", "Full Submitter"],
    [SUBMITTER_SPEAKER, "revdec-sub-speaker@example.com", "Speaking Submitter"],
    [REVIEWER_1, "revdec-r1@example.com", "Reviewer One"],
    [REVIEWER_2, "revdec-r2@example.com", "Reviewer Two"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [id, email, name, "active", 0, now, now],
    );
  }

  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_revdec_chair", CHAIR_PERSON, "password", CHAIR_EMAIL, hashPassword(CHAIR_PASSWORD), now, CHAIR_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
    ["rg_revdec_chair", CHAIR_PERSON, "program_chair", "event", EVENT, CHAIR_PERSON, now],
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
       (id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL_SHORT, EVENT, CFP, "frm_revdec", "REVDEC-0001", SUBMITTER_SHORT, "Short of Quorum", "An abstract.", "in_review", now, now, now, 1],
  );
  await run(
    `INSERT OR IGNORE INTO proposal
       (id, event_id, cfp_id, form_id, reference, submitter_person_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL_FULL, EVENT, CFP, "frm_revdec", "REVDEC-0002", SUBMITTER_FULL, "Has Quorum", "An abstract.", "in_review", now, now, now, 1],
  );

  // A proposal whose submitter is also its credited primary speaker — the
  // common case, and the one the duplicate-email defect hid in: they belong
  // to both "the submitter" and "every speaker", the two sets
  // `platform.notify_decision` (10, reaction map) queues for. Its decision is
  // inserted already `published` rather than published through the HTTP
  // route, so this fixture is never touched by the real `EVENT_QUEUE` a live
  // publish would enqueue to — the only delivery of its `decision.published`
  // fact is the one the test below drives directly.
  await run(
    `INSERT OR IGNORE INTO proposal
       (id, event_id, cfp_id, form_id, reference, submitter_person_id, session_format_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL_SPEAKER, EVENT, CFP, "frm_revdec", "REVDEC-0003", SUBMITTER_SPEAKER, FORMAT, "Submitter Is The Speaker", "An abstract.", "accepted", now, now, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO proposal_speaker (id, proposal_id, person_id, speaker_role, sort_order, participation_status, added_by_person_id, added_at) VALUES (?,?,?,?,?,?,?,?)",
    ["psp_revdec_speaker", PROPOSAL_SPEAKER, SUBMITTER_SPEAKER, "primary", 0, "accepted", SUBMITTER_SPEAKER, now],
  );
  await run(
    `INSERT OR IGNORE INTO decision
       (id, proposal_id, outcome, conditions, feedback_for_speaker, decided_by_person_id, decided_at, status, published_at, confirmation_deadline)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      DECISION_SPEAKER,
      PROPOSAL_SPEAKER,
      "accept",
      "Please add a live demo.",
      "Loved the concreteness.",
      CHAIR_PERSON,
      now,
      "published",
      now,
      "2027-05-01T10:00:00.000Z",
    ],
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

  /** The decisions screen, and the one bucket of it a test cares about. */
  async function queues(): Promise<{ html: string; bucket: (title: string) => string }> {
    const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/decisions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    return {
      html: body,
      bucket(title: string) {
        const start = body.indexOf(title);
        if (start === -1) return "";
        const next = body.indexOf("<h2>", start + title.length);
        return body.slice(start, next === -1 ? undefined : next);
      },
    };
  }

  /** Move a proposal between the queues the way the screen does: one click. */
  async function moveTo(proposalId: string, outcome: string): Promise<void> {
    const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/decisions`, {
      method: "POST",
      body: new URLSearchParams({ proposal_id: proposalId, outcome }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
  }

  it("groups undecided proposals under the untriaged bucket before a chair has leaned either way", async () => {
    const { bucket } = await queues();
    expect(bucket("Not looked at yet")).toContain("REVDEC-0001");
    expect(bucket("Not looked at yet")).toContain("REVDEC-0002");
    // An accepted proposal is off the chair's desk, not in a queue.
    expect(bucket("Not looked at yet")).not.toContain("REVDEC-0003");
  });

  it("moves a proposal into the accept queue in one click, and out again, without touching Proposal.status", async () => {
    await moveTo(PROPOSAL_FULL, "accept");
    let view = await queues();
    expect(view.bucket("Accept queue")).toContain("REVDEC-0002");
    expect(view.bucket("Not looked at yet")).not.toContain("REVDEC-0002");

    await moveTo(PROPOSAL_FULL, "reject");
    view = await queues();
    expect(view.bucket("Reject queue")).toContain("REVDEC-0002");
    expect(view.bucket("Accept queue")).not.toContain("REVDEC-0002");

    // The queues are a projection of the provisional decision. Nothing has
    // happened to the proposal and nobody has been told.
    const proposal = await env.DB.prepare("SELECT status FROM proposal WHERE id = ?").bind(PROPOSAL_FULL).first<{ status: string }>();
    expect(proposal?.status).toBe("in_review");
    const decision = await env.DB.prepare("SELECT status, outcome FROM decision WHERE proposal_id = ?")
      .bind(PROPOSAL_FULL)
      .all<{ status: string; outcome: string }>();
    expect(decision.results).toHaveLength(1); // edited in place, not a second record
    expect(decision.results[0].status).toBe("provisional");
  });

  it("keeps the confirmation deadline when a proposal is moved between queues", async () => {
    // Set on the decision form, which sends every field...
    const form = await SELF.fetch(`http://localhost/admin/proposals/${PROPOSAL_FULL}/decision`, {
      method: "POST",
      body: new URLSearchParams({ outcome: "accept", confirmation_deadline: "2027-05-01T10:00" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(form.status).toBe(303);
    const before = await env.DB.prepare("SELECT confirmation_deadline FROM decision WHERE proposal_id = ?")
      .bind(PROPOSAL_FULL)
      .first<{ confirmation_deadline: string }>();
    expect(before?.confirmation_deadline).toBeTruthy();

    // ...and must survive a queue move, which sends only the outcome. Losing
    // it here would silently block the publish it is required for.
    await moveTo(PROPOSAL_FULL, "waitlist");
    await moveTo(PROPOSAL_FULL, "accept");
    const after = await env.DB.prepare("SELECT confirmation_deadline FROM decision WHERE proposal_id = ?")
      .bind(PROPOSAL_FULL)
      .first<{ confirmation_deadline: string }>();
    expect(after?.confirmation_deadline).toBe(before?.confirmation_deadline);
  });

  it("INV-05-11: records a provisional accept for a proposal short of quorum, so triage is not blocked on the reviews", async () => {
    const res = await SELF.fetch(`http://localhost/admin/proposals/${PROPOSAL_SHORT}/decision`, {
      method: "POST",
      body: new URLSearchParams({ outcome: "accept", confirmation_deadline: "2027-05-01T10:00" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const { results } = await env.DB.prepare("SELECT status, quorum_waived_reason FROM decision WHERE proposal_id = ?")
      .bind(PROPOSAL_SHORT)
      .all<{ status: string; quorum_waived_reason: string | null }>();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("provisional");
    expect(results[0].quorum_waived_reason).toBeFalsy();

    // The leaning is the chair's alone until they publish (R5) — nothing has
    // happened to the proposal and nobody has been told.
    const proposal = await env.DB.prepare("SELECT status FROM proposal WHERE id = ?").bind(PROPOSAL_SHORT).first<{ status: string }>();
    expect(proposal?.status).toBe("in_review");
  });

  it("INV-05-11: refuses to publish that accept while it is short of quorum and no reason is recorded", async () => {
    const decision = await env.DB.prepare("SELECT id FROM decision WHERE proposal_id = ? AND status = 'provisional'")
      .bind(PROPOSAL_SHORT)
      .first<{ id: string }>();
    expect(decision?.id).toBeTruthy();

    const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/decisions/publish`, {
      method: "POST",
      body: new URLSearchParams({ decision_id: decision!.id }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    // Skipped, not published: the speaker is the person this invariant
    // protects, and they have not been told anything.
    const after = await env.DB.prepare("SELECT status FROM decision WHERE id = ?").bind(decision!.id).first<{ status: string }>();
    expect(after?.status).toBe("provisional");
    const proposal = await env.DB.prepare("SELECT status FROM proposal WHERE id = ?").bind(PROPOSAL_SHORT).first<{ status: string }>();
    expect(proposal?.status).toBe("in_review");
  });

  it("INV-05-11: publishes that same accept once an explicit quorum_waived_reason is recorded", async () => {
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

    const decision = await env.DB.prepare("SELECT id, status, quorum_waived_reason FROM decision WHERE proposal_id = ?")
      .bind(PROPOSAL_SHORT)
      .first<{ id: string; status: string; quorum_waived_reason: string }>();
    // Edited in place — `provisional → provisional` is drawn on the diagram.
    expect(decision?.status).toBe("provisional");
    expect(decision?.quorum_waived_reason).toBeTruthy();

    const publish = await SELF.fetch(`http://localhost/admin/events/${EVENT}/decisions/publish`, {
      method: "POST",
      body: new URLSearchParams({ decision_id: decision!.id }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(publish.status).toBe(303);

    const after = await env.DB.prepare("SELECT status FROM decision WHERE id = ?").bind(decision!.id).first<{ status: string }>();
    expect(after?.status).toBe("published");
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

    // `publishDecisions` no longer writes a notification itself — that used
    // to be a second, inline writer (`writeDecisionNotification`, subject_type
    // 'decision') alongside `platform.notify_decision` reacting to the
    // `decision.published` event this same publish emits. There is now
    // exactly one writer, and it is not this request path.
    const { results: notifications } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_delivery WHERE subject_type = 'decision' AND subject_id = ?",
    )
      .bind(decisionId)
      .all<{ n: number }>();
    expect(notifications[0].n).toBe(0);

    const { results: published } = await env.DB.prepare("SELECT status FROM decision WHERE id = ?").bind(decisionId).all<{ status: string }>();
    expect(published[0].status).toBe("published");
  });

  it("INV-05-10: a submitter who is also the credited speaker gets exactly one decision email, not two", async () => {
    // Regression for the defect where `publishDecisions` wrote a
    // submitter-only notification inline *and* emitted `decision.published`,
    // which `platform.notify_decision` also queues for the submitter plus
    // every speaker — so a submitter credited as their own proposal's speaker
    // (`PROPOSAL_SPEAKER`, seeded above) landed in both sets and got the
    // acceptance letter twice, the second copy under `decision.*` template
    // keys that were never declared in `platform/templates.ts`.
    //
    // Deliver the `decision.published` fact directly (`deliverEvent` against
    // a built envelope), the same way every other reaction test in this
    // suite does, rather than through the live `EVENT_QUEUE` — this fixture
    // was seeded already-published specifically so nothing else ever
    // delivers this fact, and the count below is unambiguous.
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_delivery WHERE recipient_person_id = ?")
      .bind(SUBMITTER_SPEAKER)
      .first<{ n: number }>();
    expect(before?.n ?? 0).toBe(0);

    const ev = buildEvent(
      {
        type: "decision.published",
        subject: { type: "decision", id: DECISION_SPEAKER },
        data: { decision_id: DECISION_SPEAKER, proposal_id: PROPOSAL_SPEAKER, outcome: "accept", confirmation_deadline: "2027-05-01T10:00:00.000Z" },
      },
      { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_revdec_notify" },
    );
    await deliverEvent(env, ev);

    const rows = await env.DB.prepare(
      "SELECT template_key, rendered_body FROM notification_delivery WHERE recipient_person_id = ?",
    )
      .bind(SUBMITTER_SPEAKER)
      .all<{ template_key: string; rendered_body: string }>();
    expect(rows.results).toHaveLength(1);
    // The template key must be one `platform/templates.ts` actually declares
    // — the inline path's `decision.accepted` never was.
    expect(templateSpec(rows.results[0].template_key)).toBeTruthy();
    expect(rows.results[0].template_key).toBe("proposal.accepted");
    // `decision.conditions` — "conditions of acceptance, shown to the
    // speaker" (05, `Decision`) — reaches the body; `rationale` never would
    // (INV-05-7), and this decision has none set anyway.
    expect(rows.results[0].rendered_body).toContain("Please add a live demo.");

    // Redelivering the same fact is a no-op (INV-05-10, idempotent on
    // decision id / event id) — the dispatcher's per-`(event, handler)` log
    // is what the whole architecture leans on for this.
    await deliverEvent(env, ev);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_delivery WHERE recipient_person_id = ?")
      .bind(SUBMITTER_SPEAKER)
      .first<{ n: number }>();
    expect(after?.n ?? 0).toBe(1);
  });
});
