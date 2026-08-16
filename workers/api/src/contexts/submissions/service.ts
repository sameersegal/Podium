/**
 * Submissions — 04-submissions.md.
 *
 * Aggregate root: `Proposal`. `ProposalAnswer`, `ProposalSpeaker`,
 * `ProposalRevision` and `DraftProgress` are inside the aggregate and only
 * change through the functions here.
 *
 * Two things this file exists to keep honest:
 *   * every answer is a `ProposalAnswer` row **and** the mapped ones are real
 *     columns, written in the same write (04, "Why content is both");
 *   * the lifecycle is exactly the state machine drawn in 04 — an edge that is
 *     not drawn is rejected, not quietly allowed.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  acceptsSubmission,
  cfpStatus,
  percentComplete,
  visibleSteps,
  type EventStatus,
  type FormSpec,
  type Origin,
} from "@podiumstack/domain/event-config/types.js";
import { DomainError, illegalTransition, invariantError, notFound, validationError } from "@podiumstack/domain/shared/errors.js";
import { eventCodeFromSlug, formatReference, newId } from "@podiumstack/domain/shared/ids.js";
import {
  allFields,
  coerceAnswer,
  fieldByKey,
  isBlank,
  promoteAnswers,
  stepKeyIndex,
  visibleAnswers,
  assetIdsIn,
  type AnswerMap,
} from "@podiumstack/domain/submissions/answers.js";
import {
  canTransitionProposal,
  canWithdraw,
  changedFields,
  contentIsImmutable,
  editAffordance,
  proposalContentHash,
  type ChangeKind,
  type ProposalStatus,
  type SpeakerRole,
  type SpeakerView,
} from "@podiumstack/domain/submissions/types.js";
import { validateSubmission, type FormatView } from "@podiumstack/domain/submissions/validation.js";
import { createInvitation, findOrCreatePerson } from "../identity/service.js";
import {
  assertEntitlementUsable,
  assertMaySubmitForSponsor,
  emitHold,
  emitRelease,
  entitlementCounts,
} from "../sponsorship/service.js";
// The form runtime belongs to event configuration (02); submissions consume it.
import { loadFormSpec, loadPublishedForm } from "../event-config/views.js";

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export interface ProposalRow extends Row {
  id: string;
  event_id: string;
  cfp_id: string;
  form_id: string;
  reference: string;
  origin: string;
  submitter_person_id: string;
  sponsor_id: string | null;
  entitlement_id: string | null;
  status: string;
  row_version: number;
}

export async function getProposal(app: AppContext, proposalId: string): Promise<ProposalRow> {
  const row = await app.db.byId<ProposalRow>("proposal", proposalId);
  if (!row) throw notFound("Proposal", proposalId);
  return row;
}

export async function getCfp(app: AppContext, cfpId: string): Promise<Row> {
  const row = await app.db.byId<Row>("call_for_proposals", cfpId);
  if (!row) throw notFound("Call for proposals", cfpId);
  return row;
}

export async function answersOf(app: AppContext, proposalId: string): Promise<AnswerMap> {
  const rows = await app.db.select<Row>("proposal_answer", { proposal_id: proposalId });
  const out: AnswerMap = {};
  for (const r of rows) out[str(r.field_key)] = parseJson<unknown>(r.value, null);
  return out;
}

export async function speakersOf(app: AppContext, proposalId: string): Promise<Row[]> {
  return app.db.select<Row>("proposal_speaker", { proposal_id: proposalId }, { orderBy: "sort_order" });
}

function toSpeakerViews(rows: Row[]): SpeakerView[] {
  return rows.map((r) => ({
    person_id: str(r.person_id),
    speaker_role: str(r.speaker_role) as SpeakerRole,
    participation_status: str(r.participation_status) as SpeakerView["participation_status"],
  }));
}

export async function progressOf(app: AppContext, proposalId: string): Promise<Row | null> {
  return app.db.first<Row>("draft_progress", { proposal_id: proposalId });
}

/** The proposal's bound form version (INV-04-1: set at draft creation, never changed implicitly). */
export async function formOf(app: AppContext, proposal: ProposalRow): Promise<FormSpec> {
  return loadFormSpec(app, str(proposal.form_id));
}

/**
 * `content_hash` is derived (INV-04-12) — computed here, never stored.
 */
export function contentHashOf(proposal: Row): string {
  return proposalContentHash({
    title: proposal.title,
    abstract: proposal.abstract,
    description: proposal.description,
    session_format_id: proposal.session_format_id,
    requested_duration_minutes: proposal.requested_duration_minutes,
    track_id: proposal.track_id,
    audience_level: proposal.audience_level,
    keywords: parseJson<string[]>(proposal.keywords, []),
  });
}

/* -------------------------------------------------------------------------- */
/* CFP window                                                                  */
/* -------------------------------------------------------------------------- */

export interface CfpWindow {
  cfp: Row;
  status: string;
  accepts: { allowed: boolean; late: boolean; reason?: string };
  allow_edit_after_submit: boolean;
  withdraw_allowed_until: string;
  closes_at: string;
}

export async function cfpWindow(app: AppContext, cfpId: string, eventStatus?: string): Promise<CfpWindow> {
  const cfp = await getCfp(app, cfpId);
  const ev = await app.db.byId<Row>("event", str(cfp.event_id));
  const evStatus = (eventStatus ?? str(ev?.status, "draft")) as EventStatus;
  const spec = {
    opens_at: str(cfp.opens_at),
    closes_at: str(cfp.closes_at),
    closed_early_at: strOrNull(cfp.closed_early_at),
    published_at: strOrNull(cfp.published_at),
    grace_period_minutes: num(cfp.grace_period_minutes),
    late_submission_policy: str(cfp.late_submission_policy, "reject") as "reject" | "allow_with_flag",
  };
  return {
    cfp,
    status: cfpStatus(spec, evStatus, app.now()),
    accepts: acceptsSubmission(spec, evStatus, app.now()),
    allow_edit_after_submit: bool(cfp.allow_edit_after_submit),
    withdraw_allowed_until: str(cfp.withdraw_allowed_until, "always"),
    closes_at: str(cfp.closes_at),
  };
}

/* -------------------------------------------------------------------------- */
/* reference (INV-04-2)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * INV-04-2 — `reference` is unique per event, assigned at draft creation, and
 * **never reused even if the proposal is deleted**. The counter only ever moves
 * forward, which is why it is a row rather than `max(reference) + 1`.
 */
