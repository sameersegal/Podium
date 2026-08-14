/**
 * The unit of work for one request or job.
 *
 * Domain services take this, raise events and audit entries on it, and never
 * touch a binding. `flush()` persists the append-only domain event log and the
 * audit log, then hands the events to the queue so consumers can react
 * (10-domain-events.md, "Reaction map").
 */

import { buildEvent, type Actor, type DomainEvent, type NewEvent } from "@podiumstack/domain/events/envelope.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import type { AuditEntry, AuditSink, Clock, EventSink } from "@podiumstack/domain/shared/ports.js";
import { nowIso, type Instant } from "@podiumstack/domain/shared/time.js";
import { D1Db, type Db, type Row } from "./db.js";
import { pokeRooms } from "./live.js";

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
  /**
   * The live-update rooms, one per event. Typed loosely for the same reason as
   * `SCHEDULE_DO`; callers reach it through `pokeRooms` / `kickFromRoom` in
   * `./live.js`, which own the request contract.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ROOM_DO: DurableObjectNamespace<any>;
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
  /**
   * HMAC key for signed, no-login links (today: unsubscribe — 09,
   * "Suppression is global"; INV-09-15). A Workers Secret
   * (`wrangler secret put UNSUBSCRIBE_SECRET`), not a var: `wrangler.jsonc`
   * cannot declare a plain secret, and this is not an `Integration.secret_ref`
   * (there is no `Integration` row it belongs to — see the comment on
   * `unsubscribeSigningKey` in `contexts/platform/notifications.ts`). Optional
   * on the type because it is genuinely absent outside production, where a
   * documented dev default is used instead.
   */
  UNSUBSCRIBE_SECRET?: string;
}

/**
 * The deployment's one Organization (INV-01-16) — its settings row, and the
 * single definition of which row that is.
 *
 * Since R9 was amended and migration 0011 dropped `org_id`, this resolves
 * nothing that scopes a query. It is still needed for two things: the
 * organization's own settings (name, `default_timezone`), and the `org_id` that
 * every domain event envelope carries to external webhook consumers
 * (10-domain-events.md, "Envelope").
 *
 * `ORDER BY created_at LIMIT 1` rather than "the only row", because on a
 * freshly migrated deployment there is no row at all until `/setup` runs.
 */
export async function soleOrg(env: Env): Promise<Row | null> {
  return await env.DB.prepare("SELECT * FROM organization ORDER BY created_at LIMIT 1").first<Row>();
}

/**
 * `soleOrg`'s id, for contexts built off the request path — cron jobs, queue
 * consumers, reactions — which have no `RequestContext` to inherit it from and
 * need only the id for the envelope.
 */
export async function soleOrgId(env: Env): Promise<string> {
  const row = await soleOrg(env);
  return row ? String(row.id) : "";
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
  /**
   * The deployment's one Organization (INV-01-16). Since R9 was amended and
   * migration 0011 dropped `org_id`, this no longer scopes a single query — it
   * is carried solely because `org_id` is a published field of the domain event
   * envelope (10-domain-events.md, "Envelope") that external webhook consumers
   * receive.
   */
  orgId: string;
  eventId?: string | null;
  actor: Actor;
  correlationId?: string;
  ip?: string | null;
  userAgent?: string | null;
  causationId?: string | null;
  clock?: Clock;
  /**
   * Work that must outlive the response but must not delay it — today, the
   * live-room poke in `flush()`. Absent for contexts built off the request
   * path (reactions, cron), which simply await it.
   */
  waitUntil?: (p: Promise<unknown>) => void;
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
  private readonly waitUntil?: (p: Promise<unknown>) => void;

  constructor(init: AppContextInit) {
    this.waitUntil = init.waitUntil;
    this.env = init.env;
    this.orgId = init.orgId;
    this.eventId = init.eventId ?? null;
    this.actor = init.actor;
    this.correlationId = init.correlationId ?? newId("DomainEventRecord");
    this.ip = init.ip ?? null;
    this.userAgent = init.userAgent ?? null;
    this.clock = init.clock ?? { now: () => nowIso() };
    this.db = new D1Db(init.env.DB);
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
      // The second transport: browsers watching this event's screens. Awaited
      // only when there is no `waitUntil` to hand it to — a Durable Object
      // round trip on the way to a 303 is exactly the latency this path exists
      // to remove, and a poke that never lands costs a refresh, not a fact.
      const poke = pokeRooms(this.env, events);
      if (this.waitUntil) this.waitUntil(poke);
      else await poke;
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
    // reaction, not the fact. `platform.replay_unprocessed_events`
    // (workers/api/src/contexts/platform/cron.ts, backed by
    // workers/api/src/consumers/replay.ts) re-delivers any event whose
    // reaction map is still incomplete on its next tick, at most 15 minutes
    // later — the Cron Trigger's own floor (wrangler.jsonc).
    console.warn("event publish failed", { count: events.length, error: String(err) });
  }
}
