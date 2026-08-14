/**
 * Onboarding — the `TaskDefinition` / `TaskInstance` aggregates (07-onboarding.md).
 *
 * "Definitions are templates, instances are obligations, and the two are
 * versioned apart." Every invariant is enforced here, at the root; materiali-
 * sation lives in `materialise.ts` because it spans many instances at once.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { slotKey as buildSlotKey } from "@podiumstack/domain/content/assets.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  assertAcyclic,
  assertMayComplete,
  assertStartable,
  assertTaskTransition,
  assertWaiverReason,
  canTransitionTask,
  checkCompletion,
  isTerminalTask,
  nextStatusOnSubmit,
  reminderSuppression,
  type CompletionResult,
  type RequirementType,
  type TaskCategory,
  type TaskInstanceStatus,
  type TaskSubjectType,
} from "@podiumstack/domain/onboarding/types.js";
import { DEFAULT_TASK_DEFINITIONS, type DefaultTaskDefinition } from "@podiumstack/domain/onboarding/defaults.js";
import { DomainError, illegalTransition, invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { addDays, calendarDateInZone, type Instant } from "@podiumstack/domain/shared/time.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";
import {
  eventStartOf,
  materialiseChained,
  materialiseInstance,
  rematerialiseDefinition,
  unblockDependents,
  type AssigneeCandidate,
} from "./materialise.js";

export type { AssigneeCandidate };

/* -------------------------------------------------------------------------- */
/* TaskDefinition — CRUD                                                      */
/* -------------------------------------------------------------------------- */

export interface DefinitionInput {
  key?: string | null;
  title: string;
  instructions?: string | null;
  category: TaskCategory;
  requirement_type: RequirementType;
  config: Record<string, unknown>;
  subject_type: TaskSubjectType;
  assignee_rule: string;
  assignee_person_id?: string | null;
  assignee_person_ids?: string[];
  applies_to?: Record<string, unknown> | null;
  trigger: string;
  trigger_task_key?: string | null;
  due_rule: string;
  due_value?: Record<string, unknown> | null;
  is_blocking?: boolean;
  is_required?: boolean;
  requires_review?: boolean;
  auto_complete_on_event?: string | null;
  depends_on_task_keys?: string[];
  sort_order?: number;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "task"
  );
}

export async function listDefinitions(app: AppContext, eventId: string): Promise<Row[]> {
  return app.db.select<Row>("task_definition", { event_id: eventId }, { orderBy: "sort_order, key" });
}

export async function getDefinition(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("task_definition", id);
  if (!row) throw notFound("Task definition", id);
  return row;
}

/** INV-07-12 — `named_people` requires a non-empty `assignee_person_ids`. Pure, so it is unit-tested directly. */
export function assertNamedPeople(assigneeRule: string, ids: string[] | undefined): void {
  if (assigneeRule === "named_people" && (!ids || ids.length === 0)) {
    // INV-07-12
    throw invariantError("INV-07-12", "named_people_requires_people", "Name at least one person for a named-people task.");
  }
}

export async function createTaskDefinition(app: AppContext, eventId: string, input: DefinitionInput): Promise<Row> {
  assertNamedPeople(input.assignee_rule, input.assignee_person_ids);
  const key = slugify(input.key || input.title);
  const existing = await app.db.first<Row>("task_definition", { event_id: eventId, key });
  if (existing) {
    throw new DomainError({ code: "duplicate_key", message: `A task called "${key}" already exists on this event.`, status: 422 });
  }
  const id = newId("TaskDefinition");
  const now = app.now();
  const row: Row = {
    id,
    event_id: eventId,
    key,
    title: input.title,
    instructions: input.instructions ?? null,
    category: input.category,
    requirement_type: input.requirement_type,
    config: JSON.stringify(input.config ?? {}),
    subject_type: input.subject_type,
    assignee_rule: input.assignee_rule,
    assignee_person_id: input.assignee_person_id ?? null,
    assignee_person_ids: input.assignee_person_ids?.length ? JSON.stringify(input.assignee_person_ids) : null,
    applies_to: input.applies_to && Object.keys(input.applies_to).length ? JSON.stringify(input.applies_to) : null,
    trigger: input.trigger,
    trigger_task_key: input.trigger_task_key ?? null,
    due_rule: input.due_rule,
    due_value: input.due_value ? JSON.stringify(input.due_value) : null,
    is_blocking: input.is_blocking ? 1 : 0,
    is_required: input.is_required === false ? 0 : 1,
    requires_review: input.requires_review ? 1 : 0,
    auto_complete_on_event: input.auto_complete_on_event ?? null,
    depends_on_task_keys: input.depends_on_task_keys?.length ? JSON.stringify(input.depends_on_task_keys) : null,
    sort_order: input.sort_order ?? 0,
    status: "draft",
    version: 1,
    created_at: now,
    updated_at: now,
    row_version: 1,
  };
  await app.db.insert("task_definition", row);
  app.audit.record({ action: "task_definition.create", entity_type: "task_definition", entity_id: id, after: { key, title: input.title } });
  return row;
}

