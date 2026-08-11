/**
 * A stand-in for SendGrid's signing half, shared by the unit and integration
 * suites.
 *
 * It holds a real private key and produces real ECDSA P-256 signatures in the
 * DER encoding the Event Webhook actually sends. That matters: WebCrypto signs
 * into the raw `r||s` form and the production code converts DER→raw to verify,
 * so a test that signed in raw form would only prove the code agrees with
 * itself. Converting back to DER here means an accepted signature is evidence
 * the provider's scheme is implemented, not ours.
 */

import { bytesToBase64 } from "@podiumconf/plugins/webhook-verify.js";

function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
  const encodeInt = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    // DER integers are signed, so a high bit set needs a leading zero byte.
    if ((v[0] ?? 0) & 0x80) {
      const padded = new Uint8Array(v.length + 1);
      padded.set(v, 1);
      v = padded;
    }
    return v;
  };
  const r = encodeInt(raw.subarray(0, 32));
  const s = encodeInt(raw.subarray(32));
  const body = new Uint8Array(4 + r.length + s.length);
  let o = 0;
  body[o++] = 0x02;
  body[o++] = r.length;
  body.set(r, o);
  o += r.length;
  body[o++] = 0x02;
  body[o++] = s.length;
  body.set(s, o);
  // P-256 keeps the whole structure under 128 bytes, so the length is short-form.
  const out = new Uint8Array(2 + body.length);
  out[0] = 0x30;
  out[1] = body.length;
  out.set(body, 2);
  return out;
}

export interface SendgridSigner {
  /** Base64 SPKI — what an operator pastes into `config.event_webhook_public_key`. */
  publicKeyBase64: string;
  /** Base64 DER signature over `timestamp + body`, as the provider sends it. */
  sign(payload: string): Promise<string>;
}

export async function sendgridSigner(): Promise<SendgridSigner> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  return {
    publicKeyBase64: bytesToBase64(spki),
    async sign(payload: string) {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload)));
      return bytesToBase64(rawToDerEcdsa(raw));
    },
  };
}
