/**
 * The sponsorship rows of the reaction map (10-domain-events.md).
 *
 * | `proposal.submitted`                     | hold entitlement    |
 * | `proposal.withdrawn` / `proposal.rejected` | release entitlement hold |
 * | `session.created`                        | spend entitlement   |
 * | `session.cancelled`                      | release entitlement |
 *
 * Idempotency on `DomainEvent.id` is enforced once, in `consumers/dispatch.ts`
 * — but every handler here is also written to be re-runnable, because
 * `consumed_count` is derived and re-deriving it is idempotent by construction.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { str, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { emitHold, emitRelease, spendEntitlement } from "./service.js";

function contextFor(env: Env, ev: DomainEvent): AppContext {
  return new AppContext({
    env,
    orgId: ev.org_id,
    eventId: ev.event_id ?? null,
    actor: SYSTEM_ACTOR,
    correlationId: ev.correlation_id ?? undefined,
    causationId: ev.id, // makes the cascade traceable (10, "Envelope")
  });
}

async function proposalOf(app: AppContext, proposalId: string): Promise<Row | null> {
  if (!proposalId) return null;
  return app.db.byId<Row>("proposal", proposalId, { includeDeleted: true });
}

export const SPONSORSHIP_REACTIONS: Reaction[] = [
  {
    name: "sponsorship.hold_entitlement",
    types: ["proposal.submitted"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const proposalId = str((ev.data as Record<string, unknown>).proposal_id);
      const proposal = await proposalOf(app, proposalId);
      if (!proposal?.entitlement_id) return;
      // The hold already exists — it started with the draft. Re-emitting it on
      // submit is what the sponsor portal and the nudge jobs subscribe to.
      await emitHold(app, str(proposal.entitlement_id), proposalId);
      await app.flush();
    },
  },
  {
    name: "sponsorship.release_entitlement",
    types: ["proposal.withdrawn", "proposal.rejected", "draft.abandoned"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const proposalId = str((ev.data as Record<string, unknown>).proposal_id);
      const proposal = await proposalOf(app, proposalId);
      if (!proposal?.entitlement_id) return;
      // 03: "held --> available: draft withdrawn / abandoned / rejected".
      const reason =
        ev.type === "proposal.withdrawn" ? "withdrawn" : ev.type === "proposal.rejected" ? "rejected" : "abandoned";
      await emitRelease(app, str(proposal.entitlement_id), proposalId, reason);
      await app.flush();
    },
  },
  {
    name: "sponsorship.spend_entitlement",
    types: ["session.created"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as Record<string, unknown>;
      if (str(data.origin) !== "sponsor") return;
      const proposalId = str(data.proposal_id);
      const proposal = await proposalOf(app, proposalId);
      if (!proposal?.entitlement_id) return;
      // `held --> spent`. `entitlement.exhausted` follows when the last slot
      // goes — both are emitted by `spendEntitlement`.
      await spendEntitlement(app, str(proposal.entitlement_id), str(data.session_id));
      await app.flush();
    },
  },
  {
    name: "sponsorship.release_on_session_cancelled",
    types: ["session.cancelled"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const sessionId = str((ev.data as Record<string, unknown>).session_id);
      const session = await app.db.byId<Row>("session", sessionId, { includeDeleted: true });
      if (!session?.proposal_id) return;
      const proposal = await proposalOf(app, str(session.proposal_id));
      if (!proposal?.entitlement_id) return;
      // 03: "spent --> available: session cancelled (chair action)" — also
      // INV-06-7, which requires the release as part of cancellation.
      await emitRelease(app, str(proposal.entitlement_id), str(proposal.id), "session_cancelled");
      await app.flush();
    },
  },
];
