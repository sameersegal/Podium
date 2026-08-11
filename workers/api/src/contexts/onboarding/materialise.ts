/**
 * Materialisation — 07-onboarding.md, "Materialisation".
 *
 * The six numbered steps, run for every active `TaskDefinition` against
 * whichever subject a trigger names:
 *   1. does `applies_to` match this session and this speaker?
 *   2. resolve `assignee_rule` to concrete people
 *   3. snapshot title / instructions / type / config; freeze `definition_version`
 *   4. resolve `due_at`
 *   5. `blocked` if `depends_on_task_keys` are incomplete, else `not_started`
 *   6. skip if an instance already exists for (definition_key, subject, assignee)
 *
 * Step 6 is what makes re-running this safe — it *will* be triggered by
 * retried events (INV-07-2).
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import {
  appliesTo,
  isTerminalTask,
  resolveDueAt,
  type AppliesTo as AppliesToFilter,
  type AssigneeRule,
  type DueRule,
  type DueValue,
  type TaskInstanceStatus,
  type TaskSubjectType,
  type TaskTrigger,
} from "@podiumconf/domain/onboarding/types.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import type { Instant } from "@podiumconf/domain/shared/time.js";
import { getSession, liveSpeakers, type SessionRow } from "../program/service.js";

export interface AssigneeCandidate {
  person_id: string;
  speaker_role?: string | null;
  attendance_mode?: string | null;
}

export interface MaterialiseParams {
  subject_type: TaskSubjectType;
  subject_id: string;
  assignee_person_id: string;
  session_id: string | null;
  sponsor_id: string | null;
  event_start: Instant | null;
  session_start: Instant | null;
}

/** `Event.starts_on` as an instant at the event's local start of business. */
export async function eventStartOf(app: AppContext, eventId: string): Promise<Instant | null> {
  const ev = await app.db.byId<Row>("event", eventId);
  const startsOn = str(ev?.starts_on);
  if (!startsOn) return null;
  return new Date(`${startsOn}T09:00:00.000Z`).toISOString();
}

async function sessionStartOf(app: AppContext, sessionId: string): Promise<Instant | null> {
  const placement = await app.db.first<Row>("placement", { session_id: sessionId });
  return placement ? str(placement.starts_at) : null;
}

async function sponsorContact(app: AppContext, sponsorId: string, eventId: string, role: string): Promise<Row | null> {
  const rows = await app.db.raw<Row>(
    `SELECT * FROM sponsor_contact
      WHERE sponsor_id = ? AND contact_role = ? AND status = 'active' AND (event_id IS NULL OR event_id = ?)
      ORDER BY event_id DESC LIMIT 1`,
    [sponsorId, role, eventId],
  );
  return rows[0] ?? null;
}

/** Materialisation step 2 — `assignee_rule` resolved to concrete people. */
async function resolveAssignees(
  app: AppContext,
  def: Row,
  ctx: {
    speakers?: AssigneeCandidate[];
    submitterPersonId?: string | null;
    sponsorId?: string | null;
    eventId: string;
    participantPersonId?: string | null;
  },
): Promise<AssigneeCandidate[]> {
  const rule = str(def.assignee_rule) as AssigneeRule;
  switch (rule) {
    case "each_speaker":
      return ctx.speakers ?? [];
    case "primary_speaker_only":
      return (ctx.speakers ?? []).filter((s) => s.speaker_role === "primary");
    case "submitter":
      return ctx.submitterPersonId ? [{ person_id: ctx.submitterPersonId }] : [];
    case "sponsor_primary_contact": {
      if (!ctx.sponsorId) return [];
      const c = await sponsorContact(app, ctx.sponsorId, ctx.eventId, "primary");
      return c ? [{ person_id: str(c.person_id) }] : [];
    }
    case "sponsor_speaker_wrangler": {
      if (!ctx.sponsorId) return [];
      const c = await sponsorContact(app, ctx.sponsorId, ctx.eventId, "speaker_wrangler");
      return c ? [{ person_id: str(c.person_id) }] : [];
    }
    case "named_organizer":
      return def.assignee_person_id ? [{ person_id: str(def.assignee_person_id) }] : [];
    case "named_people": {
      // INV-07-12 — a non-empty list, one instance per listed person.
      const ids = parseJson<string[]>(def.assignee_person_ids, []);
      return ids.map((id) => ({ person_id: id }));
    }
    case "each_participant":
      // INV-07-12 — resolves against a confirmed EventParticipant, independent
      // of whether the person has a session.
      return ctx.participantPersonId ? [{ person_id: ctx.participantPersonId }] : [];
    default:
      return [];
  }
}

