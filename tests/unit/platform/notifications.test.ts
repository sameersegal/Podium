import { describe, expect, it } from "vitest";
import { assertTemplateBody, validateTemplateBody, extractVariables } from "@podiumconf/domain/platform/rendering.js";
import { declaredVariables, isTransactionalTemplate } from "@podiumconf/domain/platform/templates.js";
import { decideSuppression } from "@podiumconf/domain/platform/suppression.js";

describe("template variable validation (INV-09-13)", () => {
  it("INV-09-13: rejects a body referencing a variable outside the template_key's declared set at save time", () => {
    expect(() => assertTemplateBody("proposal.accepted", null, "Hi {{talk_title}}")).toThrowError();
    try {
      assertTemplateBody("proposal.accepted", null, "Hi {{talk_title}}");
    } catch (err) {
      const e = err as { invariant?: string; details?: { unknown: string[] } };
      expect(e.invariant).toBe("INV-09-13");
      expect(e.details?.unknown).toContain("talk_title");
    }
  });

  it("INV-09-13: accepts a body using only declared variables, common plus the template's own", () => {
    expect(() => assertTemplateBody("proposal.accepted", "Accepted!", "Hi {{recipient.first_name}}, see {{confirm_url}}")).not.toThrow();
  });

  it("declares the common set for every key, plus the key's own", () => {
    const declared = declaredVariables("proposal.accepted");
    expect(declared).toContain("recipient.first_name"); // common
    expect(declared).toContain("confirm_url"); // proposal.accepted-specific
    expect(declared).not.toContain("task.due_at"); // belongs to a different key
  });

  it("a composed campaign (no template_key) validates against the generic campaign variable set", () => {
    const result = validateTemplateBody(null, null, "Hi {{recipient.first_name}}, room is now {{session.room}}");
    expect(result.ok).toBe(true);
  });

  it("extracts every {{variable}} used in a body, deduplicated", () => {
    expect(extractVariables("{{a}} and {{b}} and {{a}} again")).toEqual(["a", "b"]);
  });

  it("proposal.accepted and task.reminder are both transactional (INV-09-10 exemption applies)", () => {
    expect(isTransactionalTemplate("proposal.accepted")).toBe(true);
    expect(isTransactionalTemplate("task.reminder")).toBe(true);
  });
});

describe("suppression with the transactional exemption (INV-09-10)", () => {
  it("INV-09-10: a transactional message about the recipient's own proposal is never suppressed by an unsubscribe", () => {
    const decision = decideSuppression(
      [{ email: "speaker@example.com", category: "all", reason: "unsubscribe" }],
      { email: "speaker@example.com", category: "proposal", transactional: true },
    );
    expect(decision.suppressed).toBe(false);
  });

  it("a marketing campaign (transactional: false) is suppressed by the same unsubscribe", () => {
    const decision = decideSuppression(
      [{ email: "speaker@example.com", category: "all", reason: "unsubscribe" }],
      { email: "speaker@example.com", category: "campaign", transactional: false },
    );
    expect(decision).toMatchObject({ suppressed: true, reason: "unsubscribed" });
  });

  it("a hard bounce suppresses every message, transactional or not — undeliverable is undeliverable", () => {
    const entries = [{ email: "bounced@example.com", category: "all", reason: "hard_bounce" }];
    expect(decideSuppression(entries, { email: "bounced@example.com", category: "proposal", transactional: true })).toMatchObject({
      suppressed: true,
      reason: "hard_bounced",
    });
  });

  it("a complaint suppresses every message the same way a hard bounce does", () => {
    const entries = [{ email: "complained@example.com", category: "all", reason: "complaint" }];
    expect(decideSuppression(entries, { email: "complained@example.com", category: "campaign", transactional: false })).toMatchObject({
      suppressed: true,
      reason: "complained",
    });
  });

  it("an unsubscribe from one category does not suppress a message in a different category", () => {
    const entries = [{ email: "picky@example.com", category: "task", reason: "unsubscribe" }];
    const decision = decideSuppression(entries, { email: "picky@example.com", category: "campaign", transactional: false });
    expect(decision.suppressed).toBe(false);
  });

  it("an empty or malformed email is always suppressed — there is nowhere to send it", () => {
    expect(decideSuppression([], { email: "", category: "campaign", transactional: false }).suppressed).toBe(true);
  });
});
