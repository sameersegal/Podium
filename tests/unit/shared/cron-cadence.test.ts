import { describe, expect, it } from "vitest";
import { CRON_JOBS, TRIGGER_MINUTES, isDue } from "@podiumstack/web/consumers/cron.js";

/**
 * The Cron Trigger fires every 15 minutes on the clock (wrangler.jsonc).
 * `runScheduled` (consumers/cron.ts) used to gate each job with modular
 * arithmetic on the absolute epoch minute the trigger fired at — which,
 * because every firing's epoch-minute is already ≡ 0 mod 15, only ever
 * lined up for cadences that are themselves clean multiples of 15 from
 * epoch zero. This simulates a full day of real firings against every
 * declared cadence in `CRON_JOBS` and asserts each job's *realised*
 * interval — the actual gap between the runs `isDue` allows — equals its
 * declared `everyMinutes`, floored at the trigger's own 15-minute cadence.
 */
describe("cron cadence gate", () => {
  it("realises every job's declared everyMinutes over a simulated day of 15-minute firings", () => {
    const dayMinutes = 24 * 60;
    const lastRun = new Map<string, number>(); // job name -> ms of its last run
    const runTimesMs = new Map<string, number[]>();

    for (let minute = 0; minute <= dayMinutes; minute += TRIGGER_MINUTES) {
      const nowMs = minute * 60_000;
      for (const job of CRON_JOBS) {
        const last = lastRun.get(job.name);
        const dueAt = last == null ? null : new Date(last).toISOString();
        if (!isDue(dueAt, job.everyMinutes, nowMs)) continue;
        lastRun.set(job.name, nowMs);
        const times = runTimesMs.get(job.name) ?? [];
        times.push(nowMs);
        runTimesMs.set(job.name, times);
      }
    }

    expect(CRON_JOBS.length).toBeGreaterThan(0);
    for (const job of CRON_JOBS) {
      const times = runTimesMs.get(job.name) ?? [];
      const expectedIntervalMinutes = Math.max(job.everyMinutes, TRIGGER_MINUTES);
      const expectedRuns = Math.floor(dayMinutes / expectedIntervalMinutes) + 1;

      // Realised interval: the gap between consecutive runs, which should be
      // exactly the declared cadence (floored at the trigger) every time —
      // not just on average.
      expect(times.length, `${job.name}: ran ${times.length} times over the day, expected ${expectedRuns}`).toBe(
        expectedRuns,
      );
      for (let i = 1; i < times.length; i++) {
        const gapMinutes = (times[i] - times[i - 1]) / 60_000;
        expect(gapMinutes, `${job.name}: gap between run ${i - 1} and ${i}`).toBe(expectedIntervalMinutes);
      }
    }
  });

  it("INV: a job with no prior run is always due", () => {
    expect(isDue(null, 24 * 60, 0)).toBe(true);
  });

  it("a job cannot run more often than the 15-minute trigger even when it declares a shorter cadence", () => {
    const t0 = new Date(0).toISOString();
    // Declared every 1 minute; only 14 minutes have elapsed — still not due,
    // because the trigger itself has not fired again yet.
    expect(isDue(t0, 1, 14 * 60_000)).toBe(false);
    expect(isDue(t0, 1, 15 * 60_000)).toBe(true);
  });
});
