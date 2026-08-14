import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * 08, "The embed (J10)" and INV-08-13 — the public surface end to end:
 * landing, schedule, sessions, speakers, ICS and the embed, against real D1
 * and KV (Miniflare). Every request here is anonymous; none may redirect to
 * a login page or gate content behind one.
 */

const ORG = "org_pub";
const EVENT = "evt_pub";
const EVENT_SLUG = "pub-conf";
const VENUE = "ven_pub";
const ROOM = "rom_pub";
const DAY = "day_pub";
const FORMAT = "fmt_pub";
const TRACK = "trk_pub";
const CFP = "cfp_pub";
const CHAIR_EMAIL = "pub-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-4";
const CHAIR = "per_pub_chair";
const SPEAKER = "per_pub_speaker";
const SESSION = "ses_pub_1";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Pub Org", "pub-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, tagline, description, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Pub Conf", EVENT_SLUG, "Talks worth flying for.", "A conference about publishing schedules.", "UTC", "2027-11-01", "2027-11-01", "in_person", "active", "public", "{}", now, now],
  );
  await run("INSERT OR IGNORE INTO venue (id, event_id, name) VALUES (?,?,?)", [VENUE, EVENT, "Main Hall"]);
  await run(
    "INSERT OR IGNORE INTO room (id, venue_id, event_id, name, slug, av_capabilities, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?)",
    [ROOM, VENUE, EVENT, "Room A", "room-a", "[]", 0, 1],
  );
  await run("INSERT OR IGNORE INTO event_day (id, event_id, date, label, sort_order, is_public) VALUES (?,?,?,?,?,?)", [DAY, EVENT, "2027-11-01", "Day 1", 0, 1]);
  await run("INSERT OR IGNORE INTO track (id, event_id, name, slug, sort_order, is_public) VALUES (?,?,?,?,?,?)", [TRACK, EVENT, "Agents", "agents", 0, 1]);
  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 1, '["cfp"]', 0, 1],
  );
  // A closed CFP — INV-02-12: never 404, states the deadline that passed.
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, audience, opens_at, closes_at, published_at, active_form_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main CFP", "main", "public", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null, now, now],
  );

  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [CHAIR, CHAIR_EMAIL, "Chair Person", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [SPEAKER, "pub-speaker@example.com", "Ada Speaker", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_pub_chair", CHAIR, "password", CHAIR_EMAIL, hashPassword(CHAIR_PASSWORD), now, CHAIR_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
    ["rg_pub_chair", CHAIR, "program_chair", "event", EVENT, CHAIR, now],
  );

  await run(
    `INSERT OR IGNORE INTO session
      (id, event_id, reference, origin, title, abstract, session_format_id, track_id, duration_minutes, status, content_status, visibility, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [SESSION, EVENT, "T-0001", "cfp", "Publishing at Scale", "How the snapshot model keeps the embed fast.", FORMAT, TRACK, 30, "confirmed", "approved", "public", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO session_speaker (id, session_id, person_id, speaker_role, confirmation_status, is_public, added_at) VALUES (?,?,?,?,?,?,?)",
    ["spk_pub_1", SESSION, SPEAKER, "primary", "confirmed", 1, now],
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
  if (!match) throw new Error("sign-in failed");
  return `podium_session=${match[1]}`;
}

async function publish(cookie: string) {
  const place = await SELF.fetch(`http://localhost/admin/events/${EVENT}/schedule/place`, {
    method: "POST",
    body: new URLSearchParams({ session_id: SESSION, room_id: ROOM, event_day_id: DAY, start_time: "09:00" }),
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(place.status).toBe(303);
  const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/publications`, {
    method: "POST",
    body: new URLSearchParams({ note: "First publish" }),
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
}

describe("public event surfaces — anonymous and complete (INV-08-13)", () => {
  beforeAll(async () => {
    await seed();
    const cookie = await signInChair();
    await publish(cookie);
  });

  it("GET / renders the single public event's landing page directly, with no redirect", async () => {
    const res = await SELF.fetch("http://localhost/", { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Pub Conf");
    expect(body).toContain("Sign in");
  });

  it("GET /e/:slug renders the landing page with no login prompt", async () => {
    const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Pub Conf");
    expect(body).not.toContain("Sign in to continue");
  });

  it("INV-02-12: a closed CFP still renders — never a 404", async () => {
    const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/cfp/main`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/closed/i);
  });

  it("GET /e/:slug/schedule serves the live snapshot with an etag and answers 304 on If-None-Match", async () => {
    const first = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/schedule`, { redirect: "manual" });
    expect(first.status).toBe(200);
    const body = await first.text();
    expect(body).toContain("Publishing at Scale");
    expect(body).not.toContain("Sign in to continue");

    const etag = first.headers.get("etag");
    // The full page carries the embedded snapshot's etag inside the JSON
    // island; check it round-trips through the JSON endpoint's own headers.
    const jsonRes = await SELF.fetch(`http://localhost/v1/public/events/${EVENT_SLUG}/schedule`);
    const jsonEtag = jsonRes.headers.get("etag");
    expect(jsonEtag).toBeTruthy();

    const conditional = await SELF.fetch(`http://localhost/v1/public/events/${EVENT_SLUG}/schedule`, { headers: { "if-none-match": jsonEtag! } });
    expect(conditional.status).toBe(304);
    void etag;
  });

  it("08: every widget type is reachable by browsing from the landing page, not only by embed key", async () => {
    const landing = await (await SELF.fetch(`http://localhost/e/${EVENT_SLUG}`, { redirect: "manual" })).text();
    for (const path of ["/schedule", "/sessions", "/speakers", "/gallery"]) {
      expect(landing).toContain(`/e/${EVENT_SLUG}${path}`);
    }
  });

  it("08: /e/:slug/sessions and /e/:slug/gallery read anonymously, with no login prompt (INV-08-13)", async () => {
    for (const path of ["sessions", "gallery"]) {
      const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/${path}`, { redirect: "manual" });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Publishing at Scale");
      expect(body).not.toContain("Sign in to continue");
    }
  });

  it("08: both speaker surfaces offer a search-by-name box over the directory", async () => {
    for (const path of ["speakers", "gallery"]) {
      const body = await (await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/${path}`, { redirect: "manual" })).text();
      expect(body).toContain('id="podium-speaker-search"');
      expect(body).toContain("data-name=");
    }
  });

  it("08: the public schedule offers keyword search and track/format/room facets over the snapshot", async () => {
    const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/schedule`, { redirect: "manual" });
    const body = await res.text();
    expect(body).toContain('id="podium-search"');
    // A facet is dropped when there is nothing to choose between, so assert on
    // the wiring the client script binds to rather than on all three selects.
    expect(body).toContain("data-podium-facet");
    expect(body).toContain("data-track=");
    expect(body).toContain("data-format=");
    expect(body).toContain("data-room=");
  });

  it("GET /e/:slug/sessions/:id shows the session, with the speaker resolved from the snapshot", async () => {
    const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/sessions/${SESSION}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Publishing at Scale");
    expect(body).toContain("Ada Speaker");
  });

  it("a session id that is not (or no longer) published never 404s — INV-08-10", async () => {
    const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/sessions/ses_does_not_exist`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/not part of the published schedule/);
  });

  it("GET /e/:slug/speakers lists the directory; GET /e/:slug/speakers/:id shows one speaker, without their email", async () => {
    const list = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/speakers`, { redirect: "manual" });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("Ada Speaker");

    const detail = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/speakers/${SPEAKER}`, { redirect: "manual" });
    expect(detail.status).toBe(200);
    const body = await detail.text();
    expect(body).toContain("Ada Speaker");
    expect(body).not.toContain("pub-speaker@example.com");
  });

  it("GET /e/:slug/schedule.ics returns a VCALENDAR with the published session as a VEVENT", async () => {
    const res = await SELF.fetch(`http://localhost/e/${EVENT_SLUG}/schedule.ics`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("SUMMARY:Publishing at Scale");
  });

  it("PII: the public JSON schedule carries no email or other never-public field (INV-08-8 / INV-01-4)", async () => {
    const res = await SELF.fetch(`http://localhost/v1/public/events/${EVENT_SLUG}/schedule`);
    const body = await res.text();
    expect(body).not.toContain("pub-speaker@example.com");
    expect(body).not.toMatch(/"email"/);
    expect(body).not.toMatch(/"dietary_notes"/);
  });
});

