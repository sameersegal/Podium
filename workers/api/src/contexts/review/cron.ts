/**
 * Review reminder sweep — 05, "Progress and chasing" (`ReviewRoundReminderRule`).
 *
 * Finds assignments whose `due_at + offset_days` has passed, skips terminal
 * statuses, digests per reviewer per day, and hands off to `remindReviewer`
 * (service.ts) which writes the `NotificationDelivery`, increments
 * `ReviewAssignment.reminder_count` and emits `review_assignment.reminded`.
 * Nothing long-running happens here — the sweep only finds what is due (09,
 * platform mapping).
 */

import { AppContext, soleOrgId } from "@podiumstack/data/context.js";
import { num, str, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { isTerminalAssignment, type AssignmentStatus, type ReminderChannel } from "@podiumstack/domain/review/types.js";
import { addDays, calendarDateInZone } from "@podiumstack/domain/shared/time.js";
import type { CronJob } from "../../consumers/cron.js";
import { remindReviewer } from "./service.js";


export const REVIEW_CRON: CronJob[] = [
  {
    name: "review.reminder_sweep",
    everyMinutes: 60,
    async run(env, now) {
      let digestsSent = 0;
      const orgId = await soleOrgId(env);
      const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR, clock: { now: () => now } });

      const rules = await app.db.raw<Row>(
        `SELECT rrr.* FROM review_round_reminder_rule rrr
           JOIN review_round rr ON rr.id = rrr.round_id
          WHERE rr.status = 'open'`,
      );

      for (const rule of rules) {
        const roundId = str(rule.round_id);
        const onlyIfStatus = rule.only_if_status ? (JSON.parse(str(rule.only_if_status)) as string[]) : null;
        const assignments = await app.db.select<Row>("review_assignment", { round_id: roundId });
        const today = calendarDateInZone(now, "UTC");

        // "A reviewer with nine outstanding proposals gets one email listing
        // nine" — batched per person per day, so group before sending.
        const byReviewer = new Map<string, string[]>();
        for (const a of assignments) {
          const status = str(a.status, "assigned") as AssignmentStatus;
          if (isTerminalAssignment(status)) continue;
          if (onlyIfStatus && !onlyIfStatus.includes(status)) continue;
          const dueAt = str(a.due_at);
          if (!dueAt) continue;
          const threshold = addDays(dueAt, num(rule.offset_days));
          if (threshold > now) continue; // not due for this rule's offset yet
          const lastRemindedToday = a.last_reminded_at && calendarDateInZone(str(a.last_reminded_at), "UTC") === today;
          if (lastRemindedToday) continue; // already digested once today
          const list = byReviewer.get(str(a.reviewer_person_id)) ?? [];
          list.push(str(a.id));
          byReviewer.set(str(a.reviewer_person_id), list);
        }

        for (const [reviewerPersonId, assignmentIds] of byReviewer) {
          const id = await remindReviewer(app, {
            round_id: roundId,
            reviewer_person_id: reviewerPersonId,
            assignment_ids: assignmentIds,
            trigger: "scheduled",
            channel: (str(rule.channel, "email") || "email") as ReminderChannel,
            template_key: str(rule.template_key) || undefined,
          });
          if (id) digestsSent++;
        }
      }

      await app.flush();
      return digestsSent;
    },
  },
];
