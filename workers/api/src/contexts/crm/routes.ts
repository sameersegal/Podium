/**
 * Speaker CRM — the directory (`/admin/contacts`), the dashboard, segments,
 * the sourcing-pipeline kanban board, and the `/v1/segments`, `/v1/pipelines`,
 * `/v1/prospects` management API. `/v1/people` is Identity's — the directory
 * is an org-level view over `Person`, not a new entity (14, "The directory").
 *
 * **Authorization.** The matrix in 11-cross-cutting.md now carries the three
 * Speaker CRM rows this context needs: `contact_directory.read` for the
 * directory and dashboard, `segment.manage` for `ContactSegment`, and
 * `pipeline.manage` for the sourcing board. All three are org-scoped, because
 * this context is (INV-14-7) — which is why `track_lead` and `reviewer`, whose
 * grants are event- or track-scoped, appear in none of them. Pushing a contact
 * into an event is not a fourth capability: it creates an `EventParticipant`,
 * so it is gated on `roster.manage` at that event's scope (INV-14-5).
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import type { DirectoryCriteria, SegmentKind } from "@podiumconf/domain/crm/index.js";
import { forbidden, notFound, validationError } from "@podiumconf/domain/shared/errors.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { collectPrefixed, readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { adminPage } from "../../ui/shell.js";
import { listPersonNotes } from "../identity/service.js";
import { pageOf, pageRequest } from "../identity/listing.js";
import {
  addToStaticSegment,
  convertSegment,
  createPipeline,
  createSegment,
  crmDashboard,
  directory,
  directoryFacets,
  enrol,
  getCard,
  cardTransitions,
  getPipeline,
  getSegment,
  listCards,
  listPipelines,
  listSegments,
  moveCard,
  pushToEvent,
  segmentMembers,
  setPipelineStatus,
  updateCard,
  updateSegment,
  type SegmentView,
} from "./service.js";
import {
  cardDetailView,
  dashboardView,
  directoryFiltersFrom,
  directoryView,
  pipelineBoardView,
  pipelineListView,
  pipelineNewFormView,
  segmentDetailView,
  segmentListView,
  segmentNewFormView,
} from "./views.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

function requireStaff(ctx: RequestContext): void {
  if (!ctx.canRead("contact_directory.read")) throw forbidden("The contacts directory is for event staff.");
}

function requireCrmWrite(ctx: RequestContext): void {
  if (!ctx.canWrite("segment.manage")) throw forbidden("You do not have permission to manage contacts.");
}

export function registerCrmRoutes(router: Router<RequestContext>): void {
  registerDirectoryRoutes(router);
  registerSegmentRoutes(router);
  registerPipelineRoutes(router);
  registerManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* /admin/contacts                                                            */
/* -------------------------------------------------------------------------- */

