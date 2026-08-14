import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * The D1 budget, enforced rather than remembered.
 *
 * `implementer.md`, G: "D1 queries per request — single digits — an N+1 is a
 * defect, not a slow path". A budget nobody can read is a budget nobody keeps,
 * so every response outside production carries `x-podium-d1-queries` and this
 * file holds the screens that grew fastest to a ceiling.
 *
 * ## Why the ceilings are not single digits
 *
 * Two costs sit under every number here and neither is the screen's:
 *
 * - **~10 statements of request context.** `buildContext` resolves the org,
 *   the session, the person, their grants and the five relationship lookups
 *   that authorization needs, before any route runs. `/login` — a form and
 *   nothing else — costs 10. That is the floor for any signed-in page. It was
 *   11 until `resolveOrg` stopped reading the org's id and then the row that
 *   id identifies; every number in this file is one lower for that reason and
 *   no other.
 * - **~20 statements to answer "what is not published yet".** `pendingChanges`
 *   diffs the working schedule against the live snapshot, which means reading
 *   the schedule. It is flat in the number of sessions rather than N+1, and it
 *   is the honest cost of an exact number; the alternative is a screen that
 *   says "some changes".
 *
 * So these ceilings are set where a *regression* trips them, not where the
 * ideal sits. They are deliberately loose enough not to churn on a one-query
 * change and tight enough that the shapes this file was written to catch —
 * a per-round loop, a per-call loop, eleven `COUNT(*) … WHERE status = ?` —
 * cannot come back unnoticed. `/admin` cost 94 before those were collapsed.
 */

const ORG = "org_qbudget";
const EVENT = "evt_qbudget";
const CFP = "cfp_qbudget";
const PERSON = "per_qbudget";
const EMAIL = "qbudget-organizer@example.com";
const PASSWORD = "a-long-enough-password-1";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Budget Org", "budget-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Budget Conf", "budget-conf", "UTC", "2027-06-01", "2027-06-02", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [CFP, EVENT, "Main call", "main", "2027-01-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [PERSON, EMAIL, "Budget Organizer", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ["aid_qbudget", PERSON, "password", EMAIL, hashPassword(PASSWORD), now, EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)",
    ["rg_qbudget", PERSON, "organizer", "org", ORG, PERSON, now],
  );

  // Several rounds and calls, because the shapes this file exists to catch are
  // the ones that cost *per round* and *per call*. One of each would pass a
  // per-round loop without noticing it.
  for (const [i, id] of ["rnd_qb_1", "rnd_qb_2", "rnd_qb_3"].entries()) {
    await run(
      "INSERT OR IGNORE INTO review_round (id, event_id, name, sequence, status, anonymity, target_reviews_per_proposal, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, EVENT, `Round ${i + 1}`, i + 1, "open", "double_blind", 2, now, now],
    );
  }
  for (const [i, id] of ["cfp_qb_2", "cfp_qb_3"].entries()) {
    await run(
      "INSERT OR IGNORE INTO call_for_proposals (id, event_id, name, slug, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, EVENT, `Extra call ${i + 1}`, `extra-${i + 1}`, "2027-01-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", now, now],
    );
  }
});

async function signIn(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** How many D1 statements one request prepared, from the response itself. */
async function queriesFor(path: string, cookie?: string): Promise<number> {
  const res = await SELF.fetch(`http://localhost${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  const header = res.headers.get("x-podium-d1-queries");
  expect(header, `${path} carried no query count`).toBeTruthy();
  return Number(header);
}

describe("the D1 budget per request (implementer.md, G)", () => {
  it("a public page costs a handful of statements and nothing more", async () => {
    // Anonymous, and served from the cached publication snapshot (INV-09-6) —
    // the cheapest thing in the product, and it must stay that way.
    expect(await queriesFor("/e/budget-conf")).toBeLessThanOrEqual(10);
  });

  it("signing in is the floor every authenticated screen pays", async () => {
    const cookie = await signIn();
    // Not an assertion about `/login` so much as a recorded baseline: if this
    // moves, every ceiling below moves with it and the reason is `buildContext`,
    // not the screen.
    expect(await queriesFor("/login", cookie)).toBeLessThanOrEqual(15);
  });

  it("Today does not loop over rounds, calls or statuses", async () => {
    const cookie = await signIn();
    // 94 before the funnel, task, conflict, round, call and sponsorship counts
    // were collapsed into grouped queries and the publication diff stopped
    // building a payload it discards. Three rounds and three calls are seeded
    // above precisely so a reintroduced per-round or per-call loop shows up
    // here as a jump, not as a rounding error.
    expect(await queriesFor("/admin?nojs=1", cookie)).toBeLessThanOrEqual(60);
  });

  it("the console's Today read is no more expensive than the screen it feeds", async () => {
    const cookie = await signIn();
    const today = await queriesFor(`/v1/events/${EVENT}/dashboard?sections=today`, cookie);
    const all = await queriesFor(`/v1/events/${EVENT}/dashboard`, cookie);
    expect(today).toBeLessThanOrEqual(60);
    // The subset must actually be a subset. If these converge, `sections` has
    // stopped skipping anything and the split is costing complexity for nothing.
    expect(today).toBeLessThan(all);
  });

  it("the reviewer queue and the speaker portal stay close to the floor", async () => {
    const cookie = await signIn();
    // Both are one person's own rows, and neither should ever grow a per-row
    // read: the queue joins its proposals in one statement, and the portal's
    // dashboard is a fixed set of lookups.
    expect(await queriesFor("/review", cookie)).toBeLessThanOrEqual(25);
    expect(await queriesFor("/portal", cookie)).toBeLessThanOrEqual(30);
  });
});