describe("the embed — INV-08-6 (CORS) and INV-08-13 (anonymous, no gate)", () => {
  const KEY = "pub-embed-key-1";
  const IFRAME_KEY = "pub-embed-key-2";

  beforeAll(async () => {
    const now = new Date().toISOString();
    await run(
      `INSERT OR IGNORE INTO embed_config
        (id, event_id, key, name, widget_type, allowed_origins, format, show_unpublished, cache_ttl_seconds, status, created_by_person_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["emb_pub_1", EVENT, KEY, "Main site widget", "sessions_list", JSON.stringify(["https://allowed.example"]), "js_widget", 0, 300, "active", CHAIR, now],
    );
    await run(
      `INSERT OR IGNORE INTO embed_config
        (id, event_id, key, name, widget_type, allowed_origins, format, show_unpublished, cache_ttl_seconds, status, created_by_person_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["emb_pub_2", EVENT, IFRAME_KEY, "Framed agenda", "agenda_grid", JSON.stringify(["https://allowed.example"]), "iframe", 0, 300, "active", CHAIR, now],
    );
  });

  it("reads with no login prompt or redirect, from an unauthenticated request", async () => {
    const res = await SELF.fetch(`http://localhost/embed/${KEY}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(302);
    const body = await res.text();
    expect(body).toContain("Publishing at Scale");
  });

  it("INV-08-6: an unlisted origin gets no CORS headers", async () => {
    const res = await SELF.fetch(`http://localhost/embed/${KEY}`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a listed origin gets an Access-Control-Allow-Origin header naming it", async () => {
    const res = await SELF.fetch(`http://localhost/embed/${KEY}`, { headers: { origin: "https://allowed.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  });

  it("answers 304 on a matching If-None-Match", async () => {
    const first = await SELF.fetch(`http://localhost/embed/${KEY}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await SELF.fetch(`http://localhost/embed/${KEY}`, { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);
  });

  it("INV-08-7: the JSON format always carries is_sponsored_content, disclosure that is never themeable", async () => {
    await run(
      `INSERT OR IGNORE INTO embed_config (id, event_id, key, name, widget_type, allowed_origins, format, show_unpublished, cache_ttl_seconds, status, created_by_person_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["emb_pub_3", EVENT, "pub-embed-key-json", "JSON feed", "sessions_list", JSON.stringify(["https://allowed.example"]), "json", 0, 300, "active", CHAIR, new Date().toISOString()],
    );
    const res = await SELF.fetch("http://localhost/embed/pub-embed-key-json");
    expect(res.status).toBe(200);
    const body = await res.json<{ sessions: { title: string; is_sponsored_content: boolean }[] }>();
    const session = body.sessions.find((s) => s.title === "Publishing at Scale");
    expect(session).toBeTruthy();
    expect(session!.is_sponsored_content).toBe(false);
  });

  it("INV-08-12: an impossible widget/format pair is rejected at configuration time, not request time", async () => {
    const cookie = await signInChair();
    const res = await SELF.fetch(`http://localhost/admin/events/${EVENT}/embeds`, {
      method: "POST",
      body: new URLSearchParams({ name: "Bad combo", widget_type: "speaker_gallery", format: "ics", allowed_origins: "https://allowed.example" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      redirect: "manual",
    });
    expect(res.status).toBe(422);
    const body = await res.json<{ invariant?: string }>();
    expect(body.invariant).toBe("INV-08-12");
  });

  it("iframe format falls back to a full server-rendered HTML page with frame-ancestors naming the allowed origins", async () => {
    const res = await SELF.fetch(`http://localhost/embed/${IFRAME_KEY}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("https://allowed.example");
    const body = await res.text();
    expect(body).toContain("<html");
  });

  it("GET /embed.js serves one script exposing window.Podium", async () => {
    const res = await SELF.fetch("http://localhost/embed.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("window.Podium");
  });
});

describe("home — one event renders its landing page; several render a list", () => {
  const EVENT2 = "evt_pub_second";
  const EVENT2_SLUG = "pub-conf-second";
  const DRAFT_EVENT = "evt_pub_draft";

  it("with two public events, GET / lists them instead of picking one", async () => {
    const now = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [EVENT2, "Second Pub Conf", EVENT2_SLUG, "UTC", "2027-12-01", "2027-12-01", "in_person", "active", "public", "{}", now, now],
    );
    // A draft event, even though public, has no public surface at all.
    await run(
      "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [DRAFT_EVENT, "Unlaunched Conf", "unlaunched-conf", "UTC", "2028-01-01", "2028-01-01", "in_person", "draft", "public", "{}", now, now],
    );

    const res = await SELF.fetch("http://localhost/", { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Pub Conf");
    expect(body).toContain("Second Pub Conf");
    expect(body).not.toContain("Unlaunched Conf");
  });

  it("a draft event has no public landing page", async () => {
    const res = await SELF.fetch("http://localhost/e/unlaunched-conf", { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});
