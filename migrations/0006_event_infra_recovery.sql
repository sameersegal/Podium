-- 0006 — Operational recovery for the event infrastructure: dead-letter
-- arrivals and cron cadence tracking.
--
-- Neither table is a modelled entity — same footing as `event_reaction_log`
-- and `bootstrap_state` (docs/domain/README.md: table layout and indexes are
-- left to the implementation). Purely additive: two new tables, nothing
-- changed or dropped on any existing one.
--
-- Reversible with the two DROP TABLE statements at the foot of this file.

-- `podium-dlq` is the dead-letter queue for both `podium-events` and
-- `podium-delivery` (wrangler.jsonc). A message that lands here has already
-- exhausted `max_retries` on its home queue, so this is the last record that
-- it happened at all — the repo's own guidance is "log DLQ arrivals loudly"
-- (.claude/agents/implementer.md). `body` keeps the whole message so an
-- operator can inspect and re-drive it; `event_id`/`event_type` are populated
-- only when the body is a DomainEvent, to make the common case searchable
-- without parsing JSON.
CREATE TABLE dead_letter (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_queue TEXT NOT NULL,          -- 'podium-events' | 'podium-delivery' | 'unknown' — inferred from body shape (Cloudflare does not report a DLQ message's origin queue)
  message_kind TEXT NOT NULL,          -- 'domain_event' | 'delivery' | 'unknown'
  event_id     TEXT,
  event_type   TEXT,
  org_id       TEXT,
  body         TEXT NOT NULL,          -- JSON.stringify(message.body)
  arrived_at   TEXT NOT NULL
);
CREATE INDEX dead_letter_arrived_idx ON dead_letter(arrived_at);
CREATE INDEX dead_letter_event_idx ON dead_letter(event_id);

-- Cadence bookkeeping for `runScheduled` (consumers/cron.ts). The Cron
-- Trigger fires every 15 minutes (wrangler.jsonc); a job with a longer
-- declared `everyMinutes` only runs once its elapsed time since `last_run_at`
-- reaches that cadence. One row per job name, upserted after every attempt
-- (success or failure) so a throwing job does not hot-loop on the next tick.
CREATE TABLE cron_job_run (
  name        TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);

-- Down (not run automatically; recorded so the change is reversible):
--   DROP TABLE dead_letter;
--   DROP TABLE cron_job_run;
