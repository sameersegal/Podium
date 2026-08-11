/**
 * 07 — Onboarding. "A small, boring workflow engine with a deliberate
 * constraint: definitions are templates, instances are obligations, and the two
 * are versioned apart."
 *
 * Everything here is pure: the state machine, the due-date arithmetic, the
 * `applies_to` filter and the per-type completion conditions.
 */

import { illegalTransition, invariantError } from "../shared/errors.js";
import { addDays, type Instant } from "../shared/time.js";

export const TASK_CATEGORY = [
  "legal",
  "profile",
  "content",
  "logistics",
  "travel",
  "technical",
  "marketing",
  "other",
] as const;
export type TaskCategory = (typeof TASK_CATEGORY)[number];

export const REQUIREMENT_TYPE = [
  "acknowledgement",
  "form",
  "file_upload",
  "external_link",
  "external_action",
  "scheduling",
  "text_response",
  "speaker_nomination",
] as const;
export type RequirementType = (typeof REQUIREMENT_TYPE)[number];

export const TASK_SUBJECT_TYPE = ["session", "speaker", "sponsor"] as const;
export type TaskSubjectType = (typeof TASK_SUBJECT_TYPE)[number];

export const ASSIGNEE_RULE = [
  "each_speaker",
  "primary_speaker_only",
  "submitter",
  "sponsor_primary_contact",
  "sponsor_speaker_wrangler",
  "named_organizer",
  "named_people",
  "each_participant",
] as const;
export type AssigneeRule = (typeof ASSIGNEE_RULE)[number];

export const TASK_TRIGGER = [
  "on_session_created",
  "on_session_confirmed",
  "on_speaker_confirmed",
  "on_participant_added",
  "on_participant_confirmed",
  "on_task_completed",
  "manual",
] as const;
export type TaskTrigger = (typeof TASK_TRIGGER)[number];

export const DUE_RULE = [
  "fixed_date",
  "relative_to_event_start",
  "relative_to_session_start",
  "relative_to_assignment",
  "none",
] as const;
export type DueRule = (typeof DUE_RULE)[number];

export const DEFINITION_STATUS = ["draft", "active", "retired"] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUS)[number];

export const TASK_INSTANCE_STATUS = [
  "blocked",
  "not_started",
  "in_progress",
  "submitted",
  "changes_requested",
  "completed",
  "waived",
  "cancelled",
] as const;
export type TaskInstanceStatus = (typeof TASK_INSTANCE_STATUS)[number];

export const REVIEW_OUTCOME = ["pending", "approved", "changes_requested"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOME)[number];

export const REMINDER_CHANNEL = ["email", "webhook"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNEL)[number];

export const REMINDER_ESCALATE_TO = ["none", "primary_speaker", "sponsor_primary_contact", "organizer"] as const;
export type ReminderEscalateTo = (typeof REMINDER_ESCALATE_TO)[number];

export const REMINDER_TRIGGER = ["scheduled", "manual"] as const;
export type ReminderTrigger = (typeof REMINDER_TRIGGER)[number];

export const REMINDER_SUPPRESSED_REASON = [
  "already_complete",
  "quiet_hours",
  "digest_batched",
  "unsubscribed",
  "duplicate",
] as const;
export type ReminderSuppressedReason = (typeof REMINDER_SUPPRESSED_REASON)[number];

/* -------------------------------------------------------------------------- */
/* Instance state machine                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the arrows drawn in 07. Cancellation reaches every non-terminal state
 * (C7 in 13-open-questions.md): a task awaiting organizer review is still a
 * live obligation attached to a session that no longer exists.
 */
