import { describe, expect, it } from "vitest";
import {
  acceptsSubmission,
  cfpStatus,
  evaluateCondition,
  percentComplete,
  validateConditionOrdering,
  validateMappings,
  visibleSteps,
  type FormSpec,
} from "@podiumstack/domain/event-config/types.js";
import {
  activationBlockers,
  canTransitionEvent,
  cfpWindowProblems,
  durationProblems,
  isCosmeticFieldPatch,
  publishBlockers,
} from "@podiumstack/domain/event-config/rules.js";

const OPEN = { opens_at: "2026-01-01T00:00:00.000Z", closes_at: "2026-06-01T00:00:00.000Z", published_at: "2025-12-01T00:00:00.000Z" };
const DURING = "2026-03-01T00:00:00.000Z";
const AFTER = "2026-07-01T00:00:00.000Z";
const BEFORE = "2025-12-15T00:00:00.000Z";

describe("CallForProposals derived status (02, INV-11-6)", () => {
  it("is derived from the dates and a manual close, never stored", () => {
    expect(cfpStatus({ ...OPEN, published_at: null }, "active", DURING)).toBe("draft");
    expect(cfpStatus(OPEN, "active", BEFORE)).toBe("scheduled");
    expect(cfpStatus(OPEN, "active", DURING)).toBe("open");
    expect(cfpStatus(OPEN, "active", AFTER)).toBe("closed");
    expect(cfpStatus({ ...OPEN, closed_early_at: "2026-02-01T00:00:00.000Z" }, "active", DURING)).toBe("closed");
    expect(cfpStatus(OPEN, "archived", DURING)).toBe("archived");
  });

  it("INV-02-13: a closed CFP accepts no new proposal", () => {
    expect(acceptsSubmission(OPEN, "active", AFTER).allowed).toBe(false);
    expect(acceptsSubmission(OPEN, "active", DURING).allowed).toBe(true);
  });

  it("lets an in-flight submit land inside grace_period_minutes", () => {
    const justAfter = "2026-06-01T00:20:00.000Z";
    expect(acceptsSubmission({ ...OPEN, grace_period_minutes: 30 }, "active", justAfter)).toMatchObject({
      allowed: true,
      late: false,
    });
    expect(acceptsSubmission({ ...OPEN, grace_period_minutes: 5 }, "active", justAfter).allowed).toBe(false);
  });

  it("flags a late submission rather than rejecting it under allow_with_flag", () => {
    const result = acceptsSubmission({ ...OPEN, late_submission_policy: "allow_with_flag" }, "active", AFTER);
    expect(result).toMatchObject({ allowed: true, late: true });
  });

  it("a manual early close beats the late policy — the chair meant it", () => {
    const closedEarly = { ...OPEN, closed_early_at: "2026-02-01T00:00:00.000Z", late_submission_policy: "allow_with_flag" as const };
    expect(acceptsSubmission(closedEarly, "active", DURING).allowed).toBe(false);
  });

  it("INV-02-4: closes_at must be after opens_at", () => {
    expect(cfpWindowProblems({ opens_at: "2026-06-01T00:00:00.000Z", closes_at: "2026-01-01T00:00:00.000Z" })).not.toEqual([]);
    expect(cfpWindowProblems({ opens_at: OPEN.opens_at, closes_at: OPEN.closes_at })).toEqual([]);
  });
});

