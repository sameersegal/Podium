import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `public/confirm.js` carries the behaviour that used to live in
 * `onsubmit="return confirm(…)"` attributes. Those attributes are inline script
 * that no CSP nonce can rescue — a nonce applies to an element, and an
 * event-handler attribute is not one — so they were the last reason
 * `script-src` needed `'unsafe-inline'`.
 *
 * Asserted here rather than over HTTP because `SELF.fetch` in
 * `@cloudflare/vitest-pool-workers` dispatches to the Worker and does not
 * emulate the `assets` router, so `/confirm.js` 404s in the integration
 * environment — as do `/live.js` and `/app.css`, which have always worked in
 * production. An integration test asserting a 200 there would be asserting a
 * property of the harness.
 *
 * What this can still check is the thing that would actually break: the file
 * being deleted, renamed, or losing the hooks the markup depends on.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIRM = join(ROOT, "public", "confirm.js");

describe("public/confirm.js", () => {
  const source = readFileSync(CONFIRM, "utf8");

  it("handles both hooks the markup emits", () => {
    expect(source).toContain("data-confirm");
    expect(source).toContain("data-back");
  });

  it("listens on submit and on click", () => {
    // Forms carry `data-confirm`; so do individual buttons, where one form has
    // several actions and only one is destructive.
    expect(source).toContain('"submit"');
    expect(source).toContain('"click"');
  });

  it("is not an ES module, so it runs on pages the console never touches", () => {
    expect(source).not.toMatch(/^\s*(?:export|import)\s/m);
  });
});

describe("no inline event handlers survive in the server-rendered UI", () => {
  /**
   * The regression that matters: someone adds one `onclick="…"` back, CSP
   * silently drops it, and the button stops working in production while every
   * test still passes. Cheaper to assert here than to discover there.
   */
  function* tsFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* tsFiles(full);
      else if (entry.name.endsWith(".ts")) yield full;
    }
  }

  it("emits no on*= attribute and no javascript: URL", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(join(ROOT, "workers", "api", "src"))) {
      const source = readFileSync(file, "utf8");
      for (const [i, line] of source.split("\n").entries()) {
        // `headers.ts` and `layout.ts` explain the rule by naming the pattern
        // it forbids, which is worth keeping and is not markup. Skipping
        // comment lines is the cheap way to tell prose from output.
        if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue;
        if (/\bon(?:click|submit|change|input|load|error)\s*=\s*["']/.test(line) || /["']javascript:/.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