async function existingLiveInstance(
  app: AppContext,
  definitionKey: string,
  subjectType: string,
  subjectId: string,
  assigneePersonId: string,
): Promise<Row | null> {
  const rows = await app.db.select<Row>("task_instance", {
    definition_key: definitionKey,
    subject_type: subjectType,
    subject_id: subjectId,
    assignee_person_id: assigneePersonId,
  });
  return rows.find((r) => str(r.status) !== "cancelled") ?? null;
}

async function depsSatisfied(
  app: AppContext,
  depKeys: string[],
  subjectType: string,
  subjectId: string,
  assigneePersonId: string,
): Promise<boolean> {
  for (const key of depKeys) {
    const rows = await app.db.select<Row>("task_instance", {
      definition_key: key,
      subject_type: subjectType,
      subject_id: subjectId,
      assignee_person_id: assigneePersonId,
    });
    if (!rows.some((r) => str(r.status) === "completed" || str(r.status) === "waived")) return false;
  }
  return true;
}

/**
 * Steps 3–6 for one definition against one already-resolved assignee. Returns
 * the inserted row, or `null` when step 6 skips it (already materialised).
 */
export async function materialiseInstance(app: AppContext, def: Row, params: MaterialiseParams): Promise<Row | null> {
  // Step 6 — INV-07-2: at most one non-cancelled instance per
  // (definition_key, subject, assignee). This is what makes a retried event a
  // no-op rather than a duplicate.
  if (await existingLiveInstance(app, str(def.key), params.subject_type, params.subject_id, params.assignee_person_id)) {
    return null;
  }

  // Step 4 — resolve due_at. Negative offsets are "before"; deadlines are
  // instants, not dates (11, "Time").
  const dueAt = resolveDueAt(str(def.due_rule) as DueRule, parseJson<DueValue>(def.due_value, {}), {
    event_start: params.event_start,
    session_start: params.session_start,
    assigned_at: app.now(),
  });

  // Step 5 — INV-07-4: blocked while depends_on_task_keys are unmet.
  const depKeys = parseJson<string[]>(def.depends_on_task_keys, []);
  let status: TaskInstanceStatus = "not_started";
  if (depKeys.length > 0) {
    const ok = await depsSatisfied(app, depKeys, params.subject_type, params.subject_id, params.assignee_person_id);
    if (!ok) status = "blocked";
  }

  // Step 3 — snapshot; frozen and never retroactively changed (INV-07-1).
  const id = newId("TaskInstance");
  const now = app.now();
  const row: Row = {
    id,
    event_id: str(def.event_id),
    definition_id: str(def.id),
    definition_version: num(def.version, 1),
    definition_key: str(def.key),
    title: str(def.title),
    requirement_type: str(def.requirement_type),
    config: typeof def.config === "string" ? def.config : JSON.stringify(def.config ?? {}),
    instructions: strOrNull(def.instructions),
    subject_type: params.subject_type,
    subject_id: params.subject_id,
    session_id: params.session_id,
    assignee_person_id: params.assignee_person_id,
    sponsor_id: params.sponsor_id,
    status,
    is_blocking: bool(def.is_blocking) ? 1 : 0,
    is_required: bool(def.is_required) ? 1 : 0,
    requires_review: bool(def.requires_review) ? 1 : 0,
    due_at: dueAt,
    reminder_count: 0,
    created_at: now,
    updated_at: now,
  };
  await app.db.insert("task_instance", row);
  app.events.emit({
    type: "task_instance.created",
    subject: { type: "task", id },
    event_id: str(def.event_id),
    data: {
      task_instance_id: id,
      definition_key: str(def.key),
      subject_type: params.subject_type,
      subject_id: params.subject_id,
      assignee_person_id: params.assignee_person_id,
      due_at: dueAt,
      is_blocking: bool(def.is_blocking),
    },
  });
  return row;
}

function speakerCandidatesOf(rows: Row[]): AssigneeCandidate[] {
  return rows.map((s) => ({
    person_id: str(s.person_id),
    speaker_role: str(s.speaker_role),
    attendance_mode: strOrNull(s.attendance_mode),
  }));
}

async function submitterOf(app: AppContext, session: SessionRow): Promise<string | null> {
  if (!session.proposal_id) return null;
  const proposal = await app.db.byId<Row>("proposal", session.proposal_id);
  return proposal ? strOrNull(proposal.submitter_person_id) : null;
}

