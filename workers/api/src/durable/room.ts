/**
 * One Durable Object per event — the live channel that tells a browser its
 * screen is out of date.
 *
 * The design decision that everything else follows from: **a frame carries no
 * domain data.** It says a type, a subject and a time, and nothing else. The
 * client then refetches through the ordinary authorized route.
 *
 * That is not squeamishness. Blinding (`review/reviewer-views.ts`) and PII
 * redaction are *projections*, computed per reader on the way out of an HTTP
 * handler. Reproducing them on a broadcast path would duplicate the subtlest
 * logic in the app, and a divergence there fails silently — nothing throws,
 * someone just sees a name they should not have. Refetching inherits every
 * redaction for free, permanently. It also collapses "revalidate authorization
 * on a long-lived connection", which is hard, into "cap the staleness of a
 * low-information side channel", which is easy (see `expires_at` below).
 *
 * "No payload" is still not "no information", so each frame carries an
 * audience and each socket is tagged with its role — 10-domain-events.md's
 * `LIVE_EVENT_TYPES` is where that mapping lives.
 *
 * Sockets are accepted through the hibernation API, so an idle room costs
 * nothing: `acceptWebSocket` rather than `server.accept()`, handlers as
 * methods rather than listeners, and per-socket state in the attachment rather
 * than on `this` — none of which survives eviction.
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "@podiumconf/data/context.js";
import { isLiveEventType, liveAudience, type LiveAudience } from "@podiumconf/domain/events/catalogue.js";

/** What actually crosses the wire, one element of a `RoomBatch`. */
export interface RoomFrame {
  type: string;
  subject: { type: string; id: string };
  occurred_at: string;
}

export interface RoomBatch {
  v: 1;
  seq: number;
  frames: RoomFrame[];
  /** The room cannot prove continuity from the client's `since` — reload rather than patch. */
  resync?: true;
}

/** One event, on its way in. `id` is `DomainEvent.id` and the dedupe key. */
export interface RoomPoke {
  id: string;
  type: string;
  subject: { type: string; id: string };
  occurred_at: string;
}

export interface SocketAttachment {
  person_id: string;
  role: LiveAudience;
  /** ISO instant past which this socket is closed and must reauthenticate. */
  expires_at: string;
}

/** Told to a client whose grant went away; the client reconnects immediately. */
export const CLOSE_REAUTHENTICATE = 4001;

/**
 * Publishing hundreds of decisions raises hundreds of events sharing one
 * correlation id. Without a coalescing window a room would send hundreds of
 * frames, and every one of them would provoke a refetch. This delay is what
 * makes a single per-event room viable instead of a per-round or per-proposal
 * mapping table that rots the first time someone adds an event type.
 */
const COALESCE_MS = 250;

/** Enough to absorb a redelivery; the fast poke and the queue backstop arrive within a second. */
const DEDUPE_WINDOW = 500;

export class RoomDurableObject extends DurableObject<Env> {
  /**
   * Both are in-memory and therefore lost on hibernation, which is fine and
   * deliberate: an empty dedupe set costs at most one duplicate frame (the
   * client refetches twice), and an empty buffer cannot lose anything because
   * the alarm that would have flushed it lives in storage.
   */
  private seen = new Set<string>();
  private buffer: RoomFrame[] = [];
  private bufferAudience: LiveAudience = "staff";

