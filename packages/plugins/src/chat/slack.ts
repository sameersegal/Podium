/**
 * `chat.slack` — an incoming webhook, which is the whole integration.
 *
 * 09 gives `chat` one method: `post(channel, blocks|text)`, "for 'new proposal
 * submitted' into a committee channel". An incoming webhook needs no OAuth app,
 * no bot user and no scopes review, which is why it is the default shape here.
 * The webhook URL is the credential, so it lives behind `secret_ref` and never
 * in `config` (INV-09-3).
 */

import { configString, type ChatMessage, type ChatPlugin, type PluginContext } from "../contracts.js";

export const chatSlackPlugin: ChatPlugin = {
  key: "chat.slack",
  capability: "chat",
  display_name: "Slack",
  requires_secret: true,
  config_fields: [
    { key: "default_channel", label: "Default channel", help: "Only used by webhooks that allow overriding it." },
  ],

  async post(channel: string, message: ChatMessage, ctx: PluginContext) {
    if (!ctx.secret) return { ok: false, error: "No Slack webhook URL is configured." };
    const target = channel || configString(ctx, "default_channel");
    const res = await fetch(ctx.secret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: message.text,
        blocks: message.blocks,
        channel: target || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: body.slice(0, 200) || `Slack returned ${res.status}.` };
    }
    return { ok: true, id: null };
  },

  async health(ctx: PluginContext) {
    if (!ctx.secret) return { ok: false, error: "No Slack webhook URL is configured." };
    return ctx.secret.startsWith("https://hooks.slack.com/")
      ? { ok: true }
      : { ok: false, error: "That does not look like a Slack incoming webhook URL." };
  },
};
