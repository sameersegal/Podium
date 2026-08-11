-- 0009 — `form_field.identifies_speaker`.
--
-- 05 — Review & Selection, "Fairness rules made explicit": "Under
-- `double_blind`, reviewers do not see speaker names, bios, affiliations,
-- links, or any answer whose field is flagged `pii`."
--
-- Names, affiliations and links are `Person` fields, and the projection already
-- drops the whole roster in a blind round. Bios are not: a "Speaker bio" is an
-- ordinary long-text answer on the form, and it is `public` rather than `pii`
-- because it is published beside the talk on the schedule. So the one answer
-- most certain to name its author was the one the blind projection kept.
--
-- `pii` could not carry this: it means "redact from public responses,
-- snapshots and logs", which is the opposite of what a published bio needs.
-- This flag says something different — "this answer identifies its speaker, so
-- a blind round must not show it" — and the two are independent.
--
-- Purely additive: one column, default 0, no backfill. A form that never sets
-- it behaves exactly as it did.
--
-- Reversible on any database that supports it: `ALTER TABLE form_field DROP
-- COLUMN identifies_speaker`.

ALTER TABLE form_field ADD COLUMN identifies_speaker INTEGER NOT NULL DEFAULT 0;

-- Down (not run automatically; recorded so the change is reversible):
--   ALTER TABLE form_field DROP COLUMN identifies_speaker;
