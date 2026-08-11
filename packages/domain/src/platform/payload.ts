/**
 * The webhook payload — 09, "Delivery contract" and INV-09-5 / INV-11-4.
 *
 * The envelope on the wire is exactly `DomainEvent`. The only thing that
 * differs per recipient is redaction: without `include_pii`, personal fields
 * are removed from `data` before signing, so the signature covers what was
 * actually sent.
 */

import { EVENT_PII_DATA_FIELDS, PII_EVENT_TYPES, type DomainEventType } from "../events/catalogue.js";
import type { DomainEvent } from "../events/envelope.js";
import { REDACTED } from "../shared/pii.js";

export interface PayloadOptions {
  /** `Webhook.include_pii`, or the caller's `pii:read`. */
  includePii: boolean;
}

/**
 * INV-11-4: PII fields are absent from webhook payloads without `include_pii`.
 * "Absent" rather than `[redacted]` for the identifiers a consumer would
 * otherwise store; the field is replaced so the shape is stable.
 */
export function redactEventPayload(ev: DomainEvent, opts: PayloadOptions): DomainEvent {
  if (opts.includePii) return ev;
  if (!PII_EVENT_TYPES.has(ev.type as DomainEventType)) return ev;
  const data: Record<string, unknown> = { ...ev.data };
  for (const field of EVENT_PII_DATA_FIELDS) {
    if (field in data && data[field] !== null && data[field] !== undefined) data[field] = REDACTED;
  }
  return { ...ev, data };
}

/** The body a webhook receives, as a string, so the signature covers it byte for byte. */
export function webhookBody(ev: DomainEvent, opts: PayloadOptions): string {
  return JSON.stringify(redactEventPayload(ev, opts));
}

/** First 2KB only — `WebhookDelivery.response_body_excerpt`. */
export function excerpt(body: string, limit = 2048): string {
  return body.length <= limit ? body : body.slice(0, limit);
}
