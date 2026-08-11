/**
 * `email.sendgrid` — written against the SendGrid v3 HTTP API, no SDK.
 *
 * Same three methods as `email.resend`, and the core cannot tell them apart.
 * That is the test of whether the contract is right.
 */

import {
  PluginError,
  configString,
  type DeliveryStatusUpdate,
  type EmailMessage,
  type EmailPlugin,
  type EmailSendResult,
  type PluginContext,
  type SenderVerification,
} from "../contracts.js";

const API = "https://api.sendgrid.com/v3";

export const emailSendgridPlugin: EmailPlugin = {
  key: "email.sendgrid",
  capability: "email",
  display_name: "SendGrid",
  requires_secret: true,
  config_fields: [
    { key: "from_email", label: "From address", required: true, help: "Must be a verified sender or on an authenticated domain." },
    { key: "from_name", label: "From name", help: "Left empty, the event's name is used." },
  ],

  async send(message: EmailMessage, ctx: PluginContext): Promise<EmailSendResult> {
    if (!ctx.secret) return { provider_message_id: null, status: "failed", error: "No API key is configured." };
    const from = message.from ?? { email: configString(ctx, "from_email"), name: configString(ctx, "from_name") || null };
    if (!from.email) return { provider_message_id: null, status: "failed", error: "No from address is configured." };

    const res = await fetch(`${API}/mail/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: message.to.map((t) => ({ email: t.email, name: t.name ?? undefined })) }],
        from: { email: from.email, name: from.name ?? undefined },
        reply_to: message.reply_to ? { email: message.reply_to } : undefined,
        subject: message.subject,
        content: [
          { type: "text/plain", value: message.text },
          { type: "text/html", value: message.html },
        ],
        // SendGrid has no idempotency header, so it travels as a custom arg and
        // comes back on every event webhook — which is what lets a duplicate be
        // recognised after the fact.
        custom_args: { idempotency_key: message.idempotency_key },
        categories: message.tags?.slice(0, 10),
        headers: message.headers,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { provider_message_id: null, status: "failed", error: text.slice(0, 500) || `SendGrid returned ${res.status}.` };
    }
    return { provider_message_id: res.headers.get("x-message-id"), status: "sent" };
  },

  async verify_sender(domain: string, ctx: PluginContext): Promise<SenderVerification> {
    if (!ctx.secret) throw new PluginError("email.sendgrid", "No API key is configured.");
    const res = await fetch(`${API}/whitelabel/domains?domain=${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${ctx.secret}` },
    });
    if (!res.ok) throw new PluginError("email.sendgrid", `SendGrid returned ${res.status}.`, res.status);
    const body = (await res.json()) as { domain: string; valid: boolean; dns?: Record<string, { host: string; data: string; type: string }> }[];
    const match = body.find((d) => d.domain?.toLowerCase() === domain.toLowerCase());
    return {
      verified: Boolean(match?.valid),
      records: Object.values(match?.dns ?? {}).map((r) => ({ type: r.type, name: r.host, value: r.data })),
    };
  },

  async handle_inbound_webhook(payload: unknown): Promise<DeliveryStatusUpdate[]> {
    const events = Array.isArray(payload) ? payload : [payload];
    const out: DeliveryStatusUpdate[] = [];
    for (const raw of events) {
      const e = raw as { event?: string; email?: string; sg_message_id?: string; timestamp?: number; type?: string; reason?: string };
      if (!e.email) continue;
      const status =
        e.event === "bounce"
          ? "bounced"
          : e.event === "spamreport"
            ? "complained"
            : e.event === "delivered"
              ? "delivered"
              : e.event === "dropped"
                ? "failed"
                : null;
      if (!status) continue;
      out.push({
        provider_message_id: e.sg_message_id ?? null,
        recipient_email: e.email,
        status,
        // SendGrid's `type` is `bounce` (hard) or `blocked` (soft).
        bounce_type: status === "bounced" ? (e.type === "blocked" ? "soft" : "hard") : null,
        occurred_at: new Date((e.timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        error: e.reason ?? null,
      });
    }
    return out;
  },

  async health(ctx: PluginContext) {
    if (!ctx.secret) return { ok: false, error: "No API key is configured." };
    if (!configString(ctx, "from_email")) return { ok: false, error: "No from address is configured." };
    const res = await fetch(`${API}/scopes`, { headers: { authorization: `Bearer ${ctx.secret}` } });
    return res.ok ? { ok: true } : { ok: false, error: `SendGrid returned ${res.status}.` };
  },
};
