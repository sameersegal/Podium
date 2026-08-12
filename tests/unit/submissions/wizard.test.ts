import { describe, expect, it } from "vitest";
import type { FormFieldSpec, FormSpec, FormStepSpec } from "@podiumconf/domain/event-config/types.js";
import { resolveStepKey, wizardSteps } from "@podiumconf/web/contexts/submissions/wizard.js";

/**
 * 04, "one control per FieldType ... a final review-and-submit step listing
 * every answer with an edit link per step" — the wizard's own step list, and
 * the visibility of a conditional field/step under it.
 */

function step(partial: Partial<FormStepSpec> & Pick<FormStepSpec, "key" | "title">): FormStepSpec {
  return {
    id: `stp_${partial.key}`,
    description: null,
    sort_order: 0,
    visible_when: null,
    is_optional: false,
    fields: [],
    ...partial,
  };
}

function field(partial: Partial<FormFieldSpec> & Pick<FormFieldSpec, "key" | "label" | "type">): FormFieldSpec {
  return {
    id: `fld_${partial.key}`,
    step_id: "stp_x",
    help_text: null,
    placeholder: null,
    options: null,
    is_required: false,
    validation: null,
    visible_when: null,
    maps_to: "none",
    audience: "public",
    pii: false,
    identifies_speaker: false,
    sort_order: 0,
    ...partial,
  };
}

const TITLE_FIELD = field({ key: "title", label: "Title", type: "short_text", is_required: true, maps_to: "title" });
const TRAVEL_FIELD = field({ key: "needs_travel_support", label: "Do you need travel support?", type: "checkbox" });
const TRAVEL_DETAIL_FIELD = field({
  key: "travel_details",
  label: "Travel details",
  type: "long_text",
  visible_when: { all: [{ field: "needs_travel_support", op: "eq", value: true }] },
});

function formWithReviewStep(): FormSpec {
  return {
    id: "frm_1",
    cfp_id: "cfp_1",
    version: 1,
    status: "published",
    steps: [
      step({ key: "the-talk", title: "About your talk", sort_order: 0, fields: [TITLE_FIELD, TRAVEL_FIELD, TRAVEL_DETAIL_FIELD] }),
      step({ key: "review-and-submit", title: "Review and submit", sort_order: 1, fields: [] }),
    ],
  };
}

function formWithoutReviewStep(): FormSpec {
  return {
    id: "frm_2",
    cfp_id: "cfp_2",
    version: 1,
    status: "published",
    steps: [step({ key: "the-session", title: "The session", sort_order: 0, fields: [TITLE_FIELD] })],
  };
}

describe("wizardSteps (04, the wizard's own step list)", () => {
  it("treats a form step with no fields as the review screen, rather than appending a second one", () => {
    const steps = wizardSteps(formWithReviewStep(), {});
    expect(steps.map((s) => s.key)).toEqual(["the-talk", "review-and-submit"]);
    expect(steps[1].kind).toBe("review");
    expect(steps[0].kind).toBe("form");
  });

  it("appends a synthetic review step when the form never defines one", () => {
    const steps = wizardSteps(formWithoutReviewStep(), {});
    expect(steps.map((s) => s.key)).toEqual(["the-session", "__review__"]);
    expect(steps[1].kind).toBe("review");
  });

  it("a form with no steps at all still ends in a review screen", () => {
    const steps = wizardSteps({ id: "f", cfp_id: "c", version: 1, status: "published", steps: [] }, {});
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("review");
  });

  it("INV-02-8/visible_when: a step whose condition is false drops out of the wizard entirely", () => {
    const form: FormSpec = {
      id: "frm_3",
      cfp_id: "cfp_3",
      version: 1,
      status: "published",
      steps: [
        step({ key: "a", title: "A", sort_order: 0, fields: [field({ key: "origin_kind", label: "Kind", type: "single_select" })] }),
        step({
          key: "sponsor-only",
          title: "Sponsor details",
          sort_order: 1,
          visible_when: { all: [{ field: "origin_kind", op: "eq", value: "sponsor" }] },
          fields: [field({ key: "sponsor_note", label: "Note", type: "short_text" })],
        }),
      ],
    };
    expect(wizardSteps(form, { origin_kind: "cfp" }).map((s) => s.key)).toEqual(["a", "__review__"]);
    expect(wizardSteps(form, { origin_kind: "sponsor" }).map((s) => s.key)).toEqual(["a", "sponsor-only", "__review__"]);
  });

  it("renders every field of a visible step regardless of the field's own condition, so client-side toggling has something to show and hide", () => {
    const steps = wizardSteps(formWithReviewStep(), { needs_travel_support: false });
    const theTalk = steps.find((s) => s.key === "the-talk")!;
    expect(theTalk.fields.map((f) => f.key)).toEqual(["title", "needs_travel_support", "travel_details"]);
  });
});

describe("resolveStepKey", () => {
  const steps = wizardSteps(formWithReviewStep(), {});

  it("keeps a requested step that exists", () => {
    expect(resolveStepKey(steps, "review-and-submit", null)).toBe("review-and-submit");
  });

  it("falls back to the given fallback when the requested step does not exist (hidden or invalid)", () => {
    expect(resolveStepKey(steps, "no-such-step", "the-talk")).toBe("the-talk");
  });

  it("falls back to the first step when neither the request nor the fallback exist", () => {
    expect(resolveStepKey(steps, "no-such-step", "also-missing")).toBe("the-talk");
  });
});
