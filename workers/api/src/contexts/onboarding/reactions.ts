/**
 * Onboarding's rows of the reaction map (10-domain-events.md):
 *
 * | `session.created` / `session.confirmed`  | materialise onboarding tasks              |
 * | `session_speaker.confirmed`              | materialise that speaker's instances      |
 * | `session_speaker.replaced`               | transfer incomplete tasks                 |
 * | `session.cancelled`                      | cancel tasks                              |
 * | `task_instance.completed` (`.waived`)    | unblock dependents; chain the next task   |
 * | `task_instance.completed/.waived/.cancelled` | check `onboarding.session_complete`   |
 * | `event_participant.added/.status_changed`| materialise roster-level tasks            |
 * | `asset.uploaded`                         | complete a file-request task once clean   |
 * | `placement.moved`                        | recompute `relative_to_session_start` (INV-07-11) |
 *
 * Every handler is written to be re-runnable: idempotency on `DomainEvent.id`
 * is enforced once in `consumers/dispatch.ts`, but materialisation is also
 * idempotent by construction (INV-07-2), and the rest are simple state checks.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { getSession } from "../program/service.js";
import { blockingTasksOutstanding } from "../scheduling/program-link.js";
import { materialiseForParticipant, materialiseForSession, recomputeSessionStartDueDates, transferInstances } from "./materialise.js";
import { cancelInstancesForSession, getInstance, reactToCompletion, retrySubmissionIfClean } from "./service.js";

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

async function checkSessionComplete(app: AppContext, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const outstanding = await blockingTasksOutstanding(app, sessionId);
  if (outstanding > 0) return;
  const total = await app.db.raw<{ n: number }>("SELECT COUNT(*) AS n FROM task_instance WHERE session_id = ? AND is_blocking = 1", [sessionId]);
  app.events.emit({
    type: "onboarding.session_complete",
    subject: { type: "session", id: sessionId },
    data: { session_id: sessionId, blocking_task_count: Number(total[0]?.n ?? 0) },
  });
}

export const ONBOARDING_REACTIONS: Reaction[] = [
  {
    name: "onboarding.materialise_on_session_created",
    types: ["session.created"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const sessionId = str((ev.data as Record<string, unknown>).session_id);
      const session = await getSession(app, sessionId);
      await materialiseForSession(app, session, "on_session_created");
      await app.flush();
    },
  },
  {
    name: "onboarding.materialise_on_session_confirmed",
    types: ["session.confirmed"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const sessionId = str((ev.data as Record<string, unknown>).session_id);
      const session = await getSession(app, sessionId);
      // Every shipped default definition triggers here (07, "A realistic
      // default set") — this is the trigger that actually populates a
      // checklist for the great majority of sessions.
      await materialiseForSession(app, session, "on_session_confirmed");
      await app.flush();
    },
  },
  {
    name: "onboarding.materialise_on_speaker_confirmed",
    types: ["session_speaker.confirmed"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as Record<string, unknown>;
      const sessionId = str(data.session_id);
      const personId = str(data.person_id);
      const session = await getSession(app, sessionId);
      await materialiseForSession(app, session, "on_speaker_confirmed", { onlyPersonId: personId });
      // A speaker confirmed after the session itself already confirmed (added
      // late, or replaced) still needs the on_session_confirmed-triggered
      // instances every default definition uses — INV-07-2 makes re-running
      // this for the whole definition set on just this one person a no-op for
      // anything they already have.
      await materialiseForSession(app, session, "on_session_confirmed", { onlyPersonId: personId });
      await app.flush();
    },
  },
  {
    name: "onboarding.transfer_on_speaker_replaced",
    types: ["session_speaker.replaced"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as Record<string, unknown>;
      const sessionId = str(data.session_id);
      await transferInstances(app, sessionId, str(data.outgoing_person_id), str(data.incoming_person_id));
      await app.flush();
    },
  },
  {
    name: "onboarding.cancel_on_session_cancelled",
    types: ["session.cancelled"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const sessionId = str((ev.data as Record<string, unknown>).session_id);
      await cancelInstancesForSession(app, sessionId, "Session cancelled."); // INV-07-8
      await app.flush();
    },
  },
  {
    name: "onboarding.react_to_completion",
    types: ["task_instance.completed", "task_instance.waived"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const taskId = str((ev.data as Record<string, unknown>).task_instance_id);
      const instance = await getInstance(app, taskId);
      await reactToCompletion(app, instance); // unblock dependents; chain on_task_completed
      await app.flush();
    },
  },
  {
    name: "onboarding.check_session_complete",
    types: ["task_instance.completed", "task_instance.waived", "task_instance.cancelled"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const taskId = str((ev.data as Record<string, unknown>).task_instance_id);
      const instance = await app.db.byId<Row>("task_instance", taskId, { includeDeleted: true });
      if (!instance?.is_blocking) return;
      await checkSessionComplete(app, str(instance.session_id) || null);
      await app.flush();
    },
  },
  {
    name: "onboarding.materialise_on_participant_added",
    types: ["event_participant.added"],
    async handle(ev, env) {
      if (!ev.event_id) return;
      const app = contextFor(env, ev);
      const personId = str((ev.data as Record<string, unknown>).person_id);
      await materialiseForParticipant(app, ev.event_id, personId, "on_participant_added");
      await app.flush();
    },
  },
  {
    name: "onboarding.materialise_on_participant_confirmed",
    types: ["event_participant.status_changed"],
    async handle(ev, env) {
      const data = ev.data as Record<string, unknown>;
      if (!ev.event_id || data.to !== "confirmed") return;
      const app = contextFor(env, ev);
      await materialiseForParticipant(app, ev.event_id, str(data.person_id), "on_participant_confirmed");
      await app.flush();
    },
  },
  {
    name: "onboarding.complete_file_request_on_scan",
    types: ["asset.uploaded"],
    async handle(ev, env) {
      const assetId = str((ev.data as Record<string, unknown>).asset_id);
      const app = contextFor(env, ev);
      const rows = await app.db.raw<Row>("SELECT DISTINCT task_instance_id FROM task_submission WHERE asset_ids LIKE ?", [`%"${assetId}"%`]);
      for (const r of rows) {
        await retrySubmissionIfClean(app, str(r.task_instance_id)); // INV-07-9
      }
      await app.flush();
    },
  },
  {
    name: "onboarding.recompute_due_on_placement_moved",
    types: ["placement.moved"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const data = ev.data as { session_id?: string; to?: { starts_at?: string | null } };
      if (!data.session_id) return;
      await recomputeSessionStartDueDates(app, data.session_id, data.to?.starts_at ?? null); // INV-07-11
      await app.flush();
    },
  },
];
