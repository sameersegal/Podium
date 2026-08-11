import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  LIVE_EVENT_TYPES,
  isKnownEventType,
  isLiveEventType,
  liveAudience,
  liveEventTypes,
} from "@podiumconf/domain/events/catalogue.js";

/**
 * `LIVE_EVENT_TYPES` is the allowlist a room broadcasts on. Its failure mode is
 * silent in both directions: a name that is not a real event type never fires,
 * and a real event type left off never reaches a screen. Neither throws, and
 * neither shows up in a smoke test — the feature just quietly does nothing for
 * that one case.
 */

describe("the live topic allowlist", () => {
  it("names only event types the catalogue declares", () => {
    const unknown = liveEventTypes().filter((t) => !isKnownEventType(t));
    expect(unknown, `not in EVENT_TYPES: ${unknown.join(", ")}`).toEqual([]);
  });

  it("gives every topic an audience", () => {
    for (const type of liveEventTypes()) {
      expect(["staff", "member"], `${type} has no audience`).toContain(liveAudience(type));
    }
  });

  it("keeps review-internal timing away from members", () => {
    // 05 blinds a reviewer from their peers' work until they submit their own.
    // A frame carries no payload, but "a review landed just now" correlates,
    // so these must never reach a member-tagged socket.
    for (const type of ["review.submitted", "review.overridden", "decision.recorded", "proposal.submitted"] as const) {
      expect(liveAudience(type), `${type} must be staff-only`).toBe("staff");
    }
  });

  it("is a strict subset of the catalogue, not a second catalogue", () => {
    expect(liveEventTypes().length).toBeLessThan(EVENT_TYPES.length);
    expect(liveEventTypes().length).toBeGreaterThan(10);
  });

  it("recognises its own members and nothing else", () => {
    expect(isLiveEventType("review.submitted")).toBe(true);
    expect(isLiveEventType("person.created")).toBe(false);
    expect(isLiveEventType("not.an.event")).toBe(false);
  });

  it("carries role_grant.revoked, which is how a revoked grant closes a socket", () => {
    // Not a screen update — `platform.room_broadcast` branches on it. If it
    // ever drops off this list the kick silently stops happening and a socket
    // survives until its lifetime cap instead.
    expect(LIVE_EVENT_TYPES["role_grant.revoked"]).toBe("staff");
  });
});
