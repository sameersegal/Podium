/**
 * `PLATFORM_CRON` — 09, platform mapping: "Cron Triggers + Queues".
 *
 * Nothing here does the work itself; each sweep finds what has become due and
 * hands it back to the delivery queue, so retries and sends stay in one place
 * (`delivery.ts`) whether they were triggered by a webhook failure, a schedule,
 * or this sweep.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { str, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import type { CronJob } from "../../consumers/cron.js";
import { sendCampaignNow } from "./campaigns.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";

export const PLATFORM_CRON: CronJob[] = [
  {
    // "retry scheduled webhook deliveries" — the task brief. Retries after the
    // first attempt are created with `scheduled_for` in the future
    // (delivery.ts) rather than re-queued immediately, because the 24h step of
    // the backoff schedule is past what a Queue delay reliably covers.
    name: "platform.retry_webhook_deliveries",
    everyMinutes: 1,
    async run(env, now) {
      const due = await env.DB.prepare(
        `SELECT wd.id AS delivery_id, wd.webhook_id, wd.domain_event_id, w.org_id AS org_id
           FROM webhook_delivery wd JOIN webhook w ON w.id = wd.webhook_id
          WHERE wd.status = 'pending' AND wd.attempt > 1 AND wd.scheduled_for <= ? AND w.status = 'active'
          LIMIT 200`,
      )
        .bind(now)
        .all<Row>();
      let n = 0;
      for (const row of due.results ?? []) {
        const message: DeliveryMessage = {
          kind: "webhook",
          delivery_id: str(row.delivery_id),
          webhook_id: str(row.webhook_id),
          org_id: str(row.org_id),
          event_id: str(row.domain_event_id),
        };
        try {
          await env.DELIVERY_QUEUE.send(message);
          n++;
        } catch (err) {
          console.warn("retry sweep enqueue failed", { delivery_id: row.delivery_id, error: String(err) });
        }
      }
      return n;
    },
  },
  {
    // "send scheduled campaigns" — the task brief.
    name: "platform.send_scheduled_campaigns",
    everyMinutes: 5,
    async run(env: Env, now: string) {
      const due = await env.DB.prepare(
        "SELECT id, org_id, event_id FROM campaign WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ? LIMIT 100",
      )
        .bind(now)
        .all<Row>();
      let n = 0;
      for (const row of due.results ?? []) {
        const app = new AppContext({ env, orgId: str(row.org_id), eventId: str(row.event_id) || null, actor: SYSTEM_ACTOR });
        try {
          await sendCampaignNow(app, str(row.id));
          await app.flush();
          n++;
        } catch (err) {
          console.warn("scheduled campaign send failed", { campaign_id: row.id, error: String(err) });
        }
      }
      return n;
    },
  },
];
