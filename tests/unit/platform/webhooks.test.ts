import { describe, expect, it } from "vitest";
import { checkWebhookUrl, parseSignature, signPayload, verifySignature } from "@podiumconf/domain/platform/webhooks.js";
import { backoffSecondsFor, MAX_WEBHOOK_ATTEMPTS, WEBHOOK_BACKOFF_SECONDS } from "@podiumconf/domain/platform/types.js";

describe("SSRF refusal (INV-09-2)", () => {
  it("INV-09-2: accepts an absolute https URL to a public host", () => {
    expect(checkWebhookUrl("https://example.com/hooks/podium").ok).toBe(true);
  });

  it("INV-09-2: refuses a non-https URL", () => {
    expect(checkWebhookUrl("http://example.com/hooks").ok).toBe(false);
  });

  it("INV-09-2: refuses a private IPv4 range (10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12)", () => {
    expect(checkWebhookUrl("https://10.1.2.3/hooks").ok).toBe(false);
    expect(checkWebhookUrl("https://192.168.1.1/hooks").ok).toBe(false);
    expect(checkWebhookUrl("https://172.16.5.5/hooks").ok).toBe(false);
  });

  it("INV-09-2: refuses loopback and link-local addresses", () => {
    expect(checkWebhookUrl("https://127.0.0.1/hooks").ok).toBe(false);
    expect(checkWebhookUrl("https://169.254.1.1/hooks").ok).toBe(false);
    expect(checkWebhookUrl("https://localhost/hooks").ok).toBe(false);
  });

  it("INV-09-2: refuses a .internal / .local hostname", () => {
    expect(checkWebhookUrl("https://service.internal/hooks").ok).toBe(false);
    expect(checkWebhookUrl("https://box.local/hooks").ok).toBe(false);
  });

  it("INV-09-2: refuses an IPv6 loopback and unique-local address", () => {
    expect(checkWebhookUrl("https://[::1]/hooks").ok).toBe(false);
    expect(checkWebhookUrl("https://[fc00::1]/hooks").ok).toBe(false);
  });

  it("rejects something that is not a URL at all", () => {
    expect(checkWebhookUrl("not a url").ok).toBe(false);
  });
});

describe("the HMAC signature format", () => {
  it("signs as `t=<unix>,v1=<hmac(t + \".\" + body)>`", async () => {
    const header = await signPayload(["s3cr3t"], '{"hello":"world"}', 1_700_000_000_000);
    const parsed = parseSignature(header);
    expect(parsed?.t).toBe(1_700_000_000);
    expect(parsed?.v1).toHaveLength(1);
    expect(parsed?.v1[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits one v1 value per non-null secret, so both the current and previous secret verify during a rotation window", async () => {
    const header = await signPayload(["current", "previous"], "body", Date.now());
    const parsed = parseSignature(header);
    expect(parsed?.v1).toHaveLength(2);
  });

  it("skips a null previous secret rather than emitting an empty v1", async () => {
    const header = await signPayload(["current", null], "body", Date.now());
    expect(parseSignature(header)?.v1).toHaveLength(1);
  });

  it("verifies a signature produced with the matching secret and body", async () => {
    const now = Date.now();
    const header = await signPayload(["s3cr3t"], "the-body", now);
    expect(await verifySignature(header, "s3cr3t", "the-body", now)).toBe(true);
  });

  it("rejects a signature whose body was tampered with", async () => {
    const now = Date.now();
    const header = await signPayload(["s3cr3t"], "the-body", now);
    expect(await verifySignature(header, "s3cr3t", "a-different-body", now)).toBe(false);
  });

  it("rejects a signature outside the freshness tolerance (replay protection)", async () => {
    const then = Date.now() - 10 * 60 * 1000;
    const header = await signPayload(["s3cr3t"], "the-body", then);
    expect(await verifySignature(header, "s3cr3t", "the-body", Date.now(), 300)).toBe(false);
  });
});

describe("09: retry backoff — 1m, 5m, 30m, 2h, 6h, 24h, then exhausted", () => {
  it("matches the documented schedule exactly", () => {
    expect(WEBHOOK_BACKOFF_SECONDS).toEqual([60, 300, 1800, 7200, 21600, 86400]);
  });

  it("returns the next delay for each attempt, and null once exhausted", () => {
    expect(backoffSecondsFor(1)).toBe(60);
    expect(backoffSecondsFor(6)).toBe(86400);
    expect(backoffSecondsFor(7)).toBeNull();
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(7);
  });
});
