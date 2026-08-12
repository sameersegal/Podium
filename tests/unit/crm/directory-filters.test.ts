import { describe, expect, it } from "vitest";
import { criteriaIsEmpty, describeCriteria, normaliseCriteria } from "@podiumstack/domain/crm/index.js";
import { directoryFiltersFrom, directoryLink } from "@podiumstack/web/contexts/crm/views.js";

/**
 * 14-speaker-crm.md, "The directory" — "Filters compose with AND ... rebuilding
 * them slightly differently is how somebody gets emailed twice and somebody
 * else not at all." `normaliseCriteria` is the one place composition happens;
 * every surface (the directory form, a saved segment, this test) goes through it.
 */

describe("the directory's filter composition (14, The directory)", () => {
  it("keeps only the criteria keys the model knows, dropping empty ones", () => {
    const c = normaliseCriteria({ company: "Vela", job_title: "", tag: undefined, made_up_key: "x", q: "  ai infra  " });
    expect(c).toEqual({ company: "Vela", q: "ai infra" });
  });

  it("round-trips a query string built from the same criteria a segment stores", () => {
    const c = normaliseCriteria({ tag: "speaker", spoken: "yes" });
    const url = new URL(directoryLink(c), "http://localhost");
    const parsed = directoryFiltersFrom(url);
    expect(parsed).toEqual({ tag: "speaker", spoken: "yes" });
  });

  it("an empty criteria set is the whole directory, not a filter", () => {
    expect(criteriaIsEmpty({})).toBe(true);
    expect(criteriaIsEmpty({ company: "Vela" })).toBe(false);
  });

  it("describes a composed filter in one sentence, so a segment's name is not the only clue", () => {
    const description = describeCriteria({ company: "Vela", spoken: "yes" });
    expect(description).toContain("Vela");
    expect(description).toContain("spoken");
  });
});
