/**
 * `PLATFORM_CRON` — 09, platform mapping: "Cron Triggers + Queues".
 *
 * Nothing here does the work itself; each sweep finds what has become due and
 * hands it back to the delivery queue, so retries and sends stay in one place
 * (`delivery.ts`) whether they were triggered by a webhook failure, a schedule,
 * or this sweep.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import type { CronJob } from "../../consumers/cron.js";
import { sendCampaignNow } from "./campaigns.js";
import { writableFields } from "@podiumstack/domain/platform/sync.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";
import { replayUnprocessedEvents } from "../../consumers/replay.js";
import { schedulePull, schedulePush } from "./sync-delivery.js";

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
  {
    // Recovery for the gap `publishEvents` leaves on purpose
    // (packages/data/src/context.ts): a queue-send failure there is logged
    // and swallowed rather than losing the already-committed fact. Runs at
    // the 15-minute trigger's own floor — the fastest this can ever go — so
    // a queue outage self-heals within one tick of recovering, without
    // needing production access to `POST /dev/drain` (which refuses outright
    // when `ENVIRONMENT === "production"`).
    //
    // `lookbackHours: 24` bounds the scan to the last day: every
    // fully-processed event stays in the append-only log forever, so without
    // a bound this would re-scan the deployment's entire history on every
    // tick. An outage that outlives a day is an incident an operator is
    // already looking at, not something a background sweep should keep
    // paying to rediscover — `/dev/drain` (non-production only) has no such
    // bound for exactly that manual, one-time case.
    name: "platform.replay_unprocessed_events",
    everyMinutes: 15,
    async run(env, now) {
      const { replayed } = await replayUnprocessedEvents(env, { now, graceMinutes: 5, lookbackHours: 24 });
      return replayed;
    },
  },
  {
    /**
     * The two-way sync's backstop — 09, "The `sync` capability contract".
     *
     * Pulls exist on a schedule rather than only on a provider ping because an
     * integration that works only while webhooks land is an integration that
     * stops working silently. Airtable's automation webhook is best-effort, has
     * no delivery guarantee and no retry, so it is treated as a hint that makes
     * the sync feel live — never as the thing correctness depends on.
     *
     * The push half is swept for the same reason in reverse: `schedulePush`
     * swallows a queue failure because the link is already `pending_push` in the
     * database, and this is what makes that swallow safe.
     */
    name: "platform.sweep_sync",
    everyMinutes: 15,
    async run(env: Env) {
      const mappings = await env.DB.prepare(
        "SELECT id, org_id, subject FROM sync_mapping WHERE is_active = 1 LIMIT 200",
      ).all<Row>();

      let n = 0;
      for (const row of mappings.results ?? []) {
        const orgId = str(row.org_id);
        const mappingId = str(row.id);
        // Push first: a record left dirty by a queue outage should reach the
        // provider before the pull reads a table that is missing it.
        const pending = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM external_record_link WHERE mapping_id = ? AND status = 'pending_push'",
        )
          .bind(mappingId)
          .first<{ n: number }>();
        if (Number(pending?.n ?? 0) > 0) {
          await schedulePush(env, orgId, mappingId, "cron");
          n++;
        }
        if (writableFields(str(row.subject)).length > 0) {
          await schedulePull(env, orgId, mappingId, "cron");
          n++;
        }
      }
      return n;
    },
  },
];
