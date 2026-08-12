/**
 * Failed-sign-in throttling — INV-01-17.
 *
 * The model has always required "rate limiting per identity"
 * (01-identity-and-access.md, "Why `password` exists despite the cost"). Nothing
 * implemented it until 2026-08-12, so this file is a defect fix against the
 * specification rather than a new rule.
 *
 * Nothing stood between an attacker and unlimited password guesses. When this
 * was written that was doubly bad, because `ARGON2_PARAMS` was `m=256 KiB, t=1`
 * to fit the free plan's 10 ms CPU ceiling: a weak hash raised the value of
 * each guess at the same moment the ceiling made each guess cheap to serve.
 *
 * The hash is no longer weak — the deployment moved to Workers Paid and the
 * parameters are back to `m=12 MiB, t=3` (docs/implementation.md, "Password
 * hashing, and the plan that pays for it"). That changes what this file is for
 * rather than removing the need for it. An expensive hash makes each guess
 * costly; only a limit stops the guessing. It also now protects a real CPU
 * spend: ~108 ms per verification is worth refusing before it is paid for,
 * which is why the check still runs ahead of the hash rather than after it.
 *
 * State lives in KV rather than D1 deliberately. It is infrastructure, not
 * domain: it has a TTL, it is never read by a user-facing screen, nothing in
 * `docs/domain/` refers to it, and inventing a `LoginAttempt` entity to hold it
 * would put a row in the model that exists only because of a hosting plan. KV's
 * eventual consistency costs an attacker-favourable margin across colos, which
 * is the right trade against a D1 write on every sign-in attempt.
 */

import type { Env } from "@podiumstack/data/context.js";
import { hashToken } from "@podiumstack/domain/identity/credentials.js";
import { DomainError } from "@podiumstack/domain/shared/errors.js";

/** How long a run of failures is remembered. */
const WINDOW_SECONDS = 15 * 60;

/**
 * Per-identifier ceilings. The email limit is the one that stops an attack on a
 * known account; the address limit is the one that stops a spray across many
 * accounts from one place. The address ceiling is deliberately much higher —
 * a conference office behind one NAT is a real thing, and locking out a venue
 * on the morning of an event is its own kind of outage.
 */
const MAX_PER_EMAIL = 10;
const MAX_PER_ADDRESS = 50;

/** Email is hashed: KV keys end up in logs and dashboards, and this is PII. */
function emailKey(email: string): string {
  return `login_fail:email:${hashToken(email.trim().toLowerCase())}`;
}

function addressKey(ip: string): string {
  return `login_fail:ip:${ip}`;
}

async function readCount(env: Env, key: string): Promise<number> {
  const raw = await env.CACHE.get(key);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function tooMany(): DomainError {
  return new DomainError({
    code: "too_many_attempts",
    message: "Too many failed sign-in attempts. Wait fifteen minutes and try again.",
    status: 429,
  });
}

/**
 * Call before verifying a password — the point is to refuse *before* paying for
 * the Argon2 hash, which is both the CPU cost being protected and the thing an
 * attacker would otherwise use to exhaust the isolate.
 *
 * Throws 429 when either ceiling is exceeded. The message is the same whether
 * the email exists or not; a throttle that only fires for real accounts is an
 * account-enumeration oracle.
 */
export async function assertLoginAllowed(env: Env, req: Request, email: string): Promise<void> {
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const [byEmail, byAddress] = await Promise.all([
    readCount(env, emailKey(email)),
    ip ? readCount(env, addressKey(ip)) : Promise.resolve(0),
  ]);
  if (byEmail >= MAX_PER_EMAIL || byAddress >= MAX_PER_ADDRESS) throw tooMany();
}

/**
 * Call after a sign-in attempt fails. Deferred through `waitUntil` by the
 * caller: the person is already being told "that did not match", and making
 * them wait on two KV writes to hear it only slows the honest case.
 *
 * The read-then-write is not atomic and cannot be in KV. A racing burst
 * therefore undercounts, which is why the ceiling is a round number rather than
 * a tight one — this bounds sustained guessing, it does not bound a single
 * parallel burst. If that becomes the threat, the counter moves to a Durable
 * Object keyed by email, which serialises properly.
 */
export async function recordLoginFailure(env: Env, req: Request, email: string): Promise<void> {
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const keys = [emailKey(email), ...(ip ? [addressKey(ip)] : [])];
  await Promise.all(
    keys.map(async (key) => {
      const next = (await readCount(env, key)) + 1;
      // Fixed TTL, not a sliding one: the window starts at the first failure so
      // a lockout always ends, rather than an attacker being able to hold an
      // account locked indefinitely by continuing to guess.
      await env.CACHE.put(key, String(next), { expirationTtl: WINDOW_SECONDS });
    }),
  );
}

/** Call after a successful sign-in, so an honest person's typos do not accumulate. */
export async function clearLoginFailures(env: Env, email: string): Promise<void> {
  await env.CACHE.delete(emailKey(email));
}
