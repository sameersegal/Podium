# 10 — Domain Events

The event catalogue is a **published contract**. Webhooks, integrations, notifications,
audit and every cross-context reaction are built on it. Adding fields is safe; removing or
retyping one is a breaking change requiring a new major version of that event type.

## Envelope

Every event, on the wire and in storage, has the same shape:

```json
{
  "id": "evn_01JB9Z...",
  "type": "proposal.submitted",
  "version": 1,
  "occurred_at": "2026-03-14T09:12:44.113Z",
  "org_id": "org_01H...",
  "event_id": "evt_01H...",
  "actor": {
    "type": "person | api_key | system | integration",
    "id": "per_01H...",
    "display_name": "Ada Lovelace"
  },
  "subject": { "type": "proposal", "id": "prp_01H..." },
  "data": { },
  "correlation_id": "req_01H...",
  "causation_id": "evn_01JB9Y..."
}
```

| Field | Notes |
|---|---|
| `id` | ULID, prefix `evn_`. The consumer's idempotency key. |
| `type` | `<noun>.<past-tense-verb>`, lowercase, dot-separated. Past tense always — an event is a thing that happened, not a request. |
| `version` | Per type, starts at 1. |
| `occurred_at` | When the fact became true, not when it was delivered. |
| `actor` | Who caused it. `system` for scheduled jobs and cascades. |
| `subject` | The primary entity. Webhook ordering is guaranteed per subject only. |
| `data` | Type-specific payload; see the catalogue. Redacted per the recipient's PII permission. |
| `correlation_id` | Groups everything from one request or batch — a decision publish emits hundreds of events sharing one correlation id. |
| `causation_id` | The event that caused this one; makes cascades traceable. |

Storage: events are persisted in an append-only log with the same retention as the audit
log. That is what makes webhook replay, "why did this speaker get that email", and
after-the-fact debugging possible.

### DomainEventRecord

The stored form of the envelope. `actor` and `subject` are flattened into columns so the
log can be queried by actor or subject without unpacking JSON.

<!-- entity: DomainEventRecord -->
| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `evn_`; the consumer's idempotency key |
| `type` | `string` | Y | from the catalogue below |
| `version` | `int` | Y | per type, starts at 1 |
| `occurred_at` | `timestamptz` | Y | when the fact became true |
| `org_id` | `ref(Organization)` | Y | |
| `event_id` | `ref(Event)` | N | null for org-level facts |
| `actor_type` | `enum(person, api_key, system, integration)` | Y | |
| `actor_id` | `ulid` | N | |
| `actor_display` | `string` | N | captured at the time |
| `subject_type` | `string` | Y | webhook ordering is guaranteed per subject only |
| `subject_id` | `ulid` | Y | |
| `data` | `json` | Y | type-specific payload |
| `correlation_id` | `string` | N | groups one request or batch |
| `causation_id` | `ref(DomainEventRecord)` | N | the event that caused this one |

## Catalogue

`data` columns list the type-specific payload. All events also carry the envelope above.
"PII" marks payloads containing fields redacted without `pii:read` / `include_pii`.

### Identity

| Type | Subject | `data` | PII |
|---|---|---|---|
| `organization.created` | organization | `organization_id, name, slug` | |
| `person.created` | person | `person_id, full_name, email, source` | yes |
| `person.merged` | person | `surviving_person_id, merged_person_id, merged_by` | yes |
| `person.merge_candidate_detected` | person | `person_id, candidate_person_id, signals[], confidence` | yes |
| `person.deactivated` | person | `person_id, reason` | |
| `person_note.added` | person | `note_id, person_id, event_id, author_person_id` — **body never included** (INV-01-14) | |
| `speaker_profile.updated` | person | `person_id, changed_fields[], edited_by_person_id, edited_by_role` | |
| `event_participant.added` | person | `participant_id, event_id, person_id, kind, status, source` | yes |
| `event_participant.status_changed` | person | `participant_id, event_id, person_id, from, to` | |
| `event_participant.portal_invited` | person | `participant_id, event_id, person_id, invitation_id` | yes |
| `role_grant.created` | person | `person_id, role, scope_type, scope_id, granted_by` | |
| `role_grant.revoked` | person | `person_id, role, scope_type, scope_id, revoked_by` | |
| `invitation.sent` | invitation | `invitation_id, kind, email, context_type, context_id, expires_at` | yes |
| `invitation.accepted` | invitation | `invitation_id, person_id` | |
| `invitation.expired` | invitation | `invitation_id` | |

