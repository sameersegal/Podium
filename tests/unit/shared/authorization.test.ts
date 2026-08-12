import { describe, expect, it } from "vitest";
import {
  accessFor,
  assertMayReadReviewData,
  canAct,
  canRead,
  canWrite,
  isOwnProposal,
  NO_RELATIONSHIPS,
  type Principals,
} from "@podiumstack/domain/shared/authorization.js";

const ORG = "org_01";
const EVENT_A = "evt_A";
const EVENT_B = "evt_B";
const NOW = "2026-03-01T00:00:00.000Z";

function principals(over: Partial<Principals> = {}): Principals {
  return {
    org_id: ORG,
    person_id: "per_1",
    grants: [],
    relationships: { ...NO_RELATIONSHIPS },
    api_scopes: null,
    api_event_ids: null,
    ...over,
  };
}

describe("authorization matrix (11-cross-cutting.md)", () => {
  it("gives an org admin write access across every event", () => {
    const p = principals({ grants: [{ role: "admin", scope_type: "org", scope_id: ORG }] });
    expect(canWrite(p, "event.configure", { event_id: EVENT_A }, NOW)).toBe(true);
    expect(canWrite(p, "event.configure", { event_id: EVENT_B }, NOW)).toBe(true);
  });

  it("confines an event-scoped chair to their own event", () => {
    const p = principals({ grants: [{ role: "program_chair", scope_type: "event", scope_id: EVENT_A }] });
    expect(canWrite(p, "decision.manage", { event_id: EVENT_A }, NOW)).toBe(true);
    expect(canWrite(p, "decision.manage", { event_id: EVENT_B }, NOW)).toBe(false);
  });

  it("ignores an expired or revoked grant", () => {
    const expired = principals({
      grants: [{ role: "reviewer", scope_type: "event", scope_id: EVENT_A, expires_at: "2026-01-01T00:00:00.000Z" }],
    });
    const revoked = principals({
      grants: [{ role: "reviewer", scope_type: "event", scope_id: EVENT_A, revoked_at: "2026-02-01T00:00:00.000Z" }],
    });
    expect(canAct(expired, "review.submit", { event_id: EVENT_A }, NOW)).toBe(false);
    expect(canAct(revoked, "review.submit", { event_id: EVENT_A }, NOW)).toBe(false);
  });

  it("INV-01-13: only the profile's own person may set visibility or is_listed", () => {
    const organizer = principals({ grants: [{ role: "organizer", scope_type: "event", scope_id: EVENT_A }] });
    const owner = principals({ grants: [{ role: "owner", scope_type: "org", scope_id: ORG }] });
    const speaker = principals({ relationships: { ...NO_RELATIONSHIPS, session_ids: ["ses_1"] } });

    expect(canAct(organizer, "speaker_profile.edit", { event_id: EVENT_A }, NOW)).toBe(true);
    expect(canAct(organizer, "speaker_profile.set_visibility", { event_id: EVENT_A }, NOW)).toBe(false);
    expect(canAct(owner, "speaker_profile.set_visibility", {}, NOW)).toBe(false);
    expect(canAct(speaker, "speaker_profile.set_visibility", { session_id: "ses_1" }, NOW)).toBe(true);
  });

  it("relationship access is scoped: a speaker reaches their own session and no other", () => {
    const p = principals({ relationships: { ...NO_RELATIONSHIPS, session_ids: ["ses_mine"] } });
    expect(accessFor(p, "session.manage", { session_id: "ses_mine" }, NOW)).toBe("read");
    expect(accessFor(p, "task.complete", { session_id: "ses_mine" }, NOW)).toBe("own");
    expect(accessFor(p, "task.complete", { session_id: "ses_theirs" }, NOW)).toBe("none");
  });

  it("INV-09-9: an API key scoped to one event cannot touch another, whatever its scopes", () => {
    const p = principals({
      grants: [{ role: "admin", scope_type: "org", scope_id: ORG }],
      api_scopes: ["sessions:read", "sessions:write"],
      api_event_ids: [EVENT_A],
    });
    expect(accessFor(p, "session.manage", { event_id: EVENT_A }, NOW)).toBe("write");
    expect(accessFor(p, "session.manage", { event_id: EVENT_B }, NOW)).toBe("none");
  });

  it("INV-11-7: nobody reads review data for a proposal they are credited on, at any role", () => {
    const chairWhoAlsoSubmitted = principals({
      grants: [{ role: "program_chair", scope_type: "event", scope_id: EVENT_A }],
      relationships: { ...NO_RELATIONSHIPS, proposal_ids: ["prp_own"] },
    });
    expect(isOwnProposal(chairWhoAlsoSubmitted, "prp_own")).toBe(true);
    expect(() => assertMayReadReviewData(chairWhoAlsoSubmitted, "prp_own")).toThrow(/own proposal/);
    expect(() => assertMayReadReviewData(chairWhoAlsoSubmitted, "prp_other")).not.toThrow();
  });

  it("gives the public exactly one capability: reading the published schedule", () => {
    const anonymous = principals({ person_id: null });
    expect(canAct(anonymous, "schedule.read_published", { event_id: EVENT_A }, NOW)).toBe(true);
    expect(canAct(anonymous, "proposal.read_any", { event_id: EVENT_A }, NOW)).toBe(false);
    expect(canAct(anonymous, "review.read", { event_id: EVENT_A }, NOW)).toBe(false);
    expect(canAct(anonymous, "pii.read", { event_id: EVENT_A }, NOW)).toBe(false);
  });

  it("a track lead recommends decisions rather than making them", () => {
    const p = principals({ grants: [{ role: "track_lead", scope_type: "track", scope_id: "trk_1" }] });
    expect(accessFor(p, "decision.manage", { event_id: EVENT_A, track_id: "trk_1" }, NOW)).toBe("recommend");
    expect(canWrite(p, "decision.manage", { event_id: EVENT_A, track_id: "trk_1" }, NOW)).toBe(false);
  });

  // 01: "read-only across the event, no scores". The role had no column in the
  // 11 matrix at all until this was fixed, so it granted nothing and every
  // `viewer` grant — and every read-only API key, which maps onto one — was
  // refused everything it asked for.
  it("a viewer reads the event and writes nothing", () => {
    const p = principals({ grants: [{ role: "viewer", scope_type: "event", scope_id: EVENT_A }] });
    for (const capability of ["proposal.read_any", "session.manage", "config.manage", "sponsor.manage", "schedule.place", "task.complete"] as const) {
      expect(canRead(p, capability, { event_id: EVENT_A }, NOW), `read ${capability}`).toBe(true);
      expect(canWrite(p, capability, { event_id: EVENT_A }, NOW), `write ${capability}`).toBe(false);
    }
  });

  it("a viewer sees no scores, no PII and no audit log", () => {
    const p = principals({ grants: [{ role: "viewer", scope_type: "event", scope_id: EVENT_A }] });
    for (const capability of ["review.read", "pii.read", "audit.read", "org.configure", "contact_directory.read"] as const) {
      expect(canRead(p, capability, { event_id: EVENT_A }, NOW), capability).toBe(false);
    }
  });

  it("confines a viewer to the event they were granted", () => {
    const p = principals({ grants: [{ role: "viewer", scope_type: "event", scope_id: EVENT_A }] });
    expect(canRead(p, "proposal.read_any", { event_id: EVENT_A }, NOW)).toBe(true);
    expect(canRead(p, "proposal.read_any", { event_id: EVENT_B }, NOW)).toBe(false);
  });
});
