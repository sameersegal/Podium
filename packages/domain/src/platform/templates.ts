/**
 * Notification templates — 09, "Variables and preview".
 *
 * The declared variable set per `template_key` lives here, as data, because
 * INV-09-13 makes it the thing a save is validated against. A template
 * referencing `{{talk_title}}` when the variable is `{{session.title}}` is
 * rejected while the organizer is looking at it, not rendered as an empty
 * string into four hundred inboxes.
 *
 * **Speaker-facing email is sent as the event, not as the product**
 * (12-glossary.md): the from-name is the event's name, and no default body
 * below mentions Podium.
 *
 * `audience` classifies who a key is *for* — 09, "Notifications": it is what
 * the rendered email's header label and footer permission-reason line are
 * chosen from, never a stored field on `NotificationTemplate` (an organizer's
 * override changes the words, not who the message is for).
 */

export type TemplateChannel = "email" | "chat";

/**
 * 09, "Notifications": internal audiences (`organizers`, `reviewers`) and
 * external ones (`speakers`, `sponsors`) share the same rendered shell, and
 * on every one of them Podium is a footer credit, never the sender's voice
 * (12-glossary.md).
 */
export type TemplateAudience = "organizers" | "reviewers" | "speakers" | "sponsors";

export interface TemplateSpec {
  key: string;
  channel: TemplateChannel;
  /** Extra variables beyond `COMMON_VARIABLES`. */
  variables: readonly string[];
  /**
   * INV-09-10: a transactional message tied to a person's own proposal,
   * session or task is never suppressed by a marketing unsubscribe.
   */
  transactional: boolean;
  /** Who this message is for — drives the rendered email's header label and footer reason. */
  audience: TemplateAudience;
  subject: string;
  body_markdown: string;
  description: string;
}

/** Available to every template, whatever its key. */
export const COMMON_VARIABLES = [
  "event.name",
  "event.slug",
  "event.starts_on",
  "event.ends_on",
  "event.timezone",
  "event.url",
  "org.name",
  "recipient.name",
  "recipient.first_name",
  "recipient.email",
  "portal_url",
  "unsubscribe_url",
] as const;

