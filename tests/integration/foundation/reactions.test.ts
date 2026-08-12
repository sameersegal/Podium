import { env as testEnv } from "cloudflare:test";
import type { Env } from "@podiumstack/data/context.js";

const env = testEnv as unknown as Env & typeof testEnv;
import { beforeAll, describe, expect, it } from "vitest";
import { deliverEvent } from "@podiumstack/web/consumers/dispatch.js";
import { reactionsFor } from "@podiumstack/web/consumers/dispatch.js";
import { buildEvent, SYSTEM_ACTOR, type DomainEvent } from "@podiumstack/domain/events/envelope.js";
import { EVENT_TYPES } from "@podiumstack/domain/events/catalogue.js";

/**
 * 10-domain-events.md: "Every reaction must be idempotent on `DomainEvent.id` —
 * the same event may be delivered twice, and 'create session' running twice is
 * exactly the bug this rule exists to prevent."
 *
 * The guarantee is enforced once, in the dispatcher, so this is where it is
 * tested once.
 */

const ORG = "org_react";
const EVENT = "evt_react";

async function seed() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "React Org", "react-org", "UTC", "a@b.example", "{}", now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(EVENT, ORG, "React Event", "react-event", "UTC", "2027-05-12", "2027-05-14", "in_person", "active", "public", "{}", now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("per_react1", ORG, "react-speaker@example.com", "Rea Ction", "active", 0, now, now)
    .run();
}

function event<T extends Record<string, unknown>>(type: DomainEvent["type"], subject: { type: string; id: string }, data: T): DomainEvent<T> {
  return buildEvent(
    { type, subject, data },
    { org_id: ORG, event_id: EVENT, actor: SYSTEM_ACTOR, correlation_id: "req_test" },
  );
}

describe("the reaction map", () => {
  beforeAll(seed);

  it("runs a matching reaction once and skips it on redelivery of the same DomainEvent.id", async () => {
    const ev = event("proposal.submitted", { type: "proposal", id: "prp_react1" }, {
      proposal_id: "prp_react1",
      speaker_person_ids: ["per_react1"],
    });

    const first = await deliverEvent(env, ev);
    expect(first).toContain("identity.roster_from_proposal");

    const second = await deliverEvent(env, ev);
    expect(second).toEqual([]);

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM event_participant WHERE event_id = ? AND person_id = ?",
    )
      .bind(EVENT, "per_react1")
      .all<{ n: number }>();
    // INV-01-11: one EventParticipant per (event, person), however many times
    // the event is delivered.
    expect(results[0].n).toBe(1);
  });

  it("records which handler ran, so 'why did this happen' is a query", async () => {
    const ev = event("person.created", { type: "person", id: "per_react1" }, { person_id: "per_react1" });
    await deliverEvent(env, ev);
    const { results } = await env.DB.prepare("SELECT handler FROM event_reaction_log WHERE event_id = ?")
      .bind(ev.id)
      .all<{ handler: string }>();
    expect(results.map((r) => r.handler)).toContain("identity.detect_merge_candidates");
  });

  it("delivers an event no context reacts to only to the webhook fan-out", async () => {
    // Webhooks subscribe with `*`, so every catalogued fact reaches the fan-out
    // even when no internal handler wants it — that is the published contract.
    const ev = event("track.created", { type: "track", id: "trk_react1" }, { track_id: "trk_react1" });
    const ran = await deliverEvent(env, ev);
    expect(ran).toEqual(["platform.webhook_fanout"]);
  });

  it("only ever wires reactions to types in the published catalogue", () => {
    const known = new Set<string>(EVENT_TYPES);
    for (const type of EVENT_TYPES) {
      for (const reaction of reactionsFor(type)) {
        for (const pattern of reaction.types) {
          const literal = pattern.replace(/\.\*$/, "");
          const matches = [...known].some((t) => t === pattern || t.startsWith(literal + "."));
          expect(matches || pattern === "*", `${reaction.name} subscribes to unknown "${pattern}"`).toBe(true);
        }
      }
    }
  });
});
