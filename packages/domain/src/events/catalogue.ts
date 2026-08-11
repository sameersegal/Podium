/**
 * The domain event catalogue — 10-domain-events.md.
 *
 * This is a **published contract**. Adding fields is safe; removing or
 * retyping one is a breaking change requiring a new major version of the type.
 * Every event that crosses a context boundary appears here.
 */

export const EVENT_TYPES = [
  // Identity
  "person.created",
  "person.merged",
  "person.merge_candidate_detected",
  "person.deactivated",
  "person_note.added",
  "speaker_profile.updated",
  "event_participant.added",
  "event_participant.status_changed",
  "event_participant.portal_invited",
  "role_grant.created",
  "role_grant.revoked",
  "invitation.sent",
  "invitation.accepted",
  "invitation.expired",

  // Event configuration
  "event.created",
  "event.activated",
  "event.archived",
  "cfp.opened",
  "cfp.closed",
  "submission_form.published",
  "track.created",
  "session_format.created",
  "room.created",

  // Sponsorship
  "sponsor.created",
  "sponsorship.confirmed",
  "sponsorship.cancelled",
  "entitlement.granted",
  "entitlement.held",
  "entitlement.released",
  "entitlement.spent",
  "entitlement.exhausted",
  "entitlement.expiring_soon",
  "sponsor_contact.invited",
  "sponsor_contact.revoked",

  // Submissions
  "proposal.created",
  "proposal.submitted",
  "proposal.resubmitted",
  "proposal.updated",
  "proposal.withdrawn",
  "proposal.changes_requested",
  "proposal.expired",
  "proposal_speaker.added",
  "proposal_speaker.accepted",
  "proposal_speaker.declined",
  "proposal_speaker.removed",
  "draft.abandoned",

  // Review & selection
  "review_round.opened",
  "review_round.closed",
  "review_round_reviewer.added",
  "review_round_reviewer.removed",
  "review_assignment.created",
  "review_assignment.declined",
  "review_assignment.reminded",
  "review.submitted",
  "review.ai_generated",
  "review.overridden",
  "review.stale",
  "conflict_of_interest.declared",
  "decision.recorded",
  "decision.published",
  "proposal.accepted",
  "proposal.waitlisted",
  "proposal.rejected",

  // Program
  "session.created",
  "session.confirmed",
  "session.updated",
  "session.cancelled",
  "session.delivered",
  "session.content_approved",
  "session.content_approval_revoked",
  "session.content_restored",
  "session_speaker.confirmed",
  "session_speaker.declined",
  "session_speaker.replaced",
  "session_asset.uploaded",

  // Onboarding
  "task_definition.activated",
  "task_instance.created",
  "task_instance.started",
  "task_instance.submitted",
  "task_instance.completed",
  "task_instance.changes_requested",
  "task_instance.waived",
  "task_instance.cancelled",
  "task_instance.overdue",
  "task_reminder.sent",
  "onboarding.session_complete",

  // Scheduling & publication
  "placement.created",
  "placement.moved",
  "placement.removed",
  "schedule.conflict_detected",
  "schedule.auto_place_proposed",
  "schedule.auto_place_applied",
  "schedule.published",
  "schedule.changed",
  "schedule.rolled_back",
  "session.time_changed",
  "session.room_changed",
  "embed_config.created",

  // Platform
  "api_key.created",
  "api_key.revoked",
  "webhook.created",
  "webhook.delivery_failed",
  "webhook.disabled",
  "integration.installed",
  "integration.health_changed",
  "notification.sent",
  "notification.bounced",
  "campaign.created",
  "campaign.sent",
  "campaign.recipient_failed",

  // Content and bulk operations
  "asset.uploaded",
  "asset.version_superseded",
  "asset.scan_completed",
  "asset_comment.added",
  "custom_field.defined",
  "bulk_import.completed",
  "export.ready",

  // Speaker CRM
  "contact_segment.created",
  "contact_segment.updated",
  "sourcing_pipeline.created",
  "prospect.enrolled",
  "prospect.stage_changed",
  "prospect.converted",
  "prospect.stalled",
] as const;

export type DomainEventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

export function isKnownEventType(t: string): t is DomainEventType {
  return EVENT_TYPE_SET.has(t);
}

/**
 * Event types whose `data` carries personal data — marked "PII: yes" in the
 * catalogue. Redacted for recipients without `pii:read` / `include_pii`.
 */
export const PII_EVENT_TYPES = new Set<DomainEventType>([
  "person.created",
  "person.merged",
  "person.merge_candidate_detected",
  "event_participant.added",
  "event_participant.portal_invited",
  "invitation.sent",
  "proposal.created",
  "proposal.submitted",
  "proposal_speaker.added",
  "prospect.enrolled",
  "prospect.converted",
]);

/** Fields removed from a `data` payload when the recipient lacks PII access. */
export const EVENT_PII_DATA_FIELDS = ["email", "full_name", "recipient_email", "resolved_email"] as const;

/**
 * `*` and `<noun>.*` wildcards, per `Webhook.event_types`.
 */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}
