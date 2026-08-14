-- 0011 — Drop `org_id` as a scoping column (01, "Tenancy"; R9 amended).
--
-- INV-01-16 has always guaranteed exactly one Organization per deployment,
-- enforced by `bootstrap_state`'s single-row primary key (0005). `org_id` was
-- therefore a column whose value was the same on every row of every table, and
-- `WHERE org_id = ?` a predicate that could never exclude anything. R9 kept it
-- on the argument that a future hosted mode would need it; R9 is amended to
-- drop it, on the argument that a column carrying one distinct value is not
-- evidence that the code above it is actually tenant-safe.
--
-- What is NOT dropped, and why:
--
--   * `organization` itself. It is the deployment's settings row — name, slug,
--     default timezone, contact email, `settings` — and `/setup` still creates
--     exactly one.
--   * `domain_event_record.org_id`. That column is not scoping; it is the
--     persisted copy of a *published* field of the domain event envelope
--     (10-domain-events.md, "Envelope"), which external webhook consumers
--     receive. Removing a field from an event is a major version of that event
--     type, and here it would be a major version of every type in the
--     catalogue. It stays, and `domain_event_org_idx` is re-pointed off it
--     because an index leading with a constant column can serve no query.
--   * `role_grant.scope_id`. For a grant with `scope_type = 'org'` this holds
--     the organization's id (INV-01-6) and authorization still compares it.
--     That is grant validation, not query scoping.
--
-- Reversible in shape but not in data: re-adding the columns is mechanical
-- (see the Down block at the foot), and every value they held was the single
-- organization's id, so nothing is lost that `SELECT id FROM organization`
-- cannot reconstruct.

-- ---------------------------------------------------------------------------
-- 1. Indexes first. SQLite refuses ALTER TABLE ... DROP COLUMN while the
--    column is indexed, so each index leading with `org_id` is dropped, and
--    the ones that were doing real work beyond scoping are recreated without
--    it. `person_org_idx` and `asset_org_idx` are not recreated: single-column
--    indexes on a constant, they selected every row of their table.
-- ---------------------------------------------------------------------------
DROP INDEX person_org_idx;
DROP INDEX asset_org_idx;

DROP INDEX invitation_email_idx;
CREATE INDEX invitation_email_idx ON invitation(email);

-- One active person per email address. The partial clause is what makes a
-- merged or soft-deleted person stop holding their address, and it is carried
-- over verbatim (INV-01-9).
DROP INDEX person_org_email_uq;
CREATE UNIQUE INDEX person_email_uq ON person(email)
  WHERE deleted_at IS NULL AND merged_into_person_id IS NULL;

DROP INDEX integration_default_uq;
CREATE UNIQUE INDEX integration_default_uq
  ON integration(capability, COALESCE(event_id, ''))
  WHERE is_default_for_capability = 1;

DROP INDEX notification_template_uq;
CREATE UNIQUE INDEX notification_template_uq
  ON notification_template(COALESCE(event_id, ''), key, locale);

DROP INDEX external_record_link_subject_idx;
CREATE INDEX external_record_link_subject_idx
  ON external_record_link(subject_type, subject_id);

-- The uniqueness these two enforce is unchanged in meaning: one org means
-- "unique slug per org" and "unique slug" are the same rule. Both stay partial
-- on `deleted_at IS NULL`, so a soft-deleted row still frees its slug.
DROP INDEX event_org_slug_uq;
CREATE UNIQUE INDEX event_slug_uq ON event(slug) WHERE deleted_at IS NULL;

DROP INDEX sponsor_org_slug_uq;
CREATE UNIQUE INDEX sponsor_slug_uq ON sponsor(slug) WHERE deleted_at IS NULL;

DROP INDEX custom_field_key_uq;
CREATE UNIQUE INDEX custom_field_key_uq ON custom_field_definition(subject_type, key);

DROP INDEX audit_org_idx;
CREATE INDEX audit_created_idx ON audit_log(created_at);

DROP INDEX sync_mapping_org_idx;
CREATE INDEX sync_mapping_active_idx ON sync_mapping(is_active);

-- Keeps its column (see the header) but not an index that leads with it.
DROP INDEX domain_event_org_idx;
CREATE INDEX domain_event_occurred_idx ON domain_event_record(occurred_at);

