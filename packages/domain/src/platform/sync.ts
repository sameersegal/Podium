/**
 * Two-way sync rules — 09, "Two-way sync"; R31.
 *
 * Everything here is pure. The worker supplies rows and derived values; this
 * file decides what may be pushed, what may be accepted back, what an inbound
 * record means in Podium's own value space, and whether that inbound record is
 * merely this system hearing its own echo.
 *
 * Three rules live here because they cannot safely live anywhere else:
 *
 *   INV-09-17  a field map may only name declared fields, and may only mark
 *              `both` where the subject declares the field writable. Checked at
 *              save time, so a mapping pointed at a derived column fails while
 *              the organizer is looking at it rather than at 3am.
 *   INV-09-19  an inbound record hashing to the last push is an echo. This is
 *              the only thing stopping push and pull driving each other
 *              forever, so it is exact rather than heuristic.
 *   INV-09-23  `decision`, `entitlement` and `placement` are push-only whatever
 *              the field map says. `review` is not a subject at all.
 */

import { derivedFieldWrite, illegalTransition, invariantError } from "../shared/errors.js";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `SyncMapping.subject` — 09. `review` is deliberately absent: its visibility
 * differs per reader (INV-11-7, and reviewer identity under the round's
 * `anonymity`), and an external table has one visibility for everyone who can
 * open it.
 */
export const SYNC_SUBJECTS = [
  "proposal",
  "session",
  "person",
  "speaker_profile",
  "event_participant",
  "sponsor",
  "sponsorship",
  "entitlement",
  "placement",
  "decision",
  "prospect_card",
] as const;
export type SyncSubject = (typeof SYNC_SUBJECTS)[number];

/**
 * There is no `pull`. Podium is the system of record (R31), so every synced
 * field is pushed and some are *also* accepted back — a field the external tool
 * owned outright would be a field this model could not state the value of.
 */
