/**
 * The Speaker CRM's one scheduled sweep.
 *
 * "When did we contact her, and how long has this been sitting in Interested"
 * is the question a pipeline exists to answer (14, `ProspectStageTransition`).
 * A card nobody has touched is the failure mode the board is meant to prevent,
 * and it is invisible until something says so out loud — so `prospect.stalled`
 * fires for open cards past their `next_action_at`, or sitting in one stage
 * beyond the threshold.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { D1Db, str, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { daysInStage, isStalled } from "@podiumstack/domain/crm/index.js";
import type { CronJob } from "../../consumers/cron.js";
import { listCards } from "./service.js";

export const CRM_CRON: CronJob[] = [
  {
    name: "crm.stalled_prospects",
    everyMinutes: 24 * 60,
    async run(env: Env, now: string): Promise<number> {
      const orgs = await new D1Db(env.DB, "").raw<Row>("SELECT id FROM organization");
      let emitted = 0;

      for (const orgRow of orgs) {
        const orgId = str(orgRow.id);
        const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR });
        const pipelines = await app.db.select<Row>("sourcing_pipeline", { status: "active" });

        for (const pipeline of pipelines) {
          const cards = await listCards(app, str(pipeline.id));
          for (const card of cards) {
            if (card.stage_kind !== "open" || !card.stalled) continue;

            // Once per card per day: the event log is the record of what has
            // already been said, so a re-run of the sweep says nothing twice.
            const alreadyToday = await app.db.raw<{ n: number }>(
              `SELECT COUNT(*) AS n FROM domain_event_record
                WHERE type = 'prospect.stalled' AND subject_id = ? AND occurred_at > ?`,
              [card.id, new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString()],
            );
            if (Number(alreadyToday[0]?.n ?? 0) > 0) continue;

            app.events.emit({
              type: "prospect.stalled",
              subject: { type: "prospect", id: card.id },
              event_id: card.event_id ? str(card.event_id) : null,
              // INV-14-6: the card's private judgement about a person — its
              // rationale, its score commentary, its notes — does not leave
              // the organization, whatever `include_pii` says.
              data: {
                card_id: card.id,
                person_id: card.person_id,
                stage_id: card.stage_id,
                days_in_stage: daysInStage(card.entered_stage_at, now),
                next_action_at: card.next_action_at,
              },
            });
            emitted++;
          }
        }
        await app.flush();
      }
      return emitted;
    },
  },
];

export { isStalled };
