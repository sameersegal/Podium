import { describe, expect, it } from "vitest";
import { flattenVariables, renderTemplate } from "@podiumstack/domain/platform/rendering.js";

/**
 * INV-09-13 rejects an *unknown* variable at save time. This covers the other
 * half: a variable that is valid but resolves to nothing, which is the failure
 * "preview resolves against a real recipient" exists to catch (09, "Variables
 * and preview").
 */
describe("template variables", () => {
  it("flattens the nested objects callers naturally build", () => {
    expect(flattenVariables({ session: { title: "A great talk", room: "Main Stage" } })).toEqual({
      "session.title": "A great talk",
      "session.room": "Main Stage",
    });
  });

  it("leaves already-flat dotted keys alone, so both shapes work", () => {
    expect(flattenVariables({ "event.name": "DevFlow", portal_url: "/portal" })).toEqual({
      "event.name": "DevFlow",
      portal_url: "/portal",
    });
  });

  it("renders a nested value rather than emitting an empty string", () => {
    const vars = flattenVariables({ session: { title: "A great talk" } });
    const result = renderTemplate("Your session **{{session.title}}** is confirmed.", vars);
    expect(result.text).toBe("Your session **A great talk** is confirmed.");
    expect(result.empty).toEqual([]);
  });

  it("reports which variables came back empty, so a preview can say so", () => {
    const result = renderTemplate("Hi {{recipient.first_name}}, about {{session.title}}.", {
      "recipient.first_name": "Nora",
    });
    expect(result.empty).toEqual(["session.title"]);
  });
});
