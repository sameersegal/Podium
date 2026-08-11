/**
 * The unit of work for one request or job.
 *
 * Domain services take this, raise events and audit entries on it, and never
 * touch a binding. `flush()` persists the append-only domain event log and the
 * audit log, then hands the events to the queue so consumers can react
 * (10-domain-events.md, "Reaction map").
 */

import { buildEvent, type Actor, type DomainEvent, type NewEvent } from "@podiumconf/domain/events/envelope.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import type { AuditEntry, AuditSink, Clock, EventSink } from "@podiumconf/domain/shared/ports.js";
import { nowIso, type Instant } from "@podiumconf/domain/shared/time.js";
import { D1Db, type Db } from "./db.js";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS_BUCKET: R2Bucket;
  EVENT_QUEUE: Queue;
  DELIVERY_QUEUE: Queue;
  /**
   * The schedule writer. Typed loosely on purpose: this package must not import
   * the Worker's class, and callers reach it through `runSerialised`, which
   * owns the request contract.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SCHEDULE_DO: DurableObjectNamespace<any>;
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
}

export class CollectingEventSink implements EventSink {
  private readonly events: DomainEvent[] = [];

  constructor(
    private readonly ctx: { org_id: string; event_id?: string | null; actor: Actor; correlation_id: string },
    private readonly clock: Clock,
    private readonly causationId: string | null = null,
  ) {}

  emit(ev: NewEvent): void {
    this.events.push(
      buildEvent(ev, { ...this.ctx, causation_id: this.causationId }, this.clock.now()),
    );
  }

  drain(): DomainEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }
}

export class CollectingAuditSink implements AuditSink {
  private readonly entries: (AuditEntry & { id: string; created_at: Instant })[] = [];

  constructor(private readonly clock: Clock) {}

  record(entry: AuditEntry): void {
    this.entries.push({ ...entry, id: newId("AuditLog"), created_at: this.clock.now() });
  }

  drain(): (AuditEntry & { id: string; created_at: Instant })[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface AppContextInit {
  env: Env;
  orgId: string;
  eventId?: string | null;
  actor: Actor;
  correlationId?: string;
  ip?: string | null;
  userAgent?: string | null;
  causationId?: string | null;
  clock?: Clock;
}

export class AppContext {
  readonly env: Env;
  readonly db: D1Db;
  readonly orgId: string;
  eventId: string | null;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly clock: Clock;
  readonly events: CollectingEventSink;
  readonly audit: CollectingAuditSink;

  constructor(init: AppContextInit) {
    this.env = init.env;
    this.orgId = init.orgId;
    this.eventId = init.eventId ?? null;
    this.actor = init.actor;
    this.correlationId = init.correlationId ?? newId("DomainEventRecord");
    this.ip = init.ip ?? null;
    this.userAgent = init.userAgent ?? null;
    this.clock = init.clock ?? { now: () => nowIso() };
    this.db = new D1Db(init.env.DB, init.orgId);
    this.events = new CollectingEventSink(
      { org_id: this.orgId, event_id: this.eventId, actor: this.actor, correlation_id: this.correlationId },
      this.clock,
      init.causationId ?? null,
    );
    this.audit = new CollectingAuditSink(this.clock);
  }

  get repo(): Db {
    return this.db;
  }

  now(): Instant {
    return this.clock.now();
  }

  /**
   * Persist the event log and audit rows, then publish. Publishing is the only
   * fan-out path: nothing long-running happens in the request (the Workers
   * rule), and consumers are idempotent on `DomainEvent.id`.
   */
  async flush(): Promise<DomainEvent[]> {
    const events = this.events.drain();
    const audits = this.audit.drain();
    this.events.clear();
    this.audit.clear();

    if (events.length > 0) {
      await this.db.insertMany(
        "domain_event_record",
        events.map((e) => ({
          id: e.id,
          type: e.type,
          version: e.version,
          occurred_at: e.occurred_at,
          org_id: e.org_id,
          event_id: e.event_id,
          actor_type: e.actor.type,
          actor_id: e.actor.id ?? null,
          actor_display: e.actor.display_name ?? null,
          subject_type: e.subject.type,
          subject_id: e.subject.id,
          data: JSON.stringify(e.data),
          correlation_id: e.correlation_id,
          causation_id: e.causation_id,
        })),
      );
    }

    if (audits.length > 0) {
      await this.db.insertMany(
        "audit_log",
        audits.map((a) => ({
          id: a.id,
          org_id: this.orgId,
          event_id: this.eventId,
          actor_type: this.actor.type,
          actor_id: this.actor.id ?? null,
          actor_display: this.actor.display_name ?? null,
          action: a.action,
          entity_type: a.entity_type,
          entity_id: a.entity_id,
          before: a.before === undefined ? null : JSON.stringify(a.before),
          after: a.after === undefined ? null : JSON.stringify(a.after),
          reason: a.reason ?? null,
          ip: this.ip,
          user_agent: this.userAgent,
          correlation_id: this.correlationId,
          created_at: a.created_at,
        })),
      );
    }

    if (events.length > 0) {
      await publishEvents(this.env, events);
    }
    return events;
  }
}

/**
 * Hand events to the queue. In tests and local dev the queue is real
 * (Miniflare), so this is the same code path in every environment.
 */
export async function publishEvents(env: Env, events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await env.EVENT_QUEUE.sendBatch(events.map((e) => ({ body: e })));
  } catch (err) {
    // The log row is already committed, so a queue outage costs latency on the
    // reaction, not the fact. The sweeper re-publishes unprocessed events.
    console.warn("event publish failed", { count: events.length, error: String(err) });
  }
}
