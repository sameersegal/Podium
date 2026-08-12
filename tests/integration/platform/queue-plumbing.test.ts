import { createExecutionContext, createMessageBatch, env as testEnv, getQueueResult } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "@podiumstack/data/context.js";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent, runQueueBatch } from "@podiumstack/web/consumers/dispatch.js";
import { replayUnprocessedEvents } from "@podiumstack/web/consumers/replay.js";
import type { DeliveryMessage } from "@podiumstack/web/consumers/delivery.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * `runQueueBatch` (`consumers/dispatch.ts`) had zero test references before
 * this file — the plan's finding #9. Covered here against real Miniflare
 * queue message objects (`createMessageBatch` / `getQueueResult`,
 * `cloudflare:test`), not hand-rolled ack/retry stubs:
 *
 *  - a domain event whose reactions all succeed is acked;
 *  - one whose delivery throws is retried, never acked;
 *  - `podium-dlq` arrivals — event-shaped, delivery-shaped, unrecognised —
 *    are always acked, because there is nowhere further to retry them to.
 *
 * Alongside it, the two gaps finding #9 and finding #2 name specifically:
 * `deliverEvent`'s partial-failure isolation (one handler throwing must not
 * stop its siblings, and a redelivery must re-run only the one that failed —
 * `event_reaction_log` is keyed on `(event_id, handler)`), and
 * `replayUnprocessedEvents` actually recovering that exact case, which the
 * old `/dev/drain` query (`WHERE id NOT IN (SELECT event_id FROM
 * event_reaction_log)`) structurally could not: an event with *one* logged
 * handler already has a log row, so it was excluded from that query forever.
 */

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function insertDomainEventRecord(ev: DomainEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO domain_event_record
       (id, type, version, occurred_at, org_id, event_id, actor_type, actor_id, actor_display, subject_type, subject_id, data, correlation_id, causation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      ev.id,
      ev.type,
      ev.version,
      ev.occurred_at,
      ev.org_id,
      ev.event_id ?? null,
      ev.actor.type,
      ev.actor.id ?? null,
      ev.actor.display_name ?? null,
      ev.subject.type,
      ev.subject.id,
      JSON.stringify(ev.data),
      ev.correlation_id ?? null,
      ev.causation_id ?? null,
    )
    .run();
}

const ORG = "org_qplumb";
const EVENT = "evt_qplumb";

describe("runQueueBatch — podium-events", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [ORG, "Queue Plumbing Org", "qplumb-org", "UTC", "a@b.example", "{}", now, now],
    );
    await run(
      "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [EVENT, ORG, "Plumbing Conf", "qplumb-conf", "UTC", "2028-06-01", "2028-06-01", "in_person", "active", "public", "{}", now, now],
    );
  });

  it("acks a message whose event delivers without error", async () => {
    const ev = buildEvent(
      { type: "organization.created", subject: { type: "organization", id: ORG }, data: { organization_id: ORG, name: "Queue Plumbing Org", slug: "qplumb-org" } },
      { org_id: ORG, actor: SYSTEM_ACTOR, correlation_id: "req_qplumb_ack" },
    ) as DomainEvent;
    const batch = createMessageBatch("podium-events", [{ id: "msg_qplumb_ack", timestamp: new Date(), attempts: 1, body: ev }]);
    const ctx = createExecutionContext();

    await runQueueBatch(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["msg_qplumb_ack"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries a message whose event delivery throws", async () => {
    // No proposal exists at this id — `program.create_session_from_decision`
    // (`contexts/program/reactions.ts`) throws `notFound` fetching it, which
    // is enough to force `deliverEvent`'s aggregate error without any other
    // fixture: `identity.roster_from_decision` and `platform.notify_decision`
    // both no-op on a proposal that is not there rather than throwing, so
    // this is a real, single-handler failure, not a fixture bug.
    const ev = buildEvent(
      {
        type: "decision.published",
        subject: { type: "decision", id: "dec_qplumb_missing" },
        data: { decision_id: "dec_qplumb_missing", proposal_id: "prp_qplumb_missing", outcome: "accept" },
      },
      { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_qplumb_retry" },
    ) as DomainEvent;
    const batch = createMessageBatch("podium-events", [{ id: "msg_qplumb_retry", timestamp: new Date(), attempts: 1, body: ev }]);
    const ctx = createExecutionContext();

    await runQueueBatch(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m: { msgId: string }) => m.msgId)).toEqual(["msg_qplumb_retry"]);
  });
});