-- ---------------------------------------------------------------------------
-- 2. `notification_suppression` is rebuilt rather than altered: `org_id` is
--    part of its PRIMARY KEY and SQLite cannot DROP COLUMN through one. The
--    key becomes (email, category), which is what it always meant.
--    Nothing references this table, so the drop-and-rename needs no foreign
--    key dance.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_suppression_new (
  email      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'all',
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (email, category)
);
INSERT INTO notification_suppression_new (email, category, reason, created_at)
  SELECT email, category, reason, created_at FROM notification_suppression;
DROP TABLE notification_suppression;
ALTER TABLE notification_suppression_new RENAME TO notification_suppression;

-- ---------------------------------------------------------------------------
-- 3. The column itself, from every table that carried it for scoping.
-- ---------------------------------------------------------------------------
ALTER TABLE api_key                  DROP COLUMN org_id;
ALTER TABLE asset                    DROP COLUMN org_id;
ALTER TABLE audit_log                DROP COLUMN org_id;
ALTER TABLE auth_session             DROP COLUMN org_id;
ALTER TABLE bulk_import              DROP COLUMN org_id;
ALTER TABLE campaign                 DROP COLUMN org_id;
ALTER TABLE contact_segment          DROP COLUMN org_id;
ALTER TABLE custom_field_definition  DROP COLUMN org_id;
ALTER TABLE dead_letter              DROP COLUMN org_id;
ALTER TABLE event                    DROP COLUMN org_id;
ALTER TABLE event_participant        DROP COLUMN org_id;
ALTER TABLE export                   DROP COLUMN org_id;
ALTER TABLE external_record_link     DROP COLUMN org_id;
ALTER TABLE integration              DROP COLUMN org_id;
ALTER TABLE invitation               DROP COLUMN org_id;
ALTER TABLE notification_delivery    DROP COLUMN org_id;
ALTER TABLE notification_template    DROP COLUMN org_id;
ALTER TABLE person                   DROP COLUMN org_id;
ALTER TABLE person_merge_candidate   DROP COLUMN org_id;
ALTER TABLE person_note              DROP COLUMN org_id;
ALTER TABLE proposal                 DROP COLUMN org_id;
ALTER TABLE role_grant               DROP COLUMN org_id;
ALTER TABLE session                  DROP COLUMN org_id;
ALTER TABLE sourcing_pipeline        DROP COLUMN org_id;
ALTER TABLE speaker_profile          DROP COLUMN org_id;
ALTER TABLE sponsor                  DROP COLUMN org_id;
ALTER TABLE sync_mapping             DROP COLUMN org_id;
ALTER TABLE sync_run                 DROP COLUMN org_id;
ALTER TABLE task_instance            DROP COLUMN org_id;
ALTER TABLE webhook                  DROP COLUMN org_id;

-- Down (not run automatically; recorded so the change is reversible):
--   ALTER TABLE <each table above> ADD COLUMN org_id TEXT NOT NULL
--     REFERENCES organization(id) DEFAULT '';
--   UPDATE <each table> SET org_id = (SELECT id FROM organization
--     ORDER BY created_at LIMIT 1);
--   CREATE INDEX person_org_idx ON person(org_id);
--   CREATE INDEX asset_org_idx ON asset(org_id);
--   DROP INDEX invitation_email_idx;
--   CREATE INDEX invitation_email_idx ON invitation(org_id, email);
--   DROP INDEX event_slug_uq;
--   CREATE UNIQUE INDEX event_org_slug_uq ON event(org_id, slug)
--     WHERE deleted_at IS NULL;
--   DROP INDEX sponsor_slug_uq;
--   CREATE UNIQUE INDEX sponsor_org_slug_uq ON sponsor(org_id, slug)
--     WHERE deleted_at IS NULL;
--   DROP INDEX custom_field_key_uq;
--   CREATE UNIQUE INDEX custom_field_key_uq
--     ON custom_field_definition(org_id, subject_type, key);
--   DROP INDEX audit_created_idx;
--   CREATE INDEX audit_org_idx ON audit_log(org_id, created_at);
--   DROP INDEX sync_mapping_active_idx;
--   CREATE INDEX sync_mapping_org_idx ON sync_mapping(org_id, is_active);
--   DROP INDEX domain_event_occurred_idx;
--   CREATE INDEX domain_event_org_idx
--     ON domain_event_record(org_id, occurred_at);
--   (and rebuild notification_suppression with PRIMARY KEY
--    (org_id, email, category))
