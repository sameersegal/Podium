/**
 * 04 — Submissions: portal (speaker-facing), admin, and management API.
 *
 * Portal (server-rendered):
 *   /portal, /portal/proposals…            the SubmitterDashboard (J3)
 *   /portal/proposals/:id/step/:stepKey    the multi-step wizard
 *
 * Admin: /admin/events/:eventId/proposals, /admin/proposals/:proposalId
 * Management API: /v1/proposals…
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import type { FormSpec } from "@podiumconf/domain/event-config/types.js";
import { DomainError, notFound, validationError } from "@podiumconf/domain/shared/errors.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { fieldByKey, mappedKeys } from "@podiumconf/domain/submissions/answers.js";
import type { Origin } from "@podiumconf/domain/event-config/types.js";
import { flashCookie, type PersonView, type RequestContext } from "../../http/context.js";
import { collectPrefixed, readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Handler, Router } from "../../http/router.js";
import { adminPage, loadEvent, portalPage } from "../../ui/shell.js";
import { cfpFormatOptions, cfpTrackOptions } from "../event-config/views.js";
import { acceptUrlPanel } from "../identity/views.js";
import {
  proposalAdminDetailView,
  proposalQueueView,
  queueFiltersFrom,
  type AdminDetailData,
  type QueuePageData,
} from "./admin-views.js";
import {
  addCoSpeaker,
  answersOf,
  cfpWindow,
  createDraft,
  editAffordance,
  formOf,
  getProposal,
  organizerEdit,
  percentComplete,
  progressOf,
  removeSpeaker,
  requestChanges,
  respondToSpeakerInvitation,
  saveDraft,
  speakersOf,
  submitProposal,
  unsubmitProposal,
  withdrawProposal,
  type ProposalRow,
} from "./service.js";
import {
  dashboardView,
  newProposalPickerView,
  nextAction,
  proposalReadView,
  proposalsListView,
  renderWizardPage,
  resolveStepKey,
  speakerRoster,
  wizardSteps,
  type StepPageData,
} from "./wizard.js";
import { openCallsFor, proposalDetail, proposalQueue, submitterDashboard, submittableEntitlements } from "./views.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });
const WARN = (message: string) => ({ "set-cookie": flashCookie("warn", message) });

/* -------------------------------------------------------------------------- */
/* Portal guard — INV-01: an anonymous visitor is sent to /login?next=…       */
/* -------------------------------------------------------------------------- */

function portalRoute(
  handler: (req: Request, ctx: RequestContext, params: Record<string, string>, person: PersonView) => Promise<Response>,
): Handler<RequestContext> {
  return async (req, ctx, params) => {
    if (!ctx.person) {
      const next = ctx.url.pathname + ctx.url.search;
      return redirect(`/login?next=${encodeURIComponent(next)}`, 303);
    }
    return handler(req, ctx, params, ctx.person);
  };
}

/** Loads a proposal, sets `ctx.eventId`, and requires at least own-level access. */
async function loadOwnProposal(app: AppContext, ctx: RequestContext, proposalId: string): Promise<ProposalRow> {
  const proposal = await getProposal(app, proposalId);
  ctx.eventId = str(proposal.event_id);
  ctx.requireRead("proposal.read_any", { proposal_id: proposal.id, event_id: proposal.event_id });
  return proposal;
}

/** Where a submitter lands on a `Proposal` they may no longer edit. */
function redirectToDetail(proposal: Row, reason: string | undefined, kind: "warn" | "ok" = "warn"): Response {
  return redirect(`/portal/proposals/${str(proposal.id)}`, 303, kind === "warn" ? WARN(reason ?? "This proposal can no longer be edited.") : OK(reason ?? "Saved."));
}

/**
 * `speaker_list` is a real answer (rule 2 requires "an answer" on every
 * required visible field), but the roster it records lives in
 * `ProposalSpeaker`, not something a submitter types. This keeps the two in
 * step whenever the roster changes, exactly like `promoteAnswers` keeps the
 * mapped columns in step with the rest of the answers (04, "Why content is
 * both promoted columns and answers").
 */