export const SYNC_DIRECTIONS = ["push", "both"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_LINK_STATUSES = ["pending_push", "in_sync", "conflict", "error", "unlinked"] as const;
export type SyncLinkStatus = (typeof SYNC_LINK_STATUSES)[number];

/** Exactly the arrows drawn in the state diagram in 09. An undrawn transition does not exist. */
const LINK_TRANSITIONS: Record<SyncLinkStatus, readonly SyncLinkStatus[]> = {
  pending_push: ["in_sync", "error", "unlinked"],
  in_sync: ["pending_push", "conflict", "unlinked"],
  conflict: ["pending_push", "unlinked"],
  error: ["pending_push", "unlinked"],
  unlinked: [],
};

export function canTransitionSyncLink(from: SyncLinkStatus, to: SyncLinkStatus): boolean {
  return from === to || (LINK_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertSyncLinkTransition(from: SyncLinkStatus, to: SyncLinkStatus): void {
  if (!canTransitionSyncLink(from, to)) throw illegalTransition("ExternalRecordLink", from, to);
}

export const SYNC_RUN_DIRECTIONS = ["push", "pull"] as const;
export type SyncRunDirection = (typeof SYNC_RUN_DIRECTIONS)[number];

export const SYNC_RUN_TRIGGERS = ["event", "cron", "inbound", "manual"] as const;
export type SyncRunTrigger = (typeof SYNC_RUN_TRIGGERS)[number];

export const SYNC_RUN_STATUSES = ["running", "completed", "completed_with_errors", "failed"] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export interface SyncCounts {
  pushed: number;
  pulled: number;
  echoed: number;
  conflicted: number;
  skipped: number;
  failed: number;
}

export const EMPTY_COUNTS: SyncCounts = { pushed: 0, pulled: 0, echoed: 0, conflicted: 0, skipped: 0, failed: 0 };

/* -------------------------------------------------------------------------- */
/* Field and subject specifications                                            */
/* -------------------------------------------------------------------------- */

/**
 * Semantic field kinds, chosen so a spreadsheet tool can render each one as the
 * thing it actually is.
 *
 * The temptation is a lowest-common-denominator set — text, number, date — that
 * every provider satisfies. It is the wrong trade. A base whose Track column is
 * text cannot group by track; one whose Speakers column is a comma-joined string
 * cannot answer "what else is this person on"; one whose Headshot column is a
 * URL shows a URL instead of a face. Those three capabilities are most of why an
 * organizer chose Airtable over a spreadsheet, and a sync that flattens them
 * gives back the spreadsheet.
 *
 * The provider adapter maps these to its own types (`multipleSelects`,
 * `multipleRecordLinks`, `multipleAttachments`); the core never names one.
 */
export type SyncFieldKind =
  | "text"
  | "long_text"
  | "number"
  | "boolean"
  | "date"
  /** One value from a small closed set — a track, a status. Groupable, colourable. */
  | "select"
  /** Several values from an open set — keywords, tags. */
  | "multi_select"
  | "url"
  | "email"
  /** A relationship, carried as real links between two mirrored tables. */
  | "link"
  /** A file the provider fetches and stores its own copy of — a headshot, slides. */
  | "attachment";

/**
 * Kinds whose value is stable in Podium's own space, and therefore hashable.
 *
 * `link` and `attachment` are excluded on purpose. A link's value on the wire is
 * a set of *provider* record ids, and an attachment's is whatever the provider
 * made of a file it fetched — neither is something this system can reproduce, so
 * including them would make every record look changed on every pull and defeat
 * INV-09-19. Both are push-only, so nothing is lost: there is no inbound value
 * to compare.
 */
const HASHABLE_KINDS: readonly SyncFieldKind[] = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "select",
  "multi_select",
  "url",
  "email",
];

export function isHashable(kind: SyncFieldKind): boolean {
  return HASHABLE_KINDS.includes(kind);
}

export interface SyncFieldSpec {
  field: string;
  label: string;
  kind: SyncFieldKind;
  /** Accepted back from the external tool. Absent means push-only. */
  writable?: boolean;
  /** PII per 11. Pushed only where the mapping sets `include_pii`, never writable (INV-09-21). */
  pii?: boolean;
  /** Computed at projection time rather than read from a column — never writable (INV-11-6). */
  derived?: boolean;
  /**
   * For `kind: "link"` — the subject on the other end. The link is pushed only
   * when that subject also has an active mapping on the same integration
   * (INV-09-24), because a record id from one base means nothing in another.
   */
  linkTo?: SyncSubject;
  /**
   * The table's primary field. Airtable and its kin show this in every
   * linked-record chip and record card, so it has to be the human name of the
   * thing — a session's title, a person's name — and never an id or a status.
   * Exactly one per subject, and it must be a plain scalar: providers refuse a
   * link, an attachment or a select as the primary column.
   */
  primary?: boolean;
  /**
   * Accepting this back revokes the session's content approval and writes a
   * `SessionRevision`, in the same write (INV-06-12). True of every content
   * field on `session`. Surfaced where the field is chosen, because the first
   * time somebody fixes a typo in the spreadsheet is a bad time to find out.
   */
  revokesApproval?: boolean;
  /**
   * A `select` whose options are rows in Podium — a track, a session format.
   * Pushed and accepted back **by name**, because that is what an organizer sees
   * in the dropdown; the name is resolved to an id on the way in, and an
   * unrecognised one is a conflict rather than a silent null.
   */
  optionsFrom?: "track" | "session_format";
  /**
   * The column behind the field, where they differ. A `select` shows a name and
   * stores an id, so `track` reads and writes `track_id` — which is also why
   * these are `derived` (the name is a lookup) *and* `writable` (the id is a
   * real column somebody is choosing a value for).
   */
  column?: string;
  help?: string;
}

export function columnOf(spec: SyncFieldSpec): string {
  return spec.column ?? spec.field;
}

export interface SyncSubjectSpec {
  subject: SyncSubject;
  table: string;
  label: string;
  /** Org-scoped subjects have no `event_id`; event-scoped ones require one. */
  scope: "org" | "event";
  /** The column holding the owning event, where the table has one. */
  eventColumn?: string;
  /**
   * INV-09-23. No field is writable regardless of the field map, and the reason
   * is stated because "push-only" without one reads like an oversight.
   */
  pushOnly?: string;
  /** The `Person` this record is about, for erasure propagation (INV-09-22). */
  personColumn?: string;
  fields: SyncFieldSpec[];
}

const f = (field: string, label: string, kind: SyncFieldKind, extra: Partial<SyncFieldSpec> = {}): SyncFieldSpec => ({
  field,
  label,
  kind,
  ...extra,
});

/**
 * What each subject offers, in each direction.
 *
 * These are shaped as the tables an organizer actually builds, not as a
 * transcription of the schema. A conference base has a **Sessions** table whose
 * Speakers column links to a **Speakers** table, whose Track column is a
 * single-select you can group and colour by, and whose Headshot column shows a
 * face in gallery view. So that is what gets pushed — links, selects and
 * attachments — rather than three columns of ULIDs and a comma-joined string.
 *
 * Two rules run through all of it. **Sync what a human types, never what the
 * system computes or what fires**: every `derived` field is push-only by
 * construction, and so is every field whose write has a consequence a cell edit
 * cannot express. And **relationships are pushed from one side only**: providers
 * create the reverse link automatically, so defining both ends would have two
 * mappings fighting over one pair of columns.
 */
export const SUBJECT_SPECS: Record<SyncSubject, SyncSubjectSpec> = {
  proposal: {
    subject: "proposal",
    table: "proposal",
    label: "Proposals",
    scope: "event",
    eventColumn: "event_id",
    fields: [
      // The primary column. A proposal is referred to by its reference in every
      // room where proposals are discussed, so that is what belongs in the chip.
      f("reference", "Reference", "text", { primary: true }),
      f("title", "Title", "text"),
      f("abstract", "Abstract", "long_text"),
      f("description", "Description", "long_text"),
      f("status", "Status", "select"),
      f("origin", "Origin", "select"),
      f("is_late", "Late submission", "boolean"),
      f("submitted_at", "Submitted", "date"),
      f("confirmation_deadline", "Confirmation deadline", "date"),
      f("requested_duration_minutes", "Requested duration (min)", "number"),
      // The chair-side triage columns, and the reason a review committee opens a
      // grid at all: sort four hundred proposals, group by track, fix the ones
      // in the wrong place. Both are selects resolved by name, so the dropdown
      // reads "Platform Engineering" and not `trk_01J…`.
      f("assigned_track", "Assigned track", "select", { writable: true, derived: true, optionsFrom: "track", column: "assigned_track_id" }),
      f("track", "Requested track", "select", { derived: true, optionsFrom: "track", column: "track_id" }),
      f("format", "Format", "select", { derived: true, optionsFrom: "session_format", column: "session_format_id" }),
      f("audience_level", "Audience level", "select", { writable: true }),
      f("keywords", "Keywords", "multi_select", { writable: true }),
      f("language", "Language", "text", { writable: true }),
      f("speakers", "Speakers", "link", { derived: true, linkTo: "speaker_profile" }),
      f("submitter_name", "Submitter", "text", { derived: true }),
      f("submitter_email", "Submitter email", "email", { derived: true, pii: true }),
      f("decision_outcome", "Decision", "select", { derived: true }),
    ],
  },

  session: {
    subject: "session",
    table: "session",
    label: "Sessions",
    scope: "event",
    eventColumn: "event_id",
    fields: [
      f("title", "Title", "text", { primary: true, writable: true, revokesApproval: true }),
      f("reference", "Reference", "text"),
      f("subtitle", "Subtitle", "text", { writable: true, revokesApproval: true }),
      f("abstract", "Abstract", "long_text", { writable: true, revokesApproval: true }),
      f("description", "Description", "long_text", { writable: true, revokesApproval: true }),
      // The relationship, as a relationship. This is the column that answers
      // "what else is she on this year" and "who have we not heard back from",
      // and a comma-joined string answers neither.
      f("speakers", "Speakers", "link", { derived: true, linkTo: "speaker_profile" }),
      f("proposal", "Proposal", "link", { derived: true, linkTo: "proposal" }),
      f("track", "Track", "select", { writable: true, derived: true, optionsFrom: "track", column: "track_id" }),
      f("format", "Format", "select", { derived: true, optionsFrom: "session_format", column: "session_format_id" }),
      f("duration_minutes", "Duration (min)", "number"),
      f("audience_level", "Audience level", "select", { writable: true }),
      f("keywords", "Keywords", "multi_select", { writable: true }),
      f("language", "Language", "text", { writable: true }),
      f("recording_url", "Recording", "url", { writable: true }),
      f("registration_url", "Registration", "url", { writable: true }),
      f("capacity_override", "Capacity override", "number", { writable: true }),
      f("status", "Status", "select"),
      f("content_status", "Content status", "select"),
      f("visibility", "Visibility", "select"),
      f("recording_consent", "Recording consent", "select"),
      f("published_at", "Published", "date"),
      f("slides", "Slides", "attachment", { derived: true }),
      // Times live on `Placement` (08), not here. Pushed so the grid can be
      // sorted by slot; never accepted back, because placement serialises
      // through one writer per event.
      f("room_name", "Room", "text", { derived: true }),
      f("starts_at", "Starts", "date", { derived: true }),
      f("ends_at", "Ends", "date", { derived: true }),
    ],
  },

  speaker_profile: {
    subject: "speaker_profile",
    table: "speaker_profile",
    label: "Speakers",
    scope: "org",
    personColumn: "person_id",
    fields: [
      // `full_name` lives on `Person`, not on the profile — but the Speakers
      // table is where an organizer notices a misspelling, so it is writable
      // here and applied through the identity service.
      f("full_name", "Name", "text", { primary: true, writable: true, derived: true }),
      f("email", "Email", "email", { derived: true, pii: true }),
      f("headline", "Headline", "text", { writable: true }),
      f("job_title", "Job title", "text", { writable: true }),
      f("company", "Company", "text", { writable: true }),
      f("bio", "Bio", "long_text", { writable: true }),
      f("short_bio", "Short bio", "long_text", { writable: true }),
      f("location", "Location", "text", { writable: true }),
      // The column that makes a gallery view worth opening. Pushed as a file the
      // provider fetches and keeps its own copy of; never read back, because a
      // headshot arriving from outside would bypass the scan the asset pipeline
      // runs on every upload.
      f("headshot", "Headshot", "attachment", { derived: true }),
      // INV-01-13: only the profile's own person may change these two, so no
      // integration may. Pushed so the grid can show who is listed, never read.
      f("is_listed", "Listed publicly", "boolean"),
      f("phone", "Phone", "text", { pii: true }),
      f("dietary_notes", "Dietary notes", "long_text", { pii: true }),
      f("accessibility_notes", "Accessibility notes", "long_text", { pii: true }),
    ],
  },

  person: {
    subject: "person",
    table: "person",
    label: "People",
    scope: "org",
    personColumn: "id",
    fields: [
      f("full_name", "Name", "text", { primary: true, writable: true }),
      f("display_name", "Display name", "text", { writable: true }),
      f("pronouns", "Pronouns", "text", { writable: true }),
      f("timezone", "Timezone", "text", { writable: true }),
      f("locale", "Locale", "text", { writable: true }),
      f("tags", "Tags", "multi_select", { writable: true }),
      f("status", "Status", "select"),
      // Push-only on purpose. `Person.email` is unique per org (INV-01-1) and is
      // what authentication resolves against; a typo in a cell should not be
      // able to take somebody's login away.
      f("email", "Email", "email", { pii: true }),
    ],
  },

  event_participant: {
    subject: "event_participant",
    table: "event_participant",
    label: "Roster",
    scope: "event",
    eventColumn: "event_id",
    personColumn: "person_id",
    fields: [
      f("full_name", "Name", "text", { primary: true, derived: true }),
      f("person", "Person", "link", { derived: true, linkTo: "person" }),
      f("kind", "Kind", "select"),
      f("status", "Status", "select", { writable: true }),
      f("source", "Source", "select"),
      f("portal_access", "Portal access", "select"),
      f("email", "Email", "email", { derived: true, pii: true }),
    ],
  },

  sponsor: {
    subject: "sponsor",
    table: "sponsor",
    label: "Sponsors",
    scope: "org",
    fields: [
      f("name", "Name", "text", { primary: true, writable: true }),
      f("display_name", "Display name", "text", { writable: true }),
      f("website_url", "Website", "url", { writable: true }),
      f("description", "Description", "long_text", { writable: true }),
      f("industry_tags", "Industry", "multi_select", { writable: true }),
      f("internal_notes", "Internal notes", "long_text", { writable: true }),
      f("status", "Status", "select", { writable: true }),
      f("logo", "Logo", "attachment", { derived: true }),
      f("slug", "Slug", "text"),
    ],
  },

  sponsorship: {
    subject: "sponsorship",
    table: "sponsorship",
    label: "Sponsorships",
    scope: "event",
    eventColumn: "event_id",
    fields: [
      f("sponsor_name", "Sponsor", "text", { primary: true, derived: true }),
      f("sponsor", "Sponsor record", "link", { derived: true, linkTo: "sponsor" }),
      f("tier_name", "Tier", "select", { derived: true }),
      // The documented seam to whatever the sales side actually runs on (03).
      f("contract_reference", "Contract reference", "text", { writable: true }),
      f("internal_notes", "Internal notes", "long_text", { writable: true }),
      f("public_from", "Public from", "date", { writable: true }),
      f("sort_order_override", "Sort order", "number", { writable: true }),
      // Push-only: confirming and cancelling grant and revoke entitlements (03),
      // which is a transition, not a cell.
      f("status", "Status", "select"),
      f("confirmed_at", "Confirmed", "date"),
    ],
  },

  entitlement: {
    subject: "entitlement",
    table: "entitlement",
    label: "Entitlements",
    scope: "event",
    pushOnly:
      "consumed_count and remaining are derived from the proposals pointing at the entitlement (03). There is nothing to write.",
    fields: [
      f("sponsor_name", "Sponsor", "text", { primary: true, derived: true }),
      f("sponsorship", "Sponsorship", "link", { derived: true, linkTo: "sponsorship" }),
      f("entitlement_type", "Type", "select"),
      f("quantity", "Quantity", "number"),
      f("consumed_count", "Used", "number", { derived: true }),
      f("remaining", "Remaining", "number", { derived: true }),
      f("submission_deadline", "Submission deadline", "date"),
      f("expires_at", "Expires", "date"),
      f("notes", "Notes", "long_text"),
    ],
  },

  placement: {
    subject: "placement",
    table: "placement",
    label: "Schedule",
    scope: "event",
    eventColumn: "event_id",
    pushOnly:
      "Placement writes serialise through one writer per event (08) because concurrent edits produce conflicts no retry untangles. A spreadsheet row is the opposite of that discipline.",
    fields: [
      f("session_title", "Session", "text", { primary: true, derived: true }),
      f("session", "Session record", "link", { derived: true, linkTo: "session" }),
      f("room_name", "Room", "select", { derived: true }),
      f("day", "Day", "date", { derived: true }),
      f("starts_at", "Starts", "date"),
      f("ends_at", "Ends", "date"),
      f("status", "Status", "select"),
      f("is_public", "Public", "boolean"),
      f("notes", "Notes", "long_text"),
    ],
  },

  decision: {
    subject: "decision",
    table: "decision",
    label: "Decisions",
    scope: "event",
    pushOnly:
      "Publishing a decision emails every speaker (INV-05-10). A dropdown in a spreadsheet must not be able to send four hundred rejections at 2am.",
    fields: [
      // `feedback_for_speaker` and `rationale` are absent on purpose: one is a
      // letter to a person, the other is the committee's private reasoning.
      f("proposal_reference", "Proposal", "text", { primary: true, derived: true }),
      f("proposal", "Proposal record", "link", { derived: true, linkTo: "proposal" }),
      f("outcome", "Outcome", "select"),
      f("status", "Status", "select"),
      f("decided_at", "Decided", "date"),
      f("published_at", "Published", "date"),
      f("confirmation_deadline", "Confirmation deadline", "date"),
      f("assigned_duration_minutes", "Assigned duration (min)", "number"),
    ],
  },

  prospect_card: {
    subject: "prospect_card",
    table: "prospect_card",
    label: "Speaker pipeline",
    scope: "org",
    personColumn: "person_id",
    fields: [
      // `rationale` is absent: the card's private judgement about a person does
      // not leave the organization (INV-14-6), and a shared grid is leaving.
      f("full_name", "Name", "text", { primary: true, derived: true }),
      f("person", "Person", "link", { derived: true, linkTo: "person" }),
      f("stage_name", "Stage", "select", { derived: true }),
      f("pipeline_name", "Pipeline", "select", { derived: true }),
      f("topic", "Topic", "text", { writable: true }),
      f("score", "Score", "number", { writable: true }),
      f("next_action_at", "Next action", "date", { writable: true }),
    ],
  },
};

export function subjectSpec(subject: string): SyncSubjectSpec {
  const spec = SUBJECT_SPECS[subject as SyncSubject];
  if (!spec) {
    throw invariantError("INV-09-17", "unknown_sync_subject", `${subject} is not a syncable subject.`, { subject });
  }
  return spec;
}

export function fieldSpec(subject: string, field: string): SyncFieldSpec | null {
  return subjectSpec(subject).fields.find((f) => f.field === field) ?? null;
}

/** Every field the subject may push, minus PII where the mapping is not allowed it. */
export function pushableFields(subject: string, includePii = true): SyncFieldSpec[] {
  return subjectSpec(subject).fields.filter((f) => includePii || !f.pii);
}

/**
 * Every field the subject may accept back. Empty for a push-only subject
 * (INV-09-23), and never containing a derived or PII field.
 */
export function writableFields(subject: string): SyncFieldSpec[] {
  const spec = subjectSpec(subject);
  if (spec.pushOnly) return [];
  return spec.fields.filter((f) => isWritable(spec, f));
}

/**
 * One field being writable, with every reason it might not be, in one place.
 *
 * `speaker_profile.full_name` is the case that makes this worth a function
 * rather than a filter: it is derived (the value lives on `Person`) *and*
 * writable, because the Speakers table is exactly where somebody notices a
 * misspelling. Derived normally implies push-only; this is the one place the two
 * are decided separately, so the adapter has somewhere to apply it.
 */
function isWritable(spec: SyncSubjectSpec, f: SyncFieldSpec): boolean {
  if (spec.pushOnly) return false;
  if (!f.writable) return false;
  if (f.pii) return false;
  // A relationship or a file is never accepted back: adding a speaker to a
  // session has consequences a cell edit cannot express (an invitation, a
  // confirmation state, materialised tasks), and a file arriving from outside
  // would bypass the scan every upload goes through.
  if (f.kind === "link" || f.kind === "attachment") return false;
  return true;
}

/** The derived fields the worker must compute before a push can be projected. */
export function derivedFields(subject: string): string[] {
  return subjectSpec(subject).fields.filter((f) => f.derived).map((f) => f.field);
}

/** The column a provider shows in every linked-record chip and record card. */
export function primaryField(subject: string): SyncFieldSpec {
  const spec = subjectSpec(subject);
  const found = spec.fields.find((f) => f.primary);
  if (!found) throw invariantError("INV-09-17", "no_primary_field", `${subject} declares no primary field.`, { subject });
  return found;
}

/** Relationship fields, and the subject each points at (INV-09-24). */
export function linkFields(subject: string): SyncFieldSpec[] {
  return subjectSpec(subject).fields.filter((f) => f.kind === "link" && f.linkTo);
}

/** Select fields whose options are rows in Podium, resolved by name in both directions. */
export function optionFields(subject: string): SyncFieldSpec[] {
  return subjectSpec(subject).fields.filter((f) => f.optionsFrom);
}

/** Files the provider should fetch and keep its own copy of. */
export function attachmentFields(subject: string): SyncFieldSpec[] {
  return subjectSpec(subject).fields.filter((f) => f.kind === "attachment");
}

/**
 * The subjects that must already be mapped for this one's links to carry.
 *
 * A record id is meaningful only inside the base that minted it, so a Sessions
 * table whose Speakers column points at an unmapped subject has nothing to point
 * *to*. Rather than push a dangling value, the field is omitted and the mapping
 * screen says which table to add first (INV-09-24).
 */
export function requiredLinkTargets(subject: string): SyncSubject[] {
  return [...new Set(linkFields(subject).map((f) => f.linkTo!))];
}

/* -------------------------------------------------------------------------- */
/* Field maps                                                                  */
/* -------------------------------------------------------------------------- */

export interface SyncFieldMap {
  field: string;
  external_field: string;
  direction: SyncDirection;
}

/**
 * INV-09-17, and the place INV-11-6 finally gets teeth.
 *
 * Every other service builds its patch from a named field set, so a derived
 * column has never had a route that could write it — the rule held because
 * nothing asked. A field map is the first surface that accepts a field bag from
 * outside, so it is checked here, at save time, and a bad entry is refused
 * rather than dropped: silently ignoring a mapping an organizer configured is
 * how a column quietly stops syncing for a month.
 */
export function validateFieldMap(subject: string, fieldMap: SyncFieldMap[], includePii: boolean): void {
  const spec = subjectSpec(subject);
  const seenFields = new Set<string>();
  const seenExternal = new Set<string>();

  for (const entry of fieldMap) {
    const f = spec.fields.find((x) => x.field === entry.field);
    if (!f) {
      throw invariantError(
        "INV-09-17",
        "field_not_syncable",
        `${subject}.${entry.field} is not a field this subject can sync.`,
        { subject, field: entry.field, allowed: spec.fields.map((x) => x.field) },
      );
    }
    if (!SYNC_DIRECTIONS.includes(entry.direction)) {
      throw invariantError("INV-09-17", "bad_sync_direction", `${entry.direction} is not a sync direction.`, {
        field: entry.field,
        direction: entry.direction,
      });
    }
    if (!entry.external_field?.trim()) {
      throw invariantError("INV-09-17", "missing_external_field", `${entry.field} has no external column.`, {
        field: entry.field,
      });
    }
    if (seenFields.has(entry.field)) {
      throw invariantError("INV-09-17", "duplicate_field", `${entry.field} is mapped twice.`, { field: entry.field });
    }
    if (seenExternal.has(entry.external_field)) {
      // Two Podium fields into one column would make the inbound projection
      // ambiguous, and the hash unstable.
      throw invariantError("INV-09-17", "duplicate_external_field", `${entry.external_field} is mapped twice.`, {
        external_field: entry.external_field,
      });
    }
    seenFields.add(entry.field);
    seenExternal.add(entry.external_field);

    if (f.pii && !includePii) {
      throw invariantError(
        "INV-09-21",
        "pii_without_consent",
        `${subject}.${entry.field} is personal data; the mapping must set include_pii to carry it.`,
        { subject, field: entry.field },
      );
    }

    if (entry.direction !== "both") continue;

    if (f.kind === "link") {
      throw invariantError(
        "INV-09-24",
        "link_not_writable",
        `${f.label} is a relationship. Adding a speaker to a session creates an invitation, a confirmation state and a set of tasks — more than a cell edit can mean, so it is managed here and mirrored out.`,
        { subject, field: entry.field, links_to: f.linkTo },
      );
    }
    if (f.kind === "attachment") {
      throw invariantError(
        "INV-09-17",
        "attachment_not_writable",
        `${f.label} is a file. Files arrive through the upload pipeline so they are scanned and versioned; one appearing in a table cannot be.`,
        { subject, field: entry.field },
      );
    }
    // `derived` normally implies push-only, but a field may be computed here and
    // still writable where a service exists to apply it — `full_name` on the
    // Speakers table is read from `Person` and written back to it.
    if (f.derived && !isWritable(spec, f)) throw derivedFieldWrite(`${subject}.${entry.field}`);
    if (spec.pushOnly) {
      throw invariantError(
        "INV-09-23",
        "subject_is_push_only",
        `${spec.label} can be pushed but never written back. ${spec.pushOnly}`,
        { subject, field: entry.field },
      );
    }
    if (f.pii) {
      throw invariantError(
        "INV-09-21",
        "pii_not_writable",
        `${subject}.${entry.field} is personal data and is never accepted back from an external tool.`,
        { subject, field: entry.field },
      );
    }
    if (!isWritable(spec, f)) {
      throw invariantError(
        "INV-09-17",
        "field_not_writable",
        `${subject}.${entry.field} can be pushed but never written back.`,
        { subject, field: entry.field, writable: writableFields(subject).map((x) => x.field) },
      );
    }
  }
}

/** The entries that may be written back, after INV-09-17 has already passed. */
export function writableEntries(subject: string, fieldMap: SyncFieldMap[]): SyncFieldMap[] {
  const allowed = new Set(writableFields(subject).map((f) => f.field));
  return fieldMap.filter((e) => e.direction === "both" && allowed.has(e.field));
}

/** True where accepting this map back can revoke a session's content approval (INV-06-12). */
export function revokesApproval(subject: string, fieldMap: SyncFieldMap[]): boolean {
  return writableEntries(subject, fieldMap).some((e) => fieldSpec(subject, e.field)?.revokesApproval);
}

/* -------------------------------------------------------------------------- */
/* Value space                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Podium's value space, per field kind.
 *
 * The hash that suppresses echoes (INV-09-19) is computed over *these* values,
 * on both the push and the pull side, so that a provider trimming whitespace,
 * reordering a multi-select or rendering a date differently cannot make an
 * unchanged record look changed. Formatting differences belong to the provider;
 * this is the only place they are allowed to be resolved.
 */
export function canonical(kind: SyncFieldKind, raw: unknown): string | number | boolean | string[] | null {
  const multi = kind === "multi_select" || kind === "link" || kind === "attachment";
  if (raw === undefined || raw === null || raw === "") return multi ? [] : null;
  switch (kind) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      const s = String(raw).trim().toLowerCase();
      return ["1", "true", "yes", "y", "checked"].includes(s);
    }
    case "date": {
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case "multi_select":
    case "link":
    case "attachment": {
      const items = Array.isArray(raw)
        ? raw
        : typeof raw === "string" && raw.trim().startsWith("[")
          ? safeArray(raw)
          : String(raw).split(",");
      return items.map((x) => String(x).trim()).filter(Boolean);
    }
    case "email":
      return String(raw).trim().toLowerCase();
    default:
      return String(raw).trim();
  }
}

function safeArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * How a canonical value crosses to the provider.
 *
 * A `multi_select` goes as an array so the provider can render chips rather than
 * a sentence — with `typecast` on, an unknown option is created rather than
 * refused, which is what makes a new keyword just work. `link` and `attachment`
 * arrive here already resolved by the worker: a link as provider record ids, an
 * attachment as `{url}` objects the provider fetches for itself.
 */
export function toExternal(kind: SyncFieldKind, value: ReturnType<typeof canonical>): unknown {
  if (value === null) return null;
  if (kind === "attachment") return (value as string[]).map((url) => ({ url }));
  if (kind === "multi_select" || kind === "link") return value as string[];
  return value;
}

/** And how it comes back, so that `canonical(fromExternal(x)) === canonical(x)`. */
export function fromExternal(kind: SyncFieldKind, raw: unknown): ReturnType<typeof canonical> {
  if (kind === "attachment") {
    const items = Array.isArray(raw) ? raw : [];
    return items.map((a) => String((a as { url?: unknown })?.url ?? "")).filter(Boolean);
  }
  if (kind === "link") {
    const items = Array.isArray(raw) ? raw : [];
    // Providers return either bare record ids or `{id, name}` objects depending
    // on the endpoint; take whichever is there rather than guessing per call.
    return items.map((v) => String((v as { id?: unknown })?.id ?? v)).filter(Boolean);
  }
  return canonical(kind, raw);
}

/** The stored form, for the columns the writeback patches. Lists are JSON in TEXT. */
export function toStored(kind: SyncFieldKind, value: ReturnType<typeof canonical>): unknown {
  if (kind === "multi_select") return JSON.stringify(value ?? []);
  if (kind === "boolean") return value ? 1 : 0;
  return value;
}

/* -------------------------------------------------------------------------- */
/* Projection and hashing                                                      */
/* -------------------------------------------------------------------------- */

export interface ProjectOptions {
  includePii: boolean;
  /** Values the worker computed — every `derived` field the map names. */
  derived?: Record<string, unknown>;
  /**
   * Link targets already resolved to provider record ids, keyed by field.
   * A field absent here is a field whose target subject has no mapping on this
   * integration, and is omitted from the push rather than sent dangling
   * (INV-09-24).
   */
  links?: Record<string, string[]>;
  /** Signed, no-login URLs the provider can fetch, keyed by field. */
  attachments?: Record<string, string[]>;
}

/**
 * The canonical Podium-space values of the mapped fields that can be hashed.
 *
 * Deliberately not every mapped field: `link` and `attachment` carry provider
 * record ids and fetched file copies, neither of which this system can
 * reproduce, so hashing them would make every record look changed on every pull
 * and defeat INV-09-19. Both are push-only, so there is no inbound value to
 * compare and nothing is lost by leaving them out.
 */
export function projectCanonical(
  subject: string,
  row: Record<string, unknown>,
  fieldMap: SyncFieldMap[],
  opts: ProjectOptions,
): Record<string, ReturnType<typeof canonical>> {
  const out: Record<string, ReturnType<typeof canonical>> = {};
  for (const entry of fieldMap) {
    const spec = fieldSpec(subject, entry.field);
    if (!spec || !isHashable(spec.kind)) continue;
    if (spec.pii && !opts.includePii) continue;
    const raw = spec.derived ? opts.derived?.[entry.field] : row[entry.field];
    out[entry.field] = canonical(spec.kind, raw);
  }
  return out;
}

/** The record handed to the provider: external column names, provider-shaped values. */
export function projectForPush(
  subject: string,
  row: Record<string, unknown>,
  fieldMap: SyncFieldMap[],
  opts: ProjectOptions,
): Record<string, unknown> {
  const hashable = projectCanonical(subject, row, fieldMap, opts);
  const out: Record<string, unknown> = {};

  for (const entry of fieldMap) {
    const spec = fieldSpec(subject, entry.field);
    if (!spec) continue;
    if (spec.pii && !opts.includePii) continue;

    if (spec.kind === "link") {
      const resolved = opts.links?.[entry.field];
      // Omitted, not blanked: a mapping added later should fill the column in,
      // and writing `[]` first would clear links an organizer may have made by
      // hand in the meantime.
      if (!resolved) continue;
      out[entry.external_field] = toExternal("link", resolved);
      continue;
    }
    if (spec.kind === "attachment") {
      const urls = opts.attachments?.[entry.field];
      if (!urls) continue;
      out[entry.external_field] = toExternal("attachment", urls);
      continue;
    }
    if (!(entry.field in hashable)) continue;
    out[entry.external_field] = toExternal(spec.kind, hashable[entry.field]);
  }
  return out;
}

/**
 * The inbound half: an external record, in Podium's value space.
 *
 * Returns every hashable mapped field, not only the writable ones, because the
 * hash that detects an echo (INV-09-19) has to cover exactly what the push
 * hashed. `patch` is separately the subset that may actually be written.
 */
export interface InboundProjection {
  /** Canonical values for every hashable mapped field the record carried. */
  values: Record<string, ReturnType<typeof canonical>>;
  /** The writable subset, in stored form, ready for a service call. */
  patch: Record<string, unknown>;
  /** Mapped fields the record did not carry at all — absent, not blank. */
  absent: string[];
  /**
   * Writable `select` values that name a row here — a track, a format. Carried
   * separately because they are still names at this point: resolving one needs
   * the event's tracks, which is a query, and this file does not do queries.
   */
  options: Record<string, { optionsFrom: string; name: string | null }>;
}

export function projectInbound(
  subject: string,
  external: Record<string, unknown>,
  fieldMap: SyncFieldMap[],
  opts: ProjectOptions,
): InboundProjection {
  const values: Record<string, ReturnType<typeof canonical>> = {};
  const patch: Record<string, unknown> = {};
  const options: Record<string, { optionsFrom: string; name: string | null }> = {};
  const absent: string[] = [];
  const writable = new Set(writableEntries(subject, fieldMap).map((e) => e.field));

  for (const entry of fieldMap) {
    const spec = fieldSpec(subject, entry.field);
    if (!spec || !isHashable(spec.kind)) continue;
    if (spec.pii && !opts.includePii) continue;
    if (!(entry.external_field in external)) {
      absent.push(entry.field);
      continue;
    }
    const value = fromExternal(spec.kind, external[entry.external_field]);
    values[entry.field] = value;
    if (!writable.has(entry.field)) continue;
    if (spec.optionsFrom) {
      options[entry.field] = { optionsFrom: spec.optionsFrom, name: value === null ? null : String(value) };
      continue;
    }
    patch[entry.field] = toStored(spec.kind, value);
  }
  return { values, patch, absent, options };
}

/**
 * SHA-256 over the canonical values, with object keys sorted.
 *
 * `JSON.stringify` preserves insertion order, so two projections of the same
 * record could hash differently purely because the field map was reordered.
 * Sorting is what makes the comparison in INV-09-19 mean what it says.
 */
export async function syncHash(values: Record<string, unknown>): Promise<string> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key];
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * INV-09-19 — the mechanism the whole design rests on.
 *
 * A push changes the external record; the provider reports a change; the pull
 * writes it back; the write raises a domain event; the event schedules a push.
 * Every naive two-way sync contains that loop and no timer fixes it. An inbound
 * record matching either hash we already know about is this system hearing
 * itself, and is dropped without a write, an event, or a run counter.
 */
