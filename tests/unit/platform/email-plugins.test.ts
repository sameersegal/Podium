import { afterEach, describe, expect, it, vi } from "vitest";
import { emailResendPlugin } from "@podiumstack/plugins/email/resend.js";
import { emailSendgridPlugin } from "@podiumstack/plugins/email/sendgrid.js";
import type { PluginContext } from "@podiumstack/plugins/contracts.js";

/**
 * 09, `email` — the adapter's whole job is "put this rendered message on the
 * wire". Both defects pinned here were invisible to every other kind of test:
 * they only appear in what the provider does with a real request.
 */

function ctx(config: Record<string, unknown> = { from_email: "noreply@app.example.com" }, secret: string | null = "re_test_key"): PluginContext {
  return {
    integration_id: "itg_test",
    plugin_key: "email.resend",
    config,
    secret,
    base_url: "https://app.example.com",
    now: () => "2028-01-01T00:00:00.000Z",
  };
}

const MESSAGE = {
  to: [{ email: "someone@example.com" }],
  subject: "We have your proposal",
  html: "<p>Hello</p>",
  text: "Hello",
  // Every tag the core sends is a `template_key`, and every template key has a dot.
  tags: ["proposal.submitted"],
  idempotency_key: "notification:ntd_test",
};

afterEach(() => vi.unstubAllGlobals());

/** Captures the outgoing request so the assertion is about what Resend receives. */
function stubFetch(response: { status?: number; body?: unknown } = {}): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response.body ?? { id: "resend_msg_1" }), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

describe("email.resend", () => {
  it("normalises a dotted template key into a tag Resend will accept", async () => {
    const { calls } = stubFetch();
    const result = await emailResendPlugin.send(MESSAGE, ctx());

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(calls[0].init.body));
    // Resend rejects the entire send when a tag value contains a dot, which
    // made every notification fail with "Tags should only contain ASCII
    // letters, numbers, underscores, or dashes."
    expect(body.tags).toEqual([{ name: "podium", value: "proposal_submitted" }]);
    for (const tag of body.tags) expect(tag.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("reports a sending-only API key as healthy", async () => {
    // Resend recommends a restricted, send-only key for production; `GET
    // /domains` refuses it. Reporting that unhealthy writes `misconfigured`,
    // which `resolvePlugin` filters out — a health check would stop all email.
    stubFetch({ status: 401, body: { statusCode: 401, message: "This API key is restricted to only send emails", name: "restricted_api_key" } });
    expect(await emailResendPlugin.health?.(ctx())).toEqual({ ok: true });
  });

  it("still reports a genuinely bad key as unhealthy", async () => {
    stubFetch({ status: 401, body: { statusCode: 401, message: "API key is invalid", name: "validation_error" } });
    expect(await emailResendPlugin.health?.(ctx())).toMatchObject({ ok: false });
  });

  it("reports a missing from address rather than failing at send time", async () => {
    stubFetch();
    expect(await emailResendPlugin.health?.(ctx({}))).toMatchObject({ ok: false });
  });

  it("says which key is needed when a sending-only key cannot verify a domain", async () => {
    stubFetch({ status: 401, body: { name: "restricted_api_key" } });
    await expect(emailResendPlugin.verify_sender("app.example.com", ctx())).rejects.toThrow(/sending-only/);
  });

  it("turns a Resend bounce callback into a hard-bounce update", async () => {
    const updates = await emailResendPlugin.handle_inbound_webhook(
      {
        type: "email.bounced",
        created_at: "2028-01-01T00:00:00.000Z",
        data: { email_id: "resend_msg_1", to: ["someone@example.com"], bounce: { type: "Permanent" }, reason: "550 unknown" },
      },
      ctx(),
    );
    expect(updates).toEqual([
      {
        provider_message_id: "resend_msg_1",
        recipient_email: "someone@example.com",
        status: "bounced",
        bounce_type: "hard",
        occurred_at: "2028-01-01T00:00:00.000Z",
        error: "550 unknown",
      },
    ]);
  });

  it("treats a Transient bounce as soft, so it stays off the suppression list", async () => {
    const [update] = await emailResendPlugin.handle_inbound_webhook(
      { type: "email.bounced", data: { email_id: "m", to: ["a@example.com"], bounce: { type: "Transient" } } },
      ctx(),
    );
    expect(update.bounce_type).toBe("soft");
  });
});

describe("email.sendgrid", () => {
  it("reads the provider message id off the response header", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 202, headers: { "x-message-id": "sg_abc" } }));
    const result = await emailSendgridPlugin.send(MESSAGE, { ...ctx(), plugin_key: "email.sendgrid" });
    expect(result).toMatchObject({ status: "sent", provider_message_id: "sg_abc" });
  });

  it("records the provider's error body rather than throwing past the caller", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "Maximum credits exceeded" }] }), { status: 401 }));
    const result = await emailSendgridPlugin.send(MESSAGE, { ...ctx(), plugin_key: "email.sendgrid" });
    expect(result.status).toBe("failed");
    expect(String(result.error)).toContain("Maximum credits exceeded");
  });

  it("turns a `blocked` event into a soft bounce and `bounce` into a hard one", async () => {
    const [soft] = await emailSendgridPlugin.handle_inbound_webhook([{ email: "a@example.com", event: "bounce", type: "blocked", sg_message_id: "m" }], ctx());
    const [hard] = await emailSendgridPlugin.handle_inbound_webhook([{ email: "a@example.com", event: "bounce", type: "bounce", sg_message_id: "m" }], ctx());
    expect(soft.bounce_type).toBe("soft");
    expect(hard.bounce_type).toBe("hard");
  });
});
