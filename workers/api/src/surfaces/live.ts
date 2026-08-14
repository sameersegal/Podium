/**
 * The live-update surface: one route, one WebSocket upgrade.
 *
 * Authorization happens here and only here, which is what makes a long-lived
 * socket tractable. Permissions are recomputed per request by design
 * (`http/context.ts`: "they end when the relationship ends, which is why they
 * are recomputed per request rather than baked into a session"), and a socket
 * outlives a request — so the design has to say what the socket is granting.
 *
 * It grants almost nothing. A frame carries no domain data (`durable/room.ts`),
 * so a socket that outlives a revocation leaks only *something happened in
 * this event*, and the refetch it provokes runs through `buildContext` and is
 * refused. Three further layers narrow even that: the handshake is fully
 * authorized, the socket carries a hard lifetime cap, and a revoked grant or a
 * sign-out closes it immediately.
 */

import { kickFromRoom, roomKey } from "@podiumstack/data/live.js";
import { forbidden, unauthorized } from "@podiumstack/domain/shared/errors.js";
import type { Env } from "@podiumstack/data/context.js";
import type { RequestContext } from "../http/context.js";
import { json } from "../http/responses.js";
import type { Router } from "../http/router.js";

/**
 * How long a socket may run before it must reauthenticate. This is the stated
 * worst-case staleness of the side channel: for at most this long after a
 * grant is revoked, a former reviewer's open tab can still learn that
 * *something* changed in an event, though not what, and cannot fetch it.
 * Anything they could act on already goes through a fresh authorization.
 */
const SOCKET_LIFETIME_MS = 30 * 60 * 1000;

/** One person, one screen, a handful of tabs. Beyond that they are pinning the object. */
const MAX_SOCKETS_PER_PERSON = 5;

export function registerLiveRoutes(router: Router<RequestContext>): void {
  router.get("/live/subscribe", async (req, ctx) => {
    // Not an upgrade: say so plainly rather than 500ing inside the object.
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "upgrade_required", message: "This endpoint speaks WebSocket." }, { status: 426 });
    }

    // Browsers cannot set headers on `new WebSocket()`, so this is cookie-only
    // by construction — which is right: the API-key path is for machines, and
    // a machine has the webhook surface.
    const person = ctx.person;
    if (!person) throw unauthorized("Sign in to receive live updates.");

    const url = new URL(req.url);
    const eventId = url.searchParams.get("event");
    if (eventId) ctx.eventId = eventId;

    // Staff see the frames that carry review-internal timing; everyone else
    // does not. 05 blinds a reviewer from their peers until they submit, and
    // "a review landed just now" is enough to erode that — so a reviewer is
    // deliberately not staff here.
    const role = ctx.isStaff({ event_id: eventId ?? undefined }) ? "staff" : "member";

    // A room is per event, and a member-audience frame still says that
    // *something* happened in it. Requiring a relationship rather than merely
    // a session keeps that from reaching people with no business in the event
    // at all. Staff are already established by the matrix; everyone else has
    // to actually be taking part.
    if (eventId && role !== "staff") {
      const participant = await ctx
        .app(eventId)
        .db.first("event_participant", { event_id: eventId, person_id: person.id });
      if (!participant) throw forbidden("You are not taking part in this event.");
    }

    const params = new URLSearchParams({
      person: person.id,
      role,
      expires: new Date(Date.now() + SOCKET_LIFETIME_MS).toISOString(),
      max: String(MAX_SOCKETS_PER_PERSON),
    });
    const since = url.searchParams.get("since");
    if (since) params.set("since", since);

    return roomStub(ctx.env, roomKey(eventId)).fetch(
      `https://room.internal/subscribe?${params}`,
      // The upgrade header has to survive the hop, or the object cannot tell
      // a subscribe from a poke.
      { headers: { upgrade: "websocket" } },
    );
  });
}

/**
 * Called on sign-out. A session that has ended must not keep a channel open,
 * even one that says as little as this one does.
 */
export async function closeSocketsFor(env: Env, personId: string): Promise<void> {
  await kickFromRoom(env, null, personId);
}

function roomStub(env: Env, key: string): { fetch: typeof fetch } {
  const namespace = env.ROOM_DO as DurableObjectNamespace;
  return namespace.get(namespace.idFromName(key)) as unknown as { fetch: typeof fetch };
}
