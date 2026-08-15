import { describe, expect, it } from "vitest";
import type { Env } from "@podiumstack/data/context.js";
import { assertTemplateBody, validateTemplateBody, extractVariables } from "@podiumstack/domain/platform/rendering.js";
import {
  DEFAULT_TEMPLATES,
  declaredVariables,
  invitationAudience,
  isTransactionalTemplate,
  templateAudience,
} from "@podiumstack/domain/platform/templates.js";
import { decideSuppression } from "@podiumstack/domain/platform/suppression.js";
import {
  isTransactionalDelivery,
  oneClickUnsubscribeHeaders,
  unsubscribeUrl,
  verifyUnsubscribeSignature,
} from "@podiumstack/web/contexts/platform/notifications.js";

function fakeEnv(overrides: Partial<Env> & { ENVIRONMENT: string }): Env {
  // A reserved example domain, not the real deployment's. Nothing here asserts
  // on the host, and a fixture that names a real hostname teaches the next
  // reader that the app knows where it is served — it does not.
  return { PUBLIC_BASE_URL: "https://podium.example", ...overrides } as unknown as Env;
}

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

describe("template audience — 09, 'Conference-first rendering and audience'", () => {
  it("every default template declares an audience", () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(["organizers", "reviewers", "speakers", "sponsors"]).toContain(t.audience);
    }
  });

  it("classifies proposal, task, schedule and confirmation keys as speakers", () => {
    for (const key of ["proposal.submitted", "proposal.accepted", "proposal.rejected", "proposal.waitlisted", "proposal.changes_requested", "task.assigned", "task.reminder", "schedule.changed", "speaker.confirmation_request"]) {
      expect(templateAudience(key)).toBe("speakers");
    }
  });

  it("classifies review.assignment and review.reminder as reviewers", () => {
    expect(templateAudience("review.assignment")).toBe("reviewers");
    expect(templateAudience("review.reminder")).toBe("reviewers");
  });

  it("classifies entitlement.expiring_soon as sponsors", () => {
    expect(templateAudience("entitlement.expiring_soon")).toBe("sponsors");
  });

  it("defaults invitation.sent to the organizing team's own label", () => {
    expect(templateAudience("invitation.sent")).toBe("organizers");
  });

  it("falls back to speakers for a one-off campaign (no template_key) or an unrecognised custom key", () => {
    expect(templateAudience(null)).toBe("speakers");
    expect(templateAudience("a_custom_key")).toBe("speakers");
  });

  it("addresses an invitation as what its kind actually is, not by its default", () => {
    expect(invitationAudience("reviewer")).toBe("reviewers");
    expect(invitationAudience("sponsor_contact")).toBe("sponsors");
    expect(invitationAudience("co_speaker")).toBe("speakers");
    expect(invitationAudience("speaker_portal")).toBe("speakers");
    expect(invitationAudience("staff")).toBe("organizers");
    expect(invitationAudience(null)).toBe("organizers");
  });
});

