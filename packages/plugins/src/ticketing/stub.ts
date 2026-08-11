/**
 * `ticketing.stub` — one method, and nothing else (R19).
 *
 * "Workshop capacity is already modelled but registration lives in a ticketing
 * system, and the only thing the platform actually needs back is whether a
 * workshop is full — on the schedule, in real time."
 *
 * The stub answers from `config.capacities`, keyed by session id, so the
 * capacity path is exercisable without a provider. A real adapter replaces this
 * file and nothing else.
 */

import type { PluginContext, SessionCapacity, SessionCapacityRef, TicketingPlugin } from "../contracts.js";

export const ticketingStubPlugin: TicketingPlugin = {
  key: "ticketing.stub",
  capability: "ticketing",
  display_name: "Ticketing (local stub)",
  requires_secret: false,
  config_fields: [
    {
      key: "capacities",
      label: "Capacities",
      help: 'JSON of {"ses_…": {"sold": 40, "remaining": 10}} — for testing the capacity path without a provider.',
    },
  ],

  async get_capacity(session: SessionCapacityRef, ctx: PluginContext): Promise<SessionCapacity> {
    const raw = ctx.config.capacities;
    const map = (typeof raw === "string" ? safeParse(raw) : raw) as Record<string, { sold?: number; remaining?: number }> | null;
    const entry = map?.[session.session_id] ?? map?.[session.external_ref ?? ""] ?? null;
    return { sold: Number(entry?.sold ?? 0), remaining: Number(entry?.remaining ?? 0) };
  },

  async health() {
    return { ok: true };
  },
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
