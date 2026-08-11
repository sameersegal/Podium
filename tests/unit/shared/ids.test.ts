import { describe, expect, it } from "vitest";
import {
  entityOfId,
  eventCodeFromSlug,
  formatReference,
  ID_PREFIXES,
  isId,
  isSlug,
  newId,
  slugify,
  ulid,
} from "@podiumconf/domain/shared/ids.js";

describe("typed identifiers (11-cross-cutting.md, Identifiers)", () => {
  it("mints a ULID with the prefix the model documents for the entity", () => {
    const id = newId("Proposal");
    expect(id.startsWith("prp_")).toBe(true);
    expect(id).toHaveLength(4 + 26);
  });

  it("makes 'you passed a session id where a proposal id belongs' a validation error, not a mystery", () => {
    const sessionId = newId("Session");
    expect(isId("Session", sessionId)).toBe(true);
    expect(isId("Proposal", sessionId)).toBe(false);
  });

  it("uses a distinct prefix for every entity", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("recognises which entity an id belongs to", () => {
    expect(entityOfId(newId("SchedulePublication"))).toBe("SchedulePublication");
    expect(entityOfId("nope_01H")).toBeNull();
  });

  it("sorts by creation time, which is what gives pagination its order", () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_800_000_000_000);
    expect(early < late).toBe(true);
  });

  it("produces slugs of [a-z0-9-]", () => {
    expect(slugify("AI Engineering & Evals!")).toBe("ai-engineering-evals");
    expect(isSlug(slugify("Platform & Infra"))).toBe(true);
  });

  it("formats a human-facing reference that is safe to say out loud", () => {
    expect(formatReference("WF26", 142)).toBe("WF26-0142");
    expect(eventCodeFromSlug("devflow-conf-2027")).toBe("DC27");
  });
});
