import { env as testEnv } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "@podiumstack/data/context.js";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { autoCompleteInstance } from "@podiumstack/web/contexts/onboarding/service.js";
import { publishSchedule } from "@podiumstack/web/contexts/scheduling/publication.js";
import { drain, handlerRan, stepsOfType } from "../helpers/events.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * The other signature cascade the README advertises: closing the last
 * blocking onboarding task republishes the schedule and tells the affected
 * speaker, with nobody polling for it.
 *
 * The cascade under test (10-domain-events.md, "Reactions — dispatched from
 * the queue"):
 *
 *   task_instance.completed
 *     -> onboarding.check_session_complete            => onboarding.session_complete
 *          -> scheduling.recompute_readiness_on_task_complete
 *               -- auto_publish on (R25) --           => schedule.published, schedule.changed
 *                    -> scheduling.invalidate_cache_on_publish   (on schedule.published)
 *                    -> platform.notify_schedule_change          (on schedule.changed)
 *
 * `onboarding.react_to_completion` also subscribes to `task_instance.completed`
 * (unblock dependents / chain `on_task_completed`) — it is asserted to have
 * run too, but this session has nothing downstream of the one task, so it is
 * a no-op past the dispatcher's log row.
 */

const ORG = "org_tccasc";
const EVENT = "evt_tccasc";
const VENUE = "ven_tccasc";
const ROOM = "rom_tccasc";
const DAY = "day_tccasc";
const FORMAT = "fmt_tccasc";
const SESSION = "ses_tccasc";
const SPEAKER = "per_tccasc_speaker";
const PLACEMENT = "plc_tccasc";
const TASK_DEF = "tdf_tccasc";
const TASK_INSTANCE = "tsk_tccasc";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Session Complete Cascade Org", "tccasc-org", "UTC", "a@b.example", "{}", now, now],
  );
  // R25 — auto_publish is off by default; this event opts in, which is what
  // makes closing the last blocking task actually republish rather than only
  // clear the block.
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Cascade Conf", "tccasc-conf", "UTC", "2028-05-01", "2028-05-01", "in_person", "active", "public", JSON.stringify({ publication: { auto_publish: true } }), now, now],
  );
  await run("INSERT OR IGNORE INTO venue (id, event_id, name) VALUES (?,?,?)", [VENUE, EVENT, "Venue"]);
  await run(
    "INSERT OR IGNORE INTO room (id, venue_id, event_id, name, slug, av_capabilities, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?)",
    [ROOM, VENUE, EVENT, "Room", "room", "[]", 0, 1],
  );
  await run("INSERT OR IGNORE INTO event_day (id, event_id, date, sort_order, is_public) VALUES (?,?,?,?,?)", [DAY, EVENT, "2028-05-01", 0, 1]);
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 1, '["cfp"]', 0, 1],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [SPEAKER, "tccasc-speaker@example.com", "Sasha Speaker", "active", 0, now, now],
  );
  await run(
    `INSERT OR IGNORE INTO session
      (id, event_id, reference, origin, title, abstract, session_format_id, duration_minutes, status, content_status, visibility, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [SESSION, EVENT, "TC-0001", "cfp", "A talk worth rearranging", "An abstract.", FORMAT, 30, "scheduled", "approved", "public", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO session_speaker (id, session_id, person_id, speaker_role, sort_order, confirmation_status, is_public, added_at) VALUES (?,?,?,?,?,?,?,?)",
    ["ssp_tccasc", SESSION, SPEAKER, "primary", 0, "confirmed", 1, now],
  );
  // Placed at 09:00 — this is the "before" the schedule.changed diff will be
  // computed against, once the first publish below makes it live.
  await run(
    `INSERT OR IGNORE INTO placement
      (id, event_id, session_id, room_id, event_day_id, starts_at, ends_at, setup_minutes, teardown_minutes, status, is_public, placed_by_person_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PLACEMENT, EVENT, SESSION, ROOM, DAY, "2028-05-01T09:00:00.000Z", "2028-05-01T09:30:00.000Z", 0, 0, "tentative", 1, "system", now, now],
  );
  // The one blocking task standing between this session and readiness.
  await run(
    `INSERT OR IGNORE INTO task_definition
      (id, event_id, key, title, category, requirement_type, config, subject_type, assignee_rule, trigger, due_rule, is_blocking, is_required, requires_review, status, version, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [TASK_DEF, EVENT, "tccasc-last-task", "Confirm the demo works", "technical", "acknowledgement", "{}", "session", "primary_speaker_only", "manual", "none", 1, 1, 0, "active", 1, now, now, 1],
  );
  await run(
    `INSERT INTO task_instance
      (id, event_id, definition_id, definition_version, definition_key, title, requirement_type, config, subject_type, subject_id, session_id, assignee_person_id, status, is_blocking, is_required, requires_review, reminder_count, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [TASK_INSTANCE, EVENT, TASK_DEF, 1, "tccasc-last-task", "Confirm the demo works", "acknowledgement", "{}", "session", SESSION, SESSION, SPEAKER, "not_started", 1, 1, 0, 0, now, now, 1],
  );

  // Publish once up front so there is a `live` publication to diff against —
  // setup, not part of the cascade under test, so it is not drained. The one
  // blocking task is still open at this point, so `INV-08-4` would otherwise
  // leave the session out of the snapshot entirely (unplaced sessions and
  // ones with an outstanding block are skipped, not merely flagged); the
  // override — required to carry a reason, INV-11-5 — is what makes this a
  // real "previous version" to diff the auto-publish against, standing in
  // for an organizer who published ahead of the checklist once already.
  const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
  await publishSchedule(app, EVENT, {
    note: "Initial publish (fixture setup).",
    override_reasons: { [SESSION]: "Fixture setup — publish once ahead of the checklist to give the cascade something to diff against." },
  });
  await app.flush();

  // Re-arrange the grid before the last task closes — 10:30 instead of 09:00
  // — the change the second publish's diff must surface.
  await run("UPDATE placement SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?", [
    "2028-05-01T10:30:00.000Z",
    "2028-05-01T11:00:00.000Z",
    now,
    PLACEMENT,
  ]);

  // A stale cache entry — asserted gone once `scheduling.invalidate_cache_on_publish` runs.
  await env.CACHE.put(`snapshot:${EVENT}`, JSON.stringify({ stale: true }));
}

