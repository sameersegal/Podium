/**
 * Onboarding's cron sweeps (09, platform mapping): scheduled reminders and the
 * overdue sweep. Neither does long work itself — each finds what has become
 * due and either emits the fact (overdue) or hands off to the same delivery
 * path a manual nudge uses (reminders), so a Cron Trigger and an organizer's
 * click end up in exactly the same log.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { D1Db, num, str, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import { daysOverdue } from "@podiumconf/domain/onboarding/types.js";
import type { CronJob } from "../../consumers/cron.js";
import { deliverReminders, scheduledReminderCandidates } from "./service.js";

async function orgIds(env: Env): Promise<string[]> {
  const db = new D1Db(env.DB, "");
  const rows = await db.raw<{ id: string }>("SELECT id FROM organization");
  return rows.map((r) => r.id);
}

export const ONBOARDING_CRON: CronJob[] = [
  {
    name: "onboarding.scheduled_reminders",
    everyMinutes: 60,
    async run(env) {
      let sent = 0;
      for (const orgId of await orgIds(env)) {
        const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR });
        const candidates = await scheduledReminderCandidates(app);
        if (candidates.length > 0) {
          const result = await deliverReminders(app, candidates);
          sent += result.sent;
        }
        await app.flush();
      }
      return sent;
    },
  },
  {
    name: "onboarding.overdue_sweep",
    everyMinutes: 30,
    async run(env, now) {
      let emitted = 0;
      const sinceMidnight = `${now.slice(0, 10)}T00:00:00.000Z`;
      for (const orgId of await orgIds(env)) {
        const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR });
        const rows = await app.db.raw<Row>(
          `SELECT * FROM task_instance WHERE org_id = ? AND due_at IS NOT NULL AND due_at < ?
             AND status NOT IN ('completed','waived','cancelled')`,
          [orgId, now],
        );
        for (const r of rows) {
          const already = await app.db.raw<{ n: number }>(
            `SELECT COUNT(*) AS n FROM domain_event_record
              WHERE org_id = ? AND type = 'task_instance.overdue' AND subject_id = ? AND occurred_at >= ?`,
            [orgId, str(r.id), sinceMidnight],
          );
          if (num(already[0]?.n) > 0) continue; // once a day is plenty of "this is overdue"
          app.events.emit({
            type: "task_instance.overdue",
            subject: { type: "task", id: str(r.id) },
            event_id: str(r.event_id),
            data: { task_instance_id: str(r.id), due_at: str(r.due_at), days_overdue: daysOverdue(str(r.due_at), now) },
          });
          emitted++;
        }
        await app.flush();
      }
      return emitted;
    },
  },
];
