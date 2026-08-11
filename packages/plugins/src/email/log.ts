/**
 * `email.log` — the default when nothing else is configured.
 *
 * It records the message and returns success. That is not a stub for want of a
 * real provider: INV-09-12 says every intended message is written to the outbox
 * *before* any provider call and stays readable there, so a deployment with no
 * email provider is a working deployment whose mail is copy-pasteable. This
 * plugin is what makes that the default rather than an error path.
 *
 * It logs the recipient's id and the template, never the address or the body
 * (11, "Never logged").
 */

import type {
  DeliveryStatusUpdate,
  EmailMessage,
  EmailPlugin,
  EmailSendResult,
  PluginContext,
  SenderVerification,
} from "../contracts.js";

export const emailLogPlugin: EmailPlugin = {
  key: "email.log",
  capability: "email",
  display_name: "Outbox only (no provider)",
  requires_secret: false,
  config_fields: [],

  async send(message: EmailMessage, _ctx: PluginContext): Promise<EmailSendResult> {
    console.log("email.log", {
      recipients: message.to.length,
      subject_length: message.subject.length,
      tags: message.tags ?? [],
      idempotency_key: message.idempotency_key,
    });
    return { provider_message_id: `log_${message.idempotency_key}`, status: "sent" };
  },

  async verify_sender(domain: string): Promise<SenderVerification> {
    return { verified: true, records: [{ type: "note", name: domain, value: "No provider configured; nothing to verify." }] };
  },

  async handle_inbound_webhook(): Promise<DeliveryStatusUpdate[]> {
    return [];
  },

  async health() {
    return { ok: true };
  },
};