### Event configuration

| Type | Subject | `data` |
|---|---|---|
| `event.created` | event | `event_id, name, slug, starts_on, ends_on, timezone` |
| `event.cloned` | event | `event_id, source_event_id, day_shift, copied{day, track, session_format, venue, room, cfp, rubric, task_definition, sponsorship_tier, notification_template}` |
| `event.activated` | event | `event_id` |
| `event.archived` | event | `event_id` |
| `cfp.opened` | cfp | `cfp_id, name, audience, opens_at, closes_at` |
| `cfp.closed` | cfp | `cfp_id, closed_early, proposal_count` |
| `submission_form.published` | form | `form_id, cfp_id, version, changed_field_keys[]` |
| `track.created` | track | `track_id, name, slug` |
| `session_format.created` | format | `format_id, name, slug, default_duration_minutes` |
| `room.created` | room | `room_id, venue_id, name, slug, capacity` |

### Sponsorship

| Type | Subject | `data` |
|---|---|---|
| `sponsor.created` | sponsor | `sponsor_id, name, slug` |
| `sponsorship.confirmed` | sponsorship | `sponsorship_id, sponsor_id, event_id, tier_id` |
| `sponsorship.cancelled` | sponsorship | `sponsorship_id, reason` |
| `entitlement.granted` | entitlement | `entitlement_id, sponsorship_id, entitlement_type, quantity, source` |
| `entitlement.held` | entitlement | `entitlement_id, proposal_id, remaining` |
| `entitlement.released` | entitlement | `entitlement_id, proposal_id, reason, remaining` |
| `entitlement.spent` | entitlement | `entitlement_id, session_id, remaining` |
| `entitlement.exhausted` | entitlement | `entitlement_id, sponsor_id` |
| `entitlement.expiring_soon` | entitlement | `entitlement_id, sponsor_id, remaining, expires_at, days_remaining` |
| `sponsor_contact.invited` | sponsor_contact | `sponsor_contact_id, sponsor_id, person_id, contact_role` |
| `sponsor_contact.revoked` | sponsor_contact | `sponsor_contact_id, sponsor_id, person_id` |

### Submissions

| Type | Subject | `data` | PII |
|---|---|---|---|
| `proposal.created` | proposal | `proposal_id, reference, cfp_id, origin, submitter_person_id` | yes |
| `proposal.submitted` | proposal | `proposal_id, reference, title, format_id, track_id, speaker_person_ids[], is_late, sponsor_id` | yes |
| `proposal.resubmitted` | proposal | `proposal_id, revision_number, changed_fields[]` | |
| `proposal.updated` | proposal | `proposal_id, changed_fields[], change_kind` | |
| `proposal.withdrawn` | proposal | `proposal_id, reason, withdrawn_by` | |
| `proposal.changes_requested` | proposal | `proposal_id, decision_id, note` | |
| `proposal.expired` | proposal | `proposal_id, confirmation_deadline` | |
| `proposal_speaker.added` | proposal | `proposal_id, person_id, speaker_role, invitation_id` | yes |
| `proposal_speaker.accepted` | proposal | `proposal_id, person_id` | |
| `proposal_speaker.declined` | proposal | `proposal_id, person_id` | |
| `proposal_speaker.removed` | proposal | `proposal_id, person_id, removed_by` | |
| `draft.abandoned` | proposal | `proposal_id, last_activity_at, percent_complete` | |

### Review & selection

`reviews:read` is required to receive these; reviewer identity is omitted unless the round
is `open`.

