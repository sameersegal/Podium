/**
 * Cron Triggers produce Queue messages (09, platform mapping): the sweep finds
 * what has become due and emits the fact; the nudge itself is a reaction.
 *
 * "`entitlement.exhausted` and `entitlement.expiring_soon` are the hooks the
 * nudge emails hang off — the sponsor-chasing job (J2's unhappy path) is mostly
 * 'who has unspent slots and a deadline next week', and that should be a
 * subscription, not a spreadsheet."
 */

import { AppContext, soleOrgId } from "@podiumstack/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { expiringSoon } from "@podiumstack/domain/sponsorship/types.js";
import type { CronJob } from "../../consumers/cron.js";
import { entitlementUsageFor } from "./service.js";

export const EXPIRY_WINDOW_DAYS = 7;


export const SPONSORSHIP_CRON: CronJob[] = [
  {
    name: "sponsorship.entitlement_expiring_soon",
    everyMinutes: 60 * 12,
    async run(env, now) {
      let emitted = 0;
      const orgId = await soleOrgId(env);
      const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR });
      const rows = await app.db.raw<Row>(
        `SELECT en.*, sp.event_id AS event_id, sp.sponsor_id AS sponsor_id
           FROM entitlement en
           JOIN sponsorship sp ON sp.id = en.sponsorship_id
           JOIN sponsor s ON s.id = sp.sponsor_id AND s.deleted_at IS NULL
          WHERE sp.status = 'confirmed'
            AND (en.expires_at IS NOT NULL OR en.submission_deadline IS NOT NULL)`,
        [],
      );
      if (rows.length === 0) return 0;

      const usage = await entitlementUsageFor(app, rows);
      for (const row of rows) {
        const id = str(row.id);
        const remaining = usage.get(id)?.remaining ?? 0;
        const due = expiringSoon(
          { expires_at: strOrNull(row.expires_at), submission_deadline: strOrNull(row.submission_deadline) },
          remaining,
          now,
          EXPIRY_WINDOW_DAYS,
        );
        if (!due.due) continue;

        // Once per entitlement per day. The domain event log is the record of
        // what was already said, so there is no second table to drift.
        const sinceYesterday = new Date(new Date(now).getTime() - 24 * 3600_000).toISOString();
        const already = await app.db.raw<{ n: number }>(
          `SELECT COUNT(*) AS n FROM domain_event_record
            WHERE type = 'entitlement.expiring_soon'
              AND subject_id = ? AND occurred_at >= ?`,
          [id, sinceYesterday],
        );
        if (num(already[0]?.n, 0) > 0) continue;

        app.events.emit({
          type: "entitlement.expiring_soon",
          subject: { type: "entitlement", id },
          event_id: str(row.event_id),
          data: {
            entitlement_id: id,
            sponsor_id: str(row.sponsor_id),
            remaining,
            expires_at: due.at,
            days_remaining: due.days_remaining,
          },
        });
        emitted++;
      }
      await app.flush();
      return emitted;
    },
  },
];
