import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "@podiumstack/web/http/headers.js";
import { withDemoBanner } from "@podiumstack/web/ui/demo.js";
import { isDemoDeployment } from "@podiumstack/data/context.js";

/**
 * The demonstration bar (09, "Demonstration deployments") and the predicate the
 * whole of INV-09-28 hangs off.
 *
 * Both are tested here rather than only through the Worker because both fail
 * quietly. A bar injected into an embed appears inside somebody else's page;
 * a predicate that reads `"false"` as truthy turns every real deployment into
 * one that has silently stopped sending email.
 */

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const DEMO = { DEMO_MODE: "true" };
const REAL = { DEMO_MODE: "false" };

describe("isDemoDeployment", () => {
  it("is true only for the exact string, so a var left at a falsy word is not a demonstration", () => {
    expect(isDemoDeployment({ DEMO_MODE: "true" })).toBe(true);
    for (const value of ["false", "0", "", "no", "TRUE", "1", undefined]) {
      expect(isDemoDeployment({ DEMO_MODE: value })).toBe(false);
    }
  });
});

describe("the demonstration bar", () => {
  it("goes at the top of the body, after the opening tag and before the top bar", () => {
    const out = withDemoBanner('<!doctype html><html><body class="auth"><header>hi</header></body></html>');
    expect(out).toContain('<body class="auth"><div class="demo-bar"');
    expect(out.indexOf("demo-bar")).toBeLessThan(out.indexOf("<header>"));
  });

  it("leaves a fragment alone — a partial has no body of its own to be at the top of", () => {
    const fragment = '<div class="card"><h1>Just a piece of a page</h1></div>';
    expect(withDemoBanner(fragment)).toBe(fragment);
  });

  it("says the two things a visitor cannot find out by looking: it resets, and it emails nobody", () => {
    const out = withDemoBanner("<body></body>");
    expect(out).toContain("every hour");
    expect(out).toContain("outbox");
  });

  it("rides on an HTML response only where the deployment is a demonstration", async () => {
    const req = () => new Request("https://podium.example/admin/proposals");
    expect(await (await withSecurityHeaders(req(), html("<body>x</body>"), DEMO)).text()).toContain("demo-bar");
    expect(await (await withSecurityHeaders(req(), html("<body>x</body>"), REAL)).text()).not.toContain("demo-bar");
    // Absent env is a real deployment: the banner is opt-in, never opt-out.
    expect(await (await withSecurityHeaders(req(), html("<body>x</body>"))).text()).not.toContain("demo-bar");
  });

  it("stays out of the embed, which renders inside somebody else's page", async () => {
    const embed = new Request("https://podium.example/embed/abc123");
    const res = await withSecurityHeaders(embed, html("<body>agenda</body>"), DEMO);
    expect(await res.text()).not.toContain("demo-bar");
  });

  it("asks not to be indexed on every response, not only the ones a crawler asked permission for", async () => {
    const req = () => new Request("https://podium.example/e/some-conference");
    expect((await withSecurityHeaders(req(), html("<body>x</body>"), DEMO)).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await withSecurityHeaders(req(), html("<body>x</body>"), REAL)).headers.get("x-robots-tag")).toBeNull();
  });
});
