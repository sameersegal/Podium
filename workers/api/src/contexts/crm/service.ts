/**
 * Speaker CRM — 14-speaker-crm.md.
 *
 * The directory needs no new entity: it *is* `Person` at org scope. What this
 * context adds is the three things that turn a table of people into a working
 * pipeline — a way to save the queries you run repeatedly, a way to track a
 * conversation that has not yet reached a commitment, and a way to move
 * somebody into an event without re-typing them.
 *
 * INV-14-7: this context reads and writes only org-scoped data. It grants no
 * access to any event's proposals, reviews or decisions.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  canMoveCard,
  criteriaIsEmpty,
  DEFAULT_PIPELINE_STAGES,
  describeCriteria,
  daysInStage,
  enteredStageAt,
  isStalled,
  normaliseCriteria,
  normaliseScore,
  segmentShapeProblems,
  stageSetProblems,
  type DirectoryCriteria,
  type SegmentKind,
  type StageKind,
  type StageSpec,
} from "@podiumstack/domain/crm/index.js";
import { DomainError, invariantError, notFound, validationError } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { addParticipant } from "../identity/service.js";

/* -------------------------------------------------------------------------- */
/* The directory                                                               */
/* -------------------------------------------------------------------------- */

export interface DirectoryRow extends Row {
  id: string;
  full_name: string;
  email: string;
  job_title: string | null;
  company: string | null;
  tags: string[];
  event_count: number;
  session_count: number;
  last_activity_at: string | null;
}

/**
 * "Filters compose with AND, and every filtered set is directly actionable."
 * The whole query runs in SQL because the answer feeds a bulk action, and a
 * bulk action over a page of results is a different (wrong) answer.
 */
