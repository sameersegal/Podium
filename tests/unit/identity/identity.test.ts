import { describe, expect, it } from "vitest";
import {
  canTransitionParticipant,
  INVITATION_TRANSITIONS,
  isAbsoluteHttps,
  normaliseEmail,
  normaliseName,
  profileCompleteness,
  PARTICIPANT_STATUS,
  PORTAL_ACCESS,
} from "@podiumconf/domain/identity/types.js";

describe("Person and profile (01)", () => {
  it("canonicalises email, since INV-01-1 makes it unique per org", () => {
    expect(normaliseEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("normalises a name for merge-candidate matching without inventing a first/last split", () => {
    // 01: full_name is "as the person writes it; never split into first/last".
    expect(normaliseName("  Ádá  Lovelace ")).toBe("ada lovelace");
    expect(normaliseName("Ada Lovelace")).toBe(normaliseName("ADA  LOVELACE"));
  });

  it("INV-01-5: a profile link must be an absolute https URL", () => {
    expect(isAbsoluteHttps("https://example.com/me")).toBe(true);
    expect(isAbsoluteHttps("http://example.com/me")).toBe(false);
    expect(isAbsoluteHttps("example.com/me")).toBe(false);
    expect(isAbsoluteHttps("javascript:alert(1)")).toBe(false);
  });

  it("computes profile completeness so the portal's nudge names what is missing", () => {
    expect(profileCompleteness({})).toBe(0);
    expect(
      profileCompleteness({
        headline: "Staff Engineer, Acme",
        job_title: "Staff Engineer",
        company: "Acme",
        bio: "…",
        short_bio: "…",
        headshot_asset_id: "ast_1",
        location: "SF",
        link_count: 1,
      }),
    ).toBe(100);
    expect(profileCompleteness({ headline: "x", bio: "y" })).toBe(25);
  });
});

describe("EventParticipant roster workflow (01)", () => {
  it("permits exactly the transitions the diagram draws", () => {
    expect(canTransitionParticipant("prospect", "invited")).toBe(true);
    expect(canTransitionParticipant("invited", "confirmed")).toBe(true);
    expect(canTransitionParticipant("invited", "declined")).toBe(true);
    expect(canTransitionParticipant("confirmed", "withdrawn")).toBe(true);
  });

  it("rejects the transitions it does not draw — an undrawn transition does not exist", () => {
    expect(canTransitionParticipant("prospect", "confirmed")).toBe(false);
    expect(canTransitionParticipant("declined", "confirmed")).toBe(false);
    expect(canTransitionParticipant("withdrawn", "confirmed")).toBe(false);
    expect(canTransitionParticipant("confirmed", "invited")).toBe(false);
  });

  it("keeps roster status and portal access as separate questions (INV-01-11)", () => {
    // "is this human coming to our conference" vs "can they reach the portal";
    // membership grants sign-in only, never content access.
    expect(PARTICIPANT_STATUS).toContain("confirmed");
    expect(PORTAL_ACCESS).toEqual(["none", "invited", "active", "revoked"]);
    expect(PARTICIPANT_STATUS).not.toContain("active");
  });
});

describe("Invitation lifecycle (01)", () => {
  it("INV-01-7: an invitation is single-use — every terminal state is terminal", () => {
    expect(INVITATION_TRANSITIONS.pending).toEqual(["accepted", "declined", "expired", "revoked"]);
    for (const terminal of ["accepted", "declined", "expired", "revoked"] as const) {
      expect(INVITATION_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});
