/**
 * Read models and JSON/redaction shaping shared by the platform routes.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import type { DomainEvent } from "@podiumconf/domain/events/envelope.js";
import { redactEventPayload } from "@podiumconf/domain/platform/payload.js";
import { redactRecord } from "@podiumconf/domain/shared/pii.js";
import { reactionsFor } from "../../consumers/dispatch.js";
import { rowToEvent } from "../../consumers/replay.js";
import { availablePlugins } from "./service.js";

/* -------------------------------------------------------------------------- */
/* CommunicationsHistory — "did we tell her?" as a query                      */
/* -------------------------------------------------------------------------- */

export interface CommsFilters {
  event_id?: string | null;
  person_id?: string | null;
  session_id?: string | null;
  campaign_id?: string | null;
  status?: string | null;
  cursor?: string | null;
  limit?: number;
}

/**
 * Every `NotificationDelivery` for an event, a person or a session,
 * system-triggered and campaign alike (09, "`CommunicationsHistory`"). Reached
 * from the event, from a person's record, and from a session.
 */
export async function communicationsHistory(app: AppContext, filters: CommsFilters): Promise<{ items: Row[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const clauses = ["org_id = ?"];
  const params: unknown[] = [app.orgId];
  if (filters.event_id) {
    clauses.push("event_id = ?");
    params.push(filters.event_id);
  }
  if (filters.person_id) {
    clauses.push("recipient_person_id = ?");
    params.push(filters.person_id);
  }
  if (filters.campaign_id) {
    clauses.push("campaign_id = ?");
    params.push(filters.campaign_id);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.session_id) {
    clauses.push("subject_type = 'session' AND subject_id = ?");
    params.push(filters.session_id);
  }
  if (filters.cursor) {
    clauses.push("id < ?");
    params.push(filters.cursor);
  }
  const rows = await app.db.raw<Row>(
    `SELECT * FROM notification_delivery WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${limit + 1}`,
    params,
  );
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? str(items[items.length - 1]?.id) : null };
}

/** INV-09-5 / INV-11-4: redact `recipient_email` and the rendered body without `pii:read`. */
export function notificationJson(row: Row, includePii: boolean): Record<string, unknown> {
  const redacted = redactRecord("NotificationDelivery", row as Record<string, unknown>, { includePii });
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    campaign_id: strOrNull(row.campaign_id),
    template_key: strOrNull(row.template_key),
    template_version: row.template_version === null || row.template_version === undefined ? null : num(row.template_version),
    recipient_person_id: strOrNull(row.recipient_person_id),
    recipient_email: redacted.recipient_email,
    channel: str(row.channel),
    integration_id: strOrNull(row.integration_id),
    subject_type: strOrNull(row.subject_type),
    subject_id: strOrNull(row.subject_id),
    subject: strOrNull(row.subject),
    rendered_body: redacted.rendered_body,
    status: str(row.status),
    suppressed_reason: strOrNull(row.suppressed_reason),
    provider_message_id: strOrNull(row.provider_message_id),
    sent_at: strOrNull(row.sent_at),
    delivered_at: strOrNull(row.delivered_at),
    error: strOrNull(row.error),
    created_at: str(row.created_at),
  };
}

/* -------------------------------------------------------------------------- */
/* Entity JSON shapes                                                          */
/* -------------------------------------------------------------------------- */

export function apiKeyJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    name: str(row.name),
    prefix: str(row.prefix),
    scopes: parseJson<string[]>(row.scopes, []),
    event_ids: parseJson<string[]>(row.event_ids, []),
    created_by_person_id: str(row.created_by_person_id),
    expires_at: strOrNull(row.expires_at),
    last_used_at: strOrNull(row.last_used_at),
    last_used_ip: strOrNull(row.last_used_ip),
    rate_limit_per_minute: row.rate_limit_per_minute === null ? null : num(row.rate_limit_per_minute),
    revoked_at: strOrNull(row.revoked_at),
    created_at: str(row.created_at),
  };
}

export function webhookJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    name: str(row.name),
    url: str(row.url),
    event_types: parseJson<string[]>(row.event_types, []),
    include_pii: bool(row.include_pii),
    status: str(row.status),
    consecutive_failures: num(row.consecutive_failures),
    secret_rotated_at: strOrNull(row.secret_rotated_at),
    created_by_person_id: str(row.created_by_person_id),
    created_at: str(row.created_at),
    row_version: num(row.row_version, 1),
  };
}

export function webhookDeliveryJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    webhook_id: str(row.webhook_id),
    domain_event_id: str(row.domain_event_id),
    attempt: num(row.attempt, 1),
    status: str(row.status),
    response_status: row.response_status === null || row.response_status === undefined ? null : num(row.response_status),
    response_body_excerpt: strOrNull(row.response_body_excerpt),
    error: strOrNull(row.error),
    scheduled_for: strOrNull(row.scheduled_for),
    delivered_at: strOrNull(row.delivered_at),
    duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
  };
}

export function integrationJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    plugin_key: str(row.plugin_key),
    capability: str(row.capability),
    display_name: str(row.display_name),
    config: parseJson<Record<string, unknown>>(row.config, {}),
    secret_ref: strOrNull(row.secret_ref) || null,
    is_default_for_capability: bool(row.is_default_for_capability),
    status: str(row.status),
    last_health_check_at: strOrNull(row.last_health_check_at),
    last_error: strOrNull(row.last_error),
    created_at: str(row.created_at),
  };
}

