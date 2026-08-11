import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "@podiumconf/data/context.js";
import { pokeRooms, roomKey } from "@podiumconf/data/live.js";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import type { RoomBatch, RoomDurableObject } from "@podiumconf/web/durable/room.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * The room is the one place a live update can go wrong quietly: a duplicate
 * frame is invisible, a coalescing bug only shows up under a decision publish,
 * and an audience leak looks exactly like working software. Miniflare does not
 * actually evict objects, so hibernation itself is not observable here — what
 * is testable, and what actually matters, is that the object behaves correctly
 * when its in-memory state is empty, which is the state eviction leaves it in.
 */

const ORG = "org_room";
const EVENT = "evt_room";

// `testEnv.ROOM_DO` rather than `env.ROOM_DO`: wrangler's generated types
// already give it the right branded namespace, and re-deriving that through
// the `Env & typeof testEnv` intersection sends the checker into TS2589.
function stub() {
  const ns = testEnv.ROOM_DO;
  return ns.get(ns.idFromName(roomKey(ORG, EVENT)));
}

function event(type: string, subjectType: string, id: string): DomainEvent {
  return buildEvent(
    { type: type as DomainEvent["type"], subject: { type: subjectType, id }, data: {} },
    { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_room" },
  );
}

/** A socket pair whose client end collects whatever the room sends. */
function connect(instance: RoomDurableObject, state: DurableObjectState, role: "staff" | "member", personId: string, expiresAt: string) {
  const received: RoomBatch[] = [];
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  // The server end goes through the hibernation API first: accepting the
  // client end marks the pair as used and `acceptWebSocket` then refuses it.
  state.acceptWebSocket(server, [`person:${personId}`, `role:${role}`]);
  server.serializeAttachment({ person_id: personId, role, expires_at: expiresAt });
  client.accept();
  client.addEventListener("message", (ev) => {
    try {
      received.push(JSON.parse(String(ev.data)) as RoomBatch);
    } catch {
      /* the keepalive pong */
    }
  });
  return received;
}

const FAR_FUTURE = new Date(Date.now() + 3_600_000).toISOString();

/**
 * `ws.send()` returns before the other end's listener runs, so every assertion
 * about what a client received has to let the runtime deliver first. Without
 * this the tests that expect *nothing* pass for the wrong reason.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("the live room", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(ORG, "Room Org", "room-org", "UTC", "a@b.example", "{}", now, now)
      .run();
  });

  it("sends one frame for an event delivered twice", async () => {
    const ev = event("placement.moved", "placement", "plc_room1");

    await runInDurableObject(stub(), async (instance, state) => {
      const staff = connect(instance, state, "staff", "per_room_staff", FAR_FUTURE);

      // Both transports carrying the same fact: the direct poke from
      // `flush()` and the `platform.room_broadcast` reaction off the queue.
      await pokeRooms(env, [ev]);
      await pokeRooms(env, [ev]);
      await instance.alarm();
      await settle();

      expect(staff).toHaveLength(1);
      expect(staff[0].frames).toHaveLength(1);
      expect(staff[0].frames[0].type).toBe("placement.moved");
      // No domain data crosses the socket — that is the whole security
      // argument, so it is asserted rather than assumed.
      expect(Object.keys(staff[0].frames[0]).sort()).toEqual(["occurred_at", "subject", "type"]);
    });
  });

  it("coalesces a burst into a single batch", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const staff = connect(instance, state, "staff", "per_room_burst", FAR_FUTURE);

      // Publishing decisions raises one of these per proposal. Without
      // coalescing this is fifty frames and fifty refetches.
      const burst = Array.from({ length: 50 }, (_, i) => event("review.submitted", "review", `rev_burst_${i}`));
      await pokeRooms(env, burst);
      await instance.alarm();
      await settle();

      expect(staff).toHaveLength(1);
      expect(staff[0].frames).toHaveLength(50);
    });
  });

  it("keeps a staff-only frame away from a member socket", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const staff = connect(instance, state, "staff", "per_room_chair", FAR_FUTURE);
      const member = connect(instance, state, "member", "per_room_speaker", FAR_FUTURE);

      // 05: a reviewer does not see their peers' work until they submit, and
      // the timing of a submission is enough to erode that.
      await pokeRooms(env, [event("review.submitted", "review", "rev_room_secret")]);
      await instance.alarm();
      await settle();

      expect(staff).toHaveLength(1);
      expect(member).toHaveLength(0);
    });
  });

  it("sends a member-audience frame to everyone", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const staff = connect(instance, state, "staff", "per_room_chair2", FAR_FUTURE);
      const member = connect(instance, state, "member", "per_room_speaker2", FAR_FUTURE);

      await pokeRooms(env, [event("schedule.published", "schedule_publication", "pub_room1")]);
      await instance.alarm();
      await settle();

      expect(staff).toHaveLength(1);
      expect(member).toHaveLength(1);
    });
  });

  it("ignores an event type that is not a live topic", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const staff = connect(instance, state, "staff", "per_room_quiet", FAR_FUTURE);

      // `person.created` carries PII and is nobody's screen update.
      await pokeRooms(env, [event("person.created", "person", "per_room_new")]);
      await instance.alarm();
      await settle();

      expect(staff).toHaveLength(0);
    });
  });

  it("closes a socket past its lifetime cap instead of sending to it", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const expired = connect(instance, state, "staff", "per_room_expired", new Date(Date.now() - 1000).toISOString());

      await pokeRooms(env, [event("placement.moved", "placement", "plc_room_expired")]);
      await instance.alarm();
      await settle();

      // Permissions are recomputed per request by design; the cap is what
      // stops a socket outliving the grant that opened it.
      expect(expired).toHaveLength(0);
    });
  });

  it("still behaves correctly with the in-memory dedupe set empty, as eviction leaves it", async () => {
    const ev = event("session.updated", "session", "ses_room_wake");

    await runInDurableObject(stub(), async (instance, state) => {
      const member = connect(instance, state, "member", "per_room_wake", FAR_FUTURE);
      await pokeRooms(env, [ev]);
      await instance.alarm();
      await settle();
      expect(member).toHaveLength(1);

      // What hibernation would have done to `seen`. The redelivery now gets
      // through — one duplicate frame, which costs a refetch and nothing else.
      // The point is that it does not throw or lose the batch.
      (instance as unknown as { seen: Set<string> }).seen = new Set();
      await pokeRooms(env, [ev]);
      await instance.alarm();
      await settle();
      expect(member).toHaveLength(2);
      // `seq` lives in storage, so it survives and keeps advancing.
      expect(member[1].seq).toBeGreaterThan(member[0].seq);
    });
  });

  it("closes a person's sockets when their grant is revoked", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const victim = connect(instance, state, "staff", "per_room_revoked", FAR_FUTURE);
      const bystander = connect(instance, state, "staff", "per_room_bystander", FAR_FUTURE);

      await stub().fetch("https://room.internal/kick", {
        method: "POST",
        body: JSON.stringify({ person_id: "per_room_revoked" }),
        headers: { "content-type": "application/json" },
      });

      await pokeRooms(env, [event("placement.moved", "placement", "plc_room_after_kick")]);
      await instance.alarm();
      await settle();

      expect(victim).toHaveLength(0);
      expect(bystander).toHaveLength(1);
    });
  });
});
