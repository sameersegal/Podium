import { env as testEnv } from "cloudflare:test";
import type { Env } from "@podiumstack/data/context.js";

const env = testEnv as unknown as Env & typeof testEnv;
import { beforeAll, describe, expect, it } from "vitest";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";

/**
 * `SCHEDULING_REACTIONS` — 10-domain-events.md's reaction map, and INV-08-14 /
 * R25's async paths. Every handler must be a no-op on redelivery of the same
 * `DomainEvent.id` (enforced once in `consumers/dispatch.ts`, exercised here).
 */

const ORG = "org_screact";
const EVENT = "evt_screact";
const ROOM = "rom_screact";
const VENUE = "ven_screact";
const DAY = "day_screact";
const FORMAT = "fmt_screact";
const SESSION = "ses_screact";
const PLACEMENT = "plc_screact";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Screact Org", "screact-org", "UTC", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Screact Conf", "screact-conf", "UTC", "2027-10-01", "2027-10-01", "in_person", "active", "public", "{}", now, now],
  );
  await run("INSERT OR IGNORE INTO venue (id, event_id, name) VALUES (?,?,?)", [VENUE, EVENT, "Venue"]);
  await run(
    "INSERT OR IGNORE INTO room (id, venue_id, event_id, name, slug, av_capabilities, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?)",
    [ROOM, VENUE, EVENT, "Room", "room", "[]", 0, 1],
  );
  await run("INSERT OR IGNORE INTO event_day (id, event_id, date, sort_order, is_public) VALUES (?,?,?,?,?)", [DAY, EVENT, "2027-10-01", 0, 1]);
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 1, '["cfp"]', 0, 1],
  );
  await run(
    `INSERT OR IGNORE INTO session
      (id, event_id, reference, origin, title, abstract, session_format_id, duration_minutes, status, content_status, visibility, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [SESSION, EVENT, "T-0001", "cfp", "A talk", "An abstract.", FORMAT, 30, "scheduled", "approved", "public", now, now],
  );
  await run(
    `INSERT OR IGNORE INTO placement
      (id, event_id, session_id, room_id, event_day_id, starts_at, ends_at, setup_minutes, teardown_minutes, status, is_public, placed_by_person_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PLACEMENT, EVENT, SESSION, ROOM, DAY, "2027-10-01T09:00:00.000Z", "2027-10-01T09:30:00.000Z", 0, 0, "tentative", 1, "system", now, now],
  );
}

