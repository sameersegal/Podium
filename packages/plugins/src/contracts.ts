/**
 * Capability contracts — 09, "Capability contracts".
 *
 * **The core never imports a vendor SDK.** An `Integration` is an installed
 * adapter implementing one or more of these; the core calls the contract. Each
 * is deliberately minimal, so the widest possible provider set can satisfy it,
 * and so that "swap Resend for SES" is a config change.
 *
 * Templating, batching, quiet hours, digesting and suppression are **core
 * concerns**, not provider ones. The plugin does one thing: put this rendered
 * message on the wire.
 */

import type { Capability } from "@podiumconf/domain/platform/types.js";

export type { Capability };

/**
 * What a plugin is handed at call time. `secret` is resolved from
 * `Integration.secret_ref`; INV-09-3 means it never came out of `config`.
 */
export interface PluginContext {
  integration_id: string | null;
  plugin_key: string;
  config: Record<string, unknown>;
  secret: string | null;
  /**
   * Resolved from `Integration.webhook_secret_ref` — what an inbound callback
   * is verified against. Separate from `secret` because providers issue a
   * distinct signing secret for webhooks, and because the send credential must
   * not be reachable from the unauthenticated inbound path at all.
   */
  webhook_secret: string | null;
  /** `PUBLIC_BASE_URL` — plugins that mint URLs back into the platform need it. */
  base_url: string;
  /** Bindings a plugin needs. `storage.r2` takes the bucket. */
  bindings?: { bucket?: R2Bucket };
  now(): string;
}

export interface PluginBase {
  key: string;
  capability: Capability;
  display_name: string;
  /** Config keys the install form should ask for. Never a secret (INV-09-3). */
  config_fields?: { key: string; label: string; required?: boolean; help?: string }[];
  /** True when the plugin needs a `secret_ref` pointing at a real secret. */
  requires_secret?: boolean;
  /** A cheap liveness check driving `Integration.status` and `last_error`. */
  health?(ctx: PluginContext): Promise<{ ok: boolean; error?: string }>;
}

/* -------------------------------------------------------------------------- */
/* email                                                                       */
/* -------------------------------------------------------------------------- */

export interface EmailAddress {
  email: string;
  name?: string | null;
}

export interface EmailMessage {
  to: EmailAddress[];
  from?: EmailAddress;
  reply_to?: string | null;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  tags?: string[];
  /** INV-09-7 all the way down: a provider retry must not send twice. */
  idempotency_key: string;
}

export interface EmailSendResult {
  provider_message_id: string | null;
  status: "sent" | "queued" | "failed";
  error?: string | null;
}

export interface SenderVerification {
  verified: boolean;
  records?: { type: string; name: string; value: string }[];
}

/**
 * A provider callback as it arrived, before anything trusts it.
 *
 * `raw_body` is the unparsed request body: every provider signs the exact
 * bytes it sent, so parsing and re-serialising invalidates the signature.
 * `headers` keys are lowercased by the caller.
 */
export interface InboundWebhookRequest {
  headers: Record<string, string>;
  raw_body: string;
  /** Now, in epoch milliseconds — the replay window is measured against it. */
  received_at_ms: number;
}

/** What `handle_inbound_webhook` turns a provider callback into. */
export interface DeliveryStatusUpdate {
  provider_message_id: string | null;
  recipient_email: string;
  status: "delivered" | "bounced" | "complained" | "failed";
  /** Only a `hard` bounce goes on the global suppression list. */
  bounce_type?: "hard" | "soft" | null;
  occurred_at: string;
  error?: string | null;
}

export interface EmailPlugin extends PluginBase {
  capability: "email";
  send(message: EmailMessage, ctx: PluginContext): Promise<EmailSendResult>;
  verify_sender(domain: string, ctx: PluginContext): Promise<SenderVerification>;
  /**
   * INV-09-16: whether this callback really came from the provider. The
   * inbound route has no other authentication, so a `false` here is the only
   * thing standing between a stranger and the global suppression list. It runs
   * *before* `handle_inbound_webhook` and fails closed — an unconfigured
   * verification key means unverifiable, which means rejected.
   */
  verify_webhook(req: InboundWebhookRequest, ctx: PluginContext): Promise<boolean>;
  handle_inbound_webhook(payload: unknown, ctx: PluginContext): Promise<DeliveryStatusUpdate[]>;
}

/* -------------------------------------------------------------------------- */
/* chat                                                                        */
/* -------------------------------------------------------------------------- */

export interface ChatMessage {
  text: string;
  /** Provider-shaped rich blocks, optional; `text` is always the fallback. */
  blocks?: unknown[];
}

export interface ChatPlugin extends PluginBase {
  capability: "chat";
  post(channel: string, message: ChatMessage, ctx: PluginContext): Promise<{ ok: boolean; id?: string | null; error?: string }>;
}

/* -------------------------------------------------------------------------- */
/* calendar                                                                    */
/* -------------------------------------------------------------------------- */

export interface CalendarEvent {
  /** Stable key so a second call updates rather than duplicates. */
  external_ref: string;
  title: string;
  description?: string | null;
  location?: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  attendees?: EmailAddress[];
}

export interface CalendarPlugin extends PluginBase {
  capability: "calendar";
  create_or_update_event(ev: CalendarEvent, ctx: PluginContext): Promise<{ external_id: string; url?: string | null }>;
}

