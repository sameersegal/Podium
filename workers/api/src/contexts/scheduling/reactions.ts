/**
 * `SCHEDULING_REACTIONS` — the Scheduling & Publication rows of the reaction
 * map (10-domain-events.md). Idempotency on `DomainEvent.id` is enforced once
 * in `consumers/dispatch.ts`; each handler here only has to be safe to run
 * twice, which "recompute and, maybe, write" already is.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { str, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { recomputeConflicts } from "./conflicts.js";
import { autoPublishEnabled, toEventFact } from "./facts.js";
import { invalidateSnapshot, publishSchedule } from "./publication.js";
import { runSerialised } from "../../durable/schedule.js";

function systemApp(env: Env, orgId: string, eventId: string, causationId: string, correlationId: string | null): AppContext {
  return new AppContext({
    env,
    orgId,
    eventId,
    actor: SYSTEM_ACTOR,
    correlationId: correlationId ?? causationId,
    causationId,
  });
}

/**
 * `onboarding.session_complete` and `session.content_approved` both change
 * whether a session is publishable. `ScheduleConflict.UNPUBLISHABLE` is the
 * materialised read model that reflects that (08, "Conflict detection"), so
 * both react the same way: recompute it, then republish if the event has
 * opted into `auto_publish` (R25 — off by default; a setting, not a default,
 * because a half-finished rearrangement going live at 2am is worse than a
 * stale page).
 */
async function recomputeReadinessAndMaybePublish(env: Env, orgId: string, eventId: string, causationId: string, correlationId: string | null): Promise<void> {
  const app = systemApp(env, orgId, eventId, causationId, correlationId);
  await recomputeConflicts(app, eventId);
  const eventRow = await app.db.byId<Row>("event", eventId);
  if (eventRow && autoPublishEnabled(toEventFact(eventRow))) {
    await publishSchedule(app, eventId, { note: "Auto-published (Event.settings.publication.auto_publish)." });
  }
  await app.flush();
}

/**
 * `session.cancelled` → release its placement (INV-06-7; reaction map:
 * "release placement and entitlement" | Scheduling, Onboarding, Sponsorship).
 * Program's `cancelSession` sets the session to `cancelled` and stops there —
 * the fact is its, the consequences are ours.
 *
 * This goes through the schedule Durable Object like every other placement
 * write, so a cancellation racing an organizer's drag still serialises. The
 * command carries `reason = "session_cancelled"`, which is the one case
 * `assertRemovable` lets past: by the time this reaction runs the session is
 * already `cancelled`, and an organizer-initiated unplace of a cancelled
 * session is the thing that guard exists to refuse.
 */
async function releasePlacementOnCancel(env: Env, orgId: string, eventId: string, sessionId: string, causationId: string, correlationId: string | null): Promise<void> {
  const app = systemApp(env, orgId, eventId, causationId, correlationId);
  const placement = await app.db.first<Row>("placement", { session_id: sessionId });
  if (!placement) return;
  await runSerialised(env, {
    command: { kind: "remove", placement_id: str(placement.id), reason: "session_cancelled" },
    orgId,
    eventId,
    actor: SYSTEM_ACTOR,
    correlationId: correlationId ?? causationId,
  });
}

/**
 * `placement.moved` → recompute conflicts (reaction map: "Recompute
 * `relative_to_session_start` due dates; recompute conflicts" | Onboarding,
 * Scheduling). The Durable Object already does this synchronously inside the
 * write that emits the event (INV-08-14); this is the belt-and-braces async
 * path so a `ScheduleConflict` row is never left stale if a placement is ever
 * moved by a path other than `commands.ts` — recomputation is idempotent, so
 * running it twice costs a query, not correctness.
 */
async function recomputeConflictsOnMove(env: Env, orgId: string, eventId: string, causationId: string, correlationId: string | null): Promise<void> {
  const app = systemApp(env, orgId, eventId, causationId, correlationId);
  await recomputeConflicts(app, eventId);
  await app.flush();
}

/**
 * `schedule.published` → invalidate the KV snapshot cache (reaction map:
 * "Invalidate embed cache; compute diffs; notify affected speakers" —
 * Scheduling's slice is the cache). `publishSchedule` already writes the
 * fresh snapshot into KV in the same request; this covers the case where a
 * publish reaches `live` status by a route other than that helper (a
 * rollback, or a future direct write) and guarantees the next public read is
 * never served a snapshot from before this publish.
 */
async function invalidateCacheOnPublish(env: Env, eventId: string): Promise<void> {
  await invalidateSnapshot(env, eventId);
}

export const SCHEDULING_REACTIONS: Reaction[] = [
  {
    name: "scheduling.recompute_readiness_on_task_complete",
    types: ["onboarding.session_complete"],
    async handle(ev, env) {
      if (!ev.event_id) return;
      await recomputeReadinessAndMaybePublish(env, ev.org_id, ev.event_id, ev.id, ev.correlation_id ?? null);
    },
  },
  {
    name: "scheduling.recompute_readiness_on_content_approved",
    types: ["session.content_approved"],
    async handle(ev, env) {
      if (!ev.event_id) return;
      await recomputeReadinessAndMaybePublish(env, ev.org_id, ev.event_id, ev.id, ev.correlation_id ?? null);
    },
  },
  {
    name: "scheduling.release_placement_on_cancel",
    types: ["session.cancelled"],
    async handle(ev, env) {
      if (!ev.event_id) return;
      const sessionId = str((ev.data as Record<string, unknown>).session_id);
      if (!sessionId) return;
      await releasePlacementOnCancel(env, ev.org_id, ev.event_id, sessionId, ev.id, ev.correlation_id ?? null);
    },
  },
  {
    name: "scheduling.recompute_conflicts_on_move",
    types: ["placement.moved"],
    async handle(ev, env) {
      if (!ev.event_id) return;
      await recomputeConflictsOnMove(env, ev.org_id, ev.event_id, ev.id, ev.correlation_id ?? null);
    },
  },
  {
    name: "scheduling.invalidate_cache_on_publish",
    types: ["schedule.published"],
    async handle(ev, env) {
      if (!ev.event_id) return;
      await invalidateCacheOnPublish(env, ev.event_id);
    },
  },
];
