-- 0008 — `event.cloned_from_event_id`.
--
-- 02 — Event Configuration, "Starting an event": an event is provisioned from
-- the starter blueprint, from a clone of an earlier edition, or empty. Only the
-- clone leaves a trace, and this is it (INV-02-15). Provenance only: no read
-- path follows the pointer, so a source event that is later archived or removed
-- costs nothing but a dangling id.
--
-- Purely additive: one nullable column on `event`, no backfill — every event
-- that existed before this migration was not cloned, which is what NULL says.
--
-- Reversible on any database that supports it: `ALTER TABLE event DROP COLUMN
-- cloned_from_event_id`.

ALTER TABLE event ADD COLUMN cloned_from_event_id TEXT REFERENCES event(id);

-- Down (not run automatically; recorded so the change is reversible):
--   ALTER TABLE event DROP COLUMN cloned_from_event_id;
