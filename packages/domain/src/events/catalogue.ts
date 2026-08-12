/**
 * The domain event catalogue — 10-domain-events.md.
 *
 * This is a **published contract**. Adding fields is safe; removing or
 * retyping one is a breaking change requiring a new major version of the type.
 * Every event that crosses a context boundary appears here.
 */

export const EVENT_TYPES = [
  // Identity
  "organization.created",
  "person.created",
  "person.updated",
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
  "event.cloned",
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

  // Two-way sync
  "sync_mapping.created",
  "sync_mapping.activated",
  "sync_mapping.deactivated",
  "sync_link.created",
  "sync_link.conflicted",
  "sync_link.resolved",
  "sync_link.unlinked",
  "sync_run.completed",
  "sync_run.failed",

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
 * Who a live frame may reach — `workers/api/src/durable/room.ts`.
 *
 * `staff` is anyone holding a write capability on the event: chairs, admins,
 * organizers. `member` is everyone else with a session — speakers in the
 * portal, sponsor contacts, and reviewers, who are deliberately *not* staff
 * here. A live frame carries no domain data, but "a review landed just now" is
 * still information, and 05 blinds a reviewer from their peers' work until
 * they submit their own. Timing correlates; the audience split is what keeps
 * the side channel on the right side of that line.
 */
export type LiveAudience = "staff" | "member";

/**
 * The subset of the catalogue that is worth waking a browser for — the same
 * shape as `PII_EVENT_TYPES` above: a slice of the published contract with a
 * transport meaning, not a second contract.
 *
 * Deliberately an allowlist rather than `*`. The dispatcher filters on a
 * reaction's `types` *before* it writes to `event_reaction_log`, so a wildcard
 * would cost a D1 insert for every one of the 130 event types to decide it had
 * nothing to say. Adding a type here is how a screen becomes live; nothing
 * else needs to change.
 */
export const LIVE_EVENT_TYPES = {
  // Review — the chair watching a round fill up. Staff only: see LiveAudience.
  "review.submitted": "staff",
  "review.overridden": "staff",
  "review.stale": "staff",
  "review_assignment.created": "staff",
  "review_assignment.declined": "staff",
  "conflict_of_interest.declared": "staff",
  "decision.recorded": "staff",

  // Selection and the submission queue.
  "decision.published": "member",
  "proposal.submitted": "staff",
  "proposal.withdrawn": "staff",
  "proposal.accepted": "member",
  "proposal.waitlisted": "member",
  "proposal.rejected": "member",

  // The programme board and one session's record.
  "session.created": "staff",
  "session.updated": "member",
  "session.cancelled": "member",
  "session.content_approved": "member",
  "session.content_approval_revoked": "member",

  // The schedule builder — two organizers in the same grid.
  "placement.created": "staff",
  "placement.moved": "staff",
  "placement.removed": "staff",
  "schedule.conflict_detected": "staff",
  "schedule.published": "member",

  // Threads and obligations.
  "asset_comment.added": "member",
  "task_instance.completed": "staff",

  // Not a screen update: the room closes this person's sockets, so a revoked
  // grant cannot keep a live channel open until its lifetime cap expires.
  "role_grant.revoked": "staff",
} as const satisfies Record<string, LiveAudience>;

export type LiveEventType = keyof typeof LIVE_EVENT_TYPES;

const LIVE_TYPE_LIST = Object.keys(LIVE_EVENT_TYPES) as LiveEventType[];

/** The reaction's `types`, and the `flush()` filter. */
export function liveEventTypes(): LiveEventType[] {
  return [...LIVE_TYPE_LIST];
}

export function isLiveEventType(t: string): t is LiveEventType {
  return t in LIVE_EVENT_TYPES;
}

export function liveAudience(t: LiveEventType): LiveAudience {
  return LIVE_EVENT_TYPES[t];
}

/**
 * `*` and `<noun>.*` wildcards, per `Webhook.event_types`.
 */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}
