# Endpoint catalogue

Every endpoint on the management surface, generated from the routes themselves by
`claude-plugin/scripts/build-endpoints.mjs`. Do not edit by hand — regenerate.

190 endpoints. Columns:

- **Scope** — the API-key scope that reaches it. A key reaches exactly what its scopes name
  and nothing else (INV-09-25). **`session`** means no API key of any scope reaches it: the
  handler either needs a person's id, or refuses a key outright because the record is that
  person's own statement — submitting a proposal and writing a review, INV-09-27.
  Blank means the guard is neither a capability nor a person: a public route, one scoped by a
  relationship the caller has, or one gated on being staff at all — the CRM routes
  (`/v1/segments`, `/v1/pipelines`, `/v1/prospects`) check that and nothing finer, so any
  authenticated key reaches them.
- **Query** — query-string parameters the handler reads. Every list endpoint also takes
  `limit` and `cursor`.
- **Body** — fields the handler reads from a JSON body. Presence here is not proof a field is
  required, optional, or even accepted: a handler may read one only to refuse it, as
  `PATCH /v1/entitlements/:id` does with `consumed_count`. The 422 will tell you, and it
  names the invariant.
- A `·` in the PII column means the response is redacted unless the key holds `pii:read`.

Paths shown with `:name` take an id in that position.

## cfp forms

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/cfps/:cfpId` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2282 |
| `PATCH /v1/cfps/:cfpId` | `events:write` | — | `row_version` |  | workers/api/src/contexts/event-config/routes.ts:2289 |
| `GET /v1/cfps/:cfpId/builder` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2423 |
| `POST /v1/cfps/:cfpId/close` | `events:write` | — | `reason` |  | workers/api/src/contexts/event-config/routes.ts:2308 |
| `GET /v1/cfps/:cfpId/forms` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2348 |
| `POST /v1/cfps/:cfpId/forms` | `events:write` | — | `notes` |  | workers/api/src/contexts/event-config/routes.ts:2365 |
| `GET /v1/cfps/:cfpId/options` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2328 |
| `PATCH /v1/cfps/:cfpId/options` | `events:write` | — | `formats` `tracks` |  | workers/api/src/contexts/event-config/routes.ts:2335 |
| `POST /v1/cfps/:cfpId/publish` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2299 |
| `POST /v1/cfps/:cfpId/reopen` | `events:write` | — | `reason` `closes_at` |  | workers/api/src/contexts/event-config/routes.ts:2318 |
| `GET /v1/events/:eventId/cfps` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2259 |
| `POST /v1/events/:eventId/cfps` | `events:write` | — | `name` `slug` `audience` `intro_markdown` `guidelines_url` `grace_period_minutes` `late_submission_policy` `max_proposals_per_person` `allow_edit_after_submit` `withdraw_allowed_until` `notify_on_submit` |  | workers/api/src/contexts/event-config/routes.ts:2272 |
| `DELETE /v1/fields/:fieldId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2541 |
| `PATCH /v1/fields/:fieldId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2527 |
| `GET /v1/forms/:formId` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2375 |
| `POST /v1/forms/:formId/fields` | `events:write` | — | `step_id` `key` `label` `help_text` `placeholder` `type` `options` `is_required` `visible_when` `maps_to` `audience` `pii` `identifies_speaker` `sort_order` |  | workers/api/src/contexts/event-config/routes.ts:2499 |
| `POST /v1/forms/:formId/publish` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2383 |
| `POST /v1/forms/:formId/reorder` | `events:write` | — | `steps` `fields` |  | workers/api/src/contexts/event-config/routes.ts:2470 |
| `POST /v1/forms/:formId/steps` | `events:write` | — | `key` `title` `description` `is_optional` `sort_order` `visible_when` |  | workers/api/src/contexts/event-config/routes.ts:2394 |
| `DELETE /v1/steps/:stepId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2554 |
| `PATCH /v1/steps/:stepId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2485 |

## console

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/console/bootstrap` | `session` | `path` `event` | — |  | workers/api/src/surfaces/console.ts:289 |

