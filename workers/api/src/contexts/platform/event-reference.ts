/**
 * Event reference metadata for admin UX.
 *
 * Extracts event catalogue and template variable information from the domain
 * to display contextually in admin forms, so users don't need to read
 * documentation or source code.
 */

import { DEFAULT_TEMPLATES, COMMON_VARIABLES, type TemplateSpec } from "@podiumconf/domain/platform/templates.js";
import { type DomainEventCatalogue } from "@podiumconf/domain/events/catalogue.js";

export interface EventMetadata {
  type: string;
  subject: string;
  description: string;
  dataFields: string[];
  hasPii: boolean;
  category: string;
}

export interface VariableMetadata {
  name: string;
  group: "common" | "template-specific" | "campaign";
  description: string;
}

// Hardcoded event catalogue metadata — mirrors 10-domain-events.md
const EVENT_CATALOGUE: Record<string, EventMetadata> = {
  // Identity
  "organization.created": {
    type: "organization.created",
    subject: "organization",
    category: "Identity",
    description: "Organization created",
    dataFields: ["organization_id", "name", "slug"],
    hasPii: false,
  },
  "person.created": {
    type: "person.created",
    subject: "person",
    category: "Identity",
    description: "Person created",
    dataFields: ["person_id", "full_name", "email", "source"],
    hasPii: true,
  },
  "person.merged": {
    type: "person.merged",
    subject: "person",
    category: "Identity",
    description: "Two person records merged",
    dataFields: ["surviving_person_id", "merged_person_id", "merged_by"],
    hasPii: true,
  },
  "person.deactivated": {
    type: "person.deactivated",
    subject: "person",
    category: "Identity",
    description: "Person deactivated",
    dataFields: ["person_id", "reason"],
    hasPii: false,
  },
  "speaker_profile.updated": {
    type: "speaker_profile.updated",
    subject: "person",
    category: "Identity",
    description: "Speaker profile updated",
    dataFields: ["person_id", "changed_fields[]", "edited_by_person_id", "edited_by_role"],
    hasPii: false,
  },
  "event_participant.added": {
    type: "event_participant.added",
    subject: "person",
    category: "Identity",
    description: "Event participant added",
    dataFields: ["participant_id", "event_id", "person_id", "kind", "status", "source"],
    hasPii: true,
  },
  "event_participant.status_changed": {
    type: "event_participant.status_changed",
    subject: "person",
    category: "Identity",
    description: "Participant status changed",
    dataFields: ["participant_id", "event_id", "person_id", "from", "to"],
    hasPii: false,
  },
  "role_grant.created": {
    type: "role_grant.created",
    subject: "person",
    category: "Identity",
    description: "Role granted to person",
    dataFields: ["person_id", "role", "scope_type", "scope_id", "granted_by"],
    hasPii: false,
  },
  "role_grant.revoked": {
    type: "role_grant.revoked",
    subject: "person",
    category: "Identity",
    description: "Role revoked from person",
    dataFields: ["person_id", "role", "scope_type", "scope_id", "revoked_by"],
    hasPii: false,
  },
  "invitation.sent": {
    type: "invitation.sent",
    subject: "invitation",
    category: "Identity",
    description: "Invitation sent",
    dataFields: ["invitation_id", "kind", "email", "context_type", "context_id", "expires_at"],
    hasPii: true,
  },
  "invitation.accepted": {
    type: "invitation.accepted",
    subject: "invitation",
    category: "Identity",
    description: "Invitation accepted",
    dataFields: ["invitation_id", "person_id"],
    hasPii: false,
  },

  // Event configuration
  "event.created": {
    type: "event.created",
    subject: "event",
    category: "Event configuration",
    description: "Event created",
    dataFields: ["event_id", "name", "slug", "starts_on", "ends_on", "timezone"],
    hasPii: false,
  },
  "event.activated": {
    type: "event.activated",
    subject: "event",
    category: "Event configuration",
    description: "Event activated",
    dataFields: ["event_id"],
    hasPii: false,
  },
  "event.archived": {
    type: "event.archived",
    subject: "event",
    category: "Event configuration",
    description: "Event archived",
    dataFields: ["event_id"],
    hasPii: false,
  },
  "cfp.opened": {
    type: "cfp.opened",
    subject: "cfp",
    category: "Event configuration",
    description: "Call for proposals opened",
    dataFields: ["cfp_id", "name", "audience", "opens_at", "closes_at"],
    hasPii: false,
  },
  "cfp.closed": {
    type: "cfp.closed",
    subject: "cfp",
    category: "Event configuration",
    description: "Call for proposals closed",
    dataFields: ["cfp_id", "closed_early", "proposal_count"],
    hasPii: false,
  },

  // Submissions
  "proposal.submitted": {
    type: "proposal.submitted",
    subject: "proposal",
    category: "Submissions",
    description: "Proposal submitted",
    dataFields: ["proposal_id", "reference", "title", "format_id", "track_id", "speaker_person_ids[]", "is_late", "sponsor_id"],
    hasPii: true,
  },
  "proposal.resubmitted": {
    type: "proposal.resubmitted",
    subject: "proposal",
    category: "Submissions",
    description: "Proposal resubmitted",
    dataFields: ["proposal_id", "revision_number", "changed_fields[]"],
    hasPii: false,
  },
  "proposal.withdrawn": {
    type: "proposal.withdrawn",
    subject: "proposal",
    category: "Submissions",
    description: "Proposal withdrawn",
    dataFields: ["proposal_id", "reason", "withdrawn_by"],
    hasPii: false,
  },
  "proposal.changes_requested": {
    type: "proposal.changes_requested",
    subject: "proposal",
    category: "Submissions",
    description: "Changes requested on proposal",
    dataFields: ["proposal_id", "decision_id", "note"],
    hasPii: false,
  },
  "proposal_speaker.added": {
    type: "proposal_speaker.added",
    subject: "proposal",
    category: "Submissions",
    description: "Speaker added to proposal",
    dataFields: ["proposal_id", "person_id", "speaker_role", "invitation_id"],
    hasPii: true,
  },
  "proposal_speaker.accepted": {
    type: "proposal_speaker.accepted",
    subject: "proposal",
    category: "Submissions",
    description: "Speaker accepted proposal",
    dataFields: ["proposal_id", "person_id"],
    hasPii: false,
  },
  "proposal_speaker.declined": {
    type: "proposal_speaker.declined",
    subject: "proposal",
    category: "Submissions",
    description: "Speaker declined proposal",
    dataFields: ["proposal_id", "person_id"],
    hasPii: false,
  },

  // Review & selection
  "review_round.opened": {
    type: "review_round.opened",
    subject: "round",
    category: "Review & selection",
    description: "Review round opened",
    dataFields: ["round_id", "name", "sequence", "proposal_count", "assignment_count"],
    hasPii: false,
  },
  "review_round.closed": {
    type: "review_round.closed",
    subject: "round",
    category: "Review & selection",
    description: "Review round closed",
    dataFields: ["round_id", "submitted_review_count", "missing_review_count"],
    hasPii: false,
  },
  "review_assignment.created": {
    type: "review_assignment.created",
    subject: "assignment",
    category: "Review & selection",
    description: "Review assignment created",
    dataFields: ["assignment_id", "round_id", "proposal_id", "reviewer_person_id", "due_at", "assigned_by"],
    hasPii: false,
  },
  "review.submitted": {
    type: "review.submitted",
    subject: "review",
    category: "Review & selection",
    description: "Review submitted",
    dataFields: ["review_id", "proposal_id", "round_id", "author_kind", "recommendation", "overall_score", "has_quorum"],
    hasPii: false,
  },
  "decision.published": {
    type: "decision.published",
    subject: "decision",
    category: "Review & selection",
    description: "Decision published (key event)",
    dataFields: ["decision_id", "proposal_id", "outcome", "assigned_track_id", "assigned_format_id", "assigned_duration_minutes", "confirmation_deadline"],
    hasPii: false,
  },
  "proposal.accepted": {
    type: "proposal.accepted",
    subject: "proposal",
    category: "Review & selection",
    description: "Proposal accepted",
    dataFields: ["proposal_id", "decision_id", "confirmation_deadline"],
    hasPii: false,
  },
  "proposal.rejected": {
    type: "proposal.rejected",
    subject: "proposal",
    category: "Review & selection",
    description: "Proposal rejected",
    dataFields: ["proposal_id", "decision_id"],
    hasPii: false,
  },
  "proposal.waitlisted": {
    type: "proposal.waitlisted",
    subject: "proposal",
    category: "Review & selection",
    description: "Proposal waitlisted",
    dataFields: ["proposal_id", "decision_id"],
    hasPii: false,
  },

  // Program
  "session.created": {
    type: "session.created",
    subject: "session",
    category: "Program",
    description: "Session created",
    dataFields: ["session_id", "proposal_id", "origin", "title", "format_id", "track_id", "sponsor_id", "speaker_person_ids[]"],
    hasPii: false,
  },
  "session.confirmed": {
    type: "session.confirmed",
    subject: "session",
    category: "Program",
    description: "Session confirmed",
    dataFields: ["session_id"],
    hasPii: false,
  },
  "session.cancelled": {
    type: "session.cancelled",
    subject: "session",
    category: "Program",
    description: "Session cancelled",
    dataFields: ["session_id", "reason", "was_published"],
    hasPii: false,
  },
  "session.delivered": {
    type: "session.delivered",
    subject: "session",
    category: "Program",
    description: "Session delivered",
    dataFields: ["session_id"],
    hasPii: false,
  },
  "session_speaker.confirmed": {
    type: "session_speaker.confirmed",
    subject: "session",
    category: "Program",
    description: "Speaker confirmed for session",
    dataFields: ["session_id", "person_id", "speaker_role"],
    hasPii: false,
  },
  "session_speaker.declined": {
    type: "session_speaker.declined",
    subject: "session",
    category: "Program",
    description: "Speaker declined session",
    dataFields: ["session_id", "person_id", "reason"],
    hasPii: false,
  },

  // Onboarding
  "task_instance.created": {
    type: "task_instance.created",
    subject: "task",
    category: "Onboarding",
    description: "Task created",
    dataFields: ["task_instance_id", "definition_key", "subject_type", "subject_id", "assignee_person_id", "due_at", "is_blocking"],
    hasPii: false,
  },
  "task_instance.submitted": {
    type: "task_instance.submitted",
    subject: "task",
    category: "Onboarding",
    description: "Task submitted",
    dataFields: ["task_instance_id", "submission_version"],
    hasPii: false,
  },
  "task_instance.completed": {
    type: "task_instance.completed",
    subject: "task",
    category: "Onboarding",
    description: "Task completed",
    dataFields: ["task_instance_id", "completed_by", "days_to_complete", "reminder_count"],
    hasPii: false,
  },
  "task_instance.overdue": {
    type: "task_instance.overdue",
    subject: "task",
    category: "Onboarding",
    description: "Task overdue",
    dataFields: ["task_instance_id", "due_at", "days_overdue"],
    hasPii: false,
  },

  // Scheduling
  "placement.created": {
    type: "placement.created",
    subject: "placement",
    category: "Scheduling & publication",
    description: "Placement created",
    dataFields: ["placement_id", "session_id", "room_id", "starts_at", "ends_at"],
    hasPii: false,
  },
  "placement.moved": {
    type: "placement.moved",
    subject: "placement",
    category: "Scheduling & publication",
    description: "Placement moved",
    dataFields: ["placement_id", "session_id", "from", "to"],
    hasPii: false,
  },
  "schedule.published": {
    type: "schedule.published",
    subject: "publication",
    category: "Scheduling & publication",
    description: "Schedule published",
    dataFields: ["publication_id", "version", "session_count", "content_etag", "override_reasons"],
    hasPii: false,
  },
  "schedule.changed": {
    type: "schedule.changed",
    subject: "publication",
    category: "Scheduling & publication",
    description: "Schedule changed",
    dataFields: ["publication_id", "version", "diff"],
    hasPii: false,
  },
  "session.time_changed": {
    type: "session.time_changed",
    subject: "session",
    category: "Scheduling & publication",
    description: "Session time changed (published)",
    dataFields: ["session_id", "from", "to", "publication_id"],
    hasPii: false,
  },
  "session.room_changed": {
    type: "session.room_changed",
    subject: "session",
    category: "Scheduling & publication",
    description: "Session room changed (published)",
    dataFields: ["session_id", "from_room", "to_room", "publication_id"],
    hasPii: false,
  },

  // Platform
  "webhook.created": {
    type: "webhook.created",
    subject: "webhook",
    category: "Platform",
    description: "Webhook created",
    dataFields: ["webhook_id", "url", "event_types[]"],
    hasPii: false,
  },
  "webhook.delivery_failed": {
    type: "webhook.delivery_failed",
    subject: "webhook",
    category: "Platform",
    description: "Webhook delivery failed",
    dataFields: ["webhook_id", "delivery_id", "attempt", "response_status", "error"],
    hasPii: false,
  },
  "notification.sent": {
    type: "notification.sent",
    subject: "notification",
    category: "Platform",
    description: "Notification sent",
    dataFields: ["notification_id", "template_key", "recipient_person_id", "channel", "campaign_id"],
    hasPii: false,
  },
  "campaign.sent": {
    type: "campaign.sent",
    subject: "campaign",
    category: "Platform",
    description: "Campaign sent",
    dataFields: ["campaign_id", "recipient_count", "sent", "suppressed", "failed"],
    hasPii: false,
  },

  // Sponsorship
  "sponsor.created": {
    type: "sponsor.created",
    subject: "sponsor",
    category: "Sponsorship",
    description: "Sponsor created",
    dataFields: ["sponsor_id", "name", "slug"],
    hasPii: false,
  },
  "sponsorship.confirmed": {
    type: "sponsorship.confirmed",
    subject: "sponsorship",
    category: "Sponsorship",
    description: "Sponsorship confirmed",
    dataFields: ["sponsorship_id", "sponsor_id", "event_id", "tier_id"],
    hasPii: false,
  },
  "entitlement.granted": {
    type: "entitlement.granted",
    subject: "entitlement",
    category: "Sponsorship",
    description: "Entitlement granted",
    dataFields: ["entitlement_id", "sponsorship_id", "entitlement_type", "quantity", "source"],
    hasPii: false,
  },
  "entitlement.spent": {
    type: "entitlement.spent",
    subject: "entitlement",
    category: "Sponsorship",
    description: "Entitlement spent",
    dataFields: ["entitlement_id", "session_id", "remaining"],
    hasPii: false,
  },
};

