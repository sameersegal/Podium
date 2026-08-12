import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "@podiumstack/web/http/headers.js";
import { CSP_NONCE_MARKER, inlineScript, jsonScript } from "@podiumstack/web/ui/html.js";

/**
 * The nonce substitution, tested directly because it is the half of the CSP
 * change that fails silently.
 *
 * `script-src` no longer allows `'unsafe-inline'`, so every inline block in the
 * app now depends on a marker being replaced with the same value the header
 * names. Get that wrong and nothing throws: the pages render, the tests pass,
 * and the schedule's star buttons, the proposal queue's select-all and the
 * submission wizard's conditional fields quietly stop working in a browser
 * nobody ran during CI.
 */

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

const req = () => new Request("https://podium.example/admin/proposals");

function nonceFromHeader(res: Response): string {
  const csp = res.headers.get("content-security-policy") ?? "";
  return /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
}

describe("CSP nonce substitution", () => {
  it("replaces the marker with the nonce the header names", async () => {
    const res = await withSecurityHeaders(req(), html(`<body>${inlineScript("var a=1;")}</body>`));
    const body = await res.text();
    const nonce = nonceFromHeader(res);

    expect(nonce).not.toBe("");
    expect(body).toContain(`nonce="${nonce}"`);
    expect(body).not.toContain(CSP_NONCE_MARKER);
  });

  it("replaces every marker on the page, not only the first", async () => {
    const page = `<body>${inlineScript("var a=1;")}${inlineScript("var b=2;")}${jsonScript("boot", { a: 1 })}</body>`;
    const res = await withSecurityHeaders(req(), html(page));
    const body = await res.text();

    expect(body).not.toContain(CSP_NONCE_MARKER);
    expect(body.match(/nonce="/g)).toHaveLength(3);
  });

  it("forbids inline script, which is the point of the whole exercise", async () => {
    const res = await withSecurityHeaders(req(), html("<body></body>"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toContain("'unsafe-inline'; script");
    expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(false);
  });

  it("issues a different nonce every response", async () => {
    // A predictable nonce is `'unsafe-inline'` with extra steps.
    const a = nonceFromHeader(await withSecurityHeaders(req(), html("<body></body>")));
    const b = nonceFromHeader(await withSecurityHeaders(req(), html("<body></body>")));
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });

  it("leaves a non-HTML body alone rather than buffering it", async () => {
    // R2 objects and exports stream through here. Reading them into a string to
    // look for a marker they cannot contain would be a memory bug waiting for
    // the first large slide deck.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await withSecurityHeaders(
      new Request("https://podium.example/assets/ast_1"),
      new Response(bytes, { headers: { "content-type": "application/pdf" } }),
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    // Uploaded bytes get the sandbox policy, which names no nonce at all.
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});