## content

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `POST /v1/assets` | `session` | — | `subject_type` `subject_id` `kind` `purpose` `visibility` |  | workers/api/src/contexts/content/routes.ts:756 |
| `GET /v1/assets/:id` | — | — | — |  | workers/api/src/contexts/content/routes.ts:790 |
| `GET /v1/assets/:id/comments` | — | — | — |  | workers/api/src/contexts/content/routes.ts:798 |
| `POST /v1/assets/:id/comments` | `session` | — | `body` `parent_id` |  | workers/api/src/contexts/content/routes.ts:806 |
| `POST /v1/assets/presign` | `session` | — | `subject_type` `subject_id` `kind` `filename` `content_type` `size_bytes` `purpose` `visibility` |  | workers/api/src/contexts/content/routes.ts:773 |
| `GET /v1/exports` | `events:read` | — | — |  | workers/api/src/contexts/content/routes.ts:899 |
| `POST /v1/exports` | `events:write` | — | `subject` `format` `event_id` `include_pii` `filters` `options` |  | workers/api/src/contexts/content/routes.ts:910 |
| `GET /v1/exports/:id` | `events:read` | — | — |  | workers/api/src/contexts/content/routes.ts:932 |
| `GET /v1/imports` | `events:read` | — | — |  | workers/api/src/contexts/content/routes.ts:856 |
| `POST /v1/imports` | `events:write` | — | `subject` `event_id` `csv_text` |  | workers/api/src/contexts/content/routes.ts:860 |
| `GET /v1/imports/:id` | `events:read` | — | — |  | workers/api/src/contexts/content/routes.ts:874 |
| `POST /v1/imports/:id/map` | `events:write` | — | `column_mapping` `dedupe_key` `on_duplicate` |  | workers/api/src/contexts/content/routes.ts:878 |
| `POST /v1/imports/:id/run` | `events:write` | — | — |  | workers/api/src/contexts/content/routes.ts:891 |

## events & configuration

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/custom-fields` | `events:read` | `subject_type` | — |  | workers/api/src/contexts/content/routes.ts:815 |
| `POST /v1/custom-fields` | `events:write` | — | `subject_type` `key` `label` `type` `options` `is_required` `pii` `audience` |  | workers/api/src/contexts/content/routes.ts:820 |
| `POST /v1/custom-fields/:id` | `events:write` | — | `action` `label` `help_text` `is_required` `show_in_list` `is_filterable` |  | workers/api/src/contexts/content/routes.ts:837 |
| `DELETE /v1/days/:dayId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2085 |
| `PATCH /v1/days/:dayId` | `events:write` | — | `date` `label` `sort_order` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2069 |
| `GET /v1/events` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:1950 |
| `POST /v1/events` | `events:write` | — | `name` `slug` `edition` `tagline` `description` `timezone` `starts_on` `ends_on` `mode` `website_url` `visibility` `source` `clone_from_event_id` |  | workers/api/src/contexts/event-config/routes.ts:1957 |
| `GET /v1/events/:eventId` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2011 |
| `PATCH /v1/events/:eventId` | `events:write` | — | `row_version` |  | workers/api/src/contexts/event-config/routes.ts:2017 |
| `POST /v1/events/:eventId/activate` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2026 |
| `POST /v1/events/:eventId/archive` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2034 |
| `POST /v1/events/:eventId/auto-place` | `schedule:publish` | — | `track_ids` `event_day_ids` `strategy` |  | workers/api/src/contexts/scheduling/api-routes.ts:229 |
| `POST /v1/events/:eventId/clone` | `events:read` `events:write` | — | `name` `slug` `edition` `tagline` `description` `timezone` `starts_on` `ends_on` `mode` `website_url` |  | workers/api/src/contexts/event-config/routes.ts:1984 |
| `GET /v1/events/:eventId/dashboard` | `events:read` | — | — |  | workers/api/src/surfaces/console.ts:311 |
| `GET /v1/events/:eventId/days` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2049 |
| `POST /v1/events/:eventId/days` | `events:write` | — | `date` `label` `sort_order` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2055 |
| `GET /v1/events/:eventId/formats` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2143 |
| `POST /v1/events/:eventId/formats` | `events:write` | — | `name` `slug` `description` `default_duration_minutes` `min_duration_minutes` `max_duration_minutes` `max_speakers` `eligible_origins` `requires_review` `requires_recording_consent` `capacity_policy` `sort_order` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2156 |
| `GET /v1/events/:eventId/readiness` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2042 |
| `GET /v1/events/:eventId/rooms` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2208 |
| `POST /v1/events/:eventId/rooms` | `events:write` | — | `venue_id` `name` `slug` `capacity` `floor` `av_capabilities` `default_track_id` `sort_order` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2221 |
| `GET /v1/events/:eventId/schedule` | `schedule:read` | — | — |  | workers/api/src/contexts/scheduling/api-routes.ts:96 |
| `GET /v1/events/:eventId/tracks` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2097 |
| `POST /v1/events/:eventId/tracks` | `events:write` | — | `name` `slug` `description` `color` `sort_order` `target_session_count` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2110 |
| `GET /v1/events/:eventId/venues` | `events:read` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2188 |
| `POST /v1/events/:eventId/venues` | `events:write` | — | `name` `address` `map_url` `timezone` `venue_id` |  | workers/api/src/contexts/event-config/routes.ts:2194 |
| `DELETE /v1/formats/:formatId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2176 |
| `PATCH /v1/formats/:formatId` | `events:write` | — | `name` `slug` `description` `default_duration_minutes` `min_duration_minutes` `max_duration_minutes` `max_speakers` `eligible_origins` `requires_review` `requires_recording_consent` `capacity_policy` `sort_order` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2165 |
| `DELETE /v1/rooms/:roomId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2247 |
| `PATCH /v1/rooms/:roomId` | `events:write` | — | `name` `slug` `capacity` `floor` `av_capabilities` `default_track_id` `sort_order` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2236 |
| `DELETE /v1/tracks/:trackId` | `events:write` | — | — |  | workers/api/src/contexts/event-config/routes.ts:2130 |
| `PATCH /v1/tracks/:trackId` | `events:write` | — | `name` `slug` `description` `color` `sort_order` `target_session_count` `is_public` |  | workers/api/src/contexts/event-config/routes.ts:2119 |