describe("task_instance.completed — schedule readiness, republish and speaker notification", () => {
  beforeAll(seed);

  it("closing the last blocking task auto-publishes the moved placement and notifies the speaker", async () => {
    const beforePublications = await env.DB.prepare("SELECT COUNT(*) AS n FROM schedule_publication WHERE event_id = ?").bind(EVENT).first<{ n: number }>();
    expect(beforePublications?.n).toBe(1); // just the fixture's initial publish

    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    const completed = await autoCompleteInstance(app, TASK_INSTANCE);
    expect(completed?.status).toBe("completed");
    const seedEvents = await app.flush();
    expect(seedEvents.map((e) => e.type)).toContain("task_instance.completed");

    const result = await drain(env, seedEvents);

    // Hop 1: task_instance.completed ran both of Onboarding's reactions.
    expect(handlerRan(result, "onboarding.react_to_completion")).toBe(true);
    expect(handlerRan(result, "onboarding.check_session_complete")).toBe(true);

    // Hop 2: onboarding.session_complete ran Scheduling's readiness reaction.
    const sessionCompleteSteps = stepsOfType(result, "onboarding.session_complete");
    expect(sessionCompleteSteps).toHaveLength(1);
    expect(sessionCompleteSteps[0].event.data).toMatchObject({ session_id: SESSION });
    expect(sessionCompleteSteps[0].handlers).toContain("scheduling.recompute_readiness_on_task_complete");

    // Hop 3: auto_publish being on means that reaction actually published —
    // schedule.published and schedule.changed are both children of the
    // onboarding.session_complete hop, not of one another.
    const publishedSteps = stepsOfType(result, "schedule.published");
    expect(publishedSteps).toHaveLength(1);
    expect(publishedSteps[0].handlers).toContain("scheduling.invalidate_cache_on_publish");

    const changedSteps = stepsOfType(result, "schedule.changed");
    expect(changedSteps).toHaveLength(1);
    expect(changedSteps[0].handlers).toContain("platform.notify_schedule_change");
    const diff = (changedSteps[0].event.data as { diff: { change_type: string; session_id: string }[] }).diff;
    expect(diff.some((d) => d.change_type === "time_changed" && d.session_id === SESSION)).toBe(true);

    // Downstream state: a second, live SchedulePublication with the moved time.
    const publications = await env.DB.prepare("SELECT id, version, status FROM schedule_publication WHERE event_id = ? ORDER BY version").bind(EVENT).all<{ id: string; version: number; status: string }>();
    expect(publications.results).toHaveLength(2);
    expect(publications.results[0].status).toBe("superseded"); // INV-08-9: exactly one live publication
    expect(publications.results[1].status).toBe("live");

    // The blocking task no longer blocks readiness (it is why the publish happened).
    const outstanding = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM task_instance WHERE session_id = ? AND is_blocking = 1 AND status NOT IN ('completed','waived','cancelled')",
    )
      .bind(SESSION)
      .first<{ n: number }>();
    expect(outstanding?.n).toBe(0);

    // The speaker was actually notified — not just that the reaction ran,
    // but that it did what it says: one queued notification, addressed to
    // the speaker whose session moved, on the template the reaction map names.
    const notifications = await env.DB.prepare(
      "SELECT template_key, recipient_person_id, subject_id FROM notification_delivery WHERE subject_type = 'session' AND subject_id = ?",
    )
      .bind(SESSION)
      .all<{ template_key: string; recipient_person_id: string; subject_id: string }>();
    expect(notifications.results).toHaveLength(1);
    expect(notifications.results[0].template_key).toBe("schedule.changed");
    expect(notifications.results[0].recipient_person_id).toBe(SPEAKER);

    // The embed cache was actually invalidated (INV-09-6's cache is the one
    // performance decision the whole publication model leans on) — not left
    // serving the stale snapshot the fixture seeded.
    expect(await env.CACHE.get(`snapshot:${EVENT}`)).toBeNull();
  });
});
