/**
 * Program's rows of the reaction map (10-domain-events.md):
 *
 * | `decision.published` (accept) | Create session | Program, Notifications |
 * | `session_speaker.confirmed`   | Re-evaluate session confirmation; materialise per-speaker tasks | Program, Onboarding |
 *
 * `createSessionFromProposal` is itself idempotent (it looks for an existing
 * non-cancelled session on the proposal before inserting — INV-06-1), and the
 * dispatcher also guarantees each handler runs once per `DomainEvent.id`
 * (`consumers/dispatch.ts`): two independent reasons a redelivered
 * `decision.published` creates exactly one session.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { createSessionFromProposal, evaluateConfirmation } from "./service.js";

function contextFor(env: Env, ev: DomainEvent): AppContext {
  return new AppContext({
    env,
    orgId: ev.org_id,
    eventId: ev.event_id ?? null,
    // The cascade is the system acting, not the person whose click started it.
    actor: SYSTEM_ACTOR,
    correlationId: ev.correlation_id ?? ev.id,
    causationId: ev.id,
  });
}

export const PROGRAM_REACTIONS: Reaction[] = [
  {
    name: "program.create_session_from_decision",
    types: ["decision.published"],
    async handle(ev, env) {
      const data = ev.data as { outcome?: string; proposal_id?: string; decision_id?: string };
      if (data.outcome !== "accept" || !data.proposal_id) return;
      const app = contextFor(env, ev);
      await createSessionFromProposal(app, { proposal_id: data.proposal_id, decision_id: data.decision_id ?? null });
      await app.flush();
    },
  },
  {
    name: "program.reevaluate_confirmation",
    types: ["session_speaker.confirmed"],
    async handle(ev, env) {
      const data = ev.data as { session_id?: string };
      if (!data.session_id) return;
      const app = contextFor(env, ev);
      await evaluateConfirmation(app, data.session_id);
      await app.flush();
    },
  },
];