## onboarding tasks

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/task-definitions` | `tasks:read` | `event_id` | — |  | workers/api/src/contexts/onboarding/routes.ts:839 |
| `POST /v1/task-definitions` | `tasks:write` | — | `event_id` `title` `instructions` `category` `requirement_type` `config` `subject_type` `assignee_rule` `assignee_person_ids` `applies_to` `trigger` `due_rule` `due_value` `is_blocking` `is_required` `requires_review` |  | workers/api/src/contexts/onboarding/routes.ts:849 |
| `GET /v1/task-definitions/:id` | `tasks:read` | — | — |  | workers/api/src/contexts/onboarding/routes.ts:875 |
| `POST /v1/task-definitions/:id/activate` | `tasks:write` | — | — |  | workers/api/src/contexts/onboarding/routes.ts:882 |
| `POST /v1/task-definitions/:id/rematerialise` | `tasks:write` | — | — |  | workers/api/src/contexts/onboarding/routes.ts:900 |
| `POST /v1/task-definitions/:id/retire` | `tasks:write` | — | — |  | workers/api/src/contexts/onboarding/routes.ts:891 |
| `GET /v1/tasks` | `tasks:read` | `event_id` `assignee_person_id` `status` | — |  | workers/api/src/contexts/onboarding/routes.ts:909 |
| `GET /v1/tasks/:id` | — | — | — |  | workers/api/src/contexts/onboarding/routes.ts:958 |
| `POST /v1/tasks/:id/approve` | `tasks:write` | — | `note` |  | workers/api/src/contexts/onboarding/routes.ts:979 |
| `POST /v1/tasks/:id/cancel` | `tasks:write` | — | `reason` |  | workers/api/src/contexts/onboarding/routes.ts:1009 |
| `POST /v1/tasks/:id/remind` | `tasks:write` | — | — |  | workers/api/src/contexts/onboarding/routes.ts:1028 |
| `POST /v1/tasks/:id/request-changes` | `tasks:write` | — | `note` |  | workers/api/src/contexts/onboarding/routes.ts:989 |
| `POST /v1/tasks/:id/start` | `tasks:read` | — | — |  | workers/api/src/contexts/onboarding/routes.ts:1019 |
| `GET /v1/tasks/:id/submissions` | — | — | — | · | workers/api/src/contexts/onboarding/routes.ts:968 |
| `POST /v1/tasks/:id/waive` | `tasks:write` | — | `reason` |  | workers/api/src/contexts/onboarding/routes.ts:999 |

## people & roles

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/invitations` | `webhooks:manage` | `status` | — | · | workers/api/src/contexts/identity/routes.ts:655 |
| `POST /v1/invitations` | `speakers:write` | — | `scope_type` `scope_id` `intended_role` `context_id` `email` `kind` `context_type` `expires_in_days` |  | workers/api/src/contexts/identity/routes.ts:669 |
| `GET /v1/participants` | `speakers:read` | `event_id` `outstanding` `q` `status` `kind` `track_id` | — | · | workers/api/src/contexts/identity/routes.ts:605 |
| `POST /v1/participants` | `speakers:write` | — | `event_id` `person_id` `email` `full_name` `kind` `status` `source` |  | workers/api/src/contexts/identity/routes.ts:635 |
| `GET /v1/people` | `speakers:read` | `q` | — | · | workers/api/src/contexts/identity/routes.ts:550 |
| `GET /v1/people/:personId` | `speakers:read` | — | — | · | workers/api/src/contexts/identity/routes.ts:571 |
| `GET /v1/people/:personId/notes` | `speakers:read` | — | — | · | workers/api/src/contexts/identity/routes.ts:586 |
| `POST /v1/people/:personId/notes` | `speakers:write` | — | `body` `event_id` |  | workers/api/src/contexts/identity/routes.ts:594 |
| `GET /v1/role-grants` | `webhooks:manage` | `person_id` | — |  | workers/api/src/contexts/identity/routes.ts:696 |
| `POST /v1/role-grants` | — | — | `scope_type` `scope_id` `role` `person_id` `expires_at` |  | workers/api/src/contexts/identity/routes.ts:715 |
| `DELETE /v1/role-grants/:grantId` | — | — | — |  | workers/api/src/contexts/identity/routes.ts:732 |

