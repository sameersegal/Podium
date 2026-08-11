/**
 * Submission sweeps. Each finds the rows that have become due and emits the
 * domain event; nothing long-running happens here (09, platform mapping).
 *
 *   * abandoned drafts — R22, `Event.settings.sponsorship.draft_abandonment_days`
 *     (default 14). Emits `draft.abandoned`, which the sponsorship reaction
 *     turns into `entitlement.released`.
 *   * accepted proposals past `confirmation_deadline` — the drawn
 *     `accepted --> expired` edge. Emits `proposal.expired`.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { D1Db, num, str, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import type { CronJob } from "../../consumers/cron.js";
import { abandonmentPolicy } from "../sponsorship/service.js";
import { emitDraftAbandoned, expireProposal } from "./service.js";

async function orgIds(env: Env): Promise<string[]> {
  const db = new D1Db(env.DB, "");
  const rows = await db.raw<{ id: string }>("SELECT id FROM organization");
  return rows.map((r) => r.id);
}

export const SUBMISSION_CRON: CronJob[] = [
  {
    name: "submissions.abandoned_drafts",
    everyMinutes: 60 * 6,
    async run(env, now) {
      let emitted = 0;
      for (const orgId of await orgIds(env)) {
        const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR, clock: { now: () => now } });
        const events = await app.db.select<Row>("event", {});
        for (const ev of events) {
          const policy = await abandonmentPolicy(app, str(ev.id), now);
          const stale = await app.db.raw<Row>(
            `SELECT p.* FROM proposal p
              WHERE p.org_id = ? AND p.event_id = ? AND p.deleted_at IS NULL
                AND p.status = 'draft' AND p.last_activity_at <= ?`,
            [orgId, str(ev.id), policy.cutoff],
          );
          for (const proposal of stale) {
            // Once per draft: the event log is the record of what was already
            // said, so a re-run of the sweep does not nag twice.
            const already = await app.db.raw<{ n: number }>(
              `SELECT COUNT(*) AS n FROM domain_event_record
                WHERE org_id = ? AND type = 'draft.abandoned' AND subject_id = ?
                  AND occurred_at >= ?`,
              [orgId, str(proposal.id), str(proposal.last_activity_at)],
            );
            if (num(already[0]?.n, 0) > 0) continue;
            await emitDraftAbandoned(app, proposal);
            emitted++;
          }
        }
        await app.flush();
      }
      return emitted;
    },
  },
  {
    name: "submissions.expire_accepted",
    everyMinutes: 60,
    async run(env, now) {
      let expired = 0;
      for (const orgId of await orgIds(env)) {
        const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR, clock: { now: () => now } });
        const due = await app.db.raw<Row>(
          `SELECT p.id FROM proposal p
            WHERE p.org_id = ? AND p.deleted_at IS NULL AND p.status = 'accepted'
              AND p.confirmation_deadline IS NOT NULL AND p.confirmation_deadline <= ?
              AND p.session_id IS NULL`,
          [orgId, now],
        );
        for (const row of due) {
          // `accepted --> expired: confirmation_deadline passes with no speaker
          // confirmation`. A proposal that already has a session is confirmed.
          await expireProposal(app, str(row.id));
          expired++;
        }
        await app.flush();
      }
      return expired;
    },
  },
];
