/**
 * Review's row of the reaction map (10-domain-events.md):
 *
 * | `proposal.resubmitted` / `proposal.updated` | Mark affected reviews stale (INV-05-8) | Review |
 *
 * `sweepStaleReviews` and the two events it reacts to have always existed;
 * what was missing was the wiring. With nothing calling it, `review.stale`
 * was never emitted and INV-05-8 — "divergence between a submitted review's
 * `reviewed_content_hash` and the proposal's current `content_hash` sets
 * `status = stale`" — was unenforced: an organizer could edit a proposal's
 * reviewable content after it had been scored, and every existing review
 * would keep reporting itself current. This is the reaction that makes the
 * invariant real.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { str } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { sweepStaleReviews } from "./service.js";

function contextFor(env: Env, ev: DomainEvent): AppContext {
  return new AppContext({
    env,
    orgId: ev.org_id,
    eventId: ev.event_id ?? null,
    actor: SYSTEM_ACTOR,
    correlationId: ev.correlation_id ?? ev.id,
    causationId: ev.id,
  });
}

export const REVIEW_REACTIONS: Reaction[] = [
  {
    name: "review.mark_stale_on_proposal_change",
    types: ["proposal.resubmitted", "proposal.updated"],
    async handle(ev, env) {
      const proposalId = str((ev.data as Record<string, unknown>).proposal_id);
      if (!proposalId) return;
      const app = contextFor(env, ev);
      // Narrowed to this one proposal's rounds — see the comment on
      // `sweepStaleReviews` for why a per-proposal edit does not re-hash
      // every submitted review in the event.
      await sweepStaleReviews(app, { proposalId });
      await app.flush();
    },
  },
];
