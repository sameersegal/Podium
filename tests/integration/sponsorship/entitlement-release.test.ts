import { env as testEnv } from "cloudflare:test";
import type { Env } from "@podiumconf/data/context.js";
import { AppContext } from "@podiumconf/data/context.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { deliverEvent } from "@podiumconf/web/consumers/dispatch.js";
import { applyDecisionToProposal, expireProposal, withdrawProposal } from "@podiumconf/web/contexts/submissions/service.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * INV-04-10 — "withdrawing or rejecting releases any entitlement hold in the
 * same transaction." `withdrawProposal`, `applyDecisionToProposal` (reject)
 * and `expireProposal` all call `emitRelease` inline for exactly this reason
 * — the slot is free before the response is written. Before this fix,
 * `sponsorship.release_entitlement` *also* subscribed to the
 * `proposal.withdrawn` / `proposal.rejected` events those same calls emit,
 * so each release produced two `entitlement.released` events (different ids)
 * and two audit rows for one fact. `draft.abandoned` has no inline call — the
 * cron sweep (`submissions/cron.ts`) is not a request with a response to
 * keep fast (R22) — so it is the one path that should still go through the
 * reaction, and only it.
 */

const ORG = "org_entrel";
const EVENT = "evt_entrel";
const SPONSOR = "spo_entrel";
const SPONSORSHIP = "snp_entrel";
const CFP = "cfp_entrel";
const SUBMITTER = "per_entrel_sub";

const ENT_WITHDRAW = "ent_entrel_withdraw";
const ENT_REJECT = "ent_entrel_reject";
const ENT_EXPIRE = "ent_entrel_expire";
const ENT_ABANDON = "ent_entrel_abandon";

const PROP_WITHDRAW = "prp_entrel_withdraw";
const PROP_REJECT = "prp_entrel_reject";
const PROP_EXPIRE = "prp_entrel_expire";
const PROP_ABANDON = "prp_entrel_abandon";

const DECISION_REJECT = "dec_entrel_reject";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

function appFor(): AppContext {
  return new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
}