const SEMANTIC_FIELDS = [
  "title",
  "instructions",
  "category",
  "requirement_type",
  "config",
  "subject_type",
  "assignee_rule",
  "assignee_person_id",
  "assignee_person_ids",
  "applies_to",
  "trigger",
  "trigger_task_key",
  "due_rule",
  "due_value",
  "is_blocking",
  "is_required",
  "requires_review",
  "auto_complete_on_event",
  "depends_on_task_keys",
] as const;
const JSON_FIELDS = new Set(["config", "assignee_person_ids", "applies_to", "due_value", "depends_on_task_keys"]);

/**
 * Editing a definition never touches existing instances (INV-07-1): only
 * future materialisations see the change. `version` is bumped whenever a
 * semantic field changes, so a re-materialise can be told "this is stale".
 */
export async function updateTaskDefinition(app: AppContext, id: string, patch: Partial<DefinitionInput>): Promise<Row> {
  const def = await getDefinition(app, id);
  const effectiveRule = patch.assignee_rule ?? str(def.assignee_rule);
  if ("assignee_rule" in patch || "assignee_person_ids" in patch) {
    assertNamedPeople(effectiveRule, patch.assignee_person_ids ?? parseJson<string[]>(def.assignee_person_ids, []));
  }
  const update: Row = {};
  let semanticChange = false;
  for (const f of SEMANTIC_FIELDS) {
    if (!(f in patch)) continue;
    const raw = (patch as Record<string, unknown>)[f];
    let value: unknown;
    if (JSON_FIELDS.has(f)) {
      const hasContent = Array.isArray(raw) ? raw.length > 0 : !!raw && Object.keys(raw as object).length > 0;
      value = hasContent ? JSON.stringify(raw) : null;
    } else if (typeof raw === "boolean") {
      value = raw ? 1 : 0;
    } else {
      value = raw ?? null;
    }
    if (String(value ?? "") !== String(def[f] ?? "")) {
      update[f] = value;
      semanticChange = true;
    }
  }
  if (patch.sort_order !== undefined) update.sort_order = patch.sort_order;
  if (Object.keys(update).length === 0) return def;
  if (semanticChange) update.version = num(def.version, 1) + 1; // INV-07-1
  update.updated_at = app.now();
  await app.db.update("task_definition", id, update);
  app.audit.record({ action: "task_definition.update", entity_type: "task_definition", entity_id: id, after: update });
  return { ...def, ...update };
}

/** INV-07-4 — dependency graphs are validated acyclic at activation. */
export async function activateTaskDefinition(app: AppContext, id: string): Promise<Row> {
  const def = await getDefinition(app, id);
  const all = await listDefinitions(app, str(def.event_id));
  const nodes = all
    .filter((d) => str(d.id) === id || str(d.status) === "active")
    .map((d) => ({ key: str(d.key), depends_on_task_keys: parseJson<string[]>(d.depends_on_task_keys, []) }));
  assertAcyclic(nodes);
  await app.db.update("task_definition", id, { status: "active", updated_at: app.now() });
  app.events.emit({
    type: "task_definition.activated",
    subject: { type: "definition", id },
    event_id: str(def.event_id),
    data: { definition_id: id, key: str(def.key), version: num(def.version, 1), is_blocking: bool(def.is_blocking) },
  });
  app.audit.record({ action: "task_definition.activate", entity_type: "task_definition", entity_id: id });
  return { ...def, status: "active" };
}

export async function retireTaskDefinition(app: AppContext, id: string): Promise<Row> {
  const def = await getDefinition(app, id);
  await app.db.update("task_definition", id, { status: "retired", updated_at: app.now() });
  app.audit.record({ action: "task_definition.retire", entity_type: "task_definition", entity_id: id });
  return { ...def, status: "retired" };
}

/** The organizer's explicit, audited "apply this definition to existing subjects" command. */
export async function rematerialise(app: AppContext, definitionId: string): Promise<number> {
  const def = await getDefinition(app, definitionId);
  const created = await rematerialiseDefinition(app, def);
  app.audit.record({ action: "task_definition.rematerialise", entity_type: "task_definition", entity_id: definitionId, after: { created } });
  return created;
}

/** Seeds the shipped default set (07, "A realistic default set"). */
export async function createDefaultTaskDefinitions(app: AppContext, eventId: string): Promise<Row[]> {
  const created: Row[] = [];
  for (const [i, d] of DEFAULT_TASK_DEFINITIONS.entries() as IterableIterator<[number, DefaultTaskDefinition]>) {
    const existing = await app.db.first<Row>("task_definition", { event_id: eventId, key: d.key });
    if (existing) continue;
    const def = await createTaskDefinition(app, eventId, {
      key: d.key,
      title: d.title,
      instructions: d.instructions ?? null,
      category: d.category,
      requirement_type: d.requirement_type,
      config: d.config,
      subject_type: d.subject_type,
      assignee_rule: d.assignee_rule,
      applies_to: (d.applies_to ?? null) as Record<string, unknown> | null,
      trigger: d.trigger,
      due_rule: d.due_rule,
      due_value: d.due_value as Record<string, unknown>,
      is_blocking: d.is_blocking,
      is_required: d.is_required,
      requires_review: d.requires_review,
      depends_on_task_keys: d.depends_on_task_keys,
      sort_order: i,
    });
    const activated = await activateTaskDefinition(app, str(def.id));
    for (const offset of d.reminder_offsets) {
      await app.db.insert("task_reminder_rule", {
        id: newId("TaskReminderRule"),
        definition_id: activated.id,
        offset_days: offset,
        channel: "email",
        template_key: "task.reminder",
        escalate_to: offset > 0 ? "organizer" : null,
        only_if_status: null,
      });
    }
    created.push(activated);
  }
  return created;
}