/** One definition, evaluated against one session and its live speakers. */
export async function materialiseOneDefinitionForSession(
  app: AppContext,
  def: Row,
  session: SessionRow,
  speakers: AssigneeCandidate[],
  opts: { onlyPersonId?: string | null; submitterPersonId?: string | null } = {},
): Promise<Row[]> {
  const subjectType = str(def.subject_type) as TaskSubjectType;
  if (subjectType === "sponsor" && !session.sponsor_id) return [];

  const candidates = await resolveAssignees(app, def, {
    speakers,
    submitterPersonId: opts.submitterPersonId ?? (await submitterOf(app, session)),
    sponsorId: session.sponsor_id ?? null,
    eventId: session.event_id,
  });
  const filtered = opts.onlyPersonId ? candidates.filter((c) => c.person_id === opts.onlyPersonId) : candidates;
  if (filtered.length === 0) return [];

  const eventStart = await eventStartOf(app, session.event_id);
  const sessionStart = await sessionStartOf(app, session.id);
  const filter = parseJson<AppliesToFilter>(def.applies_to, {});
  const created: Row[] = [];
  for (const candidate of filtered) {
    // Step 1 — applies_to, evaluated per candidate: attendance_mode and
    // speaker_role are per-speaker, not per-session.
    const ok = appliesTo(filter, {
      origin: session.origin,
      format_id: session.session_format_id,
      track_id: session.track_id,
      attendance_mode: candidate.attendance_mode ?? null,
      speaker_role: candidate.speaker_role ?? null,
    });
    if (!ok) continue;

    const subjectId = subjectType === "sponsor" ? str(session.sponsor_id) : subjectType === "speaker" ? candidate.person_id : session.id;
    const instance = await materialiseInstance(app, def, {
      subject_type: subjectType,
      subject_id: subjectId,
      assignee_person_id: candidate.person_id,
      session_id: session.id,
      sponsor_id: subjectType === "sponsor" ? str(session.sponsor_id) : null,
      event_start: eventStart,
      session_start: sessionStart,
    });
    if (instance) created.push(instance);
  }
  return created;
}

/** Every active definition matching `trigger`, against one session. */
export async function materialiseForSession(
  app: AppContext,
  session: SessionRow,
  trigger: TaskTrigger,
  opts: { onlyPersonId?: string | null } = {},
): Promise<Row[]> {
  const defs = await app.db.select<Row>("task_definition", { event_id: session.event_id, status: "active", trigger });
  if (defs.length === 0) return [];
  const speakers = speakerCandidatesOf(await liveSpeakers(app, session.id));
  const submitterPersonId = await submitterOf(app, session);

  const created: Row[] = [];
  for (const def of defs.sort((a, b) => num(a.sort_order) - num(b.sort_order))) {
    created.push(...(await materialiseOneDefinitionForSession(app, def, session, speakers, { onlyPersonId: opts.onlyPersonId, submitterPersonId })));
  }
  return created;
}

/**
 * `subject_type = speaker`, `assignee_rule = each_participant` — the
 * roster-level case that needs no session (INV-07-12).
 */
export async function materialiseForParticipant(app: AppContext, eventId: string, personId: string, trigger: TaskTrigger): Promise<Row[]> {
  const defs = await app.db.select<Row>("task_definition", { event_id: eventId, status: "active", trigger });
  if (defs.length === 0) return [];
  const eventStart = await eventStartOf(app, eventId);
  const created: Row[] = [];
  for (const def of defs) {
    if (str(def.assignee_rule) !== "each_participant") continue;
    const subjectType = str(def.subject_type) as TaskSubjectType;
    const instance = await materialiseInstance(app, def, {
      subject_type: subjectType,
      subject_id: personId,
      assignee_person_id: personId,
      session_id: null,
      sponsor_id: null,
      event_start: eventStart,
      session_start: null,
    });
    if (instance) created.push(instance);
  }
  return created;
}

/**
 * `trigger = on_task_completed` — a definition that materialises once another
 * task in the same subject scope closes, named by `trigger_task_key`.
 */
export async function materialiseChained(app: AppContext, completed: Row): Promise<Row[]> {
  const defs = await app.db.select<Row>("task_definition", {
    event_id: str(completed.event_id),
    status: "active",
    trigger: "on_task_completed",
    trigger_task_key: str(completed.definition_key),
  });
  if (defs.length === 0) return [];

  const created: Row[] = [];
  if (completed.session_id) {
    const session = await getSession(app, str(completed.session_id));
    const speakers = speakerCandidatesOf(await liveSpeakers(app, session.id));
    const submitterPersonId = await submitterOf(app, session);
    for (const def of defs) {
      created.push(...(await materialiseOneDefinitionForSession(app, def, session, speakers, { submitterPersonId })));
    }
  } else {
    const eventStart = await eventStartOf(app, str(completed.event_id));
    for (const def of defs) {
      const instance = await materialiseInstance(app, def, {
        subject_type: str(def.subject_type) as TaskSubjectType,
        subject_id: str(completed.subject_id),
        assignee_person_id: str(completed.assignee_person_id),
        session_id: null,
        sponsor_id: strOrNull(completed.sponsor_id),
        event_start: eventStart,
        session_start: null,
      });
      if (instance) created.push(instance);
    }
  }
  return created;
}

