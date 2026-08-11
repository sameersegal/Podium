/**
 * Credential handling — 01-identity-and-access.md, `AuthIdentity`.
 *
 * INV-01-12: `credential_hash` is required when `provider = password` and null
 * for every other provider. The plaintext is never stored, never logged, and
 * never returned by any surface.
 *
 * Argon2id, per the same section. Parameters are the conservative end of the
 * OWASP range that a JS implementation can run inside a Worker's CPU budget:
 * 19 MiB is the RFC 9106 second recommendation; 12 MiB with t=3 sits in the
 * same family and keeps sign-in interactive on a single isolate.
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

export function verifyPassword(plaintext: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id") return false;
  const params = Object.fromEntries(parts[3].split(",").map((kv) => kv.split("=")));
  const salt = fromBase64(parts[4]);
  const expected = fromBase64(parts[5]);
  const actual = argon2id(new TextEncoder().encode(plaintext), salt, {
    t: Number(params.t ?? ARGON2_PARAMS.t),
    m: Number(params.m ?? ARGON2_PARAMS.m),
    p: Number(params.p ?? ARGON2_PARAMS.p),
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