export async function directory(
  app: AppContext,
  criteria: DirectoryCriteria,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: DirectoryRow[]; total: number }> {
  const c = normaliseCriteria(criteria as Record<string, unknown>);
  const where: string[] = ["p.deleted_at IS NULL", "p.merged_into_person_id IS NULL"];
  const params: unknown[] = [];

  if (c.q) {
    where.push("(p.full_name LIKE ?1q OR p.email LIKE ?1q OR sp.company LIKE ?1q OR sp.bio LIKE ?1q)".replace(/\?1q/g, "?"));
    const like = `%${c.q}%`;
    params.push(like, like, like, like);
  }
  if (c.company) {
    where.push("sp.company LIKE ?");
    params.push(`%${c.company}%`);
  }
  if (c.job_title) {
    where.push("sp.job_title LIKE ?");
    params.push(`%${c.job_title}%`);
  }
  if (c.tag) {
    where.push("p.tags LIKE ?");
    params.push(`%"${c.tag}"%`);
  }
  if (c.custom_field_key) {
    where.push("p.custom_field_values LIKE ?");
    params.push(c.custom_field_value ? `%"${c.custom_field_key}":"${c.custom_field_value}"%` : `%"${c.custom_field_key}"%`);
  }
  if (c.event_id) {
    where.push("EXISTS (SELECT 1 FROM event_participant ep WHERE ep.person_id = p.id AND ep.event_id = ?" + (c.participant_status ? " AND ep.status = ?" : "") + ")");
    params.push(c.event_id);
    if (c.participant_status) params.push(c.participant_status);
  } else if (c.participant_status) {
    where.push("EXISTS (SELECT 1 FROM event_participant ep WHERE ep.person_id = p.id AND ep.status = ?)");
    params.push(c.participant_status);
  }
  if (c.spoken === "yes") {
    where.push(
      "EXISTS (SELECT 1 FROM session_speaker ss JOIN session s ON s.id = ss.session_id WHERE ss.person_id = p.id AND s.status != 'cancelled')",
    );
  }
  if (c.spoken === "no") {
    where.push(
      "NOT EXISTS (SELECT 1 FROM session_speaker ss JOIN session s ON s.id = ss.session_id WHERE ss.person_id = p.id AND s.status != 'cancelled')",
    );
  }
  if (c.last_contacted_before) {
    where.push(
      "NOT EXISTS (SELECT 1 FROM notification_delivery nd WHERE nd.recipient_person_id = p.id AND nd.created_at >= ?)",
    );
    params.push(c.last_contacted_before);
  }

  const clause = where.join(" AND ");
  const rows = await app.db.raw<Row>(
    `SELECT p.*, sp.job_title, sp.company,
            (SELECT COUNT(*) FROM event_participant ep WHERE ep.person_id = p.id) AS event_count,
            (SELECT COUNT(*) FROM session_speaker ss JOIN session s ON s.id = ss.session_id
              WHERE ss.person_id = p.id AND s.status != 'cancelled') AS session_count,
            (SELECT MAX(nd.created_at) FROM notification_delivery nd WHERE nd.recipient_person_id = p.id) AS last_activity_at
       FROM person p
       LEFT JOIN speaker_profile sp ON sp.person_id = p.id
      WHERE ${clause}
      ORDER BY p.full_name
      LIMIT ? OFFSET ?`,
    [...params, opts.limit ?? 100, opts.offset ?? 0],
  );
  const counted = await app.db.raw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM person p LEFT JOIN speaker_profile sp ON sp.person_id = p.id WHERE ${clause}`,
    params,
  );

  return {
    total: num(counted[0]?.n),
    rows: rows.map((r) => ({
      ...r,
      id: str(r.id),
      full_name: str(r.full_name),
      email: str(r.email),
      job_title: strOrNull(r.job_title),
      company: strOrNull(r.company),
      tags: parseJson<string[]>(r.tags, []),
      event_count: num(r.event_count),
      session_count: num(r.session_count),
      last_activity_at: strOrNull(r.last_activity_at),
    })),
  };
}

/** Every distinct company and tag in the directory, for the filter controls. */
export async function directoryFacets(app: AppContext): Promise<{ companies: string[]; tags: string[] }> {
  const companies = await app.db.raw<{ company: string }>(
    `SELECT DISTINCT sp.company AS company FROM speaker_profile sp
       JOIN person p ON p.id = sp.person_id
      WHERE sp.company IS NOT NULL AND sp.company != ''
      ORDER BY sp.company`,
    [],
  );
  const tagRows = await app.db.raw<{ tags: string }>("SELECT tags FROM person WHERE tags IS NOT NULL", []);
  const tags = new Set<string>();
  for (const row of tagRows) for (const t of parseJson<string[]>(row.tags, [])) tags.add(t);
  return { companies: companies.map((c) => str(c.company)), tags: [...tags].sort() };
}

/* -------------------------------------------------------------------------- */
/* Segments                                                                    */
/* -------------------------------------------------------------------------- */

export interface SegmentView extends Row {
  id: string;
  name: string;
  kind: SegmentKind;
  description: string | null;
  criteria: DirectoryCriteria;
  member_person_ids: string[];
  /** Derived (INV-11-6): resolved for `dynamic`, counted for `static`. */
  member_count: number;
  criteria_description: string;
}

export async function listSegments(app: AppContext): Promise<SegmentView[]> {
  const rows = await app.db.select<Row>("contact_segment", {}, { orderBy: "name" });
  return Promise.all(rows.map((row) => hydrateSegment(app, row)));
}

export async function getSegment(app: AppContext, segmentId: string): Promise<SegmentView> {
  const row = await app.db.byId<Row>("contact_segment", segmentId);
  if (!row) throw notFound("Segment", segmentId);
  return hydrateSegment(app, row);
}

async function hydrateSegment(app: AppContext, row: Row): Promise<SegmentView> {
  const kind = str(row.kind) as SegmentKind;
  const criteria = normaliseCriteria(parseJson<Record<string, unknown>>(row.criteria, {}));
  const members = parseJson<string[]>(row.member_person_ids, []);
  const count = kind === "dynamic" ? (await directory(app, criteria, { limit: 1 })).total : members.length;
  return {
    ...row,
    id: str(row.id),
    name: str(row.name),
    kind,
    description: strOrNull(row.description),
    criteria,
    member_person_ids: members,
    member_count: count,
    criteria_description: kind === "dynamic" ? describeCriteria(criteria) : `${members.length} people, chosen by hand`,
  };
}

/** The members of a segment right now — resolved for `dynamic`, frozen for `static`. */
export async function segmentMembers(app: AppContext, segment: SegmentView): Promise<DirectoryRow[]> {
  if (segment.kind === "dynamic") return (await directory(app, segment.criteria, { limit: 500 })).rows;
  if (segment.member_person_ids.length === 0) return [];
  const rows = await app.db.select<Row>("person", { id: segment.member_person_ids }, { orderBy: "full_name" });
  return rows.map((r) => ({
    ...r,
    id: str(r.id),
    full_name: str(r.full_name),
    email: str(r.email),
    job_title: null,
    company: null,
    tags: parseJson<string[]>(r.tags, []),
    event_count: 0,
    session_count: 0,
    last_activity_at: null,
  }));
}

/**
 * INV-14-1 — a segment is `dynamic` (criteria, resolved at read) or `static`
 * (a frozen member list) and never both. The choice is explicit at creation
 * rather than inferred, because getting it wrong fails in both directions: a
 * static list that silently gains a thirteenth member, or a saved query that
 * stops being true tomorrow.
 */
export async function createSegment(
  app: AppContext,
  input: {
    name: string;
    description?: string | null;
    kind: SegmentKind;
    criteria?: DirectoryCriteria | null;
    member_person_ids?: string[] | null;
    visibility?: "private" | "shared";
  },
): Promise<string> {
  const shape = {
    criteria: (input.criteria ?? null) as Record<string, unknown> | null,
    member_person_ids: input.member_person_ids ?? null,
  };
  const problems = segmentShapeProblems(input.kind, shape);
  if (problems.length > 0) throw validationError(problems.join(" "), []);

  const id = newId("ContactSegment");
  const now = app.now();
  await app.db.insert("contact_segment", {
    id,
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    criteria: input.kind === "dynamic" ? JSON.stringify(normaliseCriteria(input.criteria as Record<string, unknown>)) : null,
    member_person_ids: input.kind === "static" ? JSON.stringify(input.member_person_ids ?? []) : null,
    created_by_person_id: app.actor.id ?? "system",
    visibility: input.visibility ?? "shared",
    created_at: now,
    updated_at: now,
  });

  const view = await getSegment(app, id);
  app.events.emit({
    type: "contact_segment.created",
    subject: { type: "segment", id },
    data: { segment_id: id, name: input.name, kind: input.kind, member_count: view.member_count },
  });
  app.audit.record({ action: "contact_segment.create", entity_type: "contact_segment", entity_id: id, after: { name: input.name, kind: input.kind } });
  return id;
}

export async function updateSegment(
  app: AppContext,
  segmentId: string,
  patch: { name?: string; description?: string | null; criteria?: DirectoryCriteria; member_person_ids?: string[]; visibility?: "private" | "shared" },
): Promise<void> {
  const segment = await getSegment(app, segmentId);
  const update: Row = { updated_at: app.now() };
  const changed: string[] = [];
  if (patch.name !== undefined && patch.name !== segment.name) {
    update.name = patch.name;
    changed.push("name");
  }
  if (patch.description !== undefined) {
    update.description = patch.description;
    changed.push("description");
  }
  if (patch.visibility !== undefined) {
    update.visibility = patch.visibility;
    changed.push("visibility");
  }
  if (patch.criteria !== undefined) {
    if (segment.kind !== "dynamic") {
      throw invariantError("INV-14-1", "segment_kind_mismatch", "A static segment holds a member list, not criteria.");
    }
    update.criteria = JSON.stringify(normaliseCriteria(patch.criteria as Record<string, unknown>));
    changed.push("criteria");
  }
  if (patch.member_person_ids !== undefined) {
    if (segment.kind !== "static") {
      throw invariantError("INV-14-1", "segment_kind_mismatch", "A dynamic segment resolves its members; it has no list to edit.");
    }
    update.member_person_ids = JSON.stringify(patch.member_person_ids);
    changed.push("member_person_ids");
  }
  if (changed.length === 0) return;
  await app.db.update("contact_segment", segmentId, update);
  const view = await getSegment(app, segmentId);
  app.events.emit({
    type: "contact_segment.updated",
    subject: { type: "segment", id: segmentId },
    data: { segment_id: segmentId, changed_fields: changed, member_count: view.member_count },
  });
  app.audit.record({ action: "contact_segment.update", entity_type: "contact_segment", entity_id: segmentId, after: { changed } });
}

export async function addToStaticSegment(app: AppContext, segmentId: string, personIds: string[]): Promise<number> {
  const segment = await getSegment(app, segmentId);
  if (segment.kind !== "static") {
    throw invariantError("INV-14-1", "segment_kind_mismatch", "Only a static segment has a list to add to.");
  }
  const merged = [...new Set([...segment.member_person_ids, ...personIds])];
  await updateSegment(app, segmentId, { member_person_ids: merged });
  return merged.length - segment.member_person_ids.length;
}

/**
 * INV-14-1's second half: converting between kinds is an explicit command that
 * records which it was.
 */
export async function convertSegment(app: AppContext, segmentId: string, to: SegmentKind): Promise<void> {
  const segment = await getSegment(app, segmentId);
  if (segment.kind === to) return;
  const now = app.now();
  if (to === "static") {
    const members = await segmentMembers(app, segment);
    await app.db.update("contact_segment", segmentId, {
      kind: "static",
      member_person_ids: JSON.stringify(members.map((m) => m.id)),
      criteria: null,
      updated_at: now,
    });
  } else {
    await app.db.update("contact_segment", segmentId, { kind: "dynamic", criteria: "{}", member_person_ids: null, updated_at: now });
  }
  app.events.emit({
    type: "contact_segment.updated",
    subject: { type: "segment", id: segmentId },
    data: { segment_id: segmentId, changed_fields: ["kind"], member_count: segment.member_count },
  });
  app.audit.record({
    action: "contact_segment.convert",
    entity_type: "contact_segment",
    entity_id: segmentId,
    before: { kind: segment.kind },
    after: { kind: to },
    reason: `Converted from ${segment.kind} to ${to}`,
  });
}

export async function deleteSegment(app: AppContext, segmentId: string): Promise<void> {
  await getSegment(app, segmentId);
  await app.db.hardDelete("contact_segment", { id: segmentId });
  app.audit.record({ action: "contact_segment.delete", entity_type: "contact_segment", entity_id: segmentId });
}

/* -------------------------------------------------------------------------- */
/* Sourcing pipeline                                                           */
/* -------------------------------------------------------------------------- */

export interface PipelineView extends Row {
  id: string;
  name: string;
  status: string;
  stages: (StageSpec & { id: string; card_count: number })[];
}

export async function listPipelines(app: AppContext, filter: { status?: string } = {}): Promise<Row[]> {
  const where: Row = {};
  if (filter.status) where.status = filter.status;
  return app.db.select<Row>("sourcing_pipeline", where, { orderBy: "created_at DESC" });
}

export async function getPipeline(app: AppContext, pipelineId: string): Promise<PipelineView> {
  const row = await app.db.byId<Row>("sourcing_pipeline", pipelineId);
  if (!row) throw notFound("Pipeline", pipelineId);
  const stages = await app.db.select<Row>("pipeline_stage", { pipeline_id: pipelineId }, { orderBy: "sort_order" });
  const counts = await app.db.raw<{ stage_id: string; n: number }>(
    "SELECT stage_id, COUNT(*) AS n FROM prospect_card WHERE pipeline_id = ? GROUP BY stage_id",
    [pipelineId],
  );
  const byStage = new Map(counts.map((c) => [str(c.stage_id), num(c.n)]));
  return {
    ...row,
    id: str(row.id),
    name: str(row.name),
    status: str(row.status),
    stages: stages.map((s) => ({
      id: str(s.id),
      name: str(s.name),
      kind: str(s.kind) as StageKind,
      sort_order: num(s.sort_order),
      wip_limit: s.wip_limit === null ? null : num(s.wip_limit),
      card_count: byStage.get(str(s.id)) ?? 0,
    })),
  };
}

/**
 * INV-14-2 — a pipeline must have at least one `open`, one `won` and one `lost`
 * stage, and terminal semantics come from `kind`, never from the stage's name.
 * "Did we land them" must not depend on string-matching a column header that
 * somebody renamed to "Locked in 🎉".
 */
export async function createPipeline(
  app: AppContext,
  input: { name: string; event_id?: string | null; stages?: StageSpec[] },
): Promise<string> {
  const stages = input.stages?.length ? input.stages : DEFAULT_PIPELINE_STAGES;
  const problems = stageSetProblems(stages);
  if (problems.length > 0) throw invariantError("INV-14-2", "invalid_stage_set", problems.join(" "));

  const id = newId("SourcingPipeline");
  await app.db.insert("sourcing_pipeline", {
    id,
    event_id: input.event_id ?? null,
    name: input.name,
    status: "active",
    created_by_person_id: app.actor.id ?? "system",
    created_at: app.now(),
  });
  await app.db.insertMany(
    "pipeline_stage",
    stages.map((s, i) => ({
      id: newId("PipelineStage"),
      pipeline_id: id,
      name: s.name,
      kind: s.kind,
      sort_order: s.sort_order ?? i,
      wip_limit: s.wip_limit ?? null,
    })),
  );
  app.events.emit({
    type: "sourcing_pipeline.created",
    subject: { type: "pipeline", id },
    event_id: input.event_id ?? null,
    data: { pipeline_id: id, event_id: input.event_id ?? null, name: input.name, stage_names: stages.map((s) => s.name) },
  });
  app.audit.record({ action: "sourcing_pipeline.create", entity_type: "sourcing_pipeline", entity_id: id, after: { name: input.name } });
  return id;
}

export async function setPipelineStatus(app: AppContext, pipelineId: string, status: "active" | "archived"): Promise<void> {
  const pipeline = await getPipeline(app, pipelineId);
  if (pipeline.status === status) return;
  await app.db.update("sourcing_pipeline", pipelineId, { status });
  // Archiving hides the board and stops its nudges; it deletes nothing, because
  // next year's pipeline starts by reading last year's.
  app.audit.record({
    action: "sourcing_pipeline.status_change",
    entity_type: "sourcing_pipeline",
    entity_id: pipelineId,
    before: { status: pipeline.status },
    after: { status },
  });
}

export interface CardView extends Row {
  id: string;
  person_id: string;
  person_name: string;
  person_company: string | null;
  stage_id: string;
  stage_name: string;
  stage_kind: StageKind;
  topic: string | null;
  score: number | null;
  owner_name: string | null;
  next_action_at: string | null;
  entered_stage_at: string;
  days_in_stage: number;
  stalled: boolean;
}

export async function listCards(app: AppContext, pipelineId: string): Promise<CardView[]> {
  const rows = await app.db.raw<Row>(
    `SELECT c.*, p.full_name AS person_name, sp.company AS person_company,
            st.name AS stage_name, st.kind AS stage_kind,
            owner.full_name AS owner_name
       FROM prospect_card c
       JOIN person p ON p.id = c.person_id
       LEFT JOIN speaker_profile sp ON sp.person_id = c.person_id
       JOIN pipeline_stage st ON st.id = c.stage_id
       LEFT JOIN person owner ON owner.id = c.owner_person_id
      WHERE c.pipeline_id = ?
      ORDER BY st.sort_order, c.sort_order`,
    [pipelineId],
  );
  const now = app.now();
  return rows.map((r) => {
    const entered = str(r.entered_stage_at, now);
    return {
      ...r,
      id: str(r.id),
      person_id: str(r.person_id),
      person_name: str(r.person_name),
      person_company: strOrNull(r.person_company),
      stage_id: str(r.stage_id),
      stage_name: str(r.stage_name),
      stage_kind: str(r.stage_kind) as StageKind,
      topic: strOrNull(r.topic),
      score: r.score === null ? null : num(r.score),
      owner_name: strOrNull(r.owner_name),
      next_action_at: strOrNull(r.next_action_at),
      entered_stage_at: entered,
      days_in_stage: daysInStage(entered, now),
      stalled: isStalled(
        { next_action_at: strOrNull(r.next_action_at), entered_stage_at: entered, stage_kind: str(r.stage_kind) as StageKind },
        now,
      ),
    };
  });
}

/** Cards about one person, across every pipeline — shown on their record. */
export async function cardsForPerson(app: AppContext, personId: string): Promise<Row[]> {
  return app.db.raw<Row>(
    `SELECT c.*, pl.name AS pipeline_name, st.name AS stage_name, st.kind AS stage_kind
       FROM prospect_card c
       JOIN sourcing_pipeline pl ON pl.id = c.pipeline_id
       JOIN pipeline_stage st ON st.id = c.stage_id
      WHERE c.person_id = ?
      ORDER BY c.updated_at DESC`,
    [personId],
  );
}

export async function getCard(app: AppContext, cardId: string): Promise<Row> {
  const row = await app.db.byId<Row>("prospect_card", cardId);
  if (!row) throw notFound("Prospect card", cardId);
  return row;
}

export async function cardTransitions(app: AppContext, cardId: string): Promise<Row[]> {
  return app.db.raw<Row>(
    `SELECT t.*, f.name AS from_name, s.name AS to_name, p.full_name AS moved_by_name
       FROM prospect_stage_transition t
       LEFT JOIN pipeline_stage f ON f.id = t.from_stage_id
       JOIN pipeline_stage s ON s.id = t.to_stage_id
       LEFT JOIN person p ON p.id = t.moved_by_person_id
      WHERE t.card_id = ?
      ORDER BY t.created_at DESC`,
    [cardId],
  );
}

/**
 * INV-14-3 — one card per `(pipeline, person)`. Enrolling somebody already on
 * the board moves and annotates the existing card rather than creating a
 * second one.
 */
export async function enrol(
  app: AppContext,
  input: { pipeline_id: string; person_id: string; stage_id?: string | null; topic?: string | null; score?: number | null; rationale?: string | null; owner_person_id?: string | null; next_action_at?: string | null; note?: string | null },
): Promise<string> {
  const pipeline = await getPipeline(app, input.pipeline_id);
  const stage = input.stage_id
    ? pipeline.stages.find((s) => s.id === input.stage_id)
    : pipeline.stages.find((s) => s.kind === "open");
  if (!stage) throw notFound("Pipeline stage", input.stage_id ?? "");

  const existing = await app.db.first<Row>("prospect_card", { pipeline_id: input.pipeline_id, person_id: input.person_id });
  if (existing) {
    await moveCard(app, str(existing.id), stage.id, input.note ?? "Re-enrolled from the directory.");
    return str(existing.id);
  }

  const id = newId("ProspectCard");
  const now = app.now();
  await app.db.insert("prospect_card", {
    id,
    pipeline_id: input.pipeline_id,
    stage_id: stage.id,
    person_id: input.person_id,
    event_id: strOrNull(pipeline.event_id),
    topic: input.topic ?? null,
    score: normaliseScore(input.score),
    rationale: input.rationale ?? null,
    owner_person_id: input.owner_person_id ?? app.actor.id ?? null,
    next_action_at: input.next_action_at ?? null,
    sort_order: 0,
    entered_stage_at: now,
    created_by_person_id: app.actor.id ?? "system",
    created_at: now,
    updated_at: now,
  });
  // INV-14-4: enrolment is itself a transition, with `from` null.
  await app.db.insert("prospect_stage_transition", {
    id: newId("ProspectStageTransition"),
    card_id: id,
    from_stage_id: null,
    to_stage_id: stage.id,
    moved_by_person_id: app.actor.id ?? "system",
    note: input.note ?? "Enrolled from the directory.",
    created_at: now,
  });

  app.events.emit({
    type: "prospect.enrolled",
    subject: { type: "prospect", id },
    event_id: strOrNull(pipeline.event_id),
    // INV-14-6: no rationale, no score commentary, no note bodies leave the org.
    data: { card_id: id, pipeline_id: input.pipeline_id, person_id: input.person_id, stage_id: stage.id, event_id: strOrNull(pipeline.event_id), score: normaliseScore(input.score) },
  });
  app.audit.record({ action: "prospect.enrol", entity_type: "prospect_card", entity_id: id, after: { person_id: input.person_id } });
  return id;
}

/**
 * INV-14-4 — every stage change writes a `ProspectStageTransition`; the set of
 * transitions is the card's history and is never mutated or deleted, and
 * `entered_stage_at` equals the latest transition's `created_at`.
 */
export async function moveCard(app: AppContext, cardId: string, toStageId: string, note?: string | null): Promise<void> {
  const card = await getCard(app, cardId);
  const fromStage = await app.db.byId<Row>("pipeline_stage", str(card.stage_id));
  const toStage = await app.db.byId<Row>("pipeline_stage", toStageId);
  if (!toStage) throw notFound("Pipeline stage", toStageId);
  if (str(toStage.pipeline_id) !== str(card.pipeline_id)) {
    throw new DomainError({ code: "stage_not_in_pipeline", message: "That stage belongs to a different pipeline.", status: 422 });
  }
  if (str(card.stage_id) === toStageId) return;

  const fromKind = str(fromStage?.kind, "open") as StageKind;
  const toKind = str(toStage.kind) as StageKind;
  if (!canMoveCard(fromKind, toKind)) {
    throw new DomainError({
      code: "illegal_transition",
      message: `A card cannot move from a ${fromKind} stage to a ${toKind} stage.`,
      status: 422,
      details: { from: fromKind, to: toKind },
    });
  }

  const now = app.now();
  const previousEntered = str(card.entered_stage_at, now);
  await app.db.insert("prospect_stage_transition", {
    id: newId("ProspectStageTransition"),
    card_id: cardId,
    from_stage_id: str(card.stage_id),
    to_stage_id: toStageId,
    moved_by_person_id: app.actor.id ?? "system",
    note: note ?? null,
    created_at: now,
  });
  await app.db.update("prospect_card", cardId, { stage_id: toStageId, entered_stage_at: now, updated_at: now });

  app.events.emit({
    type: "prospect.stage_changed",
    subject: { type: "prospect", id: cardId },
    event_id: strOrNull(card.event_id),
    data: {
      card_id: cardId,
      from_stage_id: str(card.stage_id),
      to_stage_id: toStageId,
      to_stage_kind: toKind,
      moved_by_person_id: app.actor.id ?? null,
      days_in_previous_stage: daysInStage(previousEntered, now),
    },
  });
  app.audit.record({
    action: "prospect.move",
    entity_type: "prospect_card",
    entity_id: cardId,
    before: { stage_id: str(card.stage_id) },
    after: { stage_id: toStageId },
  });
}

export async function updateCard(
  app: AppContext,
  cardId: string,
  patch: { topic?: string | null; score?: number | null; rationale?: string | null; owner_person_id?: string | null; next_action_at?: string | null },
): Promise<void> {
  await getCard(app, cardId);
  const update: Row = { updated_at: app.now() };
  if (patch.topic !== undefined) update.topic = patch.topic;
  if (patch.score !== undefined) update.score = normaliseScore(patch.score);
  if (patch.rationale !== undefined) update.rationale = patch.rationale;
  if (patch.owner_person_id !== undefined) update.owner_person_id = patch.owner_person_id;
  if (patch.next_action_at !== undefined) update.next_action_at = patch.next_action_at;
  await app.db.update("prospect_card", cardId, update);
}

/* -------------------------------------------------------------------------- */
/* Conversion — from database to event                                         */
/* -------------------------------------------------------------------------- */

/**
 * INV-14-5 — pushing a contact to an event creates an `EventParticipant`
 * referencing the existing `Person`. **Nothing is copied**: the org-level
 * profile stays the single source of truth, so a speaker who updates their bio
 * updates it everywhere, and a company change in 2027 does not silently
 * rewrite what the 2026 programme said.
 *
 * Available from the directory row, the pipeline card and a segment's bulk
 * action — all three run this one command.
 */
export async function pushToEvent(
  app: AppContext,
  input: { person_id: string; event_id: string; kind?: "speaker" | "prospect" | "sponsor_contact" | "staff" | "reviewer" | "other"; card_id?: string | null },
): Promise<string> {
  const participant = await addParticipant(app, {
    event_id: input.event_id,
    person_id: input.person_id,
    kind: input.kind ?? "speaker",
    status: "invited",
    source: "crm_push",
    portal_access: "none",
  });

  if (input.card_id) {
    await app.db.update("prospect_card", input.card_id, {
      outcome_participant_id: str(participant.id),
      updated_at: app.now(),
    });
    app.events.emit({
      type: "prospect.converted",
      subject: { type: "prospect", id: input.card_id },
      event_id: input.event_id,
      data: { card_id: input.card_id, person_id: input.person_id, event_id: input.event_id, participant_id: str(participant.id) },
    });
  }
  app.audit.record({
    action: "prospect.push_to_event",
    entity_type: "event_participant",
    entity_id: str(participant.id),
    after: { person_id: input.person_id, event_id: input.event_id, source: "crm_push" },
  });
  return str(participant.id);
}

/* -------------------------------------------------------------------------- */
/* CRM dashboard                                                               */
/* -------------------------------------------------------------------------- */

export interface CrmDashboard {
  contact_count: number;
  speaker_count: number;
  returning_speaker_count: number;
  event_count: number;
  pipeline_summary: { pipeline_id: string; name: string; open: number; won: number; lost: number }[];
  stalled_cards: CardView[];
  top_companies: { company: string; n: number }[];
  top_topics: { tag: string; n: number }[];
  acquisition_mix: { source: string; n: number }[];
  outreach_volume: { month: string; n: number }[];
}

/**
 * Every counter is derived from its source rows (INV-11-6).
 * `returning_speaker_count` in particular is the number that justifies this
 * context existing, and a stored version of it would be wrong within a week.
 */
export async function crmDashboard(app: AppContext): Promise<CrmDashboard> {
  const [contacts, speakers, returning, events, companies, sources, outreach, pipelines] = await Promise.all([
    app.db.raw<{ n: number }>(
      "SELECT COUNT(*) AS n FROM person WHERE deleted_at IS NULL AND merged_into_person_id IS NULL",
      [],
    ),
    app.db.raw<{ n: number }>(
      `SELECT COUNT(DISTINCT ss.person_id) AS n FROM session_speaker ss
         JOIN session s ON s.id = ss.session_id
        WHERE s.status != 'cancelled'`,
      [],
    ),
    app.db.raw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT ss.person_id FROM session_speaker ss
           JOIN session s ON s.id = ss.session_id
          WHERE s.status != 'cancelled'
          GROUP BY ss.person_id HAVING COUNT(DISTINCT s.event_id) > 1)`,
      [],
    ),
    app.db.raw<{ n: number }>("SELECT COUNT(*) AS n FROM event WHERE deleted_at IS NULL", []),
    app.db.raw<{ company: string; n: number }>(
      `SELECT sp.company AS company, COUNT(*) AS n FROM speaker_profile sp
         JOIN person p ON p.id = sp.person_id
        WHERE sp.company IS NOT NULL AND sp.company != '' AND p.deleted_at IS NULL
        GROUP BY sp.company ORDER BY n DESC LIMIT 10`,
      [],
    ),
    app.db.raw<{ source: string; n: number }>(
      "SELECT source, COUNT(*) AS n FROM event_participant  GROUP BY source ORDER BY n DESC",
      [],
    ),
    app.db.raw<{ month: string; n: number }>(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS n FROM notification_delivery
         GROUP BY month ORDER BY month DESC LIMIT 12`,
      [],
    ),
    app.db.select<Row>("sourcing_pipeline", { status: "active" }),
  ]);

  const tagRows = await app.db.raw<{ tags: string }>("SELECT tags FROM person WHERE tags IS NOT NULL", []);
  const tagCounts = new Map<string, number>();
  for (const row of tagRows) for (const t of parseJson<string[]>(row.tags, [])) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

  const pipelineSummary: CrmDashboard["pipeline_summary"] = [];
  const stalled: CardView[] = [];
  for (const p of pipelines) {
    const cards = await listCards(app, str(p.id));
    pipelineSummary.push({
      pipeline_id: str(p.id),
      name: str(p.name),
      open: cards.filter((c) => c.stage_kind === "open").length,
      won: cards.filter((c) => c.stage_kind === "won").length,
      lost: cards.filter((c) => c.stage_kind === "lost").length,
    });
    stalled.push(...cards.filter((c) => c.stalled));
  }

  return {
    contact_count: num(contacts[0]?.n),
    speaker_count: num(speakers[0]?.n),
    returning_speaker_count: num(returning[0]?.n),
    event_count: num(events[0]?.n),
    pipeline_summary: pipelineSummary,
    stalled_cards: stalled,
    top_companies: companies.map((c) => ({ company: str(c.company), n: num(c.n) })),
    top_topics: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, n]) => ({ tag, n })),
    acquisition_mix: sources.map((s) => ({ source: str(s.source), n: num(s.n) })),
    outreach_volume: outreach.map((o) => ({ month: str(o.month), n: num(o.n) })).reverse(),
  };
}

export { criteriaIsEmpty, describeCriteria, normaliseCriteria, enteredStageAt };
