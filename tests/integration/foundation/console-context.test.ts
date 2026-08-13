import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * The admin console's event in context (R30).
 *
 * The console is one document that outlives the screen it booted on, and
 * `boot.event` is only ever the answer for the path the *document* was opened
 * at. Every client-side navigation that crosses out of that event has to ask
 * again, and `GET /v1/console/bootstrap?path=` is where it asks.
 *
 * What these tests pin down is that the asking and the booting give the same
 * answer. They resolve through the same `matchConsolePath` / `eventForMatch`
 * pair on purpose, so the interesting failure is not "the query parameter is
 * broken" — it is the two drifting apart, which is why every case below asserts
 * the bootstrap payload against the boot document for the same path rather than
 * against a hard-coded expectation.
 *
 * The defect this closes: opening `/admin/events`, clicking an event and landing
 * on its dashboard with no event bar and no section nav — the screen right and
 * every way out of it missing.
 */

const ORG = "org_console";
const OLDER_EVENT = "evt_console_older";
const EVENT = "evt_console";
const CFP = "cfp_console";
const FORM = "frm_console";
const PROPOSAL = "prp_console";
const CHAIR = "per_console_chair";
const CHAIR_EMAIL = "console-chair@example.com";
const CHAIR_PASSWORD = "a-long-enough-password-7";
const OUTSIDER = "per_console_outsider";
const OUTSIDER_EMAIL = "console-outsider@example.com";
const OUTSIDER_PASSWORD = "a-long-enough-password-8";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed() {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Console Org", "console-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  // Two events, so "the most recent one" is a choice rather than the only row.
  for (const [id, name, slug, starts] of [
    [OLDER_EVENT, "Console Conf 2026", "console-conf-2026", "2026-05-01"],
    [EVENT, "Console Conf 2027", "console-conf-2027", "2027-05-01"],
  ]) {
    await run(
      "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, ORG, name, slug, "UTC", starts, starts, "in_person", "active", "public", "{}", now, now],
    );
  }
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, audience, opens_at, closes_at, active_form_id, published_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main call", "main", "public", now, now, FORM, now, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO submission_form (id, cfp_id, version, status, published_at, created_at) VALUES (?,?,?,?,?,?)",
    [FORM, CFP, 1, "published", now, now],
  );
  await run(
    `INSERT OR IGNORE INTO proposal
       (id, org_id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, title, abstract, status, is_late, submitted_at, last_activity_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PROPOSAL, ORG, EVENT, CFP, FORM, "CON-0001", "cfp", CHAIR, "A talk", "An abstract.", "submitted", 0, now, now, now, now],
  );

  for (const [id, email, password] of [
    [CHAIR, CHAIR_EMAIL, CHAIR_PASSWORD],
    [OUTSIDER, OUTSIDER_EMAIL, OUTSIDER_PASSWORD],
  ]) {
    await run(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, ORG, email, "Console Person", "active", 0, now, now],
    );
    await run(
      "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [`aid_${id}`, id, "password", email, hashPassword(password), now, email, now],
    );
  }
  // The chair is a chair of the newer event only; the outsider holds nothing.
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_console_chair", ORG, CHAIR, "program_chair", "event", EVENT, CHAIR, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_console_chair_org", ORG, CHAIR, "organizer", "org", ORG, CHAIR, now],
  );
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email, password }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /podium_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Sign-in did not set a session cookie: ${setCookie}`);
  return `podium_session=${match[1]}`;
}