function event<T extends Record<string, unknown>>(type: DomainEvent["type"], subject: { type: string; id: string }, data: T): DomainEvent<T> {
  return buildEvent({ type, subject, data }, { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_screact" });
}

describe("scheduling.release_placement_on_cancel", () => {
  beforeAll(seed);

  it("session.cancelled releases the placement, and redelivery of the same event id is a no-op", async () => {
    const ev = event("session.cancelled", { type: "session", id: SESSION }, { session_id: SESSION, reason: "Speaker withdrew.", was_published: false });

    const first = await deliverEvent(env, ev);
    expect(first).toContain("scheduling.release_placement_on_cancel");
    const { results: after1 } = await env.DB.prepare("SELECT COUNT(*) AS n FROM placement WHERE id = ?").bind(PLACEMENT).all<{ n: number }>();
    expect(after1[0].n).toBe(0);

    const { results: removedEvents } = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'placement.removed' AND subject_id = ?").bind(PLACEMENT).all<{ n: number }>();
    expect(removedEvents[0].n).toBe(1);

    // Redelivered: the placement is already gone, so this is a no-op rather
    // than an error, and no second placement.removed is recorded.
    const second = await deliverEvent(env, ev);
    expect(second).toEqual([]);
    const { results: removedEventsAgain } = await env.DB.prepare("SELECT COUNT(*) AS n FROM domain_event_record WHERE type = 'placement.removed' AND subject_id = ?").bind(PLACEMENT).all<{ n: number }>();
    expect(removedEventsAgain[0].n).toBe(1);
  });
});

describe("scheduling.recompute_conflicts_on_move", () => {
  const EVENT2 = "evt_screact_move";
  const SESSION_A = "ses_screact_a";
  const SESSION_B = "ses_screact_b";
  const PLACEMENT_A = "plc_screact_a";
  const PLACEMENT_B = "plc_screact_b";

  beforeAll(async () => {
    const now = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [EVENT2, "Screact Conf 2", "screact-conf-2", "UTC", "2027-10-02", "2027-10-02", "in_person", "active", "public", "{}", now, now],
    );
    for (const [id, ref] of [
      [SESSION_A, "T-0002"],
      [SESSION_B, "T-0003"],
    ]) {
      await run(
        `INSERT OR IGNORE INTO session (id, event_id, reference, origin, title, abstract, session_format_id, duration_minutes, status, content_status, visibility, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, EVENT2, ref, "cfp", `Talk ${ref}`, "Abstract.", FORMAT, 30, "scheduled", "approved", "public", now, now],
      );
    }
    // Both in the same room, overlapping — a conflict already exists before
    // any reaction runs.
    await run(
      `INSERT OR IGNORE INTO placement (id, event_id, session_id, room_id, event_day_id, starts_at, ends_at, setup_minutes, teardown_minutes, status, is_public, placed_by_person_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [PLACEMENT_A, EVENT2, SESSION_A, ROOM, DAY, "2027-10-02T09:00:00.000Z", "2027-10-02T09:30:00.000Z", 0, 0, "tentative", 1, "system", now, now],
    );
    await run(
      `INSERT OR IGNORE INTO placement (id, event_id, session_id, room_id, event_day_id, starts_at, ends_at, setup_minutes, teardown_minutes, status, is_public, placed_by_person_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [PLACEMENT_B, EVENT2, SESSION_B, ROOM, DAY, "2027-10-02T09:15:00.000Z", "2027-10-02T09:45:00.000Z", 0, 0, "tentative", 1, "system", now, now],
    );
  });

  it("recomputes ScheduleConflict rows for the event on placement.moved, idempotently", async () => {
    const ev = buildEvent(
      { type: "placement.moved", subject: { type: "placement", id: PLACEMENT_B }, data: { placement_id: PLACEMENT_B, session_id: SESSION_B, from: { room_id: ROOM, starts_at: "x" }, to: { room_id: ROOM, starts_at: "2027-10-02T09:15:00.000Z" } } },
      { org_id: ORG, event_id: EVENT2, actor: SYSTEM_ACTOR, correlation_id: "req_screact_move" },
    );

    const first = await deliverEvent(env, ev);
    expect(first).toContain("scheduling.recompute_conflicts_on_move");
    const { results } = await env.DB.prepare("SELECT code FROM schedule_conflict WHERE event_id = ?").bind(EVENT2).all<{ code: string }>();
    expect(results.some((r) => r.code === "ROOM_DOUBLE_BOOKED")).toBe(true);

    const second = await deliverEvent(env, ev);
    expect(second).toEqual([]);
    // Still exactly the rows a single recomputation would leave — no
    // duplicate conflict rows from redelivery.
    const { results: again } = await env.DB.prepare("SELECT COUNT(*) AS n FROM schedule_conflict WHERE event_id = ? AND code = 'ROOM_DOUBLE_BOOKED'").bind(EVENT2).all<{ n: number }>();
    expect(again[0].n).toBe(1);
  });
});

describe("scheduling.invalidate_cache_on_publish", () => {
  it("invalidates the KV snapshot cache, idempotently on redelivery", async () => {
    await env.CACHE.put(`snapshot:${EVENT}`, JSON.stringify({ stale: true }));
    const ev = event("schedule.published", { type: "publication", id: "pub_screact" }, { publication_id: "pub_screact", version: 1, session_count: 0, content_etag: '"x"', override_reasons: null });

    const first = await deliverEvent(env, ev);
    expect(first).toContain("scheduling.invalidate_cache_on_publish");
    expect(await env.CACHE.get(`snapshot:${EVENT}`)).toBeNull();

    // Redelivery: still absent, still a no-op, no error.
    const second = await deliverEvent(env, ev);
    expect(second).toEqual([]);
    expect(await env.CACHE.get(`snapshot:${EVENT}`)).toBeNull();
  });
});
