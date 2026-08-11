-- 0007 — Index `domain_event_record.causation_id`.
--
-- Purely additive: one index, nothing else touched. Existed as a column
-- since 0001 but with no index, so following a cascade ("what did this event
-- cause") was a full table scan — fine at the volumes migrations/tests run
-- at, not fine on a deployment with a real event history. `/admin/event-log`
-- (contexts/platform/routes.ts) is the first production read path to walk
-- `causation_id` chains, and `tests/integration/helpers/events.ts`'s `drain`
-- does the same lookup once per hop of every cascade test.
--
-- Reversible: DROP INDEX domain_event_causation_idx.

CREATE INDEX domain_event_causation_idx ON domain_event_record(causation_id);

-- Down (not run automatically; recorded so the change is reversible):
--   DROP INDEX domain_event_causation_idx;