/** What the boot document for `path` would put in the console's hands. */
async function bootedEvent(path: string, cookie: string): Promise<string | null> {
  const res = await SELF.fetch(`http://localhost${path}`, { headers: { cookie, accept: "text/html" } });
  expect(res.status).toBe(200);
  const html = await res.text();
  const payload = /<script type="application\/json" id="console-boot">(.*?)<\/script>/s.exec(html);
  if (!payload) throw new Error(`${path} did not answer with a console boot document`);
  const boot = JSON.parse(payload[1].replace(/<\\\//g, "</"));
  return boot.event ? boot.event.id : null;
}

/** What the console gets when it navigates to `path` without a reload. */
async function navigatedTo(path: string, cookie: string) {
  const res = await SELF.fetch(`http://localhost/v1/console/bootstrap?path=${encodeURIComponent(path)}`, {
    headers: { cookie, accept: "application/json" },
  });
  const body = res.status === 200 ? ((await res.json()) as { data: Record<string, unknown> }).data : null;
  return { status: res.status, boot: body };
}

describe("the console's event in context", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signIn(CHAIR_EMAIL, CHAIR_PASSWORD);
  });

  // Each of these is a path a client-side navigation can land on, and each
  // reaches its event by a different route: named outright, through the call,
  // through the proposal, or not named at all.
  const paths = [
    [`/admin/events/${EVENT}`, "names the event"],
    [`/admin/events/${EVENT}/proposals`, "names the event, deeper"],
    [`/admin/cfps/${CFP}/form`, "reaches it through the call"],
    [`/admin/proposals/${PROPOSAL}`, "reaches it through the proposal"],
    ["/admin", "names none, and opens on the most recent"],
    ["/admin/events", "names none, and has none"],
    ["/review", "is the other console, and takes no event at all"],
  ] as const;

  for (const [path, how] of paths) {
    it(`resolves the same event navigating to ${path} as booting there — ${how}`, async () => {
      const booted = await bootedEvent(path, cookie);
      const navigated = await navigatedTo(path, cookie);
      expect(navigated.status).toBe(200);
      const event = navigated.boot!.event as { id: string } | null;
      expect(event ? event.id : null).toBe(booted);
    });
  }

  /**
   * The reviewer surface is the one console path that must *not* acquire an
   * event. `/review` is one segment long, like `/admin`, and the rule that
   * opens `/admin` on the most recent event would otherwise fly an event bar
   * over a queue that spans rounds in several of them — and hand the client a
   * rail belonging to a different screen.
   */
  it("boots /review with no event and the reviewer's own rail, and says so both ways", async () => {
    const res = await SELF.fetch("http://localhost/review", { headers: { cookie, accept: "text/html" } });
    const html = await res.text();
    const payload = /<script type="application\/json" id="console-boot">(.*?)<\/script>/s.exec(html)!;
    const booted = JSON.parse(payload[1].replace(/<\\\//g, "</"));
    expect(booted.surface).toBe("reviewer");
    expect(booted.event).toBeNull();
    expect(booted.reviewer).not.toBeNull();

    const navigated = await navigatedTo("/review", cookie);
    expect(navigated.status).toBe(200);
    expect(navigated.boot!.surface).toBe("reviewer");
    expect(navigated.boot!.event).toBeNull();
  });

  it("opens /admin on the most recent event, not the first one seeded", async () => {
    const navigated = await navigatedTo("/admin", cookie);
    expect((navigated.boot!.event as { id: string }).id).toBe(EVENT);
  });

  it("answers with the permissions of the event it resolved, not the one asked about", async () => {
    // The point of re-reading rather than adopting an event from the client's
    // own list: `can` / `can_write` are computed against the event in the
    // payload, so a console that switched event without them would keep drawing
    // the previous event's controls — the stale authority R30 forbids.
    const navigated = await navigatedTo(`/admin/events/${EVENT}`, cookie);
    const canWrite = navigated.boot!.can_write as Record<string, boolean>;
    expect(canWrite["proposal.edit"]).toBe(true);

    const older = await navigatedTo(`/admin/events/${OLDER_EVENT}`, cookie);
    // Chair of the newer event only — the older one is readable as an organizer
    // but not chairable, and the two payloads have to say so differently.
    expect((older.boot!.event as { id: string }).id).toBe(OLDER_EVENT);
    expect((older.boot!.can_write as Record<string, boolean>)["decision.manage"]).toBe(false);
  });

  it("refuses a path the reader may not open, rather than answering with its event", async () => {
    const outsider = await signIn(OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
    const navigated = await navigatedTo(`/admin/events/${EVENT}/proposals`, outsider);
    expect(navigated.status).toBe(403);
  });

  it("404s a path the console does not own, rather than guessing an event", async () => {
    // `/admin/settings` is a real screen and deliberately not a console one. A
    // bootstrap that answered for it would be telling the client it may render
    // a screen it has no view for.
    expect((await navigatedTo("/admin/settings", cookie)).status).toBe(404);
    expect((await navigatedTo("/admin/events/evt_nope", cookie)).status).toBe(404);
  });

  it("still answers the ?event= form, which the event switcher uses", async () => {
    const res = await SELF.fetch(`http://localhost/v1/console/bootstrap?event=${EVENT}`, {
      headers: { cookie, accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { event: { id: string } } };
    expect(body.data.event.id).toBe(EVENT);
  });
});