async function syncSpeakerAnswer(app: AppContext, proposalId: string, form: FormSpec): Promise<void> {
  const key = mappedKeys(form).speakers;
  if (!key) return;
  const fld = fieldByKey(form, key);
  if (!fld) return;
  const rows = await speakersOf(app, proposalId);
  const ids = rows.filter((r) => str(r.participation_status) !== "removed").map((r) => str(r.person_id));
  const existing = await app.db.first<Row>("proposal_answer", { proposal_id: proposalId, field_key: key });
  const value = JSON.stringify(ids);
  const now = app.now();
  if (existing) await app.db.update("proposal_answer", str(existing.id), { value, answered_at: now });
  else await app.db.insert("proposal_answer", { id: newId("ProposalAnswer"), proposal_id: proposalId, field_key: key, form_field_id: fld.id, value, answered_at: now });
}

const FILE_MAX_BYTES = 25 * 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A `file`-type answer is an `Asset`, uploaded through the Worker (11, "Assets"). */
async function storeProposalAnswerFile(app: AppContext, proposalId: string, personId: string, fieldKey: string, file: File): Promise<{ asset_ids: string[] }> {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) throw new DomainError({ code: "empty_upload", message: "That file was empty.", status: 422 });
  if (buffer.byteLength > FILE_MAX_BYTES) {
    throw new DomainError({ code: "file_too_large", message: "That file is larger than 25 MB.", status: 422 });
  }
  const slotKey = `proposal:${proposalId}:${fieldKey}`;
  const prior = await app.db.raw<Row>(
    "SELECT id, version FROM asset WHERE slot_key = ? AND org_id = ? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    [slotKey, app.orgId],
  );
  const version = num(prior[0]?.version, 0) + 1;
  const id = newId("Asset");
  const filename = (file.name || "upload").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const storageKey = `${app.orgId}/proposal/${proposalId}/${fieldKey}/${version}/${filename}`;
  await app.env.ASSETS_BUCKET.put(storageKey, buffer, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  await app.db.insert("asset", {
    id,
    org_id: app.orgId,
    storage_key: storageKey,
    filename,
    content_type: file.type || "application/octet-stream",
    size_bytes: buffer.byteLength,
    checksum: await sha256Hex(buffer),
    scan_status: "pending", // INV-11-3
    visibility: "private",
    uploaded_by_person_id: personId,
    purpose: "document",
    slot_key: slotKey,
    version,
    supersedes_asset_id: prior[0] ? str(prior[0].id) : null,
    created_at: app.now(),
  });
  app.events.emit({
    type: "asset.uploaded",
    subject: { type: "asset", id },
    data: { asset_id: id, slot_key: slotKey, version, purpose: "document", filename, size_bytes: buffer.byteLength, uploaded_by_person_id: personId },
  });
  return { asset_ids: [id] };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerSubmissionRoutes(router: Router<RequestContext>): void {
  registerPortalRoutes(router);
  registerAdminRoutes(router);
  registerManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* Portal — dashboard, list, read view                                        */
/* -------------------------------------------------------------------------- */

function registerPortalRoutes(router: Router<RequestContext>): void {
  router.get(
    "/portal",
    portalRoute(async (_req, ctx, _params, person) => {
      const dash = await submitterDashboard(ctx.app(), person.id);
      return htmlResponse(portalPage(ctx, { title: "My dashboard", active: "dashboard" }, dashboardView(dash)));
    }),
  );

  router.get(
    "/portal/proposals",
    portalRoute(async (_req, ctx, _params, person) => {
      const dash = await submitterDashboard(ctx.app(), person.id);
      return htmlResponse(portalPage(ctx, { title: "My proposals", active: "proposals" }, proposalsListView(dash.proposals)));
    }),
  );

  router.get(
    "/portal/proposals/new",
    portalRoute(async (_req, ctx, _params, person) => {
      const app = ctx.app();
      const cfps = await openCallsFor(app, person.id, ctx.isStaff());
      const entitlementsByEvent = new Map<string, Row[]>();
      for (const c of cfps) {
        const eventId = str(c.event_id);
        if (!entitlementsByEvent.has(eventId)) entitlementsByEvent.set(eventId, await submittableEntitlements(app, person.id, eventId));
      }
      return htmlResponse(portalPage(ctx, { title: "Start a proposal", active: "proposals" }, newProposalPickerView(cfps, entitlementsByEvent)));
    }),
  );

  router.post(
    "/portal/proposals/new",
    portalRoute(async (req, ctx, _params, person) => {
      const input = await readInput(req);
      const app = ctx.app();
      const cfpId = input.str("cfp_id");
      const eligible = await openCallsFor(app, person.id, ctx.isStaff());
      const cfp = eligible.find((c) => str(c.id) === cfpId);
      if (!cfp) throw notFound("Call for proposals", cfpId); // INV-02-3: not on their eligible list
      ctx.eventId = str(cfp.event_id);

      let origin: Origin = "cfp";
      let sponsorId: string | null = null;
      let entitlementId: string | null = null;
      let isSponsorManager = false;
      const entId = input.optional("entitlement_id");
      if (entId) {
        const rows = await submittableEntitlements(app, person.id, str(cfp.event_id));
        const row = rows.find((r) => str(r.id) === entId);
        if (!row) throw notFound("Entitlement", entId);
        origin = "sponsor";
        sponsorId = str(row.sponsor_id);
        entitlementId = entId;
        isSponsorManager = ctx.canWrite("sponsor.manage", { sponsor_id: sponsorId });
      }

      const proposal = await createDraft(app, {
        cfp_id: cfpId,
        submitter_person_id: person.id,
        origin,
        sponsor_id: sponsorId,
        entitlement_id: entitlementId,
        is_sponsor_manager: isSponsorManager,
      });
      const form = await formOf(app, proposal);
      await syncSpeakerAnswer(app, proposal.id, form);
      await app.flush();
      const steps = wizardSteps(form, await answersOf(app, proposal.id));
      return redirect(`/portal/proposals/${proposal.id}/step/${steps[0]?.key ?? "__review__"}`, 303, OK("Draft created."));
    }),
  );

  router.get(
    "/portal/proposals/:id",
    portalRoute(async (_req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      const window = await cfpWindow(app, str(proposal.cfp_id));
      const affordance = editAffordance(str(proposal.status), { accepts_edit: window.accepts.allowed, allow_edit_after_submit: window.allow_edit_after_submit });
      const includePii = ctx.includePii({ proposal_id: proposal.id });
      const detail = await proposalDetail(app, proposal.id, { includePii, audience: "submitter" });

      let pct = 100;
      if (str(proposal.status) === "draft") {
        const form = await formOf(app, proposal);
        pct = percentComplete(form, await answersOf(app, proposal.id));
      }
      const next = nextAction({
        status: str(proposal.status),
        percent_complete: pct,
        confirmation_deadline: strOrNull(proposal.confirmation_deadline),
        cfp_closes_at: window.closes_at,
        now: ctx.now,
        timezone: detail.event ? str(detail.event.timezone, "UTC") : "UTC",
      });
      return htmlResponse(
        portalPage(
          ctx,
          { title: str(proposal.title) || "Untitled proposal", active: "proposals", width: "wide" },
          proposalReadView(detail, next, affordance.editable),
        ),
      );
    }),
  );

  /* -------------------------------------------------------------------------- */
  /* The wizard                                                                  */
  /* -------------------------------------------------------------------------- */

  router.get(
    "/portal/proposals/:id/step/:stepKey",
    portalRoute(async (_req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      const window = await cfpWindow(app, str(proposal.cfp_id));
      const affordance = editAffordance(str(proposal.status), { accepts_edit: window.accepts.allowed, allow_edit_after_submit: window.allow_edit_after_submit });
      if (!affordance.editable) return redirectToDetail(proposal, affordance.reason);

      const form = await formOf(app, proposal);
      const answers = await answersOf(app, proposal.id);
      const steps = wizardSteps(form, answers);
      const progress = await progressOf(app, proposal.id);
      const wantedStep = resolveStepKey(steps, params.stepKey, progress ? str(progress.current_step_key) : null);
      if (wantedStep !== params.stepKey) return redirect(`/portal/proposals/${proposal.id}/step/${wantedStep}`, 303);
      const current = steps.find((s) => s.key === wantedStep)!;

      const event = (await loadEvent(ctx, str(proposal.event_id)))!;
      const [tracks, formats, speakerRows] = await Promise.all([
        cfpTrackOptions(app, str(proposal.cfp_id), true),
        cfpFormatOptions(app, str(proposal.cfp_id), true),
        speakersOf(app, proposal.id),
      ]);
      const roster = await speakerRoster(app, proposal.id, speakerRows);

      const data: StepPageData = {
        proposal,
        event,
        form,
        answers,
        steps,
        current,
        tracks,
        formats,
        roster,
        fieldErrors: [],
        affordance,
        window,
        clientRevision: num(progress?.client_revision, 0),
        submitterPersonId: str(proposal.submitter_person_id),
        progress,
      };
      return htmlResponse(
        portalPage(ctx, { title: str(proposal.title) || "Untitled proposal", active: "proposals", width: "wide" }, renderWizardPage(data)),
      );
    }),
  );

  router.post(
    "/portal/proposals/:id/step/:stepKey",
    portalRoute(async (req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      const window = await cfpWindow(app, str(proposal.cfp_id));
      const affordance = editAffordance(str(proposal.status), { accepts_edit: window.accepts.allowed, allow_edit_after_submit: window.allow_edit_after_submit });
      if (!affordance.editable) return redirectToDetail(proposal, affordance.reason);
      if (affordance.requires_unsubmit) await unsubmitProposal(app, proposal.id); // submitted --> draft (04, "the way out")

      const input = await readInput(req);
      const form = await formOf(app, proposal);
      const values = collectPrefixed(input, "answer.");
      for (const step of form.steps) {
        for (const f of step.fields) {
          if (f.type !== "file") continue;
          const [file] = input.files(`answer.${f.key}`);
          if (file && file.size > 0) values[f.key] = await storeProposalAnswerFile(app, proposal.id, str(proposal.submitter_person_id), f.key, file);
        }
      }

      // Two submit buttons on every step (04): "Save draft" persists and stays;
      // "Save and continue" persists and advances to `next_step_key`.
      const advancing = input.has("next");
      const nextStepKey = advancing ? input.optional("next_step_key") : null;
      try {
        await saveDraft(app, proposal.id, {
          values,
          step_key: params.stepKey,
          next_step_key: nextStepKey,
          client_revision: input.int("client_revision"),
          mark_step_complete: advancing,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === "stale_draft") {
          await app.flush();
          return redirect(`/portal/proposals/${proposal.id}/step/${params.stepKey}`, 303, WARN(err.message));
        }
        throw err;
      }
      await app.flush();

      const steps = wizardSteps(form, await answersOf(app, proposal.id));
      const target = resolveStepKey(steps, nextStepKey ?? params.stepKey, null);
      return redirect(`/portal/proposals/${proposal.id}/step/${target}`, 303, OK("Saved."));
    }),
  );

  router.post(
    "/portal/proposals/:id/submit",
    portalRoute(async (_req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      try {
        const result = await submitProposal(app, proposal.id);
        await app.flush();
        return redirect(`/portal/proposals/${proposal.id}`, 303, OK(result.resubmitted ? "Resubmitted." : "Submitted. You will hear back once the committee has decided."));
      } catch (err) {
        if (err instanceof DomainError && err.fieldErrors?.length) {
          const window = await cfpWindow(app, str(proposal.cfp_id));
          const affordance = editAffordance(str(proposal.status), { accepts_edit: window.accepts.allowed, allow_edit_after_submit: window.allow_edit_after_submit });
          const form = await formOf(app, proposal);
          const answers = await answersOf(app, proposal.id);
          const steps = wizardSteps(form, answers);
          const current = steps[steps.length - 1];
          const event = (await loadEvent(ctx, str(proposal.event_id)))!;
          const [tracks, formats, speakerRows] = await Promise.all([
            cfpTrackOptions(app, str(proposal.cfp_id), true),
            cfpFormatOptions(app, str(proposal.cfp_id), true),
            speakersOf(app, proposal.id),
          ]);
          const roster = await speakerRoster(app, proposal.id, speakerRows);
          const progress = await progressOf(app, proposal.id);
          const data: StepPageData = {
            proposal,
            event,
            form,
            answers,
            steps,
            current,
            tracks,
            formats,
            roster,
            fieldErrors: err.fieldErrors,
            affordance,
            window,
            clientRevision: num(progress?.client_revision, 0),
            submitterPersonId: str(proposal.submitter_person_id),
            progress,
          };
          return htmlResponse(
            portalPage(ctx, { title: str(proposal.title) || "Untitled proposal", active: "proposals", width: "wide" }, renderWizardPage(data)),
            { status: 422 },
          );
        }
        throw err;
      }
    }),
  );

  router.post(
    "/portal/proposals/:id/withdraw",
    portalRoute(async (req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      const input = await readInput(req);
      await withdrawProposal(app, proposal.id, input.str("reason", "Withdrawn by the submitter."));
      await app.flush();
      return redirect("/portal/proposals", 303, OK("Withdrawn."));
    }),
  );

  router.post(
    "/portal/proposals/:id/speakers",
    portalRoute(async (req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      const input = await readInput(req);
      const base = ctx.env.PUBLIC_BASE_URL || ctx.url.origin;
      const { accept_url, person } = await addCoSpeaker(app, proposal.id, {
        full_name: input.str("full_name"),
        email: input.str("email"),
        base_url: base,
      });
      const form = await formOf(app, proposal);
      await syncSpeakerAnswer(app, proposal.id, form);
      await app.flush();
      // INV-01-15: the one-time accept link is shown on screen, never redirected past.
      return htmlResponse(
        portalPage(
          ctx,
          { title: "Co-speaker added", active: "proposals" },
          acceptUrlPanel(accept_url, str((person as Row).email), `/portal/proposals/${proposal.id}/step/${input.str("redirect_step") || "__review__"}`),
        ),
      );
    }),
  );

  router.post(
    "/portal/proposals/:id/speakers/:personId/remove",
    portalRoute(async (_req, ctx, params) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      await removeSpeaker(app, proposal.id, params.personId);
      const form = await formOf(app, proposal);
      await syncSpeakerAnswer(app, proposal.id, form);
      await app.flush();
      return redirect(`/portal/proposals/${proposal.id}`, 303, OK("Removed."));
    }),
  );

  router.post(
    "/portal/proposals/:id/invitation/accept",
    portalRoute(async (_req, ctx, params, person) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      await respondToSpeakerInvitation(app, proposal.id, person.id, true);
      await app.flush();
      return redirect("/portal", 303, OK("You are now credited as a speaker."));
    }),
  );

  router.post(
    "/portal/proposals/:id/invitation/decline",
    portalRoute(async (_req, ctx, params, person) => {
      const app = ctx.app();
      const proposal = await loadOwnProposal(app, ctx, params.id);
      await respondToSpeakerInvitation(app, proposal.id, person.id, false);
      await app.flush();
      return redirect("/portal", 303, OK("Declined."));
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

function registerAdminRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/proposals", async (_req, ctx, params) => {
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireRead("proposal.read_any", { event_id: event.id });
    const app = ctx.app(event.id);
    const filters = queueFiltersFrom(ctx.url);
    const [{ rows, next_cursor, total }, cfps, tracks, formats] = await Promise.all([
      proposalQueue(app, event.id, filters),
      app.db.select<Row>("call_for_proposals", { event_id: event.id }),
      app.db.select<Row>("track", { event_id: event.id }, { orderBy: "sort_order" }),
      app.db.select<Row>("session_format", { event_id: event.id }, { orderBy: "sort_order" }),
    ]);
    // INV-09-5 / INV-11-4: `Person.email` is PII, redacted without `pii:read`.
    const includePii = ctx.includePii({ event_id: event.id });
    const rowsForView = includePii ? rows : rows.map((r) => ({ ...r, submitter_email: "[redacted]" }));
    const data: QueuePageData = { event, rows: rowsForView, filters, total, nextCursor: next_cursor, url: ctx.url, cfps, tracks, formats };
    return htmlResponse(adminPage(ctx, { title: "Proposals", event, active: "proposals", width: "wide" }, proposalQueueView(data)));
  });

  router.get("/admin/proposals/:proposalId", async (_req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.proposalId);
    ctx.eventId = str(proposal.event_id);
    ctx.requireRead("proposal.read_any", { event_id: proposal.event_id, proposal_id: proposal.id });
    const event = await loadEvent(ctx, str(proposal.event_id));
    if (!event) throw notFound("Event", str(proposal.event_id));
    const includePii = ctx.includePii({ event_id: event.id });
    const detail = await proposalDetail(app, proposal.id, { includePii, audience: "committee" });
    const [tracks, formats] = await Promise.all([
      app.db.select<Row>("track", { event_id: event.id }, { orderBy: "sort_order" }),
      app.db.select<Row>("session_format", { event_id: event.id }, { orderBy: "sort_order" }),
    ]);
    const canEdit = ctx.canWrite("proposal.edit", { event_id: event.id, proposal_id: proposal.id });
    const data: AdminDetailData = { detail, event, tracks, formats, canEdit, fieldErrors: [] };
    return htmlResponse(adminPage(ctx, { title: str(proposal.title) || "Untitled proposal", event, active: "proposals", width: "wide" }, proposalAdminDetailView(data)));
  });

  router.post("/admin/proposals/:proposalId/edit", async (req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.proposalId);
    ctx.eventId = str(proposal.event_id);
    ctx.requireWrite("proposal.edit", { event_id: proposal.event_id, proposal_id: proposal.id });
    const input = await readInput(req);
    const reason = input.str("reason");
    if (!reason) {
      throw validationError("An organizer edit needs a reason.", [{ field_key: "reason", message: "Say what changed and why." }]); // INV-11-5
    }
    const patch = readOrganizerEditInput(input);
    await organizerEdit(app, proposal.id, patch, reason);
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}`, 303, OK("Saved."));
  });

  router.post("/admin/proposals/:proposalId/request-changes", async (req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.proposalId);
    ctx.eventId = str(proposal.event_id);
    ctx.requireWrite("proposal.edit", { event_id: proposal.event_id, proposal_id: proposal.id });
    const input = await readInput(req);
    const note = input.str("note");
    if (!note) throw validationError("Say what needs to change.", [{ field_key: "note", message: "Tell the submitter what to change." }]);
    await requestChanges(app, proposal.id, note);
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}`, 303, OK("Changes requested."));
  });

  router.post("/admin/proposals/:proposalId/withdraw", async (req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.proposalId);
    ctx.eventId = str(proposal.event_id);
    ctx.requireWrite("proposal.edit", { event_id: proposal.event_id, proposal_id: proposal.id });
    const input = await readInput(req);
    await withdrawProposal(app, proposal.id, input.str("reason", "Withdrawn by an organizer."));
    await app.flush();
    return redirect(`/admin/proposals/${proposal.id}`, 303, OK("Withdrawn."));
  });
}