## platform

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/api-keys` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1539 |
| `POST /v1/api-keys` | `webhooks:manage` | — | `name` `scopes` `event_ids` `expires_at` |  | workers/api/src/contexts/platform/routes.ts:1543 |
| `POST /v1/api-keys/:id/revoke` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1557 |
| `POST /v1/api-keys/:id/rotate` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1565 |
| `GET /v1/integrations` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1640 |
| `POST /v1/integrations` | `webhooks:manage` | — | `plugin_key` `event_id` `display_name` `secret_ref` `is_default_for_capability` |  | workers/api/src/contexts/platform/routes.ts:1644 |
| `POST /v1/integrations/:id` | `webhooks:manage` | — | `display_name` `config` `secret_ref` `is_default_for_capability` `status` |  | workers/api/src/contexts/platform/routes.ts:1659 |
| `POST /v1/integrations/:id/health-check` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1673 |
| `GET /v1/notifications` | `speakers:read` | `event_id` `person_id` `session_id` `campaign_id` `status` | — | · | workers/api/src/contexts/platform/routes.ts:1682 |
| `GET /v1/sync/active` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:663 |
| `POST /v1/sync/links/:linkId/resolve` | `events:write` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:651 |
| `GET /v1/sync/mappings` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:553 |
| `POST /v1/sync/mappings` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:559 |
| `GET /v1/sync/mappings/:id` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:579 |
| `POST /v1/sync/mappings/:id` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:586 |
| `GET /v1/sync/mappings/:id/links` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:611 |
| `POST /v1/sync/mappings/:id/pull` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:635 |
| `POST /v1/sync/mappings/:id/push` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:618 |
| `GET /v1/sync/mappings/:id/runs` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:606 |
| `POST /v1/sync/mappings/:id/scaffold` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:627 |
| `GET /v1/sync/subjects` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:522 |
| `GET /v1/webhooks` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1575 |
| `POST /v1/webhooks` | `webhooks:manage` | — | `name` `url` `event_types` `event_id` `include_pii` |  | workers/api/src/contexts/platform/routes.ts:1579 |
| `GET /v1/webhooks/:id` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1593 |
| `POST /v1/webhooks/:id` | `webhooks:manage` | — | `name` `url` `event_types` `include_pii` |  | workers/api/src/contexts/platform/routes.ts:1597 |
| `GET /v1/webhooks/:id/deliveries` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1617 |
| `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1623 |
| `POST /v1/webhooks/:id/replay` | `webhooks:manage` | — | `event_type` `from` `to` |  | workers/api/src/contexts/platform/routes.ts:1630 |
| `POST /v1/webhooks/:id/rotate-secret` | `webhooks:manage` | — | — |  | workers/api/src/contexts/platform/routes.ts:1610 |