export function templateJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: strOrNull(row.event_id),
    key: str(row.key),
    channel: str(row.channel),
    subject: strOrNull(row.subject),
    body_markdown: str(row.body_markdown),
    locale: str(row.locale, "en"),
    is_active: bool(row.is_active),
    version: num(row.version, 1),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

export function campaignJson(row: Row, stats: Record<string, number>, recipientCount: number): Record<string, unknown> {
  return {
    id: str(row.id),
    org_id: str(row.org_id),
    event_id: strOrNull(row.event_id),
    name: str(row.name),
    channel: str(row.channel),
    template_id: strOrNull(row.template_id),
    subject: strOrNull(row.subject),
    body_markdown: str(row.body_markdown),
    audience: parseJson<Record<string, unknown>>(row.audience, {}),
    recipient_count: recipientCount, // D — resolved from audience, never stored
    status: str(row.status),
    scheduled_for: strOrNull(row.scheduled_for),
    created_by_person_id: str(row.created_by_person_id),
    sent_at: strOrNull(row.sent_at),
    stats, // D — from its deliveries
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

/* -------------------------------------------------------------------------- */
/* Event log — domain_event_record + event_reaction_log, read-only            */
/* -------------------------------------------------------------------------- */

export interface EventLogFilters {
  /** Exact type, or a `noun.*` wildcard — the same shape the webhook replay filter already uses. */
  type?: string | null;
  subject_id?: string | null;
  correlation_id?: string | null;
  cursor?: string | null;
  limit?: number;
}

/**
 * `domain_event_record`, newest first — the read surface 10-domain-events.md
 * promises ("why did this speaker get that email") and, before this,
 * genuinely lacked: the table was reachable only from cron dedupe, delivery
 * and the (production-refusing) dev routes. Webhooks got a full ops screen;
 * the internal event log got two `console.error` calls.
 */
export async function listDomainEvents(app: AppContext, filters: EventLogFilters): Promise<{ items: Row[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const clauses = ["org_id = ?"];
  const params: unknown[] = [app.orgId];
  const type = filters.type?.trim();
  if (type && type !== "*") {
    if (type.endsWith(".*")) {
      clauses.push("type LIKE ?");
      params.push(`${type.slice(0, -1)}%`);
    } else {
      clauses.push("type = ?");
      params.push(type);
    }
  }
  if (filters.subject_id) {
    clauses.push("subject_id = ?");
    params.push(filters.subject_id);
  }
  if (filters.correlation_id) {
    clauses.push("correlation_id = ?");
    params.push(filters.correlation_id);
  }
  if (filters.cursor) {
    clauses.push("id < ?");
    params.push(filters.cursor);
  }
  const rows = await app.db.raw<Row>(`SELECT * FROM domain_event_record WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${limit + 1}`, params);
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? str(items[items.length - 1]?.id) : null };
}

export async function getDomainEventRow(app: AppContext, id: string): Promise<Row | null> {
  const rows = await app.db.raw<Row>("SELECT * FROM domain_event_record WHERE id = ? AND org_id = ?", [id, app.orgId]);
  return rows[0] ?? null;
}

/** Events this one caused — walking `causation_id` forward, one hop. */
export async function childEventsOf(app: AppContext, id: string): Promise<Row[]> {
  return app.db.raw<Row>("SELECT * FROM domain_event_record WHERE causation_id = ? AND org_id = ? ORDER BY id", [id, app.orgId]);
}

export interface ReactionStatus {
  handler: string;
  ran: boolean;
  processed_at: string | null;
}

/**
 * Every handler the reaction map (`consumers/reactions.ts`, mirroring
 * 10-domain-events.md) says should subscribe to this event's type, each
 * cross-checked against whether it actually logged completion — "which
 * handlers ran, and which are still missing" for one event, the exact
 * question `platform.replay_unprocessed_events` (`consumers/replay.ts`)
 * answers for the whole log on a schedule.
 */
export async function reactionStatusFor(app: AppContext, eventId: string, type: string): Promise<ReactionStatus[]> {
  const expected = reactionsFor(type);
  if (expected.length === 0) return [];
  const logRows = await app.db.raw<Row>("SELECT handler, processed_at FROM event_reaction_log WHERE event_id = ?", [eventId]);
  const done = new Map(logRows.map((r) => [str(r.handler), str(r.processed_at)]));
  return expected.map((r) => ({ handler: r.name, ran: done.has(r.name), processed_at: done.get(r.name) ?? null }));
}

/**
 * The envelope, redacted per the reader's PII permission — the same rule
 * webhook payloads already follow (INV-09-5 / INV-11-4), applied here so the
 * one place `data` is rendered in full does not become the side door around
 * it.
 */
export function domainEventPayload(row: Row, includePii: boolean): DomainEvent {
  return redactEventPayload(rowToEvent(row), { includePii });
}

export function pluginOptionsJson(): Record<string, unknown>[] {
  return availablePlugins().map((p) => ({
    key: p.key,
    capability: p.capability,
    display_name: p.display_name,
    requires_secret: !!p.requires_secret,
    config_fields: p.config_fields ?? [],
  }));
}
