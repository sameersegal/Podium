/**
 * Per-request D1 statement capture, outside production.
 *
 * `countingEnv` (http/context.ts) already answers "how many statements did this
 * request prepare" and puts the number on every response as
 * `x-podium-d1-queries`. That number tells you a screen is expensive; it never
 * tells you *what* it spent the budget on, so every investigation of a hot
 * screen has so far started by reading the code and guessing.
 *
 * This records the statement text alongside the count, so the answer is
 * readable instead of inferred: eleven identical `SELECT * FROM person WHERE
 * id = ?` is an N+1 and one `SELECT ... IN (?,?,…)` is not, and no amount of
 * staring at a single integer distinguishes them.
 *
 * Three properties keep it honest:
 *
 *   * **Opt-in per request.** Nothing is captured unless the caller sends
 *     `x-podium-profile: 1`, so the ordinary dev request pays one increment,
 *     exactly as before.
 *   * **Never in production.** Same rule, and the same reason, as the header
 *     it extends: this is a fact about the shape of our code, and an attacker
 *     is the only caller who benefits from being told it.
 *   * **Bounded.** A ring buffer of the last `MAX_RECORDS` profiled requests,
 *     drained by `/dev/profile`. A profiler that grows without limit is a
 *     memory leak wearing a lab coat.
 */

export interface ProfileRecord {
  method: string;
  path: string;
  status: number;
  count: number;
  /** How many times the request actually went to D1 — a `batch` is one. */
  roundTrips: number;
  /** Statement text in the order the request prepared it. Already parameterised. */
  statements: string[];
  /** Wall-clock milliseconds spent inside the handler. */
  ms: number;
}

/** The header a caller sends to ask for capture, and the one it gets back. */
export const PROFILE_REQUEST_HEADER = "x-podium-profile";

const MAX_RECORDS = 2000;

const RECORDS: ProfileRecord[] = [];

/** Whether this request asked to be profiled. Non-production only. */
export function profileRequested(req: Request, environment: string): boolean {
  if (environment === "production") return false;
  return req.headers.has(PROFILE_REQUEST_HEADER);
}

export function recordProfile(record: ProfileRecord): void {
  RECORDS.push(record);
  if (RECORDS.length > MAX_RECORDS) RECORDS.splice(0, RECORDS.length - MAX_RECORDS);
}

/** Hands back everything captured since the last drain, and empties the buffer. */
export function drainProfiles(): ProfileRecord[] {
  const out = RECORDS.slice();
  RECORDS.length = 0;
  return out;
}
