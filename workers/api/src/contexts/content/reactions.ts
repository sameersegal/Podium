/**
 * The content rows of the reaction map (10-domain-events.md).
 *
 * "`scan_status` starts `pending`; a scan reaction sets it `clean`" — the
 * task brief. There is no real anti-virus integration in this deployment, so
 * this reaction is the seam: swapping in a real scanner means replacing this
 * handler's body, not the event it reacts to or the invariant it satisfies
 * (INV-11-3).
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import type { Reaction } from "../../consumers/reactions.js";
import { markScanned } from "./assets.js";

function contextFor(env: Env, ev: DomainEvent): AppContext {
  return new AppContext({
    env,
    orgId: ev.org_id,
    eventId: ev.event_id ?? null,
    actor: SYSTEM_ACTOR,
    correlationId: ev.correlation_id ?? undefined,
    causationId: ev.id,
  });
}

export const CONTENT_REACTIONS: Reaction[] = [
  {
    name: "content.scan_asset",
    types: ["asset.uploaded"],
    async handle(ev, env) {
      const app = contextFor(env, ev);
      const assetId = (ev.data as Record<string, unknown>).asset_id as string;
      await markScanned(app, assetId, "clean");
      await app.flush();
    },
  },
];