describe("Event state machine (02)", () => {
  it("draws only the transitions the diagram draws", () => {
    expect(canTransitionEvent("draft", "active")).toBe(true);
    expect(canTransitionEvent("active", "archived")).toBe(true);
    expect(canTransitionEvent("archived", "active")).toBe(true);
    expect(canTransitionEvent("draft", "archived")).toBe(false);
    expect(canTransitionEvent("active", "draft")).toBe(false);
  });

  it("INV-02-11: cannot become active without a day, a format, and a room when in person", () => {
    expect(activationBlockers({ mode: "in_person", day_count: 0, session_format_count: 1, room_count: 1 })).not.toEqual([]);
    expect(activationBlockers({ mode: "in_person", day_count: 1, session_format_count: 1, room_count: 0 })).not.toEqual([]);
    expect(activationBlockers({ mode: "in_person", day_count: 1, session_format_count: 1, room_count: 1 })).toEqual([]);
    // An online event needs no room.
    expect(activationBlockers({ mode: "online", day_count: 1, session_format_count: 1, room_count: 0 })).toEqual([]);
  });

  it("keeps a format's durations coherent", () => {
    expect(durationProblems({ default_duration_minutes: 30, min_duration_minutes: 40, max_duration_minutes: 60 })).not.toEqual([]);
    expect(durationProblems({ default_duration_minutes: 30, min_duration_minutes: 20, max_duration_minutes: 60 })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

function form(steps: FormSpec["steps"]): FormSpec {
  return { id: "frm_1", cfp_id: "cfp_1", version: 1, status: "draft", steps };
}

function field(over: Partial<FormSpec["steps"][number]["fields"][number]> = {}) {
  return {
    id: "fld_" + (over.key ?? "x"),
    step_id: "stp_1",
    key: "x",
    label: "X",
    type: "short_text" as const,
    is_required: false,
    maps_to: "none" as const,
    audience: "public" as const,
    pii: false,
    identifies_speaker: false,
    sort_order: 0,
    ...over,
  };
}

const fullForm = form([
  {
    id: "stp_1",
    key: "the-talk",
    title: "The talk",
    sort_order: 0,
    is_optional: false,
    fields: [
      field({ key: "title", maps_to: "title", is_required: true, sort_order: 0 }),
      field({ key: "abstract", type: "long_text", maps_to: "abstract", is_required: true, sort_order: 1 }),
      field({ key: "track", type: "track_picker", maps_to: "track", is_required: true, sort_order: 2 }),
      field({ key: "format", type: "format_picker", maps_to: "format", is_required: true, sort_order: 3 }),
      field({ key: "speakers", type: "speaker_list", maps_to: "speakers", is_required: true, sort_order: 4 }),
    ],
  },
]);

describe("the submission form (02)", () => {
  it("INV-02-7: every published form must map title, abstract, track, format and speakers", () => {
    expect(validateMappings(fullForm)).toEqual([]);
    const missing = form([{ ...fullForm.steps[0], fields: fullForm.steps[0].fields.slice(0, 3) }]);
    expect(validateMappings(missing).join(" ")).toMatch(/format/);
  });

  it("INV-02-7: refuses two fields claiming the same maps_to", () => {
    const duplicated = form([
      { ...fullForm.steps[0], fields: [...fullForm.steps[0].fields, field({ key: "title2", maps_to: "title", is_required: true, sort_order: 5 })] },
    ]);
    expect(validateMappings(duplicated).join(" ")).toMatch(/More than one field maps to title/);
  });

  it("INV-02-7: a mapped field must be required", () => {
    const optionalTitle = form([
      {
        ...fullForm.steps[0],
        fields: fullForm.steps[0].fields.map((f) => (f.key === "title" ? { ...f, is_required: false } : f)),
      },
    ]);
    expect(validateMappings(optionalTitle).join(" ")).toMatch(/must be required/);
  });

  it("INV-02-8: a condition may only reference a field that precedes it", () => {
    const backwards = form([
      {
        ...fullForm.steps[0],
        fields: [
          field({ key: "a", sort_order: 0, visible_when: { all: [{ field: "b", op: "eq", value: "1" }] } }),
          field({ key: "b", sort_order: 1 }),
        ],
      },
    ]);
    expect(validateConditionOrdering(backwards)).not.toEqual([]);

    const forwards = form([
      {
        ...fullForm.steps[0],
        fields: [
          field({ key: "b", sort_order: 0 }),
          field({ key: "a", sort_order: 1, visible_when: { all: [{ field: "b", op: "eq", value: "1" }] } }),
        ],
      },
    ]);
    expect(validateConditionOrdering(forwards)).toEqual([]);
  });

  it("INV-02-9: cosmetic edits stay in place; anything else clones a version", () => {
    expect(isCosmeticFieldPatch({ label: "New label", help_text: "hi" })).toBe(true);
    expect(isCosmeticFieldPatch({ label: "New label", is_required: true })).toBe(false);
    expect(isCosmeticFieldPatch({ type: "long_text" })).toBe(false);
  });

  it("INV-02-5 / INV-02-7: publishing is blocked until the form is complete", () => {
    expect(publishBlockers(fullForm)).toEqual([]);
    expect(publishBlockers(form([{ ...fullForm.steps[0], fields: [] }]))).not.toEqual([]);
  });
});

describe("condition rules (02, 'Condition rules')", () => {
  const answers = { format: "workshop", level: 3, consent: true, keywords: ["a", "b"], empty: "" };

  it("supports every documented op", () => {
    expect(evaluateCondition({ all: [{ field: "format", op: "eq", value: "workshop" }] }, answers)).toBe(true);
    expect(evaluateCondition({ all: [{ field: "format", op: "neq", value: "workshop" }] }, answers)).toBe(false);
    expect(evaluateCondition({ all: [{ field: "format", op: "in", value: ["talk", "workshop"] }] }, answers)).toBe(true);
    expect(evaluateCondition({ all: [{ field: "format", op: "not_in", value: ["talk"] }] }, answers)).toBe(true);
    expect(evaluateCondition({ all: [{ field: "format", op: "is_set" }] }, answers)).toBe(true);
    expect(evaluateCondition({ all: [{ field: "empty", op: "is_empty" }] }, answers)).toBe(true);
    expect(evaluateCondition({ all: [{ field: "level", op: "gt", value: 2 }] }, answers)).toBe(true);
    expect(evaluateCondition({ all: [{ field: "level", op: "lt", value: 2 }] }, answers)).toBe(false);
  });

  it("is a flat all-of list — every condition must hold", () => {
    expect(
      evaluateCondition(
        { all: [{ field: "format", op: "eq", value: "workshop" }, { field: "level", op: "gt", value: 5 }] },
        answers,
      ),
    ).toBe(false);
  });

  it("treats an absent rule as always visible", () => {
    expect(evaluateCondition(null, answers)).toBe(true);
    expect(evaluateCondition({ all: [] }, answers)).toBe(true);
  });

  it("hides a conditional field until its trigger is answered", () => {
    const conditional = form([
      {
        ...fullForm.steps[0],
        fields: [
          ...fullForm.steps[0].fields,
          field({
            key: "workshop_prerequisites",
            type: "long_text",
            sort_order: 5,
            visible_when: { all: [{ field: "format", op: "eq", value: "fmt_workshop" }] },
          }),
        ],
      },
    ]);
    const hidden = visibleSteps(conditional, { format: "fmt_talk" })[0].fields.map((f) => f.key);
    const shown = visibleSteps(conditional, { format: "fmt_workshop" })[0].fields.map((f) => f.key);
    expect(hidden).not.toContain("workshop_prerequisites");
    expect(shown).toContain("workshop_prerequisites");
  });

  it("counts only visible required fields toward progress", () => {
    expect(percentComplete(fullForm, {})).toBe(0);
    expect(percentComplete(fullForm, { title: "T", abstract: "A", track: "trk", format: "fmt", speakers: ["per_1"] })).toBe(100);
    expect(percentComplete(fullForm, { title: "T", abstract: "A" })).toBe(40);
  });
});
