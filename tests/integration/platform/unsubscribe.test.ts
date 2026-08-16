import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { attemptSend, unsubscribeUrl, writeNotification } from "@podiumstack/web/contexts/platform/notifications.js";

/**
 * `POST /unsubscribe` — the RFC 8058 one-click form and the human
 * confirm-page form, both ending at the same `recordSuppression` call.
 *
 * A one-click POST carries `email`/`category`/`sig` in the URL's query
 * string and a body of exactly `List-Unsubscribe=One-Click`, per the RFC;
 * the human form still posts all three as hidden body fields.
 */

const ORG = "org_oneclick_test";
const EVENT = "evt_oneclick_test";
const PERSON = "per_oneclick_test";
const EMAIL = "oneclick-recipient@example.com";
const now = () => new Date().toISOString();

/** `resolveOrgId` takes the earliest-created organization, so this one must sort first. */
const EPOCH = "2000-01-01T00:00:00.000Z";

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "One-Click Test Org", "oneclick-test-org", "UTC", "test@example.com", "{}", EPOCH, EPOCH)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, "One-Click Test Conf", "oneclick-test-conf", "UTC", "2028-09-01", "2028-09-02", "in_person", "active", "public", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(PERSON, EMAIL, "One Click Recipient", "active", 0, now(), now())
    .run();
}

function appFor(): AppContext {
  return new AppContext({ env, orgId: ORG, eventId: EVENT, actor: SYSTEM_ACTOR });
}

async function suppressionRow(): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM notification_suppression WHERE email = ? AND category = 'campaign'")
    .bind(EMAIL)
    .first<Record<string, unknown>>();
}

describe("POST /unsubscribe — the RFC 8058 one-click form and the human confirm form", () => {
  let validUrl = "";

  beforeAll(async () => {
    await seed();
    validUrl = await unsubscribeUrl(env, EMAIL, "campaign");
  });

  it("refuses a one-click POST whose signature does not verify, and records no suppression", async () => {
    const url = new URL(validUrl);
    url.searchParams.set("sig", "deadbeef");
    const res = await SELF.fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(400);
    expect(await suppressionRow()).toBeNull();
  });

  it("refuses a one-click POST carrying no signature at all", async () => {
    const url = new URL(validUrl);
    url.searchParams.delete("sig");
    const res = await SELF.fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(400);
    expect(await suppressionRow()).toBeNull();
  });

  it("a one-click POST — email/category/sig in the query string, `List-Unsubscribe=One-Click` as the whole body — records the suppression and returns a minimal 200", async () => {
    const res = await SELF.fetch(validUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    // Mail clients do not render this body — it stays minimal, not the
    // full confirmation page the human path returns.
    const body = await res.text();
    expect(body.length).toBeLessThan(50);

    const row = await suppressionRow();
    expect(row?.reason).toBe("unsubscribed");
  });

  it("the end-to-end property: the same recipient's next campaign send comes back suppressed, not sent", async () => {
    const app = appFor();
    const notificationId = await writeNotification(app, {
      recipient_person_id: PERSON,
      recipient_email: EMAIL,
      channel: "email",
      subject_type: "campaign",
      subject_id: "cmp_oneclick_e2e",
      subject: "A campaign this recipient already opted out of",
      rendered_body: "Body.",
      transactional: false,
      campaign_id: "cmp_oneclick_e2e",
    });
    await app.flush();

    const outcome = await attemptSend(app, notificationId);
    expect(outcome).toEqual({ status: "suppressed", suppressed_reason: "unsubscribed" });
  });

  it("still honours the existing human confirm-page form — email/category/sig as hidden body fields, no query string", async () => {
    // A second, distinct recipient, so this assertion is not riding on the
    // suppression the one-click test above already recorded.
    const formEmail = "form-path-recipient@example.com";
    const url = await unsubscribeUrl(env, formEmail, "campaign");
    const parsed = new URL(url);
    const res = await SELF.fetch("http://localhost/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: parsed.searchParams.get("email")!,
        category: parsed.searchParams.get("category")!,
        sig: parsed.searchParams.get("sig")!,
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("You will not receive marketing messages");

    const row = await env.DB.prepare("SELECT reason FROM notification_suppression WHERE email = ? AND category = 'campaign'")
      .bind(formEmail)
      .first<Record<string, unknown>>();
    expect(row?.reason).toBe("unsubscribed");
  });

  it("the GET confirmation page still renders and mutates nothing", async () => {
    const getEmail = "get-path-recipient@example.com";
    const url = await unsubscribeUrl(env, getEmail, "campaign");
    const res = await SELF.fetch(url, { headers: {} });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Unsubscribe");
    const row = await env.DB.prepare("SELECT * FROM notification_suppression WHERE email = ?").bind(getEmail).first();
    expect(row).toBeNull();
  });
});
