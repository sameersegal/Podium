import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumconf/domain/identity/credentials.js";

/**
 * `GET /live/subscribe` — the only way into a room, and therefore the only
 * place authorization for a long-lived socket happens.
 *
 * The 101 assertion below is also a standing regression pin on
 * `workers/api/src/index.ts`: the flash-cookie rewrap there (`new
 * Response(res.body, res)`) drops the `webSocket` property on a 101 without
 * throwing, which produces a handshake the browser waits on forever and no
 * error anywhere.
 */

const ORG = "org_sub";
const EVENT = "evt_sub";

const CHAIR = "per_sub_chair";
const CHAIR_EMAIL = "sub-chair@example.com";
const CHAIR_PASSWORD = "subscribe-chair-password";

const SPEAKER = "per_sub_speaker";
const SPEAKER_EMAIL = "sub-speaker@example.com";
const SPEAKER_PASSWORD = "subscribe-speaker-password";

const OUTSIDER = "per_sub_outsider";
const OUTSIDER_EMAIL = "sub-outsider@example.com";
const OUTSIDER_PASSWORD = "subscribe-outsider-password";

const UPGRADE = { upgrade: "websocket" };

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seedPerson(id: string, email: string, name: string, password: string): Promise<void> {
  const now = new Date().toISOString();
  await run("INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
    id,
    ORG,
    email,
    name,
    "active",
    0,
    now,
    now,
  ]);
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`aid_${id}`, id, "password", email, hashPassword(password), now, email, now],
  );
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Subscribe Org", "subscribe-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Subscribe Conf", "subscribe-conf", "UTC", "2027-10-01", "2027-10-02", "in_person", "active", "public", "{}", now, now],
  );

  await seedPerson(CHAIR, CHAIR_EMAIL, "Chair Person", CHAIR_PASSWORD);
  await seedPerson(SPEAKER, SPEAKER_EMAIL, "Speaker Person", SPEAKER_PASSWORD);
  await seedPerson(OUTSIDER, OUTSIDER_EMAIL, "Outsider Person", OUTSIDER_PASSWORD);

  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_sub_chair", ORG, CHAIR, "program_chair", "event", EVENT, CHAIR, now],
  );
  // A speaker is not staff; they are taking part, which is what gets them in.
  await run(
    "INSERT OR IGNORE INTO event_participant (id, org_id, event_id, person_id, kind, status, source, added_by_person_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["evp_sub_speaker", ORG, EVENT, SPEAKER, "speaker", "active", "manual", CHAIR, now, now],
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
  const match = /podium_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error(`sign-in set no cookie for ${email}`);
  return `podium_session=${match[1]}`;
}

function subscribe(cookie: string | null, query = `?event=${EVENT}`): Promise<Response> {
  return SELF.fetch(`http://localhost/live/subscribe${query}`, {
    headers: cookie ? { ...UPGRADE, cookie } : UPGRADE,
  });
}

describe("GET /live/subscribe", () => {
  beforeAll(seed);

  it("refuses an anonymous upgrade", async () => {
    const res = await subscribe(null);
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("refuses someone with a session but no part in the event", async () => {
    const cookie = await signIn(OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
    const res = await subscribe(cookie);
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("upgrades a chair, and the socket survives the response pipeline", async () => {
    const cookie = await signIn(CHAIR_EMAIL, CHAIR_PASSWORD);
    const res = await subscribe(cookie);
    expect(res.status).toBe(101);
    // The pin. If `index.ts` ever rewraps a 101 again, this is `null`.
    expect(res.webSocket).not.toBeNull();
    res.webSocket?.accept();
    res.webSocket?.close(1000, "done");
  });

  it("upgrades a speaker who is taking part", async () => {
    const cookie = await signIn(SPEAKER_EMAIL, SPEAKER_PASSWORD);
    const res = await subscribe(cookie);
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    res.webSocket?.accept();
    res.webSocket?.close(1000, "done");
  });

  it("answers a plain GET with 426 rather than a broken handshake", async () => {
    const cookie = await signIn(CHAIR_EMAIL, CHAIR_PASSWORD);
    const res = await SELF.fetch(`http://localhost/live/subscribe?event=${EVENT}`, { headers: { cookie } });
    expect(res.status).toBe(426);
  });

  // `/live.js` itself is checked by `scripts/smoke.mjs`, alongside `/app.css`:
  // the assets binding is not served under `SELF` in this pool, and the thing
  // worth catching there is a `run_worker_first` slip swallowing the script,
  // which only a real server can show.
});
