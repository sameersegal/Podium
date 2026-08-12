-- 0010 — two-way sync with an external table tool (09, "Two-way sync"; R31).
--
-- Three tables. `sync_mapping` is what an organizer configures: one Podium
-- subject mirrored into one external table, with a per-field direction.
-- `external_record_link` is the join between one record and its external row,
-- and it carries the three columns the whole design rests on —
-- `last_pushed_hash`, `last_pulled_hash` and `last_pushed_version`.
-- `sync_run` is the receipt for one sweep in one direction.
--
-- Purely additive: three new tables, no column added to and no row touched in
-- any existing one. A deployment with no `sync` integration installed sees no
-- behaviour change at all.
--
-- Reversible: DROP TABLE sync_run; DROP TABLE external_record_link;
-- DROP TABLE sync_mapping;

CREATE TABLE sync_mapping (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization(id),
  integration_id       TEXT NOT NULL REFERENCES integration(id),
  event_id             TEXT,
  subject              TEXT NOT NULL,
  external_table_id    TEXT NOT NULL,
  external_table_name  TEXT NOT NULL DEFAULT '',
  field_map            TEXT NOT NULL DEFAULT '[]',
  include_pii          INTEGER NOT NULL DEFAULT 0,
  filter               TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1,
  last_cursor          TEXT,
  last_push_at         TEXT,
  last_pull_at         TEXT,
  created_by_person_id TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);

-- One mapping per (integration, subject, scope). Two mappings pushing the same
-- records into the same base would each see the other's writes as an inbound
-- change, and INV-09-19's hash check is per link — it cannot tell them apart.
CREATE UNIQUE INDEX sync_mapping_subject_uq
  ON sync_mapping(integration_id, subject, COALESCE(event_id, ''));
CREATE INDEX sync_mapping_org_idx ON sync_mapping(org_id, is_active);

CREATE TABLE external_record_link (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organization(id),
  mapping_id          TEXT NOT NULL REFERENCES sync_mapping(id),
  subject_type        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  external_id         TEXT,
  last_pushed_hash    TEXT,
  last_pulled_hash    TEXT,
  -- INV-09-18: the subject's row_version at the last successful push. An
  -- inbound change is applied only while this still matches, which is what
  -- makes "Podium is the system of record" a check rather than a promise.
  last_pushed_version INTEGER,
  last_pushed_at      TEXT,
  last_pulled_at      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_push',
  conflict_payload    TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- One link per record per mapping, in both directions. The second index is
-- what an inbound change looks itself up by, and making it unique means a
-- provider that reuses a record id cannot silently fan one external row onto
-- two Podium records.
CREATE UNIQUE INDEX external_record_link_subject_uq
  ON external_record_link(mapping_id, subject_type, subject_id);
CREATE UNIQUE INDEX external_record_link_external_uq
  ON external_record_link(mapping_id, external_id)
  WHERE external_id IS NOT NULL;
-- The push sweep's working query: everything dirty on one mapping.
CREATE INDEX external_record_link_pending_idx
  ON external_record_link(mapping_id, status);
-- INV-09-22 walks every link for one person, across mappings, at erasure.
CREATE INDEX external_record_link_subject_idx
  ON external_record_link(org_id, subject_type, subject_id);

CREATE TABLE sync_run (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization(id),
  mapping_id    TEXT NOT NULL REFERENCES sync_mapping(id),
  direction     TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  counts        TEXT NOT NULL DEFAULT '{}',
  cursor_before TEXT,
  cursor_after  TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error         TEXT
);

CREATE INDEX sync_run_mapping_idx ON sync_run(mapping_id, started_at);

-- Down (not run automatically; recorded so the change is reversible):
--   DROP TABLE sync_run;
--   DROP TABLE external_record_link;
--   DROP TABLE sync_mapping;
