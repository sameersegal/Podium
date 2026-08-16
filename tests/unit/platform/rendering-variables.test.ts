import { describe, expect, it } from "vitest";
import { flattenVariables, renderTemplate, toPlainText } from "@podiumstack/domain/platform/rendering.js";
import { DEFAULT_TEMPLATES } from "@podiumstack/domain/platform/templates.js";

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

/**
 * The default templates now put a lone action-labeled markdown link where the
 * HTML render promotes it to a CTA button — "[Confirm your slot]({{confirm_url}})"
 * rather than a bare `{{confirm_url}}` — so the button carries an action label,
 * not the raw URL. The plain-text half must not lose the URL in the bargain:
 * `toPlainText`'s link rule renders "label (url)", which is what every
 * plain-text mail reader and spam filter actually needs to see.
 */
describe("the plain-text half keeps the real URL behind a labeled link", () => {
  it("renders a markdown link as 'label (url)'", () => {
    expect(toPlainText("[Confirm your slot](https://example.com/confirm)")).toBe("Confirm your slot (https://example.com/confirm)");
  });

  it("every default template with a call-to-action carries an action label, and the plain-text render keeps the real URL behind it", () => {
    const ctaLink = /\[([^\]]+)\]\(\{\{([a-z_.]*url)\}\}\)/;
    const withCta = DEFAULT_TEMPLATES.filter((t) => ctaLink.test(t.body_markdown));
    expect(withCta.length).toBeGreaterThan(0); // the fixture itself must exercise this
    for (const t of withCta) {
      const [, label, urlVar] = ctaLink.exec(t.body_markdown)!;
      // The label is an action, not the raw token or a bare URL.
      expect(label).not.toMatch(/^https?:\/\//);
      expect(label).not.toBe(`{{${urlVar}}}`);
      const rendered = renderTemplate(t.body_markdown, { [urlVar]: "https://example.com/action" });
      const plain = toPlainText(rendered.text);
      expect(plain).toContain(`${label} (https://example.com/action)`);
    }
  });
});
