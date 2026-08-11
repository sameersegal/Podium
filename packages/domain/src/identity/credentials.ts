/**
 * Credential handling — 01-identity-and-access.md, `AuthIdentity`.
 *
 * INV-01-12: `credential_hash` is required when `provider = password` and null
 * for every other provider. The plaintext is never stored, never logged, and
 * never returned by any surface.
 *
 * Argon2id, per the same section.
 *
 * **These parameters are deliberately far below the OWASP floor.** The Worker
 * runs on the Cloudflare free plan, which allows 10 ms of CPU per invocation.
 * The previous setting — m=12 MiB, t=3, chosen against the paid plan's 30 s
 * budget — costs ~345 ms of Worker CPU, so every sign-in was killed with
 * `exceededCpu` (error 1102) and password login was effectively down. m=256 KiB
 * with t=1 costs ~3 ms, which is what is left once the rest of the sign-in
 * request is paid for.
 *
 * The cost of that: this is roughly two orders of magnitude cheaper to attack
 * offline than RFC 9106's second recommendation (19 MiB, t=2). It is a stopgap
 * to keep the service usable on the free plan, not a considered security
 * position. Raising `ARGON2_PARAMS` back to `{ t: 3, m: 12288 }` is the whole
 * revert; `needsRehash` below then upgrades each stored hash on next sign-in.
 */

import { argon2id } from "@noble/hashes/argon2.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ARGON2_PARAMS = { t: 1, m: 256, p: 1, dkLen: 32 } as const;

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
 * the PHC string carries the parameters it was written with. A stored hash
 * above this ceiling cannot be checked inside the free plan's 10 ms, so
 * attempting it does not fail the sign-in, it kills the isolate. Callers ask
 * `beyondCpuBudget` first and send the person to a password reset instead.
 */
const MAX_VERIFIABLE_M = 1024;

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
