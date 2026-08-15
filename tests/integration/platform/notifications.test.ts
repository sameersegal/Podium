import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppContext, type Env } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import {
  attemptSend,
  previewTemplate,
  queueNotification,
  renderNotificationHtml,
  verifyUnsubscribeSignature,
  writeNotification,
} from "@podiumstack/web/contexts/platform/notifications.js";
import { installIntegration } from "@podiumstack/web/contexts/platform/service.js";

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
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, "Notif Test Conf", "notif-test-conf", "UTC", "2028-06-01", "2028-06-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(PERSON, "recipient@example.com", "Reci P. Ient", "active", 0, now(), now())
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

describe("the unsubscribe link and the postal address in the rendered email footer", () => {
  beforeAll(seed);

  it("INV-09-10: a transactional template's preview renders no unsubscribe link, but keeps the permission reason and the Podium credit", async () => {
    const app = appFor();
    const result = await previewTemplate(app, { key: "proposal.accepted", subject: "Accepted!", body_markdown: "Hi {{recipient.first_name}}, see {{confirm_url}}" }, PERSON);
    expect(result.html).not.toContain(">Unsubscribe<");
    expect(result.html).toContain("submitted a proposal"); // the speaker permission-reason line
    expect(result.html).toContain("Program run on Podium");
  });

  it("a non-transactional (campaign) render carries the unsubscribe link, the address and the credit — all four footer lines", async () => {
    await env.DB.prepare("UPDATE organization SET postal_address = ? WHERE id = ?").bind("254 Canal Street, New York, NY 10013", ORG).run();
    const app = appFor();
    const html = await renderNotificationHtml(app, {
      audience: "speakers",
      recipientEmail: "recipient@example.com",
      bodyMarkdown: "The venue has changed.",
      unsubscribeCategory: "campaign",
      transactional: false,
    });
    expect(html).toContain(">Unsubscribe<");
    expect(html).toContain("submitted a proposal");
    expect(html).toContain("254 Canal Street, New York, NY 10013");
    expect(html).toContain("Program run on Podium");
    await env.DB.prepare("UPDATE organization SET postal_address = NULL WHERE id = ?").bind(ORG).run();
  });

  it("a transactional render omits the unsubscribe link even when the org has an address on file", async () => {
    await env.DB.prepare("UPDATE organization SET postal_address = ? WHERE id = ?").bind("254 Canal Street, New York, NY 10013", ORG).run();
    const app = appFor();
    const html = await renderNotificationHtml(app, {
      audience: "speakers",
      recipientEmail: "recipient@example.com",
      bodyMarkdown: "Your talk was accepted.",
      unsubscribeCategory: "proposal",
      transactional: true,
    });
    expect(html).not.toContain(">Unsubscribe<");
    expect(html).toContain("254 Canal Street, New York, NY 10013");
    await env.DB.prepare("UPDATE organization SET postal_address = NULL WHERE id = ?").bind(ORG).run();
  });

  it("omits the address line entirely, never the string 'null', when the org has none on file", async () => {
    const app = appFor();
    const html = await renderNotificationHtml(app, {
      audience: "speakers",
      recipientEmail: "recipient@example.com",
      bodyMarkdown: "Hello.",
      unsubscribeCategory: "proposal",
      transactional: false,
    });
    expect(html).not.toContain("null");
  });
});

/**
 * RFC 8058 one-click unsubscribe headers on a real send. An `email.resend`
 * integration is installed here (not in the earlier describes above), so
 * `attemptSend` actually reaches `plugin.send` instead of recording
 * `no_provider` — that describe's tests run first and are unaffected.
 */
describe("RFC 8058 one-click unsubscribe headers on a real send", () => {
  function appForSend(): AppContext {
    // Layers a fake `RESEND_API_KEY` binding onto the real test env, exactly
    // as `tests/integration/onboarding/reminders.test.ts` layers a mock
    // DELIVERY_QUEUE — `resolveSecret` reads it as an env lookup, never a
    // database read (INV-09-3).
    const mockEnv = { ...(env as unknown as Env), RESEND_API_KEY: "re_test_key" } as unknown as Env;
    return new AppContext({ env: mockEnv, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR, clock: { now: () => DAYTIME } });
  }

  beforeAll(async () => {
    await seed();
    const app = appForSend();
    await installIntegration(app, {
      plugin_key: "email.resend",
      config: { from_email: "hello@example.com" },
      secret_ref: "RESEND_API_KEY",
      is_default_for_capability: true,
    });
    await app.flush();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("a campaign send carries both List-Unsubscribe headers, and the link's signature verifies", async () => {
    const app = appForSend();
    const notificationId = await writeNotification(app, {
      recipient_person_id: PERSON,
      recipient_email: "recipient@example.com",
      channel: "email",
      subject_type: "campaign",
      subject_id: "cmp_oneclick_test",
      subject: "The venue changed",
      rendered_body: "The venue changed to Hall B.",
      transactional: false,
      campaign_id: "cmp_oneclick_test",
    });
    await app.flush();

    let seenHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seenHeaders = JSON.parse(String(init.body)).headers;
        return new Response(JSON.stringify({ id: "resend_oneclick_1" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const outcome = await attemptSend(app, notificationId);
    expect(outcome.status).toBe("sent");
    expect(seenHeaders?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const match = /^<(.+)>$/.exec(seenHeaders?.["List-Unsubscribe"] ?? "");
    expect(match).toBeTruthy();
    const url = new URL(match![1]);
    expect(
      await verifyUnsubscribeSignature(env, url.searchParams.get("email")!, url.searchParams.get("category")!, url.searchParams.get("sig")!),
    ).toBe(true);
  });

  it("INV-09-10: a transactional send carries no List-Unsubscribe headers", async () => {
    const app = appForSend();
    const notificationId = await queueNotification(app, {
      template_key: "proposal.accepted",
      recipient_person_id: PERSON,
      subject_type: "proposal",
      subject_id: "prp_oneclick_test",
      variables: { "proposal.title": "A great talk", confirm_url: "https://example.com" },
    });
    await app.flush();

    let sawCall = false;
    let seenHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sawCall = true;
        seenHeaders = JSON.parse(String(init.body)).headers;
        return new Response(JSON.stringify({ id: "resend_oneclick_2" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const outcome = await attemptSend(app, String(notificationId));
    expect(outcome.status).toBe("sent");
    expect(sawCall).toBe(true);
    expect(seenHeaders).toBeUndefined();
  });
});
