/**
 * Webhook URL safety and payload signing — 09, `Webhook`.
 *
 * Pure: the delivery attempt itself lives in the worker, on the delivery queue.
 */

import { hmacSha256Hex } from "../identity/credentials.js";
import { invariantError } from "../shared/errors.js";
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "./types.js";

/* -------------------------------------------------------------------------- */
/* INV-09-2 — absolute https, no private or link-local ranges                  */
/* -------------------------------------------------------------------------- */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
  /^0\./,
  /^22[4-9]\.|^2[3-5]\d\./, // multicast + reserved
];

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * INV-09-2: webhook URLs must be absolute `https`, and requests to private and
 * link-local address ranges are refused **at delivery time** (SSRF). Checked at
 * save time too, because a URL that can never be delivered is not worth saving.
 */
export function checkWebhookUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not an absolute URL." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Webhook URLs must use https." };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: `${host} is a loopback address.` };
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, reason: `${host} resolves inside the private network.` };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_V4.some((re) => re.test(host))) return { ok: false, reason: `${host} is a private or link-local address.` };
  }
  if (host.includes(":")) {
    // IPv6 literal: loopback, unique-local (fc00::/7), link-local (fe80::/10),
    // and IPv4-mapped forms of the ranges above.
    if (host === "::1" || host === "::") return { ok: false, reason: "That is a loopback address." };
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return { ok: false, reason: "That is a private IPv6 address." };
    const mapped = /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (mapped && PRIVATE_V4.some((re) => re.test(mapped[1]))) {
      return { ok: false, reason: "That is a private address in IPv4-mapped form." };
    }
  }
  return { ok: true };
}

export function assertDeliverableUrl(raw: string): void {
  const check = checkWebhookUrl(raw);
  if (!check.ok) {
    throw invariantError("INV-09-2", "webhook_url_refused", check.reason ?? "That URL cannot be used.", { url: raw });
  }
}

/* -------------------------------------------------------------------------- */
/* Signature                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `X-Signature: t=<unix>,v1=<hmac(t + "." + body)>` — 09, "Delivery contract".
 * Both current and previous secrets are valid mid-rotation, which is emitted as
 * two `v1=` values so a consumer that checks any of them accepts both.
 */
export async function signPayload(secrets: (string | null | undefined)[], body: string, atMs: number): Promise<string> {
  const t = Math.floor(atMs / 1000);
  const signed = `${t}.${body}`;
  const parts = [`t=${t}`];
  for (const secret of secrets) {
    if (!secret) continue;
    parts.push(`v1=${await hmacSha256Hex(secret, signed)}`);
  }
  return parts.join(",");
}

export interface ParsedSignature {
  t: number;
  v1: string[];
}

export function parseSignature(header: string): ParsedSignature | null {
  const out: ParsedSignature = { t: 0, v1: [] };
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") out.t = Number(v);
    if (k?.trim() === "v1" && v) out.v1.push(v.trim());
  }
  return out.t ? out : null;
}

/** The consumer-side check, exported so the contract is testable from both ends. */
export async function verifySignature(
  header: string,
  secret: string,
  body: string,
  nowMs: number,
  toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  const parsed = parseSignature(header);
  if (!parsed) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - parsed.t) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${parsed.t}.${body}`);
  return parsed.v1.includes(expected);
}
