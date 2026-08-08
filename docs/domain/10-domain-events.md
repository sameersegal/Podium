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

## Catalogue

`data` columns list the type-specific payload. All events also carry the envelope above.
"PII" marks payloads containing fields redacted without `pii:read` / `include_pii`.

### Identity

| Type | Subject | `data` | PII |
|---|---|---|---|
| `person.created` | person | `person_id, full_name, email, source` | yes |
| `person.merged` | person | `surviving_person_id, merged_person_id, merged_by` | yes |
| `person.deactivated` | person | `person_id, reason` | |
| `speaker_profile.updated` | person | `person_id, changed_fields[]` | |
| `role_grant.created` | person | `person_id, role, scope_type, scope_id, granted_by` | |
| `role_grant.revoked` | person | `person_id, role, scope_type, scope_id, revoked_by` | |
| `invitation.sent` | invitation | `invitation_id, kind, email, context_type, context_id, expires_at` | yes |
| `invitation.accepted` | invitation | `invitation_id, person_id` | |
| `invitation.expired` | invitation | `invitation_id` | |

### Event configuration

| Type | Subject | `data` |
|---|---|---|
| `event.created` | event | `event_id, name, slug, starts_on, ends_on, timezone` |
| `event.activated` | event | `event_id` |
| `event.archived` | event | `event_id` |
| `cfp.opened` | cfp | `cfp_id, name, audience, opens_at, closes_at` |
| `cfp.closed` | cfp | `cfp_id, closed_early, proposal_count` |
| `submission_form.published` | form | `form_id, cfp_id, version, changed_field_keys[]` |
| `track.created` | track | `track_id, name, slug` |
| `session_format.created` | format | `format_id, name, slug, default_duration_minutes` |

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
| `review_assignment.created` | assignment | `assignment_id, round_id, proposal_id, reviewer_person_id, due_at` |
| `review_assignment.declined` | assignment | `assignment_id, reason` |
| `review.submitted` | review | `review_id, proposal_id, round_id, recommendation, overall_score, has_quorum` |
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
| `schedule.published` | publication | `publication_id, version, session_count, content_etag, override_reasons` |
| `schedule.changed` | publication | `publication_id, version, diff: [{change_type, session_id, before, after}]` |
| `schedule.rolled_back` | publication | `publication_id, restored_version, rolled_back_from_version` |
| `session.time_changed` | session | `session_id, from, to, publication_id` |
| `session.room_changed` | session | `session_id, from_room, to_room, publication_id` |

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
| `notification.sent` | notification | `notification_id, template_key, recipient_person_id, channel` |
| `notification.bounced` | notification | `notification_id, recipient_email, bounce_type` |

## Reaction map

Which internal handlers subscribe to what. This is the actual wiring between contexts, and
keeping it in one table is what stops it from becoming folklore.

| Event | Reaction | Context |
|---|---|---|
| `proposal.submitted` | Confirmation email; notify committee channel; hold entitlement | Notifications, Sponsorship |
| `proposal.withdrawn` / `proposal.rejected` | Release entitlement hold | Sponsorship |
| `decision.published` (accept) | Create session; set confirmation deadline; email speakers | Program, Notifications |
| `decision.published` (reject/waitlist) | Email speakers with `feedback_for_speaker` | Notifications |
| `session.created` | Materialise onboarding tasks; spend entitlement | Onboarding, Sponsorship |
| `session_speaker.confirmed` | Re-evaluate session confirmation; materialise per-speaker tasks | Program, Onboarding |
| `session_speaker.replaced` | Transfer incomplete tasks; revoke outgoing access | Onboarding, Identity |
| `session.confirmed` | Make eligible for placement | Scheduling |
| `task_instance.completed` | Unblock dependents; recompute `onboarding_progress`; check publication readiness | Onboarding, Program |
| `onboarding.session_complete` | Clear the publication block | Scheduling |
| `placement.moved` | Recompute `relative_to_session_start` due dates; recompute conflicts | Onboarding, Scheduling |
| `schedule.published` | Invalidate embed cache; compute diffs; notify affected speakers | Publication, Notifications |
| `session.cancelled` | Cancel tasks; release placement and entitlement; queue schedule diff | Onboarding, Scheduling, Sponsorship |
| `entitlement.expiring_soon` | Nudge the sponsor contact | Notifications |
| `task_instance.overdue` | Reminder with escalation | Notifications |

Every reaction must be **idempotent on `DomainEvent.id`** — the same event may be delivered
twice, and "create session" running twice is exactly the bug this rule exists to prevent.

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
