/**
 * The domain event envelope — 10-domain-events.md, "Envelope".
 */

import { newId } from "../shared/ids.js";
import { nowIso, type Instant } from "../shared/time.js";
import type { DomainEventType } from "./catalogue.js";

export type ActorType = "person" | "api_key" | "system" | "integration";

export interface Actor {
  type: ActorType;
  id?: string | null;
  display_name?: string | null;
}

export interface EventSubject {
  type: string;
  id: string;
}

export interface DomainEvent<D = Record<string, unknown>> {
  /** ULID, prefix `evn_`. The consumer's idempotency key. */
  id: string;
  type: DomainEventType;
  /** Per type, starts at 1. */
  version: number;
  /** When the fact became true, not when it was delivered. */
  occurred_at: Instant;
  org_id: string;
  event_id?: string | null;
  actor: Actor;
  subject: EventSubject;
  data: D;
  /** Groups everything from one request or batch. */
  correlation_id?: string | null;
  /** The event that caused this one; makes cascades traceable. */
  causation_id?: string | null;
}

export interface NewEvent<D = Record<string, unknown>> {
  type: DomainEventType;
  subject: EventSubject;
  data: D;
  event_id?: string | null;
  version?: number;
}

export function buildEvent<D extends Record<string, unknown>>(
  ev: NewEvent<D>,
  ctx: { org_id: string; event_id?: string | null; actor: Actor; correlation_id?: string | null; causation_id?: string | null },
  at: Instant = nowIso(),
): DomainEvent<D> {
  return {
    id: newId("DomainEventRecord"),
    type: ev.type,
    version: ev.version ?? 1,
    occurred_at: at,
    org_id: ctx.org_id,
    event_id: ev.event_id ?? ctx.event_id ?? null,
    actor: ctx.actor,
    subject: ev.subject,
    data: ev.data,
    correlation_id: ctx.correlation_id ?? null,
    causation_id: ctx.causation_id ?? null,
  };
}

export const SYSTEM_ACTOR: Actor = { type: "system", id: null, display_name: "system" };
