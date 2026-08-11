/**
 * `email.resend` — written against the Resend HTTP API, no SDK.
 *
 * The whole adapter is three fetches. That is the point of the contract: the
 * core knows nothing about Resend, and swapping providers changes this file and
 * one row of `integration`.
 *
 * https://resend.com/docs/api-reference — `POST /emails`, `GET /domains`, and
 * the webhook payload shape for bounces and complaints.
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

const API = "https://api.resend.com";

function addr(a: { email: string; name?: string | null }): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * Resend accepts only ASCII letters, numbers, underscores and dashes in a tag,
 * and rejects the whole send otherwise. Every tag the core passes is a
 * `template_key` — `proposal.submitted`, `schedule.changed` — so the dot in the
 * name made *every* notification fail with "Tags should only contain ASCII
 * letters, numbers, underscores, or dashes."
 *
 * Normalising here rather than in the core is the point of the contract: a
 * dotted template key is the platform's vocabulary, and one provider's charset
 * is that provider's problem.
 */
function tagValue(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "_");
}

export const emailResendPlugin: EmailPlugin = {
  key: "email.resend",
  capability: "email",
  display_name: "Resend",
  requires_secret: true,
  config_fields: [
    { key: "from_email", label: "From address", required: true, help: "Must be on a domain you have verified with Resend." },
    { key: "from_name", label: "From name", help: "Left empty, the event's name is used — speaker mail is sent as the event." },
  ],

  async send(message: EmailMessage, ctx: PluginContext): Promise<EmailSendResult> {
    if (!ctx.secret) return { provider_message_id: null, status: "failed", error: "No API key is configured." };
    const from = message.from ?? { email: configString(ctx, "from_email"), name: configString(ctx, "from_name") || null };
    if (!from.email) return { provider_message_id: null, status: "failed", error: "No from address is configured." };

    const res = await fetch(`${API}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.secret}`,
        "content-type": "application/json",
        // Resend honours this, so a queue retry cannot send twice.
        "idempotency-key": message.idempotency_key,
      },
      body: JSON.stringify({
        from: addr(from),
        to: message.to.map(addr),
        reply_to: message.reply_to ?? undefined,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
        tags: message.tags?.map((t) => ({ name: "podium", value: tagValue(t) })),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      return { provider_message_id: null, status: "failed", error: body.message ?? `Resend returned ${res.status}.` };
    }
    return { provider_message_id: body.id ?? null, status: "sent" };
  },

  async verify_sender(domain: string, ctx: PluginContext): Promise<SenderVerification> {
    if (!ctx.secret) throw new PluginError("email.resend", "No API key is configured.");
    const res = await fetch(`${API}/domains`, { headers: { authorization: `Bearer ${ctx.secret}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { name?: string };
      // Unlike `health`, this one cannot answer: a sending-only key genuinely
      // cannot read domain status, so say which key would.
      if (res.status === 401 && body.name === "restricted_api_key") {
        throw new PluginError("email.resend", "This is a sending-only API key; domain verification needs a full-access key.", res.status);
      }
      throw new PluginError("email.resend", `Resend returned ${res.status}.`, res.status);
    }
    const body = (await res.json()) as { data?: { name: string; status: string; records?: unknown[] }[] };
    const match = body.data?.find((d) => d.name.toLowerCase() === domain.toLowerCase());
    return {
      verified: match?.status === "verified",
      records: (match?.records as SenderVerification["records"]) ?? [],
    };
  },

  /**
   * Bounce and complaint callbacks. Only a hard bounce and a complaint reach
   * the global suppression list (09, "Suppression").
   */
  async handle_inbound_webhook(payload: unknown): Promise<DeliveryStatusUpdate[]> {
    const ev = payload as {
      type?: string;
      created_at?: string;
      data?: { email_id?: string; to?: string[]; bounce?: { type?: string }; reason?: string };
    };
    const type = ev.type ?? "";
    const data = ev.data ?? {};
    const at = ev.created_at ?? new Date().toISOString();
    const recipients = data.to ?? [];
    const status =
      type === "email.bounced"
        ? "bounced"
        : type === "email.complained"
          ? "complained"
          : type === "email.delivered"
            ? "delivered"
            : type === "email.failed"
              ? "failed"
              : null;
    if (!status) return [];
    return recipients.map((email) => ({
      provider_message_id: data.email_id ?? null,
      recipient_email: email,
      status: status as DeliveryStatusUpdate["status"],
      bounce_type: status === "bounced" ? (data.bounce?.type === "Transient" ? "soft" : "hard") : null,
      occurred_at: at,
      error: data.reason ?? null,
    }));
  },

  async health(ctx: PluginContext) {
    if (!ctx.secret) return { ok: false, error: "No API key is configured." };
    if (!configString(ctx, "from_email")) return { ok: false, error: "No from address is configured." };
    const res = await fetch(`${API}/domains`, { headers: { authorization: `Bearer ${ctx.secret}` } });
    if (res.ok) return { ok: true };
    // A **sending-only** key — Resend's own recommendation for production — is
    // refused by `GET /domains` with `restricted_api_key`. That is a correctly
    // configured integration, not a broken one, and reporting it unhealthy is
    // not cosmetic: `healthCheckIntegration` writes `misconfigured`, and
    // `resolvePlugin` only ever returns `active` rows, so a health check on a
    // working deployment would silently stop every email.
    const body = (await res.json().catch(() => ({}))) as { name?: string };
    if (res.status === 401 && body.name === "restricted_api_key") return { ok: true };
    return { ok: false, error: `Resend returned ${res.status}.` };
  },
};