export const TASK_TRANSITIONS: Record<TaskInstanceStatus, TaskInstanceStatus[]> = {
  blocked: ["not_started", "cancelled"],
  not_started: ["in_progress", "completed", "waived", "cancelled"],
  in_progress: ["submitted", "completed", "waived", "cancelled"],
  submitted: ["completed", "changes_requested", "waived", "cancelled"],
  changes_requested: ["in_progress", "cancelled"],
  completed: ["in_progress"],
  waived: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: TaskInstanceStatus[] = ["completed", "waived", "cancelled"];

export function isTerminalTask(status: TaskInstanceStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** Non-terminal, per the diagram's `--> [*]` arrows. INV-07-8 acts on these. */
export function isNonTerminalTask(status: TaskInstanceStatus): boolean {
  return !isTerminalTask(status);
}

export function canTransitionTask(from: TaskInstanceStatus, to: TaskInstanceStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTaskTransition(from: TaskInstanceStatus, to: TaskInstanceStatus): void {
  if (from === to) return;
  if (!canTransitionTask(from, to)) throw illegalTransition("Task", from, to);
}

/**
 * INV-07-3 — `is_overdue` is computed by comparing `due_at` to now at read
 * time, and is never persisted as a status. Overdue-as-a-state means a nightly
 * job, and a nightly job means somebody's dashboard disagrees with somebody
 * else's email.
 */
export function isOverdue(task: { due_at?: string | null; status: TaskInstanceStatus }, now: Instant): boolean {
  if (!task.due_at) return false;
  if (isTerminalTask(task.status)) return false;
  return task.due_at < now;
}

export function daysOverdue(dueAt: string, now: Instant): number {
  return Math.max(0, Math.floor((new Date(now).getTime() - new Date(dueAt).getTime()) / 86_400_000));
}

/**
 * INV-07-4 — a task with unmet `depends_on_task_keys` is `blocked` and cannot
 * be started.
 */
export function assertStartable(status: TaskInstanceStatus): void {
  if (status === "blocked") {
    throw invariantError("INV-07-4", "task_blocked", "This task is waiting on an earlier one to be completed.");
  }
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

export interface DependencyNode {
  key: string;
  depends_on_task_keys?: string[] | null;
}

/**
 * INV-07-4 — dependency graphs must be acyclic, validated when the definition
 * is activated. Returns the cycle it found, or null.
 */
export function findDependencyCycle(nodes: DependencyNode[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const n of nodes) edges.set(n.key, n.depends_on_task_keys ?? []);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    const s = state.get(key) ?? 0;
    if (s === 1) return [...stack.slice(stack.indexOf(key)), key];
    if (s === 2) return null;
    state.set(key, 1);
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      if (!edges.has(next)) continue; // an unknown key is a validation error elsewhere, not a cycle
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };

  for (const n of nodes) {
    const cycle = visit(n.key);
    if (cycle) return cycle;
  }
  return null;
}

export function assertAcyclic(nodes: DependencyNode[]): void {
  const cycle = findDependencyCycle(nodes);
  if (cycle) {
    throw invariantError(
      "INV-07-4",
      "dependency_cycle",
      `These tasks depend on each other in a loop: ${cycle.join(" → ")}.`,
      { cycle },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* applies_to                                                                  */
/* -------------------------------------------------------------------------- */

export interface AppliesTo {
  origins?: string[];
  format_ids?: string[];
  track_ids?: string[];
  attendance_modes?: string[];
  speaker_roles?: string[];
}

export interface AppliesContext {
  origin?: string | null;
  format_id?: string | null;
  track_id?: string | null;
  attendance_mode?: string | null;
  speaker_role?: string | null;
}

/**
 * Materialisation step 1 — does `applies_to` match this session (origin,
 * format, track) and this speaker (role, attendance mode)? An empty filter
 * matches everything.
 */
export function appliesTo(filter: AppliesTo | null | undefined, ctx: AppliesContext): boolean {
  if (!filter) return true;
  const check = (allowed: string[] | undefined, actual: string | null | undefined): boolean => {
    if (!allowed || allowed.length === 0) return true;
    if (actual === null || actual === undefined || actual === "") return false;
    return allowed.includes(actual);
  };
  return (
    check(filter.origins, ctx.origin) &&
    check(filter.format_ids, ctx.format_id) &&
    check(filter.track_ids, ctx.track_id) &&
    check(filter.attendance_modes, ctx.attendance_mode) &&
    check(filter.speaker_roles, ctx.speaker_role)
  );
}

/* -------------------------------------------------------------------------- */
/* due_at                                                                      */
/* -------------------------------------------------------------------------- */

export interface DueValue {
  date?: string;
  offset_days?: number;
  at_time?: string;
}

export interface DueContext {
  /** `Event.starts_on` as an instant at the event's local start of business. */
  event_start?: Instant | null;
  /** The session's placement start, when it has one. */
  session_start?: Instant | null;
  /** When the instance is being materialised. */
  assigned_at: Instant;
}

/**
 * Materialisation step 4 — resolve `due_at` from `due_rule`. Negative offsets
 * are "before"; deadlines are instants, never dates (11, "Time").
 */
export function resolveDueAt(rule: DueRule, value: DueValue | null | undefined, ctx: DueContext): Instant | null {
  const v = value ?? {};
  switch (rule) {
    case "none":
      return null;
    case "fixed_date":
      return v.date ? atTime(v.date, v.at_time) : null;
    case "relative_to_event_start":
      return ctx.event_start ? addDays(ctx.event_start, v.offset_days ?? 0) : null;
    case "relative_to_session_start":
      return ctx.session_start ? addDays(ctx.session_start, v.offset_days ?? 0) : null;
    case "relative_to_assignment":
      return addDays(ctx.assigned_at, v.offset_days ?? 0);
    default:
      return null;
  }
}

function atTime(date: string, time?: string): Instant {
  const iso = date.includes("T") ? date : `${date}T${time ?? "17:00"}:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date(`${date}T17:00:00.000Z`).toISOString() : parsed.toISOString();
}

/* -------------------------------------------------------------------------- */
/* Completion conditions                                                       */
/* -------------------------------------------------------------------------- */

export interface AcknowledgementRecord {
  accepted: boolean;
  typed_name?: string | null;
  document_version?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  accepted_at?: string | null;
}

export interface CompletionInput {
  requirement_type: RequirementType;
  config: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** `{scan_status, width, height}` for each asset referenced by the submission. */
  assets?: { id: string; scan_status: string; width?: number | null; height?: number | null }[];
}

export interface CompletionResult {
  satisfied: boolean;
  /** The invariant a failure enforces, when there is one. */
  invariant?: string;
  message?: string;
}

/**
 * "Completed when" from the `config` table in 07. A submission that does not
 * satisfy its own type never reaches `completed` or `submitted`.
 */
export function checkCompletion(input: CompletionInput): CompletionResult {
  const { config, payload } = input;
  switch (input.requirement_type) {
    case "acknowledgement": {
      const rec = payload as unknown as AcknowledgementRecord;
      if (!rec.accepted) return fail("You need to tick the box to accept.");
      if (config.require_typed_name && !String(rec.typed_name ?? "").trim()) {
        return fail("Type your full name to sign this.");
      }
      return ok();
    }
    case "form": {
      const answers = (payload.answers ?? {}) as Record<string, unknown>;
      const required = (config.required_field_keys ?? []) as string[];
      const missing = required.filter((k) => isEmpty(answers[k]));
      if (missing.length > 0) return fail(`Still to answer: ${missing.join(", ")}.`);
      if (required.length === 0 && Object.keys(answers).length === 0) return fail("Fill the form in before submitting.");
      return ok();
    }
    case "file_upload": {
      const assets = input.assets ?? [];
      if (assets.length === 0) return fail("Upload at least one file.");
      const maxFiles = Number(config.max_files ?? 0);
      if (maxFiles > 0 && assets.length > maxFiles) return fail(`At most ${maxFiles} file(s), please.`);
      // INV-07-9: every asset must be scanned clean before the task completes.
      const unclean = assets.filter((a) => a.scan_status !== "clean");
      if (unclean.length > 0) {
        return {
          satisfied: false,
          invariant: "INV-07-9",
          message:
            unclean.every((a) => a.scan_status === "pending")
              ? "Your file is still being scanned. This completes on its own once the scan passes."
              : "A file failed its virus scan. Upload a replacement.",
        };
      }
      const minW = Number(config.min_width ?? 0);
      const minH = Number(config.min_height ?? 0);
      if (minW > 0 || minH > 0) {
        const tooSmall = assets.filter((a) => (a.width ?? 0) < minW || (a.height ?? 0) < minH);
        if (tooSmall.length > 0) return fail(`Images must be at least ${minW}×${minH} pixels.`);
      }
      return ok();
    }
    case "external_link":
      return payload.confirmed ? ok() : fail("Confirm you have done this.");
    case "external_action":
      // Completed by the integration reporting through `auto_complete_on_event`.
      return payload.confirmed || payload.completed_by_event ? ok() : fail("Waiting for the integration to report this.");
    case "scheduling":
      return payload.booked || payload.slot_at ? ok() : fail("Book a slot, then confirm here.");
    case "text_response": {
      const text = String(payload.text ?? "").trim();
      const min = Number(config.min_length ?? 0);
      const max = Number(config.max_length ?? 0);
      if (text.length === 0) return fail("Write your answer before submitting.");
      if (min > 0 && text.length < min) return fail(`At least ${min} characters, please (you have ${text.length}).`);
      if (max > 0 && text.length > max) return fail(`At most ${max} characters, please (you have ${text.length}).`);
      return ok();
    }
    case "speaker_nomination": {
      const nominees = (payload.nominees ?? []) as { full_name?: string; email?: string }[];
      const named = nominees.filter((n) => String(n.full_name ?? "").trim() && String(n.email ?? "").includes("@"));
      const min = Number(config.min_speakers ?? 1);
      const max = Number(config.max_speakers ?? 0);
      if (named.length < min) return fail(`Name at least ${min} speaker${min === 1 ? "" : "s"}, with a name and email each.`);
      if (max > 0 && named.length > max) return fail(`At most ${max} speaker${max === 1 ? "" : "s"}.`);
      return ok();
    }
    default:
      return ok();
  }
}

function ok(): CompletionResult {
  return { satisfied: true };
}

function fail(message: string): CompletionResult {
  return { satisfied: false, message };
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProgressInput {
  status: TaskInstanceStatus;
  is_blocking: boolean;
  is_required: boolean;
}

/**
 * `Session.onboarding_progress` (0–100) — derived, computed at read time
 * (INV-11-6). Cancelled instances are not obligations and do not count.
 *
 * **`waived` is not `completed`**: a waived task closes out of the denominator
 * of "still to do" but is reported separately by `completionStats`.
 */
export function onboardingProgress(tasks: ProgressInput[]): number {
  const live = tasks.filter((t) => t.status !== "cancelled");
  if (live.length === 0) return 100;
  const closed = live.filter((t) => t.status === "completed" || t.status === "waived");
  return Math.round((closed.length / live.length) * 100);
}

/** `Session.blocking_tasks_outstanding` — derived (INV-06-5). */
export function blockingTasksOutstanding(tasks: ProgressInput[]): number {
  return tasks.filter((t) => t.is_blocking && isNonTerminalTask(t.status)).length;
}

export interface CompletionStats {
  total: number;
  completed: number;
  waived: number;
  outstanding: number;
  cancelled: number;
  percent: number;
}

/** Completion metrics report `completed` and `waived` separately, always. */
export function completionStats(tasks: ProgressInput[]): CompletionStats {
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const live = tasks.filter((t) => t.status !== "cancelled");
  const completed = live.filter((t) => t.status === "completed").length;
  const waived = live.filter((t) => t.status === "waived").length;
  return {
    total: live.length,
    completed,
    waived,
    outstanding: live.length - completed - waived,
    cancelled,
    percent: onboardingProgress(tasks),
  };
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

export type TaskVisibility = "none" | "status_only" | "full";

export interface TaskVisibilityInput {
  assignee_person_id: string;
  session_id?: string | null;
  sponsor_id?: string | null;
}

export interface TaskViewer {
  person_id: string | null;
  is_event_staff: boolean;
  /** Sessions the viewer is a live `SessionSpeaker` on. */
  session_ids: string[];
  /** Sponsors the viewer is an active `SponsorContact` for. */
  sponsor_ids: string[];
  /** People the viewer nominated, via a `speaker_nomination` task they own. */
  nominated_person_ids?: string[];
}

/**
 * INV-07-10 — a task instance is only visible to its assignee, that session's
 * speakers (title and status only, not payload), and event staff. Sponsor
 * contacts see their sponsor's tasks and their nominated speakers' task
 * *status*, never payloads.
 */
export function taskVisibility(task: TaskVisibilityInput, viewer: TaskViewer): TaskVisibility {
  if (viewer.is_event_staff) return "full";
  if (!viewer.person_id) return "none";
  if (task.assignee_person_id === viewer.person_id) return "full";
  if (task.sponsor_id && viewer.sponsor_ids.includes(task.sponsor_id)) return "full";
  if ((viewer.nominated_person_ids ?? []).includes(task.assignee_person_id)) return "status_only";
  if (task.session_id && viewer.session_ids.includes(task.session_id)) return "status_only";
  return "none";
}

/**
 * INV-07-5 — only the assignee, or an organizer acting explicitly on their
 * behalf, may complete a task; `completed_by_person_id` always records who
 * actually did it.
 */
export function assertMayComplete(assigneePersonId: string, actorPersonId: string | null, actorIsStaff: boolean): void {
  if (actorPersonId && actorPersonId === assigneePersonId) return;
  if (actorIsStaff) return;
  throw invariantError("INV-07-5", "not_the_assignee", "Only the person this task is assigned to can complete it.");
}

/** INV-07-6 — `requires_review` tasks reach `completed` only via approval. */
export function nextStatusOnSubmit(requiresReview: boolean): TaskInstanceStatus {
  return requiresReview ? "submitted" : "completed";
}

/** INV-07-7 — waiving requires a reason and is always attributed. */
export function assertWaiverReason(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (!r) {
    throw invariantError("INV-07-7", "waiver_reason_required", "A waiver has to say why. It is a decision, not a delete.");
  }
  return r;
}

/**
 * INV-07-13 — reminders are never sent for terminal task instances, and a
 * manual nudge is subject to the same suppression rules as a scheduled one.
 */
export function reminderSuppression(input: {
  status: TaskInstanceStatus;
  last_reminded_at?: string | null;
  now: Instant;
  already_sent_today: boolean;
  unsubscribed?: boolean;
  min_hours_between?: number;
}): ReminderSuppressedReason | null {
  if (isTerminalTask(input.status)) return "already_complete";
  if (input.unsubscribed) return "unsubscribed";
  if (input.already_sent_today) return "digest_batched";
  const minHours = input.min_hours_between ?? 20;
  if (input.last_reminded_at) {
    const hours = (new Date(input.now).getTime() - new Date(input.last_reminded_at).getTime()) / 3_600_000;
    if (hours < minHours) return "duplicate";
  }
  return null;
}

/**
 * PII — 11 classifies "any `TaskSubmission.payload` for a definition in
 * category `travel` or `legal`" as personal data, along with the acknowledgement
 * record's ip and user agent.
 */
export function submissionPayloadIsPii(category: string): boolean {
  return category === "travel" || category === "legal";
}
