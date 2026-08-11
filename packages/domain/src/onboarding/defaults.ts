/**
 * "A realistic default set" — 07-onboarding.md.
 *
 * "Seed data should ship roughly this, because a blank onboarding config is
 * where organizers give up and reopen the spreadsheet."
 *
 * Data only: `createDefaultTaskDefinitions` in the onboarding service turns
 * these into `TaskDefinition` rows for an event. Two places deviate from the
 * literal table, both licensed by its "roughly", and both matching
 * `scripts/seed.mjs` so the shipped seed and this list cannot disagree:
 *
 *   * the rows the table types as `form` ship as `text_response` (or
 *     `file_upload` for the headshot), because `form` config is `{form_id}` and
 *     a default set has no `SubmissionForm` to point at;
 *   * `requires_review` is on for uploads, which is where an organizer actually
 *     wants a look before it goes on the website.
 */

import type { AppliesTo, AssigneeRule, DueRule, DueValue, RequirementType, TaskCategory, TaskSubjectType, TaskTrigger } from "./types.js";

export interface DefaultTaskDefinition {
  key: string;
  title: string;
  instructions?: string;
  category: TaskCategory;
  requirement_type: RequirementType;
  config: Record<string, unknown>;
  subject_type: TaskSubjectType;
  assignee_rule: AssigneeRule;
  applies_to?: AppliesTo;
  trigger: TaskTrigger;
  due_rule: DueRule;
  due_value: DueValue;
  is_blocking: boolean;
  is_required: boolean;
  requires_review: boolean;
  depends_on_task_keys?: string[];
  /** Offsets in days relative to `due_at`; positive = escalation after. */
  reminder_offsets: number[];
}

export const DEFAULT_TASK_DEFINITIONS: DefaultTaskDefinition[] = [
  {
    key: "speaker-agreement",
    title: "Sign the speaker agreement",
    instructions:
      "This is the standard agreement covering recording, code of conduct and travel reimbursement. It takes a minute.",
    category: "legal",
    requirement_type: "acknowledgement",
    config: { checkbox_label: "I agree to the speaker agreement", require_typed_name: true, document_version: "1" },
    subject_type: "session",
    assignee_rule: "each_speaker",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_assignment",
    due_value: { offset_days: 7 },
    is_blocking: true,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "code-of-conduct",
    title: "Accept the code of conduct",
    category: "legal",
    requirement_type: "acknowledgement",
    config: { checkbox_label: "I have read and accept the code of conduct", require_typed_name: false, document_version: "1" },
    subject_type: "session",
    assignee_rule: "each_speaker",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_assignment",
    due_value: { offset_days: 7 },
    is_blocking: true,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "profile-bio-headshot",
    title: "Complete your profile and headshot",
    instructions: "A square headshot, at least 800×800. This is what appears next to your talk on the website.",
    category: "profile",
    requirement_type: "file_upload",
    config: {
      accept: ["image/png", "image/jpeg"],
      max_files: 1,
      max_file_mb: 8,
      min_width: 800,
      min_height: 800,
      naming_hint: "firstname-lastname.jpg",
    },
    subject_type: "session",
    assignee_rule: "each_speaker",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -60 },
    is_blocking: true,
    is_required: true,
    requires_review: true,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "confirm-title-abstract",
    title: "Confirm your title and abstract",
    category: "content",
    requirement_type: "text_response",
    config: { prompt: "Paste the final title and abstract you want published.", min_length: 80, max_length: 2500 },
    subject_type: "session",
    assignee_rule: "primary_speaker_only",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -60 },
    is_blocking: true,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "recording-consent",
    title: "Confirm recording consent",
    category: "legal",
    requirement_type: "acknowledgement",
    config: { checkbox_label: "You may record my session and publish the recording", require_typed_name: false },
    subject_type: "session",
    assignee_rule: "each_speaker",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -45 },
    is_blocking: true,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "av-requirements",
    title: "Tell us your AV requirements",
    category: "technical",
    requirement_type: "text_response",
    config: { prompt: "Anything beyond a projector, a clicker and a microphone?", max_length: 500 },
    subject_type: "session",
    assignee_rule: "primary_speaker_only",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -30 },
    is_blocking: false,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "travel-details",
    title: "Send us your travel details",
    category: "travel",
    requirement_type: "text_response",
    config: { prompt: "Arrival and departure, and whether you need us to book anything.", max_length: 800 },
    subject_type: "session",
    assignee_rule: "each_speaker",
    applies_to: { attendance_modes: ["in_person"] },
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -45 },
    is_blocking: false,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "visa-letter-request",
    title: "Request a visa invitation letter",
    instructions: "Only if you need one. Tell us the name as it appears on your passport and the consulate you are applying at.",
    category: "travel",
    requirement_type: "text_response",
    config: {
      prompt: "Full name as printed in your passport, passport number, and which consulate you will apply at.",
      max_length: 800,
    },
    subject_type: "session",
    assignee_rule: "each_speaker",
    applies_to: { attendance_modes: ["in_person"] },
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -90 },
    is_blocking: false,
    is_required: false,
    requires_review: false,
    reminder_offsets: [-14, -3],
  },
  {
    key: "slides-upload",
    title: "Upload your final slides",
    instructions: "PDF please, 16:9. Re-uploading creates a new version — we keep the old ones.",
    category: "content",
    requirement_type: "file_upload",
    config: { accept: ["application/pdf"], max_files: 2, max_file_mb: 50, naming_hint: "session-title.pdf" },
    subject_type: "session",
    assignee_rule: "primary_speaker_only",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -7 },
    is_blocking: false,
    is_required: true,
    requires_review: true,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "tech-check",
    title: "Book your tech check",
    category: "technical",
    requirement_type: "scheduling",
    config: { booking_url: "", window_start: null, window_end: null },
    subject_type: "session",
    assignee_rule: "primary_speaker_only",
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -3 },
    is_blocking: false,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "nominate-speaker",
    title: "Name your speaker",
    instructions: "The contract is signed and the session exists; the one thing missing is a human.",
    category: "content",
    requirement_type: "speaker_nomination",
    config: { min_speakers: 1, max_speakers: 2 },
    subject_type: "sponsor",
    assignee_rule: "sponsor_speaker_wrangler",
    applies_to: { origins: ["sponsor"] },
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -60 },
    is_blocking: true,
    is_required: true,
    requires_review: false,
    reminder_offsets: [-14, -3, 3],
  },
  {
    key: "sponsor-logo",
    title: "Send us your logo",
    category: "marketing",
    requirement_type: "file_upload",
    config: { accept: ["image/svg+xml", "image/png"], max_files: 2, max_file_mb: 5 },
    subject_type: "sponsor",
    assignee_rule: "sponsor_primary_contact",
    applies_to: { origins: ["sponsor"] },
    trigger: "on_session_confirmed",
    due_rule: "relative_to_event_start",
    due_value: { offset_days: -60 },
    is_blocking: false,
    is_required: true,
    requires_review: true,
    reminder_offsets: [-14, -3, 3],
  },
];

export const DEFAULT_TASK_DEFINITION_KEYS = DEFAULT_TASK_DEFINITIONS.map((d) => d.key);
