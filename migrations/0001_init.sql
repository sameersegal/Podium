-- Podium — initial schema.
--
-- One table per `<!-- entity: -->` anchor in docs/domain/. Fields marked `D`
-- (derived) get no column (R8, INV-11-6) except on materialised read models,
-- which are noted where they occur.
--
-- Conventions:
--   * ids are text ULIDs with the documented prefix (11-cross-cutting.md)
--   * instants are ISO-8601 UTC text; calendar dates are YYYY-MM-DD text
--   * `json` and `T[]` fields are JSON text
--   * `row_version` is the optimistic-concurrency counter for aggregate roots
--     (11-cross-cutting.md, "Concurrency"). It is deliberately not called
--     `version`, which several entities already use with a domain meaning.
--   * enum membership is enforced in the domain layer, not by CHECK constraints,
--     so that adding a member (which the model says is always additive) does not
--     require a table rewrite.

-- ===========================================================================
-- 01 — Identity & Access
-- ===========================================================================

CREATE TABLE organization (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  primary_domain    TEXT,
  logo_asset_id     TEXT,
  default_timezone  TEXT NOT NULL,
  contact_email     TEXT NOT NULL,
  settings          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  row_version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE person (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organization(id),
  email                 TEXT NOT NULL,
  email_verified_at     TEXT,
  full_name             TEXT NOT NULL,
  display_name          TEXT,
  pronouns              TEXT,
  timezone              TEXT,
  locale                TEXT,
  status                TEXT NOT NULL DEFAULT 'invited',
  is_placeholder        INTEGER NOT NULL DEFAULT 0,
  merged_into_person_id TEXT,
  tags                  TEXT,
  custom_field_values   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  row_version           INTEGER NOT NULL DEFAULT 1
);
-- INV-01-1: email unique per org among non-deleted, non-merged people.
CREATE UNIQUE INDEX person_org_email_uq
  ON person(org_id, email) WHERE deleted_at IS NULL AND merged_into_person_id IS NULL;
CREATE INDEX person_org_idx ON person(org_id);

CREATE TABLE auth_identity (
  id                    TEXT PRIMARY KEY,
  person_id             TEXT NOT NULL REFERENCES person(id),
  provider              TEXT NOT NULL,
  subject               TEXT NOT NULL,
  credential_hash       TEXT,
  credential_updated_at TEXT,
  email_at_provider     TEXT,
  last_used_at          TEXT,
  created_at            TEXT NOT NULL
);
-- INV-01-2: (provider, subject) globally unique.
CREATE UNIQUE INDEX auth_identity_provider_subject_uq ON auth_identity(provider, subject);
CREATE INDEX auth_identity_person_idx ON auth_identity(person_id);

CREATE TABLE speaker_profile (
  id                       TEXT PRIMARY KEY,
  person_id                TEXT NOT NULL REFERENCES person(id),
  org_id                   TEXT NOT NULL REFERENCES organization(id),
  headline                 TEXT,
  job_title                TEXT,
  company                  TEXT,
  bio                      TEXT,
  short_bio                TEXT,
  headshot_asset_id        TEXT,
  location                 TEXT,
  phone                    TEXT,
  dietary_notes            TEXT,
  accessibility_notes      TEXT,
  visibility               TEXT NOT NULL DEFAULT '{}',
  is_listed                INTEGER NOT NULL DEFAULT 1,
  last_edited_by_person_id TEXT,
  updated_at               TEXT NOT NULL,
  row_version              INTEGER NOT NULL DEFAULT 1
);
-- INV-01-3: at most one SpeakerProfile per person.
CREATE UNIQUE INDEX speaker_profile_person_uq ON speaker_profile(person_id);

CREATE TABLE profile_link (
  id                 TEXT PRIMARY KEY,
  speaker_profile_id TEXT NOT NULL REFERENCES speaker_profile(id),
  kind               TEXT NOT NULL,
  url                TEXT NOT NULL,
  label              TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  is_public          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX profile_link_profile_idx ON profile_link(speaker_profile_id);

CREATE TABLE event_participant (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organization(id),
  event_id              TEXT NOT NULL,
  person_id             TEXT NOT NULL REFERENCES person(id),
  kind                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  source                TEXT NOT NULL,
  portal_access         TEXT NOT NULL DEFAULT 'none',
  portal_invited_at     TEXT,
  portal_first_seen_at  TEXT,
  custom_field_values   TEXT,
  added_by_person_id    TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  row_version           INTEGER NOT NULL DEFAULT 1
);
-- INV-01-11: one EventParticipant per (event, person).
CREATE UNIQUE INDEX event_participant_uq ON event_participant(event_id, person_id);
CREATE INDEX event_participant_person_idx ON event_participant(person_id);

CREATE TABLE person_note (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organization(id),
  person_id        TEXT NOT NULL REFERENCES person(id),
  event_id         TEXT,
  body             TEXT NOT NULL,
  author_person_id TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX person_note_person_idx ON person_note(person_id);

CREATE TABLE role_grant (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organization(id),
  person_id             TEXT NOT NULL REFERENCES person(id),
  role                  TEXT NOT NULL,
  scope_type            TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  granted_by_person_id  TEXT NOT NULL,
  granted_at            TEXT NOT NULL,
  expires_at            TEXT,
  revoked_at            TEXT
);
CREATE INDEX role_grant_person_idx ON role_grant(person_id);
CREATE INDEX role_grant_scope_idx ON role_grant(scope_type, scope_id);

CREATE TABLE invitation (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization(id),
  email                TEXT NOT NULL,
  person_id            TEXT,
  kind                 TEXT NOT NULL,
  intended_role        TEXT,
  scope_type           TEXT,
  scope_id             TEXT,
  context_type         TEXT,
  context_id           TEXT,
  token_hash           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  expires_at           TEXT NOT NULL,
  invited_by_person_id TEXT NOT NULL,
  accepted_at          TEXT,
  created_at           TEXT NOT NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX invitation_token_uq ON invitation(token_hash);
CREATE INDEX invitation_email_idx ON invitation(org_id, email);

-- Derived read model (01, "Person merge"): pairs are recomputed, but a
-- dismissal must be remembered so the same pair is not offered forever.
CREATE TABLE person_merge_candidate (
  org_id                 TEXT NOT NULL,
  person_id              TEXT NOT NULL,
  candidate_person_id    TEXT NOT NULL,
  signals                TEXT NOT NULL DEFAULT '[]',
  confidence             REAL NOT NULL DEFAULT 0,
  dismissed_by_person_id TEXT,
  dismissed_at           TEXT,
  created_at             TEXT NOT NULL,
  PRIMARY KEY (person_id, candidate_person_id)
);

-- ===========================================================================
-- 02 — Event Configuration
-- ===========================================================================

CREATE TABLE event (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organization(id),
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  edition      TEXT,
  tagline      TEXT,
  description  TEXT,
  timezone     TEXT NOT NULL,
  starts_on    TEXT NOT NULL,
  ends_on      TEXT NOT NULL,
  venue_id     TEXT,
  mode         TEXT NOT NULL DEFAULT 'in_person',
  website_url  TEXT,
  logo_asset_id TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',
  visibility   TEXT NOT NULL DEFAULT 'private',
  settings     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT,
  deleted_at   TEXT,
  row_version  INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX event_org_slug_uq ON event(org_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE event_day (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES event(id),
  date       TEXT NOT NULL,
  label      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_public  INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX event_day_uq ON event_day(event_id, date);

CREATE TABLE track (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL REFERENCES event(id),
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  description          TEXT,
  color                TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  target_session_count INTEGER,
  is_public            INTEGER NOT NULL DEFAULT 1,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX track_event_slug_uq ON track(event_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE session_format (
  id                        TEXT PRIMARY KEY,
  event_id                  TEXT NOT NULL REFERENCES event(id),
  name                      TEXT NOT NULL,
  slug                      TEXT NOT NULL,
  description               TEXT,
  default_duration_minutes  INTEGER NOT NULL,
  min_duration_minutes      INTEGER,
  max_duration_minutes      INTEGER,
  max_speakers              INTEGER NOT NULL DEFAULT 1,
  eligible_origins          TEXT NOT NULL DEFAULT '["cfp"]',
  requires_review           INTEGER NOT NULL DEFAULT 1,
  requires_recording_consent INTEGER NOT NULL DEFAULT 0,
  capacity_policy           TEXT NOT NULL DEFAULT 'open',
  sort_order                INTEGER NOT NULL DEFAULT 0,
  is_public                 INTEGER NOT NULL DEFAULT 1,
  deleted_at                TEXT
);
CREATE UNIQUE INDEX session_format_event_slug_uq ON session_format(event_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE venue (
  id       TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES event(id),
  name     TEXT NOT NULL,
  address  TEXT,
  map_url  TEXT,
  timezone TEXT
);

CREATE TABLE room (
  id               TEXT PRIMARY KEY,
  venue_id         TEXT NOT NULL REFERENCES venue(id),
  event_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL,
  capacity         INTEGER,
  floor            TEXT,
  av_capabilities  TEXT NOT NULL DEFAULT '[]',
  default_track_id TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_public        INTEGER NOT NULL DEFAULT 1,
  deleted_at       TEXT
);
CREATE UNIQUE INDEX room_venue_slug_uq ON room(venue_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE call_for_proposals (
  id                      TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL REFERENCES event(id),
  name                    TEXT NOT NULL,
  slug                    TEXT NOT NULL,
  audience                TEXT NOT NULL DEFAULT 'public',
  intro_markdown          TEXT,
  guidelines_url          TEXT,
  opens_at                TEXT NOT NULL,
  closes_at               TEXT NOT NULL,
  grace_period_minutes    INTEGER NOT NULL DEFAULT 0,
  late_submission_policy  TEXT NOT NULL DEFAULT 'reject',
  max_proposals_per_person INTEGER,
  allow_edit_after_submit INTEGER NOT NULL DEFAULT 1,
  withdraw_allowed_until  TEXT NOT NULL DEFAULT 'always',
  active_form_id          TEXT,
  notify_on_submit        INTEGER NOT NULL DEFAULT 1,
  closed_early_at         TEXT,
  published_at            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  row_version             INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX cfp_event_slug_uq ON call_for_proposals(event_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE cfp_format_option (
  id                       TEXT PRIMARY KEY,
  cfp_id                   TEXT NOT NULL REFERENCES call_for_proposals(id),
  session_format_id        TEXT NOT NULL REFERENCES session_format(id),
  is_available             INTEGER NOT NULL DEFAULT 1,
  max_proposals_per_person INTEGER,
  closes_at_override       TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX cfp_format_option_uq ON cfp_format_option(cfp_id, session_format_id);

CREATE TABLE cfp_track_option (
  id                       TEXT PRIMARY KEY,
  cfp_id                   TEXT NOT NULL REFERENCES call_for_proposals(id),
  track_id                 TEXT NOT NULL REFERENCES track(id),
  is_available             INTEGER NOT NULL DEFAULT 1,
  max_proposals_per_person INTEGER,
  closes_at_override       TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX cfp_track_option_uq ON cfp_track_option(cfp_id, track_id);

CREATE TABLE submission_form (
  id           TEXT PRIMARY KEY,
  cfp_id       TEXT NOT NULL REFERENCES call_for_proposals(id),
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  row_version  INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX submission_form_version_uq ON submission_form(cfp_id, version);
-- INV-02-5: exactly one published SubmissionForm per CFP at a time.
CREATE UNIQUE INDEX submission_form_published_uq ON submission_form(cfp_id) WHERE status = 'published';

CREATE TABLE form_step (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL REFERENCES submission_form(id),
  key          TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  visible_when TEXT,
  is_optional  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX form_step_key_uq ON form_step(form_id, key);

CREATE TABLE form_field (
  id           TEXT PRIMARY KEY,
  step_id      TEXT NOT NULL REFERENCES form_step(id),
  form_id      TEXT NOT NULL,
  key          TEXT NOT NULL,
  label        TEXT NOT NULL,
  help_text    TEXT,
  placeholder  TEXT,
  type         TEXT NOT NULL,
  options      TEXT,
  is_required  INTEGER NOT NULL DEFAULT 0,
  validation   TEXT,
  visible_when TEXT,
  maps_to      TEXT NOT NULL DEFAULT 'none',
  audience     TEXT NOT NULL DEFAULT 'public',
  pii          INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
-- INV-02-6: FormField.key unique within a form.
CREATE UNIQUE INDEX form_field_key_uq ON form_field(form_id, key);
CREATE INDEX form_field_step_idx ON form_field(step_id);

-- ===========================================================================
-- 03 — Sponsorship
-- ===========================================================================

CREATE TABLE sponsor (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organization(id),
  name            TEXT NOT NULL,
  display_name    TEXT,
  slug            TEXT NOT NULL,
  website_url     TEXT,
  logo_asset_id   TEXT,
  logo_dark_asset_id TEXT,
  description     TEXT,
  industry_tags   TEXT,
  internal_notes  TEXT,
  status          TEXT NOT NULL DEFAULT 'prospect',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX sponsor_org_slug_uq ON sponsor(org_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE sponsorship_tier (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES event(id),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  is_public   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX tier_event_slug_uq ON sponsorship_tier(event_id, slug);

CREATE TABLE tier_entitlement_template (
  id                 TEXT PRIMARY KEY,
  tier_id            TEXT NOT NULL REFERENCES sponsorship_tier(id),
  entitlement_type   TEXT NOT NULL,
  quantity           INTEGER NOT NULL,
  allowed_format_ids TEXT,
  constraints        TEXT,
  notes              TEXT
);

CREATE TABLE sponsorship (
  id                  TEXT PRIMARY KEY,
  sponsor_id          TEXT NOT NULL REFERENCES sponsor(id),
  event_id            TEXT NOT NULL REFERENCES event(id),
  tier_id             TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  confirmed_at        TEXT,
  contract_reference  TEXT,
  public_from         TEXT,
  internal_notes      TEXT,
  sort_order_override INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  row_version         INTEGER NOT NULL DEFAULT 1
);
-- INV-03-1: one Sponsorship per (sponsor, event).
CREATE UNIQUE INDEX sponsorship_uq ON sponsorship(sponsor_id, event_id);

CREATE TABLE entitlement (
  id                 TEXT PRIMARY KEY,
  sponsorship_id     TEXT NOT NULL REFERENCES sponsorship(id),
  entitlement_type   TEXT NOT NULL,
  quantity           INTEGER NOT NULL,
  allowed_format_ids TEXT,
  constraints        TEXT,
  submission_deadline TEXT,
  expires_at         TEXT,
  source             TEXT NOT NULL DEFAULT 'manual',
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  row_version        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX entitlement_sponsorship_idx ON entitlement(sponsorship_id);
-- consumed_count / remaining are derived from the proposals pointing here
-- (INV-03-3, 11-cross-cutting "Concurrency"): no column, ever.

CREATE TABLE sponsor_contact (
  id                  TEXT PRIMARY KEY,
  sponsor_id          TEXT NOT NULL REFERENCES sponsor(id),
  person_id           TEXT NOT NULL REFERENCES person(id),
  contact_role        TEXT NOT NULL DEFAULT 'primary',
  event_id            TEXT,
  can_submit_sessions INTEGER NOT NULL DEFAULT 1,
  can_manage_contacts INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active',
  invited_at          TEXT,
  accepted_at         TEXT,
  revoked_at          TEXT
);
CREATE INDEX sponsor_contact_person_idx ON sponsor_contact(person_id);
CREATE INDEX sponsor_contact_sponsor_idx ON sponsor_contact(sponsor_id);

-- ===========================================================================
-- 04 — Submissions
-- ===========================================================================

CREATE TABLE proposal (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES organization(id),
  event_id                  TEXT NOT NULL REFERENCES event(id),
  cfp_id                    TEXT NOT NULL REFERENCES call_for_proposals(id),
  form_id                   TEXT NOT NULL,
  reference                 TEXT NOT NULL,
  origin                    TEXT NOT NULL DEFAULT 'cfp',
  submitter_person_id       TEXT NOT NULL,
  sponsor_id                TEXT,
  entitlement_id            TEXT,
  title                     TEXT NOT NULL DEFAULT '',
  abstract                  TEXT NOT NULL DEFAULT '',
  description               TEXT,
  session_format_id         TEXT,
  requested_duration_minutes INTEGER,
  track_id                  TEXT,
  assigned_track_id         TEXT,
  audience_level            TEXT,
  keywords                  TEXT,
  language                  TEXT DEFAULT 'en',
  av_requirements           TEXT,
  recording_consent         TEXT NOT NULL DEFAULT 'unanswered',
  recording_conditions      TEXT,
  coi_disclosure            TEXT,
  status                    TEXT NOT NULL DEFAULT 'draft',
  is_late                   INTEGER NOT NULL DEFAULT 0,
  submitted_at              TEXT,
  last_activity_at          TEXT NOT NULL,
  decision_id               TEXT,
  confirmation_deadline     TEXT,
  session_id                TEXT,
  withdrawn_reason          TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  row_version               INTEGER NOT NULL DEFAULT 1
);
-- INV-04-2: reference unique per event, never reused.
CREATE UNIQUE INDEX proposal_reference_uq ON proposal(event_id, reference);
CREATE INDEX proposal_cfp_idx ON proposal(cfp_id, status);
CREATE INDEX proposal_submitter_idx ON proposal(submitter_person_id);
CREATE INDEX proposal_entitlement_idx ON proposal(entitlement_id);
CREATE INDEX proposal_event_idx ON proposal(event_id, status);

-- Per-event monotonic counter behind `Proposal.reference`. Infrastructure, not
-- a domain entity: the model specifies the reference, not how it is sequenced.
CREATE TABLE event_reference_counter (
  event_id   TEXT PRIMARY KEY,
  event_code TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE proposal_answer (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL REFERENCES proposal(id),
  field_key     TEXT NOT NULL,
  form_field_id TEXT NOT NULL,
  value         TEXT NOT NULL,
  answered_at   TEXT NOT NULL
);
-- INV-04-4: one answer per (proposal, field_key).
CREATE UNIQUE INDEX proposal_answer_uq ON proposal_answer(proposal_id, field_key);

CREATE TABLE proposal_speaker (
  id                   TEXT PRIMARY KEY,
  proposal_id          TEXT NOT NULL REFERENCES proposal(id),
  person_id            TEXT NOT NULL REFERENCES person(id),
  speaker_role         TEXT NOT NULL DEFAULT 'primary',
  sort_order           INTEGER NOT NULL DEFAULT 0,
  invitation_id        TEXT,
  participation_status TEXT NOT NULL DEFAULT 'pending',
  added_by_person_id   TEXT NOT NULL,
  added_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX proposal_speaker_uq ON proposal_speaker(proposal_id, person_id);
CREATE INDEX proposal_speaker_person_idx ON proposal_speaker(person_id);

CREATE TABLE draft_progress (
  proposal_id         TEXT PRIMARY KEY REFERENCES proposal(id),
  current_step_key    TEXT NOT NULL,
  completed_step_keys TEXT NOT NULL DEFAULT '[]',
  furthest_step_key   TEXT NOT NULL,
  last_saved_at       TEXT NOT NULL,
  client_revision     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE proposal_revision (
  id                    TEXT PRIMARY KEY,
  proposal_id           TEXT NOT NULL REFERENCES proposal(id),
  revision_number       INTEGER NOT NULL,
  changed_by_person_id  TEXT NOT NULL,
  change_kind           TEXT NOT NULL,
  diff                  TEXT NOT NULL DEFAULT '{}',
  snapshot              TEXT,
  created_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX proposal_revision_uq ON proposal_revision(proposal_id, revision_number);

-- ===========================================================================
-- 05 — Review & Selection
-- ===========================================================================

CREATE TABLE rubric (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES event(id),
  name             TEXT NOT NULL,
  description      TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  overall_scale    TEXT NOT NULL DEFAULT 'recommendation',
  requires_comment INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  row_version      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rubric_criterion (
  id          TEXT PRIMARY KEY,
  rubric_id   TEXT NOT NULL REFERENCES rubric(id),
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL DEFAULT 'numeric',
  scale_min   INTEGER,
  scale_max   INTEGER,
  options     TEXT,
  max_length  INTEGER,
  weight      REAL NOT NULL DEFAULT 1.0,
  is_required INTEGER NOT NULL DEFAULT 1,
  allows_na   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX rubric_criterion_key_uq ON rubric_criterion(rubric_id, key);

CREATE TABLE review_round (
  id                              TEXT PRIMARY KEY,
  event_id                        TEXT NOT NULL REFERENCES event(id),
  name                            TEXT NOT NULL,
  sequence                        INTEGER NOT NULL DEFAULT 1,
  rubric_id                       TEXT NOT NULL,
  scope                           TEXT,
  anonymity                       TEXT NOT NULL DEFAULT 'double_blind',
  opens_at                        TEXT NOT NULL,
  closes_at                       TEXT NOT NULL,
  target_reviews_per_proposal     INTEGER NOT NULL DEFAULT 2,
  max_assignments_per_reviewer    INTEGER,
  allow_self_assignment           INTEGER NOT NULL DEFAULT 0,
  show_other_reviews_before_submit INTEGER NOT NULL DEFAULT 0,
  discussion_enabled              INTEGER NOT NULL DEFAULT 1,
  status                          TEXT NOT NULL DEFAULT 'draft',
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL,
  row_version                     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX review_round_event_idx ON review_round(event_id);

CREATE TABLE review_round_reviewer (
  id                 TEXT PRIMARY KEY,
  round_id           TEXT NOT NULL REFERENCES review_round(id),
  person_id          TEXT NOT NULL REFERENCES person(id),
  pool_role          TEXT NOT NULL DEFAULT 'reviewer',
  track_ids          TEXT,
  max_assignments    INTEGER,
  added_by_person_id TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TEXT NOT NULL
);
-- INV-05-15: one pool row per (round, person).
CREATE UNIQUE INDEX review_round_reviewer_uq ON review_round_reviewer(round_id, person_id);

CREATE TABLE review_round_reminder_rule (
  id            TEXT PRIMARY KEY,
  round_id      TEXT NOT NULL REFERENCES review_round(id),
  offset_days   INTEGER NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'email',
  template_key  TEXT NOT NULL,
  escalate_to   TEXT,
  only_if_status TEXT
);

CREATE TABLE review_assignment (
  id                  TEXT PRIMARY KEY,
  round_id            TEXT NOT NULL REFERENCES review_round(id),
  proposal_id         TEXT NOT NULL REFERENCES proposal(id),
  reviewer_person_id  TEXT NOT NULL REFERENCES person(id),
  assigned_by         TEXT NOT NULL DEFAULT 'chair',
  status              TEXT NOT NULL DEFAULT 'assigned',
  decline_reason      TEXT,
  due_at              TEXT,
  reminder_count      INTEGER NOT NULL DEFAULT 0,
  last_reminded_at    TEXT,
  assigned_at         TEXT NOT NULL,
  submitted_at        TEXT
);
-- INV-05-2: one assignment per (round, proposal, reviewer).
CREATE UNIQUE INDEX review_assignment_uq ON review_assignment(round_id, proposal_id, reviewer_person_id);
CREATE INDEX review_assignment_reviewer_idx ON review_assignment(reviewer_person_id, status);
CREATE INDEX review_assignment_proposal_idx ON review_assignment(proposal_id);

CREATE TABLE review (
  id                      TEXT PRIMARY KEY,
  assignment_id           TEXT,
  proposal_id             TEXT NOT NULL REFERENCES proposal(id),
  round_id                TEXT NOT NULL,
  reviewer_person_id      TEXT,
  author_kind             TEXT NOT NULL DEFAULT 'human',
  ai_evaluator_key        TEXT,
  ai_model                TEXT,
  ai_rationale            TEXT,
  overridden_by_person_id TEXT,
  overridden_at           TEXT,
  recommendation          TEXT,
  confidence              TEXT,
  comments_for_committee  TEXT,
  comments_for_speaker    TEXT,
  flags                   TEXT,
  status                  TEXT NOT NULL DEFAULT 'draft',
  reviewed_content_hash   TEXT NOT NULL DEFAULT '',
  submitted_at            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  row_version             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX review_proposal_idx ON review(proposal_id, status);
CREATE INDEX review_assignment_idx ON review(assignment_id);
-- overall_score is derived (weighted mean of criterion scores): no column.

CREATE TABLE criterion_score (
  review_id    TEXT NOT NULL REFERENCES review(id),
  criterion_id TEXT NOT NULL REFERENCES rubric_criterion(id),
  value_number INTEGER,
  value_option TEXT,
  value_text   TEXT,
  value_bool   INTEGER,
  note         TEXT,
  PRIMARY KEY (review_id, criterion_id)
);

CREATE TABLE conflict_of_interest (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES event(id),
  reviewer_person_id TEXT NOT NULL REFERENCES person(id),
  subject_type       TEXT NOT NULL,
  subject_id         TEXT,
  subject_value      TEXT,
  reason             TEXT NOT NULL,
  source             TEXT NOT NULL,
  note               TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX coi_reviewer_idx ON conflict_of_interest(event_id, reviewer_person_id);

CREATE TABLE review_comment (
  id               TEXT PRIMARY KEY,
  proposal_id      TEXT NOT NULL REFERENCES proposal(id),
  round_id         TEXT,
  author_person_id TEXT NOT NULL,
  parent_id        TEXT,
  body             TEXT NOT NULL,
  visibility       TEXT NOT NULL DEFAULT 'committee_only',
  created_at       TEXT NOT NULL,
  edited_at        TEXT,
  deleted_at       TEXT
);
CREATE INDEX review_comment_proposal_idx ON review_comment(proposal_id);

CREATE TABLE decision (
  id                        TEXT PRIMARY KEY,
  proposal_id               TEXT NOT NULL REFERENCES proposal(id),
  round_id                  TEXT,
  outcome                   TEXT NOT NULL,
  assigned_track_id         TEXT,
  assigned_format_id        TEXT,
  assigned_duration_minutes INTEGER,
  conditions                TEXT,
  feedback_for_speaker      TEXT,
  rationale                 TEXT,
  decided_by_person_id      TEXT NOT NULL,
  decided_at                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'provisional',
  published_at              TEXT,
  notification_id           TEXT,
  confirmation_deadline     TEXT,
  supersedes_decision_id    TEXT,
  quorum_waived_reason      TEXT,
  row_version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX decision_proposal_idx ON decision(proposal_id, status);

-- ===========================================================================
-- 06 — Program
-- ===========================================================================

CREATE TABLE session (
  id                           TEXT PRIMARY KEY,
  org_id                       TEXT NOT NULL REFERENCES organization(id),
  event_id                     TEXT NOT NULL REFERENCES event(id),
  proposal_id                  TEXT,
  reference                    TEXT NOT NULL,
  origin                       TEXT NOT NULL,
  title                        TEXT NOT NULL,
  subtitle                     TEXT,
  abstract                     TEXT NOT NULL DEFAULT '',
  description                  TEXT,
  session_format_id            TEXT NOT NULL,
  track_id                     TEXT,
  duration_minutes             INTEGER NOT NULL,
  audience_level               TEXT,
  keywords                     TEXT,
  language                     TEXT,
  sponsor_id                   TEXT,
  av_requirements              TEXT,
  recording_consent            TEXT NOT NULL DEFAULT 'unanswered',
  recording_url                TEXT,
  slides_asset_id              TEXT,
  capacity_override            INTEGER,
  registration_url             TEXT,
  status                       TEXT NOT NULL DEFAULT 'pending_confirmation',
  content_status               TEXT NOT NULL DEFAULT 'draft',
  content_approved_by_person_id TEXT,
  content_approved_at          TEXT,
  visibility                   TEXT NOT NULL DEFAULT 'public',
  cancellation_reason          TEXT,
  publication_override_reason  TEXT,
  published_at                 TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  deleted_at                   TEXT,
  row_version                  INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX session_reference_uq ON session(event_id, reference);
-- INV-06-1 / INV-04-9: a proposal has at most one non-cancelled session.
CREATE UNIQUE INDEX session_proposal_uq ON session(proposal_id) WHERE proposal_id IS NOT NULL AND status != 'cancelled';
CREATE INDEX session_event_idx ON session(event_id, status);

CREATE TABLE session_speaker (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES session(id),
  person_id             TEXT NOT NULL REFERENCES person(id),
  speaker_role          TEXT NOT NULL DEFAULT 'primary',
  sort_order            INTEGER NOT NULL DEFAULT 0,
  confirmation_status   TEXT NOT NULL DEFAULT 'pending',
  confirmed_at          TEXT,
  declined_at           TEXT,
  replaced_by_person_id TEXT,
  is_public             INTEGER NOT NULL DEFAULT 1,
  travel_status         TEXT,
  attendance_mode       TEXT,
  added_at              TEXT NOT NULL
);
-- INV-06-3: one SessionSpeaker per (session, person).
CREATE UNIQUE INDEX session_speaker_uq ON session_speaker(session_id, person_id);
CREATE INDEX session_speaker_person_idx ON session_speaker(person_id);

CREATE TABLE session_relation (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES session(id),
  related_session_id TEXT NOT NULL REFERENCES session(id),
  relation           TEXT NOT NULL,
  sort_order         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_asset (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES session(id),
  asset_id               TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  uploaded_by_person_id  TEXT NOT NULL,
  is_public              INTEGER NOT NULL DEFAULT 0,
  public_from            TEXT
);
CREATE INDEX session_asset_session_idx ON session_asset(session_id);

CREATE TABLE session_revision (
  id                        TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL REFERENCES session(id),
  revision_number           INTEGER NOT NULL,
  changed_by_person_id      TEXT NOT NULL,
  change_kind               TEXT NOT NULL,
  diff                      TEXT NOT NULL DEFAULT '{}',
  snapshot                  TEXT NOT NULL DEFAULT '{}',
  restored_from_revision_id TEXT,
  created_at                TEXT NOT NULL
);
CREATE UNIQUE INDEX session_revision_uq ON session_revision(session_id, revision_number);

-- ===========================================================================
-- 07 — Onboarding
-- ===========================================================================

CREATE TABLE task_definition (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES event(id),
  key                   TEXT NOT NULL,
  title                 TEXT NOT NULL,
  instructions          TEXT,
  category              TEXT NOT NULL DEFAULT 'other',
  requirement_type      TEXT NOT NULL,
  config                TEXT NOT NULL DEFAULT '{}',
  subject_type          TEXT NOT NULL DEFAULT 'session',
  assignee_rule         TEXT NOT NULL,
  assignee_person_id    TEXT,
  assignee_person_ids   TEXT,
  applies_to            TEXT,
  trigger               TEXT NOT NULL DEFAULT 'on_session_confirmed',
  trigger_task_key      TEXT,
  due_rule              TEXT NOT NULL DEFAULT 'none',
  due_value             TEXT,
  is_blocking           INTEGER NOT NULL DEFAULT 0,
  is_required           INTEGER NOT NULL DEFAULT 1,
  requires_review       INTEGER NOT NULL DEFAULT 0,
  auto_complete_on_event TEXT,
  depends_on_task_keys  TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'draft',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  row_version           INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX task_definition_key_uq ON task_definition(event_id, key);

CREATE TABLE task_instance (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organization(id),
  event_id               TEXT NOT NULL REFERENCES event(id),
  definition_id          TEXT NOT NULL,
  definition_version     INTEGER NOT NULL,
  definition_key         TEXT NOT NULL,
  title                  TEXT NOT NULL,
  requirement_type       TEXT NOT NULL,
  config                 TEXT NOT NULL DEFAULT '{}',
  instructions           TEXT,
  subject_type           TEXT NOT NULL,
  subject_id             TEXT NOT NULL,
  session_id             TEXT,
  assignee_person_id     TEXT NOT NULL,
  sponsor_id             TEXT,
  status                 TEXT NOT NULL DEFAULT 'not_started',
  is_blocking            INTEGER NOT NULL DEFAULT 0,
  is_required            INTEGER NOT NULL DEFAULT 1,
  requires_review        INTEGER NOT NULL DEFAULT 0,
  due_at                 TEXT,
  started_at             TEXT,
  submitted_at           TEXT,
  completed_at           TEXT,
  completed_by_person_id TEXT,
  waived_by_person_id    TEXT,
  waiver_reason          TEXT,
  reviewed_by_person_id  TEXT,
  review_note            TEXT,
  reminder_count         INTEGER NOT NULL DEFAULT 0,
  last_reminded_at       TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1
);
-- INV-07-2: at most one non-cancelled instance per (definition_key, subject, assignee).
CREATE UNIQUE INDEX task_instance_uq
  ON task_instance(definition_key, subject_type, subject_id, assignee_person_id)
  WHERE status != 'cancelled';
CREATE INDEX task_instance_assignee_idx ON task_instance(assignee_person_id, status);
CREATE INDEX task_instance_session_idx ON task_instance(session_id);
CREATE INDEX task_instance_event_idx ON task_instance(event_id, status);
-- is_overdue is computed at read time and never persisted (INV-07-3).

CREATE TABLE task_submission (
  id                    TEXT PRIMARY KEY,
  task_instance_id      TEXT NOT NULL REFERENCES task_instance(id),
  version               INTEGER NOT NULL,
  payload               TEXT NOT NULL DEFAULT '{}',
  asset_ids             TEXT,
  submitted_by_person_id TEXT NOT NULL,
  submitted_at          TEXT NOT NULL,
  review_outcome        TEXT,
  reviewed_by_person_id TEXT,
  reviewed_at           TEXT,
  review_note           TEXT
);
CREATE UNIQUE INDEX task_submission_uq ON task_submission(task_instance_id, version);

CREATE TABLE task_reminder_rule (
  id             TEXT PRIMARY KEY,
  definition_id  TEXT NOT NULL REFERENCES task_definition(id),
  offset_days    INTEGER NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'email',
  template_key   TEXT NOT NULL,
  escalate_to    TEXT,
  only_if_status TEXT
);

CREATE TABLE task_reminder_log (
  id                     TEXT PRIMARY KEY,
  task_instance_id       TEXT NOT NULL REFERENCES task_instance(id),
  rule_id                TEXT,
  trigger                TEXT NOT NULL,
  triggered_by_person_id TEXT,
  scheduled_for          TEXT NOT NULL,
  sent_at                TEXT,
  notification_id        TEXT,
  suppressed_reason      TEXT
);
CREATE INDEX task_reminder_log_task_idx ON task_reminder_log(task_instance_id);

-- ===========================================================================
-- 08 — Scheduling & Publication
-- ===========================================================================

CREATE TABLE time_slot (
  id           TEXT PRIMARY KEY,
  event_day_id TEXT NOT NULL REFERENCES event_day(id),
  event_id     TEXT NOT NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  label        TEXT,
  kind         TEXT NOT NULL DEFAULT 'session',
  room_ids     TEXT,
  is_public    INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE placement (
  id                  TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL REFERENCES event(id),
  session_id          TEXT NOT NULL REFERENCES session(id),
  room_id             TEXT NOT NULL,
  event_day_id        TEXT NOT NULL,
  time_slot_id        TEXT,
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  setup_minutes       INTEGER NOT NULL DEFAULT 0,
  teardown_minutes    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'tentative',
  is_public           INTEGER NOT NULL DEFAULT 1,
  placed_by_person_id TEXT NOT NULL,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  row_version         INTEGER NOT NULL DEFAULT 1
);
-- INV-08-1: a non-cancelled session has at most one placement.
CREATE UNIQUE INDEX placement_session_uq ON placement(session_id);
CREATE INDEX placement_event_idx ON placement(event_id, starts_at);

-- Materialised read model (08): recomputed on every placement write
-- (INV-08-14). Acknowledgements survive recomputation because the id is
-- derived from (event, code, participating placements).
CREATE TABLE schedule_conflict (
  id                        TEXT PRIMARY KEY,
  event_id                  TEXT NOT NULL,
  code                      TEXT NOT NULL,
  severity                  TEXT NOT NULL,
  placement_ids             TEXT NOT NULL DEFAULT '[]',
  detail                    TEXT,
  acknowledged_by_person_id TEXT,
  acknowledged_reason       TEXT,
  computed_at               TEXT NOT NULL
);
CREATE INDEX schedule_conflict_event_idx ON schedule_conflict(event_id);

CREATE TABLE auto_place_run (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES event(id),
  scope                 TEXT,
  strategy              TEXT NOT NULL DEFAULT 'greedy_fill',
  proposed              TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'proposed',
  requested_by_person_id TEXT NOT NULL,
  applied_session_ids   TEXT,
  created_at            TEXT NOT NULL,
  applied_at            TEXT
);

CREATE TABLE schedule_publication (
  id                     TEXT PRIMARY KEY,
  event_id               TEXT NOT NULL REFERENCES event(id),
  version                INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'building',
  scope                  TEXT,
  published_by_person_id TEXT NOT NULL,
  published_at           TEXT NOT NULL,
  note                   TEXT,
  override_reasons       TEXT,
  -- content_etag is derived from the snapshot content (INV-08-11) but is stored
  -- on this materialised snapshot because the snapshot is immutable once live:
  -- the hash of an immutable body cannot drift from it.
  content_etag           TEXT NOT NULL DEFAULT '',
  row_version            INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX publication_version_uq ON schedule_publication(event_id, version);
-- INV-08-9: exactly one live publication per event.
CREATE UNIQUE INDEX publication_live_uq ON schedule_publication(event_id) WHERE status = 'live';

CREATE TABLE published_session (
  id                   TEXT PRIMARY KEY,
  publication_id       TEXT NOT NULL REFERENCES schedule_publication(id),
  session_id           TEXT NOT NULL,
  reference            TEXT NOT NULL,
  title                TEXT NOT NULL,
  subtitle             TEXT,
  abstract             TEXT,
  description          TEXT,
  track                TEXT,
  format               TEXT,
  room                 TEXT,
  starts_at            TEXT,
  ends_at              TEXT,
  duration_minutes     INTEGER,
  audience_level       TEXT,
  keywords             TEXT,
  language             TEXT,
  speaker_refs         TEXT NOT NULL DEFAULT '[]',
  sponsor              TEXT,
  is_sponsored_content INTEGER NOT NULL DEFAULT 0,
  assets               TEXT,
  registration_url     TEXT,
  capacity             INTEGER,
  sort_order           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX published_session_pub_idx ON published_session(publication_id);

CREATE TABLE published_speaker (
  id             TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES schedule_publication(id),
  person_id      TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  pronouns       TEXT,
  headline       TEXT,
  job_title      TEXT,
  company        TEXT,
  short_bio      TEXT,
  bio            TEXT,
  headshot_url   TEXT,
  links          TEXT,
  session_refs   TEXT NOT NULL DEFAULT '[]',
  sort_key       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX published_speaker_pub_idx ON published_speaker(publication_id);

CREATE TABLE schedule_diff_entry (
  id             TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES schedule_publication(id),
  change_type    TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  before         TEXT,
  after          TEXT
);
CREATE INDEX schedule_diff_pub_idx ON schedule_diff_entry(publication_id);

CREATE TABLE embed_config (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES event(id),
  key                   TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  widget_type           TEXT NOT NULL,
  allowed_origins       TEXT NOT NULL DEFAULT '[]',
  filters               TEXT,
  format                TEXT NOT NULL DEFAULT 'js_widget',
  fields                TEXT,
  theme                 TEXT,
  show_unpublished      INTEGER NOT NULL DEFAULT 0,
  cache_ttl_seconds     INTEGER NOT NULL DEFAULT 300,
  pinned_publication_id TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  created_by_person_id  TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX embed_config_event_idx ON embed_config(event_id);

-- ===========================================================================
-- 09 — API & Integrations
-- ===========================================================================

CREATE TABLE api_key (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organization(id),
  name                  TEXT NOT NULL,
  prefix                TEXT NOT NULL,
  secret_hash           TEXT NOT NULL,
  scopes                TEXT NOT NULL DEFAULT '[]',
  event_ids             TEXT,
  created_by_person_id  TEXT NOT NULL,
  expires_at            TEXT,
  last_used_at          TEXT,
  last_used_ip          TEXT,
  rate_limit_per_minute INTEGER,
  revoked_at            TEXT,
  revoked_by_person_id  TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX api_key_prefix_idx ON api_key(prefix);

CREATE TABLE webhook (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization(id),
  event_id             TEXT,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  event_types          TEXT NOT NULL DEFAULT '[]',
  secret               TEXT NOT NULL,
  previous_secret      TEXT,
  secret_rotated_at    TEXT,
  include_pii          INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by_person_id TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE webhook_delivery (
  id                    TEXT PRIMARY KEY,
  webhook_id            TEXT NOT NULL REFERENCES webhook(id),
  domain_event_id       TEXT NOT NULL,
  attempt               INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'pending',
  request_body_hash     TEXT,
  response_status       INTEGER,
  response_body_excerpt TEXT,
  error                 TEXT,
  scheduled_for         TEXT,
  delivered_at          TEXT,
  duration_ms           INTEGER
);
-- Consumers are idempotent on DomainEvent.id; so is the producer.
CREATE UNIQUE INDEX webhook_delivery_uq ON webhook_delivery(webhook_id, domain_event_id, attempt);
CREATE INDEX webhook_delivery_webhook_idx ON webhook_delivery(webhook_id);

CREATE TABLE integration (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organization(id),
  event_id                 TEXT,
  plugin_key               TEXT NOT NULL,
  capability               TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  config                   TEXT NOT NULL DEFAULT '{}',
  secret_ref               TEXT NOT NULL DEFAULT '',
  is_default_for_capability INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'active',
  last_health_check_at     TEXT,
  last_error               TEXT,
  created_at               TEXT NOT NULL,
  row_version              INTEGER NOT NULL DEFAULT 1
);
-- INV-09-4: at most one default per capability per scope.
CREATE UNIQUE INDEX integration_default_uq
  ON integration(org_id, capability, COALESCE(event_id, ''))
  WHERE is_default_for_capability = 1;

CREATE TABLE notification_template (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization(id),
  event_id      TEXT,
  key           TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'email',
  subject       TEXT,
  body_markdown TEXT NOT NULL,
  locale        TEXT NOT NULL DEFAULT 'en',
  is_active     INTEGER NOT NULL DEFAULT 1,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  row_version   INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX notification_template_uq
  ON notification_template(org_id, COALESCE(event_id, ''), key, locale);

CREATE TABLE notification_delivery (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  event_id            TEXT,
  campaign_id         TEXT,
  template_key        TEXT,
  template_version    INTEGER,
  recipient_person_id TEXT,
  recipient_email     TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'email',
  integration_id      TEXT,
  subject_type        TEXT,
  subject_id          TEXT,
  subject             TEXT,
  -- The outbox body (INV-09-12): every intended message is readable even when
  -- no provider is configured.
  rendered_body       TEXT,
  status              TEXT NOT NULL DEFAULT 'queued',
  suppressed_reason   TEXT,
  provider_message_id TEXT,
  sent_at             TEXT,
  delivered_at        TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX notification_delivery_person_idx ON notification_delivery(recipient_person_id);
CREATE INDEX notification_delivery_event_idx ON notification_delivery(event_id, created_at);
CREATE INDEX notification_delivery_campaign_idx ON notification_delivery(campaign_id);

CREATE TABLE campaign (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization(id),
  event_id             TEXT,
  name                 TEXT NOT NULL,
  channel              TEXT NOT NULL DEFAULT 'email',
  template_id          TEXT,
  subject              TEXT,
  body_markdown        TEXT NOT NULL,
  audience             TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'draft',
  scheduled_for        TEXT,
  created_by_person_id TEXT NOT NULL,
  sent_at              TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE campaign_recipient (
  campaign_id       TEXT NOT NULL REFERENCES campaign(id),
  person_id         TEXT NOT NULL,
  resolved_email    TEXT NOT NULL,
  notification_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  suppressed_reason TEXT,
  -- INV-09-14: sending is idempotent per (campaign, person).
  PRIMARY KEY (campaign_id, person_id)
);

-- Global suppression list. 09 states suppression is "global per email address"
-- for hard bounces and complaints, and per-category for unsubscribes, but names
-- no entity to hold it.
CREATE TABLE notification_suppression (
  org_id     TEXT NOT NULL,
  email      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'all',
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, email, category)
);

-- ===========================================================================
-- 10 — Domain events (the append-only log)
-- ===========================================================================

CREATE TABLE domain_event_record (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  occurred_at    TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  event_id       TEXT,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT,
  actor_display  TEXT,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  data           TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  causation_id   TEXT
);
CREATE INDEX domain_event_type_idx ON domain_event_record(type, occurred_at);
CREATE INDEX domain_event_subject_idx ON domain_event_record(subject_type, subject_id);
CREATE INDEX domain_event_org_idx ON domain_event_record(org_id, occurred_at);

-- Consumer-side idempotency: at-least-once delivery means every reaction must
-- be idempotent on DomainEvent.id (10-domain-events.md, "Reaction map").
CREATE TABLE event_reaction_log (
  event_id     TEXT NOT NULL,
  handler      TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (event_id, handler)
);

-- ===========================================================================
-- 11 — Cross-cutting
-- ===========================================================================

CREATE TABLE asset (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organization(id),
  storage_key           TEXT NOT NULL,
  filename              TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL DEFAULT 0,
  checksum              TEXT NOT NULL DEFAULT '',
  width                 INTEGER,
  height                INTEGER,
  scan_status           TEXT NOT NULL DEFAULT 'pending',
  visibility            TEXT NOT NULL DEFAULT 'private',
  uploaded_by_person_id TEXT NOT NULL,
  purpose               TEXT NOT NULL DEFAULT 'other',
  expires_at            TEXT,
  slot_key              TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  supersedes_asset_id   TEXT,
  created_at            TEXT NOT NULL,
  deleted_at            TEXT
);
-- INV-11-9: version is monotonic within a slot_key; is_latest is derived from it.
CREATE UNIQUE INDEX asset_slot_version_uq ON asset(slot_key, version);
CREATE INDEX asset_slot_idx ON asset(slot_key);
CREATE INDEX asset_org_idx ON asset(org_id);

CREATE TABLE asset_comment (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES asset(id),
  slot_key         TEXT NOT NULL,
  author_person_id TEXT NOT NULL,
  body             TEXT NOT NULL,
  parent_id        TEXT,
  created_at       TEXT NOT NULL,
  edited_at        TEXT,
  deleted_at       TEXT
);
-- INV-11-10: the thread belongs to the slot, not the version.
CREATE INDEX asset_comment_slot_idx ON asset_comment(slot_key, created_at);

CREATE TABLE custom_field_definition (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization(id),
  event_id      TEXT,
  subject_type  TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  help_text     TEXT,
  type          TEXT NOT NULL,
  options       TEXT,
  is_required   INTEGER NOT NULL DEFAULT 0,
  pii           INTEGER NOT NULL,
  audience      TEXT NOT NULL,
  show_in_list  INTEGER NOT NULL DEFAULT 0,
  is_filterable INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX custom_field_key_uq ON custom_field_definition(org_id, subject_type, key);

CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  event_id       TEXT,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT,
  actor_display  TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  before         TEXT,
  after          TEXT,
  reason         TEXT,
  ip             TEXT,
  user_agent     TEXT,
  correlation_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_org_idx ON audit_log(org_id, created_at);

CREATE TABLE bulk_import (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organization(id),
  event_id              TEXT,
  subject               TEXT NOT NULL,
  source_asset_id       TEXT,
  source_text           TEXT,
  column_mapping        TEXT NOT NULL DEFAULT '{}',
  dedupe_key            TEXT NOT NULL DEFAULT 'email',
  on_duplicate          TEXT NOT NULL DEFAULT 'update',
  status                TEXT NOT NULL DEFAULT 'uploaded',
  requested_by_person_id TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  row_version           INTEGER NOT NULL DEFAULT 1
);

-- Per-row outcomes; `errors` and the counts on BulkImport are derived from here.
CREATE TABLE bulk_import_row (
  import_id   TEXT NOT NULL REFERENCES bulk_import(id),
  row_number  INTEGER NOT NULL,
  raw         TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'pending',
  entity_id   TEXT,
  column_name TEXT,
  message     TEXT,
  PRIMARY KEY (import_id, row_number)
);

CREATE TABLE export (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organization(id),
  event_id               TEXT,
  subject                TEXT NOT NULL,
  format                 TEXT NOT NULL,
  filters                TEXT,
  options                TEXT,
  include_pii            INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'queued',
  result_asset_id        TEXT,
  result_body            TEXT,
  expires_at             TEXT NOT NULL,
  requested_by_person_id TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

-- ===========================================================================
-- 14 — Speaker CRM
-- ===========================================================================

CREATE TABLE contact_segment (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization(id),
  name                 TEXT NOT NULL,
  description          TEXT,
  kind                 TEXT NOT NULL,
  criteria             TEXT,
  member_person_ids    TEXT,
  created_by_person_id TEXT NOT NULL,
  visibility           TEXT NOT NULL DEFAULT 'shared',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sourcing_pipeline (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organization(id),
  event_id             TEXT,
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  created_by_person_id TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE pipeline_stage (
  id          TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES sourcing_pipeline(id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  wip_limit   INTEGER
);

CREATE TABLE prospect_card (
  id                     TEXT PRIMARY KEY,
  pipeline_id            TEXT NOT NULL REFERENCES sourcing_pipeline(id),
  stage_id               TEXT NOT NULL,
  person_id              TEXT NOT NULL REFERENCES person(id),
  event_id               TEXT,
  topic                  TEXT,
  score                  INTEGER,
  rationale              TEXT,
  owner_person_id        TEXT,
  next_action_at         TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  entered_stage_at       TEXT NOT NULL,
  outcome_participant_id TEXT,
  created_by_person_id   TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1
);
-- INV-14-3: one ProspectCard per (pipeline, person).
CREATE UNIQUE INDEX prospect_card_uq ON prospect_card(pipeline_id, person_id);

CREATE TABLE prospect_stage_transition (
  id                  TEXT PRIMARY KEY,
  card_id             TEXT NOT NULL REFERENCES prospect_card(id),
  from_stage_id       TEXT,
  to_stage_id         TEXT NOT NULL,
  moved_by_person_id  TEXT NOT NULL,
  note                TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX prospect_transition_card_idx ON prospect_stage_transition(card_id);

-- ===========================================================================
-- Infrastructure (not domain entities)
-- ===========================================================================

-- Browser sign-in sessions. `AuthIdentity` models how you prove who you are;
-- this is the cookie that remembers it for a while.
CREATE TABLE auth_session (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  person_id     TEXT NOT NULL REFERENCES person(id),
  org_id        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT
);
CREATE INDEX auth_session_person_idx ON auth_session(person_id);
