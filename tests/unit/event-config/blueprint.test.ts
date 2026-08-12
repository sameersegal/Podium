import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  blueprintDays,
  calendarDaysBetween,
  MAX_BLUEPRINT_DAYS,
  rebaseInstant,
  starterCfpWindow,
  STARTER_BLUEPRINT,
} from "@podiumstack/domain/event-config/blueprint.js";
import { cfpWindowProblems, DEFAULT_FORM_TEMPLATE, formSpecAsTemplate, publishBlockers } from "@podiumstack/domain/event-config/rules.js";
import type { FormSpec } from "@podiumstack/domain/event-config/types.js";

/**
 * 02 — "Starting an event: the starter blueprint and cloning". The pure half:
 * the day generation an event's range produces, the date rebasing a clone is
 * shifted by (INV-02-16), and the shipped starter data itself.
 */

describe("blueprintDays", () => {
  it("writes one day per date across the event's own range", () => {
    const days = blueprintDays("2027-05-12", "2027-05-14");
    expect(days.map((d) => d.date)).toEqual(["2027-05-12", "2027-05-13", "2027-05-14"]);
    expect(days.map((d) => d.label)).toEqual(["Day 1", "Day 2", "Day 3"]);
    expect(days.map((d) => d.sort_order)).toEqual([0, 1, 2]);
  });

  it("carries a clone's labels across positionally", () => {
    const days = blueprintDays("2028-05-10", "2028-05-12", ["Day 1 — Workshops", null]);
    expect(days.map((d) => d.label)).toEqual(["Day 1 — Workshops", "Day 2", "Day 3"]);
  });

  it("counts a one-day event as one day, and an inverted range as none", () => {
    expect(blueprintDays("2027-05-12", "2027-05-12")).toHaveLength(1);
    expect(blueprintDays("2027-05-14", "2027-05-12")).toEqual([]);
  });

  it("caps a range so a typo in the end date cannot write four hundred rows", () => {
    expect(blueprintDays("2027-01-01", "2029-01-01")).toHaveLength(MAX_BLUEPRINT_DAYS);
  });

  it("crosses a month and a year boundary by date, not by arithmetic on the day number", () => {
    expect(blueprintDays("2027-12-30", "2028-01-02").map((d) => d.date)).toEqual([
      "2027-12-30",
      "2027-12-31",
      "2028-01-01",
      "2028-01-02",
    ]);
  });
});

