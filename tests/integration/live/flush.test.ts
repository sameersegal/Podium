import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext, type Env } from "@podiumstack/data/context.js";
import { roomKey } from "@podiumstack/data/live.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";
import type { RoomBatch, RoomDurableObject } from "@podiumstack/web/durable/room.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * Two transports carry the same fact to a room: `AppContext.flush()` pokes it
 * directly in the request (~100ms), and `platform.room_broadcast` pokes it
 * again off the queue (seconds later, but durably). The pair is the design —
 * fast and lossy in front of slow and reliable — and it only works because the
 * room is idempotent on `DomainEvent.id`.
 *
 * The failure this guards against is the second poke arriving as a second
 * frame, which would show up as every screen refetching twice for every change.
 */

const ORG = "org_flush";
const EVENT = "evt_flush";

// `testEnv.ROOM_DO` rather than `env.ROOM_DO`: wrangler's generated types
// already give it the right branded namespace, and re-deriving that through
// the `Env & typeof testEnv` intersection sends the checker into TS2589.
function stub() {
  const ns = testEnv.ROOM_DO;
  return ns.get(ns.idFromName(roomKey(ORG, EVENT)));
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("the two paths into a room", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(ORG, "Flush Org", "flush-org", "UTC", "a@b.example", "{}", now, now)
      .run();
  });

  it("delivers one frame when flush() and the queue reaction both poke", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const received: RoomBatch[] = [];
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      state.acceptWebSocket(server, ["person:per_flush", "role:staff"]);
      server.serializeAttachment({
        person_id: "per_flush",
        role: "staff",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      client.accept();
      client.addEventListener("message", (ev) => {
        try {
          received.push(JSON.parse(String(ev.data)) as RoomBatch);
        } catch {
          /* pong */
        }
      });

      const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
      // `session.updated` has no reaction of its own beyond the webhook fan-out
      // (which finds no webhooks here) and the broadcast — so what this
      // measures is the two room pokes, not a cascade.
      app.events.emit({
        type: "session.updated",
        subject: { type: "session", id: "ses_flush1" },
        data: { session_id: "ses_flush1" },
      });

      // The fast half. No `waitUntil` on this context, so the poke is awaited
      // rather than deferred — which is what a reaction or a cron job gets.
      const [event] = await app.flush();

      // The durable half, carrying the same `DomainEvent.id`.
      await deliverEvent(env, event);

      await instance.alarm();
      await settle();

      // One frame, not two. Both transports ran; the room collapsed them.
      expect(received).toHaveLength(1);
      expect(received[0].frames).toHaveLength(1);
      expect(received[0].frames[0].subject.id).toBe("ses_flush1");
    });
  });

  it("registers the broadcast reaction against the event type", async () => {
    const { reactionsFor } = await import("@podiumstack/web/consumers/dispatch.js");
    const names = reactionsFor("session.updated").map((r) => r.name);
    expect(names).toContain("platform.room_broadcast");

    // And explicitly not against everything: an allowlist rather than `*` is
    // what keeps a `event_reaction_log` insert off the other ~105 types.
    expect(reactionsFor("person.created").map((r) => r.name)).not.toContain("platform.room_broadcast");
  });
});
