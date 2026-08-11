/**
 * The admin reference panels are derived from the published event catalogue,
 * not a second copy of it. These tests are what keeps that true: an event added
 * to `EVENT_TYPES` shows up in the webhook panel with no further work, and a
 * PII reclassification cannot drift out of the UI that advertises it.
 */

import { describe, expect, it } from "vitest";
import { EVENT_TYPES, PII_EVENT_TYPES, eventTypeMatches } from "@podiumconf/domain/events/catalogue.js";
import { COMMON_VARIABLES, DEFAULT_TEMPLATES } from "@podiumconf/domain/platform/templates.js";
import {
  UNCATEGORISED,
  getAllEvents,
  getEventsByCategory,
  getEventsByPattern,
  getTemplateVariableMetadata,
  getUniqueCategories,
} from "../../../workers/api/src/contexts/platform/event-reference.js";

describe("event reference — derived from the catalogue, never restated", () => {
  it("surfaces every published event type, so the panel cannot under-report", () => {
    const surfaced = getAllEvents().map((e) => e.type);
    expect(surfaced).toEqual([...EVENT_TYPES]);
  });

  it("takes PII from PII_EVENT_TYPES rather than a hand-kept copy", () => {
    for (const e of getAllEvents()) {
      expect(e.hasPii, `${e.type} PII flag disagrees with the catalogue`).toBe(PII_EVENT_TYPES.has(e.type));
    }
    // A non-trivial number, so a bug that returns false everywhere still fails.
    expect(getAllEvents().filter((e) => e.hasPii).length).toBe(PII_EVENT_TYPES.size);
  });

  it("categorises every event — a new noun must be mapped, not silently bucketed", () => {
    const orphans = getAllEvents().filter((e) => e.category === UNCATEGORISED).map((e) => e.type);
    expect(orphans, `unmapped nouns — add them to CATEGORY_BY_NOUN: ${orphans.join(", ")}`).toEqual([]);
  });

  it("loses no event when partitioned by category", () => {
    const byCategory = getUniqueCategories().flatMap((c) => getEventsByCategory(c));
    expect(byCategory.length).toBe(EVENT_TYPES.length);
    expect(new Set(byCategory.map((e) => e.type)).size).toBe(EVENT_TYPES.length);
  });
});

describe("event reference — pattern preview matches delivery", () => {
  it("agrees with eventTypeMatches for every pattern/type pair", () => {
    for (const pattern of ["*", "proposal.*", "session.*", "review.*", "decision.published"]) {
      const previewed = new Set(getEventsByPattern(pattern).map((e) => e.type));
      for (const type of EVENT_TYPES) {
        expect(previewed.has(type), `${pattern} vs ${type}`).toBe(eventTypeMatches(pattern, type));
      }
    }
  });

  it("treats a dot as a literal — `proposal.*` never matches a look-alike noun", () => {
    // A regex built with `pattern.replace("*", ".*")` matches `proposalX...`.
    const matched = getEventsByPattern("proposal.*").map((e) => e.type);
    expect(matched.every((t) => t.startsWith("proposal."))).toBe(true);
    expect(matched).toContain("proposal.submitted");
    expect(matched).not.toContain("proposal_speaker.added");
  });

  it("reads the comma-separated form the field actually stores", () => {
    const matched = getEventsByPattern("proposal.accepted, session.created").map((e) => e.type);
    expect(matched.sort()).toEqual(["proposal.accepted", "session.created"]);
  });

  it("shows everything for `*` and for an empty filter", () => {
    expect(getEventsByPattern("*").length).toBe(EVENT_TYPES.length);
    expect(getEventsByPattern("   ").length).toBe(EVENT_TYPES.length);
  });
});

describe("template variable reference — INV-09-13", () => {
  it("offers exactly what a save will accept, for every shipped template", () => {
    for (const spec of DEFAULT_TEMPLATES) {
      const offered = getTemplateVariableMetadata(spec.key).map((v) => v.name).sort();
      const declared = [...COMMON_VARIABLES, ...spec.variables].sort();
      expect(offered, `${spec.key} offers variables the save would reject`).toEqual(declared);
    }
  });

  it("falls back to the common set for an unknown or absent key", () => {
    for (const key of [null, undefined, "", "not.a.template"]) {
      const offered = getTemplateVariableMetadata(key).map((v) => v.name).sort();
      expect(offered).toEqual([...COMMON_VARIABLES].sort());
    }
  });

  it("separates common variables from the ones this template adds", () => {
    const vars = getTemplateVariableMetadata("proposal.accepted");
    expect(vars.filter((v) => v.group === "common").length).toBe(COMMON_VARIABLES.length);
    expect(vars.filter((v) => v.group === "template-specific").map((v) => v.name)).toContain("confirm_url");
  });
});