export const DEFAULT_TEMPLATES: readonly TemplateSpec[] = [
  {
    key: "proposal.submitted",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["proposal.title", "proposal.reference", "proposal.url", "cfp.name", "cfp.closes_at"],
    description: "Sent to the submitter the moment a proposal leaves draft.",
    subject: "We have your proposal — {{proposal.reference}}",
    body_markdown: `Hi {{recipient.first_name}},

Thanks for submitting **{{proposal.title}}** to {{event.name}}.

Your reference is **{{proposal.reference}}**. You can review or update it at any time before
the call closes on {{cfp.closes_at}}.

[Review your proposal]({{proposal.url}})

We will be in touch once review is finished.

— The {{event.name}} programme team`,
  },
  {
    key: "proposal.accepted",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: [
      "proposal.title",
      "proposal.reference",
      "decision.confirmation_deadline",
      "decision.feedback",
      "decision.conditions",
      "session.title",
      "confirm_url",
    ],
    description: "The acceptance letter. Carries the confirmation deadline.",
    subject: "Your talk was accepted for {{event.name}}",
    body_markdown: `Hi {{recipient.first_name}},

We would like to include **{{proposal.title}}** in the {{event.name}} programme.

Please confirm by **{{decision.confirmation_deadline}}**. If we do not hear from you by then
the slot is released to somebody on the waitlist.

[Confirm your slot]({{confirm_url}})

{{decision.feedback}}

{{decision.conditions}}

— The {{event.name}} programme team`,
  },
  {
    key: "proposal.rejected",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["proposal.title", "proposal.reference", "decision.feedback"],
    description: "The rejection letter, carrying feedback_for_speaker where there is any.",
    subject: "About your {{event.name}} proposal",
    body_markdown: `Hi {{recipient.first_name}},

Thank you for proposing **{{proposal.title}}** to {{event.name}}. We had more good
submissions than slots, and we are not able to include it this time.

{{decision.feedback}}

We would be glad to see you submit again.

— The {{event.name}} programme team`,
  },
  {
    key: "proposal.waitlisted",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["proposal.title", "proposal.reference", "decision.feedback"],
    description: "Waitlist notice — a real state, not a soft rejection.",
    subject: "Your {{event.name}} proposal is on the waitlist",
    body_markdown: `Hi {{recipient.first_name}},

**{{proposal.title}}** is on the waitlist for {{event.name}}. That means we would like to
include it and do not yet have a slot. If one opens up we will contact you first.

{{decision.feedback}}

— The {{event.name}} programme team`,
  },
  {
    key: "proposal.changes_requested",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["proposal.title", "proposal.reference", "proposal.url", "decision.note"],
    description: "The committee wants an edit before deciding.",
    subject: "A change to your proposal {{proposal.reference}}",
    body_markdown: `Hi {{recipient.first_name}},

Before we decide on **{{proposal.title}}** we would like one change:

> {{decision.note}}

[Edit and resubmit]({{proposal.url}})

— The {{event.name}} programme team`,
  },
  {
    key: "task.assigned",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["task.title", "task.due_at", "task.url", "task.instructions", "session.title"],
    description: "A new onboarding obligation landed on somebody.",
    subject: "{{task.title}} — for {{event.name}}",
    body_markdown: `Hi {{recipient.first_name}},

There is something we need from you for {{event.name}}: **{{task.title}}**, due
{{task.due_at}}.

{{task.instructions}}

[Open the task]({{task.url}})

— The {{event.name}} programme team`,
  },
  {
    key: "task.reminder",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["task.title", "task.due_at", "task.url", "days_remaining", "session.title"],
    description: "The chase. Escalates per the task's reminder rules.",
    subject: "Still needed: {{task.title}}",
    body_markdown: `Hi {{recipient.first_name}},

We still need **{{task.title}}** for {{event.name}}. It is due {{task.due_at}}.

[Open the task]({{task.url}})

If it is already done, ignore this — the reminder stops as soon as we have it.

— The {{event.name}} programme team`,
  },
  {
    key: "schedule.changed",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["session.title", "session.starts_at", "session.room", "change_summary", "schedule_url"],
    description: "Fires on publication, not on every drag in the planning UI.",
    subject: "Your {{event.name}} session has moved",
    body_markdown: `Hi {{recipient.first_name}},

The published schedule for {{event.name}} has changed and it affects
**{{session.title}}**.

{{change_summary}}

It is now {{session.starts_at}} in {{session.room}} ({{event.timezone}}).

[See the full schedule]({{schedule_url}})

— The {{event.name}} programme team`,
  },
  {
    key: "invitation.sent",
    channel: "email",
    audience: "organizers",
    transactional: true,
    variables: ["invitation.accept_url", "invitation.kind", "invited_by"],
    description: "Carries the accept_url. INV-01-15 also shows it on screen.",
    subject: "You have been invited to {{event.name}}",
    body_markdown: `Hi {{recipient.first_name}},

{{invited_by}} has invited you to {{event.name}}.

[Accept your invitation]({{invitation.accept_url}})

The link is single-use and expires.

— The {{event.name}} programme team`,
  },
  {
    key: "speaker.confirmation_request",
    channel: "email",
    audience: "speakers",
    transactional: true,
    variables: ["session.title", "confirmation_deadline", "confirm_url"],
    description: "Asks a credited speaker to confirm they are actually coming.",
    subject: "Please confirm your {{event.name}} session",
    body_markdown: `Hi {{recipient.first_name}},

You are credited on **{{session.title}}** at {{event.name}}. Please confirm you can present
it by **{{confirmation_deadline}}**.

[Confirm your session]({{confirm_url}})

— The {{event.name}} programme team`,
  },
  {
    key: "review.assignment",
    channel: "email",
    audience: "reviewers",
    transactional: true,
    variables: ["round.name", "assignment_count", "due_at", "review_url"],
    description: "Reviewer has proposals waiting.",
    subject: "{{assignment_count}} proposals to review for {{event.name}}",
    body_markdown: `Hi {{recipient.first_name}},

You have **{{assignment_count}}** proposals to review in {{round.name}}, due {{due_at}}.

[Open your review queue]({{review_url}})

— The {{event.name}} programme team`,
  },
  {
    key: "review.reminder",
    channel: "email",
    audience: "reviewers",
    transactional: true,
    variables: ["round.name", "outstanding_count", "due_at", "review_url"],
    description: "The reviewer chase.",
    subject: "{{outstanding_count}} reviews still open",
    body_markdown: `Hi {{recipient.first_name}},

{{outstanding_count}} of your reviews for {{round.name}} are still open, and the round closes
{{due_at}}.

[Open your review queue]({{review_url}})

— The {{event.name}} programme team`,
  },
  {
    key: "entitlement.expiring_soon",
    channel: "email",
    audience: "sponsors",
    transactional: true,
    variables: ["sponsor.name", "entitlement.type", "remaining", "expires_at", "days_remaining"],
    description: "Nudges a sponsor contact before a paid-for right lapses.",
    subject: "{{remaining}} unused {{entitlement.type}} for {{event.name}}",
    body_markdown: `Hi {{recipient.first_name}},

{{sponsor.name}} has **{{remaining}}** unused {{entitlement.type}} for {{event.name}}, and
they expire on {{expires_at}} — {{days_remaining}} days from now.

[Open the sponsor portal]({{portal_url}})

— The {{event.name}} programme team`,
  },
];