describe("runQueueBatch — podium-dlq", () => {
  it("records a domain-event-shaped arrival and always acks", async () => {
    const ev = buildEvent(
      { type: "proposal.submitted", subject: { type: "proposal", id: "prp_qplumb_dlq" }, data: { proposal_id: "prp_qplumb_dlq", reference: "Q-0001" } },
      { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_qplumb_dlq_event" },
    ) as DomainEvent;
    const batch = createMessageBatch("podium-dlq", [{ id: "msg_qplumb_dlq_event", timestamp: new Date(), attempts: 6, body: ev }]);
    const ctx = createExecutionContext();

    await runQueueBatch(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    // "There is nowhere further to retry it to" (dead-letter.ts) — always acked.
    expect(result.explicitAcks).toEqual(["msg_qplumb_dlq_event"]);
    expect(result.retryMessages).toEqual([]);

    const row = await env.DB.prepare("SELECT * FROM dead_letter WHERE event_id = ?").bind(ev.id).first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    expect(row?.source_queue).toBe("podium-events");
    expect(row?.message_kind).toBe("domain_event");
    expect(row?.event_type).toBe("proposal.submitted");
    expect(row?.org_id).toBe(ORG);
  });

  it("records a delivery-message-shaped arrival and always acks", async () => {
    const message: DeliveryMessage = { kind: "webhook", delivery_id: "whd_qplumb_dlq", webhook_id: "wbh_qplumb_dlq", org_id: ORG, event_id: "evn_qplumb_dlq_source" };
    const batch = createMessageBatch("podium-dlq", [{ id: "msg_qplumb_dlq_delivery", timestamp: new Date(), attempts: 7, body: message }]);
    const ctx = createExecutionContext();

    await runQueueBatch(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["msg_qplumb_dlq_delivery"]);

    const row = await env.DB.prepare("SELECT * FROM dead_letter WHERE event_id = ?").bind("evn_qplumb_dlq_source").first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    expect(row?.source_queue).toBe("podium-delivery");
    expect(row?.message_kind).toBe("delivery");
  });

  it("records an unrecognised body and still acks, rather than throwing back into a retry loop with no further queue", async () => {
    const batch = createMessageBatch("podium-dlq", [{ id: "msg_qplumb_dlq_unknown", timestamp: new Date(), attempts: 3, body: { surprise: true } }]);
    const ctx = createExecutionContext();

    await expect(runQueueBatch(batch, env, ctx)).resolves.toBeUndefined();
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["msg_qplumb_dlq_unknown"]);

    const row = await env.DB.prepare("SELECT source_queue, message_kind FROM dead_letter ORDER BY id DESC LIMIT 1").first<{ source_queue: string; message_kind: string }>();
    expect(row?.source_queue).toBe("unknown");
    expect(row?.message_kind).toBe("unknown");
  });
});

describe("deliverEvent — partial failure isolates handlers, and replayUnprocessedEvents recovers it", () => {
  const PROPOSAL = "prp_qplumb_partial";
  const CFP = "cfp_qplumb_partial";
  const SUBMITTER = "per_qplumb_partial";
  const SPONSOR = "spo_qplumb_partial";
  const SPONSORSHIP = "snp_qplumb_partial";
  // Referenced by the proposal but not created until the "fix" step below —
  // this is what makes `sponsorship.release_entitlement` throw the first
  // time and succeed the second, without mocking anything.
  const ENTITLEMENT = "ent_qplumb_partial";

  let abandoned: DomainEvent;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [CFP, EVENT, "Plumbing CFP", "plumbing", "2028-01-01T00:00:00.000Z", "2028-05-01T00:00:00.000Z", now, now],
    );
    await run(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [SUBMITTER, ORG, "qplumb-submitter@example.com", "Sam Submitter", "active", 0, now, now],
    );
    await run(
      "INSERT OR IGNORE INTO sponsor (id, org_id, name, slug, status, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
      [SPONSOR, ORG, "Acme", "acme-qplumb", "active", now, now, 1],
    );
    await run(
      "INSERT OR IGNORE INTO sponsorship (id, sponsor_id, event_id, status, confirmed_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
      [SPONSORSHIP, SPONSOR, EVENT, "confirmed", now, now, now, 1],
    );
    await run(
      `INSERT OR IGNORE INTO proposal
         (id, org_id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, sponsor_id, entitlement_id, title, abstract, status, last_activity_at, created_at, updated_at, row_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [PROPOSAL, ORG, EVENT, CFP, "frm_qplumb", "QPLUMB-0001", "sponsor", SUBMITTER, SPONSOR, ENTITLEMENT, "A sponsor talk", "An abstract.", "draft", now, now, now, 1],
    );

    abandoned = buildEvent(
      { type: "draft.abandoned", subject: { type: "proposal", id: PROPOSAL }, data: { proposal_id: PROPOSAL, last_activity_at: now, percent_complete: 15 } },
      { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_qplumb_partial" },
    ) as DomainEvent;
    // `replayUnprocessedEvents` scans `domain_event_record`, not in-memory
    // envelopes — this row is what `app.flush()` would have written for the
    // real `draft.abandoned` fact (the 14-day abandonment sweep, R22); it is
    // written directly here because this test is about the delivery and
    // recovery paths, not about reproducing the sweep that emits the fact.
    await insertDomainEventRecord(abandoned);
  });

  it("INV-04-10 (via sponsorship.release_entitlement): one handler throwing does not stop platform.webhook_fanout from running, and the aggregate error names it", async () => {
    await expect(deliverEvent(env, abandoned)).rejects.toThrow(/sponsorship\.release_entitlement/);

    const rows = await env.DB.prepare("SELECT handler FROM event_reaction_log WHERE event_id = ?").bind(abandoned.id).all<{ handler: string }>();
    const handlers = rows.results.map((r) => r.handler);
    expect(handlers).toContain("platform.webhook_fanout");
    expect(handlers).not.toContain("sponsorship.release_entitlement");
  });

  it("replayUnprocessedEvents re-runs only the missing handler, and does not duplicate the one that already succeeded", async () => {
    // The underlying cause is fixed between attempts, the same as an
    // operator would between a first failed delivery and a later replay.
    const now = new Date().toISOString();
    await run(
      "INSERT INTO entitlement (id, sponsorship_id, entitlement_type, quantity, source, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
      [ENTITLEMENT, SPONSORSHIP, "session_slot", 1, "manual", now, now, 1],
    );

    // The specific defect finding #2 named: the old `/dev/drain` query
    // (`WHERE id NOT IN (SELECT event_id FROM event_reaction_log)`) would
    // have excluded this event forever, because it already has *a* log row
    // (`platform.webhook_fanout`). `replayUnprocessedEvents` compares against
    // the full set of expected handlers (`reactionsFor`) instead, so it finds
    // this one.
    const result = await replayUnprocessedEvents(env, { graceMinutes: 0 });
    expect(result.replayed).toBeGreaterThanOrEqual(1);

    const rows = await env.DB.prepare("SELECT handler FROM event_reaction_log WHERE event_id = ?").bind(abandoned.id).all<{ handler: string }>();
    const handlers = rows.results.map((r) => r.handler);
    expect(handlers).toContain("sponsorship.release_entitlement");
    // Exactly one row for the handler that had already succeeded — the
    // replay re-ran only what `event_reaction_log` said was missing, not the
    // whole event.
    expect(handlers.filter((h) => h === "platform.webhook_fanout")).toHaveLength(1);
    expect(handlers.filter((h) => h === "sponsorship.release_entitlement")).toHaveLength(1);

    const released = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'entitlement.released' AND subject_id = ?")
      .bind(ENTITLEMENT)
      .first<{ n: number }>();
    expect(released?.n).toBe(1);
  });
});
