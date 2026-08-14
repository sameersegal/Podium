/**
 * Program — the admin board (`/admin/events/:eventId/sessions`), the session
 * detail screen (`/admin/sessions/:sessionId`), the speaker's own
 * `/portal/sessions`, and the `/v1/sessions` management API.
 *
 * The `Session` aggregate itself lives in `service.ts`; this module resolves
 * the request, checks authorization, and renders.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { onboardingProgress, type TaskInstanceStatus } from "@podiumstack/domain/onboarding/types.js";
import type { SpeakerRole } from "@podiumstack/domain/program/types.js";
import { forbidden, notFound, validationError } from "@podiumstack/domain/shared/errors.js";
import { redactList } from "@podiumstack/domain/shared/pii.js";
import { expectedVersion, staleWriteRedirect } from "../../http/concurrency.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { transferInstances } from "../onboarding/materialise.js";
import { adminPage, loadEvent, portalPage, type EventRef } from "../../ui/shell.js";
import { pageOf, pageRequest } from "../identity/listing.js";
import { blockingTasksOutstanding } from "../scheduling/program-link.js";
import {
  addRelation,
  addSpeaker,
  approveContent,
  attachAsset,
  cancelSession,
  confirmSpeaker,
  createProgramItem,
  createSponsorSession,
  declineSpeaker,
  getSession,
  isContentDiverged,
  liveSpeakers,
  listRelations,
  listRevisions,
  listSessionAssets,
  removeSpeaker,
  replaceSpeaker,
  requestContentChanges,
  restoreRevision,
  sessionIsSponsored,
  submitContentForReview,
  updateSessionContent,
  type SessionRow,
} from "./service.js";
import {
  boardFiltersFrom,
  loadBoard,
  newSessionFormView,
  portalSessionDetailView,
  programBoardView,
  sessionDetailView,
} from "./views.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

export function registerProgramRoutes(router: Router<RequestContext>): void {
  registerBoardRoutes(router);
  registerSessionDetailRoutes(router);
  registerPortalRoutes(router);
  registerManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                            */
/* -------------------------------------------------------------------------- */

async function requireEvent(ctx: RequestContext, idOrSlug: string): Promise<EventRef> {
  const event = await loadEvent(ctx, idOrSlug);
  if (!event) throw notFound("Event", idOrSlug);
  ctx.eventId = event.id;
  return event;
}

/** Resolve the event a session belongs to, and set `ctx.eventId` for the authz target. */
async function loadSessionAndEvent(ctx: RequestContext, sessionId: string): Promise<{ session: SessionRow; event: EventRef }> {
  const app0 = ctx.app();
  const session = await getSession(app0, sessionId);
  const event = await requireEvent(ctx, str(session.event_id));
  return { session, event };
}

function speakersFromInput(input: Input): { full_name?: string; email?: string; speaker_role?: SpeakerRole }[] {
  const full_name = input.optional("speaker_full_name");
  const email = input.optional("speaker_email");
  if (!full_name && !email) return [];
  return [{ full_name: full_name ?? undefined, email: email ?? undefined, speaker_role: "primary" }];
}

/**
 * `SessionSpeaker` substitution transfers the outgoing speaker's incomplete
 * task instances (INV-06-10, INV-07-8), in the same transaction as the
 * replacement. The transfer itself is Onboarding's rule, so Program calls its
 * command rather than reaching into `task_instance` — which is also what keeps
 * INV-07-2's collision case (the incoming speaker already holds that
 * definition) handled in the one place that knows about it.
 */
const transferTaskInstances = transferInstances;

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/sessions                                            */
/* -------------------------------------------------------------------------- */

function registerBoardRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/sessions", async (_req, ctx, params) => {
    const event = await requireEvent(ctx, params.eventId);
    ctx.requireRead("session.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const filters = boardFiltersFrom(ctx.url);
    const { rows, health, tracks, formats } = await loadBoard(app, event.id, filters);
    const canWrite = ctx.canWrite("session.manage", { event_id: event.id });
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Sessions · ${event.name}`, event, active: "sessions", width: "wide" },
        programBoardView({ event, rows, filters, health, tracks, formats, canWrite }),
      ),
    );
  });

  router.get("/admin/events/:eventId/sessions/new", async (_req, ctx, params) => {
    const event = await requireEvent(ctx, params.eventId);
    ctx.requireWrite("session.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const [tracks, formats, sponsors] = await Promise.all([
      app.db.select<Row>("track", { event_id: event.id }, { orderBy: "sort_order, name" }),
      app.db.select<Row>("session_format", { event_id: event.id }, { orderBy: "sort_order, name" }),
      app.db.raw<Row>(
        `SELECT s.* FROM sponsor s JOIN sponsorship sp ON sp.sponsor_id = s.id
          WHERE sp.event_id = ? AND sp.status = 'confirmed' AND s.deleted_at IS NULL`,
        [event.id],
      ),
    ]);
    return htmlResponse(
      adminPage(ctx, { title: "New session", event, active: "sessions" }, newSessionFormView({ event, tracks, formats, sponsors })),
    );
  });

  router.post("/admin/events/:eventId/sessions/new", async (req, ctx, params) => {
    const event = await requireEvent(ctx, params.eventId);
    ctx.requireWrite("session.manage", { event_id: event.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const origin = input.str("origin", "organizer");
    const common = {
      event_id: event.id,
      title: input.str("title"),
      subtitle: input.optional("subtitle"),
      description: input.optional("description"),
      session_format_id: input.str("session_format_id"),
      track_id: input.optional("track_id"),
      duration_minutes: input.int("duration_minutes", 30) ?? 30,
      speakers: speakersFromInput(input),
    };
    const session =
      origin === "sponsor"
        ? await createSponsorSession(app, { ...common, abstract: input.str("abstract"), sponsor_id: input.str("sponsor_id") })
        : await createProgramItem(app, { ...common, abstract: input.optional("abstract") ?? "" });
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Session created."));
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/sessions/:sessionId                                                 */
/* -------------------------------------------------------------------------- */

async function speakersWithNames(app: AppContext, sessionId: string): Promise<(Row & { name: string })[]> {
  const rows = await app.db.raw<Row>(
    `SELECT ss.*, p.full_name, p.display_name FROM session_speaker ss JOIN person p ON p.id = ss.person_id
      WHERE ss.session_id = ? AND ss.confirmation_status NOT IN ('replaced', 'withdrawn')
      ORDER BY ss.sort_order`,
    [sessionId],
  );
  return rows.map((r) => ({ ...r, name: str(r.display_name) || str(r.full_name) }));
}

async function loadPlacement(app: AppContext, sessionId: string): Promise<Row | null> {
  const rows = await app.db.raw<Row>(
    `SELECT pl.*, r.name AS room_name, d.label AS day_label, d.date AS day_date
       FROM placement pl JOIN room r ON r.id = pl.room_id JOIN event_day d ON d.id = pl.event_day_id
      WHERE pl.session_id = ?`,
    [sessionId],
  );
  return rows[0] ?? null;
}

function registerSessionDetailRoutes(router: Router<RequestContext>): void {
  router.get("/admin/sessions/:sessionId", async (_req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireRead("session.manage", { event_id: event.id, session_id: session.id });
    const app = ctx.app(event.id);

    const [tracks, formats, speakers, relationRows, otherSessions, assets, revisions, diverged, blocking, placement, tasks] =
      await Promise.all([
        app.db.select<Row>("track", { event_id: event.id }, { orderBy: "sort_order, name" }),
        app.db.select<Row>("session_format", { event_id: event.id }, { orderBy: "sort_order, name" }),
        speakersWithNames(app, session.id),
        listRelations(app, session.id),
        app.db.select<Row>("session", { event_id: event.id }, { orderBy: "reference" }),
        listSessionAssets(app, session.id),
        listRevisions(app, session.id),
        isContentDiverged(app, session),
        blockingTasksOutstanding(app, session.id),
        loadPlacement(app, session.id),
        app.db.select<Row>("task_instance", { session_id: session.id }),
      ]);

    const track = session.track_id ? await app.db.byId<Row>("track", session.track_id) : null;
    const format = await app.db.byId<Row>("session_format", session.session_format_id);
    const sponsor = session.sponsor_id ? await app.db.byId<Row>("sponsor", session.sponsor_id) : null;
    const relatedTitleOf = new Map(otherSessions.map((s) => [str(s.id), str(s.title)]));
    const relations = relationRows.map((r) => ({ ...r, related_title: relatedTitleOf.get(str(r.related_session_id)) ?? str(r.related_session_id) }));

    const progress = onboardingProgress(
      tasks.map((t) => ({ status: str(t.status) as TaskInstanceStatus, is_blocking: bool(t.is_blocking), is_required: bool(t.is_required) })),
    );

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(session.title) || session.reference, event, active: "sessions", width: "wide" },
        sessionDetailView({
          event,
          session,
          content_diverged: diverged,
          track,
          format,
          sponsor,
          tracks,
          formats,
          speakers,
          relations,
          otherSessions: otherSessions.filter((s) => str(s.id) !== session.id),
          assets,
          revisions,
          onboarding_progress: progress,
          blocking_tasks_outstanding: blocking,
          placement,
          canWrite: ctx.canWrite("session.manage", { event_id: event.id, session_id: session.id }),
          canApprove: ctx.canWrite("session.approve_content", { event_id: event.id, session_id: session.id }),
          canRestore: ctx.canWrite("session.restore_revision", { event_id: event.id, session_id: session.id }),
        }),
      ),
    );
  });

  router.post("/admin/sessions/:sessionId", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    const patch: Record<string, unknown> = {};
    for (const f of ["title", "subtitle", "abstract", "description", "session_format_id", "track_id", "duration_minutes", "audience_level", "language", "visibility"]) {
      if (input.has(f)) patch[f] = f === "duration_minutes" ? input.int(f) : input.optional(f) ?? input.str(f);
    }
    try {
      // INV-11-14. The highest-stakes of the versioned forms: an organizer and
      // a speaker editing one abstract is the collision this catches, and a
      // silent overwrite here loses prose nobody can reconstruct.
      await updateSessionContent(app, session.id, patch, {
        change_kind: "organizer_edit",
        expected_version: expectedVersion(input),
      });
    } catch (err) {
      const stale = await staleWriteRedirect(err, app, `/admin/sessions/${session.id}`);
      if (stale) return stale;
      throw err;
    }
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Content saved."));
  });

  router.post("/admin/sessions/:sessionId/submit-for-review", async (_req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const app = ctx.app(event.id);
    await submitContentForReview(app, session.id);
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Submitted for review."));
  });

  router.post("/admin/sessions/:sessionId/approve-content", async (_req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.approve_content", { event_id: event.id, session_id: session.id });
    const app = ctx.app(event.id);
    await approveContent(app, session.id);
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Content approved."));
  });

  router.post("/admin/sessions/:sessionId/request-content-changes", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.approve_content", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await requestContentChanges(app, session.id, input.str("note"));
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Sent back for changes."));
  });

  router.post("/admin/sessions/:sessionId/restore/:revisionId", async (_req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.restore_revision", { event_id: event.id, session_id: session.id });
    const app = ctx.app(event.id);
    await restoreRevision(app, session.id, params.revisionId);
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Revision restored — a new revision was written forward."));
  });

  router.post("/admin/sessions/:sessionId/cancel", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await cancelSession(app, session.id, input.str("reason"));
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Session cancelled."));
  });

  router.post("/admin/sessions/:sessionId/speakers", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await addSpeaker(app, session.id, {
      full_name: input.optional("full_name") ?? undefined,
      email: input.optional("email") ?? undefined,
      speaker_role: (input.optional("speaker_role") as SpeakerRole) ?? undefined,
      override_reason: input.optional("override_reason"),
    });
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Speaker added."));
  });

  router.post("/admin/sessions/:sessionId/speakers/:personId/remove", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await removeSpeaker(app, session.id, params.personId, input.str("reason"));
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Speaker removed."));
  });

  router.post("/admin/sessions/:sessionId/speakers/:personId/replace", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await replaceSpeaker(
      app,
      session.id,
      params.personId,
      { full_name: input.optional("full_name") ?? undefined, email: input.optional("email") ?? undefined },
      transferTaskInstances,
    );
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Speaker replaced."));
  });

  router.post("/admin/sessions/:sessionId/speakers/:personId/confirm", async (_req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const app = ctx.app(event.id);
    await confirmSpeaker(app, session.id, params.personId);
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Confirmed on their behalf."));
  });

  router.post("/admin/sessions/:sessionId/relations", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await addRelation(app, session.id, input.str("related_session_id"), input.str("relation"));
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Linked."));
  });

  router.post("/admin/sessions/:sessionId/assets", async (req, ctx, params) => {
    const { session, event } = await loadSessionAndEvent(ctx, params.sessionId);
    ctx.requireWrite("session.manage", { event_id: event.id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(event.id);
    await attachAsset(app, session.id, { asset_id: input.str("asset_id"), kind: input.str("kind", "other"), is_public: input.bool("is_public") });
    await app.flush();
    return redirect(`/admin/sessions/${session.id}`, 303, OK("Attached."));
  });
}

/* -------------------------------------------------------------------------- */
/* /portal/sessions                                                           */
/* -------------------------------------------------------------------------- */

function registerPortalRoutes(router: Router<RequestContext>): void {
  // R13 — a speaker's proposals and sessions are one list, at `/portal`. This
  // URL is in the model's URL map and in email already sent, so it lands there
  // rather than 404ing.
  router.get("/portal/sessions", async (_req, ctx) => {
    ctx.requirePerson();
    return redirect("/portal", 303);
  });

  router.get("/portal/sessions/:sessionId", async (_req, ctx, params) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const session = await getSession(app, params.sessionId);
    ctx.eventId = str(session.event_id);
    const mine = await app.db.first<Row>("session_speaker", { session_id: session.id, person_id: person.id });
    if (!mine || ["withdrawn", "replaced"].includes(str(mine.confirmation_status))) {
      throw forbidden("You are not credited on this session.");
    }
    const speakers = await speakersWithNames(app, session.id);
    const coSpeakers = speakers.filter((s) => str(s.person_id) !== person.id);
    const tasks = await app.db.select<Row>("task_instance", { session_id: session.id, assignee_person_id: person.id }, { orderBy: "due_at" });
    const placement = await loadPlacement(app, session.id);
    return htmlResponse(
      portalPage(
        ctx,
        { title: str(session.title), active: "sessions" },
        portalSessionDetailView({
          session,
          myPersonId: person.id,
          myStatus: str(mine.confirmation_status),
          coSpeakers,
          tasks,
          placement,
        }),
      ),
    );
  });

  router.post("/portal/sessions/:sessionId/confirm", async (_req, ctx, params) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const session = await getSession(app, params.sessionId);
    const mine = await app.db.first<Row>("session_speaker", { session_id: session.id, person_id: person.id });
    if (!mine) throw forbidden("You are not credited on this session.");
    await confirmSpeaker(app, session.id, person.id);
    await app.flush();
    return redirect(`/portal/sessions/${session.id}`, 303, OK("Thanks — you're confirmed."));
  });

  router.post("/portal/sessions/:sessionId/decline", async (req, ctx, params) => {
    const person = ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();
    const session = await getSession(app, params.sessionId);
    const mine = await app.db.first<Row>("session_speaker", { session_id: session.id, person_id: person.id });
    if (!mine) throw forbidden("You are not credited on this session.");
    await declineSpeaker(app, session.id, person.id, input.str("reason", "No reason given."));
    await app.flush();
    return redirect(`/portal/sessions/${session.id}`, 303, OK("Recorded — thanks for letting us know."));
  });
}

/* -------------------------------------------------------------------------- */
/* Management API — /v1/sessions                                              */
/* -------------------------------------------------------------------------- */

function sessionJson(row: Row, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: str(row.id),
    event_id: str(row.event_id),
    proposal_id: strOrNull(row.proposal_id),
    reference: str(row.reference),
    origin: str(row.origin),
    title: str(row.title),
    subtitle: strOrNull(row.subtitle),
    abstract: str(row.abstract),
    description: strOrNull(row.description),
    session_format_id: str(row.session_format_id),
    track_id: strOrNull(row.track_id),
    duration_minutes: num(row.duration_minutes),
    audience_level: strOrNull(row.audience_level),
    language: strOrNull(row.language),
    sponsor_id: strOrNull(row.sponsor_id),
    is_sponsored_content: sessionIsSponsored(row), // D, INV-11-6
    recording_consent: str(row.recording_consent),
    recording_url: strOrNull(row.recording_url),
    slides_asset_id: strOrNull(row.slides_asset_id),
    status: str(row.status),
    content_status: str(row.content_status),
    visibility: str(row.visibility),
    cancellation_reason: strOrNull(row.cancellation_reason),
    published_at: strOrNull(row.published_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    row_version: num(row.row_version, 1),
    ...extra,
  };
}

function registerManagementApi(router: Router<RequestContext>): void {
  router.get("/v1/sessions", async (_req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id");
    ctx.requireRead("session.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const { limit, cursor } = pageRequest(ctx.url);
    const params: unknown[] = [];
    let sql = "SELECT * FROM session WHERE deleted_at IS NULL";
    if (eventId) {
      sql += " AND event_id = ?";
      params.push(eventId);
    }
    const status = ctx.url.searchParams.get("status");
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    if (cursor) {
      sql += " AND id > ?";
      params.push(cursor);
    }
    sql += ` ORDER BY id LIMIT ${limit + 1}`;
    const rows = await app.db.raw<Row>(sql, params);
    const page = pageOf(rows, limit);

    // The names behind the ids, in one pass. `sessionJson` is the entity as the
    // API models it, which is right for an integration and unreadable as a
    // table: a programme listing `trk_01J…` in the track column is one nobody
    // can scan. Presentation only — nothing here changes what may be read.
    const trackIds = new Set<string>();
    const formatIds = new Set<string>();
    for (const r of page.data) {
      if (r.track_id) trackIds.add(str(r.track_id));
      if (r.session_format_id) formatIds.add(str(r.session_format_id));
    }
    const inList = (ids: Set<string>) => [...ids].map(() => "?").join(",");
    const [tracks, formats, speakers] = await Promise.all([
      trackIds.size ? app.db.raw<Row>(`SELECT id, name FROM track WHERE id IN (${inList(trackIds)})`, [...trackIds]) : Promise.resolve([]),
      formatIds.size ? app.db.raw<Row>(`SELECT id, name FROM session_format WHERE id IN (${inList(formatIds)})`, [...formatIds]) : Promise.resolve([]),
      page.data.length
        ? app.db.raw<Row>(
            `SELECT ss.session_id, GROUP_CONCAT(COALESCE(pe.display_name, pe.full_name), ', ') AS names
               FROM session_speaker ss JOIN person pe ON pe.id = ss.person_id
              WHERE ss.session_id IN (${page.data.map(() => "?").join(",")}) AND ss.confirmation_status != 'replaced'
              GROUP BY ss.session_id`,
            page.data.map((r) => str(r.id)),
          )
        : Promise.resolve([]),
    ]);
    const trackName = new Map(tracks.map((t) => [str(t.id), str(t.name)]));
    const formatName = new Map(formats.map((f) => [str(f.id), str(f.name)]));
    const speakerNames = new Map(speakers.map((s) => [str(s.session_id), str(s.names)]));

    return json({
      ...page,
      data: page.data.map((r) => ({
        ...sessionJson(r),
        track_name: r.track_id ? (trackName.get(str(r.track_id)) ?? null) : null,
        format_name: r.session_format_id ? (formatName.get(str(r.session_format_id)) ?? null) : null,
        speaker_names: speakerNames.get(str(r.id)) ?? null,
      })),
    });
  });

  router.get("/v1/sessions/:sessionId", async (_req, ctx, params) => {
    const app0 = ctx.app();
    const session = await getSession(app0, params.sessionId);
    ctx.eventId = str(session.event_id);
    ctx.requireRead("session.manage", { event_id: session.event_id, session_id: session.id });
    const app = ctx.app(session.event_id);
    const diverged = await isContentDiverged(app, session);
    return json(sessionJson(session, { content_diverged: diverged }));
  });

  router.get("/v1/sessions/:sessionId/speakers", async (_req, ctx, params) => {
    const app0 = ctx.app();
    const session = await getSession(app0, params.sessionId);
    ctx.eventId = str(session.event_id);
    ctx.requireRead("session.manage", { event_id: session.event_id, session_id: session.id });
    const app = ctx.app(session.event_id);
    const rows = await liveSpeakers(app, session.id);
    const includePii = ctx.includePii({ event_id: session.event_id });
    return json({ data: redactList("SessionSpeaker", rows, { includePii }) });
  });

  router.post("/v1/sessions/:sessionId/speakers", async (req, ctx, params) => {
    const app0 = ctx.app();
    const session = await getSession(app0, params.sessionId);
    ctx.eventId = str(session.event_id);
    ctx.requireWrite("session.manage", { event_id: session.event_id, session_id: session.id });
    const input = await readInput(req);
    const app = ctx.app(session.event_id);
    if (!input.optional("person_id") && !input.optional("email")) {
      throw validationError("Name a person, or give a name and email.", [{ field_key: "email", message: "Required without person_id." }]);
    }
    const personId = await addSpeaker(app, session.id, {
      person_id: input.optional("person_id") ?? undefined,
      full_name: input.optional("full_name") ?? undefined,
      email: input.optional("email") ?? undefined,
      speaker_role: (input.optional("speaker_role") as SpeakerRole) ?? undefined,
      override_reason: input.optional("override_reason"),
    });
    await app.flush();
    return json({ person_id: personId }, { status: 201 });
  });
}
