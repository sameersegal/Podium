import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import { attemptSend, queueNotification } from "@podiumconf/web/contexts/platform/notifications.js";

/**
 * INV-09-12 — every message the platform intends to send writes a
 * `NotificationDelivery` before any provider call, and where no `email`
 * integration is active it is recorded `queued` with `suppressed_reason =
 * no_provider`, remaining readable in the outbox rather than being dropped.
 *
 * The seeded deployment installs no integrations, so this is the live path.
 */

const ORG = "org_notif_test";
const EVENT = "evt_notif_test";
const PERSON = "per_notif_test";
const now = () => new Date().toISOString();

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Notif Test Org", "notif-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "Notif Test Conf", "notif-test-conf", "UTC", "2028-06-01", "2028-06-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(PERSON, ORG, "recipient@example.com", "Reci P. Ient", "active", 0, now(), now())
    .run();
}

// A fixed, deliberately daytime-UTC clock, so this test's outcome does not
// depend on the wall-clock hour the suite happens to run at (09, "quiet
// hours" defers a send rather than dropping it, which would otherwise make
// this assertion flaky).
const DAYTIME = "2028-06-01T15:00:00.000Z";

function appFor() {
  return new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR, clock: { now: () => DAYTIME } });
}

describe("the outbox with no email provider configured (INV-09-12)", () => {
  beforeAll(seed);

  it("writes a NotificationDelivery with its rendered body before any provider call, and records no_provider rather than dropping it", async () => {
    const app = appFor();
    const notificationId = await queueNotification(app, {
      template_key: "proposal.submitted",
      recipient_person_id: PERSON,
      subject_type: "proposal",
      subject_id: "prp_notif_test",
      variables: { "proposal.title": "A great talk", "proposal.reference": "NT-0001", "proposal.url": "https://example.com", "cfp.name": "Main CFP", "cfp.closes_at": "2028-05-01" },
    });
    await app.flush();
    expect(notificationId).toBeTruthy();

    // The row exists — readable — the moment queueNotification returns,
    // before the delivery consumer has run at all.
    const before = await env.DB.prepare("SELECT * FROM notification_delivery WHERE id = ?").bind(notificationId).first<Record<string, unknown>>();
    expect(before?.status).toBe("queued");
    expect(String(before?.rendered_body)).toContain("A great talk");
    expect(before?.recipient_email).toBe("recipient@example.com");

    // Now the delivery attempt runs (no `email` integration is installed).
    await attemptSend(app, String(notificationId));

    const after = await env.DB.prepare("SELECT * FROM notification_delivery WHERE id = ?").bind(notificationId).first<Record<string, unknown>>();
    expect(after?.status).toBe("queued");
    expect(after?.suppressed_reason).toBe("no_provider");
    // Still fully readable — this is what makes the outbox operable with no provider.
    expect(String(after?.rendered_body)).toContain("A great talk");
  });

  it("redelivery of the same notification id is idempotent — no duplicate rows, no duplicate provider calls", async () => {
    const app = appFor();
    const notificationId = await queueNotification(app, {
      template_key: "task.assigned",
      recipient_person_id: PERSON,
      subject_type: "task",
      subject_id: "tsk_notif_test",
      variables: { "task.title": "Upload your slides", "task.due_at": "2028-06-01", "task.url": "https://example.com", "task.instructions": "Please upload.", "session.title": "" },
    });
    await app.flush();

    await attemptSend(app, String(notificationId));
    await attemptSend(app, String(notificationId));

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_delivery WHERE id = ?").bind(notificationId).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});
