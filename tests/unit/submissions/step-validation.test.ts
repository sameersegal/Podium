import { describe, expect, it } from "vitest";
import type { FormFieldSpec, FormSpec, FormStepSpec } from "@podiumconf/domain/event-config/types.js";
import { validateStep } from "@podiumconf/domain/submissions/validation.js";

/**
 * 04, "Submission-time validation" rule 2, applied a step at a time — what
 * "Save and continue" enforces. "Save draft" runs none of it: a draft may be
 * as empty as a title, which is the whole point of a draft.
 */

function step(partial: Partial<FormStepSpec> & Pick<FormStepSpec, "key" | "title">): FormStepSpec {
  return { id: `stp_${partial.key}`, description: null, sort_order: 0, visible_when: null, is_optional: false, fields: [], ...partial };
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

const FORM: FormSpec = {
  id: "frm_1",
  cfp_id: "cfp_1",
  version: 1,
  status: "published",
  steps: [
    step({
      key: "the-talk",
      title: "About your talk",
      fields: [
        field({ key: "title", label: "Session title", type: "short_text", is_required: true, maps_to: "title" }),
        field({ key: "abstract", label: "Abstract", type: "long_text", is_required: true, maps_to: "abstract" }),
        field({ key: "notes", label: "Notes for the committee", type: "long_text" }),
        field({
          key: "workshop_prereqs",
          label: "Workshop prerequisites",
          type: "long_text",
          is_required: true,
          visible_when: { all: [{ field: "format", op: "eq", value: "fmt_workshop" }] },
        }),
      ],
    }),
    step({ key: "logistics", title: "Logistics", fields: [field({ key: "consent", label: "Recording consent", type: "consent", is_required: true })] }),
  ],
};

describe("validateStep (04, rule 2 scoped to one step)", () => {
  it("names every required answer the step is still missing, and only that step's", () => {
    const errors = validateStep(FORM, { format: "fmt_talk" }, "the-talk");
    expect(errors.map((e) => e.field_key)).toEqual(["title", "abstract"]);
    expect(errors[0].message).toBe("Session title is required.");
    expect(errors.every((e) => e.step_key === "the-talk")).toBe(true);
  });

  it("passes once the required answers are present", () => {
    expect(validateStep(FORM, { title: "Taming 40-Minute CI", abstract: "How we cut it to six.", format: "fmt_talk" }, "the-talk")).toEqual([]);
  });

  it("ignores a required field its own condition is hiding — it is not being asked", () => {
    const errors = validateStep(FORM, { title: "t", abstract: "a", format: "fmt_talk" }, "the-talk");
    expect(errors).toEqual([]);
  });

  it("enforces a conditional required field once its trigger selects it", () => {
    const errors = validateStep(FORM, { title: "t", abstract: "a", format: "fmt_workshop" }, "the-talk");
    expect(errors.map((e) => e.field_key)).toEqual(["workshop_prereqs"]);
  });

  it("never asks for a speaker_list answer — the roster is managed by its own controls", () => {
    const form: FormSpec = {
      ...FORM,
      steps: [step({ key: "you", title: "About you", fields: [field({ key: "speakers", label: "Speakers", type: "speaker_list", is_required: true })] })],
    };
    expect(validateStep(form, {}, "you")).toEqual([]);
  });

  it("returns nothing for a step that is not visible, or does not exist", () => {
    expect(validateStep(FORM, {}, "no-such-step")).toEqual([]);
  });
});