function registerDirectoryRoutes(router: Router<RequestContext>): void {
  router.get("/admin/contacts/dashboard", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const dashboard = await crmDashboard(app);
    return htmlResponse(adminPage(ctx, { title: "Contacts dashboard", active: "contacts" }, dashboardView(dashboard)));
  });

  router.get("/admin/contacts", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const criteria = directoryFiltersFrom(ctx.url);
    const [result, facets, events, segments, pipelines] = await Promise.all([
      directory(app, criteria, { limit: 200 }),
      directoryFacets(app),
      app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" }),
      listSegments(app),
      listPipelines(app, { status: "active" }),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Contacts", active: "contacts", width: "wide" },
        directoryView({
          rows: result.rows,
          total: result.total,
          criteria,
          facets,
          events,
          segments,
          pipelines,
          canWrite: ctx.canWrite("segment.manage"),
        }),
      ),
    );
  });

  router.post("/admin/contacts/bulk", async (req, ctx) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const personIds = input.list("person_id");
    const action = input.str("action");
    const backTo = "/admin/contacts?" + new URLSearchParams(collectPrefixed(input, "criteria.") as Record<string, string>).toString();

    if (personIds.length === 0) {
      return redirect(backTo, 303, { "set-cookie": flashCookie("warn", "Select at least one contact first.") });
    }

    if (action === "add_to_segment") {
      const segmentId = input.str("segment_id");
      if (!segmentId) throw validationError("Choose a segment.", [{ field_key: "segment_id", message: "Required." }]);
      const added = await addToStaticSegment(app, segmentId, personIds);
      await app.flush();
      return redirect(`/admin/segments/${segmentId}`, 303, OK(`Added ${added} contact${added === 1 ? "" : "s"}.`));
    }
    if (action === "enrol_pipeline") {
      const pipelineId = input.str("pipeline_id");
      if (!pipelineId) throw validationError("Choose a pipeline.", [{ field_key: "pipeline_id", message: "Required." }]);
      for (const personId of personIds) await enrol(app, { pipeline_id: pipelineId, person_id: personId });
      await app.flush();
      return redirect(`/admin/pipelines/${pipelineId}`, 303, OK(`Enrolled ${personIds.length} contact${personIds.length === 1 ? "" : "s"}.`));
    }
    if (action === "push_to_event") {
      const eventId = input.str("event_id");
      if (!eventId) throw validationError("Choose an event.", [{ field_key: "event_id", message: "Required." }]);
      ctx.requireWrite("roster.manage", { event_id: eventId }); // INV-14-5
      for (const personId of personIds) await pushToEvent(app, { person_id: personId, event_id: eventId });
      await app.flush();
      return redirect(backTo, 303, OK(`Pushed ${personIds.length} contact${personIds.length === 1 ? "" : "s"} to the event.`));
    }
    if (action === "campaign") {
      // Campaigns are Platform's context (09) and not yet built; this is the
      // handoff point the directory promises — "a link that carries the
      // selection into a campaign" — for whenever it lands.
      return redirect(`/admin/campaigns/new?person_ids=${personIds.join(",")}`, 303);
    }
    throw validationError("Unknown bulk action.", [{ field_key: "action", message: "Choose an action." }]);
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/segments                                                            */
/* -------------------------------------------------------------------------- */

function segmentCriteriaFrom(input: Input): DirectoryCriteria {
  const c: DirectoryCriteria = {};
  for (const key of ["q", "company", "job_title", "tag", "custom_field_key", "custom_field_value", "event_id", "participant_status", "last_contacted_before"] as const) {
    const v = input.optional(key);
    if (v) c[key] = v;
  }
  const spoken = input.optional("spoken");
  if (spoken === "yes" || spoken === "no") c.spoken = spoken;
  return c;
}

function registerSegmentRoutes(router: Router<RequestContext>): void {
  router.get("/admin/segments", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const segments = await listSegments(app);
    return htmlResponse(adminPage(ctx, { title: "Segments", active: "contacts" }, segmentListView(segments, ctx.canWrite("segment.manage"))));
  });

  // Before "/admin/segments/:segmentId" — the literal wins only if it is
  // registered first (http/router.ts).
  router.get("/admin/segments/new", async (_req, ctx) => {
    requireCrmWrite(ctx);
    return htmlResponse(adminPage(ctx, { title: "New segment", active: "contacts", width: "narrow" }, segmentNewFormView()));
  });

  router.post("/admin/segments", async (req, ctx) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const kind = (input.str("kind", "dynamic") || "dynamic") as SegmentKind;
    const id = await createSegment(app, {
      name: input.str("name"),
      description: input.optional("description"),
      kind,
      // INV-14-1: the choice is explicit, made on this form; a `static`
      // segment starts empty and is populated from the directory's checkboxes.
      criteria: kind === "dynamic" ? segmentCriteriaFrom(input) : null,
      member_person_ids: kind === "static" ? [] : null,
      visibility: "shared",
    });
    await app.flush();
    return redirect(`/admin/segments/${id}`, 303, OK("Segment created."));
  });

  router.get("/admin/segments/:segmentId", async (_req, ctx, params) => {
    requireStaff(ctx);
    const app = ctx.app();
    const segment = await getSegment(app, params.segmentId);
    const members = await segmentMembers(app, segment);
    return htmlResponse(
      adminPage(ctx, { title: segment.name, active: "contacts" }, segmentDetailView({ segment, members, canWrite: ctx.canWrite("segment.manage") })),
    );
  });

  router.post("/admin/segments/:segmentId/convert", async (req, ctx, params) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const to = input.str("to") as SegmentKind;
    await convertSegment(app, params.segmentId, to); // INV-14-1
    await app.flush();
    return redirect(`/admin/segments/${params.segmentId}`, 303, OK(`Converted to ${to}.`));
  });

  router.post("/admin/segments/:segmentId", async (req, ctx, params) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    await updateSegment(app, params.segmentId, {
      name: input.optional("name") ?? undefined,
      description: input.has("description") ? input.optional("description") : undefined,
    });
    await app.flush();
    return redirect(`/admin/segments/${params.segmentId}`, 303, OK("Saved."));
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/pipelines                                                           */
/* -------------------------------------------------------------------------- */

async function directoryOptionsFor(app: AppContext): Promise<{ id: string; label: string }[]> {
  const { rows } = await directory(app, {}, { limit: 300 });
  return rows.map((r) => ({ id: r.id, label: `${r.full_name} · ${r.email}` }));
}

function registerPipelineRoutes(router: Router<RequestContext>): void {
  router.get("/admin/pipelines", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const pipelines = await listPipelines(app);
    return htmlResponse(adminPage(ctx, { title: "Sourcing pipelines", active: "contacts" }, pipelineListView(pipelines, ctx.canWrite("pipeline.manage"))));
  });

  // Registered before "/admin/pipelines/:id" — both are three segments, one
  // literal and one dynamic, so the literal must come first (http/router.ts).
  router.get("/admin/pipelines/new", async (_req, ctx) => {
    requireCrmWrite(ctx);
    const app = ctx.app();
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    return htmlResponse(adminPage(ctx, { title: "New pipeline", active: "contacts" }, pipelineNewFormView(events)));
  });

  router.post("/admin/pipelines/new", async (req, ctx) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const id = await createPipeline(app, { name: input.str("name"), event_id: input.optional("event_id") }); // INV-14-2
    await app.flush();
    return redirect(`/admin/pipelines/${id}`, 303, OK("Pipeline created."));
  });

  router.get("/admin/pipelines/:pipelineId", async (_req, ctx, params) => {
    requireStaff(ctx);
    const app = ctx.app();
    const [pipeline, cards, directoryOptions] = await Promise.all([
      getPipeline(app, params.pipelineId),
      listCards(app, params.pipelineId),
      directoryOptionsFor(app),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: pipeline.name, active: "contacts", width: "wide" },
        pipelineBoardView({ pipeline, cards, directoryOptions, canWrite: ctx.canWrite("pipeline.manage") }),
      ),
    );
  });

  router.post("/admin/pipelines/:pipelineId/status", async (req, ctx, params) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const status = input.str("status") as "active" | "archived";
    await setPipelineStatus(app, params.pipelineId, status);
    await app.flush();
    return redirect(`/admin/pipelines/${params.pipelineId}`, 303, OK(status === "archived" ? "Archived." : "Reopened."));
  });

  router.post("/admin/pipelines/:pipelineId/enrol", async (req, ctx, params) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const cardId = await enrol(app, {
      // INV-14-3: enrolling somebody already on the board moves the existing
      // card rather than creating a second one — `enrol` handles that itself.
      pipeline_id: params.pipelineId,
      person_id: input.str("person_id"),
      topic: input.optional("topic"),
      score: input.int("score"),
    });
    await app.flush();
    return redirect(`/admin/pipelines/cards/${cardId}`, 303, OK("Enrolled."));
  });

  router.get("/admin/pipelines/cards/:cardId", async (_req, ctx, params) => {
    requireStaff(ctx);
    const app = ctx.app();
    const card = await getCard(app, params.cardId);
    const pipeline = await getPipeline(app, str(card.pipeline_id));
    const person = await app.db.byId<Row>("person", str(card.person_id));
    if (!person) throw notFound("Person", str(card.person_id));
    const [transitions, notes] = await Promise.all([
      cardTransitions(app, str(card.id)),
      listPersonNotes(app, str(card.person_id), { eventId: strOrNull(card.event_id) }),
    ]);
    return htmlResponse(
      adminPage(
        ctx,
        { title: str(person.full_name), active: "contacts" },
        cardDetailView({
          card,
          pipeline,
          stages: pipeline.stages,
          transitions,
          notes,
          personName: str(person.display_name) || str(person.full_name),
          canWrite: ctx.canWrite("segment.manage"),
        }),
      ),
    );
  });

  router.post("/admin/pipelines/cards/:cardId/move", async (req, ctx, params) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    await moveCard(app, params.cardId, input.str("stage_id"), input.optional("note")); // INV-14-4
    await app.flush();
    return redirect(`/admin/pipelines/cards/${params.cardId}`, 303, OK("Moved."));
  });

  router.post("/admin/pipelines/cards/:cardId/convert", async (_req, ctx, params) => {
    requireCrmWrite(ctx);
    const app = ctx.app();
    const card = await getCard(app, params.cardId);
    const pipeline = await app.db.byId<Row>("sourcing_pipeline", str(card.pipeline_id));
    const eventId = strOrNull(card.event_id) ?? strOrNull(pipeline?.event_id);
    if (!eventId) {
      throw validationError("This card has no event to push to — set one on the card or the pipeline first.", [
        { field_key: "event_id", message: "Required." },
      ]);
    }
    ctx.requireWrite("roster.manage", { event_id: eventId }); // INV-14-5
    await pushToEvent(app, { person_id: str(card.person_id), event_id: eventId, card_id: params.cardId });
    await app.flush();
    return redirect(`/admin/pipelines/cards/${params.cardId}`, 303, OK("Pushed to the event roster."));
  });

  router.post("/admin/pipelines/cards/:cardId", async (req, ctx, params) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    await updateCard(app, params.cardId, {
      topic: input.has("topic") ? input.optional("topic") : undefined,
      score: input.has("score") ? input.int("score") : undefined,
      rationale: input.has("rationale") ? input.optional("rationale") : undefined,
      next_action_at: input.has("next_action_at") ? input.optional("next_action_at") : undefined,
    });
    await app.flush();
    return redirect(`/admin/pipelines/cards/${params.cardId}`, 303, OK("Saved."));
  });
}

