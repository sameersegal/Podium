/**
 * Reference metadata for the admin console — 09, "Variables and preview".
 *
 * The organizer configuring a webhook has not read `docs/domain/10-domain-events.md`
 * and should not have to. This module turns the published event catalogue into
 * something a form can render beside the field it explains.
 *
 * **The catalogue is not restated here.** `EVENT_TYPES` and `PII_EVENT_TYPES` in
 * `@podiumconf/domain/events/catalogue.js` are the contract; this module reads
 * them. The only thing added below is prose — a category and a payload-field
 * list per type — and an event missing that prose still appears in the UI,
 * because a reference panel that silently omits an event tells the reader it
 * does not exist. `tests/unit/platform/event-reference.test.ts` fails if any
 * catalogue member goes uncategorised or if PII is restated by hand.
 */

import { EVENT_TYPES, PII_EVENT_TYPES, eventTypeMatches, type DomainEventType } from "@podiumconf/domain/events/catalogue.js";
import { COMMON_VARIABLES, DEFAULT_TEMPLATES, type TemplateSpec } from "@podiumconf/domain/platform/templates.js";

export interface EventMetadata {
  type: DomainEventType;
  /** The primary entity. Webhook ordering is guaranteed per subject only. */
  subject: string;
  description: string;
  /** Keys inside the envelope's `data` object. Empty when not yet documented. */
  dataFields: readonly string[];
  /** Derived from `PII_EVENT_TYPES` — never hand-declared. */
  hasPii: boolean;
  category: string;
}