## portal

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/me/export` | `session` | — | — |  | workers/api/src/contexts/content/routes.ts:723 |

## programme

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/sessions` | `sessions:read` | `event_id` `status` | — |  | workers/api/src/contexts/program/routes.ts:501 |
| `GET /v1/sessions/:sessionId` | `sessions:read` | — | — |  | workers/api/src/contexts/program/routes.ts:564 |
| `GET /v1/sessions/:sessionId/speakers` | `sessions:read` | — | — | · | workers/api/src/contexts/program/routes.ts:574 |
| `POST /v1/sessions/:sessionId/speakers` | `sessions:write` | — | `person_id` `email` `full_name` `speaker_role` `override_reason` |  | workers/api/src/contexts/program/routes.ts:585 |

## proposals

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/proposals` | `proposals:read` | `event_id` `q` `sort` `status` `track_id` `format_id` `origin` `cfp_id` | — | · | workers/api/src/contexts/submissions/routes.ts:797 |
| `POST /v1/proposals` | `proposals:read` | — | `cfp_id` `submitter_person_id` `entitlement_id` `sponsor_id` `origin` | · | workers/api/src/contexts/submissions/routes.ts:853 |
| `GET /v1/proposals/:id` | `proposals:read` | — | — | · | workers/api/src/contexts/submissions/routes.ts:809 |
| `PATCH /v1/proposals/:id` | `proposals:write` | — | `reason` `keywords` `title` `abstract` `description` `session_format_id` `requested_duration_minutes` `track_id` `assigned_track_id` `audience_level` `language` `recording_consent` `recording_conditions` `coi_disclosure` | · | workers/api/src/contexts/submissions/routes.ts:881 |
| `POST /v1/proposals/:id/submit` | `session` `proposals:read` | — | — | · | workers/api/src/contexts/submissions/routes.ts:894 |
| `POST /v1/proposals/:id/withdraw` | `proposals:read` | — | `reason` | · | workers/api/src/contexts/submissions/routes.ts:910 |
| `GET /v1/proposals/:proposalId/score` | `reviews:read` | `round_id` | — |  | workers/api/src/contexts/review/routes.ts:1577 |

## public

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/public/events/:eventSlug/cfps/:cfpSlug` | — | — | — |  | workers/api/src/contexts/event-config/routes.ts:2578 |
| `GET /v1/public/events/:eventSlug/schedule` | — | — | — |  | workers/api/src/surfaces/public.ts:682 |
| `GET /v1/public/events/:eventSlug/sessions` | — | — | — |  | workers/api/src/surfaces/public.ts:691 |
| `GET /v1/public/events/:eventSlug/speakers` | — | — | — |  | workers/api/src/surfaces/public.ts:701 |