| Type | Subject | `data` |
|---|---|---|
| `review_round.opened` | round | `round_id, name, sequence, proposal_count, assignment_count` |
| `review_round.closed` | round | `round_id, submitted_review_count, missing_review_count` |
| `review_round_reviewer.added` | round | `round_id, person_id, pool_role, track_ids[], max_assignments` |
| `review_round_reviewer.removed` | round | `round_id, person_id, removed_by` |
| `review_assignment.created` | assignment | `assignment_id, round_id, proposal_id, reviewer_person_id, due_at, assigned_by` |
| `review_assignment.declined` | assignment | `assignment_id, reason` |
| `review_assignment.reminded` | assignment | `assignment_id, reviewer_person_id, reminder_count, trigger, triggered_by_person_id` |
| `review.submitted` | review | `review_id, proposal_id, round_id, author_kind, recommendation, overall_score, has_quorum` |
| `review.ai_generated` | review | `review_id, proposal_id, round_id, ai_evaluator_key, ai_model, overall_score` |
| `review.overridden` | review | `review_id, superseded_review_id, proposal_id, overridden_by_person_id` |
| `review.stale` | review | `review_id, proposal_id, previous_hash, current_hash` |
| `conflict_of_interest.declared` | coi | `coi_id, reviewer_person_id, subject_type, subject_id, reason, source` |
| `decision.recorded` | decision | `decision_id, proposal_id, outcome, decided_by` |
| `decision.published` | decision | `decision_id, proposal_id, outcome, assigned_track_id, assigned_format_id, assigned_duration_minutes, confirmation_deadline` |
| `proposal.accepted` | proposal | `proposal_id, decision_id, confirmation_deadline` |
| `proposal.waitlisted` | proposal | `proposal_id, decision_id` |
| `proposal.rejected` | proposal | `proposal_id, decision_id` |

`decision.published` is the highest-value event in the catalogue: session creation,
onboarding materialisation, speaker notification and every external integration key off it.

### Program

| Type | Subject | `data` |
|---|---|---|
| `session.created` | session | `session_id, proposal_id, origin, title, format_id, track_id, sponsor_id, speaker_person_ids[]` |
| `session.confirmed` | session | `session_id` |
| `session.updated` | session | `session_id, changed_fields[]` |
| `session.cancelled` | session | `session_id, reason, was_published` |
| `session.delivered` | session | `session_id` |
| `session.content_approved` | session | `session_id, approved_by_person_id, revision_number` |
| `session.content_approval_revoked` | session | `session_id, changed_fields[], changed_by_person_id` |
| `session.content_restored` | session | `session_id, revision_number, restored_from_revision_id, restored_by_person_id` |
| `session_speaker.confirmed` | session | `session_id, person_id, speaker_role` |
| `session_speaker.declined` | session | `session_id, person_id, reason` |
| `session_speaker.replaced` | session | `session_id, outgoing_person_id, incoming_person_id, transferred_task_count` |
| `session_asset.uploaded` | session | `session_id, asset_id, kind, is_public` |

### Onboarding

| Type | Subject | `data` |
|---|---|---|
| `task_definition.activated` | definition | `definition_id, key, version, is_blocking` |
| `task_instance.created` | task | `task_instance_id, definition_key, subject_type, subject_id, assignee_person_id, due_at, is_blocking` |
| `task_instance.started` | task | `task_instance_id` |
| `task_instance.submitted` | task | `task_instance_id, submission_version` |
| `task_instance.completed` | task | `task_instance_id, completed_by, days_to_complete, reminder_count` |
| `task_instance.changes_requested` | task | `task_instance_id, review_note` |
| `task_instance.waived` | task | `task_instance_id, waived_by, waiver_reason` |
| `task_instance.cancelled` | task | `task_instance_id, reason` |
| `task_instance.overdue` | task | `task_instance_id, due_at, days_overdue` |
| `task_reminder.sent` | task | `task_instance_id, rule_id, reminder_count, escalated_to` |
| `onboarding.session_complete` | session | `session_id, blocking_task_count` |

### Scheduling & publication

| Type | Subject | `data` |
|---|---|---|
| `placement.created` | placement | `placement_id, session_id, room_id, starts_at, ends_at` |
| `placement.moved` | placement | `placement_id, session_id, from: {room_id, starts_at}, to: {room_id, starts_at}` |
| `placement.removed` | placement | `placement_id, session_id` |
| `schedule.conflict_detected` | event | `code, severity, placement_ids[], detail` |
| `schedule.auto_place_proposed` | event | `run_id, strategy, proposed_count, unplaceable_count, conflicts_introduced` |
| `schedule.auto_place_applied` | event | `run_id, applied_session_ids[], skipped_session_ids[]` |
| `schedule.published` | publication | `publication_id, version, session_count, content_etag, override_reasons` |
| `schedule.changed` | publication | `publication_id, version, diff: [{change_type, session_id, before, after}]` |
| `schedule.rolled_back` | publication | `publication_id, restored_version, rolled_back_from_version` |
| `session.time_changed` | session | `session_id, from, to, publication_id` |
| `session.room_changed` | session | `session_id, from_room, to_room, publication_id` |
| `embed_config.created` | embed | `embed_config_id, event_id, format, allowed_origins` |