/** The organizer's explicit, audited "re-materialise" command (INV-07-1). */
export async function rematerialiseDefinition(app: AppContext, def: Row): Promise<number> {
  const subjectType = str(def.subject_type) as TaskSubjectType;
  let created = 0;
  if (subjectType === "session" || subjectType === "sponsor") {
    const sessions = await app.db.select<SessionRow>("session", { event_id: str(def.event_id) });
    for (const session of sessions) {
      if (str(session.status) === "cancelled") continue;
      const speakers = speakerCandidatesOf(await liveSpeakers(app, session.id));
      const submitterPersonId = await submitterOf(app, session);
      created += (await materialiseOneDefinitionForSession(app, def, session, speakers, { submitterPersonId })).length;
    }
  } else {
    const participants = await app.db.select<Row>("event_participant", { event_id: str(def.event_id), status: "confirmed" });
    const eventStart = await eventStartOf(app, str(def.event_id));
    for (const p of participants) {
      const instance = await materialiseInstance(app, def, {
        subject_type: subjectType,
        subject_id: str(p.person_id),
        assignee_person_id: str(p.person_id),
        session_id: null,
        sponsor_id: null,
        event_start: eventStart,
        session_start: null,
      });
      if (instance) created++;
    }
  }
  return created;
}

/** Unblocks instances whose `depends_on_task_keys` are now satisfied. */
export async function unblockDependents(app: AppContext, completed: Row): Promise<number> {
  const candidates = await app.db.select<Row>("task_instance", {
    subject_type: str(completed.subject_type),
    subject_id: str(completed.subject_id),
    assignee_person_id: str(completed.assignee_person_id),
    status: "blocked",
  });
  let unblocked = 0;
  for (const c of candidates) {
    const def = await app.db.byId<Row>("task_definition", str(c.definition_id));
    const depKeys = parseJson<string[]>(def?.depends_on_task_keys, []);
    if (!depKeys.includes(str(completed.definition_key))) continue;
    const ok = await depsSatisfied(app, depKeys, str(c.subject_type), str(c.subject_id), str(c.assignee_person_id));
    if (!ok) continue;
    await app.db.update("task_instance", str(c.id), { status: "not_started", updated_at: app.now() });
    unblocked++;
  }
  return unblocked;
}

/** INV-07-11 — moving a session's placement recomputes `relative_to_session_start` due dates. */
export async function recomputeSessionStartDueDates(app: AppContext, sessionId: string, sessionStart: Instant | null): Promise<number> {
  const rows = await app.db.raw<Row>(
    `SELECT ti.id, ti.definition_id, ti.status FROM task_instance ti
       JOIN task_definition td ON td.id = ti.definition_id
      WHERE ti.session_id = ? AND td.due_rule = 'relative_to_session_start'`,
    [sessionId],
  );
  let updated = 0;
  for (const r of rows) {
    if (isTerminalTask(str(r.status) as TaskInstanceStatus)) continue;
    const def = await app.db.byId<Row>("task_definition", str(r.definition_id));
    if (!def) continue;
    const dueAt = resolveDueAt("relative_to_session_start", parseJson<DueValue>(def.due_value, {}), {
      session_start: sessionStart,
      assigned_at: app.now(),
    });
    await app.db.update("task_instance", str(r.id), { due_at: dueAt, updated_at: app.now() });
    updated++;
  }
  return updated;
}

/**
 * Speaker substitution transfers the outgoing speaker's incomplete instances
 * to the incoming one, in the same transaction as the replacement (Program's
 * `replaceSpeaker`). A repoint that would collide with an instance the
 * incoming speaker already holds (INV-07-2) is left on the outgoing person.
 */
export async function transferInstances(app: AppContext, sessionId: string, fromPersonId: string, toPersonId: string): Promise<number> {
  const rows = await app.db.select<Row>("task_instance", { session_id: sessionId, assignee_person_id: fromPersonId });
  let transferred = 0;
  const now = app.now();
  for (const r of rows) {
    if (isTerminalTask(str(r.status) as TaskInstanceStatus)) continue;
    try {
      await app.db.rawRun("UPDATE task_instance SET assignee_person_id = ?, updated_at = ? WHERE id = ? AND assignee_person_id = ?", [
        toPersonId,
        now,
        str(r.id),
        fromPersonId,
      ]);
      transferred++;
    } catch {
      // The incoming speaker already has their own instance for this
      // definition (INV-07-2's unique index refused the repoint).
    }
  }
  return transferred;
}
