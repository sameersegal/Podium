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

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
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
    // INV-04-10 — "withdrawing or rejecting releases any entitlement hold in
    // the same transaction". `withdrawProposal` and `applyDecisionToProposal`
    // (`submissions/service.ts`) already call `emitRelease` inline, so the
    // slot is free before the response is written rather than only once a
    // queue delivers — and `expireProposal` does the same for the fourth
    // release path, `accepted --> expired`, which INV-04-10 does not name but
    // the entitlement lifecycle (03, `Entitlement`) requires for the same
    // reason: an expired acceptance never became a session, so its hold has
    // nowhere else to go.
    //
    // This reaction used to also subscribe to `proposal.withdrawn` and
    // `proposal.rejected`, so every one of those two release paths ran
    // *twice* — once inline, once again here on the event the inline call's
    // own transition emitted — producing two `entitlement.released` events
    // with different ids and two audit rows for one fact (`emitRelease` is
    // pure event-plus-audit with no state guard, so nothing caught the
    // duplicate). `draft.abandoned` is the one release path with no inline
    // call (the 14-day sweep is a cron, not a request with a response to keep
    // fast — R22), so it is the only type that still belongs here.
    name: "sponsorship.release_entitlement",
    types: ["draft.abandoned"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const proposalId = str((ev.data as Record<string, unknown>).proposal_id);
      const proposal = await proposalOf(app, proposalId);
      if (!proposal?.entitlement_id) return;
      // 03: "held --> available: draft withdrawn / abandoned / rejected".
      await emitRelease(app, str(proposal.entitlement_id), proposalId, "abandoned");
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