## review & decisions

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/assignments` | `reviews:read` | `round_id` | — |  | workers/api/src/contexts/review/routes.ts:1449 |
| `POST /v1/assignments` | `decisions:write` | — | `round_id` `proposal_id` `reviewer_person_id` `assigned_by` `due_at` |  | workers/api/src/contexts/review/routes.ts:1460 |
| `GET /v1/decisions` | `decisions:read` | `event_id` | — |  | workers/api/src/contexts/review/routes.ts:1553 |
| `POST /v1/decisions` | `decisions:write` | — | `proposal_id` `outcome` `assigned_track_id` `assigned_format_id` `assigned_duration_minutes` `conditions` `feedback_for_speaker` `rationale` `confirmation_deadline` `quorum_waived_reason` |  | workers/api/src/contexts/review/routes.ts:1563 |
| `GET /v1/reviews` | `reviews:read` | `round_id` `proposal_id` | — |  | workers/api/src/contexts/review/routes.ts:1477 |
| `POST /v1/reviews` | `session` | — | `assignment_id` `intent` `recommendation` `confidence` `comments_for_committee` `comments_for_speaker` `flags` |  | workers/api/src/contexts/review/routes.ts:1507 |
| `POST /v1/reviews/:reviewId/override` | `decisions:write` | — | `assignment_id` `reason` `recommendation` `confidence` `comments_for_committee` `comments_for_speaker` `flags` |  | workers/api/src/contexts/review/routes.ts:1533 |
| `GET /v1/rounds` | `reviews:read` | `event_id` | — |  | workers/api/src/contexts/review/routes.ts:1420 |
| `POST /v1/rounds` | `decisions:write` | — | `event_id` `name` `sequence` `rubric_id` `anonymity` `opens_at` `closes_at` `target_reviews_per_proposal` `max_assignments_per_reviewer` `allow_self_assignment` `show_other_reviews_before_submit` `discussion_enabled` |  | workers/api/src/contexts/review/routes.ts:1430 |
| `GET /v1/rounds/:roundId` | `reviews:read` | — | — |  | workers/api/src/contexts/review/routes.ts:1442 |

## scheduling

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/auto-place-runs/:runId` | `schedule:read` | — | — |  | workers/api/src/contexts/scheduling/api-routes.ts:244 |
| `POST /v1/auto-place-runs/:runId/apply` | `schedule:publish` | — | `session_ids` |  | workers/api/src/contexts/scheduling/api-routes.ts:250 |
| `POST /v1/conflicts/:conflictId/acknowledge` | `schedule:publish` | — | `reason` |  | workers/api/src/contexts/scheduling/api-routes.ts:213 |
| `GET /v1/events/:eventId/conflicts` | `schedule:read` | — | — |  | workers/api/src/contexts/scheduling/api-routes.ts:207 |
| `POST /v1/events/:eventId/placements` | `schedule:publish` | — | `session_id` `event_day_id` `starts_at` `ends_at` `start_time` `duration_minutes` `room_id` `time_slot_id` `notes` |  | workers/api/src/contexts/scheduling/api-routes.ts:114 |
| `GET /v1/events/:eventId/publications` | `schedule:read` | — | — |  | workers/api/src/contexts/scheduling/api-routes.ts:267 |
| `POST /v1/events/:eventId/publications` | `schedule:publish` | — | `note` |  | workers/api/src/contexts/scheduling/api-routes.ts:275 |
| `DELETE /v1/placements/:placementId` | `schedule:publish` | — | — |  | workers/api/src/contexts/scheduling/api-routes.ts:192 |
| `PATCH /v1/placements/:placementId` | `schedule:publish` | — | `event_day_id` `starts_at` `start_time` `ends_at` `duration_minutes` `room_id` |  | workers/api/src/contexts/scheduling/api-routes.ts:154 |
| `POST /v1/publications/:publicationId/rollback` | `schedule:publish` | — | `reason` |  | workers/api/src/contexts/scheduling/api-routes.ts:284 |
| `GET /v1/sync/conflicts` | `events:read` | — | — |  | workers/api/src/contexts/platform/sync-routes.ts:646 |