function readOrganizerEditInput(input: Input): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of [
    "title",
    "abstract",
    "description",
    "session_format_id",
    "requested_duration_minutes",
    "track_id",
    "assigned_track_id",
    "audience_level",
    "language",
    "recording_consent",
    "recording_conditions",
    "coi_disclosure",
  ]) {
    if (input.has(f)) patch[f] = input.optional(f);
  }
  if (input.has("keywords")) {
    // A JSON array survives (`organizerEdit` maps it directly); the HTML form
    // posts a single comma-separated string, which `organizerEdit` splits.
    const raw = input.all().keywords;
    patch.keywords = Array.isArray(raw) ? raw : input.optional("keywords");
  }
  return patch;
}

/* -------------------------------------------------------------------------- */
/* Management API — /v1/proposals                                             */
/* -------------------------------------------------------------------------- */

// `Proposal`'s own columns carry no PII (only `ProposalAnswer.value` for a
// `pii`-flagged `FormField` does — handled below, per answer, via `proposalDetail`).
function proposalJson(row: Row, _includePii: boolean): Record<string, unknown> {
  return {
    id: str(row.id),
    org_id: str(row.org_id),
    event_id: str(row.event_id),
    cfp_id: str(row.cfp_id),
    form_id: str(row.form_id),
    reference: str(row.reference),
    origin: str(row.origin),
    submitter_person_id: str(row.submitter_person_id),
    sponsor_id: strOrNull(row.sponsor_id),
    entitlement_id: strOrNull(row.entitlement_id),
    title: str(row.title),
    abstract: str(row.abstract),
    description: strOrNull(row.description),
    session_format_id: strOrNull(row.session_format_id),
    requested_duration_minutes: row.requested_duration_minutes ?? null,
    track_id: strOrNull(row.track_id),
    assigned_track_id: strOrNull(row.assigned_track_id),
    audience_level: strOrNull(row.audience_level),
    keywords: parseJson<string[]>(row.keywords, []),
    language: str(row.language, "en"),
    av_requirements: parseJson<string[]>(row.av_requirements, []),
    recording_consent: str(row.recording_consent, "unanswered"),
    recording_conditions: strOrNull(row.recording_conditions),
    coi_disclosure: strOrNull(row.coi_disclosure),
    status: str(row.status),
    is_late: bool(row.is_late),
    submitted_at: strOrNull(row.submitted_at),
    last_activity_at: str(row.last_activity_at),
    decision_id: strOrNull(row.decision_id),
    confirmation_deadline: strOrNull(row.confirmation_deadline),
    session_id: strOrNull(row.session_id),
    withdrawn_reason: strOrNull(row.withdrawn_reason),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    row_version: num(row.row_version, 1),
  };
}

