import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setupOrganization } from "@podiumstack/web/contexts/identity/service.js";

/**
 * Defect 2 — the `try/catch` around claiming `bootstrap_state` used to catch
 * *every* error and report `INV-01-16` ("already been set up"). If migration
 * `0005_bootstrap.sql` had not been applied, the real error is `no such
 * table: bootstrap_state`, and an operator deploying for the first time was
 * told setup was already complete, with no organization anywhere — the one
 * scenario where that message is actively misleading.
 *
 * `isBootstrapLockConflict` (service.ts) narrows the catch to the exact
 * message D1 gives for a primary-key collision on `bootstrap_state.id`:
 * `D1_ERROR: UNIQUE constraint failed: bootstrap_state.id: SQLITE_CONSTRAINT
 * (extended: SQLITE_CONSTRAINT_PRIMARYKEY)` — confirmed against the real
 * binding (not assumed), and pinned here and in `setup-race.test.ts`. This
 * file proves the other half: a missing table propagates as itself.
 */
describe("INV-01-16's catch is narrow: only a real bootstrap_state PK conflict is reported as 'already set up'", () => {
  it("a missing bootstrap_state table (an unapplied migration) surfaces as its own error, not INV-01-16", async () => {
    await env.DB.exec("DROP TABLE bootstrap_state");

    let thrown: unknown;
    try {
      await setupOrganization(env, {
        org_name: "AI Engineer",
        default_timezone: "UTC",
        contact_email: "hello@example.com",
        postal_address: "1 Test Way, Testville, CA 94000",
        owner_full_name: "Ada Owner",
        owner_email: "ada@example.com",
        owner_password: "a-long-enough-password-1",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { invariant?: string } | undefined)?.invariant).not.toBe("INV-01-16");
    expect((thrown as { code?: string } | undefined)?.code).not.toBe("organization_already_exists");
    expect((thrown as Error).message).toContain("no such table: bootstrap_state");

    // And nothing this doomed attempt touched was left behind either.
    const org = await env.DB.prepare("SELECT COUNT(*) AS n FROM organization").first<{ n: number }>();
    expect(org?.n ?? 0).toBe(0);
  });
});
