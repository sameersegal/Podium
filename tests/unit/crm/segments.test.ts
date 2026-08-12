import { describe, expect, it } from "vitest";
import { segmentShapeProblems, stageSetProblems, canMoveCard, isStalled, DEFAULT_PIPELINE_STAGES } from "@podiumstack/domain/crm/index.js";

/**
 * INV-14-1 — "a `ContactSegment` is `dynamic` (criteria, resolved at read) or
 * `static` (a frozen member list) and never both." The choice is explicit at
 * creation and enforced here, against plain data, before any row is written.
 */
describe("INV-14-1: dynamic vs static segment shape is explicit and mutually exclusive", () => {
  it("accepts a dynamic segment with criteria and no member list", () => {
    expect(segmentShapeProblems("dynamic", { criteria: { tag: "speaker" } })).toEqual([]);
  });

  it("rejects a dynamic segment with no criteria at all — that is the directory, not a segment", () => {
    const problems = segmentShapeProblems("dynamic", {});
    expect(problems.length).toBeGreaterThan(0);
  });

  it("rejects a dynamic segment carrying a frozen member list", () => {
    const problems = segmentShapeProblems("dynamic", { criteria: { tag: "speaker" }, member_person_ids: ["per_1"] });
    expect(problems.some((p) => p.includes("frozen member list"))).toBe(true);
  });

  it("accepts a static segment with a member list and no criteria", () => {
    expect(segmentShapeProblems("static", { member_person_ids: ["per_1", "per_2"] })).toEqual([]);
  });

  it("rejects a static segment carrying criteria — it is a decision, not a query", () => {
    const problems = segmentShapeProblems("static", { criteria: { tag: "speaker" } });
    expect(problems.some((p) => p.includes("decision somebody made"))).toBe(true);
  });

  it("a static segment with zero members today is still valid — the list is allowed to be empty", () => {
    expect(segmentShapeProblems("static", { member_person_ids: [] })).toEqual([]);
  });
});

describe("INV-14-2: a pipeline needs at least one open, one won and one lost stage", () => {
  it("the default stage set ships valid", () => {
    expect(stageSetProblems(DEFAULT_PIPELINE_STAGES)).toEqual([]);
  });

  it("rejects a stage set missing a won stage — terminal semantics come from kind, not a label", () => {
    const stages = DEFAULT_PIPELINE_STAGES.filter((s) => s.kind !== "won");
    const problems = stageSetProblems(stages);
    expect(problems.some((p) => p.includes("won"))).toBe(true);
  });

  it("rejects an empty stage set", () => {
    expect(stageSetProblems([])).toEqual(["A pipeline needs stages."]);
  });
});

describe("ProspectCard stage-kind transitions (14)", () => {
  it("allows open -> won and open -> lost", () => {
    expect(canMoveCard("open", "won")).toBe(true);
    expect(canMoveCard("open", "lost")).toBe(true);
  });

  it("allows reopening a won or lost card, logged as any other move", () => {
    expect(canMoveCard("won", "open")).toBe(true);
    expect(canMoveCard("lost", "open")).toBe(true);
  });

  it("does not draw won -> lost directly — reopen first, per the diagram", () => {
    expect(canMoveCard("won", "lost")).toBe(false);
    expect(canMoveCard("lost", "won")).toBe(false);
  });
});

describe("stalled_cards (14, CRM dashboard)", () => {
  const now = "2026-03-01T00:00:00.000Z";

  it("a won or lost card is never stalled — it is finished", () => {
    expect(isStalled({ stage_kind: "won", entered_stage_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("an open card past its next_action_at is stalled", () => {
    expect(isStalled({ stage_kind: "open", entered_stage_at: now, next_action_at: "2026-02-01T00:00:00.000Z" }, now)).toBe(true);
  });

  it("an open card in stage for 30+ days with no next_action_at is stalled", () => {
    expect(isStalled({ stage_kind: "open", entered_stage_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(true);
  });

  it("an open card recently moved, with a future next action, is not stalled", () => {
    expect(isStalled({ stage_kind: "open", entered_stage_at: "2026-02-25T00:00:00.000Z", next_action_at: "2026-03-10T00:00:00.000Z" }, now)).toBe(false);
  });
});