function registerManagementApi(router: Router<RequestContext>): void {
  router.get("/v1/proposals", async (_req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id");
    if (!eventId) throw validationError("event_id is required.", [{ field_key: "event_id", message: "Which event's proposals?" }]);
    ctx.eventId = eventId;
    ctx.requireRead("proposal.read_any", { event_id: eventId });
    const app = ctx.app(eventId);
    const filters = queueFiltersFrom(ctx.url);
    const { rows, next_cursor, total } = await proposalQueue(app, eventId, filters);
    const includePii = ctx.includePii({ event_id: eventId });
    return json({ data: rows.map((r) => proposalJson(r, includePii)), next_cursor, total });
  });

  router.get("/v1/proposals/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.id);
    ctx.eventId = str(proposal.event_id);
    ctx.requireRead("proposal.read_any", { event_id: proposal.event_id, proposal_id: proposal.id });
    const includePii = ctx.includePii({ event_id: proposal.event_id, proposal_id: proposal.id });
    // Staff (rank >= read) see committee/organizer-only answers; a speaker or
    // sponsor contact reading their own proposal (rank == own) gets exactly
    // what the portal read view shows them (INV-04-11) — never reviews, scores
    // or reviewer identities, which this endpoint does not surface at all.
    const isStaffReader = ctx.canRead("proposal.read_any", { event_id: proposal.event_id, proposal_id: proposal.id });
    const detail = await proposalDetail(app, proposal.id, { includePii, audience: isStaffReader ? "committee" : "submitter" });
    return json({
      ...proposalJson(proposal, includePii),
      speakers: detail.speakers.map((s) => ({
        person_id: str(s.person_id),
        full_name: s.person ? str(s.person.full_name) : null,
        email: s.person ? s.person.email : null, // already redacted by `proposalDetail`
        speaker_role: str(s.speaker_role),
        participation_status: str(s.participation_status),
      })),
      answers: Object.fromEntries(
        detail.answer_views.filter((a) => a.visible).map((a) => [a.field_key, a.value]),
      ),
    });
  });

  router.post("/v1/proposals", async (req, ctx) => {
    const input = await readInput(req);
    const cfpId = input.str("cfp_id");
    const cfp = await ctx.app().db.byId<Row>("call_for_proposals", cfpId);
    if (!cfp) throw notFound("Call for proposals", cfpId);
    ctx.eventId = str(cfp.event_id);
    ctx.requireRead("proposal.submit", { event_id: str(cfp.event_id) });
    const app = ctx.app(str(cfp.event_id));
    const submitterId = input.optional("submitter_person_id") || ctx.person?.id;
    if (!submitterId) throw validationError("submitter_person_id is required.", [{ field_key: "submitter_person_id", message: "Who is submitting?" }]);
    const entId = input.optional("entitlement_id");
    let sponsorId: string | null = input.optional("sponsor_id");
    let isSponsorManager = false;
    if (entId && sponsorId) isSponsorManager = ctx.canWrite("sponsor.manage", { sponsor_id: sponsorId });
    const proposal = await createDraft(app, {
      cfp_id: cfpId,
      submitter_person_id: submitterId,
      origin: (input.optional("origin") as Origin) ?? undefined,
      sponsor_id: sponsorId,
      entitlement_id: entId,
      is_sponsor_manager: isSponsorManager,
    });
    const form = await formOf(app, proposal);
    await syncSpeakerAnswer(app, proposal.id, form);
    await app.flush();
    return json(proposalJson(proposal, ctx.includePii({ event_id: proposal.event_id })), { status: 201 });
  });

  router.patch("/v1/proposals/:id", async (req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.id);
    ctx.eventId = str(proposal.event_id);
    ctx.requireWrite("proposal.edit", { event_id: proposal.event_id, proposal_id: proposal.id });
    const input = await readInput(req);
    const reason = input.str("reason", "API edit.");
    const patch = readOrganizerEditInput(input);
    const result = await organizerEdit(app, proposal.id, patch, reason);
    await app.flush();
    return json(proposalJson(result.proposal, ctx.includePii({ event_id: proposal.event_id })));
  });

  router.post("/v1/proposals/:id/submit", async (_req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.id);
    ctx.eventId = str(proposal.event_id);
    ctx.requireRead("proposal.edit", { event_id: proposal.event_id, proposal_id: proposal.id });
    const result = await submitProposal(app, proposal.id);
    await app.flush();
    return json(proposalJson(result.proposal, ctx.includePii({ event_id: proposal.event_id })));
  });

  router.post("/v1/proposals/:id/withdraw", async (req, ctx, params) => {
    const app = ctx.app();
    const proposal = await getProposal(app, params.id);
    ctx.eventId = str(proposal.event_id);
    ctx.requireRead("proposal.edit", { event_id: proposal.event_id, proposal_id: proposal.id });
    const input = await readInput(req);
    const result = await withdrawProposal(app, proposal.id, input.str("reason", "Withdrawn via API."));
    await app.flush();
    return json(proposalJson(result, ctx.includePii({ event_id: proposal.event_id })));
  });
}
