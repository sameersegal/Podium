import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppContext, type Env } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import { attemptSend } from "@podiumconf/web/contexts/platform/notifications.js";
import { deliverReminders, sendManualReminder } from "@podiumconf/web/contexts/onboarding/service.js";

/**
 * 07-onboarding.md, "Reminders" — `deliverReminders` is what both the
 * `onboarding.scheduled_reminders` cron sweep and the deliverables board's
 * "Remind selected" manual nudge call. Before this fix it inserted a
 * `NotificationDelivery` row already stamped `status: "queued"`, marked
 * `TaskReminderLog.sent_at`, and emitted `task_reminder.sent` — every signal
 * a real send leaves — without ever calling `DELIVERY_QUEUE.send`. Nothing
 * else in the codebase drains a `queued` notification, so both flavours of
 * reminder reported themselves sent and reached nobody.
 */

const ORG = "org_ob_remind";
const EVENT = "evt_ob_remind";

// One assignee per test, seeded fresh — digesting is "one reminder per
// assignee per day" (07, "Reminders"), and reusing a person across tests
// would make the second test's reminder suppress itself as
// `digest_batched`, which is a different behaviour than the one under test.
const ASSIGNEE_1 = "per_ob_remind_1";
const ASSIGNEE_2 = "per_ob_remind_2";
const ASSIGNEE_3 = "per_ob_remind_3";

const now = () => new Date().toISOString();

async function seedPerson(id: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, timezone, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, ORG, `${id}@example.com`, "Remy Assignee", "active", 0, "UTC", now(), now())
    .run();
}

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Onboarding Reminders Org", "ob-remind-org", "UTC", "a@b.example", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "Reminders Conf", "ob-remind-conf", "UTC", "2028-06-01", "2028-06-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await seedPerson(ASSIGNEE_1);
  await seedPerson(ASSIGNEE_2);
  await seedPerson(ASSIGNEE_3);
}

async function makeTaskInstance(id: string, assignee: string) {
  await env.DB.prepare(
    `INSERT INTO task_instance
       (id, org_id, event_id, definition_id, definition_version, definition_key, title, requirement_type, config,
        subject_type, subject_id, assignee_person_id, status, is_blocking, is_required, requires_review,
        due_at, reminder_count, created_at, updated_at, row_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      ORG,
      EVENT,
      "tdf_ob_remind",
      1,
      "speaker-agreement",
      "Sign the speaker agreement",
      "acknowledgement",
      "{}",
      "speaker",
      assignee,
      assignee,
      "not_started",
      1,
      1,
      0,
      "2028-05-01T00:00:00.000Z",
      0,
      now(),
      now(),
      1,
    )
    .run();
  return env.DB.prepare("SELECT * FROM task_instance WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

/** A queue mock swapped into `AppContext.env` so the test observes the exact
 * `DELIVERY_QUEUE.send` call the fix adds, without depending on Miniflare's
 * real (asynchronous, timing-sensitive) local queue consumer. */
/**
 * Mid-morning, fixed.
 *
 * `attemptSend` defers an email inside quiet hours (21:00–08:00 in the
 * recipient's timezone) and returns before it ever asks whether a provider is
 * installed — so the `no_provider` assertion below is only reachable in
 * daylight. Reading the wall clock made this suite pass during the working day
 * and fail overnight, which is the worst of both: green when anyone looks, red
 * in a nightly run. The quiet-hours path has its own tests; this one is about
 * the delivery queue.
 */
const DAYTIME = "2026-06-01T10:00:00.000Z";

function appWithMockQueue(): { app: AppContext; sendMock: ReturnType<typeof vi.fn> } {
  const sendMock = vi.fn(async () => undefined);
  const mockEnv = { ...(env as unknown as Env), DELIVERY_QUEUE: { send: sendMock, sendBatch: vi.fn() } } as unknown as Env;
  const app = new AppContext({
    env: mockEnv,
    orgId: ORG,
    eventId: EVENT,
    actor: SYSTEM_ACTOR,
    clock: { now: () => DAYTIME },
  });
  return { app, sendMock };
}

describe("onboarding task reminders actually reach the delivery queue", () => {
  beforeAll(seed);

  it("deliverReminders enqueues the DELIVERY_QUEUE message it used to skip", async () => {
    const instance = await makeTaskInstance("tsk_ob_remind_1", ASSIGNEE_1);
    const { app, sendMock } = appWithMockQueue();

    const result = await deliverReminders(app, [{ instance: instance!, rule_id: null, trigger: "scheduled" }]);
    expect(result.sent).toBe(1);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [message] = sendMock.mock.calls[0] as [{ kind: string; notification_id: string; org_id: string }];
    expect(message.kind).toBe("notification");
    expect(message.org_id).toBe(ORG);

    const row = await env.DB.prepare("SELECT * FROM notification_delivery WHERE id = ?").bind(message.notification_id).first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    expect(row?.status).toBe("queued");
    // A declared template key — the previous `task.manual_reminder` for
    // manual nudges resolved to nothing in `platform/templates.ts`, which
    // silently defeated `isTransactionalTemplate` too.
    expect(row?.template_key).toBe("task.reminder");

    // The row is now genuinely reachable by the delivery pipeline: running
    // the attempt the queue consumer would run moves it out of a bare
    // "queued" with no reason — the state that meant "reported sent, reached
    // nobody, forever" before this fix.
    await attemptSend(app, String(message.notification_id));
    const after = await env.DB.prepare("SELECT status, suppressed_reason FROM notification_delivery WHERE id = ?")
      .bind(message.notification_id)
      .first<{ status: string; suppressed_reason: string | null }>();
    expect(after?.suppressed_reason).toBe("no_provider"); // no email integration installed in this fixture
  });

  it("sendManualReminder (the deliverables board's 'remind selected') also enqueues, with the same template key", async () => {
    const instance = await makeTaskInstance("tsk_ob_remind_2", ASSIGNEE_2);
    const { app, sendMock } = appWithMockQueue();

    const result = await sendManualReminder(app, [String(instance!.id)], ASSIGNEE_2);
    expect(result.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const [message] = sendMock.mock.calls[0] as [{ notification_id: string }];
    const row = await env.DB.prepare("SELECT template_key, status FROM notification_delivery WHERE id = ?")
      .bind(message.notification_id)
      .first<{ template_key: string; status: string }>();
    expect(row?.template_key).toBe("task.reminder");
    expect(row?.status).toBe("queued");
  });

  it("a DELIVERY_QUEUE outage does not lose the row (INV-09-12) — it is still readable, just not yet enqueued", async () => {
    const instance = await makeTaskInstance("tsk_ob_remind_3", ASSIGNEE_3);
    const sendMock: ReturnType<typeof vi.fn> = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const mockEnv = { ...(env as unknown as Env), DELIVERY_QUEUE: { send: sendMock, sendBatch: vi.fn() } } as unknown as Env;
    const app = new AppContext({ env: mockEnv, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });

    const result = await deliverReminders(app, [{ instance: instance!, rule_id: null, trigger: "scheduled" }]);
    expect(result.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const [message] = sendMock.mock.calls[0] as [{ notification_id: string }];
    const row = await env.DB.prepare("SELECT status FROM notification_delivery WHERE id = ?")
      .bind(message.notification_id)
      .first<{ status: string }>();
    expect(row?.status).toBe("queued"); // committed before the enqueue attempt, so the outage costs latency, not the fact
  });
});