export function isEcho(hash: string, link: { last_pushed_hash?: unknown; last_pulled_hash?: unknown }): boolean {
  return hash === link.last_pushed_hash || hash === link.last_pulled_hash;
}

/* -------------------------------------------------------------------------- */
/* Event types that make a record dirty                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where the dirtied record's id comes from.
 *
 * `subject` — `DomainEvent.subject.id` is already the record.
 * `person`   — the event is about a person; find the row by its `personColumn`.
 *              `speaker_profile.updated` carries the *person* id, not the
 *              profile id, because the subject of that fact is the person (10,
 *              naming rule 3).
 * `data`     — the id is a field of the payload, which is how one fact dirties
 *              a different record than the one it is about.
 */
export type SyncDirtySource = { kind: "subject" } | { kind: "person" } | { kind: "data"; key: string };

export interface SyncDirtyRule {
  pattern: string;
  subject: SyncSubject;
  from: SyncDirtySource;
  /** Why this rule exists, where it is not the obvious one. */
  why?: string;
}

/**
 * The reaction map row in 10, as data.
 *
 * Wildcards rather than `*`: the dispatcher writes an `event_reaction_log` row
 * for every event a reaction *matches*, so a `*` subscription costs a D1 insert
 * per event forever — the same reason `platform.room_broadcast` lists its types.
 *
 * The non-obvious rows are the ones that dirty a record the event is not about.
 * A derived column is still a column somebody is looking at: if a speaker
 * changes their name and only the `person` table updates, the sessions grid
 * keeps showing the old one until something unrelated happens to touch it.
 */
