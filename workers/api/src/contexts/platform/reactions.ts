/**
 * The platform rows of the reaction map (10-domain-events.md).
 *
 * Platform reacts **last**: webhook fan-out and notification delivery react to
 * everything, including the events the handlers in every other context raise
 * (`consumers/reactions.ts` orders `PLATFORM_REACTIONS` after the rest).
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { eventTypeMatches, liveEventTypes } from "@podiumconf/domain/events/catalogue.js";
import { kickFromRoom, pokeRooms } from "@podiumconf/data/live.js";
import { SYNC_DIRTY_EVENT_TYPES, SYNC_DIRTY_RULES } from "@podiumconf/domain/platform/sync.js";
import type { Reaction } from "../../consumers/reactions.js";
import { queueNotification } from "./notifications.js";
import { scheduleWebhookDelivery } from "./service.js";
import { activeMappings, markDirty } from "./sync.js";
import { scheduleErase, schedulePush } from "./sync-delivery.js";
import { adapterFor } from "./sync-subjects.js";

function contextFor(env: Env, ev: DomainEvent): AppContext {
  return new AppContext({
    env,
    orgId: ev.org_id,
    eventId: ev.event_id ?? null,
    actor: SYSTEM_ACTOR,
    correlationId: ev.correlation_id ?? undefined,
    causationId: ev.id,
  });
}

export const PLATFORM_REACTIONS: Reaction[] = [
  {
    // "`PLATFORM_REACTIONS` includes a `*` reaction fanning every domain event
    // out to matching webhooks by enqueuing a delivery" — the task brief.
    name: "platform.webhook_fanout",
    types: ["*"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const webhooks = await app.db.select<Row>("webhook", { status: "active" });
      for (const webhook of webhooks) {
        if (webhook.event_id && str(webhook.event_id) !== ev.event_id) continue; // scoped to a different event
        const patterns = JSON.parse(str(webhook.event_types, "[]")) as string[];
        if (!patterns.some((p) => eventTypeMatches(p, ev.type))) continue;
        await scheduleWebhookDelivery(app, str(webhook.id), ev.id);
      }
      await app.flush();
    },
  },
  {
    // 10, reaction map: `proposal.submitted` → "Confirmation email". Honours
    // `CallForProposals.notify_on_submit`, which is the organizer's switch for
    // exactly this message.
    name: "platform.confirm_submission",
    types: ["proposal.submitted"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const proposal = await app.db.byId<Row>("proposal", str((ev.data as Record<string, unknown>).proposal_id));
      if (!proposal) return;
      const cfp = await app.db.byId<Row>("call_for_proposals", str(proposal.cfp_id));
      if (cfp && !num(cfp.notify_on_submit, 1)) return;
      await queueNotification(app, {
        template_key: "proposal.submitted",
        recipient_person_id: str(proposal.submitter_person_id),
        subject_type: "proposal",
        subject_id: str(proposal.id),
        variables: { proposal: { reference: str(proposal.reference), title: str(proposal.title) } },
      });
      await app.flush();
    },
  },
  {
    // 10, reaction map: `decision.published` → "email speakers", for every
    // outcome. This is the one channel to the speaker, and a human wrote its
    // `feedback_for_speaker` (05, "Discussion").
    //
    // This used to run alongside a second, inline notification write in
    // `publishDecisions` (`review/service.ts`) that sent the submitter a copy
    // directly. A submitter who is also a speaker — the common case — was in
    // both sets, so they got the acceptance letter twice, and the inline copy
    // used `decision.*` template keys that were never declared in
    // `platform/templates.ts`. This reaction is now the only writer
    // (INV-05-10: at most one speaker notification per proposal); the
    // dispatcher's per-`(event, handler)` idempotency plus the `Set` below
    // are what keep a redelivered event, or a submitter who is also credited
    // as a speaker, to exactly one send each.
    name: "platform.notify_decision",
    types: ["decision.published"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as Record<string, unknown>;
      const outcome = str(data.outcome);
      const template =
        outcome === "accept"
          ? "proposal.accepted"
          : outcome === "waitlist"
            ? "proposal.waitlisted"
            : outcome === "request_changes"
              ? "proposal.changes_requested"
              : "proposal.rejected";
      const proposalId = str(data.proposal_id);
      const proposal = await app.db.byId<Row>("proposal", proposalId);
      if (!proposal) return;
      const decision = await app.db.byId<Row>("decision", str(data.decision_id));
      const speakers = await app.db.raw<Row>(
        "SELECT person_id FROM proposal_speaker WHERE proposal_id = ? AND participation_status != 'removed'",
        [proposalId],
      );
      // INV-05-10: at most one speaker notification per proposal. The
      // dispatcher already makes this idempotent on the event id; the loop is
      // over the people credited on that one proposal, not over decisions.
      const recipients = new Set<string>([str(proposal.submitter_person_id), ...speakers.map((r) => str(r.person_id))]);
      const feedback = strOrNull(decision?.feedback_for_speaker) ?? "";
      for (const personId of recipients) {
        await queueNotification(app, {
          template_key: template,
          recipient_person_id: personId,
          subject_type: "proposal",
          subject_id: proposalId,
          variables: {
            proposal: { reference: str(proposal.reference), title: str(proposal.title) },
            session: { title: str(proposal.title) },
            // Names must match what each template actually declares
            // (`platform/templates.ts`) — `proposal.accepted`/`waitlisted`/
            // `rejected` read `decision.feedback`, `changes_requested` reads
            // the same content under `decision.note`. This block used to pass
            // flat `feedback_for_speaker` / `confirmation_deadline` keys that
            // no template referenced, so those lines silently rendered empty
            // in every decision email; wiring the removal of the duplicate
            // inline copy (which *did* show them) surfaced it.
            "decision.feedback": feedback,
            "decision.note": feedback,
            "decision.confirmation_deadline": strOrNull(decision?.confirmation_deadline) ?? "",
            // "Conditions of acceptance, shown to the speaker" (05, `Decision`).
            // `rationale` is deliberately never read here — INV-05-7,
            // committee-only, never reaches the submitter.
            "decision.conditions": strOrNull(decision?.conditions) ?? "",
          },
        });
      }
      await app.flush();
    },
  },
  {
    // 10, reaction map: `schedule.published` → "notify affected speakers".
    // `schedule.changed` carries the diff, and speakers hear about a change
    // when it is real — which is why these fire on publication, not on every
    // drag in the planning UI.
    name: "platform.notify_schedule_change",
    types: ["schedule.changed"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const diff = ((ev.data as Record<string, unknown>).diff ?? []) as { change_type?: string; session_id?: string }[];
      const affected = diff.filter((d) => d.change_type === "time_changed" || d.change_type === "room_changed");
      for (const entry of affected) {
        if (!entry.session_id) continue;
        const session = await app.db.byId<Row>("session", entry.session_id);
        if (!session) continue;
        const placement = await app.db.first<Row>("placement", { session_id: entry.session_id });
        const room = placement ? await app.db.byId<Row>("room", str(placement.room_id)) : null;
        const speakers = await app.db.raw<Row>(
          "SELECT person_id FROM session_speaker WHERE session_id = ? AND confirmation_status NOT IN ('declined','replaced')",
          [entry.session_id],
        );
        for (const s of speakers) {
          await queueNotification(app, {
            template_key: "schedule.changed",
            recipient_person_id: str(s.person_id),
            subject_type: "session",
            subject_id: entry.session_id,
            variables: {
              session: {
                title: str(session.title),
                starts_at: placement ? str(placement.starts_at) : "",
                room: room ? str(room.name) : "",
              },
            },
          });
        }
      }
      await app.flush();
    },
  },
  {
    // 10, reaction map: `entitlement.expiring_soon` → "Nudge the sponsor
    // contact", Notifications only.
    name: "platform.nudge_entitlement_expiring",
    types: ["entitlement.expiring_soon"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as Record<string, unknown>;
      const sponsorId = str(data.sponsor_id);
      const sponsor = sponsorId ? await app.db.byId<Row>("sponsor", sponsorId) : null;
      const entitlement = await app.db.byId<Row>("entitlement", str(data.entitlement_id));
      const contacts = await app.db.raw<Row>("SELECT person_id FROM sponsor_contact WHERE sponsor_id = ? AND status = 'active'", [sponsorId]);
      for (const c of contacts) {
        await queueNotification(app, {
          template_key: "entitlement.expiring_soon",
          recipient_person_id: str(c.person_id),
          subject_type: "entitlement",
          subject_id: str(data.entitlement_id),
          variables: {
            "sponsor.name": sponsor ? str(sponsor.name) : "",
            "entitlement.type": entitlement ? str(entitlement.entitlement_type) : "",
            remaining: num(data.remaining),
            expires_at: strOrNull(data.expires_at) ?? "",
            days_remaining: num(data.days_remaining),
          },
        });
      }
      await app.flush();
    },
  },
  {
    /**
     * The durable half of live updates. `AppContext.flush` already poked the
     * room directly, in the request, within ~100ms; this is what happens when
     * that poke never landed — the Worker died, the object was unreachable,
     * the event arrived through the replay sweeper instead. The room dedupes
     * on `DomainEvent.id`, so the common case where both arrive is one frame.
     *
     * An explicit `types` list rather than `["*"]`: the dispatcher filters on
     * it *before* writing to `event_reaction_log`, so a wildcard would pay a
     * D1 insert on every one of the 130 event types to decide it had nothing
     * to broadcast.
     */
    name: "platform.room_broadcast",
    types: liveEventTypes(),
    async handle(ev, env) {
      if (ev.type === "role_grant.revoked") {
        // Not a screen update. Permissions are recomputed per request by
        // design, so a socket opened before the revocation would otherwise
        // stay live until its lifetime cap — this closes it now and makes the
        // client reconnect through the authorized route.
        const personId = str((ev.data as Record<string, unknown>).person_id);
        if (personId) await kickFromRoom(env, ev.org_id, ev.event_id ?? null, personId);
        return;
      }
      await pokeRooms(env, [ev]);
    },
  },

  {
    /**
     * Mark the linked external records dirty — 09, "Two-way sync".
     *
     * Does no provider work: it flips links to `pending_push` and enqueues one
     * debounced sweep per mapping, so a decision batch over four hundred
     * proposals coalesces into a handful of API calls instead of four hundred.
     *
     * One fact can dirty several subjects. A speaker changing their name moves
     * `person`, and also every grid showing `full_name` as a derived column —
     * the sessions table, the roster, the pipeline. `SYNC_DIRTY_RULES` names
     * those rows explicitly, because a derived column nobody refreshes is a
     * column that quietly shows last month's value.
     */
    name: "platform.sync_fanout",
    types: SYNC_DIRTY_EVENT_TYPES,
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as Record<string, unknown>;
      const touched = new Set<string>();

      for (const rule of SYNC_DIRTY_RULES) {
        if (!eventTypeMatches(rule.pattern, ev.type)) continue;

        let ids: string[] = [];
        if (rule.from.kind === "subject") {
          ids = [ev.subject.id];
        } else if (rule.from.kind === "data") {
          const id = strOrNull(data[rule.from.key]);
          ids = id ? [id] : [];
        } else {
          const adapter = adapterFor(rule.subject);
          // A `person`-sourced rule reads the person id off the subject, which
          // is where 10's naming rule puts it: the subject of "a profile was
          // updated" is the person, not the profile.
          ids = adapter.byPerson ? await adapter.byPerson(app, ev.subject.id) : [];
        }

        for (const id of ids) {
          if (await markDirty(app, rule.subject, id, ev.event_id ?? null)) touched.add(rule.subject);
        }
      }

      if (touched.size > 0) {
        for (const mapping of await activeMappings(app)) {
          if (touched.has(str(mapping.subject))) {
            await schedulePush(env, ev.org_id, str(mapping.id), "event");
          }
        }
      }
      await app.flush();
    },
  },

  {
    /**
     * INV-09-22 — erasure propagates to every mirror.
     *
     * Separate from the fanout above because it is the opposite operation: not
     * "push the current value" but "this data must stop existing in a system we
     * do not control". It runs over inactive mappings too, and the delivery
     * handler throws if a provider refuses, so a failed erasure retries and
     * surfaces rather than being reported as done.
     */
    name: "platform.sync_erasure",
    types: ["person.deactivated"],
    async handle(ev, env) {
      await scheduleErase(env, ev.org_id, ev.subject.id);
    },
  },
];
