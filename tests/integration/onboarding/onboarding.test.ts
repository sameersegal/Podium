import { env as testEnv, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext, type Env } from "@podiumconf/data/context.js";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { hashToken } from "@podiumconf/domain/identity/credentials.js";
import { deliverEvent } from "@podiumconf/web/consumers/dispatch.js";
import { createDefaultTaskDefinitions, waiveTask } from "@podiumconf/web/contexts/onboarding/service.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * 07-onboarding.md — materialisation idempotency (INV-07-2), the
 * `onboarding.session_complete` signal, INV-07-10 visibility, and the PII
 * rule on `TaskSubmission.payload` (11-cross-cutting.md).
 */

const ORG = "org_ob";
const EVENT = "evt_ob";
const FORMAT = "fmt_ob";
const SESSION = "ses_ob1";
const ORGANIZER = "per_ob_organizer";
const SPEAKER1 = "per_ob_speaker1";
const SPEAKER2 = "per_ob_speaker2";

function fixedEvent<T extends Record<string, unknown>>(type: DomainEvent["type"], subject: { type: string; id: string }, data: T): DomainEvent<T> {
  return buildEvent({ type, subject, data }, { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_ob_test" });
}

async function cookieFor(personId: string): Promise<string> {
  const token = `test-token-${personId}`;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.prepare("DELETE FROM auth_session WHERE person_id = ?").bind(personId).run();
  await env.DB.prepare(
    "INSERT INTO auth_session (id, token_hash, person_id, org_id, created_at, expires_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(`sid_${personId}`, hashToken(token), personId, ORG, now, expires)
    .run();
  return `podium_session=${token}`;
}

async function apiKeyHeader(scopes: string[]): Promise<string> {
  const secret = `test-secret-${scopes.join("-")}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO api_key (id, org_id, name, prefix, secret_hash, scopes, created_by_person_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(`key_${scopes.join("_")}_${Math.random().toString(36).slice(2, 8)}`, ORG, "test key", "test", hashToken(secret), JSON.stringify(scopes), ORGANIZER, now)
    .run();
  return `Bearer ${secret}`;
}

async function seed() {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(ORG, "Onboarding Org", "onboarding-org", "UTC", "a@b.example", "{}", now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(EVENT, ORG, "Onboarding Event", "onboarding-event", "UTC", "2027-06-01", "2027-06-03", "in_person", "active", "public", "{}", now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, requires_recording_consent, capacity_policy, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(FORMAT, EVENT, "Talk", "talk", 30, 3, '["cfp"]', 1, 0, "open", 0, 1),
    env.DB.prepare(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(ORGANIZER, ORG, "ob-organizer@example.com", "Orin Organizer", "active", 0, now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(SPEAKER1, ORG, "ob-speaker1@example.com", "Sasha Speaker", "active", 0, now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(SPEAKER2, ORG, "ob-speaker2@example.com", "Cody Cospeaker", "active", 0, now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session (id, org_id, event_id, reference, origin, title, abstract, session_format_id, duration_minutes, status, content_status, visibility, created_at, updated_at, row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(SESSION, ORG, EVENT, "OB-0001", "cfp", "Materialising Onboarding", "An abstract.", FORMAT, 30, "confirmed", "draft", "public", now, now, 1),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_speaker (id, session_id, person_id, speaker_role, sort_order, confirmation_status, is_public, added_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind("ssp_ob1", SESSION, SPEAKER1, "primary", 0, "confirmed", 1, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_speaker (id, session_id, person_id, speaker_role, sort_order, confirmation_status, is_public, added_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind("ssp_ob2", SESSION, SPEAKER2, "co_speaker", 1, "confirmed", 1, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind("grt_ob1", ORG, ORGANIZER, "admin", "org", ORG, ORGANIZER, now),
  ]);

  const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
  await createDefaultTaskDefinitions(app, EVENT);
  await app.flush();
}

describe("onboarding", () => {
  beforeAll(seed);

  it("INV-07-2: session.confirmed delivered twice materialises exactly one set of instances", async () => {
    const ev = fixedEvent("session.confirmed", { type: "session", id: SESSION }, { session_id: SESSION });

    const first = await deliverEvent(env, ev);
    expect(first).toContain("onboarding.materialise_on_session_confirmed");
    const { results: afterFirst } = await env.DB.prepare("SELECT id FROM task_instance WHERE session_id = ?").bind(SESSION).all();
    expect(afterFirst.length).toBeGreaterThan(0);

    // Redelivery of the *same* DomainEvent.id is a dispatcher no-op.
    const second = await deliverEvent(env, ev);
    expect(second).toEqual([]);

    // A *retried* materialisation (a fresh event, same trigger) must still be
    // idempotent by construction (INV-07-2) — this is the case a redelivered
    // decision.published/session.confirmed with a different event id models.
    const retried = fixedEvent("session.confirmed", { type: "session", id: SESSION }, { session_id: SESSION });
    await deliverEvent(env, retried);
    const { results: afterRetry } = await env.DB.prepare("SELECT id FROM task_instance WHERE session_id = ?").bind(SESSION).all();
    expect(afterRetry.length).toBe(afterFirst.length);

    // At most one non-cancelled instance per (definition_key, subject, assignee).
    const { results: dupes } = await env.DB.prepare(
      `SELECT definition_key, subject_type, subject_id, assignee_person_id, COUNT(*) AS n
         FROM task_instance WHERE session_id = ? AND status != 'cancelled'
        GROUP BY definition_key, subject_type, subject_id, assignee_person_id HAVING n > 1`,
    )
      .bind(SESSION)
      .all();
    expect(dupes.length).toBe(0);
  });

  /**
   * A deliverable belongs to the session it is for, not to the task row that
   * asked for it. Keying the asset by task id hid every speaker upload from
   * the event files library (which scopes by `session:`/`person:` slots), and
   * keying it by filename restarted versioning whenever the speaker renamed
   * the file.
   */
  it("a task upload lands in the session's file slot and versions across renames", async () => {
    const slidesTask = await getTaskFor(SESSION, SPEAKER1, "slides-upload");
    const cookie = await cookieFor(SPEAKER1);

    for (const filename of ["deck.pdf", "deck-final-v2.pdf"]) {
      const body = new FormData();
      body.set("file", new File([new Uint8Array([37, 80, 68, 70])], filename, { type: "application/pdf" }));
      const res = await SELF.fetch(`http://localhost/portal/tasks/${slidesTask}`, { method: "POST", body, headers: { cookie }, redirect: "manual" });
      expect([200, 303]).toContain(res.status);
    }

    const { results } = await env.DB.prepare("SELECT slot_key, version, filename FROM asset WHERE purpose = 'task_submission' ORDER BY version").all<{
      slot_key: string;
      version: number;
      filename: string;
    }>();
    expect(results.map((r) => r.version)).toEqual([1, 2]);
    // One slot, keyed to the session and the definition — so v2 supersedes v1
    // even though the speaker renamed the file.
    expect(new Set(results.map((r) => r.slot_key))).toEqual(new Set([`session:${SESSION}:slides-upload`]));
  });

  it("PII: TaskSubmission.payload for a legal/travel task is redacted without pii:read, present with it", async () => {
    const speakerAgreement = await getTaskFor(SESSION, SPEAKER1, "speaker-agreement");
    const cookie = await cookieFor(SPEAKER1);
    const submit = await SELF.fetch(`http://localhost/portal/tasks/${speakerAgreement}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ accepted: "1", typed_name: "Sasha Speaker" }),
      redirect: "manual",
    });
    expect([200, 303]).toContain(submit.status);

    const withoutPii = await SELF.fetch(`http://localhost/v1/tasks/${speakerAgreement}/submissions`, {
      headers: { authorization: await apiKeyHeader(["tasks:read"]) },
    });
    expect(withoutPii.status).toBe(200);
    const withoutPiiBody = (await withoutPii.json()) as { data: { payload: unknown }[] };
    expect(withoutPiiBody.data.length).toBeGreaterThan(0);
    expect(withoutPiiBody.data[0].payload).toBe("[redacted]");

    const withPii = await SELF.fetch(`http://localhost/v1/tasks/${speakerAgreement}/submissions`, {
      headers: { authorization: await apiKeyHeader(["tasks:read", "pii:read"]) },
    });
    const withPiiBody = (await withPii.json()) as { data: { payload: Record<string, unknown> }[] };
    expect(withPiiBody.data[0].payload).not.toBe("[redacted]");
    expect((withPiiBody.data[0].payload as { typed_name?: string }).typed_name).toBe("Sasha Speaker");
  });

  it("completing the last blocking task emits onboarding.session_complete", async () => {
    const { results: blocking } = await env.DB.prepare(
      "SELECT id FROM task_instance WHERE session_id = ? AND is_blocking = 1 AND status NOT IN ('completed','waived','cancelled')",
    )
      .bind(SESSION)
      .all<{ id: string }>();
    expect(blocking.length).toBeGreaterThan(0);

    const app = new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
    for (const row of blocking) {
      await waiveTask(app, row.id, "Test fixture — waived to exercise onboarding.session_complete.", ORGANIZER);
    }
    const events = await app.flush();
    expect(events.some((e) => e.type === "task_instance.waived")).toBe(true);

    // Each task_instance.waived is delivered to the reaction map, which
    // checks whether the session's blocking obligations are now all closed.
    for (const e of events) await deliverEvent(env, e);

    const { results: complete } = await env.DB.prepare(
      "SELECT data FROM domain_event_record WHERE org_id = ? AND type = 'onboarding.session_complete' AND subject_id = ?",
    )
      .bind(ORG, SESSION)
      .all<{ data: string }>();
    expect(complete.length).toBeGreaterThan(0);
    const payload = JSON.parse(complete[complete.length - 1].data);
    expect(payload.session_id).toBe(SESSION);
    expect(typeof payload.blocking_task_count).toBe("number");

    const { results: stillOutstanding } = await env.DB.prepare(
      "SELECT id FROM task_instance WHERE session_id = ? AND is_blocking = 1 AND status NOT IN ('completed','waived','cancelled')",
    )
      .bind(SESSION)
      .all();
    expect(stillOutstanding.length).toBe(0);
  });

  it("INV-07-10: a speaker sees their own task in full, and a co-speaker's session-visible task as status only", async () => {
    const { results: speaker2Tasks } = await env.DB.prepare("SELECT id FROM task_instance WHERE session_id = ? AND assignee_person_id = ?")
      .bind(SESSION, SPEAKER2)
      .all<{ id: string }>();
    expect(speaker2Tasks.length).toBeGreaterThan(0);
    const ownTaskId = speaker2Tasks[0].id;

    const { results: speaker1Tasks } = await env.DB.prepare("SELECT id FROM task_instance WHERE session_id = ? AND assignee_person_id = ?")
      .bind(SESSION, SPEAKER1)
      .all<{ id: string }>();
    const otherTaskId = speaker1Tasks[0].id;

    const cookie = await cookieFor(SPEAKER2);

    const own = await SELF.fetch(`http://localhost/v1/tasks/${ownTaskId}`, { headers: { cookie } });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as Record<string, unknown>;
    expect(ownBody.assignee_person_id).toBe(SPEAKER2);
    expect(ownBody).toHaveProperty("instructions");

    const other = await SELF.fetch(`http://localhost/v1/tasks/${otherTaskId}`, { headers: { cookie } });
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as Record<string, unknown>;
    // status_only: title and status, never the assignee's payload-carrying fields.
    expect(otherBody.status).toBeDefined();
    expect(otherBody).not.toHaveProperty("assignee_person_id");
    expect(otherBody).not.toHaveProperty("instructions");
  });
});

async function getTaskFor(sessionId: string, personId: string, definitionKey: string): Promise<string> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM task_instance WHERE session_id = ? AND assignee_person_id = ? AND definition_key = ?",
  )
    .bind(sessionId, personId, definitionKey)
    .all<{ id: string }>();
  if (!results[0]) throw new Error(`No ${definitionKey} instance for ${personId} on ${sessionId}`);
  return results[0].id;
}
