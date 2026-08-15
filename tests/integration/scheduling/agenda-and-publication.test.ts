import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * 08, "Placement" and "Publication" — the admin surfaces end to end, against
 * real D1, KV and the schedule Durable Object (Miniflare).
 */

const ORG = "org_sched";
const EVENT = "evt_sched";
const VENUE = "ven_sched";
const ROOM_A = "rom_sched_a";
const ROOM_B = "rom_sched_b";
const DAY = "day_sched_1";
const TRACK = "trk_sched";
const FORMAT = "fmt_sched";
const CHAIR_EMAIL = "sched-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-3";
const CHAIR = "per_sched_chair";
const SPEAKER = "per_sched_speaker";
const SESSION_1 = "ses_sched_1";
const SESSION_2 = "ses_sched_2";
const SPEAKER_HEADSHOT = "ast_sched_headshot";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Sched Org", "sched-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Sched Conf", "sched-conf", "UTC", "2027-09-01", "2027-09-01", "in_person", "active", "public", "{}", now, now],
  );
  await run("INSERT OR IGNORE INTO venue (id, event_id, name) VALUES (?,?,?)", [VENUE, EVENT, "Main Venue"]);
  await run(
    "INSERT OR IGNORE INTO room (id, venue_id, event_id, name, slug, capacity, av_capabilities, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?)",
    [ROOM_A, VENUE, EVENT, "Room A", "room-a", 100, "[]", 0, 1],
  );
  await run(
    "INSERT OR IGNORE INTO room (id, venue_id, event_id, name, slug, capacity, av_capabilities, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?)",
    [ROOM_B, VENUE, EVENT, "Room B", "room-b", 50, "[]", 1, 1],
  );
  await run("INSERT OR IGNORE INTO event_day (id, event_id, date, label, sort_order, is_public) VALUES (?,?,?,?,?,?)", [DAY, EVENT, "2027-09-01", "Day 1", 0, 1]);
  await run("INSERT OR IGNORE INTO track (id, event_id, name, slug, sort_order, is_public) VALUES (?,?,?,?,?,?)", [TRACK, EVENT, "Agents", "agents", 0, 1]);
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 1, '["cfp"]', 0, 1],
  );

  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [CHAIR, CHAIR_EMAIL, "Chair Person", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [SPEAKER, "sched-speaker@example.com", "Speaker Person", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_sched_chair", CHAIR, "password", CHAIR_EMAIL, hashPassword(CHAIR_PASSWORD), now, CHAIR_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
    ["rg_sched_chair", CHAIR, "program_chair", "event", EVENT, CHAIR, now],
  );

  for (const [id, ref] of [
    [SESSION_1, "T-0001"],
    [SESSION_2, "T-0002"],
  ]) {
    await run(
      `INSERT OR IGNORE INTO session
        (id, event_id, reference, origin, title, abstract, session_format_id, track_id, duration_minutes, status, content_status, visibility, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, EVENT, ref, "cfp", `Session ${ref}`, "An abstract.", FORMAT, TRACK, 30, "confirmed", "approved", "public", now, now],
    );
  }
  await run(
    "INSERT OR IGNORE INTO session_speaker (id, session_id, person_id, speaker_role, confirmation_status, is_public, added_at) VALUES (?,?,?,?,?,?,?)",
    ["spk_sched_1", SESSION_1, SPEAKER, "primary", "confirmed", 1, now],
  );

  // A public, clean headshot in the speaker's profile — what exercises
  // `assetUrl` in the snapshot builder, below.
  await run(
    "INSERT OR IGNORE INTO asset (id, storage_key, filename, content_type, size_bytes, checksum, scan_status, visibility, uploaded_by_person_id, purpose, slot_key, version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [SPEAKER_HEADSHOT, `${ORG}/person/${SPEAKER}/headshot/1/me.png`, "me.png", "image/png", 9, "deadbeef", "clean", "public", SPEAKER, "headshot", `person:${SPEAKER}:headshot`, 1, now],
  );
  await env.ASSETS_BUCKET.put(`${ORG}/person/${SPEAKER}/headshot/1/me.png`, "headshot bytes");
  await run(
    "INSERT OR IGNORE INTO speaker_profile (id, person_id, headshot_asset_id, is_listed, visibility, updated_at) VALUES (?,?,?,?,?,?)",
    ["spf_sched", SPEAKER, SPEAKER_HEADSHOT, 1, "{}", now],
  );
}

async function signInChair(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: CHAIR_EMAIL, password: CHAIR_PASSWORD }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /podium_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Sign-in did not set a session cookie: ${setCookie}`);
  return `podium_session=${match[1]}`;
}

describe("the agenda builder", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signInChair();
  });

  it("INV-08-14: a placement write returns its conflicts in the same response", async () => {
    // Place both sessions in the same room at overlapping times — a
    // deliberately broken draft, which the model explicitly allows.
    const first = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/place`, {
      method: "POST",
      body: new URLSearchParams({ session_id: SESSION_1, room_id: ROOM_A, event_day_id: DAY, start_time: "09:00" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(first.status).toBe(303);

    const second = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/place`, {
      method: "POST",
      body: new URLSearchParams({ session_id: SESSION_2, room_id: ROOM_A, event_day_id: DAY, start_time: "09:15" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(second.status).toBe(303);

    // The write already computed and persisted ROOM_DOUBLE_BOOKED
    // synchronously (INV-08-14) — the builder page shows it without a
    // separate recompute step.
    const { results } = await env.DB.prepare("SELECT code, severity FROM schedule_conflict WHERE event_id = ?").bind(EVENT).all<{ code: string; severity: string }>();
    expect(results.some((r) => r.code === "ROOM_DOUBLE_BOOKED" && r.severity === "error")).toBe(true);

    // `?nojs=1`: the admin console (R30) owns this URL now, and this assertion
    // is about the server-rendered builder behind it. The console's own path to
    // the same guarantee — conflicts in the write's response — is asserted over
    // `/v1` at the foot of this file.
    const page = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule?nojs=1`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Room double-booked");
  });

  it("moving one of them apart clears the conflict", async () => {
    const { results } = await env.DB.prepare("SELECT id FROM placement WHERE session_id = ?").bind(SESSION_2).all<{ id: string }>();
    const placementId = results[0].id;

    const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/move`, {
      method: "POST",
      body: new URLSearchParams({ placement_id: placementId, room_id: ROOM_B, event_day_id: DAY, start_time: "09:15" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const { results: conflicts } = await env.DB.prepare("SELECT code FROM schedule_conflict WHERE event_id = ?").bind(EVENT).all<{ code: string }>();
    expect(conflicts.some((r) => r.code === "ROOM_DOUBLE_BOOKED")).toBe(false);
  });

  it("INV-11-5: acknowledging a conflict requires a reason", async () => {
    // Recreate the clash from the first test by moving session_2's (now in
    // Room B) placement back onto session_1's — it already has a placement,
    // so this goes through "move", not "place".
    const { results: existing } = await env.DB.prepare("SELECT id FROM placement WHERE session_id = ?").bind(SESSION_2).all<{ id: string }>();
    expect(existing).toHaveLength(1);
    const moveBack = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/move`, {
      method: "POST",
      body: new URLSearchParams({ placement_id: existing[0].id, room_id: ROOM_A, event_day_id: DAY, start_time: "09:00" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(moveBack.status).toBe(303);

    const { results } = await env.DB.prepare("SELECT id FROM schedule_conflict WHERE event_id = ? AND code = 'ROOM_DOUBLE_BOOKED'").bind(EVENT).all<{ id: string }>();
    expect(results.length).toBeGreaterThan(0);

    const withoutReason = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/acknowledge`, {
      method: "POST",
      body: new URLSearchParams({ conflict_id: results[0].id, reason: "" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      redirect: "manual",
    });
    expect(withoutReason.status).toBe(422);
    const body = await withoutReason.json<{ invariant?: string }>();
    expect(body.invariant).toBe("INV-11-5");

    const withReason = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/acknowledge`, {
      method: "POST",
      body: new URLSearchParams({ conflict_id: results[0].id, reason: "Known clash, accepted by the chairs." }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(withReason.status).toBe(303);
  });

  it("removing a placement returns the session to confirmed and clears its row", async () => {
    const { results } = await env.DB.prepare("SELECT id FROM placement WHERE session_id = ?").bind(SESSION_2).all<{ id: string }>();
    expect(results).toHaveLength(1);
    const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/remove`, {
      method: "POST",
      body: new URLSearchParams({ placement_id: results[0].id }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const { results: sessionRows } = await env.DB.prepare("SELECT status FROM session WHERE id = ?").bind(SESSION_2).all<{ status: string }>();
    expect(sessionRows[0].status).toBe("confirmed");
  });

  it("Concurrency: two simultaneous placements of the same session serialise through the DO — exactly one wins, INV-08-1 catches the other", async () => {
    // session_2 is unplaced again after the previous test. Fire two "place"
    // requests for it at once, into two different rooms/times: "one writer
    // per event" (11-cross-cutting.md) means these queue rather than
    // interleave, so the second sees the first's placement already there.
    const [a, b] = await Promise.all([
      SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/place`, {
        method: "POST",
        body: new URLSearchParams({ session_id: SESSION_2, room_id: ROOM_A, event_day_id: DAY, start_time: "11:00" }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        redirect: "manual",
      }),
      SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/place`, {
        method: "POST",
        body: new URLSearchParams({ session_id: SESSION_2, room_id: ROOM_B, event_day_id: DAY, start_time: "12:00" }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        redirect: "manual",
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    // One redirect (succeeded), one 422 (INV-08-1: already placed) — never
    // two successes, and never a silently dropped write.
    expect(statuses).toEqual([303, 422]);

    const { results: placed } = await env.DB.prepare("SELECT COUNT(*) AS n FROM placement WHERE session_id = ?").bind(SESSION_2).all<{ n: number }>();
    expect(placed[0].n).toBe(1);
  });

  it("assisted placement proposes, and per-row accept applies through the same serialised path", async () => {
    // Start clean: remove session_2's placement so it is a candidate again.
    const { results: existing } = await env.DB.prepare("SELECT id FROM placement WHERE session_id = ?").bind(SESSION_2).all<{ id: string }>();
    if (existing.length) {
      await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/remove`, {
        method: "POST",
        body: new URLSearchParams({ placement_id: existing[0].id }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
      });
    }

    const propose = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/auto-place`, {
      method: "POST",
      body: new URLSearchParams({ strategy: "greedy_fill" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(propose.status).toBe(303);
    const location = propose.headers.get("location") ?? "";
    const runId = new URL(location, "http://localhost").searchParams.get("run");
    expect(runId).toBeTruthy();

    const { results: runRows } = await env.DB.prepare("SELECT proposed FROM auto_place_run WHERE id = ?").bind(runId).all<{ proposed: string }>();
    const proposed = JSON.parse(runRows[0].proposed) as { session_id: string }[];
    expect(proposed.some((p) => p.session_id === SESSION_2)).toBe(true);

    const apply = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/auto-place/apply`, {
      method: "POST",
      body: new URLSearchParams({ run_id: String(runId), session_id: SESSION_2 }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(apply.status).toBe(303);

    const { results: placedAgain } = await env.DB.prepare("SELECT COUNT(*) AS n FROM placement WHERE session_id = ?").bind(SESSION_2).all<{ n: number }>();
    expect(placedAgain[0].n).toBe(1);
  });
});

describe("publish, roll back, and pending changes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await signInChair();
  });

  it("publishes v1, then a title change shows up as a pending change until published again", async () => {
    const publish = await SELF.fetch(`http://localhost/admin/events/${EVENT}/publications`, {
      method: "POST",
      body: new URLSearchParams({ note: "First publish" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(publish.status).toBe(303);

    const { results: pubs } = await env.DB.prepare("SELECT id, version, status FROM schedule_publication WHERE event_id = ? ORDER BY version").bind(EVENT).all<{ id: string; version: number; status: string }>();
    expect(pubs.length).toBeGreaterThanOrEqual(1);
    const live = pubs.find((p) => p.status === "live")!;
    expect(live.version).toBe(pubs[pubs.length - 1].version);

    // The published snapshot has at least one session with the confirmed speaker.
    const { results: publishedSessions } = await env.DB.prepare("SELECT title, speaker_refs FROM published_session WHERE publication_id = ?").bind(live.id).all<{ title: string; speaker_refs: string }>();
    expect(publishedSessions.length).toBeGreaterThan(0);

    await env.DB.prepare("UPDATE session SET title = ?, updated_at = ? WHERE id = ?").bind("A retitled session", new Date().toISOString(), SESSION_1).run();

    const pendingPage = await SELF.fetch(`http://localhost/admin/events/${EVENT}/publications?nojs=1`, { headers: { cookie } });
    const body = await pendingPage.text();
    expect(body).toContain("not yet published");

    const republish = await SELF.fetch(`http://localhost/admin/events/${EVENT}/publications`, {
      method: "POST",
      body: new URLSearchParams({ note: "Retitled" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(republish.status).toBe(303);

    const { results: diffRows } = await env.DB.prepare(
      `SELECT change_type FROM schedule_diff_entry WHERE publication_id = (SELECT id FROM schedule_publication WHERE event_id = ? AND status = 'live')`,
    )
      .bind(EVENT)
      .all<{ change_type: string }>();
    expect(diffRows.some((r) => r.change_type === "content_changed")).toBe(true);
  });

  /**
   * `headshotUrl`/`assetUrl` (identity, event-config, scheduling, the public
   * surface) built `/assets/<id>` strings that no route ever answered —
   * caught only by requesting the URL a browser actually requests, not by
   * checking that the string merely looks right. A snapshot's `headshot_url`
   * is computed once, at publish time, and served verbatim from then on, so
   * this is the level a regression here has to be caught at.
   */
  it("a published speaker's headshot_url is /assets/<assetId>, and that URL actually serves the file", async () => {
    const { results: published } = await env.DB.prepare(
      `SELECT headshot_url FROM published_speaker WHERE person_id = ? AND publication_id = (SELECT id FROM schedule_publication WHERE event_id = ? AND status = 'live')`,
    )
      .bind(SPEAKER, EVENT)
      .all<{ headshot_url: string | null }>();
    expect(published).toHaveLength(1);
    expect(published[0].headshot_url).toBe(`/assets/${SPEAKER_HEADSHOT}`);

    const res = await SELF.fetch(`http://localhost${published[0].headshot_url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("headshot bytes");
  });

  it("INV-08-9 / rollback restores the previous version as the one live publication", async () => {
    const { results: pubs } = await env.DB.prepare("SELECT id, version, status FROM schedule_publication WHERE event_id = ? ORDER BY version").bind(EVENT).all<{ id: string; version: number; status: string }>();
    expect(pubs.length).toBeGreaterThanOrEqual(2);
    const first = pubs[0];
    const current = pubs.find((p) => p.status === "live")!;
    expect(current.id).not.toBe(first.id);

    const rollback = await SELF.fetch(`http://localhost/admin/publications/${first.id}/rollback`, {
      method: "POST",
      body: new URLSearchParams({ reason: "Wrong keynote time — rolling back before doors open." }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(rollback.status).toBe(303);

    const { results: liveNow } = await env.DB.prepare("SELECT id FROM schedule_publication WHERE event_id = ? AND status = 'live'").bind(EVENT).all<{ id: string }>();
    expect(liveNow).toHaveLength(1);
    expect(liveNow[0].id).toBe(first.id);

    const { results: supersededCurrent } = await env.DB.prepare("SELECT status FROM schedule_publication WHERE id = ?").bind(current.id).all<{ status: string }>();
    expect(supersededCurrent[0].status).toBe("rolled_back");

    // Republish so later tests in this file see a `live` publication again.
    await SELF.fetch(`http://localhost/admin/events/${EVENT}/publications`, {
      method: "POST",
      body: new URLSearchParams({ note: "Restore after rollback test" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
  });
});

/**
 * The same aggregate over `/v1` — the surface R30 named as the one blocker for
 * a client-rendered admin console, because a grid that drags a card cannot post
 * a form (09, "Scheduling on the management surface").
 *
 * What matters is that it is the *same* aggregate and not a second one: the
 * writes go through `runSerialised`, so one writer per event holds however the
 * write arrived, and the response carries the conflicts the write caused
 * (INV-08-14) rather than making the client re-fetch to find out what it broke.
 */
describe("scheduling on the management surface", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signInChair();
  });

  const json = (path: string, init: RequestInit = {}) =>
    SELF.fetch(`http://localhost/v1${path}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) },
    });

  it("reads the whole grid in one request", async () => {
    const res = await json(`/events/${EVENT}/schedule`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown[]> };
    // Days, rooms and the unplaced queue together: a grid that fetched these
    // separately could not be laid out until the last response landed.
    expect(data.days.length).toBeGreaterThan(0);
    expect(data.rooms.length).toBeGreaterThan(0);
    expect(Array.isArray(data.unplaced)).toBe(true);
    expect(Array.isArray(data.placements)).toBe(true);
  });

  it("INV-08-14: a placement write answers with the conflicts it caused", async () => {
    await env.DB.prepare("DELETE FROM placement WHERE event_id = ?").bind(EVENT).run();
    await env.DB.prepare("DELETE FROM schedule_conflict WHERE event_id = ?").bind(EVENT).run();
    await env.DB.prepare("UPDATE session SET status = 'confirmed' WHERE event_id = ?").bind(EVENT).run();

    const place = (sessionId: string, start: string, end: string) =>
      json(`/events/${EVENT}/placements`, {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, room_id: ROOM_A, event_day_id: DAY, starts_at: start, ends_at: end }),
      });

    const first = await place(SESSION_1, "2027-09-01T09:00:00.000Z", "2027-09-01T09:30:00.000Z");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { placement_id: string; conflicts: unknown[] } };
    expect(firstBody.data.placement_id).toBeTruthy();
    expect(firstBody.data.conflicts).toHaveLength(0);

    const second = await place(SESSION_2, "2027-09-01T09:15:00.000Z", "2027-09-01T09:45:00.000Z");
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { placement_id: string; conflicts: { code: string; severity: string }[] } };
    expect(secondBody.data.conflicts.some((c) => c.code === "ROOM_DOUBLE_BOOKED" && c.severity === "error")).toBe(true);

    // Moving it apart clears the clash, again in the write's own response.
    const moved = await json(`/placements/${secondBody.data.placement_id}`, {
      method: "PATCH",
      body: JSON.stringify({ room_id: ROOM_B }),
    });
    expect(moved.status).toBe(200);
    const movedBody = (await moved.json()) as { data: { conflicts: { code: string }[] } };
    expect(movedBody.data.conflicts.some((c) => c.code === "ROOM_DOUBLE_BOOKED")).toBe(false);

    const removed = await json(`/placements/${secondBody.data.placement_id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const stillThere = await env.DB.prepare("SELECT id FROM placement WHERE id = ?").bind(secondBody.data.placement_id).first();
    expect(stillThere).toBeNull();
  });

  it("refuses to acknowledge a conflict without a reason (INV-11-5)", async () => {
    await json(`/events/${EVENT}/placements`, {
      method: "POST",
      body: JSON.stringify({
        session_id: SESSION_2,
        room_id: ROOM_A,
        event_day_id: DAY,
        starts_at: "2027-09-01T09:10:00.000Z",
        ends_at: "2027-09-01T09:40:00.000Z",
      }),
    });
    const conflict = await env.DB.prepare("SELECT id FROM schedule_conflict WHERE event_id = ? LIMIT 1").bind(EVENT).first<{ id: string }>();
    expect(conflict).not.toBeNull();

    const bare = await json(`/conflicts/${conflict!.id}/acknowledge`, { method: "POST", body: JSON.stringify({}) });
    expect(bare.status).toBe(422);

    const withReason = await json(`/conflicts/${conflict!.id}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ reason: "Both are lightning talks; the overlap is deliberate." }),
    });
    expect(withReason.status).toBe(200);

    // An acknowledged conflict stays in the list rather than leaving it.
    const list = await json(`/events/${EVENT}/conflicts`);
    const { data } = (await list.json()) as { data: { id: string; acknowledged_reason: string | null }[] };
    expect(data.find((c) => c.id === conflict!.id)?.acknowledged_reason).toBeTruthy();
  });

  it("publishes and reports what is still unpublished", async () => {
    const published = await json(`/events/${EVENT}/publications`, { method: "POST", body: JSON.stringify({ note: "From the console" }) });
    expect(published.status).toBe(201);

    const list = await json(`/events/${EVENT}/publications`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: unknown[]; pending_changes: { count: number } };
    expect(body.data.length).toBeGreaterThan(0);
    expect(typeof body.pending_changes.count).toBe("number");
  });
});