describe("calendar arithmetic", () => {
  it("counts whole days in both directions, including across a leap day", () => {
    expect(calendarDaysBetween("2027-05-12", "2028-05-10")).toBe(364);
    expect(calendarDaysBetween("2028-05-10", "2027-05-12")).toBe(-364);
    expect(calendarDaysBetween("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
  });

  it("adds days without a timezone getting involved", () => {
    expect(addCalendarDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addCalendarDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

/**
 * INV-02-16 — every copied instant is shifted by the whole number of days
 * between the two events' `starts_on`, preserving its wall-clock time in the
 * event timezone.
 */
describe("INV-02-16 rebasing", () => {
  it("keeps the wall-clock time an organizer wrote", () => {
    // 23:59 on 1 March in Los Angeles.
    const closesAt = "2027-03-02T07:59:00.000Z";
    const moved = rebaseInstant(closesAt, "America/Los_Angeles", 364);
    expect(moved).toBe("2028-02-29T07:59:00.000Z"); // 23:59 on 29 February, still PST
  });

  it("keeps the wall-clock time across a daylight-saving boundary, which raw millisecond arithmetic does not", () => {
    // 17:00 on 10 January in London (UTC+0) shifted 180 days lands in BST.
    const before = "2027-01-10T17:00:00.000Z";
    const moved = rebaseInstant(before, "Europe/London", 180);
    expect(moved).toBe("2027-07-09T16:00:00.000Z"); // still 17:00 local, now UTC+1
    expect(moved).not.toBe(new Date(Date.parse(before) + 180 * 86_400_000).toISOString());
  });

  it("is the identity when the two events start on the same day of the year", () => {
    const instant = "2027-06-01T12:30:45.000Z";
    expect(rebaseInstant(instant, "UTC", 0)).toBe(instant);
  });

  it("keeps a rebased window valid under INV-02-4", () => {
    const opens = rebaseInstant("2027-01-01T09:00:00.000Z", "UTC", 364);
    const closes = rebaseInstant("2027-03-01T23:59:00.000Z", "UTC", 364);
    expect(cfpWindowProblems({ opens_at: opens, closes_at: closes })).toEqual([]);
  });
});

describe("the starter CFP window", () => {
  const timezone = "America/Los_Angeles";

  it("closes the configured lead time before the doors open", () => {
    const window = starterCfpWindow({ now: "2027-01-05T18:00:00.000Z", starts_on: "2027-11-01", timezone });
    expect(window.closes_at).toBe("2027-08-04T06:59:00.000Z"); // 23:59 on 3 August, 90 days out
    expect(cfpWindowProblems(window)).toEqual([]);
  });

  it("still opens a usable window when the event is already close", () => {
    const window = starterCfpWindow({ now: "2027-10-20T18:00:00.000Z", starts_on: "2027-11-01", timezone });
    expect(cfpWindowProblems(window)).toEqual([]);
    // The floor, not a deadline in the past: 21 days from today.
    expect(window.closes_at > window.opens_at).toBe(true);
    expect(window.closes_at.slice(0, 10)).toBe("2027-11-11");
  });

  it("never produces a closing time before its opening one, even for an event that has started", () => {
    const window = starterCfpWindow({ now: "2027-11-02T18:00:00.000Z", starts_on: "2027-11-01", timezone });
    expect(cfpWindowProblems(window)).toEqual([]);
  });
});

describe("the shipped starter data", () => {
  it("offers exactly one track, because a track is the thing the platform cannot guess", () => {
    expect(STARTER_BLUEPRINT.track.name).toBe("General");
  });

  it("gives every format a duration that brackets, and at least one eligible origin (INV-02-2)", () => {
    for (const f of STARTER_BLUEPRINT.formats) {
      expect(f.eligible_origins.length).toBeGreaterThan(0);
      expect(f.default_duration_minutes).toBeGreaterThan(0);
      if (f.min_duration_minutes != null) expect(f.min_duration_minutes).toBeLessThanOrEqual(f.default_duration_minutes);
      if (f.max_duration_minutes != null) expect(f.max_duration_minutes).toBeGreaterThanOrEqual(f.default_duration_minutes);
    }
  });

  it("offers a format for every origin, so nothing in the model is unreachable", () => {
    const origins = new Set(STARTER_BLUEPRINT.formats.flatMap((f) => f.eligible_origins));
    expect([...origins].sort()).toEqual(["cfp", "invited", "sponsor"]);
  });

  it("keeps format slugs unique, since a slug is unique per event", () => {
    const slugs = STARTER_BLUEPRINT.formats.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

/**
 * A clone's form is the source's form: a template that could not carry a
 * conditional field or a validation rule would silently flatten one.
 */
describe("formSpecAsTemplate", () => {
  const spec: FormSpec = {
    id: "frm_1",
    cfp_id: "cfp_1",
    version: 1,
    status: "published",
    steps: [
      {
        id: "stp_2",
        key: "logistics",
        title: "Logistics",
        description: null,
        sort_order: 1,
        is_optional: true,
        visible_when: { all: [{ field: "title", op: "is_set" }] },
        fields: [
          {
            id: "fld_2",
            step_id: "stp_2",
            key: "travel",
            label: "Travel support",
            type: "long_text",
            is_required: false,
            validation: { max_length: 400 },
            visible_when: { all: [{ field: "needs_travel", op: "eq", value: true }] },
            maps_to: "none",
            audience: "organizer_only",
            pii: true,
            sort_order: 0,
          },
        ],
      },
      {
        id: "stp_1",
        key: "the-talk",
        title: "The talk",
        description: null,
        sort_order: 0,
        is_optional: false,
        fields: [
          {
            id: "fld_1",
            step_id: "stp_1",
            key: "title",
            label: "Title",
            type: "short_text",
            is_required: true,
            maps_to: "title",
            audience: "public",
            pii: false,
            sort_order: 0,
          },
        ],
      },
    ],
  } as FormSpec;

  it("returns steps in sort order, whatever order they were read in", () => {
    expect(formSpecAsTemplate(spec).map((s) => s.key)).toEqual(["the-talk", "logistics"]);
  });

  it("carries conditions, validation, audience and the PII flag across the copy", () => {
    const logistics = formSpecAsTemplate(spec)[1];
    expect(logistics.visible_when).toEqual({ all: [{ field: "title", op: "is_set" }] });
    expect(logistics.is_optional).toBe(true);
    const travel = logistics.fields[0];
    expect(travel.validation).toEqual({ max_length: 400 });
    expect(travel.visible_when).toEqual({ all: [{ field: "needs_travel", op: "eq", value: true }] });
    expect(travel.audience).toBe("organizer_only");
    expect(travel.pii).toBe(true);
  });

  it("round-trips the shipped default form, which is what makes a cloned call publishable", () => {
    const asSpec = templateAsSpec(DEFAULT_FORM_TEMPLATE);
    expect(publishBlockers(asSpec)).toEqual([]);
    const roundTripped = templateAsSpec(formSpecAsTemplate(asSpec));
    expect(publishBlockers(roundTripped)).toEqual([]);
    expect(formSpecAsTemplate(roundTripped)).toEqual(formSpecAsTemplate(asSpec));
  });
});

/** The inverse of `formSpecAsTemplate`, for the round-trip check above. */
function templateAsSpec(template: ReturnType<typeof formSpecAsTemplate>): FormSpec {
  return {
    id: "frm_rt",
    cfp_id: "cfp_rt",
    version: 1,
    status: "published",
    steps: template.map((step, si) => ({
      id: `stp_${si}`,
      key: step.key,
      title: step.title,
      description: step.description ?? null,
      sort_order: si,
      is_optional: step.is_optional,
      visible_when: step.visible_when ?? null,
      fields: step.fields.map((f, fi) => ({
        id: `fld_${si}_${fi}`,
        step_id: `stp_${si}`,
        key: f.key,
        label: f.label,
        help_text: f.help_text ?? null,
        placeholder: f.placeholder ?? null,
        type: f.type,
        options: f.options ?? null,
        is_required: f.is_required,
        validation: f.validation ?? null,
        visible_when: f.visible_when ?? null,
        maps_to: f.maps_to,
        audience: f.audience,
        pii: f.pii,
        sort_order: fi,
      })),
    })),
  } as FormSpec;
}
