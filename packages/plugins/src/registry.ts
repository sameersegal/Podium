/**
 * The plugin registry — `Integration.plugin_key` → the adapter.
 *
 * Adding a provider means adding a file and a line here. Nothing in the core
 * imports a vendor SDK, and nothing in the core names a provider.
 */

import type { AnyPlugin, Capability } from "./contracts.js";
import { emailLogPlugin } from "./email/log.js";
import { emailResendPlugin } from "./email/resend.js";
import { emailSendgridPlugin } from "./email/sendgrid.js";
import { chatSlackPlugin } from "./chat/slack.js";
import { storageR2Plugin } from "./storage/r2.js";
import { ticketingStubPlugin } from "./ticketing/stub.js";
import { analyticsLocalEvaluatorPlugin } from "./analytics/local-evaluator.js";

export const PLUGINS: readonly AnyPlugin[] = [
  emailLogPlugin,
  emailResendPlugin,
  emailSendgridPlugin,
  chatSlackPlugin,
  storageR2Plugin,
  ticketingStubPlugin,
  analyticsLocalEvaluatorPlugin,
];

const BY_KEY = new Map(PLUGINS.map((p) => [p.key, p]));

export function pluginFor(key: string): AnyPlugin | null {
  return BY_KEY.get(key) ?? null;
}

export function pluginsForCapability(capability: Capability): AnyPlugin[] {
  return PLUGINS.filter((p) => p.capability === capability);
}

/**
 * The implementation used when no `Integration` is installed for a capability.
 *
 * `email` falls back to `email.log`, which is what makes INV-09-12 the default
 * behaviour rather than an error path; `storage` falls back to R2, the platform
 * mapping's choice.
 */
export const FALLBACK_PLUGINS: Partial<Record<Capability, string>> = {
  email: "email.log",
  storage: "storage.r2",
  analytics: "analytics.local_evaluator",
  ticketing: "ticketing.stub",
};

export * from "./contracts.js";
export { emailLogPlugin, emailResendPlugin, emailSendgridPlugin, chatSlackPlugin, storageR2Plugin, ticketingStubPlugin, analyticsLocalEvaluatorPlugin };
export { signStorageUrl, verifyStorageUrl } from "./storage/r2.js";