/* -------------------------------------------------------------------------- */
/* crm                                                                         */
/* -------------------------------------------------------------------------- */

export interface CrmCompany {
  sponsor_id: string;
  name: string;
  website_url?: string | null;
  tier?: string | null;
  event_name?: string | null;
}

export interface CrmContact {
  person_id: string;
  full_name: string;
  email: string;
  company?: string | null;
  job_title?: string | null;
}

export interface CrmActivity {
  subject_type: string;
  subject_id: string;
  kind: string;
  summary: string;
  occurred_at: string;
}

export interface CrmPlugin extends PluginBase {
  capability: "crm";
  upsert_company(company: CrmCompany, ctx: PluginContext): Promise<{ external_id: string }>;
  upsert_contact(contact: CrmContact, ctx: PluginContext): Promise<{ external_id: string }>;
  record_activity(activity: CrmActivity, ctx: PluginContext): Promise<{ ok: boolean }>;
}

/* -------------------------------------------------------------------------- */
/* storage                                                                     */
/* -------------------------------------------------------------------------- */

export interface PresignedUpload {
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  /** Opaque key the asset will live under. */
  storage_key: string;
  expires_at: string;
}

export interface PresignedDownload {
  url: string;
  expires_at: string;
}

export interface StoragePlugin extends PluginBase {
  capability: "storage";
  presign_upload(
    req: { storage_key: string; content_type: string; max_bytes: number; expires_in_seconds?: number },
    ctx: PluginContext,
  ): Promise<PresignedUpload>;
  presign_download(
    req: { storage_key: string; filename: string; expires_in_seconds?: number },
    ctx: PluginContext,
  ): Promise<PresignedDownload>;
  delete(storage_key: string, ctx: PluginContext): Promise<void>;
  /** Reads used by the export bundler and the file-serving route. */
  get(storage_key: string, ctx: PluginContext): Promise<{ body: ReadableStream | null; size: number } | null>;
  put(storage_key: string, data: ReadableStream | ArrayBuffer | Uint8Array, contentType: string, ctx: PluginContext): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* identity                                                                    */
/* -------------------------------------------------------------------------- */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string | null;
}

export interface IdentityPlugin extends PluginBase {
  capability: "identity";
  discover(issuer: string, ctx: PluginContext): Promise<OidcDiscovery>;
}

/* -------------------------------------------------------------------------- */
/* ticketing                                                                   */
/* -------------------------------------------------------------------------- */

export interface SessionCapacityRef {
  session_id: string;
  /** `Session.registration_url` or an id in the provider, from `config`. */
  registration_url?: string | null;
  external_ref?: string | null;
}

export interface SessionCapacity {
  sold: number;
  remaining: number;
}

/**
 * One method is the entire integration, deliberately (R19). Attendees are not
 * modelled: importing a bounded context to compute one integer is how a
 * conference tool becomes a ticketing system nobody asked it to be.
 */
export interface TicketingPlugin extends PluginBase {
  capability: "ticketing";
  get_capacity(session: SessionCapacityRef, ctx: PluginContext): Promise<SessionCapacity>;
}

/* -------------------------------------------------------------------------- */
/* analytics — the AI evaluator seam (05, R24)                                 */
/* -------------------------------------------------------------------------- */

export interface EvaluationRequest {
  proposal_id: string;
  title: string;
  abstract: string;
  /** Anonymised where the round is blind; the seam never decides that itself. */
  extra?: Record<string, unknown>;
  criteria: { key: string; label: string; kind: string; min?: number | null; max?: number | null; guidance?: string | null }[];
}

export interface EvaluationResult {
  /** Recorded as `Review.author_kind = ai`; never counts toward quorum. */
  ai_evaluator_key: string;
  ai_model: string;
  overall_score: number | null;
  criterion_scores: { key: string; value: number | string | boolean | null; comment?: string | null }[];
  summary: string;
  /** Confidence the evaluator claims, 0..1. Surfaced, never acted on. */
  confidence?: number | null;
}

export interface AnalyticsPlugin extends PluginBase {
  capability: "analytics";
  evaluate(req: EvaluationRequest, ctx: PluginContext): Promise<EvaluationResult>;
}

/* -------------------------------------------------------------------------- */

export type AnyPlugin =
  | EmailPlugin
  | ChatPlugin
  | CalendarPlugin
  | CrmPlugin
  | StoragePlugin
  | IdentityPlugin
  | TicketingPlugin
  | AnalyticsPlugin;

/** Maps a capability to the plugin interface implementing it. */
export interface PluginByCapability {
  email: EmailPlugin;
  chat: ChatPlugin;
  calendar: CalendarPlugin;
  crm: CrmPlugin;
  storage: StoragePlugin;
  identity: IdentityPlugin;
  ticketing: TicketingPlugin;
  analytics: AnalyticsPlugin;
  sms: never;
  video: never;
}

/** A provider call that failed in a way the caller should record, not throw past. */
export class PluginError extends Error {
  constructor(
    readonly plugin_key: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

export function configString(ctx: PluginContext, key: string, fallback = ""): string {
  const v = ctx.config[key];
  return v === undefined || v === null ? fallback : String(v);
}