`session.time_changed` and `session.room_changed` fire **only on publication**, not on
every drag in the planning UI. Speakers should hear about a change when it is real.

### Platform

| Type | Subject | `data` |
|---|---|---|
| `api_key.created` / `api_key.revoked` | api_key | `api_key_id, name, scopes[]` |
| `webhook.created` | webhook | `webhook_id, url, event_types[]` |
| `webhook.delivery_failed` | webhook | `webhook_id, delivery_id, attempt, response_status, error` |
| `webhook.disabled` | webhook | `webhook_id, consecutive_failures` |
| `integration.installed` | integration | `integration_id, plugin_key, capability` |
| `integration.health_changed` | integration | `integration_id, status, last_error` |
| `notification.sent` | notification | `notification_id, template_key, recipient_person_id, channel, campaign_id` |
| `notification.bounced` | notification | `notification_id, recipient_email, bounce_type` |
| `campaign.created` | campaign | `campaign_id, event_id, channel, template_id, recipient_count` |
| `campaign.sent` | campaign | `campaign_id, recipient_count, sent, suppressed, failed` |
| `campaign.recipient_failed` | campaign | `campaign_id, person_id, reason` |

### Content and bulk operations

| Type | Subject | `data` | PII |
|---|---|---|---|
| `asset.uploaded` | asset | `asset_id, slot_key, version, purpose, filename, size_bytes, uploaded_by_person_id` | |
| `asset.version_superseded` | asset | `asset_id, superseded_asset_id, slot_key, version` | |
| `asset.scan_completed` | asset | `asset_id, scan_status` | |
| `asset_comment.added` | asset | `comment_id, asset_id, slot_key, author_person_id, parent_id` | |
| `custom_field.defined` | custom_field | `definition_id, subject_type, key, type, pii, audience` | |
| `bulk_import.completed` | import | `import_id, subject, row_count, created_count, updated_count, skipped_count, error_count` | |
| `export.ready` | export | `export_id, subject, format, row_count, byte_size, expires_at` | |

### Speaker CRM

| Type | Subject | `data` | PII |
|---|---|---|---|
| `contact_segment.created` | segment | `segment_id, name, kind, member_count` | |
| `contact_segment.updated` | segment | `segment_id, changed_fields[], member_count` | |
| `sourcing_pipeline.created` | pipeline | `pipeline_id, event_id, name, stage_names[]` | |
| `prospect.enrolled` | prospect | `card_id, pipeline_id, person_id, stage_id, event_id, score` | yes |
| `prospect.stage_changed` | prospect | `card_id, from_stage_id, to_stage_id, to_stage_kind, moved_by_person_id, days_in_previous_stage` | |
| `prospect.converted` | prospect | `card_id, person_id, event_id, participant_id` | yes |
| `prospect.stalled` | prospect | `card_id, person_id, stage_id, days_in_stage, next_action_at` | |

`prospect.*` payloads never carry `rationale`, `score` commentary or note bodies
(INV-14-6) — the card's private judgement about a person does not leave the organization,
whatever `include_pii` says.

## Reaction map

Which internal handlers subscribe to what. This is the actual wiring between contexts, and
keeping it in one table is what stops it from becoming folklore.

It became folklore anyway once, which is why the table is now split in two. A consequence
that is *supposed* to be a queue reaction and a consequence that is deliberately synchronous
are different claims, and collapsing them into one list is what let seven rows drift out of
agreement with the code without anything noticing (C8).

### Reactions — dispatched from the queue

Every row here is a real subscriber in a `contexts/<context>/reactions.ts`, registered in
`consumers/reactions.ts`.