const VARIABLE_DESCRIPTIONS: Record<string, string> = {
  "event.name": "The name of the event",
  "event.slug": "The URL-safe slug of the event",
  "event.starts_on": "Event start date",
  "event.ends_on": "Event end date",
  "event.timezone": "Event timezone",
  "event.url": "URL to the event",
  "org.name": "Organization name",
  "recipient.name": "Full name of the recipient",
  "recipient.first_name": "First name of the recipient",
  "recipient.email": "Email address of the recipient",
  "portal_url": "Link to the speaker/sponsor portal",
  "unsubscribe_url": "Unsubscribe link for the recipient",
  "proposal.title": "The title of the proposal",
  "proposal.reference": "The reference number of the proposal",
  "proposal.url": "URL to view/edit the proposal",
  "cfp.name": "Name of the call for proposals",
  "cfp.closes_at": "When the call closes",
  "decision.confirmation_deadline": "Deadline to confirm acceptance",
  "decision.feedback": "Feedback on the decision",
  "decision.conditions": "Any conditions on the decision",
  "session.title": "Title of the session",
  "session.starts_at": "When the session starts",
  "session.room": "Room where the session takes place",
  "task.title": "Title of the task",
  "task.due_at": "When the task is due",
  "task.url": "URL to view/complete the task",
  "task.instructions": "Instructions for the task",
  "days_remaining": "Days remaining until deadline",
  "change_summary": "Summary of what changed",
  "schedule_url": "URL to view the schedule",
  "invitation.accept_url": "Link to accept the invitation",
  "invitation.kind": "Type of invitation",
  "invited_by": "Name of person who sent the invitation",
  "confirmation_deadline": "Deadline to confirm",
  "confirm_url": "Link to confirm",
  "round.name": "Name of the review round",
  "assignment_count": "Number of assignments",
  "due_at": "When something is due",
  "review_url": "URL to access reviews",
  "outstanding_count": "Number of outstanding items",
  "sponsor.name": "Name of the sponsor",
  "entitlement.type": "Type of sponsor entitlement",
  "remaining": "Number of remaining items",
  "expires_at": "When something expires",
};

