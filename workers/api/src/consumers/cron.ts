/**
 * Cron Triggers produce Queue messages — 09, platform mapping.
 *
 * Nothing here does long work itself: each sweep finds the rows that have
 * become due and emits the domain event that drives the reaction. That keeps
 * "what happened" in the event log rather than inside a timer.
 */

import type { Env } from "@podiumstack/data/context.js";
import { D1Db } from "@podiumstack/data/db.js";

export interface CronJob {
  name: string;
  /** Run at most this often, in minutes. */
  everyMinutes: number;
  run(env: Env, now: string): Promise<number>;
}

import { SUBMISSION_CRON } from "../contexts/submissions/cron.js";
import { SPONSORSHIP_CRON } from "../contexts/sponsorship/cron.js";
import { ONBOARDING_CRON } from "../contexts/onboarding/cron.js";
import { PROGRAM_CRON } from "../contexts/program/cron.js";
import { REVIEW_CRON } from "../contexts/review/cron.js";
import { PLATFORM_CRON } from "../contexts/platform/cron.js";
import { CRM_CRON } from "../contexts/crm/cron.js";

export const CRON_JOBS: CronJob[] = [
  ...SUBMISSION_CRON,
  ...SPONSORSHIP_CRON,
  ...ONBOARDING_CRON,
  ...PROGRAM_CRON,
  ...REVIEW_CRON,
  ...PLATFORM_CRON,
  ...CRM_CRON,
];

/** The Cron Trigger's own cadence (`wrangler.jsonc`, every 15 minutes) — no job can run more often than this fires, whatever it declares. */
export const TRIGGER_MINUTES = 15;

/**
 * Whether `job` is due, given it last ran at `lastRunAt` (or never — `null`).
 *
 * Replaces a defect: the previous gate compared
 * `Math.floor(scheduledTime / 60000) % Math.max(1, Math.round(everyMinutes / 15))`
 * — modular arithmetic on the *absolute epoch minute* the trigger happened to
 * fire at. Because the trigger fires every 15 minutes on the clock, every
 * firing's epoch-minute is already ≡ 0 mod 15, so that modulus only ever
 * lined up for cadences that are themselves clean multiples of 15 measured
 * from epoch zero. Simulated
 * over a day (see the accompanying test), the result was that the 6h job ran
 * every 2h, the 12h job every 4h, the 24h job every 8h, and the two
 * sub-15-minute jobs (1m, 5m) ran on every tick — 5 of 10 declared cadences
 * wrong. Comparing elapsed time since *this job's own* last run has none of
 * that: it depends only on when the job itself last ran, never on what
 * multiple of 15 the wall clock is currently at.
 */
export function isDue(lastRunAt: string | null, everyMinutes: number, nowMs: number): boolean {
  if (lastRunAt == null) return true; // never run before — due immediately
  const intervalMinutes = Math.max(everyMinutes, TRIGGER_MINUTES);
  return nowMs - new Date(lastRunAt).getTime() >= intervalMinutes * 60_000;
}

/**
 * `cron_job_run` (migrations/0006) rather than `CACHE` (the KV binding used
 * for the published-snapshot cache and the idempotency replay cache): KV
 * reads are only eventually consistent with a recent write from a different
 * colo — a staleness window the 09 platform mapping accepts for a snapshot
 * cache invalidated by `content_etag`, but not for "has this job already run
 * in the last N minutes", where a stale read means running a send-driving
 * job (`platform.send_scheduled_campaigns`, the onboarding reminder sweep)
 * again sooner than intended. D1 gives a real read-after-write for the small
 * number of rows (one per job) this needs.
 */
export async function runScheduled(env: Env, scheduledTime: number): Promise<Record<string, number>> {
  const now = new Date(scheduledTime).toISOString();
  const db = new D1Db(env.DB);
  const rows = await db.raw<{ name: string; last_run_at: string }>("SELECT name, last_run_at FROM cron_job_run");
  const lastRun = new Map(rows.map((r) => [r.name, r.last_run_at]));

  const results: Record<string, number> = {};
  for (const job of CRON_JOBS) {
    if (!isDue(lastRun.get(job.name) ?? null, job.everyMinutes, scheduledTime)) continue;
    try {
      results[job.name] = await job.run(env, now);
    } catch (err) {
      console.error("cron job failed", { job: job.name, error: String(err) });
      results[job.name] = -1;
    }
    // Recorded after the attempt, success or failure alike: a job that keeps
    // throwing should wait out its own cadence before the next attempt, not
    // hot-loop on every 15-minute tick.
    await db.rawRun(
      `INSERT INTO cron_job_run (name, last_run_at) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at`,
      [job.name, now],
    );
  }
  return results;
}

/**
 * Run every job regardless of cadence — used by tests and the admin "run
 * now" (`POST /dev/cron`). Deliberately does not read or write
 * `cron_job_run`: bypassing the cadence must not perturb the real schedule,
 * so the next Cron Trigger still runs (or doesn't) exactly as if this had
 * never been called.
 */
export async function runAllCron(env: Env, now: string): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  for (const job of CRON_JOBS) {
    results[job.name] = await job.run(env, now);
  }
  return results;
}