/* -------------------------------------------------------------------------- */
/* Management API — /v1/segments, /v1/pipelines, /v1/prospects                */
/* -------------------------------------------------------------------------- */

function segmentJson(s: SegmentView): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    kind: s.kind,
    criteria: s.kind === "dynamic" ? s.criteria : null,
    member_count: s.member_count, // D, INV-11-6
    visibility: str(s.visibility),
    created_at: strOrNull(s.created_at),
    updated_at: strOrNull(s.updated_at),
  };
}

function registerManagementApi(router: Router<RequestContext>): void {
  router.get("/v1/segments", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const { limit, cursor } = pageRequest(ctx.url);
    const segments = await listSegments(app);
    const sliced = segments.filter((s) => !cursor || s.id > cursor).slice(0, limit + 1);
    const page = pageOf(sliced, limit);
    return json({ ...page, data: page.data.map(segmentJson) });
  });

  router.post("/v1/segments", async (req, ctx) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const kind = (input.str("kind", "dynamic") || "dynamic") as SegmentKind;
    const id = await createSegment(app, {
      name: input.str("name"),
      description: input.optional("description"),
      kind,
      criteria: kind === "dynamic" ? input.json<DirectoryCriteria>("criteria", {}) : null,
      member_person_ids: kind === "static" ? input.json<string[]>("member_person_ids", []) : null,
    });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/segments/:segmentId", async (_req, ctx, params) => {
    requireStaff(ctx);
    const app = ctx.app();
    const segment = await getSegment(app, params.segmentId);
    return json(segmentJson(segment));
  });

  router.get("/v1/pipelines", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const { limit, cursor } = pageRequest(ctx.url);
    const rows = await listPipelines(app);
    const sliced = rows.filter((r) => !cursor || str(r.id) > cursor).slice(0, limit + 1);
    return json(pageOf(sliced, limit));
  });

  router.post("/v1/pipelines", async (req, ctx) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const id = await createPipeline(app, { name: input.str("name"), event_id: input.optional("event_id") });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/pipelines/:pipelineId", async (_req, ctx, params) => {
    requireStaff(ctx);
    const app = ctx.app();
    return json(await getPipeline(app, params.pipelineId));
  });

  router.get("/v1/prospects", async (_req, ctx) => {
    requireStaff(ctx);
    const app = ctx.app();
    const { limit, cursor } = pageRequest(ctx.url);
    const pipelineId = ctx.url.searchParams.get("pipeline_id");
    const params: unknown[] = [ctx.orgId];
    let sql = `SELECT c.* FROM prospect_card c JOIN sourcing_pipeline p ON p.id = c.pipeline_id WHERE p.org_id = ?`;
    if (pipelineId) {
      sql += " AND c.pipeline_id = ?";
      params.push(pipelineId);
    }
    if (cursor) {
      sql += " AND c.id > ?";
      params.push(cursor);
    }
    sql += ` ORDER BY c.id LIMIT ${limit + 1}`;
    const rows = await app.db.raw<Row>(sql, params);
    const page = pageOf(rows, limit);
    return json({
      ...page,
      // INV-14-6: cards, notes, scores and rationales are organizer-only; this
      // is a management-API surface behind `ctx.isStaff()`, never a public one.
      data: page.data.map((r) => ({
        id: str(r.id),
        pipeline_id: str(r.pipeline_id),
        stage_id: str(r.stage_id),
        person_id: str(r.person_id),
        event_id: strOrNull(r.event_id),
        topic: strOrNull(r.topic),
        score: r.score === null ? null : num(r.score),
        rationale: strOrNull(r.rationale),
        owner_person_id: strOrNull(r.owner_person_id),
        next_action_at: strOrNull(r.next_action_at),
        entered_stage_at: str(r.entered_stage_at),
        outcome_participant_id: strOrNull(r.outcome_participant_id),
        created_at: str(r.created_at),
        updated_at: str(r.updated_at),
      })),
    });
  });

  router.post("/v1/prospects", async (req, ctx) => {
    requireCrmWrite(ctx);
    const input = await readInput(req);
    const app = ctx.app();
    const id = await enrol(app, {
      pipeline_id: input.str("pipeline_id"),
      person_id: input.str("person_id"),
      topic: input.optional("topic"),
      score: input.int("score"),
      rationale: input.optional("rationale"),
      owner_person_id: input.optional("owner_person_id"),
      next_action_at: input.optional("next_action_at"),
    });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.post("/v1/prospects/:cardId/convert", async (_req, ctx, params) => {
    requireCrmWrite(ctx);
    const app = ctx.app();
    const card = await getCard(app, params.cardId);
    const eventId = strOrNull(card.event_id);
    if (!eventId) throw validationError("This card has no event to push to.", [{ field_key: "event_id", message: "Required." }]);
    ctx.requireWrite("roster.manage", { event_id: eventId });
    const participantId = await pushToEvent(app, { person_id: str(card.person_id), event_id: eventId, card_id: params.cardId });
    await app.flush();
    return json({ participant_id: participantId });
  });
}