  /**
   * Extends the `cloudflare:workers` base class rather than standing alone as
   * `ScheduleDurableObject` does. That is not style: `DurableObjectStub<T>`
   * requires the brand the base class carries, and without it the room cannot
   * be driven through `runInDurableObject` — which is the only way to assert
   * what a socket actually received.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking this object. With a keepalive
    // every 30s per socket, this is the difference between an idle room
    // costing nothing and it costing a wakeup per socket per interval.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/subscribe") {
      return this.subscribe(req, url);
    }

    if (url.pathname === "/poke") {
      const pokes = (await req.json()) as RoomPoke[];
      for (const poke of pokes) this.enqueue(poke);
      if (this.buffer.length > 0) await this.armAlarm();
      return Response.json({ buffered: this.buffer.length });
    }

    if (url.pathname === "/kick") {
      const { person_id } = (await req.json()) as { person_id: string };
      this.kick(person_id);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/status") {
      return Response.json({ sockets: this.ctx.getWebSockets().length, seq: await this.seq() });
    }

    return new Response("not found", { status: 404 });
  }

  private async subscribe(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // The route already authorized this person and decided their audience —
    // the object trusts its own worker, which is the only thing that can
    // reach it.
    const attachment: SocketAttachment = {
      person_id: url.searchParams.get("person") ?? "",
      role: url.searchParams.get("role") === "staff" ? "staff" : "member",
      expires_at: url.searchParams.get("expires") ?? "",
    };

    // One person with forty tabs would otherwise pin the object and be
    // broadcast to forty times. Oldest first, because the tab they are looking
    // at is the one they just opened.
    const max = Number(url.searchParams.get("max") ?? "5");
    const held = this.ctx.getWebSockets(`person:${attachment.person_id}`);
    for (const stale of held.slice(0, Math.max(0, held.length - max + 1))) {
      stale.close(CLOSE_REAUTHENTICATE, "too many sockets");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Tags are how a broadcast selects its recipients later, and how a revoked
    // grant finds this person's sockets without deserialising every attachment.
    this.ctx.acceptWebSocket(server, [`person:${attachment.person_id}`, `role:${attachment.role}`]);
    server.serializeAttachment(attachment);

    const since = Number(url.searchParams.get("since") ?? "0");
    const seq = await this.seq();
    // A reconnecting client that missed frames is told to reload rather than
    // handed a gap it cannot see. Nothing durable is kept here — D1 already
    // holds every event, and a room is a notification channel, not a log.
    if (since > 0 && since < seq) {
      server.send(JSON.stringify({ v: 1, seq, frames: [], resync: true } satisfies RoomBatch));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Idempotent on `DomainEvent.id`, so the fast poke and the queue backstop collapse into one frame. */
  private enqueue(poke: RoomPoke): void {
    if (!isLiveEventType(poke.type)) return;
    if (this.seen.has(poke.id)) return;
    this.seen.add(poke.id);
    if (this.seen.size > DEDUPE_WINDOW) {
      // Cheapest possible eviction: drop the oldest insertion. A `Set` iterates
      // in insertion order, so this is exact rather than approximate.
      this.seen.delete(this.seen.values().next().value as string);
    }

    const audience = liveAudience(poke.type);
    // A batch is sent to one audience. Mixing them would mean either leaking a
    // staff-only frame to a reviewer or dropping it for everyone, so a
    // member-audience frame promotes the whole batch to the wider audience and
    // staff-only frames are held for a staff-only batch.
    if (audience === "member") this.bufferAudience = "member";
    this.buffer.push({ type: poke.type, subject: poke.subject, occurred_at: poke.occurred_at });
  }

  private async armAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + COALESCE_MS);
  }

  override async alarm(): Promise<void> {
    const frames = this.buffer;
    const audience = this.bufferAudience;
    this.buffer = [];
    this.bufferAudience = "staff";
    if (frames.length === 0) return;

    const seq = (await this.seq()) + 1;
    await this.ctx.storage.put("seq", seq);

    const batch: RoomBatch = { v: 1, seq, frames };
    const payload = JSON.stringify(batch);
    // A member-audience batch goes to everyone; a staff-only one goes to the
    // staff tag and no further.
    const targets = audience === "member" ? this.ctx.getWebSockets() : this.ctx.getWebSockets("role:staff");
    const now = new Date().toISOString();
    for (const ws of targets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      // The lifetime cap: permissions are recomputed per request by design
      // (`http/context.ts`), and a socket outlives a request. Closing here
      // makes the client reconnect through the authorized route, which
      // re-resolves grants and relationships from scratch.
      if (att?.expires_at && att.expires_at <= now) {
        ws.close(CLOSE_REAUTHENTICATE, "reauthenticate");
        continue;
      }
      try {
        ws.send(payload);
      } catch {
        // A socket the runtime has already torn down. `webSocketClose` will
        // reconcile; there is nothing to do and nothing worth logging.
      }
    }
  }

  private kick(personId: string): void {
    for (const ws of this.ctx.getWebSockets(`person:${personId}`)) {
      ws.close(CLOSE_REAUTHENTICATE, "reauthenticate");
    }
  }

  private async seq(): Promise<number> {
    return (await this.ctx.storage.get<number>("seq")) ?? 0;
  }

  // The hibernation API delivers these as methods. An `addEventListener`
  // handler registered in the constructor would be lost the moment the object
  // is evicted, which is the failure this shape exists to prevent.
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The client has nothing to say beyond the keepalive, which the runtime
    // auto-answers without waking us. Anything else is treated as a keepalive
    // rather than parsed — there is no client-authored input to trust here.
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // `close` on an already-closing socket is a no-op; this is here so the
    // runtime releases the connection promptly rather than at its own pace.
    try {
      ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  override async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    console.warn("live socket error", { error: String(err) });
  }
}
