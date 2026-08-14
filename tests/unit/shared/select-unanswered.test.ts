import { describe, expect, it } from "vitest";
import { field } from "@podiumstack/web/ui/layout.js";
import { DECLINE_REASON, RECOMMENDATION } from "@podiumstack/domain/review/types.js";
import { timezoneOptions } from "@podiumstack/domain/shared/time.js";

/**
 * A `select` must be able to express "unanswered".
 *
 * `field()` used to omit the empty first option for exactly the selects that
 * were `required`, which is the opposite of what its own comment described. Two
 * things followed, and both were silent:
 *
 *   - The browser preselects option one, so a form submitted without touching
 *     the control posts a real answer. `RECOMMENDATION[0]` is `strong_accept`
 *     and `DECLINE_REASON[0]` is `conflict_of_interest` — a reviewer who never
 *     opened either dropdown scored a talk top marks, or recorded a permanent
 *     conflict that INV-05-4 uses to bar them from that proposal for good.
 *   - `required` itself became inert. The constraint is "the selected option's
 *     value is not empty", and every option had a value, so the attribute the
 *     branch existed to serve could never fire.
 *
 * The enum orders are asserted here too. They are what makes the defect
 * dangerous rather than merely wrong, so a reordering that quietly made the
 * first member harmless would also make this test stop testing anything.
 */

const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

function render(html: { toString(): string }): string {
  return String(html);
}

describe("a required select can express 'unanswered'", () => {
  it("puts an empty option first, so the browser preselects nothing", () => {
    const html = render(
      field({ name: "recommendation", label: "Overall recommendation", type: "select", required: true, options: opts(RECOMMENDATION) }),
    );
    const firstOption = html.indexOf("<option");
    expect(html.slice(firstOption, firstOption + 60)).toContain('value=""');
    expect(html).toContain("— choose —");
    // Nothing is preselected, so `required` has something to refuse.
    expect(html).not.toContain("selected");
  });

  it("does the same for the decline reason, which writes a permanent record", () => {
    const html = render(field({ name: "reason", label: "Reason", type: "select", required: true, options: opts(DECLINE_REASON) }));
    const firstOption = html.indexOf("<option");
    expect(html.slice(firstOption, firstOption + 60)).toContain('value=""');
    expect(html).not.toContain("selected");
  });

  it("keeps the empty option when the server, not the browser, validates", () => {
    // `validate: false` drops the `required` attribute so a half-filled draft
    // can still be saved. The option must survive that, or the wizard's selects
    // go back to preselecting option one.
    const html = render(
      field({ name: "track", label: "Track", type: "select", required: true, validate: false, options: opts(["ai", "infra"]) }),
    );
    expect(html).toContain('<option value="">');
    expect(html).not.toContain(" required");
  });

  it("still selects a stored value when one exists", () => {
    const html = render(
      field({ name: "recommendation", label: "R", type: "select", required: true, value: "accept", options: opts(RECOMMENDATION) }),
    );
    expect(html).toContain('<option value="accept" selected>');
  });

  it("labels an optional select's empty option differently", () => {
    const html = render(field({ name: "confidence", label: "Confidence", type: "select", options: opts(["low", "high"]) }));
    expect(html).toContain("— none —");
  });

  it("keeps the first enum member consequential, which is why the above matters", () => {
    expect(RECOMMENDATION[0]).toBe("strong_accept");
    expect(DECLINE_REASON[0]).toBe("conflict_of_interest");
  });
});

/**
 * `timezone` decides how every instant on an event is rendered (INV-02-1), and
 * it was a free-text box on all five screens that set one. A typo produced an
 * event whose times were all wrong, with no symptom but a schedule an hour out.
 */
describe("timezone is chosen, not typed", () => {
  const zones = timezoneOptions();

  it("offers the runtime's IANA zones, sorted", () => {
    expect(zones.length).toBeGreaterThan(100);
    const values = zones.map((z) => z.value);
    expect(values).toContain("America/Los_Angeles");
    expect(values).toContain("Europe/Berlin");
    expect(values).toContain("UTC");
    expect([...values].sort()).toEqual(values);
  });

  it("keeps a valid non-canonical zone selectable, so editing never drops it", () => {
    // ICU's canonical list has no `Asia/Calcutta`; a row holding one predates a
    // rename or came from an import, and the form must still be able to show it.
    const withAlias = timezoneOptions("Asia/Calcutta").map((z) => z.value);
    expect(withAlias).toContain("Asia/Calcutta");
    // An invalid one is not smuggled in by the same door.
    expect(timezoneOptions("Europe/Berlín").map((z) => z.value)).not.toContain("Europe/Berlín");
  });

  it("renders underscores as spaces without changing the stored value", () => {
    const la = zones.find((z) => z.value === "America/Los_Angeles");
    expect(la?.label).toBe("America/Los Angeles");
  });

  it("renders as a select carrying every zone", () => {
    const html = render(field({ name: "timezone", label: "Timezone", type: "select", required: true, options: zones, value: "Europe/Berlin" }));
    expect(html).toContain("<select");
    expect(html).toContain('<option value="Europe/Berlin" selected>');
    expect(html).toContain('<option value="">');
  });
});
