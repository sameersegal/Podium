/**
 * Identity's half of the reaction map — 10-domain-events.md.
 *
 * Roster rows are created as a side effect of the pipelines, so an organizer
 * who never touches the roster still has a correct one (01, `EventParticipant`).
 *
 * The dispatcher guarantees each handler runs once per `DomainEvent.id`
 * (`consumers/dispatch.ts`), but every handler here is written to be
 * re-runnable anyway: `addParticipant` and `detectMergeCandidates` are both
 * upserts, because at-least-once delivery is assumed everywhere.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { str, type Row } from "@podiumconf/data/db.js";
import type { DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { addParticipant, detectMergeCandidates } from "./service.js";

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

export const IDENTITY_REACTIONS: Reaction[] = [
  {
    name: "identity.detect_merge_candidates",
    types: ["person.created"],
    async handle(ev, env) {
      // Duplicates are surfaced, never auto-merged (01, "Person merge").
      const app = contextFor(env, ev);
      await detectMergeCandidates(app, str((ev.data as Record<string, unknown>).person_id));
      await app.flush();
    },
  },
  {
    name: "identity.roster_from_proposal",
    types: ["proposal.submitted"],
    async handle(ev, env) {
      const data = ev.data as { speaker_person_ids?: string[]; proposal_id?: string };
      if (!ev.event_id) return;
      const app = contextFor(env, ev);
      for (const personId of data.speaker_person_ids ?? []) {
        await addParticipant(app, {
          event_id: ev.event_id,
          person_id: personId,
          kind: "speaker",
          status: "invited",
          source: "proposal",
        });
      }
      await app.flush();
    },
  },
  {
    name: "identity.roster_from_decision",
    types: ["decision.published"],
    async handle(ev, env) {
      const data = ev.data as { outcome?: string; proposal_id?: string };
      if (data.outcome !== "accept" || !ev.event_id || !data.proposal_id) return;
      const app = contextFor(env, ev);
      const speakers = await app.db.raw<Row>(
        "SELECT person_id FROM proposal_speaker WHERE proposal_id = ? AND participation_status != 'removed'",
        [data.proposal_id],
      );
      for (const row of speakers) {
        // The roster answers "is this human coming to our conference";
        // `SessionSpeaker.confirmation_status` answers "is this human giving
        // that talk". Different questions, so acceptance confirms the first.
        await addParticipant(app, {
          event_id: ev.event_id,
          person_id: str(row.person_id),
          kind: "speaker",
          status: "confirmed",
          source: "decision",
          portal_access: "invited",
        });
      }
      await app.flush();
    },
  },
  {
    name: "identity.roster_after_replacement",
    types: ["session_speaker.replaced"],
    async handle(ev, env) {
      const data = ev.data as { incoming_person_id?: string; outgoing_person_id?: string };
      if (!ev.event_id || !data.incoming_person_id) return;
      const app = contextFor(env, ev);
      await addParticipant(app, {
        event_id: ev.event_id,
        person_id: data.incoming_person_id,
        kind: "speaker",
        status: "confirmed",
        source: "manual",
        portal_access: "invited",
      });
      // The outgoing person keeps their roster row — they were still coming,
      // and INV-01-10's principle applies: losing a session does not erase the
      // record that they were part of the event.
      await app.flush();
    },
  },
];
