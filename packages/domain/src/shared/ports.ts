/**
 * Ports the domain layer depends on. Pure interfaces — no Cloudflare imports
 * anywhere under packages/domain.
 */

import type { DomainEvent, Actor, NewEvent } from "../events/envelope.js";
import type { Instant } from "./time.js";

export interface Clock {
  now(): Instant;
}

export const systemClock: Clock = { now: () => new Date().toISOString() };

/** Collects domain events raised inside one request or job. */
export interface EventSink {
  emit(ev: NewEvent): void;
  /** Everything raised so far, in order. */
  drain(): DomainEvent[];
}

export interface AuditEntry {
  action: string;
  entity_type: string;
  entity_id: string;
  before?: unknown;
  after?: unknown;
  /** Required for overrides, waivers, merges and force-publishes (INV-11-5). */
  reason?: string | null;
  event_id?: string | null;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
  drain(): (AuditEntry & { id: string; created_at: Instant })[];
}

export interface ActorContext {
  org_id: string;
  event_id?: string | null;
  actor: Actor;
  correlation_id: string;
  ip?: string | null;
  user_agent?: string | null;
}
