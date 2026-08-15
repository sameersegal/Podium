/**
 * The fast half of live updates — see `workers/api/src/durable/room.ts` for
 * what a room is and why a frame carries no domain data.
 *
 * Two things poke a room with the same event: this, from the request path, and
 * the `platform.room_broadcast` reaction, from the queue. That is deliberate
 * rather than redundant. The queue is the durable path — it survives a Worker
 * dying mid-request and is replayed by the sweeper — but Queues deliver in
 * seconds, and a second is the difference between "live" and "why is this
 * page stale". The direct poke is sub-100ms and allowed to fail, because the
 * queue is still coming. The room dedupes on `DomainEvent.id`, so whichever
 * arrives second is dropped.
 *
 * It lives here, next to `publishEvents`, for the reason stated on `flush()`:
 * publishing is the only fan-out path, and this is publishing on a second
 * transport. A poke wired into each route instead would be forgotten by the
 * third route someone adds.
 */

import { isLiveEventType } from "@podiumstack/domain/events/catalogue.js";
import type { DomainEvent } from "@podiumstack/domain/events/envelope.js";
import type { Env } from "./context.js";

/** One event, flattened to what a room is allowed to know. */
interface Poke {
  id: string;
  type: string;
  subject: { type: string; id: string };
  occurred_at: string;
}

/**
 * The room an event belongs to. Per event, because the envelope already
 * carries `event_id` — no lookup, and no `type → room` mapping table over 130
 * event types for someone to forget to extend. The cost of the coarse grain is
 * a browser waking for a change it does not care about, which the client
 * filters on subject type; the cost of the fine grain would be a screen going
 * quietly dead when a new event type routes nowhere.
 *
 * `v1` is in the name so a future change to what a room means can be rolled
 * out by renaming rather than by draining every socket in the fleet.
 */
export function roomKey(eventId: string | null | undefined): string {
  return eventId ? `room:v1:event:${eventId}` : "room:v1:org";
}

/**
 * Fire-and-forget. Never awaited on the way to a response by the HTTP callers
 * — see `AppContext.flush`, which hands this to `waitUntil` when it has one.
 */
export async function pokeRooms(env: Env, events: DomainEvent[]): Promise<void> {
  const byRoom = new Map<string, Poke[]>();
  for (const e of events) {
    if (!isLiveEventType(e.type)) continue;
    const key = roomKey(e.event_id);
    const pokes = byRoom.get(key) ?? [];
    pokes.push({ id: e.id, type: e.type, subject: e.subject, occurred_at: e.occurred_at });
    byRoom.set(key, pokes);
  }
  if (byRoom.size === 0) return;

  await Promise.all(
    [...byRoom].map(async ([key, pokes]) => {
      try {
        await roomStub(env, key).fetch("https://room.internal/poke", {
          method: "POST",
          body: JSON.stringify(pokes),
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        // A room that cannot be reached costs a browser its live update, not
        // the fact — which is already committed, and whose queue delivery is
        // still on its way. Nothing here is worth failing a request over.
        console.warn("room poke failed", { room: key, count: pokes.length, error: String(err) });
      }
    }),
  );
}

/** Closes every socket a person holds in one room — a revoked grant, or a sign-out. */
export async function kickFromRoom(env: Env, eventId: string | null, personId: string): Promise<void> {
  try {
    await roomStub(env, roomKey(eventId)).fetch("https://room.internal/kick", {
      method: "POST",
      body: JSON.stringify({ person_id: personId }),
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.warn("room kick failed", { person_id: personId, error: String(err) });
  }
}

/** The name is the room, exactly as `runSerialised` uses the name as the lock. */
function roomStub(env: Env, key: string): { fetch: typeof fetch } {
  const namespace = env.ROOM_DO as DurableObjectNamespace;
  return namespace.get(namespace.idFromName(key)) as unknown as { fetch: typeof fetch };
}
