import { env as testEnv } from "cloudflare:test";
import type { Env } from "@podiumstack/data/context.js";
import { describe, expect, it } from "vitest";
import { CRON_JOBS, runAllCron } from "@podiumstack/web/consumers/cron.js";
import { EVENT_TYPES } from "@podiumstack/domain/events/catalogue.js";

const env = testEnv as unknown as Env & typeof testEnv;

/**
 * Cron Triggers produce Queue messages (09, platform mapping). Nothing here
 * does long work itself: each sweep finds what has become due and emits the
 * domain event that drives the reaction, so "what happened" lives in the event
 * log rather than inside a timer.
 */
describe("scheduled sweeps", () => {
  it("registers every context's sweeps under a unique name", () => {
    const names = CRON_JOBS.map((j) => j.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const job of CRON_JOBS) {
      expect(job.everyMinutes, `${job.name} has no cadence`).toBeGreaterThan(0);
    }
  });

  it("covers the sweeps the model asks for", () => {
    const names = CRON_JOBS.map((j) => j.name).join(" ");
    // R22 draft abandonment, confirmation-deadline expiry, task reminders,
    // entitlement expiry nudges, `delivered`, and the stalled-prospect nudge.
    for (const expected of ["draft", "expire", "remind", "entitlement", "deliver", "stalled"]) {
      expect(names, `no sweep mentions "${expected}"`).toContain(expected);
    }
  });

  it("runs every sweep against an empty database without throwing", async () => {
    // An empty org is the state a fresh deployment is in on its first cron
    // tick, and a sweep that only works on populated data fails exactly then.
    const results = await runAllCron(env, new Date().toISOString());
    for (const [name, count] of Object.entries(results)) {
      expect(count, `${name} threw`).toBeGreaterThanOrEqual(0);
    }
  });

  it("only emits catalogued event types", async () => {
    await runAllCron(env, new Date().toISOString());
    const { results } = await env.DB.prepare("SELECT DISTINCT type FROM domain_event_record").all<{ type: string }>();
    const known = new Set<string>(EVENT_TYPES);
    for (const row of results) {
      expect(known.has(row.type), `${row.type} is not in the catalogue`).toBe(true);
    }
  });
});