export async function nextReference(app: AppContext, eventId: string, eventSlug: string): Promise<string> {
  const code = eventCodeFromSlug(eventSlug);
  const rows = await app.db.raw<{ next_value: number; event_code: string }>(
    `INSERT INTO event_reference_counter (event_id, event_code, next_value)
          VALUES (?, ?, 2)
     ON CONFLICT(event_id) DO UPDATE SET next_value = next_value + 1
       RETURNING next_value, event_code`,
    [eventId, code],
  );
  const row = rows[0];
  const sequence = row ? Number(row.next_value) - 1 : 1;
  return formatReference(row?.event_code ?? code, sequence);
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateDraftInput {
  cfp_id: string;
  submitter_person_id: string;
  origin?: Origin;
  sponsor_id?: string | null;
  entitlement_id?: string | null;
  /** Set by the caller's authorization check, for INV-03-6. */
  is_sponsor_manager?: boolean;
}

/**
 * INV-04-1 `form_id` is set at draft creation and never changes implicitly.
 * INV-04-3 `origin = sponsor` requires both `sponsor_id` and `entitlement_id`,
 *          and the entitlement must belong to a `Sponsorship` for this event.
 *          `origin = cfp` requires both to be null.
 */
export async function createDraft(app: AppContext, input: CreateDraftInput): Promise<ProposalRow> {
  const cfp = await getCfp(app, input.cfp_id);
  const eventId = str(cfp.event_id);
  const event = await app.db.byId<Row>("event", eventId);
  if (!event) throw notFound("Event", eventId);

  const window = await cfpWindow(app, input.cfp_id, str(event.status));
  if (!window.accepts.allowed) {
    throw invariantError("INV-02-13", "cfp_not_accepting", window.accepts.reason ?? "This call for proposals is not open.");
  }

  const origin: Origin = input.origin ?? (input.entitlement_id ? "sponsor" : "cfp");
  const sponsorId = input.sponsor_id ?? null;
  const entitlementId = input.entitlement_id ?? null;
  await assertOriginConsistency(app, origin, sponsorId, entitlementId, eventId, input.submitter_person_id, input.is_sponsor_manager ?? false);

  const form = await loadPublishedForm(app, input.cfp_id);
  // INV-02-5: a CFP cannot be open without exactly one published form, so a
  // draft cannot bind to a version that does not exist (INV-04-1).
  if (!form) {
    throw invariantError(
      "INV-02-5",
      "no_published_form",
      "This call for proposals has no published submission form yet.",
      { cfp_id: input.cfp_id },
    );
  }
  const now = app.now();
  const id = newId("Proposal");
  const reference = await nextReference(app, eventId, str(event.slug));

  const row: Row = {
    id,
    event_id: eventId,
    cfp_id: input.cfp_id,
    form_id: form.id,
    reference,
    origin,
    submitter_person_id: input.submitter_person_id,
    sponsor_id: sponsorId,
    entitlement_id: entitlementId,
    title: "",
    abstract: "",
    description: null,
    session_format_id: null,
    requested_duration_minutes: null,
    track_id: null,
    assigned_track_id: null,
    audience_level: null,
    keywords: JSON.stringify([]),
    language: "en",
    av_requirements: JSON.stringify([]),
    recording_consent: "unanswered",
    recording_conditions: null,
    coi_disclosure: null,
    status: "draft",
    is_late: 0,
    submitted_at: null,
    last_activity_at: now,
    decision_id: null,
    confirmation_deadline: null,
    session_id: null,
    withdrawn_reason: null,
    created_at: now,
    updated_at: now,
    row_version: 1,
  };
  await app.db.insert("proposal", row);

  const firstStep = form.steps[0]?.key ?? "start";
  await app.db.insert("draft_progress", {
    proposal_id: id,
    current_step_key: firstStep,
    completed_step_keys: JSON.stringify([]),
    furthest_step_key: firstStep,
    last_saved_at: now,
    client_revision: 0,
  });

  // The submitter is the primary speaker by default on a CFP proposal. A
  // sponsor proposal starts speaker-less on purpose (04, `ProposalSpeaker`).
  if (origin !== "sponsor") {
    await addSpeakerRow(app, id, {
      person_id: input.submitter_person_id,
      speaker_role: "primary",
      participation_status: "accepted",
      sort_order: 0,
    });
  }

  app.events.emit({
    type: "proposal.created",
    subject: { type: "proposal", id },
    event_id: eventId,
    data: {
      proposal_id: id,
      reference,
      cfp_id: input.cfp_id,
      origin,
      submitter_person_id: input.submitter_person_id,
    },
  });
  app.audit.record({ action: "proposal.create", entity_type: "proposal", entity_id: id, after: { reference, origin } });

  // A sponsor draft holds a slot from the moment it exists (03, "Consumption is
  // a hold, not a decrement"): three contacts at the same company racing for two
  // slots is the failure this prevents.
  if (entitlementId) await emitHold(app, entitlementId, id);

  return row as ProposalRow;
}

async function assertOriginConsistency(
  app: AppContext,
  origin: Origin,
  sponsorId: string | null,
  entitlementId: string | null,
  eventId: string,
  personId: string | null,
  isSponsorManager: boolean,
): Promise<void> {
  if (origin === "sponsor") {
    if (!sponsorId || !entitlementId) {
      throw invariantError(
        "INV-04-3",
        "sponsor_origin_requires_entitlement",
        "A sponsor proposal must name both a sponsor and the entitlement it spends.",
      );
    }
    const { sponsorship } = await assertEntitlementUsable(app, entitlementId); // INV-03-2 / INV-03-7
    if (str(sponsorship.event_id) !== eventId) {
      throw invariantError("INV-04-3", "entitlement_wrong_event", "That entitlement belongs to a different event.", {
        entitlement_id: entitlementId,
      });
    }
    if (str(sponsorship.sponsor_id) !== sponsorId) {
      throw invariantError("INV-04-3", "entitlement_wrong_sponsor", "That entitlement belongs to a different sponsor.", {
        entitlement_id: entitlementId,
      });
    }
    await assertMaySubmitForSponsor(app, sponsorId, eventId, personId, isSponsorManager); // INV-03-6
    return;
  }
  if (origin === "cfp" && (sponsorId || entitlementId)) {
    throw invariantError(
      "INV-04-3",
      "cfp_origin_takes_no_entitlement",
      "A CFP proposal cannot reference a sponsor or an entitlement.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Autosave / draft edit                                                       */
/* -------------------------------------------------------------------------- */

export interface SaveDraftInput {
  /** Raw values keyed by `FormField.key`, for the fields this step posted. */
  values: Record<string, unknown>;
  step_key?: string | null;
  next_step_key?: string | null;
  /** INV-04-6 — the `DraftProgress.client_revision` the tab last saw. */
  client_revision?: number | null;
  mark_step_complete?: boolean;
}

export interface SaveDraftResult {
  proposal: ProposalRow;
  answers: AnswerMap;
  client_revision: number;
  percent_complete: number;
  changed_fields: string[];
}

/**
 * Autosave. "Submit runs the full ruleset; autosave runs none of it beyond type
 * coercion" — so nothing here rejects an incomplete answer.
 *
 * INV-04-6 — a stale write is rejected **with the current server state**, so
 * two tabs cannot silently clobber each other.
 */
export async function saveDraft(app: AppContext, proposalId: string, input: SaveDraftInput): Promise<SaveDraftResult> {
  const proposal = await getProposal(app, proposalId);
  const form = await formOf(app, proposal);
  const progress = await progressOf(app, proposalId);
  const now = app.now();

  const current = num(progress?.client_revision, 0);
  if (input.client_revision !== null && input.client_revision !== undefined && input.client_revision !== current) {
    // INV-04-6: optimistic concurrency on `client_revision`.
    throw new DomainError({
      code: "stale_draft",
      message: "This proposal was saved in another tab or window since you loaded it. The current version is shown below.",
      status: 409,
      invariant: "INV-04-6",
      details: {
        expected_client_revision: input.client_revision,
        current_client_revision: current,
        current_state: {
          proposal_id: proposalId,
          status: str(proposal.status),
          answers: await answersOf(app, proposalId),
          current_step_key: str(progress?.current_step_key, ""),
          last_saved_at: str(progress?.last_saved_at, ""),
        },
      },
    });
  }

  const existing = await answersOf(app, proposalId);
  const merged: AnswerMap = { ...existing };
  const touched: string[] = [];

  for (const [key, raw] of Object.entries(input.values)) {
    const field = fieldByKey(form, key);
    if (!field) continue; // unknown key — never trusted from the client
    const value = coerceAnswer(field.type, raw);
    merged[key] = value;
    touched.push(key);
  }

  await writeAnswers(app, proposalId, form, merged, touched, now);

  const beforeContent = promotedSnapshot(proposal);
  const promoted = promoteAnswers(form, merged);
  const changed = changedFields(beforeContent, promoted as unknown as Record<string, unknown>);

  await app.db.update("proposal", proposalId, {
    ...promotedColumns(promoted),
    last_activity_at: now,
    updated_at: now,
  });

  const nextRevision = current + 1;
  const completed = new Set(parseJson<string[]>(progress?.completed_step_keys, []));
  if (input.mark_step_complete && input.step_key) completed.add(input.step_key);
  const stepOrder = form.steps.map((s) => s.key);
  const furthest = furthestOf(str(progress?.furthest_step_key, stepOrder[0] ?? ""), input.next_step_key ?? input.step_key ?? "", stepOrder);

  // `draft_progress` is keyed by `proposal_id`, not `id`, so the generic
  // update-by-id helper does not apply.
  await app.db.rawRun(
    `UPDATE draft_progress
        SET current_step_key = ?, completed_step_keys = ?, furthest_step_key = ?, last_saved_at = ?, client_revision = ?
      WHERE proposal_id = ?`,
    [
      input.next_step_key || input.step_key || str(progress?.current_step_key, stepOrder[0] ?? ""),
      JSON.stringify([...completed]),
      furthest,
      now,
      nextRevision,
      proposalId,
    ],
  );

  const after = await getProposal(app, proposalId);

  if (changed.length > 0) {
    // A revision is only interesting once reviewers have something to compare
    // against — 04 names the three uses, and all three start at submit.
    if (proposal.submitted_at) {
      await writeRevision(app, after, "draft_edit", diffOf(beforeContent, promoted as unknown as Record<string, unknown>, changed), null);
    }
    app.events.emit({
      type: "proposal.updated",
      subject: { type: "proposal", id: proposalId },
      event_id: str(proposal.event_id),
      data: { proposal_id: proposalId, changed_fields: changed, change_kind: "draft_edit" },
    });
  }

  return {
    proposal: after,
    answers: merged,
    client_revision: nextRevision,
    percent_complete: percentComplete(form, merged),
    changed_fields: changed,
  };
}

function furthestOf(current: string, candidate: string, order: string[]): string {
  if (!candidate) return current;
  const a = order.indexOf(current);
  const b = order.indexOf(candidate);
  return b > a ? candidate : current || candidate;
}

/**
 * INV-04-4 — one answer per `(proposal, field_key)`. Answers for fields that
 * later become invisible are retained, not deleted.
 */
async function writeAnswers(
  app: AppContext,
  proposalId: string,
  form: FormSpec,
  answers: AnswerMap,
  touched: string[],
  now: string,
): Promise<void> {
  if (touched.length === 0) return;
  const existing = await app.db.select<Row>("proposal_answer", { proposal_id: proposalId });
  const byKey = new Map(existing.map((r) => [str(r.field_key), r]));
  for (const key of touched) {
    const field = fieldByKey(form, key);
    if (!field) continue;
    const value = JSON.stringify(answers[key] ?? null);
    const row = byKey.get(key);
    if (row) {
      await app.db.update("proposal_answer", str(row.id), { value, form_field_id: field.id, answered_at: now });
    } else {
      await app.db.insert("proposal_answer", {
        id: newId("ProposalAnswer"),
        proposal_id: proposalId,
        field_key: key,
        form_field_id: field.id,
        value,
        answered_at: now,
      });
    }
  }
}

function promotedColumns(p: ReturnType<typeof promoteAnswers>): Row {
  return {
    title: p.title,
    abstract: p.abstract,
    description: p.description,
    session_format_id: p.session_format_id,
    requested_duration_minutes: p.requested_duration_minutes,
    track_id: p.track_id,
    audience_level: p.audience_level,
    keywords: JSON.stringify(p.keywords),
    av_requirements: JSON.stringify(p.av_requirements),
    recording_consent: p.recording_consent,
    recording_conditions: p.recording_conditions,
    coi_disclosure: p.coi_disclosure,
  };
}

function promotedSnapshot(proposal: Row): Record<string, unknown> {
  return {
    title: str(proposal.title),
    abstract: str(proposal.abstract),
    description: strOrNull(proposal.description),
    session_format_id: strOrNull(proposal.session_format_id),
    requested_duration_minutes: proposal.requested_duration_minutes ?? null,
    track_id: strOrNull(proposal.track_id),
    audience_level: strOrNull(proposal.audience_level),
    keywords: parseJson<string[]>(proposal.keywords, []),
    av_requirements: parseJson<string[]>(proposal.av_requirements, []),
    recording_consent: str(proposal.recording_consent, "unanswered"),
    recording_conditions: strOrNull(proposal.recording_conditions),
    coi_disclosure: strOrNull(proposal.coi_disclosure),
  };
}

function diffOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) out[f] = { from: before[f] ?? null, to: after[f] ?? null };
  return out;
}

/* -------------------------------------------------------------------------- */
/* ProposalRevision                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Append-only. "Only `submit` and `decision` revisions carry a full
 * `snapshot`" — the submit snapshot is what reviewers read, so it must not move
 * under them.
 */
export async function writeRevision(
  app: AppContext,
  proposal: Row,
  kind: ChangeKind,
  diff: Record<string, unknown>,
  snapshot: Record<string, unknown> | null,
): Promise<number> {
  const rows = await app.db.raw<{ n: number }>(
    "SELECT COALESCE(MAX(revision_number), 0) AS n FROM proposal_revision WHERE proposal_id = ?",
    [str(proposal.id)],
  );
  const revisionNumber = num(rows[0]?.n, 0) + 1;
  await app.db.insert("proposal_revision", {
    id: newId("ProposalRevision"),
    proposal_id: str(proposal.id),
    revision_number: revisionNumber,
    changed_by_person_id: app.actor.id ?? str(proposal.submitter_person_id),
    change_kind: kind,
    diff: JSON.stringify(diff),
    snapshot: snapshot ? JSON.stringify(snapshot) : null,
    created_at: app.now(),
  });
  return revisionNumber;
}

export async function revisionsOf(app: AppContext, proposalId: string): Promise<Row[]> {
  return app.db.select<Row>("proposal_revision", { proposal_id: proposalId }, { orderBy: "revision_number DESC" });
}

/* -------------------------------------------------------------------------- */
/* Submit                                                                      */
/* -------------------------------------------------------------------------- */

/** Everything the eight submit rules need, gathered once. */
async function submissionContext(app: AppContext, proposal: ProposalRow) {
  const id = str(proposal.id);
  const form = await formOf(app, proposal);
  const answers = await answersOf(app, id);
  const window = await cfpWindow(app, str(proposal.cfp_id));
  const event = await app.db.byId<Row>("event", str(proposal.event_id));
  const speakers = toSpeakerViews(await speakersOf(app, id));

  const formatRow = proposal.session_format_id
    ? await app.db.byId<Row>("session_format", str(proposal.session_format_id))
    : null;
  const cfpFormat = formatRow
    ? await app.db.first<Row>("cfp_format_option", { cfp_id: str(proposal.cfp_id), session_format_id: str(formatRow.id) })
    : null;
  const format: FormatView | null = formatRow
    ? {
        id: str(formatRow.id),
        name: str(formatRow.name),
        default_duration_minutes: num(formatRow.default_duration_minutes),
        min_duration_minutes: formatRow.min_duration_minutes === null ? null : num(formatRow.min_duration_minutes),
        max_duration_minutes: formatRow.max_duration_minutes === null ? null : num(formatRow.max_duration_minutes),
        max_speakers: num(formatRow.max_speakers, 1),
        eligible_origins: parseJson<string[]>(formatRow.eligible_origins, ["cfp"]),
        requires_recording_consent: bool(formatRow.requires_recording_consent),
        available_in_cfp: cfpFormat ? bool(cfpFormat.is_available) : true,
      }
    : null;

  let trackAvailable = true;
  if (proposal.track_id) {
    const opt = await app.db.first<Row>("cfp_track_option", { cfp_id: str(proposal.cfp_id), track_id: str(proposal.track_id) });
    trackAvailable = opt ? bool(opt.is_available) : true;
  }

  // Rule 5 — "counting only non-withdrawn, non-rejected proposals by the same
  // submitter under this CFP".
  const capRows = await app.db.raw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM proposal
      WHERE cfp_id = ? AND submitter_person_id = ? AND deleted_at IS NULL
        AND id != ? AND status NOT IN ('withdrawn','rejected')`,
    [str(proposal.cfp_id), str(proposal.submitter_person_id), id],
  );
  const limitCandidates = [
    window.cfp.max_proposals_per_person,
    cfpFormat?.max_proposals_per_person ?? null,
  ]
    .filter((v) => v !== null && v !== undefined)
    .map((v) => num(v));
  const limit = limitCandidates.length ? Math.min(...limitCandidates) : null;

  let sponsor: Awaited<ReturnType<typeof sponsorContextFor>> | null = null;
  if (str(proposal.origin) === "sponsor" && proposal.entitlement_id) {
    sponsor = await sponsorContextFor(app, proposal, str(event?.name, "this event"));
  }

  const referencedAssetIds = new Set<string>();
  const assetFieldKey = new Map<string, string>();
  for (const [key, value] of Object.entries(answers)) {
    for (const id of assetIdsIn(value)) {
      referencedAssetIds.add(id);
      assetFieldKey.set(id, key);
    }
  }
  const assets: { id: string; scan_status: string; field_key: string }[] = [];
  for (const id of referencedAssetIds) {
    const row = await app.db.byId<Row>("asset", id);
    assets.push({ id, scan_status: str(row?.scan_status, "failed"), field_key: assetFieldKey.get(id) ?? "" });
  }

  return { form, answers, window, event, speakers, format, trackAvailable, cap: { limit, current: num(capRows[0]?.n, 0) }, sponsor, assets };
}

async function sponsorContextFor(app: AppContext, proposal: ProposalRow, eventName: string) {
  const entitlementId = str(proposal.entitlement_id);
  const entitlement = await app.db.byId<Row>("entitlement", entitlementId);
  if (!entitlement) throw notFound("Entitlement", entitlementId);
  const sponsorship = await app.db.byId<Row>("sponsorship", str(entitlement.sponsorship_id));
  const sponsor = await app.db.byId<Row>("sponsor", str(proposal.sponsor_id));
  if (!sponsorship || !sponsor) throw notFound("Sponsorship", str(entitlement.sponsorship_id));

  // The proposal being submitted already holds its own slot, so it must not
  // count against itself when INV-03-3 is evaluated.
  const adjusted = await entitlementCounts(app, entitlementId, str(proposal.id));

  return {
    sponsor: { name: str(sponsor.name), status: str(sponsor.status) },
    sponsorship: { status: str(sponsorship.status) },
    entitlement: {
      id: entitlementId,
      entitlement_type: str(entitlement.entitlement_type),
      quantity: num(entitlement.quantity),
      allowed_format_ids: parseJson<string[]>(entitlement.allowed_format_ids, []),
      submission_deadline: strOrNull(entitlement.submission_deadline),
      expires_at: strOrNull(entitlement.expires_at),
      label: `${str(entitlement.entitlement_type).replace(/_/g, " ")}s`,
    },
    counts: adjusted,
    event_name: eventName,
  };
}

export interface SubmitResult {
  proposal: ProposalRow;
  is_late: boolean;
  revision_number: number;
  resubmitted: boolean;
}

/**
 * `draft --> submitted` and `changes_requested --> in_review`, the two drawn
 * edges a submitter drives. Runs the eight rules in 04's "Submission-time
 * validation" and returns every failure at once, keyed by `field_key` **and**
 * `step_key` so the wizard can route each error to its step.
 */
export async function submitProposal(app: AppContext, proposalId_: string): Promise<SubmitResult> {
  const proposal = await getProposal(app, proposalId_);
  const from = str(proposal.status) as ProposalStatus;
  const resubmitting = from === "changes_requested";
  const to: ProposalStatus = resubmitting ? "in_review" : "submitted";
  if (!canTransitionProposal(from, to)) throw illegalTransition("Proposal", from, to);

  const ctx = await submissionContext(app, proposal);
  const result = validateSubmission({
    form: ctx.form,
    answers: ctx.answers,
    origin: str(proposal.origin) as Origin,
    content: {
      session_format_id: strOrNull(proposal.session_format_id),
      track_id: strOrNull(proposal.track_id),
      requested_duration_minutes: proposal.requested_duration_minutes === null ? null : num(proposal.requested_duration_minutes),
      recording_consent: str(proposal.recording_consent, "unanswered") as "granted" | "denied" | "conditional" | "unanswered",
    },
    cfp: resubmitting ? { allowed: true, late: false } : ctx.window.accepts,
    format: ctx.format,
    track_available: ctx.trackAvailable,
    speakers: ctx.speakers,
    proposal_cap: ctx.cap,
    sponsor: ctx.sponsor,
    assets: ctx.assets,
    now: app.now(),
  });

  // A named invariant beats a wall of field errors: `entitlement_exhausted`
  // rather than a generic 400 (INV-03-3, 11-cross-cutting "Validation").
  const first = result.failures[0];
  if (first) {
    throw new DomainError({
      code: first.code,
      message: first.message,
      status: first.code === "entitlement_exhausted" ? 409 : 422,
      invariant: first.invariant,
      details: first.details,
      fieldErrors: result.field_errors,
    });
  }
  if (result.field_errors.length > 0) {
    throw validationError("Some answers still need attention before this can be submitted.", result.field_errors);
  }

  const now = app.now();
  const isLate = ctx.window.accepts.late;
  const snapshot = { ...promotedSnapshot(proposal), answers: visibleAnswers(ctx.form, ctx.answers), content_hash: contentHashOf(proposal) };
  const revisionNumber = await writeRevision(app, proposal, "resubmission", {}, snapshot);

  await app.db.update("proposal", proposalId_, {
    status: to,
    is_late: isLate ? 1 : 0,
    submitted_at: proposal.submitted_at ?? now,
    last_activity_at: now,
    updated_at: now,
  });

  const speakerIds = ctx.speakers.filter((s) => s.participation_status !== "removed").map((s) => s.person_id);
  if (resubmitting) {
    app.events.emit({
      type: "proposal.resubmitted",
      subject: { type: "proposal", id: proposalId_ },
      event_id: str(proposal.event_id),
      data: { proposal_id: proposalId_, revision_number: revisionNumber, changed_fields: [] },
    });
  } else {
    app.events.emit({
      type: "proposal.submitted",
      subject: { type: "proposal", id: proposalId_ },
      event_id: str(proposal.event_id),
      data: {
        proposal_id: proposalId_,
        reference: str(proposal.reference),
        title: str(proposal.title),
        format_id: strOrNull(proposal.session_format_id),
        track_id: strOrNull(proposal.track_id),
        speaker_person_ids: speakerIds,
        is_late: isLate,
        sponsor_id: strOrNull(proposal.sponsor_id),
      },
    });
  }
  app.audit.record({
    action: "proposal.submit",
    entity_type: "proposal",
    entity_id: proposalId_,
    before: { status: from },
    after: { status: to, is_late: isLate },
  });

  return { proposal: await getProposal(app, proposalId_), is_late: isLate, revision_number: revisionNumber, resubmitted: resubmitting };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransitionOptions {
  reason?: string | null;
  decision_id?: string | null;
  confirmation_deadline?: string | null;
  withdrawn_by?: string | null;
  note?: string | null;
  /** Suppress the audit row when the caller writes its own richer one. */
  skipAudit?: boolean;
}

/**
 * The single door onto `Proposal.status`. Exported so the review context can
 * drive the lifecycle without duplicating the guard rules.
 *
 * Every edge is checked against the state machine drawn in 04 —
 * `canTransitionProposal` is generated from that diagram, so an undrawn
 * transition genuinely does not exist.
 */
export async function setProposalStatus(
  app: AppContext,
  proposalId_: string,
  to: ProposalStatus,
  opts: TransitionOptions = {},
): Promise<ProposalRow> {
  const proposal = await getProposal(app, proposalId_);
  const from = str(proposal.status) as ProposalStatus;
  if (from === to) return proposal;
  if (!canTransitionProposal(from, to)) throw illegalTransition("Proposal", from, to);

  // INV-04-8 — `status = accepted` requires a `decision_id` whose outcome is `accept`.
  if (to === "accepted") {
    const decisionId = opts.decision_id ?? strOrNull(proposal.decision_id);
    const decision = decisionId ? await app.db.byId<Row>("decision", decisionId) : null;
    if (!decision || str(decision.outcome) !== "accept") {
      throw invariantError(
        "INV-04-8",
        "accept_requires_decision",
        "A proposal can only be accepted through a decision whose outcome is accept.",
        { proposal_id: proposalId_, decision_id: decisionId },
      );
    }
  }

  const now = app.now();
  const values: Row = { status: to, last_activity_at: now, updated_at: now };
  if (opts.decision_id !== undefined && opts.decision_id !== null) values.decision_id = opts.decision_id;
  if (opts.confirmation_deadline !== undefined) values.confirmation_deadline = opts.confirmation_deadline ?? null;
  if (to === "withdrawn") values.withdrawn_reason = opts.reason ?? null;
  if (to === "draft") {
    values.submitted_at = proposal.submitted_at ?? null;
    values.is_late = 0;
  }
  await app.db.update("proposal", proposalId_, values);

  await emitTransition(app, proposal, from, to, opts);

  if (!opts.skipAudit) {
    // INV-11-5 — every state transition writes an audit row.
    app.audit.record({
      action: `proposal.${to}`,
      entity_type: "proposal",
      entity_id: proposalId_,
      before: { status: from },
      after: { status: to },
      reason: opts.reason ?? null,
    });
  }
  return getProposal(app, proposalId_);
}

async function emitTransition(
  app: AppContext,
  proposal: ProposalRow,
  from: ProposalStatus,
  to: ProposalStatus,
  opts: TransitionOptions,
): Promise<void> {
  const id = str(proposal.id);
  const eventId = str(proposal.event_id);
  switch (to) {
    case "withdrawn":
      app.events.emit({
        type: "proposal.withdrawn",
        subject: { type: "proposal", id },
        event_id: eventId,
        data: { proposal_id: id, reason: opts.reason ?? null, withdrawn_by: opts.withdrawn_by ?? app.actor.id ?? null },
      });
      break;
    case "expired":
      app.events.emit({
        type: "proposal.expired",
        subject: { type: "proposal", id },
        event_id: eventId,
        data: { proposal_id: id, confirmation_deadline: strOrNull(proposal.confirmation_deadline) },
      });
      break;
    case "changes_requested":
      app.events.emit({
        type: "proposal.changes_requested",
        subject: { type: "proposal", id },
        event_id: eventId,
        data: { proposal_id: id, decision_id: opts.decision_id ?? null, note: opts.note ?? null },
      });
      break;
    case "draft":
      // `submitted --> draft: unsubmit`. Reported as an update rather than a
      // new event type — the catalogue has no `proposal.unsubmitted`.
      app.events.emit({
        type: "proposal.updated",
        subject: { type: "proposal", id },
        event_id: eventId,
        data: { proposal_id: id, changed_fields: ["status"], change_kind: "draft_edit" },
      });
      break;
    default:
      break;
  }
}

/** `draft|submitted|in_review|accepted --> withdrawn` (INV-04-10 via the reaction map). */
export async function withdrawProposal(app: AppContext, proposalId_: string, reason: string): Promise<ProposalRow> {
  const proposal = await getProposal(app, proposalId_);
  const window = await cfpWindow(app, str(proposal.cfp_id));
  if (!canWithdraw(str(proposal.status), window.withdraw_allowed_until)) {
    throw illegalTransition("Proposal", str(proposal.status), "withdrawn");
  }
  const after = await setProposalStatus(app, proposalId_, "withdrawn", { reason });
  // INV-04-10 — the hold is released in the same transaction, not only through
  // the queue, so the slot is free before the response is written.
  if (proposal.entitlement_id) await emitRelease(app, str(proposal.entitlement_id), proposalId_, "withdrawn");
  return after;
}

/**
 * `submitted --> draft: unsubmit (only while CFP open and
 * allow_edit_after_submit)`. This is how "edit after submit" works: INV-04-7
 * makes content immutable *in* `submitted`, and the diagram draws the way out.
 */
export async function unsubmitProposal(app: AppContext, proposalId_: string): Promise<ProposalRow> {
  const proposal = await getProposal(app, proposalId_);
  const window = await cfpWindow(app, str(proposal.cfp_id));
  const affordance = editAffordance(str(proposal.status), {
    accepts_edit: window.accepts.allowed,
    allow_edit_after_submit: window.allow_edit_after_submit,
  });
  if (!affordance.editable) {
    throw invariantError("INV-04-7", "proposal_not_editable", affordance.reason ?? "This proposal can no longer be edited.");
  }
  if (!affordance.requires_unsubmit) return proposal;
  return setProposalStatus(app, proposalId_, "draft");
}

/**
 * `in_review --> changes_requested`. Exported for the review context, which
 * owns the HTTP endpoint but not the transition rules.
 */
export async function requestChanges(
  app: AppContext,
  proposalId_: string,
  note: string,
  decisionId: string | null = null,
): Promise<ProposalRow> {
  return setProposalStatus(app, proposalId_, "changes_requested", { note, decision_id: decisionId, reason: note });
}

export interface DecisionApplication {
  decision_id: string;
  outcome: "accept" | "waitlist" | "reject" | "request_changes";
  confirmation_deadline?: string | null;
  note?: string | null;
  /**
   * The decision may reassign the talk (`assigned_track_id`,
   * `assigned_format_id`, `assigned_duration_minutes`). The proposal records
   * the chair's track decision in `assigned_track_id`; the rest is copied onto
   * the `Session` at creation, not back onto the frozen proposal (INV-06-9).
   */
  assigned_track_id?: string | null;
  assigned_format_id?: string | null;
  assigned_duration_minutes?: number | null;
}

/**
 * The lifecycle half of `decision.published`. The review context records and
 * publishes the decision; this moves the proposal, so the guard rules live in
 * one place.
 */
export async function applyDecisionToProposal(
  app: AppContext,
  proposalId_: string,
  decision: DecisionApplication,
): Promise<ProposalRow> {
  const proposal = await getProposal(app, proposalId_);
  // The decision id must be on the row before INV-04-8 can be satisfied.
  if (strOrNull(proposal.decision_id) !== decision.decision_id) {
    await app.db.update("proposal", proposalId_, { decision_id: decision.decision_id, updated_at: app.now() });
  }
  switch (decision.outcome) {
    case "accept":
      return setProposalStatus(app, proposalId_, "accepted", {
        decision_id: decision.decision_id,
        confirmation_deadline: decision.confirmation_deadline ?? null,
      });
    case "waitlist":
      return setProposalStatus(app, proposalId_, "waitlisted", { decision_id: decision.decision_id });
    case "reject": {
      const after = await setProposalStatus(app, proposalId_, "rejected", { decision_id: decision.decision_id });
      // INV-04-10 — rejecting releases any entitlement hold.
      if (proposal.entitlement_id) await emitRelease(app, str(proposal.entitlement_id), proposalId_, "rejected");
      return after;
    }
    case "request_changes":
      return requestChanges(app, proposalId_, decision.note ?? "", decision.decision_id);
  }
}

/** `accepted --> expired` when the confirmation deadline passes. */
export async function expireProposal(app: AppContext, proposalId_: string): Promise<ProposalRow> {
  const proposal = await getProposal(app, proposalId_);
  const after = await setProposalStatus(app, proposalId_, "expired", { reason: "confirmation_deadline passed" });
  if (proposal.entitlement_id) await emitRelease(app, str(proposal.entitlement_id), proposalId_, "expired");
  return after;
}

/* -------------------------------------------------------------------------- */
/* Organizer edit (INV-04-7)                                                   */
/* -------------------------------------------------------------------------- */

export const ORGANIZER_EDITABLE_FIELDS = [
  "title",
  "abstract",
  "description",
  "session_format_id",
  "requested_duration_minutes",
  "track_id",
  "assigned_track_id",
  "audience_level",
  "keywords",
  "language",
  "recording_consent",
  "recording_conditions",
  "coi_disclosure",
] as const;

/**
 * INV-04-7 — content fields are immutable in `submitted`, `in_review`,
 * `accepted`, `waitlisted` and `rejected` **except via an organizer edit, which
 * always writes a `ProposalRevision` with `change_kind = organizer_edit`**.
 *
 * 11-cross-cutting.md also requires an audit row for "any organizer edit of
 * submitter-owned content", with a reason.
 */
export async function organizerEdit(
  app: AppContext,
  proposalId_: string,
  patch: Record<string, unknown>,
  reason: string,
): Promise<{ proposal: ProposalRow; changed_fields: string[]; revision_number: number | null }> {
  const proposal = await getProposal(app, proposalId_);
  const before = promotedSnapshot(proposal);
  const values: Row = {};
  for (const field of ORGANIZER_EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const raw = patch[field];
    if (field === "keywords") {
      values.keywords = JSON.stringify(Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    } else if (field === "requested_duration_minutes") {
      values[field] = isBlank(raw) ? null : Math.round(Number(raw));
    } else {
      values[field] = isBlank(raw) ? null : String(raw);
    }
  }
  if (Object.keys(values).length === 0) return { proposal, changed_fields: [], revision_number: null };

  const after = { ...before, ...promotedSnapshot({ ...proposal, ...values }) };
  const changed = changedFields(before, after).filter((f) => f in values || values[f] !== undefined);
  const assignedTrackChanged = "assigned_track_id" in values && strOrNull(proposal.assigned_track_id) !== values.assigned_track_id;
  if (changed.length === 0 && !assignedTrackChanged) return { proposal, changed_fields: [], revision_number: null };

  values.updated_at = app.now();
  values.last_activity_at = app.now();
  await app.db.update("proposal", proposalId_, values);

  const updated = await getProposal(app, proposalId_);
  const revision = await writeRevision(app, updated, "organizer_edit", diffOf(before, after, changed), null);

  const allChanged = assignedTrackChanged ? [...changed, "assigned_track_id"] : changed;
  app.events.emit({
    type: "proposal.updated",
    subject: { type: "proposal", id: proposalId_ },
    event_id: str(proposal.event_id),
    data: { proposal_id: proposalId_, changed_fields: allChanged, change_kind: "organizer_edit" },
  });
  app.audit.record({
    action: "proposal.organizer_edit",
    entity_type: "proposal",
    entity_id: proposalId_,
    before: Object.fromEntries(changed.map((f) => [f, before[f]])),
    after: Object.fromEntries(changed.map((f) => [f, after[f]])),
    reason, // INV-11-5 — organizer edits of submitter-owned content carry a reason
  });

  return { proposal: updated, changed_fields: allChanged, revision_number: revision };
}

/** True when the caller may not touch content because the model says so. */
export function assertContentMutable(proposal: Row): void {
  if (contentIsImmutable(str(proposal.status))) {
    throw invariantError(
      "INV-04-7",
      "content_immutable",
      `A ${str(proposal.status).replace(/_/g, " ")} proposal's content can only be changed by an organizer.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Speakers                                                                    */
/* -------------------------------------------------------------------------- */

async function addSpeakerRow(
  app: AppContext,
  proposalId_: string,
  input: { person_id: string; speaker_role: SpeakerRole; participation_status: SpeakerView["participation_status"]; sort_order: number; invitation_id?: string | null },
): Promise<Row> {
  const id = newId("ProposalSpeaker");
  const row: Row = {
    id,
    proposal_id: proposalId_,
    person_id: input.person_id,
    speaker_role: input.speaker_role,
    sort_order: input.sort_order,
    invitation_id: input.invitation_id ?? null,
    participation_status: input.participation_status,
    added_by_person_id: app.actor.id ?? input.person_id,
    added_at: app.now(),
  };
  await app.db.insert("proposal_speaker", row);
  return row;
}

export interface AddCoSpeakerInput {
  full_name: string;
  email: string;
  speaker_role?: SpeakerRole;
  base_url: string;
}

/**
 * A co-speaker added by name and email is a real `Person` from that moment
 * (01, "A person can exist with no ability to log in"), plus an `Invitation` of
 * kind `co_speaker` whose `accept_url` INV-01-15 requires be shown on screen.
 */
export async function addCoSpeaker(
  app: AppContext,
  proposalId_: string,
  input: AddCoSpeakerInput,
): Promise<{ speaker: Row; accept_url: string; person: Row }> {
  const proposal = await getProposal(app, proposalId_);
  const existingRows = await speakersOf(app, proposalId_);

  // INV-04-5 is a property of the chosen format, and the roster is collected
  // before the format is (the seeded form asks "About you" on step 1 and
  // "About your talk" on step 2). With no format chosen there is no cap to
  // apply yet — defaulting to one made naming a co-speaker impossible on every
  // fresh draft. Submission-time validation still enforces the real cap
  // (04, rule 4), which is where a format is guaranteed to exist.
  const format = proposal.session_format_id ? await app.db.byId<Row>("session_format", str(proposal.session_format_id)) : null;
  const maxSpeakers = format ? num(format.max_speakers, 1) : Number.POSITIVE_INFINITY;
  const active = existingRows.filter((r) => str(r.participation_status) !== "removed");
  if (active.length >= maxSpeakers) {
    // INV-04-5: speaker count never exceeds `SessionFormat.max_speakers`.
    throw invariantError(
      "INV-04-5",
      "too_many_speakers",
      `This format allows at most ${maxSpeakers} speaker${maxSpeakers === 1 ? "" : "s"}.`,
      { max_speakers: maxSpeakers },
    );
  }

  const person = await findOrCreatePerson(app, {
    email: input.email,
    full_name: input.full_name,
    is_placeholder: true,
    status: "invited",
    source: "proposal",
  });
  if (existingRows.some((r) => str(r.person_id) === person.id && str(r.participation_status) !== "removed")) {
    throw new DomainError({ code: "speaker_already_credited", message: `${input.full_name} is already on this proposal.`, status: 409 });
  }

  const invitation = await createInvitation(
    app,
    {
      email: input.email,
      kind: "co_speaker",
      person_id: person.id,
      context_type: "proposal",
      context_id: proposalId_,
    },
    input.base_url,
  );

  const speaker = await addSpeakerRow(app, proposalId_, {
    person_id: person.id,
    speaker_role: input.speaker_role ?? "co_speaker",
    participation_status: "pending",
    sort_order: existingRows.length,
    invitation_id: invitation.id,
  });

  app.events.emit({
    type: "proposal_speaker.added",
    subject: { type: "proposal", id: proposalId_ },
    event_id: str(proposal.event_id),
    data: {
      proposal_id: proposalId_,
      person_id: person.id,
      speaker_role: str(speaker.speaker_role),
      invitation_id: invitation.id,
    },
  });
  await writeRevision(app, proposal, "speaker_change", { speakers: { from: null, to: person.id } }, null);
  app.audit.record({
    action: "proposal_speaker.add",
    entity_type: "proposal",
    entity_id: proposalId_,
    after: { person_id: person.id, speaker_role: speaker.speaker_role },
  });

  return { speaker, accept_url: invitation.accept_url, person: person as unknown as Row };
}

export async function removeSpeaker(app: AppContext, proposalId_: string, personId: string): Promise<void> {
  const proposal = await getProposal(app, proposalId_);
  const rows = await speakersOf(app, proposalId_);
  const target = rows.find((r) => str(r.person_id) === personId);
  if (!target) throw notFound("Speaker on this proposal", personId);

  // INV-04-5: a non-sponsor proposal keeps exactly one non-removed `primary`.
  if (str(target.speaker_role) === "primary" && str(proposal.origin) !== "sponsor") {
    throw invariantError(
      "INV-04-5",
      "cannot_remove_primary_speaker",
      "Name a different primary speaker before removing this one.",
    );
  }
  await app.db.update("proposal_speaker", str(target.id), { participation_status: "removed" });
  app.events.emit({
    type: "proposal_speaker.removed",
    subject: { type: "proposal", id: proposalId_ },
    event_id: str(proposal.event_id),
    data: { proposal_id: proposalId_, person_id: personId, removed_by: app.actor.id ?? null },
  });
  await writeRevision(app, proposal, "speaker_change", { speakers: { from: personId, to: null } }, null);
  app.audit.record({ action: "proposal_speaker.remove", entity_type: "proposal", entity_id: proposalId_, before: { person_id: personId } });
}

export async function respondToSpeakerInvitation(
  app: AppContext,
  proposalId_: string,
  personId: string,
  accept: boolean,
): Promise<void> {
  const proposal = await getProposal(app, proposalId_);
  const rows = await speakersOf(app, proposalId_);
  const target = rows.find((r) => str(r.person_id) === personId);
  if (!target) throw notFound("Speaking invitation");
  if (str(target.participation_status) !== "pending") {
    throw new DomainError({
      code: "invitation_already_answered",
      message: `You already ${str(target.participation_status)} this invitation.`,
      status: 409,
    });
  }
  await app.db.update("proposal_speaker", str(target.id), { participation_status: accept ? "accepted" : "declined" });
  app.events.emit({
    type: accept ? "proposal_speaker.accepted" : "proposal_speaker.declined",
    subject: { type: "proposal", id: proposalId_ },
    event_id: str(proposal.event_id),
    data: { proposal_id: proposalId_, person_id: personId },
  });
  app.audit.record({
    action: accept ? "proposal_speaker.accept" : "proposal_speaker.decline",
    entity_type: "proposal",
    entity_id: proposalId_,
    after: { person_id: personId },
  });
}

/* -------------------------------------------------------------------------- */
/* Draft abandonment (R22)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `draft.abandoned` — "no activity for N days, drives the nudge". The
 * entitlement hold is derived, so it is already free by the time this fires;
 * the event exists so a nudge can be sent and the fact is on the log.
 */
export async function emitDraftAbandoned(app: AppContext, proposal: Row): Promise<void> {
  const id = str(proposal.id);
  let pct = 0;
  try {
    const form = await loadFormSpec(app, str(proposal.form_id));
    pct = percentComplete(form, await answersOf(app, id));
  } catch {
    pct = 0;
  }
  app.events.emit({
    type: "draft.abandoned",
    subject: { type: "proposal", id },
    event_id: str(proposal.event_id),
    data: { proposal_id: id, last_activity_at: str(proposal.last_activity_at), percent_complete: pct },
  });
}

/* -------------------------------------------------------------------------- */
/* Shared helpers for the routes and read models                               */
/* -------------------------------------------------------------------------- */

export { allFields, stepKeyIndex, visibleSteps, percentComplete, promoteAnswers, visibleAnswers, editAffordance, canWithdraw };
