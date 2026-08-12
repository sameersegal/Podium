import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarDateInZone,
  diffMinutes,
  formatTimeInZone,
  overlaps,
  zonedDateTimeToInstant,
} from "@podiumstack/domain/shared/time.js";
import { redactRecord, stripNeverPublic, NEVER_PUBLIC_PROFILE_FIELDS } from "@podiumstack/domain/shared/pii.js";
import { EVENT_TYPES, eventTypeMatches, isKnownEventType } from "@podiumstack/domain/events/catalogue.js";
import { buildEvent, SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { beyondCpuBudget, contentHash, hashPassword, hashToken, needsRehash, verifyPassword, newToken } from "@podiumstack/domain/identity/credentials.js";

describe("time (11-cross-cutting.md, Time)", () => {
  it("INV-02-1: renders an instant in the event timezone, not the viewer's", () => {
    // 2027-05-12T17:00Z is 10:00 in Los Angeles (PDT) and 19:00 in Berlin.
    const instant = "2027-05-12T17:00:00.000Z";
    expect(formatTimeInZone(instant, "America/Los_Angeles")).toBe("10:00");
    expect(formatTimeInZone(instant, "Europe/Berlin")).toBe("19:00");
  });

  it("authors a wall-clock time in the event timezone and stores it as UTC", () => {
    expect(zonedDateTimeToInstant("2027-05-12", "09:00", "America/Los_Angeles")).toBe("2027-05-12T16:00:00.000Z");
    expect(zonedDateTimeToInstant("2027-01-12", "09:00", "America/Los_Angeles")).toBe("2027-01-12T17:00:00.000Z");
  });

  it("keeps a calendar date a calendar date in the event's zone", () => {
    expect(calendarDateInZone("2027-05-13T06:30:00.000Z", "America/Los_Angeles")).toBe("2027-05-12");
  });

  it("detects the overlap that ROOM_DOUBLE_BOOKED and SPEAKER_DOUBLE_BOOKED are built on", () => {
    const a = ["2027-05-12T17:00:00.000Z", "2027-05-12T17:30:00.000Z"] as const;
    expect(overlaps(a[0], a[1], "2027-05-12T17:15:00.000Z", "2027-05-12T17:45:00.000Z")).toBe(true);
    // Back to back is not an overlap.
    expect(overlaps(a[0], a[1], "2027-05-12T17:30:00.000Z", "2027-05-12T18:00:00.000Z")).toBe(false);
  });

  it("measures durations in whole minutes", () => {
    expect(diffMinutes(addDays("2027-01-01T00:00:00.000Z", 1), "2027-01-01T00:00:00.000Z")).toBe(1440);
  });
});

describe("PII redaction is default-on (INV-09-5, INV-11-4)", () => {
  it("redacts a person's email without pii:read and returns it with", () => {
    const row = { id: "per_1", full_name: "Ada Lovelace", email: "ada@example.com" };
    expect(redactRecord("Person", row, { includePii: false }).email).toBe("[redacted]");
    expect(redactRecord("Person", row, { includePii: true }).email).toBe("ada@example.com");
  });

  it("INV-01-4: phone, dietary and accessibility notes are never public, whatever visibility says", () => {
    const profile = {
      bio: "public bio",
      phone: "+1 555 0100",
      dietary_notes: "vegetarian",
      accessibility_notes: "step-free access",
      visibility: { bio: "public", location: "public" },
    };
    const stripped = stripNeverPublic(profile) as Record<string, unknown>;
    for (const field of NEVER_PUBLIC_PROFILE_FIELDS) expect(stripped[field]).toBeUndefined();
    expect(stripped.bio).toBe("public bio");
  });

  it("redacts a form answer flagged pii even inside proposals:read", () => {
    const answer = { field_key: "accessibility_needs", value: "I use a wheelchair" };
    expect(redactRecord("ProposalAnswer", answer, { includePii: false }).value).toBe("[redacted]");
  });
});

describe("the domain event catalogue is a published contract (10-domain-events.md)", () => {
  it("has no duplicate type and every type is past tense", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    for (const type of EVENT_TYPES) {
      expect(type, `${type} is not <noun>.<verb>`).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("recognises catalogued types and rejects invented ones", () => {
    expect(isKnownEventType("decision.published")).toBe(true);
    expect(isKnownEventType("proposal.status_changed")).toBe(false);
  });

  it("matches the * and noun.* wildcards a Webhook may subscribe with", () => {
    expect(eventTypeMatches("*", "session.created")).toBe(true);
    expect(eventTypeMatches("proposal.*", "proposal.submitted")).toBe(true);
    expect(eventTypeMatches("proposal.*", "session.created")).toBe(false);
    expect(eventTypeMatches("session.created", "session.created")).toBe(true);
  });

  it("stamps an envelope with an evn_ id, the actor and the correlation id", () => {
    const ev = buildEvent(
      { type: "proposal.submitted", subject: { type: "proposal", id: "prp_1" }, data: { proposal_id: "prp_1" } },
      { org_id: "org_1", event_id: "evt_1", actor: SYSTEM_ACTOR, correlation_id: "req_1" },
      "2026-03-14T09:12:44.113Z",
    );
    expect(ev.id.startsWith("evn_")).toBe(true);
    expect(ev.version).toBe(1);
    expect(ev.occurred_at).toBe("2026-03-14T09:12:44.113Z");
    expect(ev.correlation_id).toBe("req_1");
  });
});

describe("credentials (INV-01-12, INV-01-7, INV-09-1)", () => {
  it("INV-01-12: hashes a password with Argon2id and never keeps the plaintext", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(stored).not.toContain("correct horse");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts, so two identical passwords do not produce the same hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("stays inside the 10 ms CPU an invocation gets on the free plan", () => {
    // The regression this guards is a 503, not a slow page: a hash that costs
    // more CPU than the plan allows takes the isolate down mid-sign-in. The
    // bound is generous because CI is not the Worker; anything near it means
    // the parameters have drifted back up, which is the thing to catch.
    const start = performance.now();
    verifyPassword("correct horse battery staple", hashPassword("correct horse battery staple"));
    expect(performance.now() - start).toBeLessThan(20);
  });

  it("refuses a hash too costly to verify rather than blowing the CPU budget", () => {
    // What the pre-existing production hashes look like: m=12 MiB, t=3.
    const legacy = "$argon2id$v=19$m=12288,t=3,p=1$c2FsdHNhbHRzYWx0c2E=$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGE=";
    expect(beyondCpuBudget(legacy)).toBe(true);
    expect(beyondCpuBudget(hashPassword("current"))).toBe(false);
  });

  it("re-hashes a credential written with other parameters on next sign-in", () => {
    expect(needsRehash("$argon2id$v=19$m=512,t=2,p=1$c2FsdHNhbHRzYWx0c2E=$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGE=")).toBe(true);
    expect(needsRehash(hashPassword("current"))).toBe(false);
  });

  it("INV-01-7 / INV-09-1: tokens are stored hashed and the raw value is unrecoverable", () => {
    const token = newToken();
    const hash = hashToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });

  it("INV-08-11: a content hash changes if and only if the content changes", () => {
    const a = contentHash({ title: "A", abstract: "x" });
    expect(contentHash({ title: "A", abstract: "x" })).toBe(a);
    expect(contentHash({ title: "A", abstract: "y" })).not.toBe(a);
  });
});
