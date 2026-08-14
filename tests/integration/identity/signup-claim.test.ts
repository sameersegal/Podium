import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * INV-01-19 — sign-up creates an account; it never adopts one.
 *
 * `POST /signup` used to look up the person by email, check only whether a
 * `password` `AuthIdentity` existed, and — finding none — set the request's
 * password on that account and sign the requester in. A `Person` with no
 * password is the ordinary state of everyone the organization has named but not
 * yet heard from: placeholder co-speakers, invited reviewers, imported
 * contacts. Several of them hold role grants. So knowing an address was enough
 * to take over the person behind it and inherit whatever they held.
 *
 * The persona below is exactly that shape — invited, no password, holding a
 * `track_lead` grant — because the defect was not visible on a person who had
 * already signed in once.
 */

const ORG = "org_claim";
const VICTIM = "per_claim_victim";
const VICTIM_EMAIL = "claim-victim@example.com";
const EVENT = "evt_claim";
const TRACK = "trk_claim";

const SIGNUP = "http://localhost/signup";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Claim Org", "claim-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Claim Conf", "claim-conf", "UTC", "2027-05-01", "2027-05-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO track (id, event_id, name, slug, sort_order, is_public) VALUES (?,?,?,?,?,?)",
    [TRACK, EVENT, "Claim Track", "claim-track", 1, 1],
  );
  // Invited, never signed in, and holding a grant — the state the claim branch
  // treated as an invitation to set a password.
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [VICTIM, VICTIM_EMAIL, "Real Person", "invited", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
    [`grt_${VICTIM}`, VICTIM, "track_lead", "track", TRACK, VICTIM, now],
  );
});

function signUpAs(email: string, extra: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(SIGNUP, {
    method: "POST",
    body: new URLSearchParams({ email, password: "attacker-chosen-password", full_name: "Mallory", ...extra }),
    headers: FORM,
    redirect: "manual",
  });
}

describe("sign-up never adopts an existing account (INV-01-19)", () => {
  it("refuses to set a first password on someone else's account", async () => {
    const res = await signUpAs(VICTIM_EMAIL);

    // Bounced to sign-in, not signed in.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("podium_session=");

    // No credential was minted for them.
    const identity = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_identity WHERE person_id = ? AND provider = 'password'")
      .bind(VICTIM)
      .first<{ n: number }>();
    expect(identity?.n).toBe(0);

    // And the account itself is untouched — the old branch rewrote all three.
    const person = await env.DB.prepare("SELECT full_name, status, is_placeholder FROM person WHERE id = ?")
      .bind(VICTIM)
      .first<{ full_name: string; status: string; is_placeholder: number }>();
    expect(person?.full_name).toBe("Real Person");
    expect(person?.status).toBe("invited");

    // The grant that made this a takeover rather than a nuisance is still theirs.
    const grant = await env.DB.prepare("SELECT COUNT(*) AS n FROM role_grant WHERE person_id = ? AND revoked_at IS NULL")
      .bind(VICTIM)
      .first<{ n: number }>();
    expect(grant?.n).toBe(1);
  });

  it("still creates an account for an address nobody holds", async () => {
    const res = await signUpAs("claim-newcomer@example.com");
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie") ?? "").toContain("podium_session=");
  });

  it("answers a password-less account exactly as it answers a wrong password", async () => {
    // Otherwise this branch is the sharper of the two account-existence
    // oracles, and the refusal itself tells an attacker which addresses are
    // worth pursuing through some other door.
    const claimed = await signUpAs(VICTIM_EMAIL);
    const wrongPassword = await signUpAs("claim-newcomer@example.com", { password: "not-the-password" });
    expect(claimed.status).toBe(wrongPassword.status);
    expect(claimed.headers.get("location")).toBe(wrongPassword.headers.get("location"));
  });
});
