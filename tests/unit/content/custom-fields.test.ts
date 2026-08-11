import { describe, expect, it } from "vitest";
import {
  assertDeclaredClassification,
  assertDefinitionShape,
  coerceValue,
  redactCustomValues,
  usageOf,
  type CustomFieldDefinitionView,
} from "@podiumconf/domain/content/custom-fields.js";

const SHIRT_SIZE: CustomFieldDefinitionView = {
  id: "cfd_1",
  key: "shirt-size",
  label: "Shirt size",
  type: "single_select",
  options: [{ value: "m", label: "M" }, { value: "l", label: "L" }],
  is_required: false,
  pii: false,
  audience: "organizer_only",
  show_in_list: true,
  is_filterable: true,
  sort_order: 0,
  status: "active",
};

const PASSPORT: CustomFieldDefinitionView = { ...SHIRT_SIZE, id: "cfd_2", key: "passport-number", label: "Passport number", type: "short_text", pii: true, options: null };

describe("INV-11-11: a CustomFieldDefinition must declare pii and audience at creation", () => {
  it("rejects a definition where pii is entirely omitted — undefined is not a default", () => {
    expect(() => assertDeclaredClassification({ key: "k", label: "L", type: "short_text", pii: undefined, audience: "public" })).toThrowError();
    try {
      assertDeclaredClassification({ key: "k", label: "L", type: "short_text", pii: undefined, audience: "public" });
    } catch (err) {
      expect((err as { invariant?: string }).invariant).toBe("INV-11-11");
    }
  });

  it("rejects a definition with no audience", () => {
    expect(() => assertDeclaredClassification({ key: "k", label: "L", type: "short_text", pii: false, audience: undefined })).toThrowError();
  });

  it("accepts pii: false as a real decision, not an omission", () => {
    expect(assertDeclaredClassification({ key: "k", label: "L", type: "short_text", pii: false, audience: "public" })).toEqual({ pii: false, audience: "public" });
  });

  it("rejects an audience value outside the declared enum", () => {
    expect(() => assertDeclaredClassification({ key: "k", label: "L", type: "short_text", pii: false, audience: "everyone" })).toThrowError();
  });

  it("a select type needs at least one option", () => {
    expect(() => assertDefinitionShape({ key: "size", label: "Size", type: "single_select", pii: false, audience: "public", options: [] })).toThrowError();
  });
});

describe("custom field values — typed coercion and redaction", () => {
  it("coerces a checkbox and a number", () => {
    expect(coerceValue({ ...SHIRT_SIZE, type: "checkbox" }, "on")).toBe(true);
    expect(coerceValue({ ...SHIRT_SIZE, type: "number" }, "42")).toBe(42);
  });

  it("rejects a single_select value outside its declared options", () => {
    expect(() => coerceValue(SHIRT_SIZE, "xl")).toThrowError();
  });

  it("INV-11-11: a pii field's value is redacted like the built-in PII fields, unless include_pii", () => {
    const out = redactCustomValues([PASSPORT], { "passport-number": "AB123456" }, { includePii: false });
    expect(out["passport-number"]).toBe("[redacted]");
    const withPii = redactCustomValues([PASSPORT], { "passport-number": "AB123456" }, { includePii: true });
    expect(withPii["passport-number"]).toBe("AB123456");
  });

  it("INV-11-11: a value whose field is not audience = public never reaches a public surface", () => {
    const out = redactCustomValues([SHIRT_SIZE], { "shirt-size": "m" }, { includePii: true, surface: "public" });
    expect(out["shirt-size"]).toBeUndefined();
  });

  it("computes fill rate and last-used date per definition (R27)", () => {
    const usage = usageOf(SHIRT_SIZE, [
      { values: { "shirt-size": "m" }, updated_at: "2027-01-01T00:00:00.000Z" },
      { values: {}, updated_at: "2027-02-01T00:00:00.000Z" },
      { values: { "shirt-size": "l" }, updated_at: "2027-03-01T00:00:00.000Z" },
    ]);
    expect(usage.filled).toBe(2);
    expect(usage.total).toBe(3);
    expect(usage.fill_rate).toBeCloseTo(2 / 3);
    expect(usage.last_used_at).toBe("2027-03-01T00:00:00.000Z");
  });
});