export function getEventMetadata(eventType: string): EventMetadata | null {
  return EVENT_CATALOGUE[eventType] ?? null;
}

export function getAllEvents(): EventMetadata[] {
  return Object.values(EVENT_CATALOGUE);
}

export function getEventsByCategory(category: string): EventMetadata[] {
  return Object.values(EVENT_CATALOGUE).filter((e) => e.category === category);
}

export function getUniqueCategories(): string[] {
  const categories = new Set(Object.values(EVENT_CATALOGUE).map((e) => e.category));
  return Array.from(categories).sort();
}

export function getEventsByPattern(pattern: string): EventMetadata[] {
  const regex = pattern.replace("*", ".*");
  const re = new RegExp(`^${regex}$`);
  return Object.values(EVENT_CATALOGUE).filter((e) => re.test(e.type));
}

export function getTemplateVariableMetadata(key: string | null): VariableMetadata[] {
  const vars: VariableMetadata[] = [];

  // Add common variables
  for (const name of COMMON_VARIABLES) {
    vars.push({
      name,
      group: "common",
      description: VARIABLE_DESCRIPTIONS[name] ?? "",
    });
  }

  // Add template-specific variables
  if (key) {
    const spec = DEFAULT_TEMPLATES.find((t) => t.key === key);
    if (spec) {
      for (const name of spec.variables) {
        vars.push({
          name,
          group: "template-specific",
          description: VARIABLE_DESCRIPTIONS[name] ?? "",
        });
      }
    }
  }

  return vars;
}

export function getTemplateSpecs(): TemplateSpec[] {
  return DEFAULT_TEMPLATES;
}

export function getTemplateSpec(key: string): TemplateSpec | null {
  return DEFAULT_TEMPLATES.find((t) => t.key === key) ?? null;
}
