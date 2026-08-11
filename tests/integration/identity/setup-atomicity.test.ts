import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setupOrganization } from "@podiumconf/web/contexts/identity/service.js";
import type { Env } from "@podiumconf/data/context.js";

/**
 * Defect 1 — `setupOrganization` used to commit `bootstrap_state`,
 * `organization`, `person`, `auth_identity` and `role_grant` as five separate
 * writes, each landing the instant its own statement ran. A failure after the
 * lock claim but before `grantRole` left a deployment with a claimed lock and
 * no recoverable owner (see the two scenarios in the module comment on
 * `setupOrganization`). This file proves the fix: everything now goes
 * through one `Db.batch()`, so either all five rows land or none do.
 *
 * `organization`, `person` and `auth_identity` are each guarded by an
 * application-level "does this already exist" read before they are ever
 * written (INV-01-1, INV-01-2, and the `slug` dedup loop), which — by
 * design — turns most real unique-constraint collisions into a safe update
 * rather than a raw D1 failure. That leaves no *organically reachable*
 * uniqueness violation, other than `bootstrap_state`'s own primary key
 * (`setup-race.test.ts`), to force a failure partway through the batch with.
 * So this test injects one directly: a `D1Database` wrapper, passed in as
 * this call's `env.DB`, that appends one guaranteed-to-fail statement (an
 * insert into a table that does not exist) to whatever `setupOrganization`
 * asks D1 to batch, then hands the *combined* list to the real `d1.batch()`.
 * The rollback that follows is entirely real D1 behaviour, not a mock —
 * only the presence of a doomed statement is synthetic, standing in for the
 * class of failure this fix exists for (a transient D1 error, an
 * unanticipated constraint, a worker eviction between statements under the
 * old, non-batched code).
 */

function envWithADoomedFinalStatement(base: Env): Env {
  const realDb = base.DB;
  const doomed = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) =>
          target.batch([...statements, target.prepare("INSERT INTO no_such_table_setup_atomicity_test (id) VALUES (1)")]);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...base, DB: doomed };
}

async function counts() {
  const [org, person, auth, grant, lock] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM organization").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM person").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_identity").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM role_grant").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM bootstrap_state").first<{ n: number }>(),
  ]);
  return { org: org?.n ?? 0, person: person?.n ?? 0, auth: auth?.n ?? 0, grant: grant?.n ?? 0, lock: lock?.n ?? 0 };
}

const VALID_INPUT = {
  org_name: "Real Org",
  default_timezone: "UTC",
  contact_email: "hello@example.com",
  owner_full_name: "Ada Owner",
  owner_email: "ada@example.com",
  owner_password: "a-long-enough-password-1",
};

describe("setupOrganization is atomic: a mid-flight failure leaves no partial state", () => {
  it("rolls back the lock claim, the organization and the person when a later statement in the same batch fails, then succeeds on retry", async () => {
    expect(await counts()).toEqual({ org: 0, person: 0, auth: 0, grant: 0, lock: 0 });

    let thrown: unknown;
    try {
      await setupOrganization(envWithADoomedFinalStatement(env), VALID_INPUT);
    } catch (err) {
      thrown = err;
    }

    // The failure is real and un-relabelled: not INV-01-16 "already set up"
    // (defect 2) — the bootstrap lock was never actually claimed, because
    // the batch that tried to claim it never committed.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { invariant?: string } | undefined)?.invariant).not.toBe("INV-01-16");
    expect((thrown as Error).message).toContain("no such table");

    // Nothing this attempt touched is left behind: no orphan lock row, no
    // organization, no owner Person, no credential, no grant.
    expect(await counts()).toEqual({ org: 0, person: 0, auth: 0, grant: 0, lock: 0 });

    // A retry with the real (unwrapped) binding succeeds outright — the lock
    // was never claimed, so there is nothing for an operator to recover by
    // hand.
    const result = await setupOrganization(env, VALID_INPUT);
    expect(result.organization_id).toBeTruthy();
    expect(result.person_id).toBeTruthy();

    expect(await counts()).toEqual({ org: 1, person: 1, auth: 1, grant: 1, lock: 1 });

    const grant = await env.DB.prepare("SELECT * FROM role_grant WHERE person_id = ?")
      .bind(result.person_id)
      .first<{ role: string; scope_id: string }>();
    expect(grant?.role).toBe("owner");
    expect(grant?.scope_id).toBe(result.organization_id);

    const identity = await env.DB.prepare("SELECT * FROM auth_identity WHERE person_id = ?")
      .bind(result.person_id)
      .first<{ credential_hash: string }>();
    expect(identity?.credential_hash).toBeTruthy();
  });
});
