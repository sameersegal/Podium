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

import type { Capability } from "@podiumstack/domain/platform/types.js";
import type { SyncFieldKind } from "@podiumstack/domain/platform/sync.js";

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
  /** RFC 8058 one-click unsubscribe (`List-Unsubscribe*`) on a non-transactional send, among others. */
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
/* sync — the two-way table mirror (09, "Two-way sync"; R31)                   */
/* -------------------------------------------------------------------------- */

export interface SyncFieldDescriptor {
  external_field: string;
  label: string;
  /** The provider's own type name, shown when mapping. Opaque to the core. */
  type: string;
  /** A formula, rollup or autonumber. Offerable as a pull target, never a push one. */
  read_only?: boolean;
}

export interface SyncTable {
  external_table_id: string;
  name: string;
  fields: SyncFieldDescriptor[];
}

export interface SyncRecordInput {
  /** Null creates; a value updates. The core owns the mapping, never the provider. */
  external_id: string | null;
  fields: Record<string, unknown>;
}

export interface SyncUpsertResult {
  external_id: string;
  error?: string | null;
}

export interface SyncChange {
  external_id: string;
  fields: Record<string, unknown>;
  deleted?: boolean;
}

export interface SyncChangePage {
  changes: SyncChange[];
  /** Opaque; handed back on the next call. Null means "start from the beginning". */
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * One column to create, in semantic terms. The adapter picks the provider type.
 *
 * The core says "this is a set of tags" and "this points at that table"; only
 * the adapter knows those are `multipleSelects` and `multipleRecordLinks`.
 */
export interface SyncColumnSpec {
  external_field: string;
  kind: SyncFieldKind;
  /** For `link` — the provider table id on the other end. */
  links_to_table_id?: string | null;
  /** Shown in every linked-record chip. Exactly one, and it must be first. */
  primary?: boolean;
}

export interface SyncTableSpec {
  /** Null creates the table; a value extends the one that is there. */
  external_table_id?: string | null;
  name: string;
  columns: SyncColumnSpec[];
}

/**
 * A table-shaped, two-way mirror. Six methods, and none of them know what a
 * proposal is — every rule that matters is core (09).
 *
 * Two shapes here are deliberate. `list_changes` takes a cursor so a provider
 * with a real change feed can use it, but a provider without one may return
 * every record: the core hash-compares regardless, because it has to for echo
 * suppression (INV-09-19). And `handle_inbound_webhook` returns *which tables to
 * go and read* rather than the changed data, because spreadsheet tools send a
 * ping, and an out-of-order payload would be worse than a prompt to re-read.
 */
export interface SyncPlugin extends PluginBase {
  capability: "sync";
  /** Records per `upsert_records` call the provider will accept. Airtable: 10. */
  batch_limit: number;
  list_tables(ctx: PluginContext): Promise<SyncTable[]>;
  describe_table(external_table_id: string, ctx: PluginContext): Promise<SyncTable>;
  upsert_records(external_table_id: string, records: SyncRecordInput[], ctx: PluginContext): Promise<SyncUpsertResult[]>;
  list_changes(external_table_id: string, cursor: string | null, ctx: PluginContext): Promise<SyncChangePage>;
  /** Erasure propagation (INV-09-22). Must tolerate an id that is already gone. */
  delete_records(external_table_id: string, external_ids: string[], ctx: PluginContext): Promise<void>;
  /** Null `external_table_ids` means "something changed, re-read everything". */
  handle_inbound_webhook?(payload: unknown, ctx: PluginContext): Promise<{ external_table_ids: string[] | null }>;
  /**
   * Create the table, or add the columns it is missing, and return what it now
   * has. Optional: a provider without a schema API simply cannot offer it.
   *
   * Worth having because the alternative is an organizer hand-typing twenty
   * column names that must match exactly, and then discovering at the first sync
   * that one of them is a text field where a date was needed. Additive only — it
   * never renames, retypes or removes a column somebody else made.
   */
  ensure_table?(spec: SyncTableSpec, ctx: PluginContext): Promise<SyncTable>;
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
  | AnalyticsPlugin
  | SyncPlugin;

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
  sync: SyncPlugin;
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
