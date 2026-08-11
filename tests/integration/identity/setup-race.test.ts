import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setupOrganization } from "@podiumconf/web/contexts/identity/service.js";

/**
 * INV-01-16 — the actual backstop. The route's "refuse once `ctx.orgId` is
 * set" check and `setupOrganization`'s first write are not the same
 * statement, so two requests that both observe "no organization yet" and
 * both proceed must still not both succeed. `bootstrap_state`'s single-row
 * primary key is what makes that true regardless of how the two calls
 * interleave — this drives `setupOrganization` directly, twice, concurrently,
 * against a database this file's isolated storage guarantees starts with
 * zero `organization` rows.
 */

async function orgCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM organization").first<{ n: number }>();
  return row?.n ?? 0;
}

async function bootstrapClaims(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bootstrap_state").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("INV-01-16: bootstrap_state serialises two genuinely concurrent first-run attempts", () => {
  it("of two setupOrganization calls racing on an empty deployment, exactly one succeeds", async () => {
    expect(await orgCount()).toBe(0);

    const attempt = (email: string) =>
      setupOrganization(env, {
        org_name: "Race Org",
        default_timezone: "UTC",
        contact_email: "race@example.com",
        owner_full_name: "Racer",
        owner_email: email,
        owner_password: "a-long-enough-password-2",
      });

    const results = await Promise.allSettled([attempt("racer-a@example.com"), attempt("racer-b@example.com")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string; invariant?: string };
    expect(reason.code).toBe("organization_already_exists");
    expect(reason.invariant).toBe("INV-01-16");

    expect(await orgCount()).toBe(1);
    expect(await bootstrapClaims()).toBe(1);
  });
});