async function releaseEventCount(entitlementId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'entitlement.released' AND subject_id = ?")
    .bind(entitlementId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function releaseAuditCount(entitlementId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'entitlement.release' AND entity_id = ?")
    .bind(entitlementId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Entitlement Release Org", "entrel-org", "UTC", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Entrel Conf", "entrel-conf", "UTC", "2028-03-01", "2028-03-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Sponsor CFP", "sponsor", "2027-10-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [SUBMITTER, ORG, "entrel-submitter@example.com", "Sam Submitter", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO sponsor (id, org_id, name, slug, status, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [SPONSOR, ORG, "Acme", "acme", "active", now, now, 1],
  );
  await run(
    "INSERT OR IGNORE INTO sponsorship (id, sponsor_id, event_id, status, confirmed_at, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
    [SPONSORSHIP, SPONSOR, EVENT, "confirmed", now, now, now, 1],
  );
  for (const ent of [ENT_WITHDRAW, ENT_REJECT, ENT_EXPIRE, ENT_ABANDON]) {
    await run(
      "INSERT OR IGNORE INTO entitlement (id, sponsorship_id, entitlement_type, quantity, source, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?)",
      [ent, SPONSORSHIP, "session_slot", 1, "manual", now, now, 1],
    );
  }
  for (const [prop, ent, status, ref] of [
    [PROP_WITHDRAW, ENT_WITHDRAW, "submitted", "ENTREL-0001"],
    [PROP_REJECT, ENT_REJECT, "in_review", "ENTREL-0002"],
    [PROP_EXPIRE, ENT_EXPIRE, "accepted", "ENTREL-0003"],
    [PROP_ABANDON, ENT_ABANDON, "draft", "ENTREL-0004"],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO proposal
         (id, org_id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, sponsor_id, entitlement_id,
          title, abstract, status, confirmation_deadline, last_activity_at, created_at, updated_at, row_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [prop, ORG, EVENT, CFP, "frm_entrel", ref, "sponsor", SUBMITTER, SPONSOR, ent, "A sponsor talk", "An abstract.", status, "2020-01-01T00:00:00.000Z", now, now, now, 1],
    );
  }
  await run(
    "INSERT OR IGNORE INTO decision (id, proposal_id, outcome, decided_by_person_id, decided_at, status, row_version) VALUES (?,?,?,?,?,?,?)",
    [DECISION_REJECT, PROP_REJECT, "reject", SUBMITTER, now, "published", 1],
  );
}

describe("entitlement.released fires exactly once per release path (INV-04-10)", () => {
  beforeAll(seed);

  it("withdrawProposal releases inline, once — redelivering the resulting proposal.withdrawn event does not release again", async () => {
    const app = appFor();
    await withdrawProposal(app, PROP_WITHDRAW, "Speaker pulled out.");
    await app.flush();
    expect(await releaseEventCount(ENT_WITHDRAW)).toBe(1);
    expect(await releaseAuditCount(ENT_WITHDRAW)).toBe(1);

    // This is the redelivery finding #4 describes: `sponsorship.release_entitlement`
    // used to also subscribe to `proposal.withdrawn`, so the event the inline
    // call's own transition emits triggered a *second* release. It no longer
    // matches any reaction's `types`, so this delivers nothing.
    const handled = await deliverEvent(
      env,
      buildEvent(
        { type: "proposal.withdrawn", subject: { type: "proposal", id: PROP_WITHDRAW }, data: { proposal_id: PROP_WITHDRAW, reason: "Speaker pulled out.", withdrawn_by: null } },
        { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_entrel_redeliver" },
      ) as DomainEvent,
    );
    expect(handled).not.toContain("sponsorship.release_entitlement");
    expect(await releaseEventCount(ENT_WITHDRAW)).toBe(1);
    expect(await releaseAuditCount(ENT_WITHDRAW)).toBe(1);
  });

  it("applyDecisionToProposal(reject) releases inline, once — redelivering proposal.rejected does not release again", async () => {
    const app = appFor();
    await applyDecisionToProposal(app, PROP_REJECT, { decision_id: DECISION_REJECT, outcome: "reject" });
    await app.flush();
    expect(await releaseEventCount(ENT_REJECT)).toBe(1);

    const handled = await deliverEvent(
      env,
      buildEvent(
        { type: "proposal.rejected", subject: { type: "proposal", id: PROP_REJECT }, data: { proposal_id: PROP_REJECT, decision_id: DECISION_REJECT } },
        { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_entrel_redeliver_reject" },
      ) as DomainEvent,
    );
    expect(handled).not.toContain("sponsorship.release_entitlement");
    expect(await releaseEventCount(ENT_REJECT)).toBe(1);
  });

  it("expireProposal releases inline, exactly once (the asymmetric path finding #4 flagged — no reaction ever duplicated it)", async () => {
    const app = appFor();
    await expireProposal(app, PROP_EXPIRE);
    await app.flush();
    expect(await releaseEventCount(ENT_EXPIRE)).toBe(1);
  });

  it("draft.abandoned has no inline release — the reaction is the only path, and it still fires exactly once", async () => {
    const ev = buildEvent(
      { type: "draft.abandoned", subject: { type: "proposal", id: PROP_ABANDON }, data: { proposal_id: PROP_ABANDON, last_activity_at: new Date().toISOString(), percent_complete: 40 } },
      { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_entrel_abandon" },
    ) as DomainEvent;
    const handled = await deliverEvent(env, ev);
    expect(handled).toContain("sponsorship.release_entitlement");
    expect(await releaseEventCount(ENT_ABANDON)).toBe(1);

    // Redelivering the same event id is a no-op (idempotent on DomainEvent.id).
    await deliverEvent(env, ev);
    expect(await releaseEventCount(ENT_ABANDON)).toBe(1);
  });
});