describe("isTransactionalDelivery — the one determination suppression and the footer's unsubscribe link both read (INV-09-10)", () => {
  it("a system-triggered send of a transactional key is transactional", () => {
    expect(isTransactionalDelivery({ campaign_id: null, template_key: "proposal.accepted" })).toBe(true);
  });

  it("a system-triggered send of a non-transactional key is not transactional", () => {
    expect(isTransactionalDelivery({ campaign_id: null, template_key: null })).toBe(false);
  });

  it("INV-09-10: a campaign_id forces non-transactional, even when composed from a transactional template's key", () => {
    // 09, "Campaigns": "A campaign is not a decision notification, and
    // INV-09-10's exemption is deliberately not extended to it" — even when
    // the campaign was composed from `proposal.accepted`'s own wording.
    expect(isTransactionalDelivery({ campaign_id: "cmp_1", template_key: "proposal.accepted" })).toBe(false);
  });

  it("a campaign with no template_key at all (a one-off composed message) is also not transactional", () => {
    expect(isTransactionalDelivery({ campaign_id: "cmp_1", template_key: null })).toBe(false);
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

describe("the unsubscribe link signing key (INV-09-15)", () => {
  it("INV-09-15: fails closed in production when UNSUBSCRIBE_SECRET is not configured", async () => {
    const env = fakeEnv({ ENVIRONMENT: "production" });
    await expect(unsubscribeUrl(env, "speaker@example.com", "campaign")).rejects.toMatchObject({
      invariant: "INV-09-15",
      status: 500,
    });
    await expect(verifyUnsubscribeSignature(env, "speaker@example.com", "campaign", "anything")).rejects.toMatchObject({
      invariant: "INV-09-15",
    });
  });

  it("INV-09-15: a production deployment with UNSUBSCRIBE_SECRET set signs and verifies correctly", async () => {
    const env = fakeEnv({ ENVIRONMENT: "production", UNSUBSCRIBE_SECRET: "a-real-deployment-secret" });
    const url = await unsubscribeUrl(env, "speaker@example.com", "campaign");
    const sig = new URL(url).searchParams.get("sig")!;
    expect(await verifyUnsubscribeSignature(env, "speaker@example.com", "campaign", sig)).toBe(true);
  });

  it("INV-09-15: the previous defect — signing with the public ENVIRONMENT string itself — no longer verifies", async () => {
    // This is exactly what made every production unsubscribe link forgeable:
    // the HMAC key was `env.ENVIRONMENT`, i.e. the literal, publicly-known
    // string "production". A signature built that way must not verify against
    // the fixed implementation.
    const env = fakeEnv({ ENVIRONMENT: "production", UNSUBSCRIBE_SECRET: "a-real-deployment-secret" });
    const { hmacSha256Hex } = await import("@podiumstack/domain/identity/credentials.js");
    const forgedSig = await hmacSha256Hex("production", "speaker@example.com.campaign");
    expect(await verifyUnsubscribeSignature(env, "speaker@example.com", "campaign", forgedSig)).toBe(false);
  });

  it("dev and test deployments work with no secret configured at all", async () => {
    for (const environment of ["development", "test", ""]) {
      const env = fakeEnv({ ENVIRONMENT: environment });
      const url = await unsubscribeUrl(env, "speaker@example.com", "campaign");
      const sig = new URL(url).searchParams.get("sig")!;
      expect(await verifyUnsubscribeSignature(env, "speaker@example.com", "campaign", sig)).toBe(true);
    }
  });

  it("two different UNSUBSCRIBE_SECRET values produce different signatures for the same link", async () => {
    const a = await unsubscribeUrl(fakeEnv({ ENVIRONMENT: "production", UNSUBSCRIBE_SECRET: "secret-a" }), "x@example.com", "campaign");
    const b = await unsubscribeUrl(fakeEnv({ ENVIRONMENT: "production", UNSUBSCRIBE_SECRET: "secret-b" }), "x@example.com", "campaign");
    expect(new URL(a).searchParams.get("sig")).not.toBe(new URL(b).searchParams.get("sig"));
  });
});

describe("RFC 8058 one-click unsubscribe headers", () => {
  it("mints List-Unsubscribe (angle-bracketed) and List-Unsubscribe-Post, signed with the same key as the footer link", async () => {
    const env = fakeEnv({ ENVIRONMENT: "test" });
    const headers = await oneClickUnsubscribeHeaders(env, "speaker@example.com", "campaign");
    expect(Object.keys(headers).sort()).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post"]);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toMatch(/^<https?:\/\/.*\/unsubscribe\?.*>$/);

    const url = new URL(headers["List-Unsubscribe"].slice(1, -1));
    expect(url.searchParams.get("email")).toBe("speaker@example.com");
    expect(url.searchParams.get("category")).toBe("campaign");
    const sig = url.searchParams.get("sig")!;
    expect(await verifyUnsubscribeSignature(env, "speaker@example.com", "campaign", sig)).toBe(true);
  });

  it("never mints a mailto: form — RFC 8058's one-click contract requires the https link", async () => {
    const headers = await oneClickUnsubscribeHeaders(fakeEnv({ ENVIRONMENT: "test" }), "speaker@example.com", "campaign");
    expect(headers["List-Unsubscribe"]).not.toContain("mailto:");
  });
});