| Event | Reaction | Context |
|---|---|---|
| `person.created` | Detect merge candidates | Identity |
| `proposal.submitted` | Confirmation email; add speakers to the roster; re-emit the entitlement hold | Notifications, Identity, Sponsorship |
| `proposal.resubmitted` / `proposal.updated` | Re-hash reviewed content and mark diverged reviews `stale` (INV-05-8) | Review |
| `draft.abandoned` | Release the entitlement hold | Sponsorship |
| `decision.published` (accept) | Create the session; add or confirm the speaker's `EventParticipant` row | Program, Identity |
| `decision.published` (all outcomes) | Email the submitter and every credited speaker with `feedback_for_speaker` (INV-05-10) | Notifications |
| `session.created` | Materialise onboarding tasks; spend the entitlement | Onboarding, Sponsorship |
| `session.confirmed` | Materialise the tasks gated on confirmation | Onboarding |
| `session_speaker.confirmed` | Re-evaluate session confirmation; materialise per-speaker tasks | Program, Onboarding |
| `session_speaker.replaced` | Transfer incomplete tasks; recompute both people's roster rows | Onboarding, Identity |
| `session.cancelled` | Cancel tasks; release the placement and the entitlement | Onboarding, Scheduling, Sponsorship |
| `session.content_approved` | Recompute publication readiness | Program, Scheduling |
| `event_participant.added` / `event_participant.status_changed` | Materialise the tasks gated on joining or confirming | Onboarding |
| `task_instance.completed` / `.waived` | Unblock dependents; chain `on_task_completed` | Onboarding |
| `task_instance.completed` / `.waived` / `.cancelled` | Emit `onboarding.session_complete` once nothing blocking is outstanding | Onboarding |
| `onboarding.session_complete` | Clear the publication block; auto-publish if the event opted in | Scheduling |
| `placement.moved` | Recompute `relative_to_session_start` due dates; recompute conflicts | Onboarding, Scheduling |
| `schedule.published` | Invalidate the snapshot cache | Scheduling |
| `schedule.changed` | Notify the speakers whose time or room actually moved | Notifications |
| `asset.uploaded` | Scan the asset; complete the file-request task once scanned clean | Cross-cutting, Onboarding |
| `entitlement.expiring_soon` | Nudge the sponsor contact | Notifications |
| `*` | Fan out to every matching webhook | Platform |

### Consequences that are deliberately synchronous

These are *not* reactions, and each has a reason it cannot be one. They are listed here
because the absence of a subscriber is otherwise indistinguishable from a missing one.

| Fact | Consequence | Why inline |
|---|---|---|
| Proposal withdrawn / rejected / expired | Release the entitlement hold | INV-04-10 — the slot must be free before the response is written, not one queue hop later. `draft.abandoned` has no synchronous path and stays a reaction. |
| Session content fields edited | Write a `SessionRevision`; revoke content approval; recompute `content_diverged` | INV-06-12 requires the revision in the same transaction as the edit. |
| Speaker replaced | Revoke the outgoing speaker's relationship-derived access | INV-06-10 — "step three gets forgotten and a former speaker keeps portal access". Security-critical, so it cannot wait on a queue. |
| Prospect converted | Create the `EventParticipant` with `source = crm_push` | The participant is what conversion *means*; `prospect.converted` is the receipt, emitted after. |
| Asset uploaded | Supersede the previous version in the slot | Version ordering is decided by the write that creates the version. |
| Schedule published | Compute the diff and write the snapshot | The diff is part of building the publication, not a consequence of it. `schedule.changed` then carries it to speakers. |
| Session confirmed | Becomes eligible for placement | Derived at read time (INV-11-6), so there is nothing to react to. |
| Task overdue / reminders due | Reminder with escalation | Onboarding's two reminder cron sweeps own chasing, because a reminder is driven by elapsed time rather than by a fact. `task_instance.overdue` is emitted for the log and for webhook subscribers. |

Two rows the table used to promise are simply not built: `proposal.submitted` → *notify
committee channel* (the `chat` capability is reachable only through campaigns), and
`campaign.sent` → *append to the communications history*. They are removed rather than left
standing, because a row nobody implemented reads exactly like a row somebody did.

Every reaction must be **idempotent on `DomainEvent.id`** — the same event may be delivered
twice, and "create session" running twice is exactly the bug this rule exists to prevent.
Idempotency is enforced once, in `consumers/dispatch.ts`, on `(event id, handler)`, so a
retry re-runs only the handler that actually failed.

## Naming rules

1. Past tense, always: `proposal.submitted`, never `proposal.submit`.
2. Noun before verb, dot-separated, lowercase snake within a segment.
3. The noun is the subject aggregate. A speaker confirming is `session_speaker.confirmed`,
   subject `session` — because that is what consumers filter on.
4. State-change events name the state reached, not the transition:
   `proposal.accepted`, not `proposal.status_changed`. Generic change events push the
   semantics into the payload where nobody can subscribe to them.
5. One event per fact. A decision publish emits `decision.published` **and**
   `proposal.accepted`; they are different facts for different consumers, and both are
   cheap.
