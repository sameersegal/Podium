import { describe, expect, it } from "vitest";
import { emailLogPlugin } from "@podiumconf/plugins/email/log.js";
import { emailResendPlugin } from "@podiumconf/plugins/email/resend.js";
import { emailSendgridPlugin } from "@podiumconf/plugins/email/sendgrid.js";
import { base64ToBytes, bytesToBase64, derToRawEcdsa, hmacSha256Base64 } from "@podiumconf/plugins/webhook-verify.js";
import type { PluginContext } from "@podiumconf/plugins/contracts.js";
import { sendgridSigner } from "../../helpers/sendgrid-signature.js";

/**
 * INV-09-16 — an inbound provider callback is applied only if the plugin's
 * `verify_webhook` returns true for the exact bytes received, and verification
 * fails closed.
 *
 * These tests stand in for the provider: they hold the private half of the key
 * and produce genuine signatures, so a passing "accepts a real one" is evidence
 * the scheme is implemented correctly and not merely that nothing rejects.
 */

const NOW_MS = Date.parse("2028-06-01T12:00:00.000Z");

function ctxWith(over: Partial<PluginContext> = {}): PluginContext {
  return {
    integration_id: "itg_test",
    plugin_key: "email.test",
    config: {},
    secret: null,
    webhook_secret: null,
    base_url: "https://podium.test",
    now: () => new Date(NOW_MS).toISOString(),
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* SendGrid — ECDSA P-256 over `timestamp + body`, DER-encoded                */
/* -------------------------------------------------------------------------- */

describe("email.sendgrid verify_webhook (INV-09-16)", () => {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const body = JSON.stringify([{ event: "bounce", email: "someone@example.com", sg_message_id: "abc.filterdrecv-1" }]);

  it("accepts a callback genuinely signed by the provider's key", async () => {
    const { publicKeyBase64, sign } = await sendgridSigner();
    const signature = await sign(timestamp + body);
    const ok = await emailSendgridPlugin.verify_webhook(
      {
        headers: { "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp },
        raw_body: body,
        received_at_ms: NOW_MS,
      },
      ctxWith({ config: { event_webhook_public_key: publicKeyBase64 } }),
    );
    expect(ok).toBe(true);
  });

  it("rejects a body altered after signing — the bytes are what is signed", async () => {
    const { publicKeyBase64, sign } = await sendgridSigner();
    const signature = await sign(timestamp + body);
    const tampered = body.replace("someone@example.com", "victim@example.com");
    const ok = await emailSendgridPlugin.verify_webhook(
      {
        headers: { "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp },
        raw_body: tampered,
        received_at_ms: NOW_MS,
      },
      ctxWith({ config: { event_webhook_public_key: publicKeyBase64 } }),
    );
    expect(ok).toBe(false);
  });

  it("rejects a signature made with a different key", async () => {
    const real = await sendgridSigner();
    const attacker = await sendgridSigner();
    const signature = await attacker.sign(timestamp + body);
    const ok = await emailSendgridPlugin.verify_webhook(
      {
        headers: { "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp },
        raw_body: body,
        received_at_ms: NOW_MS,
      },
      ctxWith({ config: { event_webhook_public_key: real.publicKeyBase64 } }),
    );
    expect(ok).toBe(false);
  });

  it("rejects a valid but stale signature, so a captured callback cannot be replayed forever", async () => {
    const { publicKeyBase64, sign } = await sendgridSigner();
    const old = String(Math.floor(NOW_MS / 1000) - 3600);
    const signature = await sign(old + body);
    const ok = await emailSendgridPlugin.verify_webhook(
      {
        headers: { "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": old },
        raw_body: body,
        received_at_ms: NOW_MS,
      },
      ctxWith({ config: { event_webhook_public_key: publicKeyBase64 } }),
    );
    expect(ok).toBe(false);
  });

  it("fails closed when no verification key is configured", async () => {
    const { sign } = await sendgridSigner();
    const signature = await sign(timestamp + body);
    const ok = await emailSendgridPlugin.verify_webhook(
      {
        headers: { "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp },
        raw_body: body,
        received_at_ms: NOW_MS,
      },
      ctxWith(),
    );
    expect(ok).toBe(false);
  });

  it("fails closed when the signature headers are absent altogether", async () => {
    const { publicKeyBase64 } = await sendgridSigner();
    const ok = await emailSendgridPlugin.verify_webhook(
      { headers: {}, raw_body: body, received_at_ms: NOW_MS },
      ctxWith({ config: { event_webhook_public_key: publicKeyBase64 } }),
    );
    expect(ok).toBe(false);
  });

  it("does not throw on a malformed signature or key, it returns false", async () => {
    await expect(
      emailSendgridPlugin.verify_webhook(
        {
          headers: { "x-twilio-email-event-webhook-signature": "not-base64-DER!!", "x-twilio-email-event-webhook-timestamp": timestamp },
          raw_body: body,
          received_at_ms: NOW_MS,
        },
        ctxWith({ config: { event_webhook_public_key: "also-not-a-key" } }),
      ),
    ).resolves.toBe(false);
  });
});

describe("email.sendgrid handle_inbound_webhook", () => {
  it("strips the per-delivery suffix from sg_message_id so it matches the id `send` returned", async () => {
    const updates = await emailSendgridPlugin.handle_inbound_webhook(
      [{ event: "bounce", type: "bounce", email: "hard@example.com", sg_message_id: "aBcXyZ.filterdrecv-abc-1-XYZ", timestamp: 1_843_000_000 }],
      ctxWith(),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.provider_message_id).toBe("aBcXyZ");
    expect(updates[0]?.status).toBe("bounced");
    expect(updates[0]?.bounce_type).toBe("hard");
  });

  it("reads SendGrid's `blocked` as a soft bounce, which never reaches the global list", async () => {
    const updates = await emailSendgridPlugin.handle_inbound_webhook(
      [{ event: "bounce", type: "blocked", email: "soft@example.com", sg_message_id: "q1.filterdrecv-1" }],
      ctxWith(),
    );
    expect(updates[0]?.bounce_type).toBe("soft");
  });

  it("ignores events that say nothing about deliverability", async () => {
    const updates = await emailSendgridPlugin.handle_inbound_webhook(
      [{ event: "open", email: "a@example.com" }, { event: "click", email: "a@example.com" }, { event: "processed", email: "a@example.com" }],
      ctxWith(),
    );
    expect(updates).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Resend — Svix HMAC over `{id}.{timestamp}.{body}`                          */
/* -------------------------------------------------------------------------- */

describe("email.resend verify_webhook (INV-09-16)", () => {
  const secretBody = bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  const secret = `whsec_${secretBody}`;
  const id = "msg_2abc";
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "re_1", to: ["someone@example.com"] } });

  const sign = (payload: string, key = secretBody) => hmacSha256Base64(base64ToBytes(key), payload);

  it("accepts a correctly signed callback", async () => {
    const sig = await sign(`${id}.${timestamp}.${body}`);
    const ok = await emailResendPlugin.verify_webhook(
      { headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` }, raw_body: body, received_at_ms: NOW_MS },
      ctxWith({ webhook_secret: secret }),
    );
    expect(ok).toBe(true);
  });

  it("accepts when the signature is one of several offered, as during a secret rotation", async () => {
    const sig = await sign(`${id}.${timestamp}.${body}`);
    const ok = await emailResendPlugin.verify_webhook(
      {
        headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,c3RhbGVzaWduYXR1cmU= v1,${sig}` },
        raw_body: body,
        received_at_ms: NOW_MS,
      },
      ctxWith({ webhook_secret: secret }),
    );
    expect(ok).toBe(true);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const otherKey = bytesToBase64(new Uint8Array(16).fill(9));
    const sig = await sign(`${id}.${timestamp}.${body}`, otherKey);
    const ok = await emailResendPlugin.verify_webhook(
      { headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` }, raw_body: body, received_at_ms: NOW_MS },
      ctxWith({ webhook_secret: secret }),
    );
    expect(ok).toBe(false);
  });

  it("rejects a signature that covers a different id — the id is inside the signed payload", async () => {
    const sig = await sign(`msg_other.${timestamp}.${body}`);
    const ok = await emailResendPlugin.verify_webhook(
      { headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` }, raw_body: body, received_at_ms: NOW_MS },
      ctxWith({ webhook_secret: secret }),
    );
    expect(ok).toBe(false);
  });

  it("fails closed when no webhook secret is configured", async () => {
    const sig = await sign(`${id}.${timestamp}.${body}`);
    const ok = await emailResendPlugin.verify_webhook(
      { headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` }, raw_body: body, received_at_ms: NOW_MS },
      ctxWith(),
    );
    expect(ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("email.log verify_webhook (INV-09-16)", () => {
  it("refuses everything, because it is the fallback plugin and has no provider to trust", async () => {
    const ok = await emailLogPlugin.verify_webhook(
      { headers: { "x-twilio-email-event-webhook-signature": "anything" }, raw_body: "[]", received_at_ms: NOW_MS },
      ctxWith(),
    );
    expect(ok).toBe(false);
  });
});

describe("derToRawEcdsa", () => {
  it("round-trips a signature WebCrypto produced", async () => {
    const { sign } = await sendgridSigner();
    const der = base64ToBytes(await sign("payload"));
    const raw = derToRawEcdsa(der);
    expect(raw).not.toBeNull();
    expect(raw).toHaveLength(64);
  });

  it("returns null rather than throwing on bytes that are not a DER signature", () => {
    expect(derToRawEcdsa(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(derToRawEcdsa(new Uint8Array(0))).toBeNull();
    expect(derToRawEcdsa(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01]))).toBeNull();
  });
});
