/**
 * `delivered` is set by a scheduled job after the placement's end time passes
 * (06, "Lifecycle") — the only drawn arrow into it is from `published`. Nothing
 * long-running happens here: the sweep finds what has become due and emits
 * `session.delivered` through `markDelivered`, which is the fact post-event
 * flows (upload your recording, share your slides, feedback requests) hang
 * off.
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { D1Db, str, type Row } from "@podiumconf/data/db.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import type { CronJob } from "../../consumers/cron.js";
import { markDelivered } from "./service.js";

async function orgIds(env: Env): Promise<string[]> {
  const db = new D1Db(env.DB, "");
  const rows = await db.raw<{ id: string }>("SELECT id FROM organization");
  return rows.map((r) => r.id);
}

export const PROGRAM_CRON: CronJob[] = [
  {
    name: "program.mark_delivered",
    everyMinutes: 15,
    async run(env, now) {
      let count = 0;
      for (const orgId of await orgIds(env)) {
        const lookup = new AppContext({ env, orgId, actor: SYSTEM_ACTOR });
        const rows = await lookup.db.raw<Row>(
          `SELECT s.id AS session_id, s.event_id AS event_id FROM session s
             JOIN placement pl ON pl.session_id = s.id
            WHERE s.status = 'published' AND pl.ends_at <= ?`,
          [now],
        );
        // One AppContext per session, so `AppContext.eventId` — read once at
        // `flush()` for every audit row in the batch — is never shared across
        // sessions from different events.
        for (const row of rows) {
          const app = new AppContext({ env, orgId, eventId: str(row.event_id), actor: SYSTEM_ACTOR });
          await markDelivered(app, str(row.session_id));
          await app.flush();
          count++;
        }
      }
      return count;
    },
  },
];