## speaker CRM

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/campaigns` | `speakers:read` | `event_id` | — |  | workers/api/src/contexts/platform/routes.ts:1698 |
| `POST /v1/campaigns` | `speakers:write` | — | `event_id` `name` `channel` `template_id` `subject` `body_markdown` `audience` |  | workers/api/src/contexts/platform/routes.ts:1706 |
| `GET /v1/campaigns/:id` | `speakers:read` | — | — |  | workers/api/src/contexts/platform/routes.ts:1723 |
| `POST /v1/campaigns/:id` | `speakers:write` | — | `name` `subject` `body_markdown` `template_id` `audience` |  | workers/api/src/contexts/platform/routes.ts:1729 |
| `POST /v1/campaigns/:id/cancel` | `speakers:write` | — | — |  | workers/api/src/contexts/platform/routes.ts:1768 |
| `GET /v1/campaigns/:id/preview-audience` | `speakers:read` | — | — |  | workers/api/src/contexts/platform/routes.ts:1744 |
| `POST /v1/campaigns/:id/schedule` | `speakers:write` | — | `scheduled_for` |  | workers/api/src/contexts/platform/routes.ts:1751 |
| `POST /v1/campaigns/:id/send` | `speakers:write` | — | — |  | workers/api/src/contexts/platform/routes.ts:1760 |
| `GET /v1/pipelines` | — | — | — |  | workers/api/src/contexts/crm/routes.ts:440 |
| `POST /v1/pipelines` | — | — | `name` `event_id` |  | workers/api/src/contexts/crm/routes.ts:449 |
| `GET /v1/pipelines/:pipelineId` | — | — | — |  | workers/api/src/contexts/crm/routes.ts:458 |
| `GET /v1/prospects` | — | `pipeline_id` | — |  | workers/api/src/contexts/crm/routes.ts:464 |
| `POST /v1/prospects` | — | — | `pipeline_id` `person_id` `topic` `score` `rationale` `owner_person_id` `next_action_at` |  | workers/api/src/contexts/crm/routes.ts:505 |
| `POST /v1/prospects/:cardId/convert` | `speakers:write` | — | — |  | workers/api/src/contexts/crm/routes.ts:522 |
| `GET /v1/segments` | — | — | — |  | workers/api/src/contexts/crm/routes.ts:407 |
| `POST /v1/segments` | — | — | `kind` `name` `description` `criteria` `member_person_ids` |  | workers/api/src/contexts/crm/routes.ts:417 |
| `GET /v1/segments/:segmentId` | — | — | — |  | workers/api/src/contexts/crm/routes.ts:433 |

## sponsorship

| Endpoint | Scope | Query | Body | PII | Source |
|---|---|---|---|---|---|
| `GET /v1/entitlements` | `sponsors:read` `entitlements:read` | `sponsorship_id` `event_id` | — |  | workers/api/src/contexts/sponsorship/routes.ts:882 |
| `POST /v1/entitlements` | `sponsors:write` `entitlements:write` | — | `sponsorship_id` `entitlement_type` `quantity` `allowed_format_ids` `submission_deadline` `expires_at` `notes` |  | workers/api/src/contexts/sponsorship/routes.ts:912 |
| `GET /v1/entitlements/:entitlementId` | `sponsors:read` `entitlements:read` | — | — |  | workers/api/src/contexts/sponsorship/routes.ts:902 |
| `PATCH /v1/entitlements/:entitlementId` | `sponsors:write` `entitlements:write` | — | `consumed_count` `remaining` `quantity` `allowed_format_ids` `submission_deadline` `expires_at` `notes` `reason` |  | workers/api/src/contexts/sponsorship/routes.ts:932 |
| `GET /v1/sponsors` | `sponsors:read` `entitlements:read` | — | — |  | workers/api/src/contexts/sponsorship/routes.ts:730 |
| `POST /v1/sponsors` | `sponsors:write` `entitlements:write` | — | `name` `display_name` `slug` `website_url` `description` `status` |  | workers/api/src/contexts/sponsorship/routes.ts:746 |
| `GET /v1/sponsors/:sponsorId` | `sponsors:read` `entitlements:read` | — | — | · | workers/api/src/contexts/sponsorship/routes.ts:762 |
| `PATCH /v1/sponsors/:sponsorId` | `sponsors:write` `entitlements:write` | — | — |  | workers/api/src/contexts/sponsorship/routes.ts:786 |
| `GET /v1/sponsorships` | `sponsors:read` `entitlements:read` | `event_id` | — |  | workers/api/src/contexts/sponsorship/routes.ts:795 |
| `POST /v1/sponsorships` | `sponsors:write` `entitlements:write` | — | `event_id` `sponsor_id` `tier_id` `contract_reference` `public_from` |  | workers/api/src/contexts/sponsorship/routes.ts:815 |
| `GET /v1/sponsorships/:id` | `sponsors:read` `entitlements:read` | — | — |  | workers/api/src/contexts/sponsorship/routes.ts:832 |
| `PATCH /v1/sponsorships/:id` | `sponsors:write` `entitlements:write` | — | `contract_reference` `public_from` `internal_notes` `sort_order_override` |  | workers/api/src/contexts/sponsorship/routes.ts:845 |
| `POST /v1/sponsorships/:id/cancel` | `sponsors:write` `entitlements:write` | — | `reason` |  | workers/api/src/contexts/sponsorship/routes.ts:871 |
| `POST /v1/sponsorships/:id/confirm` | `sponsors:write` `entitlements:write` | — | — |  | workers/api/src/contexts/sponsorship/routes.ts:861 |