export interface VariableMetadata {
  name: string;
  group: "common" | "template-specific";
  description: string;
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

/** Types whose category is not the one their noun implies. */
const CATEGORY_OVERRIDES: Partial<Record<DomainEventType, string>> = {
  // A decision outcome is selection, not submission.
  "proposal.accepted": "Review & selection",
  "proposal.waitlisted": "Review & selection",
  "proposal.rejected": "Review & selection",
  // These fire only on publication (10, "Scheduling & publication").
  "session.time_changed": "Scheduling & publication",
  "session.room_changed": "Scheduling & publication",
};

/** Noun (everything before the final dot) → catalogue section. */
const CATEGORY_BY_NOUN: Record<string, string> = {
  organization: "Identity",
  person: "Identity",
  person_note: "Identity",
  speaker_profile: "Identity",
  event_participant: "Identity",
  role_grant: "Identity",
  invitation: "Identity",

  event: "Event configuration",
  cfp: "Event configuration",
  submission_form: "Event configuration",
  track: "Event configuration",
  session_format: "Event configuration",
  room: "Event configuration",

  sponsor: "Sponsorship",
  sponsorship: "Sponsorship",
  entitlement: "Sponsorship",
  sponsor_contact: "Sponsorship",

  proposal: "Submissions",
  proposal_speaker: "Submissions",
  draft: "Submissions",

  review: "Review & selection",
  review_round: "Review & selection",
  review_round_reviewer: "Review & selection",
  review_assignment: "Review & selection",
  conflict_of_interest: "Review & selection",
  decision: "Review & selection",

  session: "Program",
  session_speaker: "Program",
  session_asset: "Program",

  task_definition: "Onboarding",
  task_instance: "Onboarding",
  task_reminder: "Onboarding",
  onboarding: "Onboarding",

  placement: "Scheduling & publication",
  schedule: "Scheduling & publication",
  embed_config: "Scheduling & publication",

  api_key: "Platform",
  webhook: "Platform",
  integration: "Platform",
  notification: "Platform",
  campaign: "Platform",

  asset: "Content & bulk operations",
  asset_comment: "Content & bulk operations",
  custom_field: "Content & bulk operations",
  bulk_import: "Content & bulk operations",
  export: "Content & bulk operations",

  contact_segment: "Speaker CRM",
  sourcing_pipeline: "Speaker CRM",
  prospect: "Speaker CRM",
};

/** The order the panel renders sections in — the catalogue's own order. */
const CATEGORY_ORDER = [
  "Identity",
  "Event configuration",
  "Sponsorship",
  "Submissions",
  "Review & selection",
  "Program",
  "Onboarding",
  "Scheduling & publication",
  "Platform",
  "Content & bulk operations",
  "Speaker CRM",
];

/** Where a type lands when its noun is unmapped — visible, never dropped. */
export const UNCATEGORISED = "Other";

function categoryOf(type: DomainEventType): string {
  const override = CATEGORY_OVERRIDES[type];
  if (override) return override;
  const noun = type.slice(0, type.lastIndexOf("."));
  return CATEGORY_BY_NOUN[noun] ?? UNCATEGORISED;
}

/* -------------------------------------------------------------------------- */
/* Payload prose                                                               */
/* -------------------------------------------------------------------------- */

interface Prose {
  subject: string;
  description: string;
  dataFields: readonly string[];
}

/**
 * Transcribed from the catalogue tables in `10-domain-events.md`. Additive: a
 * type absent here still renders, with its subject inferred and no field list.
 */
const PROSE: Partial<Record<DomainEventType, Prose>> = {
  "organization.created": { subject: "organization", description: "An organization was created.", dataFields: ["organization_id", "name", "slug"] },
  "person.created": { subject: "person", description: "A person record was created.", dataFields: ["person_id", "full_name", "email", "source"] },
  "person.merged": { subject: "person", description: "Two person records were merged into one.", dataFields: ["surviving_person_id", "merged_person_id", "merged_by"] },
  "person.merge_candidate_detected": { subject: "person", description: "Two records look like the same human.", dataFields: ["person_id", "candidate_person_id", "signals[]", "confidence"] },
  "person.deactivated": { subject: "person", description: "A person was deactivated.", dataFields: ["person_id", "reason"] },
  "person_note.added": { subject: "person", description: "A private note was added. The body is never included (INV-01-14).", dataFields: ["note_id", "person_id", "event_id", "author_person_id"] },
  "speaker_profile.updated": { subject: "person", description: "A speaker profile changed.", dataFields: ["person_id", "changed_fields[]", "edited_by_person_id", "edited_by_role"] },
  "event_participant.added": { subject: "person", description: "Somebody joined an event roster.", dataFields: ["participant_id", "event_id", "person_id", "kind", "status", "source"] },
  "event_participant.status_changed": { subject: "person", description: "A roster status moved.", dataFields: ["participant_id", "event_id", "person_id", "from", "to"] },
  "event_participant.portal_invited": { subject: "person", description: "A participant was invited into the portal.", dataFields: ["participant_id", "event_id", "person_id", "invitation_id"] },
  "role_grant.created": { subject: "person", description: "A role was granted.", dataFields: ["person_id", "role", "scope_type", "scope_id", "granted_by"] },
  "role_grant.revoked": { subject: "person", description: "A role was revoked.", dataFields: ["person_id", "role", "scope_type", "scope_id", "revoked_by"] },
  "invitation.sent": { subject: "invitation", description: "An invitation went out.", dataFields: ["invitation_id", "kind", "email", "context_type", "context_id", "expires_at"] },
  "invitation.accepted": { subject: "invitation", description: "An invitation was accepted.", dataFields: ["invitation_id", "person_id"] },
  "invitation.expired": { subject: "invitation", description: "An invitation lapsed unused.", dataFields: ["invitation_id"] },

  "event.created": { subject: "event", description: "An event was created.", dataFields: ["event_id", "name", "slug", "starts_on", "ends_on", "timezone"] },
  "event.cloned": { subject: "event", description: "An event was cloned from a previous edition.", dataFields: ["event_id", "source_event_id", "day_shift", "copied{...}"] },
  "event.activated": { subject: "event", description: "An event went live.", dataFields: ["event_id"] },
  "event.archived": { subject: "event", description: "An event was archived.", dataFields: ["event_id"] },
  "cfp.opened": { subject: "cfp", description: "A call for proposals opened.", dataFields: ["cfp_id", "name", "audience", "opens_at", "closes_at"] },
  "cfp.closed": { subject: "cfp", description: "A call for proposals closed.", dataFields: ["cfp_id", "closed_early", "proposal_count"] },
  "submission_form.published": { subject: "form", description: "A submission form version was published.", dataFields: ["form_id", "cfp_id", "version", "changed_field_keys[]"] },
  "track.created": { subject: "track", description: "A track was created.", dataFields: ["track_id", "name", "slug"] },
  "session_format.created": { subject: "format", description: "A session format was created.", dataFields: ["format_id", "name", "slug", "default_duration_minutes"] },
  "room.created": { subject: "room", description: "A room was created.", dataFields: ["room_id", "venue_id", "name", "slug", "capacity"] },

  "sponsor.created": { subject: "sponsor", description: "A sponsor was created.", dataFields: ["sponsor_id", "name", "slug"] },
  "sponsorship.confirmed": { subject: "sponsorship", description: "A sponsorship was confirmed.", dataFields: ["sponsorship_id", "sponsor_id", "event_id", "tier_id"] },
  "sponsorship.cancelled": { subject: "sponsorship", description: "A sponsorship was cancelled.", dataFields: ["sponsorship_id", "reason"] },
  "entitlement.granted": { subject: "entitlement", description: "A countable sponsor right was granted.", dataFields: ["entitlement_id", "sponsorship_id", "entitlement_type", "quantity", "source"] },
  "entitlement.held": { subject: "entitlement", description: "An entitlement was provisionally held against a proposal.", dataFields: ["entitlement_id", "proposal_id", "remaining"] },
  "entitlement.released": { subject: "entitlement", description: "A held entitlement went back to the pool.", dataFields: ["entitlement_id", "proposal_id", "reason", "remaining"] },
  "entitlement.spent": { subject: "entitlement", description: "An entitlement was consumed by a session.", dataFields: ["entitlement_id", "session_id", "remaining"] },
  "entitlement.exhausted": { subject: "entitlement", description: "A sponsor used their last one.", dataFields: ["entitlement_id", "sponsor_id"] },
  "entitlement.expiring_soon": { subject: "entitlement", description: "A paid-for right is about to lapse.", dataFields: ["entitlement_id", "sponsor_id", "remaining", "expires_at", "days_remaining"] },
  "sponsor_contact.invited": { subject: "sponsor_contact", description: "A sponsor contact was invited.", dataFields: ["sponsor_contact_id", "sponsor_id", "person_id", "contact_role"] },
  "sponsor_contact.revoked": { subject: "sponsor_contact", description: "A sponsor contact lost access.", dataFields: ["sponsor_contact_id", "sponsor_id", "person_id"] },

  "proposal.created": { subject: "proposal", description: "A proposal was started — it may still be a draft.", dataFields: ["proposal_id", "reference", "cfp_id", "origin", "submitter_person_id"] },
  "proposal.submitted": { subject: "proposal", description: "A proposal left draft.", dataFields: ["proposal_id", "reference", "title", "format_id", "track_id", "speaker_person_ids[]", "is_late", "sponsor_id"] },
  "proposal.resubmitted": { subject: "proposal", description: "A proposal was edited and resubmitted.", dataFields: ["proposal_id", "revision_number", "changed_fields[]"] },
  "proposal.updated": { subject: "proposal", description: "A proposal changed.", dataFields: ["proposal_id", "changed_fields[]", "change_kind"] },
  "proposal.withdrawn": { subject: "proposal", description: "A proposal was withdrawn.", dataFields: ["proposal_id", "reason", "withdrawn_by"] },
  "proposal.changes_requested": { subject: "proposal", description: "The committee wants an edit before deciding.", dataFields: ["proposal_id", "decision_id", "note"] },
  "proposal.expired": { subject: "proposal", description: "A confirmation deadline passed unanswered.", dataFields: ["proposal_id", "confirmation_deadline"] },
  "proposal_speaker.added": { subject: "proposal", description: "A speaker was credited on a proposal.", dataFields: ["proposal_id", "person_id", "speaker_role", "invitation_id"] },
  "proposal_speaker.accepted": { subject: "proposal", description: "A credited speaker accepted.", dataFields: ["proposal_id", "person_id"] },
  "proposal_speaker.declined": { subject: "proposal", description: "A credited speaker declined.", dataFields: ["proposal_id", "person_id"] },
  "proposal_speaker.removed": { subject: "proposal", description: "A speaker was removed from a proposal.", dataFields: ["proposal_id", "person_id", "removed_by"] },
  "draft.abandoned": { subject: "proposal", description: "A draft went quiet and was given up on.", dataFields: ["proposal_id", "last_activity_at", "percent_complete"] },

  "review_round.opened": { subject: "round", description: "A review round opened.", dataFields: ["round_id", "name", "sequence", "proposal_count", "assignment_count"] },
  "review_round.closed": { subject: "round", description: "A review round closed.", dataFields: ["round_id", "submitted_review_count", "missing_review_count"] },
  "review_round_reviewer.added": { subject: "round", description: "A reviewer joined a round.", dataFields: ["round_id", "person_id", "pool_role", "track_ids[]", "max_assignments"] },
  "review_round_reviewer.removed": { subject: "round", description: "A reviewer left a round.", dataFields: ["round_id", "person_id", "removed_by"] },
  "review_assignment.created": { subject: "assignment", description: "A proposal was assigned to a reviewer.", dataFields: ["assignment_id", "round_id", "proposal_id", "reviewer_person_id", "due_at", "assigned_by"] },
  "review_assignment.declined": { subject: "assignment", description: "A reviewer declined an assignment.", dataFields: ["assignment_id", "reason"] },
  "review_assignment.reminded": { subject: "assignment", description: "A reviewer was chased.", dataFields: ["assignment_id", "reviewer_person_id", "reminder_count", "trigger", "triggered_by_person_id"] },
  "review.submitted": { subject: "review", description: "A review was submitted.", dataFields: ["review_id", "proposal_id", "round_id", "author_kind", "recommendation", "overall_score", "has_quorum"] },
  "review.ai_generated": { subject: "review", description: "An AI first-pass review was produced (R24 — off unless enabled).", dataFields: ["review_id", "proposal_id", "round_id", "ai_evaluator_key", "ai_model", "overall_score"] },
  "review.overridden": { subject: "review", description: "A review superseded an earlier one.", dataFields: ["review_id", "superseded_review_id", "proposal_id", "overridden_by_person_id"] },
  "review.stale": { subject: "review", description: "The proposal changed under a submitted review.", dataFields: ["review_id", "proposal_id", "previous_hash", "current_hash"] },
  "conflict_of_interest.declared": { subject: "coi", description: "A conflict of interest was declared.", dataFields: ["coi_id", "reviewer_person_id", "subject_type", "subject_id", "reason", "source"] },
  "decision.recorded": { subject: "decision", description: "A decision was recorded but not yet announced.", dataFields: ["decision_id", "proposal_id", "outcome", "decided_by"] },
  "decision.published": { subject: "decision", description: "The highest-value event in the catalogue — session creation, onboarding, speaker notification and external integrations all key off it.", dataFields: ["decision_id", "proposal_id", "outcome", "assigned_track_id", "assigned_format_id", "assigned_duration_minutes", "confirmation_deadline"] },
  "proposal.accepted": { subject: "proposal", description: "A proposal was accepted.", dataFields: ["proposal_id", "decision_id", "confirmation_deadline"] },
  "proposal.waitlisted": { subject: "proposal", description: "A proposal was waitlisted — a real state, not a soft rejection.", dataFields: ["proposal_id", "decision_id"] },
  "proposal.rejected": { subject: "proposal", description: "A proposal was rejected.", dataFields: ["proposal_id", "decision_id"] },

  "session.created": { subject: "session", description: "A session was created.", dataFields: ["session_id", "proposal_id", "origin", "title", "format_id", "track_id", "sponsor_id", "speaker_person_ids[]"] },
  "session.confirmed": { subject: "session", description: "A session was confirmed.", dataFields: ["session_id"] },
  "session.updated": { subject: "session", description: "A session changed.", dataFields: ["session_id", "changed_fields[]"] },
  "session.cancelled": { subject: "session", description: "A session was cancelled.", dataFields: ["session_id", "reason", "was_published"] },
  "session.delivered": { subject: "session", description: "A session was delivered on the day.", dataFields: ["session_id"] },
  "session.content_approved": { subject: "session", description: "Session content was approved.", dataFields: ["session_id", "approved_by_person_id", "revision_number"] },
  "session.content_approval_revoked": { subject: "session", description: "An edit invalidated a prior approval.", dataFields: ["session_id", "changed_fields[]", "changed_by_person_id"] },
  "session.content_restored": { subject: "session", description: "Session content was rolled back to a revision.", dataFields: ["session_id", "revision_number", "restored_from_revision_id", "restored_by_person_id"] },
  "session_speaker.confirmed": { subject: "session", description: "A speaker confirmed they are presenting.", dataFields: ["session_id", "person_id", "speaker_role"] },
  "session_speaker.declined": { subject: "session", description: "A speaker declined.", dataFields: ["session_id", "person_id", "reason"] },
  "session_speaker.replaced": { subject: "session", description: "One speaker was swapped for another.", dataFields: ["session_id", "outgoing_person_id", "incoming_person_id", "transferred_task_count"] },
  "session_asset.uploaded": { subject: "session", description: "An asset was attached to a session.", dataFields: ["session_id", "asset_id", "kind", "is_public"] },

  "task_definition.activated": { subject: "definition", description: "A task definition version went live.", dataFields: ["definition_id", "key", "version", "is_blocking"] },
  "task_instance.created": { subject: "task", description: "An onboarding obligation landed on somebody.", dataFields: ["task_instance_id", "definition_key", "subject_type", "subject_id", "assignee_person_id", "due_at", "is_blocking"] },
  "task_instance.started": { subject: "task", description: "Somebody began a task.", dataFields: ["task_instance_id"] },
  "task_instance.submitted": { subject: "task", description: "A task was submitted for review.", dataFields: ["task_instance_id", "submission_version"] },
  "task_instance.completed": { subject: "task", description: "A task was completed.", dataFields: ["task_instance_id", "completed_by", "days_to_complete", "reminder_count"] },
  "task_instance.changes_requested": { subject: "task", description: "A submitted task needs rework.", dataFields: ["task_instance_id", "review_note"] },
  "task_instance.waived": { subject: "task", description: "A task was waived.", dataFields: ["task_instance_id", "waived_by", "waiver_reason"] },
  "task_instance.cancelled": { subject: "task", description: "A task was cancelled.", dataFields: ["task_instance_id", "reason"] },
  "task_instance.overdue": { subject: "task", description: "A task passed its due date.", dataFields: ["task_instance_id", "due_at", "days_overdue"] },
  "task_reminder.sent": { subject: "task", description: "A reminder went out per the task's escalation rules.", dataFields: ["task_instance_id", "rule_id", "reminder_count", "escalated_to"] },
  "onboarding.session_complete": { subject: "session", description: "Every blocking task for a session is done.", dataFields: ["session_id", "blocking_task_count"] },

  "placement.created": { subject: "placement", description: "A session was placed on the grid.", dataFields: ["placement_id", "session_id", "room_id", "starts_at", "ends_at"] },
  "placement.moved": { subject: "placement", description: "A placement moved.", dataFields: ["placement_id", "session_id", "from{room_id,starts_at}", "to{room_id,starts_at}"] },
  "placement.removed": { subject: "placement", description: "A session came off the grid.", dataFields: ["placement_id", "session_id"] },
  "schedule.conflict_detected": { subject: "event", description: "The grid contradicts itself.", dataFields: ["code", "severity", "placement_ids[]", "detail"] },
  "schedule.auto_place_proposed": { subject: "event", description: "An auto-placement run produced a proposal.", dataFields: ["run_id", "strategy", "proposed_count", "unplaceable_count", "conflicts_introduced"] },
  "schedule.auto_place_applied": { subject: "event", description: "An auto-placement proposal was applied.", dataFields: ["run_id", "applied_session_ids[]", "skipped_session_ids[]"] },
  "schedule.published": { subject: "publication", description: "A schedule version went public.", dataFields: ["publication_id", "version", "session_count", "content_etag", "override_reasons"] },
  "schedule.changed": { subject: "publication", description: "A published schedule changed.", dataFields: ["publication_id", "version", "diff[{change_type,session_id,before,after}]"] },
  "schedule.rolled_back": { subject: "publication", description: "A publication was rolled back.", dataFields: ["publication_id", "restored_version", "rolled_back_from_version"] },
  "session.time_changed": { subject: "session", description: "Fires on publication only, not on every drag in the planning UI.", dataFields: ["session_id", "from", "to", "publication_id"] },
  "session.room_changed": { subject: "session", description: "Fires on publication only, not on every drag in the planning UI.", dataFields: ["session_id", "from_room", "to_room", "publication_id"] },
  "embed_config.created": { subject: "embed", description: "An embeddable schedule widget was configured.", dataFields: ["embed_config_id", "event_id", "format", "allowed_origins"] },

  "api_key.created": { subject: "api_key", description: "An API key was created.", dataFields: ["api_key_id", "name", "scopes[]"] },
  "api_key.revoked": { subject: "api_key", description: "An API key was revoked.", dataFields: ["api_key_id", "name", "scopes[]"] },
  "webhook.created": { subject: "webhook", description: "A webhook was created.", dataFields: ["webhook_id", "url", "event_types[]"] },
  "webhook.delivery_failed": { subject: "webhook", description: "A delivery attempt failed.", dataFields: ["webhook_id", "delivery_id", "attempt", "response_status", "error"] },
  "webhook.disabled": { subject: "webhook", description: "A webhook was disabled after repeated failures.", dataFields: ["webhook_id", "consecutive_failures"] },
  "integration.installed": { subject: "integration", description: "An integration was installed.", dataFields: ["integration_id", "plugin_key", "capability"] },
  "integration.health_changed": { subject: "integration", description: "An integration's health changed.", dataFields: ["integration_id", "status", "last_error"] },
  "notification.sent": { subject: "notification", description: "A notification was sent.", dataFields: ["notification_id", "template_key", "recipient_person_id", "channel", "campaign_id"] },
  "notification.bounced": { subject: "notification", description: "A notification bounced.", dataFields: ["notification_id", "recipient_email", "bounce_type"] },
  "campaign.created": { subject: "campaign", description: "A campaign was drafted.", dataFields: ["campaign_id", "event_id", "channel", "template_id", "recipient_count"] },
  "campaign.sent": { subject: "campaign", description: "A campaign finished sending.", dataFields: ["campaign_id", "recipient_count", "sent", "suppressed", "failed"] },
  "campaign.recipient_failed": { subject: "campaign", description: "One recipient in a campaign failed.", dataFields: ["campaign_id", "person_id", "reason"] },

  "asset.uploaded": { subject: "asset", description: "A file was uploaded.", dataFields: ["asset_id", "slot_key", "version", "purpose", "filename", "size_bytes", "uploaded_by_person_id"] },
  "asset.version_superseded": { subject: "asset", description: "A newer version replaced an asset.", dataFields: ["asset_id", "superseded_asset_id", "slot_key", "version"] },
  "asset.scan_completed": { subject: "asset", description: "A scan of an uploaded file finished.", dataFields: ["asset_id", "scan_status"] },
  "asset_comment.added": { subject: "asset", description: "Somebody commented on an asset.", dataFields: ["comment_id", "asset_id", "slot_key", "author_person_id", "parent_id"] },
  "custom_field.defined": { subject: "custom_field", description: "A custom field was defined.", dataFields: ["definition_id", "subject_type", "key", "type", "pii", "audience"] },
  "bulk_import.completed": { subject: "import", description: "A bulk import finished.", dataFields: ["import_id", "subject", "row_count", "created_count", "updated_count", "skipped_count", "error_count"] },
  "export.ready": { subject: "export", description: "An export is ready to download.", dataFields: ["export_id", "subject", "format", "row_count", "byte_size", "expires_at"] },

  "contact_segment.created": { subject: "segment", description: "A contact segment was created.", dataFields: ["segment_id", "name", "kind", "member_count"] },
  "contact_segment.updated": { subject: "segment", description: "A contact segment changed.", dataFields: ["segment_id", "changed_fields[]", "member_count"] },
  "sourcing_pipeline.created": { subject: "pipeline", description: "A sourcing pipeline was created.", dataFields: ["pipeline_id", "event_id", "name", "stage_names[]"] },
  "prospect.enrolled": { subject: "prospect", description: "Somebody was enrolled as a prospect. Never carries rationale or score commentary (INV-14-6).", dataFields: ["card_id", "pipeline_id", "person_id", "stage_id", "event_id", "score"] },
  "prospect.stage_changed": { subject: "prospect", description: "A prospect moved stage.", dataFields: ["card_id", "from_stage_id", "to_stage_id", "to_stage_kind", "moved_by_person_id", "days_in_previous_stage"] },
  "prospect.converted": { subject: "prospect", description: "A prospect became a participant.", dataFields: ["card_id", "person_id", "event_id", "participant_id"] },
  "prospect.stalled": { subject: "prospect", description: "A prospect went quiet.", dataFields: ["card_id", "person_id", "stage_id", "days_in_stage", "next_action_at"] },
};

/** Every catalogue member, enriched. Built once — the catalogue is static. */
const ALL_EVENTS: readonly EventMetadata[] = EVENT_TYPES.map((type) => {
  const prose = PROSE[type];
  return {
    type,
    subject: prose?.subject ?? type.slice(0, type.lastIndexOf(".")),
    description: prose?.description ?? "",
    dataFields: prose?.dataFields ?? [],
    hasPii: PII_EVENT_TYPES.has(type),
    category: categoryOf(type),
  };
});

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export function getAllEvents(): readonly EventMetadata[] {
  return ALL_EVENTS;
}

export function getEventMetadata(type: string): EventMetadata | null {
  return ALL_EVENTS.find((e) => e.type === type) ?? null;
}

export function getEventsByCategory(category: string): EventMetadata[] {
  return ALL_EVENTS.filter((e) => e.category === category);
}

/** Categories that actually have members, in catalogue order. */
export function getUniqueCategories(): string[] {
  const present = new Set(ALL_EVENTS.map((e) => e.category));
  const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
  for (const c of present) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

/**
 * Resolve a `Webhook.event_types` value the same way delivery does — via the
 * domain's `eventTypeMatches`, so the panel can never disagree with what the
 * dispatcher will actually send. Accepts the comma-separated form the field
 * stores.
 */
export function getEventsByPattern(pattern: string): EventMetadata[] {
  const patterns = pattern.split(",").map((p) => p.trim()).filter(Boolean);
  if (patterns.length === 0) return [...ALL_EVENTS];
  return ALL_EVENTS.filter((e) => patterns.some((p) => eventTypeMatches(p, e.type)));
}

/* -------------------------------------------------------------------------- */
/* Template variables                                                          */
/* -------------------------------------------------------------------------- */

const VARIABLE_DESCRIPTIONS: Record<string, string> = {
  "event.name": "The event's name — speaker mail is sent as the event, not as Podium",
  "event.slug": "URL-safe short name for the event",
  "event.starts_on": "First day of the event",
  "event.ends_on": "Last day of the event",
  "event.timezone": "The event's timezone",
  "event.url": "Public link to the event",
  "org.name": "Your organization's name",
  "recipient.name": "The recipient's full name",
  "recipient.first_name": "The recipient's first name",
  "recipient.email": "The recipient's email address",
  portal_url: "Link to this person's portal",
  unsubscribe_url: "Unsubscribe link — ignored for transactional mail (INV-09-10)",
  "proposal.title": "Title of the proposal",
  "proposal.reference": "Short reference the submitter can quote back",
  "proposal.url": "Link to view or edit the proposal",
  "cfp.name": "Name of the call for proposals",
  "cfp.closes_at": "When the call closes",
  "decision.confirmation_deadline": "By when the speaker must confirm before the slot is released",
  "decision.feedback": "Feedback written for the speaker",
  "decision.conditions": "Any conditions attached to the acceptance",
  "decision.note": "The note explaining what change is wanted",
  "session.title": "Title of the session",
  "session.starts_at": "When the session starts",
  "session.room": "Room the session is in",
  "task.title": "Title of the task",
  "task.due_at": "When the task is due",
  "task.url": "Link to complete the task",
  "task.instructions": "Instructions for the task",
  days_remaining: "Days left until the deadline",
  change_summary: "Plain-language summary of what changed",
  schedule_url: "Link to the published schedule",
  "invitation.accept_url": "Single-use link to accept the invitation",
  "invitation.kind": "What the person is being invited as",
  invited_by: "Who sent the invitation",
  confirmation_deadline: "By when the speaker must confirm",
  confirm_url: "Link to confirm",
  "round.name": "Name of the review round",
  assignment_count: "How many proposals are assigned",
  due_at: "When it is due",
  review_url: "Link to the review queue",
  outstanding_count: "How many are still open",
  "sponsor.name": "The sponsor's name",
  "entitlement.type": "Which countable sponsor right this is",
  remaining: "How many are left",
  expires_at: "When it expires",
};

/**
 * INV-09-13 validates a save against exactly the declared set, so the panel
 * shows exactly that set — anything wider and the organizer is told a variable
 * works that the save will reject.
 */
export function getTemplateVariableMetadata(key: string | null | undefined): VariableMetadata[] {
  const vars: VariableMetadata[] = COMMON_VARIABLES.map((name) => ({
    name,
    group: "common" as const,
    description: VARIABLE_DESCRIPTIONS[name] ?? "",
  }));

  const spec = key ? DEFAULT_TEMPLATES.find((t) => t.key === key) : null;
  if (spec) {
    for (const name of spec.variables) {
      vars.push({ name, group: "template-specific", description: VARIABLE_DESCRIPTIONS[name] ?? "" });
    }
  }
  return vars;
}

export function getTemplateSpecs(): readonly TemplateSpec[] {
  return DEFAULT_TEMPLATES;
}

export function getTemplateSpec(key: string): TemplateSpec | null {
  return DEFAULT_TEMPLATES.find((t) => t.key === key) ?? null;
}
