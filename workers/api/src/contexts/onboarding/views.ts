/**
 * Onboarding — read models (07-onboarding.md, "Read models").
 *
 * Nothing here writes. `SpeakerChecklist` is the portal's core screen,
 * `OrganizerOnboardingBoard` the "who is holding us up" screen, and
 * `TaskCompletionStats` the per-definition rollup.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  completionStats,
  isOverdue,
  onboardingProgress,
  submissionPayloadIsPii,
  taskVisibility,
  type CompletionStats,
  type TaskInstanceStatus,
  type TaskViewer,
  type TaskVisibility,
} from "@podiumstack/domain/onboarding/types.js";
import { REDACTED } from "@podiumstack/domain/shared/pii.js";
import type { Instant } from "@podiumstack/domain/shared/time.js";
import { personDisplayName } from "../identity/service.js";

/* -------------------------------------------------------------------------- */
/* JSON shapes                                                                 */
/* -------------------------------------------------------------------------- */

export function definitionJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    key: str(row.key),
    title: str(row.title),
    instructions: strOrNull(row.instructions),
    category: str(row.category),
    requirement_type: str(row.requirement_type),
    config: parseJson(row.config, {}),
    subject_type: str(row.subject_type),
    assignee_rule: str(row.assignee_rule),
    assignee_person_id: strOrNull(row.assignee_person_id),
    assignee_person_ids: parseJson<string[]>(row.assignee_person_ids, []),
    applies_to: parseJson(row.applies_to, {}),
    trigger: str(row.trigger),
    trigger_task_key: strOrNull(row.trigger_task_key),
    due_rule: str(row.due_rule),
    due_value: parseJson(row.due_value, {}),
    is_blocking: bool(row.is_blocking),
    is_required: bool(row.is_required),
    requires_review: bool(row.requires_review),
    auto_complete_on_event: strOrNull(row.auto_complete_on_event),
    depends_on_task_keys: parseJson<string[]>(row.depends_on_task_keys, []),
    sort_order: num(row.sort_order),
    status: str(row.status),
    version: num(row.version, 1),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    row_version: num(row.row_version, 1),
  };
}

