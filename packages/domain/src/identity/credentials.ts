/**
 * Credential handling — 01-identity-and-access.md, `AuthIdentity`.
 *
 * INV-01-12: `credential_hash` is required when `provider = password` and null
 * for every other provider. The plaintext is never stored, never logged, and
 * never returned by any surface.
 *
 * Argon2id, per the same section.
 *
 * **m=12 MiB, t=3 — an OWASP-recommended configuration.** This deployment ran
 * on the Cloudflare free plan until 2026-08-12, whose 10 ms CPU ceiling could
 * not pay for a real hash: the setting was m=256 KiB, t=1, roughly two orders
 * of magnitude cheaper to attack offline than it should have been, and
 * documented at the time as a stopgap rather than a position. The plan is now
 * Workers Paid, whose budget is measured in seconds, and this is the revert
 * that stopgap was written to anticipate.
 *
 * Why 12 MiB and t=3 rather than the 19 MiB, t=2 that OWASP lists first — the
 * two cost the same, 108 ms against 116 ms per hash when measured directly, so
 * the choice is not about time. It is about memory: a Workers isolate has
 * 128 MB, every concurrent sign-in holds its own Argon2 buffer for the duration
 * of the hash, and 12 MiB leaves room for roughly ten at once where 19 MiB
 * leaves six. Both configurations are on OWASP's list; this one has more
 * headroom on the runtime that actually has to run it. Revisit if sign-in
 * concurrency is ever measured rather than guessed at.
 *
 * Nothing needs migrating. `verifyPassword` reads the parameters out of each
 * stored PHC string, so hashes written at m=256 still verify at their own cost,
 * and `needsRehash` carries each one up to these parameters on its owner's next
 * successful sign-in, while the plaintext is in hand. Nobody holds the
 * plaintexts, so there is no batch path and none is needed.
 */

import { argon2id } from "@noble/hashes/argon2.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ARGON2_PARAMS = { t: 3, m: 12288, p: 1, dkLen: 32 } as const;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const b = new Uint8Array(length);
  crypto.getRandomValues(b);
  return b;
}

/** PHC-style string: `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
export function hashPassword(plaintext: string, salt: Uint8Array = randomBytes(16)): string {
  const hash = argon2id(new TextEncoder().encode(plaintext), salt, ARGON2_PARAMS);
  const { m, t, p } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * The cost of verifying a hash is fixed by the hash, not by `ARGON2_PARAMS` —
 * the PHC string carries the parameters it was written with. A hash far above
 * what the plan can pay for does not fail the sign-in, it kills the isolate, so
 * callers ask `beyondCpuBudget` first and send the person to a password reset
 * instead.
 *
 * **This ceiling must always sit above `ARGON2_PARAMS.m`, and raising the two
 * is a single edit.** Lowering `m` to 256 for the free plan left this at 1024,
 * which was correct then and became a trap: bumping `ARGON2_PARAMS` back to
 * 12288 on its own would have made every newly-set password unverifiable the
 * moment it was written — a self-inflicted lockout with no error until someone
 * tried to sign in. `tests/unit/shared/seed-credentials.test.ts` pins the
 * relationship from the seed's side; the assertion below states it directly.
 *
 * 64 MiB, not 12: the point is to refuse nonsense — a parameter set no code
 * here would ever write — rather than to second-guess a legitimate change to
 * `ARGON2_PARAMS`.
 */
const MAX_VERIFIABLE_M = 65536;

if (ARGON2_PARAMS.m > MAX_VERIFIABLE_M) {
  throw new Error(
    `ARGON2_PARAMS.m (${ARGON2_PARAMS.m}) exceeds MAX_VERIFIABLE_M (${MAX_VERIFIABLE_M}): every password written would be refused on the next sign-in.`,
  );
}

function storedParams(stored: string): { t: number; m: number; p: number } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id") return null;
  const raw = Object.fromEntries(parts[3].split(",").map((kv) => kv.split("=")));
  return {
    t: Number(raw.t ?? ARGON2_PARAMS.t),
    m: Number(raw.m ?? ARGON2_PARAMS.m),
    p: Number(raw.p ?? ARGON2_PARAMS.p),
  };
}

/** True when `stored` is too expensive to verify on this plan — see above. */
export function beyondCpuBudget(stored: string): boolean {
  const params = storedParams(stored);
  return params !== null && params.m > MAX_VERIFIABLE_M;
}

/**
 * True when `stored` was written with parameters other than the current ones.
 * Re-hashing on a successful sign-in is how a change to `ARGON2_PARAMS` reaches
 * hashes already in the table — including the way back up, once CPU allows.
 */
export function needsRehash(stored: string): boolean {
  const params = storedParams(stored);
  if (!params) return false;
  return params.t !== ARGON2_PARAMS.t || params.m !== ARGON2_PARAMS.m || params.p !== ARGON2_PARAMS.p;
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  const params = storedParams(stored);
  if (!params) return false;
  const expected = fromBase64(stored.split("$")[5]);
  const actual = argon2id(new TextEncoder().encode(plaintext), fromBase64(stored.split("$")[4]), {
    ...params,
    dkLen: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Opaque, unguessable token: 32 bytes, url-safe base64. */
export function newToken(): string {
  return toBase64(randomBytes(32)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Tokens are stored hashed (INV-01-7 for invitations, INV-09-1 for API keys).
 * SHA-256 is right here: the token is already 256 bits of entropy, so there is
 * nothing to brute-force and nothing to slow down.
 */
export function hashToken(token: string): string {
  return toHex(sha256(new TextEncoder().encode(token)));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Content hashes — `Proposal.content_hash`, `SchedulePublication.content_etag`. */
export function contentHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return toHex(sha256(new TextEncoder().encode(text))).slice(0, 32);
}

/** HMAC-SHA256 webhook signature — 09-api-and-integrations.md. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

/** SHA-256 of an uploaded file — `Asset.checksum`. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}
