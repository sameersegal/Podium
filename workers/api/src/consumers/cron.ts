/**
 * Cron Triggers produce Queue messages — 09, platform mapping.
 *
 * Nothing here does long work itself: each sweep finds the rows that have
 * become due and emits the domain event that drives the reaction. That keeps
 * "what happened" in the event log rather than inside a timer.
 */

import type { Env } from "@podiumconf/data/context.js";

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

export async function runScheduled(env: Env, scheduledTime: number): Promise<Record<string, number>> {
  const now = new Date(scheduledTime).toISOString();
  const minutes = Math.floor(scheduledTime / 60000);
  const results: Record<string, number> = {};
  for (const job of CRON_JOBS) {
    if (minutes % Math.max(1, Math.round(job.everyMinutes / 15)) !== 0) continue;
    try {
      results[job.name] = await job.run(env, now);
    } catch (err) {
      console.error("cron job failed", { job: job.name, error: String(err) });
      results[job.name] = -1;
    }
  }
  return results;
}

/** Run every job regardless of cadence — used by tests and the admin "run now". */
export async function runAllCron(env: Env, now: string): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  for (const job of CRON_JOBS) {
    results[job.name] = await job.run(env, now);
  }
  return results;
}