/** `visibility` is INV-07-10's answer for this reader; `status_only` drops the payload-carrying fields. */
export function instanceJson(row: Row, opts: { visibility: TaskVisibility; now: Instant }): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: str(row.id),
    event_id: str(row.event_id),
    definition_id: str(row.definition_id),
    definition_key: str(row.definition_key),
    title: str(row.title),
    requirement_type: str(row.requirement_type),
    subject_type: str(row.subject_type),
    subject_id: str(row.subject_id),
    session_id: strOrNull(row.session_id),
    sponsor_id: strOrNull(row.sponsor_id),
    status: str(row.status),
    is_blocking: bool(row.is_blocking),
    is_required: bool(row.is_required),
    requires_review: bool(row.requires_review),
    due_at: strOrNull(row.due_at),
    // INV-07-3: derived at read time, never stored.
    is_overdue: isOverdue({ due_at: strOrNull(row.due_at), status: str(row.status) as TaskInstanceStatus }, opts.now),
  };
  if (opts.visibility !== "full") return base; // INV-07-10: title and status only
  return {
    ...base,
    assignee_person_id: str(row.assignee_person_id),
    instructions: strOrNull(row.instructions),
    config: parseJson(row.config, {}),
    started_at: strOrNull(row.started_at),
    submitted_at: strOrNull(row.submitted_at),
    completed_at: strOrNull(row.completed_at),
    completed_by_person_id: strOrNull(row.completed_by_person_id),
    waived_by_person_id: strOrNull(row.waived_by_person_id),
    waiver_reason: strOrNull(row.waiver_reason),
    reviewed_by_person_id: strOrNull(row.reviewed_by_person_id),
    review_note: strOrNull(row.review_note),
    reminder_count: num(row.reminder_count),
    last_reminded_at: strOrNull(row.last_reminded_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

/**
 * `TaskSubmission.payload` is PII only "when the definition's category is
 * travel or legal" (07, TaskSubmission; 11-cross-cutting.md's PII table).
 */
export function submissionJson(row: Row, category: string, includePii: boolean): Record<string, unknown> {
  const redact = submissionPayloadIsPii(category) && !includePii;
  return {
    id: str(row.id),
    task_instance_id: str(row.task_instance_id),
    version: num(row.version),
    payload: redact ? REDACTED : parseJson(row.payload, {}),
    asset_ids: parseJson<string[]>(row.asset_ids, []),
    submitted_by_person_id: str(row.submitted_by_person_id),
    submitted_at: str(row.submitted_at),
    review_outcome: strOrNull(row.review_outcome),
    reviewed_by_person_id: strOrNull(row.reviewed_by_person_id),
    reviewed_at: strOrNull(row.reviewed_at),
    review_note: strOrNull(row.review_note),
  };
}

/* -------------------------------------------------------------------------- */
/* Visibility (INV-07-10)                                                     */
/* -------------------------------------------------------------------------- */

export async function nominatedPersonIds(app: AppContext, viewerPersonId: string): Promise<string[]> {
  const rows = await app.db.raw<Row>(
    `SELECT ts.payload FROM task_submission ts JOIN task_instance ti ON ti.id = ts.task_instance_id
      WHERE ts.submitted_by_person_id = ? AND ti.requirement_type = 'speaker_nomination'`,
    [viewerPersonId],
  );
  const emails = new Set<string>();
  for (const r of rows) {
    const payload = parseJson<Record<string, unknown>>(r.payload, {});
    const nominees = (payload.nominees ?? []) as { email?: string }[];
    for (const n of nominees) if (n.email) emails.add(String(n.email).toLowerCase());
  }
  if (emails.size === 0) return [];
  const list = [...emails];
  const rows2 = await app.db.raw<Row>(
    `SELECT id FROM person WHERE lower(email) IN (${list.map(() => "?").join(",")})`,
    [...list],
  );
  return rows2.map((p) => str(p.id));
}

export function visibilityOf(row: Row, viewer: TaskViewer): TaskVisibility {
  return taskVisibility({ assignee_person_id: str(row.assignee_person_id), session_id: strOrNull(row.session_id), sponsor_id: strOrNull(row.sponsor_id) }, viewer);
}

/* -------------------------------------------------------------------------- */
/* SpeakerChecklist — the portal's core screen                                */
/* -------------------------------------------------------------------------- */

export interface ChecklistItem {
  instance: Row;
  session_title: string | null;
  is_overdue: boolean;
  next_action: string;
}

function nextActionLabel(status: TaskInstanceStatus): string {
  switch (status) {
    case "blocked":
      return "Waiting on an earlier task";
    case "not_started":
      return "Start";
    case "in_progress":
      return "Finish and submit";
    case "submitted":
      return "Awaiting review";
    case "changes_requested":
      return "Revise and resubmit";
    case "completed":
      return "Done";
    case "waived":
      return "Waived";
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

/** Per person: the ordered task list with status, due date and a single next action. */
export async function speakerChecklist(app: AppContext, personId: string): Promise<ChecklistItem[]> {
  const rows = await app.db.select<Row>("task_instance", { assignee_person_id: personId });
  const live = rows.filter((r) => str(r.status) !== "cancelled");
  const sessionIds = [...new Set(live.map((r) => strOrNull(r.session_id)).filter((v): v is string => !!v))];
  const sessions = sessionIds.length ? await app.db.select<Row>("session", { id: sessionIds }, { includeDeleted: true }) : [];
  const sessionById = new Map(sessions.map((s) => [str(s.id), s]));
  const now = app.now();
  const items = live.map((r) => ({
    instance: r,
    session_title: r.session_id ? str(sessionById.get(str(r.session_id))?.title ?? "") || null : null,
    is_overdue: isOverdue({ due_at: strOrNull(r.due_at), status: str(r.status) as TaskInstanceStatus }, now),
    next_action: nextActionLabel(str(r.status) as TaskInstanceStatus),
  }));
  return items.sort((a, b) => {
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
    const ad = str(a.instance.due_at, "9999");
    const bd = str(b.instance.due_at, "9999");
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/* OrganizerOnboardingBoard — the "who is holding us up" screen               */
/* -------------------------------------------------------------------------- */

export interface BoardFilters {
  track_id?: string | null;
  format_id?: string | null;
  sponsor_id?: string | null;
  definition_id?: string | null;
  assignee_person_id?: string | null;
  status?: string | null;
  overdue?: boolean;
}

export interface BoardRow {
  instance: Row;
  session_title: string | null;
  session_track_id: string | null;
  session_format_id: string | null;
  sponsor_name: string | null;
  assignee_name: string;
  is_overdue: boolean;
}

/**
 * The matrix flattened to one directly-actionable row per obligation —
 * `(session or sponsor) x task definition x assignee`, which is exactly what
 * a checkbox and "Remind selected" needs to operate on.
 */
export async function organizerBoard(app: AppContext, eventId: string, filters: BoardFilters = {}): Promise<BoardRow[]> {
  const rows = await app.db.select<Row>("task_instance", { event_id: eventId }, { orderBy: "due_at" });
  const sessionIds = [...new Set(rows.map((r) => strOrNull(r.session_id)).filter((v): v is string => !!v))];
  const personIds = [...new Set(rows.map((r) => str(r.assignee_person_id)))];
  const sponsorIds = [...new Set(rows.map((r) => strOrNull(r.sponsor_id)).filter((v): v is string => !!v))];

  const [sessions, people, sponsors] = await Promise.all([
    sessionIds.length ? app.db.select<Row>("session", { id: sessionIds }, { includeDeleted: true }) : Promise.resolve([]),
    personIds.length ? app.db.select<Row>("person", { id: personIds }, { includeDeleted: true }) : Promise.resolve([]),
    sponsorIds.length ? app.db.select<Row>("sponsor", { id: sponsorIds }, { includeDeleted: true }) : Promise.resolve([]),
  ]);
  const sessionById = new Map(sessions.map((s) => [str(s.id), s]));
  const personById = new Map(people.map((p) => [str(p.id), p]));
  const sponsorById = new Map(sponsors.map((s) => [str(s.id), s]));

  const now = app.now();
  let out: BoardRow[] = rows.map((r) => {
    const session = r.session_id ? (sessionById.get(str(r.session_id)) ?? null) : null;
    const person = personById.get(str(r.assignee_person_id));
    return {
      instance: r,
      session_title: session ? str(session.title) : null,
      session_track_id: session ? strOrNull(session.track_id) : null,
      session_format_id: session ? strOrNull(session.session_format_id) : null,
      sponsor_name: r.sponsor_id ? (sponsorById.get(str(r.sponsor_id))?.name ? str(sponsorById.get(str(r.sponsor_id))?.name) : null) : null,
      assignee_name: person ? personDisplayName(person) : "—",
      is_overdue: isOverdue({ due_at: strOrNull(r.due_at), status: str(r.status) as TaskInstanceStatus }, now),
    };
  });

  if (filters.track_id) out = out.filter((r) => r.session_track_id === filters.track_id);
  if (filters.format_id) out = out.filter((r) => r.session_format_id === filters.format_id);
  if (filters.sponsor_id) out = out.filter((r) => str(r.instance.sponsor_id) === filters.sponsor_id);
  if (filters.definition_id) out = out.filter((r) => str(r.instance.definition_id) === filters.definition_id);
  if (filters.assignee_person_id) out = out.filter((r) => str(r.instance.assignee_person_id) === filters.assignee_person_id);
  if (filters.status) out = out.filter((r) => str(r.instance.status) === filters.status);
  if (filters.overdue) out = out.filter((r) => r.is_overdue);
  return out;
}

/* -------------------------------------------------------------------------- */
/* TaskCompletionStats — per definition                                       */
/* -------------------------------------------------------------------------- */

export interface DefinitionStats extends CompletionStats {
  definition: Row;
  median_days_to_complete: number | null;
}

/** Completion rate, median days-to-complete, reminder count before completion (07, "Read models"). */
export async function completionStatsByDefinition(app: AppContext, eventId: string): Promise<DefinitionStats[]> {
  const defs = await app.db.select<Row>("task_definition", { event_id: eventId }, { orderBy: "sort_order" });
  const out: DefinitionStats[] = [];
  for (const def of defs) {
    const instances = await app.db.select<Row>("task_instance", { definition_id: str(def.id) });
    const stats = completionStats(instances.map((i) => ({ status: str(i.status) as TaskInstanceStatus, is_blocking: bool(i.is_blocking), is_required: bool(i.is_required) })));
    const durations = instances
      .filter((i) => str(i.status) === "completed" && i.completed_at)
      .map((i) => (new Date(str(i.completed_at)).getTime() - new Date(str(i.created_at)).getTime()) / 86_400_000)
      .sort((a, b) => a - b);
    const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    out.push({ ...stats, definition: def, median_days_to_complete: median === null ? null : Math.round(median) });
  }
  return out;
}

export { onboardingProgress };