export const SYNC_DIRTY_RULES: SyncDirtyRule[] = [
  { pattern: "proposal.*", subject: "proposal", from: { kind: "subject" } },
  { pattern: "session.*", subject: "session", from: { kind: "subject" } },
  { pattern: "session_speaker.*", subject: "session", from: { kind: "subject" }, why: "speaker_names is derived" },
  { pattern: "event_participant.*", subject: "event_participant", from: { kind: "subject" } },
  { pattern: "sponsor.*", subject: "sponsor", from: { kind: "subject" } },
  { pattern: "sponsorship.*", subject: "sponsorship", from: { kind: "subject" } },
  { pattern: "entitlement.*", subject: "entitlement", from: { kind: "subject" } },
  { pattern: "placement.*", subject: "placement", from: { kind: "subject" } },
  { pattern: "prospect.*", subject: "prospect_card", from: { kind: "subject" } },
  { pattern: "decision.*", subject: "decision", from: { kind: "subject" } },
  { pattern: "person.*", subject: "person", from: { kind: "subject" } },

  {
    pattern: "placement.*",
    subject: "session",
    from: { kind: "data", key: "session_id" },
    why: "the schedule columns on a session — room_name, starts_at, ends_at — live on Placement (08)",
  },
  {
    pattern: "decision.*",
    subject: "proposal",
    from: { kind: "data", key: "proposal_id" },
    why: "decision_outcome is derived onto the proposal row",
  },
  {
    pattern: "speaker_profile.*",
    subject: "speaker_profile",
    from: { kind: "person" },
    why: "the event carries the person id, not the profile id",
  },
  { pattern: "person.*", subject: "speaker_profile", from: { kind: "person" }, why: "full_name is derived" },
  { pattern: "person.*", subject: "event_participant", from: { kind: "person" }, why: "full_name and email are derived" },
  { pattern: "person.*", subject: "prospect_card", from: { kind: "person" }, why: "full_name is derived" },
];

/** Every event type pattern the sync reaction subscribes to, deduplicated. */
export const SYNC_DIRTY_EVENT_TYPES: string[] = [...new Set(SYNC_DIRTY_RULES.map((r) => r.pattern))];
