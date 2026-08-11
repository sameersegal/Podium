/**
 * One Durable Object per event's schedule — 09, platform mapping, and
 * 11-cross-cutting.md, "Concurrency": *schedule placement is serialised per
 * event, one writer at a time, because concurrent drags produce conflicts that
 * no amount of retry logic untangles.*
 *
 * The command executes **inside** the object, wrapped in
 * `blockConcurrencyWhile`, so two organizers dragging the same slot queue
 * rather than interleave. Conflicts are recomputed in the same critical
 * section and returned in the write's response (INV-08-14).
 */

import type { Env } from "@podiumconf/data/context.js";
import { DomainError } from "@podiumconf/domain/shared/errors.js";
import type { Actor } from "@podiumconf/domain/events/envelope.js";
import { executePlacementCommand, type PlacementCommand, type PlacementResult } from "../contexts/scheduling/commands.js";

export interface SerialisedCall {
  command: PlacementCommand;
  orgId: string;
  eventId: string;
  actor: Actor;
  correlationId: string;
}

export class ScheduleDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/status") {
      const last = await this.state.storage.get<string>("last_write_at");
      return Response.json({ last_write_at: last ?? null });
    }

    if (url.pathname !== "/execute") return new Response("not found", { status: 404 });

    const call = (await req.json()) as SerialisedCall;
    let result: PlacementResult | null = null;
    let failure: { body: unknown; status: number } | null = null;

    await this.state.blockConcurrencyWhile(async () => {
      try {
        result = await executePlacementCommand(this.env, call);
        await this.state.storage.put("last_write_at", new Date().toISOString());
      } catch (err) {
        failure =
          err instanceof DomainError
            ? { body: err.toJSON(), status: err.status }
            : { body: { error: "internal_error", message: String(err) }, status: 500 };
      }
    });

    const failed = failure as { body: unknown; status: number } | null;
    if (failed) return Response.json(failed.body, { status: failed.status });
    return Response.json(result);
  }
}

/** Every mutation of a `Placement` goes through here. */
export async function runSerialised(env: Env, call: SerialisedCall): Promise<PlacementResult> {
  // One object per event: the name is the lock (11-cross-cutting.md,
  // "Concurrency"). The namespace is typed loosely at the data layer, so the
  // stub is narrowed to the only thing this call needs — a fetcher.
  const namespace = env.SCHEDULE_DO as DurableObjectNamespace;
  const id = namespace.idFromName(`schedule:${call.eventId}`);
  const stub = namespace.get(id) as unknown as { fetch: typeof fetch };
  const res = await stub.fetch("https://schedule.internal/execute", {
    method: "POST",
    body: JSON.stringify(call),
    headers: { "content-type": "application/json" },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new DomainError({
      code: String(body.error ?? "placement_failed"),
      message: String(body.message ?? "The placement could not be saved."),
      status: res.status,
      invariant: body.invariant ? String(body.invariant) : undefined,
      details: (body.details as Record<string, unknown>) ?? undefined,
    });
  }
  return body as unknown as PlacementResult;
}
