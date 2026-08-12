import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every mutation runs through an `AppContext`, and `flush()` is what persists
 * the domain event log and the audit rows and then publishes to the queue
 * (docs/implementation.md, "The unit of work").
 *
 * A handler that raises events and never flushes fails silently and
 * expensively: the write lands, and every reaction that was supposed to follow
 * it — the cache invalidation, the speaker's email, the webhook — simply never
 * happens. Nothing at runtime complains. This is the check that does.
 */

const ROOT = new URL("../../../workers/api/src", import.meta.url).pathname;

/**
 * Handlers that build a context for reads only, or that delegate the write to
 * something which flushes on their behalf. Each one is a deliberate exemption,
 * not an oversight.
 */
const EXEMPT: Record<string, string> = {
  "POST /logout": "ends a session; raises no domain event",
  "POST /admin/people/:personId/merge-lookup": "resolves a person and redirects to the confirmation screen; writes nothing",
  "POST /admin/events/:eventId/schedule/place": "delegates to the schedule Durable Object, which flushes inside the critical section",
  "POST /admin/events/:eventId/schedule/move": "delegates to the schedule Durable Object, which flushes inside the critical section",
  "PUT /files/upload": "the presigned upload callback stamps size and checksum; the asset's events were raised when it was created",
  "POST /admin/sync/:mappingId/pull": "reads the mapping to check it accepts writes at all, then enqueues; the run itself flushes on the delivery queue",
  "POST /v1/sync/mappings/:id/pull": "reads the mapping to check it accepts writes at all, then enqueues; the run itself flushes on the delivery queue",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function mutatingHandlers(): { key: string; file: string; flushes: boolean }[] {
  const found: { key: string; file: string; flushes: boolean }[] = [];
  for (const file of sourceFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    const pattern = /router\.(post|put|patch|delete)\(\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(src))) {
      const next = src.indexOf("router.", match.index + match[0].length);
      const body = src.slice(match.index, next > 0 ? next : src.length);
      if (!body.includes("ctx.app(")) continue; // no unit of work, nothing to flush
      found.push({
        key: `${match[1].toUpperCase()} ${match[2]}`,
        file: file.replace(ROOT, "workers/api/src"),
        flushes: /\.flush\(\)/.test(body),
      });
    }
  }
  return found;
}

describe("the unit of work", () => {
  const handlers = mutatingHandlers();

  it("finds the mutating handlers to check", () => {
    expect(handlers.length).toBeGreaterThan(50);
  });

  it("flushes every handler that opens one, or names why it does not", () => {
    const unflushed = handlers.filter((h) => !h.flushes && !(h.key in EXEMPT));
    expect(
      unflushed.map((h) => `${h.key}  (${h.file})`),
      "these raise domain events and throw them away — add `await app.flush()`, or an entry in EXEMPT saying why not",
    ).toEqual([]);
  });

  it("keeps the exemption list honest — no stale entries", () => {
    const keys = new Set(handlers.map((h) => h.key));
    const stale = Object.keys(EXEMPT).filter((k) => !keys.has(k));
    expect(stale, "exemptions for handlers that no longer exist").toEqual([]);
  });
});