/**
 * Copy an event's checklist onto another event (02, "Cloning an edition").
 *
 * Definitions are templates, so copying one is copying configuration —
 * `TaskInstance` rows are obligations belonging to named people and are never
 * copied (INV-02-14). Retired definitions are skipped: they were switched off
 * on purpose, and a clone that resurrects them is a clone nobody trusts. Each
 * copy lands `draft` and is activated after, so `assertAcyclic` (INV-07-3) is
 * checked against the new event exactly as a hand-built definition would be.
 */
export async function copyTaskDefinitionsToEvent(app: AppContext, fromEventId: string, toEventId: string): Promise<Row[]> {
  const source = await app.db.select<Row>("task_definition", { event_id: fromEventId }, { orderBy: "sort_order, key" });
  const created: Row[] = [];
  for (const [i, d] of source.entries()) {
    if (str(d.status) === "retired") continue;
    const existing = await app.db.first<Row>("task_definition", { event_id: toEventId, key: str(d.key) });
    if (existing) continue;
    const def = await createTaskDefinition(app, toEventId, {
      key: str(d.key),
      title: str(d.title),
      instructions: strOrNull(d.instructions),
      category: str(d.category, "other") as TaskCategory,
      requirement_type: str(d.requirement_type) as RequirementType,
      config: parseJson<Record<string, unknown>>(d.config, {}),
      subject_type: str(d.subject_type, "session") as TaskSubjectType,
      assignee_rule: str(d.assignee_rule),
      // A named assignee is an organizer, not a speaker: the same people
      // usually run the next edition, and a wrong one is a dropdown to change.
      assignee_person_id: strOrNull(d.assignee_person_id),
      assignee_person_ids: parseJson<string[]>(d.assignee_person_ids, []),
      applies_to: parseJson<Record<string, unknown> | null>(d.applies_to, null),
      trigger: str(d.trigger, "on_session_confirmed"),
      trigger_task_key: strOrNull(d.trigger_task_key),
      due_rule: str(d.due_rule, "none"),
      due_value: parseJson<Record<string, unknown> | null>(d.due_value, null),
      is_blocking: bool(d.is_blocking),
      is_required: bool(d.is_required),
      requires_review: bool(d.requires_review),
      auto_complete_on_event: strOrNull(d.auto_complete_on_event),
      depends_on_task_keys: parseJson<string[]>(d.depends_on_task_keys, []),
      sort_order: num(d.sort_order, i),
    });
    const rules = await app.db.select<Row>("task_reminder_rule", { definition_id: str(d.id) });
    for (const rule of rules) {
      await app.db.insert("task_reminder_rule", {
        id: newId("TaskReminderRule"),
        definition_id: str(def.id),
        offset_days: num(rule.offset_days),
        channel: str(rule.channel, "email"),
        template_key: str(rule.template_key),
        escalate_to: strOrNull(rule.escalate_to),
        only_if_status: strOrNull(rule.only_if_status),
      });
    }
    created.push(str(d.status) === "active" ? await activateTaskDefinition(app, str(def.id)) : def);
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/* Ad-hoc tasks — the same machinery, a one-form UI (07, "Ad-hoc tasks")       */
/* -------------------------------------------------------------------------- */

export interface AdhocTaskInput {
  title: string;
  instructions?: string | null;
  requirement_type: RequirementType;
  config?: Record<string, unknown>;
  due_rule: string;
  due_value?: Record<string, unknown> | null;
  assignee_person_ids: string[];
  is_blocking?: boolean;
  requires_review?: boolean;
  subject_type?: TaskSubjectType;
  /** The session or sponsor it is about, when it is about one. */
  subject_id?: string | null;
}

/**
 * `trigger = manual`, `assignee_rule = named_people` — a `TaskDefinition` the
 * organizer never sees as one. Materialises immediately, one instance per
 * named person.
 */
export async function createAdhocTask(app: AppContext, eventId: string, input: AdhocTaskInput): Promise<Row[]> {
  if (input.assignee_person_ids.length === 0) {
    throw invariantError("INV-07-12", "named_people_requires_people", "Name at least one person.");
  }
  const def = await createTaskDefinition(app, eventId, {
    key: `adhoc-${slugify(input.title)}-${newId("TaskDefinition").slice(-6).toLowerCase()}`,
    title: input.title,
    instructions: input.instructions ?? null,
    category: "other",
    requirement_type: input.requirement_type,
    config: input.config ?? {},
    subject_type: input.subject_type ?? "speaker",
    assignee_rule: "named_people",
    assignee_person_ids: input.assignee_person_ids,
    trigger: "manual",
    due_rule: input.due_rule,
    due_value: input.due_value ?? null,
    is_blocking: input.is_blocking ?? false,
    is_required: true,
    requires_review: input.requires_review ?? false,
    sort_order: 999,
  });
  const activated = await activateTaskDefinition(app, str(def.id));
  const eventStart = await eventStartOf(app, eventId);
  const subjectType = str(activated.subject_type) as TaskSubjectType;
  const created: Row[] = [];
  for (const personId of input.assignee_person_ids) {
    const subjectId = subjectType === "speaker" ? personId : (input.subject_id ?? personId);
    const instance = await materialiseInstance(app, activated, {
      subject_type: subjectType,
      subject_id: subjectId,
      assignee_person_id: personId,
      session_id: subjectType === "session" ? subjectId : null,
      sponsor_id: subjectType === "sponsor" ? subjectId : null,
      event_start: eventStart,
      session_start: null,
    });
    if (instance) created.push(instance);
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/* TaskInstance — reads                                                       */
/* -------------------------------------------------------------------------- */

export async function getInstance(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("task_instance", id);
  if (!row) throw notFound("Task", id);
  return row;
}

export async function listSubmissions(app: AppContext, taskId: string): Promise<Row[]> {
  return app.db.select<Row>("task_submission", { task_instance_id: taskId }, { orderBy: "version DESC" });
}

/* -------------------------------------------------------------------------- */
/* TaskInstance — state machine                                               */
/* -------------------------------------------------------------------------- */

async function completeInstance(app: AppContext, t: Row, completedByPersonId: string): Promise<Row> {
  const from = str(t.status) as TaskInstanceStatus;
  assertTaskTransition(from, "completed");
  const now = app.now();
  const update: Row = { status: "completed", completed_at: now, completed_by_person_id: completedByPersonId, updated_at: now };
  await app.db.update("task_instance", str(t.id), update);
  const days = Math.max(0, Math.round((new Date(now).getTime() - new Date(str(t.created_at)).getTime()) / 86_400_000));
  app.events.emit({
    type: "task_instance.completed",
    subject: { type: "task", id: str(t.id) },
    event_id: str(t.event_id),
    data: { task_instance_id: str(t.id), completed_by: completedByPersonId, days_to_complete: days, reminder_count: num(t.reminder_count) },
  });
  app.audit.record({ action: "task_instance.complete", entity_type: "task_instance", entity_id: str(t.id) });
  return { ...t, ...update };
}

/** not_started/changes_requested → in_progress: the assignee opens the task. */
export async function startTask(app: AppContext, id: string, actor: { personId: string | null; isStaff: boolean }): Promise<Row> {
  const t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  assertMayComplete(str(t.assignee_person_id), actor.personId, actor.isStaff); // INV-07-5
  assertStartable(from); // INV-07-4 — a blocked task cannot be started
  if (from === "in_progress") return t;
  assertTaskTransition(from, "in_progress");
  const now = app.now();
  const update: Row = { status: "in_progress", updated_at: now };
  const firstStart = !t.started_at;
  if (firstStart) update.started_at = now;
  await app.db.update("task_instance", id, update);
  if (firstStart) {
    app.events.emit({ type: "task_instance.started", subject: { type: "task", id }, event_id: str(t.event_id), data: { task_instance_id: id } });
  }
  return { ...t, ...update };
}

export interface SubmitInput {
  payload: Record<string, unknown>;
  asset_ids?: string[];
}

interface AssetInfo {
  id: string;
  scan_status: string;
  width?: number | null;
  height?: number | null;
}

async function assetsFor(app: AppContext, assetIds: string[]): Promise<AssetInfo[]> {
  const out: AssetInfo[] = [];
  for (const assetId of assetIds) {
    const a = await app.db.byId<Row>("asset", assetId);
    if (a) out.push({ id: assetId, scan_status: str(a.scan_status, "pending"), width: a.width === null ? null : num(a.width), height: a.height === null ? null : num(a.height) });
  }
  return out;
}

/**
 * in_progress → submitted/completed, per `nextStatusOnSubmit`. A `file_upload`
 * whose asset is still scanning is accepted and recorded (INV-07-9) but does
 * not advance; `retrySubmissionIfClean` finishes it once the scan clears.
 */
export async function submitTask(
  app: AppContext,
  id: string,
  actor: { personId: string | null; isStaff: boolean },
  input: SubmitInput,
): Promise<{ instance: Row; result: CompletionResult }> {
  let t = await getInstance(app, id);
  assertMayComplete(str(t.assignee_person_id), actor.personId, actor.isStaff); // INV-07-5
  const from = str(t.status) as TaskInstanceStatus;
  if (from === "not_started" || from === "changes_requested") {
    t = await startTask(app, id, actor);
  } else if (from !== "in_progress") {
    throw illegalTransition("Task", from, "submitted");
  }

  const assetIds = input.asset_ids ?? [];
  const assets = await assetsFor(app, assetIds);
  const result = checkCompletion({
    requirement_type: str(t.requirement_type) as RequirementType,
    config: parseJson<Record<string, unknown>>(t.config, {}),
    payload: input.payload ?? {},
    assets,
  });
  const scanPending = result.invariant === "INV-07-9" && assets.length > 0 && assets.every((a) => a.scan_status === "pending");
  if (!result.satisfied && !scanPending) {
    throw new DomainError({ code: "task_not_complete", message: result.message ?? "This is not ready to submit yet.", status: 422, invariant: result.invariant });
  }

  const lastSubmission = await app.db.select<Row>("task_submission", { task_instance_id: id }, { orderBy: "version DESC", limit: 1 });
  const version = num(lastSubmission[0]?.version, 0) + 1;
  await app.db.insert("task_submission", {
    id: newId("TaskSubmission"),
    task_instance_id: id,
    version,
    payload: JSON.stringify(input.payload ?? {}),
    asset_ids: assetIds.length ? JSON.stringify(assetIds) : null,
    submitted_by_person_id: actor.personId ?? str(t.assignee_person_id),
    submitted_at: app.now(),
    review_outcome: result.satisfied ? (bool(t.requires_review) ? "pending" : "approved") : null,
  });

  if (!result.satisfied) {
    // Still scanning — the assignee submitted, but this is not "submitted" as
    // a fact yet. `retrySubmissionIfClean` (asset.uploaded reaction) finishes it.
    await app.db.update("task_instance", id, { updated_at: app.now() });
    return { instance: t, result };
  }

  app.events.emit({ type: "task_instance.submitted", subject: { type: "task", id }, event_id: str(t.event_id), data: { task_instance_id: id, submission_version: version } });
  const next = nextStatusOnSubmit(bool(t.requires_review));
  const now = app.now();
  await app.db.update("task_instance", id, { status: next, submitted_at: now, updated_at: now });
  t = { ...t, status: next, submitted_at: now };
  if (next === "completed") t = await completeInstance(app, t, actor.personId ?? str(t.assignee_person_id));
  return { instance: t, result };
}

/** Re-checks the latest submission once an attached asset finishes scanning clean. */
export async function retrySubmissionIfClean(app: AppContext, taskId: string): Promise<Row | null> {
  const t = await getInstance(app, taskId);
  if (str(t.status) !== "in_progress") return null;
  const submissions = await app.db.select<Row>("task_submission", { task_instance_id: taskId }, { orderBy: "version DESC", limit: 1 });
  const last = submissions[0];
  if (!last) return null;
  const assetIds = parseJson<string[]>(last.asset_ids, []);
  if (assetIds.length === 0) return null;
  const assets = await assetsFor(app, assetIds);
  const result = checkCompletion({
    requirement_type: str(t.requirement_type) as RequirementType,
    config: parseJson<Record<string, unknown>>(t.config, {}),
    payload: parseJson<Record<string, unknown>>(last.payload, {}),
    assets,
  });
  if (!result.satisfied) return null;

  await app.db.update("task_submission", str(last.id), { review_outcome: bool(t.requires_review) ? "pending" : "approved" });
  app.events.emit({
    type: "task_instance.submitted",
    subject: { type: "task", id: taskId },
    event_id: str(t.event_id),
    data: { task_instance_id: taskId, submission_version: num(last.version) },
  });
  const next = nextStatusOnSubmit(bool(t.requires_review));
  const now = app.now();
  await app.db.update("task_instance", taskId, { status: next, submitted_at: now, updated_at: now });
  let updated: Row = { ...t, status: next, submitted_at: now };
  if (next === "completed") updated = await completeInstance(app, updated, str(t.assignee_person_id));
  return updated;
}

/** not_started/in_progress → completed, without a submission: an integration or a scan-clear reports it. */
export async function autoCompleteInstance(app: AppContext, id: string): Promise<Row | null> {
  const t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  if (!canTransitionTask(from, "completed")) return null;
  return completeInstance(app, t, str(t.assignee_person_id));
}

/** submitted → completed: organizer approval (INV-07-6). */
export async function approveTask(app: AppContext, id: string, actorPersonId: string | null, note?: string | null): Promise<Row> {
  let t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  if (from !== "submitted") throw illegalTransition("Task", from, "completed");
  const submissions = await app.db.select<Row>("task_submission", { task_instance_id: id }, { orderBy: "version DESC", limit: 1 });
  if (submissions[0]) {
    await app.db.update("task_submission", str(submissions[0].id), {
      review_outcome: "approved",
      reviewed_by_person_id: actorPersonId,
      reviewed_at: app.now(),
      review_note: note ?? null,
    });
  }
  await app.db.update("task_instance", id, { reviewed_by_person_id: actorPersonId, review_note: note ?? null, updated_at: app.now() });
  t = { ...t, review_note: note ?? null };
  return completeInstance(app, t, str(t.assignee_person_id));
}

/** submitted → changes_requested. */
export async function requestChanges(app: AppContext, id: string, actorPersonId: string | null, note: string): Promise<Row> {
  const t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  assertTaskTransition(from, "changes_requested");
  const trimmed = note.trim();
  if (!trimmed) throw new DomainError({ code: "note_required", message: "Say what needs to change.", status: 422 });
  const submissions = await app.db.select<Row>("task_submission", { task_instance_id: id }, { orderBy: "version DESC", limit: 1 });
  if (submissions[0]) {
    await app.db.update("task_submission", str(submissions[0].id), {
      review_outcome: "changes_requested",
      reviewed_by_person_id: actorPersonId,
      reviewed_at: app.now(),
      review_note: trimmed,
    });
  }
  const now = app.now();
  await app.db.update("task_instance", id, { status: "changes_requested", reviewed_by_person_id: actorPersonId, review_note: trimmed, updated_at: now });
  app.events.emit({
    type: "task_instance.changes_requested",
    subject: { type: "task", id },
    event_id: str(t.event_id),
    data: { task_instance_id: id, review_note: trimmed },
  });
  app.audit.record({ action: "task_instance.request_changes", entity_type: "task_instance", entity_id: id, reason: trimmed });
  return { ...t, status: "changes_requested", review_note: trimmed };
}

/** INV-07-7 — waiving requires a reason and is always attributed; reported separately from completion. */
export async function waiveTask(app: AppContext, id: string, reason: string, waivedByPersonId: string | null): Promise<Row> {
  const t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  assertTaskTransition(from, "waived");
  const trimmed = assertWaiverReason(reason);
  const now = app.now();
  await app.db.update("task_instance", id, { status: "waived", waived_by_person_id: waivedByPersonId, waiver_reason: trimmed, updated_at: now });
  app.events.emit({
    type: "task_instance.waived",
    subject: { type: "task", id },
    event_id: str(t.event_id),
    data: { task_instance_id: id, waived_by: waivedByPersonId, waiver_reason: trimmed },
  });
  app.audit.record({ action: "task_instance.waive", entity_type: "task_instance", entity_id: id, reason: trimmed });
  return { ...t, status: "waived" };
}

/** completed → in_progress: an organizer reopens a task, e.g. a bad upload slipped through review. */
export async function reopenTask(app: AppContext, id: string, reason?: string | null): Promise<Row> {
  const t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  assertTaskTransition(from, "in_progress");
  const now = app.now();
  await app.db.update("task_instance", id, { status: "in_progress", completed_at: null, completed_by_person_id: null, updated_at: now });
  app.audit.record({ action: "task_instance.reopen", entity_type: "task_instance", entity_id: id, reason: reason ?? undefined });
  return { ...t, status: "in_progress", completed_at: null, completed_by_person_id: null };
}

/**
 * INV-07-8 — cancellation reaches every non-terminal state (C7): `blocked`,
 * `not_started`, `in_progress`, `submitted` and `changes_requested`.
 * Completed and waived instances are retained for the record.
 */
export async function cancelInstance(app: AppContext, id: string, reason: string): Promise<Row | null> {
  const t = await getInstance(app, id);
  const from = str(t.status) as TaskInstanceStatus;
  if (isTerminalTask(from)) return null;
  assertTaskTransition(from, "cancelled");
  await app.db.update("task_instance", id, { status: "cancelled", updated_at: app.now() });
  app.events.emit({ type: "task_instance.cancelled", subject: { type: "task", id }, event_id: str(t.event_id), data: { task_instance_id: id, reason } });
  return { ...t, status: "cancelled" };
}

export async function cancelInstancesForSession(app: AppContext, sessionId: string, reason: string): Promise<number> {
  const rows = await app.db.select<Row>("task_instance", { session_id: sessionId });
  let n = 0;
  for (const r of rows) if (await cancelInstance(app, str(r.id), reason)) n++;
  return n;
}

export async function cancelInstancesForAssignee(app: AppContext, sessionId: string, personId: string, reason: string): Promise<number> {
  const rows = await app.db.select<Row>("task_instance", { session_id: sessionId, assignee_person_id: personId });
  let n = 0;
  for (const r of rows) if (await cancelInstance(app, str(r.id), reason)) n++;
  return n;
}

export async function waiveMany(app: AppContext, taskIds: string[], reason: string, waivedBy: string | null): Promise<number> {
  let n = 0;
  for (const id of taskIds) {
    try {
      await waiveTask(app, id, reason, waivedBy);
      n++;
    } catch {
      // Already terminal, or not this instance's transition to make — the
      // board re-reads current state; a partial batch is not an error.
    }
  }
  return n;
}

/** `task_instance.completed` also unblocks dependents and may chain the next definition. */
export async function reactToCompletion(app: AppContext, completed: Row): Promise<{ unblocked: number; chained: Row[] }> {
  const unblocked = await unblockDependents(app, completed);
  const chained = await materialiseChained(app, completed);
  return { unblocked, chained };
}

/* -------------------------------------------------------------------------- */
/* Reminders — INV-07-13                                                      */
/* -------------------------------------------------------------------------- */

export interface ReminderCandidate {
  instance: Row;
  rule_id: string | null;
  trigger: "scheduled" | "manual";
  triggered_by_person_id?: string | null;
}

/**
 * Shared by the cron sweep and manual nudges. Digests per assignee per day
 * (in their timezone), writes a `TaskReminderLog` row per candidate (sent or
 * suppressed, so "did we chase them?" always has an answer), and writes the
 * `NotificationDelivery` outbox row directly — this context owns its own
 * reminders rather than going through `platform.queueNotification`.
 *
 * That is a deliberate choice, not the bypass it looks like: "digest by
 * default" (07, "Reminders") means one email listing every task due for a
 * person, and `queueNotification`'s contract is one template rendered for one
 * subject — it has no shape for "N tasks, one message" any more than
 * `remindReviewer` (05, `review/service.ts`) routes the reviewer chase through
 * it. Both contexts hand-build the digested body and write the row directly.
 *
 * What *was* a bug, and is fixed here: the row was left at `status: "queued"`
 * with nothing ever calling `DELIVERY_QUEUE.send` — so both the scheduled
 * sweep and a manual nudge reported themselves sent and reached nobody. Every
 * other direct-write path in this codebase (`review/service.ts`
 * `writeDecisionNotification`, `remindReviewer`) enqueues the delivery
 * immediately after the insert; this now does too. The `template_key` is also
 * fixed to `task.reminder`, the one declared in `platform/templates.ts` — the
 * previous `task.manual_reminder` for manual nudges did not exist, which
 * silently defeated `isTransactionalTemplate` (an obligation reminder was
 * treated as suppressible marketing content) as well as leaving the outbox
 * carrying a template key nothing could resolve or preview.
 */
export async function deliverReminders(app: AppContext, candidates: ReminderCandidate[]): Promise<{ sent: number; suppressed: number }> {
  let sent = 0;
  let suppressed = 0;
  const now = app.now();
  const byAssignee = new Map<string, ReminderCandidate[]>();
  for (const c of candidates) {
    // INV-07-13 — never remind on a terminal instance.
    if (isTerminalTask(str(c.instance.status) as TaskInstanceStatus)) continue;
    const key = str(c.instance.assignee_person_id);
    const list = byAssignee.get(key) ?? [];
    list.push(c);
    byAssignee.set(key, list);
  }

  for (const [personId, list] of byAssignee) {
    const person = await app.db.byId<Row>("person", personId);
    const tz = strOrNull(person?.timezone) ?? "UTC";
    const today = calendarDateInZone(now, tz);
    const lastSent = await app.db.raw<Row>(
      `SELECT trl.sent_at FROM task_reminder_log trl JOIN task_instance ti ON ti.id = trl.task_instance_id
        WHERE ti.assignee_person_id = ? AND trl.sent_at IS NOT NULL ORDER BY trl.sent_at DESC LIMIT 1`,
      [personId],
    );
    const alreadyDigestedToday = lastSent[0]?.sent_at ? calendarDateInZone(str(lastSent[0].sent_at), tz) === today : false;

    const due: ReminderCandidate[] = [];
    for (const c of list) {
      const reason = reminderSuppression({
        status: str(c.instance.status) as TaskInstanceStatus,
        last_reminded_at: strOrNull(c.instance.last_reminded_at),
        now,
        already_sent_today: alreadyDigestedToday,
        unsubscribed: false,
      });
      if (reason) {
        await app.db.insert("task_reminder_log", {
          id: newId("TaskReminderLog"),
          task_instance_id: str(c.instance.id),
          rule_id: c.rule_id,
          trigger: c.trigger,
          triggered_by_person_id: c.triggered_by_person_id ?? null,
          scheduled_for: now,
          sent_at: null,
          suppressed_reason: reason,
        });
        suppressed++;
        continue;
      }
      due.push(c);
    }
    if (due.length === 0) continue;

    const notificationId = newId("NotificationDelivery");
    const lines = due.map((c) => `- ${str(c.instance.title)} (due ${strOrNull(c.instance.due_at) ?? "no date set"})`).join("\n");
    await app.db.insert("notification_delivery", {
      id: notificationId,
      event_id: strOrNull(due[0].instance.event_id),
      template_key: "task.reminder",
      recipient_person_id: personId,
      recipient_email: str(person?.email, ""),
      channel: "email",
      subject_type: "person",
      subject_id: personId,
      rendered_body: `You have ${due.length} onboarding task${due.length === 1 ? "" : "s"} due:\n${lines}`,
      status: "queued",
      created_at: now,
    });
    const message: DeliveryMessage = { kind: "notification", notification_id: notificationId };
    try {
      await app.env.DELIVERY_QUEUE.send(message);
    } catch (err) {
      // The row is committed either way (INV-09-12); a queue outage costs
      // latency, not the fact that the message was intended.
      console.warn("task reminder enqueue failed", { notification_id: notificationId, error: String(err) });
    }
    for (const c of due) {
      await app.db.insert("task_reminder_log", {
        id: newId("TaskReminderLog"),
        task_instance_id: str(c.instance.id),
        rule_id: c.rule_id,
        trigger: c.trigger,
        triggered_by_person_id: c.triggered_by_person_id ?? null,
        scheduled_for: now,
        sent_at: now,
        notification_id: notificationId,
        suppressed_reason: null,
      });
      const newCount = num(c.instance.reminder_count) + 1;
      await app.db.update("task_instance", str(c.instance.id), { reminder_count: newCount, last_reminded_at: now, updated_at: now });
      const rule = c.rule_id ? await app.db.byId<Row>("task_reminder_rule", c.rule_id) : null;
      app.events.emit({
        type: "task_reminder.sent",
        subject: { type: "task", id: str(c.instance.id) },
        event_id: strOrNull(c.instance.event_id),
        data: { task_instance_id: str(c.instance.id), rule_id: c.rule_id, reminder_count: newCount, escalated_to: strOrNull(rule?.escalate_to) },
      });
      sent++;
    }
  }
  return { sent, suppressed };
}

/** The organizer's board "Remind selected" — same rules as a scheduled one (INV-07-13). */
export async function sendManualReminder(app: AppContext, taskIds: string[], actorPersonId: string | null): Promise<{ sent: number; suppressed: number }> {
  const candidates: ReminderCandidate[] = [];
  for (const id of taskIds) {
    const t = await app.db.byId<Row>("task_instance", id);
    if (!t) continue;
    candidates.push({ instance: t, rule_id: null, trigger: "manual", triggered_by_person_id: actorPersonId });
  }
  return deliverReminders(app, candidates);
}

/** Candidates whose `TaskReminderRule` offset has crossed `due_at`, not yet logged. */
export async function scheduledReminderCandidates(app: AppContext): Promise<ReminderCandidate[]> {
  const now = app.now();
  const pairs = await app.db.raw<Row>(
    `SELECT ti.id AS instance_id, trr.id AS rule_id, trr.offset_days AS offset_days, trr.only_if_status AS only_if_status
       FROM task_reminder_rule trr
       JOIN task_instance ti ON ti.definition_id = trr.definition_id
      WHERE ti.due_at IS NOT NULL AND ti.status NOT IN ('completed','waived','cancelled')`,
    [],
  );
  const out: ReminderCandidate[] = [];
  for (const p of pairs) {
    const instanceId = str(p.instance_id);
    const ruleId = str(p.rule_id);
    const already = await app.db.raw<{ n: number }>("SELECT COUNT(*) AS n FROM task_reminder_log WHERE task_instance_id = ? AND rule_id = ?", [
      instanceId,
      ruleId,
    ]);
    if (num(already[0]?.n) > 0) continue;
    const instance = await app.db.byId<Row>("task_instance", instanceId);
    if (!instance || !instance.due_at) continue;
    const onlyStatuses = parseJson<string[]>(p.only_if_status, []);
    if (onlyStatuses.length && !onlyStatuses.includes(str(instance.status))) continue;
    const target = addDays(str(instance.due_at), num(p.offset_days));
    if (now < target) continue;
    out.push({ instance, rule_id: ruleId, trigger: "scheduled" });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* File uploads for `file_upload` tasks                                       */
/* -------------------------------------------------------------------------- */

const TASK_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The Content context owns uploads generally; a task's file input is a thin,
 * self-contained slice of the same idea (mirrors identity's `storeHeadshot`)
 * so `POST /portal/tasks/:id` works without depending on Content's surface.
 * `Asset.checksum` is measured here, never trusted from the client.
 */
export async function storeTaskUpload(app: AppContext, taskId: string, file: File, actorPersonId: string | null): Promise<string> {
  const t = await getInstance(app, taskId);
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) throw new DomainError({ code: "empty_upload", message: "That file was empty.", status: 422 });
  if (buffer.byteLength > TASK_UPLOAD_MAX_BYTES) {
    throw new DomainError({ code: "file_too_large", message: "That file is larger than the 50 MB limit.", status: 422 });
  }
  const contentType = file.type || "application/octet-stream";
  const filename = (file.name || "upload").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  // A task's upload belongs to the thing the task is about, not to the task
  // row. Keying it `task:<id>:<filename>` hid every deliverable from the event
  // files library (which scopes by `session:`/`person:` slots) and restarted
  // versioning whenever the speaker renamed the file — "slides-final-v2.pdf"
  // became version 1 all over again. The slot is the subject plus the
  // definition key, so re-submitting any file supersedes the last one.
  const slotKey = buildSlotKey(str(t.subject_type), str(t.subject_id), str(t.definition_key));
  const prior = await app.db.raw<Row>("SELECT id, version FROM asset WHERE slot_key = ? ORDER BY version DESC LIMIT 1", [
    slotKey,
  ]);
  const version = num(prior[0]?.version, 0) + 1;
  const id = newId("Asset");
  const storageKey = `${app.orgId}/task/${taskId}/${version}/${filename}`;
  await app.env.ASSETS_BUCKET.put(storageKey, buffer, { httpMetadata: { contentType } });
  await app.db.insert("asset", {
    id,
    storage_key: storageKey,
    filename,
    content_type: contentType,
    size_bytes: buffer.byteLength,
    checksum: await sha256Hex(buffer),
    scan_status: "pending", // INV-11-3: cleared by the content-scanning path before any public use.
    visibility: "private",
    uploaded_by_person_id: actorPersonId ?? str(t.assignee_person_id),
    purpose: "task_submission",
    slot_key: slotKey,
    version,
    supersedes_asset_id: prior[0] ? str(prior[0].id) : null,
    created_at: app.now(),
  });
  app.events.emit({
    type: "asset.uploaded",
    subject: { type: "asset", id },
    event_id: strOrNull(t.event_id),
    data: {
      asset_id: id,
      slot_key: slotKey,
      version,
      purpose: "task_submission",
      filename,
      size_bytes: buffer.byteLength,
      uploaded_by_person_id: actorPersonId ?? str(t.assignee_person_id),
    },
  });
  return id;
}

export type { Instant };