const BY_KEY = new Map(DEFAULT_TEMPLATES.map((t) => [t.key, t]));

export function templateSpec(key: string): TemplateSpec | null {
  return BY_KEY.get(key) ?? null;
}

export function isTransactionalTemplate(key: string): boolean {
  return BY_KEY.get(key)?.transactional ?? false;
}

/**
 * The audience a template key is for. Falls back to `speakers` for an
 * unrecognised or absent key — a one-off campaign (`template_key = null`) is
 * overwhelmingly a message to speakers (09, "Campaigns"), and a custom
 * template key an organizer invents is closer to that than to any of the
 * other three.
 */
export function templateAudience(key: string | null | undefined): TemplateAudience {
  if (!key) return "speakers";
  return BY_KEY.get(key)?.audience ?? "speakers";
}

/**
 * `invitation.sent` is the one key whose audience is not fixed: an
 * `Invitation.kind` (01) names who is being invited, and the email should
 * greet them as what they are being invited to be — 09, "Notifications".
 * Falls back to `organizers` (the "Program Team" label) when the kind is
 * absent, matching a staff invite.
 */
export function invitationAudience(kind: string | null | undefined): TemplateAudience {
  switch (kind) {
    case "reviewer":
      return "reviewers";
    case "sponsor_contact":
      return "sponsors";
    case "co_speaker":
    case "speaker_portal":
      return "speakers";
    case "staff":
    default:
      return "organizers";
  }
}

/**
 * A one-off campaign body has no `template_key`, so it validates against this
 * set: the common variables plus the ones an audience of speakers, sponsors or
 * task-holders can actually be resolved against.
 */
export const CAMPAIGN_VARIABLES = [
  ...COMMON_VARIABLES,
  "session.title",
  "session.starts_at",
  "session.room",
  "task.title",
  "task.due_at",
  "sponsor.name",
  "schedule_url",
] as const;

/** The full declared set for a key — common plus its own. */
export function declaredVariables(key: string | null): readonly string[] {
  if (!key) return CAMPAIGN_VARIABLES;
  const spec = BY_KEY.get(key);
  if (!spec) return CAMPAIGN_VARIABLES;
  return [...COMMON_VARIABLES, ...spec.variables];
}
