/**
 * Primitives for verifying an inbound provider callback — 09, `verify_webhook`
 * on the `email` contract.
 *
 * An inbound webhook route has no session and no API key: the signature *is*
 * the authentication. Everything here therefore fails closed — a malformed
 * key, an unparseable signature, a missing header and a wrong signature are
 * all indistinguishable `false`, never a throw the caller might mistake for a
 * different kind of failure and retry past.
 *
 * Both schemes sign the exact bytes the provider sent, which is why
 * `InboundWebhookRequest` carries `raw_body` as an unparsed string. Parsing
 * JSON and re-serialising it reorders keys and drops whitespace, and every
 * signature check fails; that is the classic way this gets built wrong.
 */

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Compares without leaking where the mismatch was, via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Signature replay window. A valid signature stays valid forever, so without
 * this a captured callback can be replayed indefinitely — which for a `bounce`
 * means an attacker can put any address on the global suppression list and
 * silently stop that speaker's mail.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function withinTolerance(timestampSeconds: number, nowMs: number, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  return Math.abs(nowMs / 1000 - timestampSeconds) <= toleranceSeconds;
}

/**
 * ECDSA signatures arrive DER-encoded (`SEQUENCE { INTEGER r, INTEGER s }`)
 * but WebCrypto verifies only the raw `r||s` fixed-width form, so the two
 * never interoperate without this. Returns null on anything that is not a
 * well-formed P-256 signature.
 */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  let seqLen = der[i++] ?? 0;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n < 1 || n > 2) return null;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | (der[i++] ?? 0);
  }
  if (i + seqLen !== der.length) return null;

  const readInt = (): Uint8Array | null => {
    if (der[i++] !== 0x02) return null;
    const len = der[i++] ?? 0;
    // r and s are at most 33 bytes on P-256; a long-form length is malformed.
    if (len & 0x80) return null;
    const start = i;
    i += len;
    if (i > der.length) return null;
    let bytes = der.subarray(start, i);
    // DER prepends a zero byte to keep the integer positive; the raw form is
    // unsigned and fixed width, so strip it and left-pad instead.
    while (bytes.length > 1 && bytes[0] === 0x00) bytes = bytes.subarray(1);
    if (bytes.length > size) return null;
    const padded = new Uint8Array(size);
    padded.set(bytes, size - bytes.length);
    return padded;
  };

  const r = readInt();
  if (!r) return null;
  const s = readInt();
  if (!s) return null;
  if (i !== der.length) return null;
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

/** SendGrid's scheme: base64 SPKI public key, base64 DER signature, SHA-256. */
export async function verifyEcdsaP256(publicKeySpkiBase64: string, signatureDerBase64: string, signedPayload: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(publicKeySpkiBase64) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const raw = derToRawEcdsa(base64ToBytes(signatureDerBase64));
    if (!raw) return false;
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, new TextEncoder().encode(signedPayload));
  } catch {
    return false;
  }
}

export async function hmacSha256Base64(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(sig));
}
