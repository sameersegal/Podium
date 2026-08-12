/**
 * Program — the `Session` aggregate (06-program.md).
 *
 * `SessionSpeaker`, `SessionRelation`, `SessionAsset` and `SessionRevision`
 * live inside the aggregate; every invariant is enforced here, at the root,
 * rather than in a route.
 *
 * Cross-aggregate consequences travel by domain event: cancelling a session
 * emits `session.cancelled` and its consumers release the placement, cancel the
 * tasks and release the entitlement (INV-06-7). This module never reaches into
 * another context's tables.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { DomainError, invariantError, notFound } from "@podiumconf/domain/shared/errors.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import type { Instant } from "@podiumconf/domain/shared/time.js";
import {
  APPROVAL_GATED_FIELDS,
  assertContentTransition,
  assertDurationWithinFormat,
  assertSessionTransition,
  assertSpeakerLimit,
  assertSponsorShape,
  confirmationCheck,
  contentDiverged,
  contentSnapshot,
  diffContent,
  isSponsoredContent,
  REVISION_CONTENT_FIELDS,
  touchesApprovedContent,
  type ContentSnapshot,
  type ContentStatus,
  type FormatLimits,
  type RevisionChangeKind,
  type SessionOrigin,
  type SessionStatus,
  type SessionVisibility,
  type SpeakerConfirmationStatus,
  type SpeakerRole,
  type SpeakerView,
} from "@podiumconf/domain/program/types.js";
import { findOrCreatePerson } from "../identity/service.js";

export interface SessionRow extends Row {
  id: string;
  org_id: string;
  event_id: string;
  proposal_id: string | null;
  reference: string;
  origin: string;
  title: string;
  abstract: string;
  session_format_id: string;
  track_id: string | null;
  duration_minutes: number;
  sponsor_id: string | null;
  status: string;
  content_status: string;
  visibility: string;
  row_version: number;
}

export interface SpeakerRow extends Row {
  id: string;
  session_id: string;
  person_id: string;
  speaker_role: string;
  sort_order: number;
  confirmation_status: string;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function findSession(app: AppContext, sessionId: string): Promise<SessionRow | null> {
  return app.db.byId<SessionRow>("session", sessionId);
}

export async function getSession(app: AppContext, sessionId: string): Promise<SessionRow> {
  const row = await findSession(app, sessionId);
  if (!row) throw notFound("Session", sessionId);
  return row;
}

export async function listSpeakers(app: AppContext, sessionId: string): Promise<SpeakerRow[]> {
  return app.db.select<SpeakerRow>("session_speaker", { session_id: sessionId }, { orderBy: "sort_order, added_at" });
}

/** Speakers who still count — `replaced` and `withdrawn` are historical. */
export async function liveSpeakers(app: AppContext, sessionId: string): Promise<SpeakerRow[]> {
  const rows = await listSpeakers(app, sessionId);
  return rows.filter((r) => str(r.confirmation_status) !== "replaced" && str(r.confirmation_status) !== "withdrawn");
}

export function speakerViews(rows: SpeakerRow[]): SpeakerView[] {
  return rows.map((r) => ({
    person_id: str(r.person_id),
    speaker_role: str(r.speaker_role) as SpeakerRole,
    confirmation_status: str(r.confirmation_status) as SpeakerConfirmationStatus,
  }));
}

export async function formatLimits(app: AppContext, formatId: string): Promise<FormatLimits> {
  const fmt = await app.db.byId<Row>("session_format", formatId);
  if (!fmt) return {};
  return {
    name: str(fmt.name),
    min_duration_minutes: fmt.min_duration_minutes === null ? null : num(fmt.min_duration_minutes, 0) || null,
    max_duration_minutes: fmt.max_duration_minutes === null ? null : num(fmt.max_duration_minutes, 0) || null,
    max_speakers: fmt.max_speakers === null ? null : num(fmt.max_speakers, 0) || null,
  };
}

export async function listRevisions(app: AppContext, sessionId: string): Promise<Row[]> {
  return app.db.select<Row>("session_revision", { session_id: sessionId }, { orderBy: "revision_number DESC" });
}

export async function listSessionAssets(app: AppContext, sessionId: string): Promise<Row[]> {
  return app.db.select<Row>("session_asset", { session_id: sessionId });
}

export async function listRelations(app: AppContext, sessionId: string): Promise<Row[]> {
  return app.db.select<Row>("session_relation", { session_id: sessionId }, { orderBy: "sort_order" });
}

/* -------------------------------------------------------------------------- */
/* Derived: content_diverged (R14 / INV-06-9)                                  */
/* -------------------------------------------------------------------------- */

/**
 * The snapshot the decision was made against: the proposal's content, with the
 * decision's `assigned_*` overrides applied. Editing a proposal after a session
 * exists never mutates the session (INV-06-9), so this is a comparison, never a
 * merge.
 */
export async function decisionBaseline(app: AppContext, session: SessionRow): Promise<ContentSnapshot | null> {
  if (!session.proposal_id) return null;
  const proposal = await app.db.byId<Row>("proposal", str(session.proposal_id));
  if (!proposal) return null;
  const decisions = await app.db.select<Row>(
    "decision",
    { proposal_id: str(session.proposal_id), status: "published" },
    { orderBy: "decided_at DESC", limit: 1 },
  );
  const decision = decisions[0] ?? null;
  return {
    title: str(proposal.title),
    abstract: str(proposal.abstract),
    description: strOrNull(proposal.description),
    session_format_id: str(decision?.assigned_format_id ?? proposal.session_format_id ?? ""),
    // See `baselineDuration` in views.ts: `num(null, fallback)` is 0, so a
    // proposal with no requested duration must fall back explicitly.
    duration_minutes:
      (decision?.assigned_duration_minutes ?? proposal.requested_duration_minutes) === null ||
      (decision?.assigned_duration_minutes ?? proposal.requested_duration_minutes) === undefined
        ? num(session.duration_minutes)
        : num(decision?.assigned_duration_minutes ?? proposal.requested_duration_minutes),
    track_id: strOrNull(decision?.assigned_track_id ?? proposal.assigned_track_id ?? proposal.track_id),
  };
}

export async function isContentDiverged(app: AppContext, session: SessionRow): Promise<boolean> {
  const baseline = await decisionBaseline(app, session);
  return contentDiverged(sessionContent(session), baseline);
}

export function sessionContent(session: Row): ContentSnapshot {
  const snap = contentSnapshot(session);
  snap.keywords = parseJson<string[]>(session.keywords, []);
  return snap;
}

/* -------------------------------------------------------------------------- */
/* Revisions (INV-06-13)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * INV-06-13 — every change to a session's content fields writes exactly one
 * `SessionRevision` with a full snapshot. Append-only: no revision is ever
 * mutated or deleted.
 */
export async function writeRevision(
  app: AppContext,
  sessionId: string,
  input: {
    change_kind: RevisionChangeKind;
    diff: Record<string, unknown>;
    snapshot: ContentSnapshot;
    restored_from_revision_id?: string | null;
    changed_by_person_id?: string | null;
  },
): Promise<number> {
  const last = await app.db.select<Row>("session_revision", { session_id: sessionId }, {
    orderBy: "revision_number DESC",
    limit: 1,
  });
  const revisionNumber = num(last[0]?.revision_number, 0) + 1;
  await app.db.insert("session_revision", {
    id: newId("SessionRevision"),
    session_id: sessionId,
    revision_number: revisionNumber,
    changed_by_person_id: input.changed_by_person_id ?? app.actor.id ?? "system",
    change_kind: input.change_kind,
    diff: JSON.stringify(input.diff),
    snapshot: JSON.stringify(input.snapshot),
    restored_from_revision_id: input.restored_from_revision_id ?? null,
    created_at: app.now(),
  });
  return revisionNumber;
}

export async function latestRevisionNumber(app: AppContext, sessionId: string): Promise<number> {
  const last = await app.db.select<Row>("session_revision", { session_id: sessionId }, {
    orderBy: "revision_number DESC",
    limit: 1,
  });
  return num(last[0]?.revision_number, 0);
}

/* -------------------------------------------------------------------------- */
/* Creation — three explicit, audited commands (06, "Creation")                */
/* -------------------------------------------------------------------------- */

interface InsertSessionInput {
  event_id: string;
  proposal_id?: string | null;
  reference: string;
  origin: SessionOrigin;
  title: string;
  subtitle?: string | null;
  abstract: string;
  description?: string | null;
  session_format_id: string;
  track_id?: string | null;
  duration_minutes: number;
  audience_level?: string | null;
  keywords?: string[];
  language?: string | null;
  sponsor_id?: string | null;
  av_requirements?: string[];
  recording_consent?: string;
  capacity_override?: number | null;
  registration_url?: string | null;
  visibility?: SessionVisibility;
  status: SessionStatus;
}

async function insertSession(app: AppContext, input: InsertSessionInput): Promise<SessionRow> {
  assertSponsorShape(input.origin, input.sponsor_id ?? null);
  const limits = await formatLimits(app, input.session_format_id);
  assertDurationWithinFormat(input.duration_minutes, limits); // INV-06-6

  const id = newId("Session");
  const now = app.now();
  const row: Row = {
    id,
    org_id: app.orgId,
    event_id: input.event_id,
    proposal_id: input.proposal_id ?? null,
    reference: input.reference,
    origin: input.origin,
    title: input.title,
    subtitle: input.subtitle ?? null,
    abstract: input.abstract,
    description: input.description ?? null,
    session_format_id: input.session_format_id,
    track_id: input.track_id ?? null,
    duration_minutes: input.duration_minutes,
    audience_level: input.audience_level ?? null,
    keywords: JSON.stringify(input.keywords ?? []),
    language: input.language ?? null,
    sponsor_id: input.sponsor_id ?? null,
    av_requirements: JSON.stringify(input.av_requirements ?? []),
    recording_consent: input.recording_consent ?? "unanswered",
    capacity_override: input.capacity_override ?? null,
    registration_url: input.registration_url ?? null,
    status: input.status,
    content_status: "draft",
    visibility: input.visibility ?? "public",
    created_at: now,
    updated_at: now,
    row_version: 1,
  };
  await app.db.insert("session", row);
  return row as SessionRow;
}

/**
 * `Session.reference` "reuses the proposal's when there is one"; otherwise it
 * comes from the same per-event counter, so an organizer-created keynote reads
 * like everything else on the run sheet.
 */
export async function allocateReference(app: AppContext, eventId: string): Promise<string> {
  const counter = await app.db.raw<Row>("SELECT * FROM event_reference_counter WHERE event_id = ?", [eventId]);
  if (counter.length === 0) {
    const ev = await app.db.byId<Row>("event", eventId);
    const { eventCodeFromSlug, formatReference } = await import("@podiumconf/domain/shared/ids.js");
    const code = eventCodeFromSlug(str(ev?.slug, "event"));
    await app.db.rawRun(
      "INSERT INTO event_reference_counter (event_id, event_code, next_value) VALUES (?, ?, ?)",
      [eventId, code, 2],
    );
    return formatReference(code, 1);
  }
  const code = str(counter[0].event_code, "EV");
  const next = num(counter[0].next_value, 1);
  await app.db.rawRun("UPDATE event_reference_counter SET next_value = next_value + 1 WHERE event_id = ?", [eventId]);
  const { formatReference } = await import("@podiumconf/domain/shared/ids.js");
  return formatReference(code, next);
}

function emitCreated(app: AppContext, session: SessionRow, speakerPersonIds: string[]): void {
  app.events.emit({
    type: "session.created",
    subject: { type: "session", id: session.id },
    event_id: session.event_id,
    data: {
      session_id: session.id,
      proposal_id: session.proposal_id ?? null,
      origin: session.origin,
      title: session.title,
      format_id: session.session_format_id,
      track_id: session.track_id ?? null,
      sponsor_id: session.sponsor_id ?? null,
      speaker_person_ids: speakerPersonIds,
    },
  });
}

/**
 * `CreateSessionFromProposal` — fires on `decision.published` with
 * `outcome = accept`, or manually. Copies content, format, duration and track
 * **from the decision** (which may have overridden the proposal), copies
 * speakers as `pending`, and links `proposal_id`. Onboarding materialises off
 * the `session.created` event.
 */
export async function createSessionFromProposal(
  app: AppContext,
  input: { proposal_id: string; decision_id?: string | null },
): Promise<SessionRow> {
  const proposal = await app.db.byId<Row>("proposal", input.proposal_id);
  if (!proposal) throw notFound("Proposal", input.proposal_id);

  // INV-06-1: a proposal has at most one non-cancelled session. This is also a
  // unique index, but the friendly error belongs here — and it is what makes a
  // redelivered `decision.published` a no-op rather than a duplicate.
  const existing = await app.db.select<SessionRow>("session", { proposal_id: input.proposal_id });
  const live = existing.find((s) => str(s.status) !== "cancelled");
  if (live) return live;

  const decision = input.decision_id
    ? await app.db.byId<Row>("decision", input.decision_id)
    : (
        await app.db.select<Row>(
          "decision",
          { proposal_id: input.proposal_id, status: "published" },
          { orderBy: "decided_at DESC", limit: 1 },
        )
      )[0] ?? null;

  const formatId = str(decision?.assigned_format_id ?? proposal.session_format_id);
  if (!formatId) {
    throw new DomainError({
      code: "format_required",
      message: "This proposal has no session format, and the decision did not assign one.",
      status: 422,
    });
  }
  const limits = await formatLimits(app, formatId);
  const duration =
    num(decision?.assigned_duration_minutes, 0) ||
    num(proposal.requested_duration_minutes, 0) ||
    num((await app.db.byId<Row>("session_format", formatId))?.default_duration_minutes, 30);

  const session = await insertSession(app, {
    event_id: str(proposal.event_id),
    proposal_id: str(proposal.id),
    reference: str(proposal.reference),
    origin: (str(proposal.origin, "cfp") as SessionOrigin) || "cfp",
    title: str(proposal.title),
    abstract: str(proposal.abstract),
    description: strOrNull(proposal.description),
    session_format_id: formatId,
    track_id: strOrNull(decision?.assigned_track_id ?? proposal.assigned_track_id ?? proposal.track_id),
    duration_minutes: duration,
    audience_level: strOrNull(proposal.audience_level),
    keywords: parseJson<string[]>(proposal.keywords, []),
    language: strOrNull(proposal.language),
    sponsor_id: strOrNull(proposal.sponsor_id),
    av_requirements: parseJson<string[]>(proposal.av_requirements, []),
    recording_consent: str(proposal.recording_consent, "unanswered"),
    status: "pending_confirmation", // [*] --> pending_confirmation: created from accepted proposal
  });
  void limits;

  // Speakers are copied as `pending`: acceptance is the committee's decision,
  // confirmation is the speaker's.
  const proposalSpeakers = await app.db.select<Row>(
    "proposal_speaker",
    { proposal_id: str(proposal.id) },
    { orderBy: "sort_order" },
  );
  const now = app.now();
  const personIds: string[] = [];
  for (const [i, ps] of proposalSpeakers.entries()) {
    if (str(ps.participation_status) === "removed" || str(ps.participation_status) === "declined") continue;
    personIds.push(str(ps.person_id));
    await app.db.insert("session_speaker", {
      id: newId("SessionSpeaker"),
      session_id: session.id,
      person_id: str(ps.person_id),
      speaker_role: str(ps.speaker_role, "primary"),
      sort_order: num(ps.sort_order, i),
      confirmation_status: "pending",
      is_public: 1,
      added_at: now,
    });
  }

  await app.db.update("proposal", str(proposal.id), { session_id: session.id, updated_at: now });

  await writeRevision(app, session.id, {
    change_kind: "decision_import",
    diff: {},
    snapshot: sessionContent(session),
  });

  emitCreated(app, session, personIds);
  app.audit.record({
    action: "session.create_from_proposal",
    entity_type: "session",
    entity_id: session.id,
    after: { proposal_id: str(proposal.id), decision_id: decision ? str(decision.id) : null, reference: session.reference },
  });

  // A sponsor proposal with no speakers is confirmed on creation (INV-06-4).
  await evaluateConfirmation(app, session.id);
  return session;
}

/**
 * `CreateSponsorSession` — sets `sponsor_id`, and may start with zero speakers:
 * "name your speaker" becomes a blocking onboarding task. Spending the
 * entitlement is Sponsorship's reaction to `session.created`, not ours.
 */
export async function createSponsorSession(
  app: AppContext,
  input: {
    event_id: string;
    sponsor_id: string;
    title: string;
    abstract: string;
    description?: string | null;
    subtitle?: string | null;
    session_format_id: string;
    track_id?: string | null;
    duration_minutes: number;
    speakers?: { person_id?: string; full_name?: string; email?: string; speaker_role?: SpeakerRole }[];
    visibility?: SessionVisibility;
  },
): Promise<SessionRow> {
  // INV-06-2: the sponsor must have a confirmed sponsorship for this event.
  const sponsorship = await app.db.first<Row>("sponsorship", {
    sponsor_id: input.sponsor_id,
    event_id: input.event_id,
  });
  if (!sponsorship || str(sponsorship.status) !== "confirmed") {
    throw invariantError(
      "INV-06-2",
      "sponsorship_not_confirmed",
      "A sponsor session needs a confirmed sponsorship for this event.",
      { sponsor_id: input.sponsor_id, event_id: input.event_id },
    );
  }

  const session = await insertSession(app, {
    ...input,
    origin: "sponsor",
    reference: await allocateReference(app, input.event_id),
    status: "confirmed", // [*] --> confirmed: created directly (contracted sponsor)
  });

  const personIds = await addSpeakerRows(app, session, input.speakers ?? []);
  await writeRevision(app, session.id, { change_kind: "organizer_edit", diff: {}, snapshot: sessionContent(session) });
  emitCreated(app, session, personIds);
  app.audit.record({
    action: "session.create_sponsor",
    entity_type: "session",
    entity_id: session.id,
    after: { sponsor_id: input.sponsor_id, reference: session.reference },
  });

  // With speakers named but unconfirmed the contract is ahead of the humans:
  // fall back to pending_confirmation rather than claiming they agreed.
  const speakers = await liveSpeakers(app, session.id);
  const check = confirmationCheck("sponsor", speakerViews(speakers));
  if (!check.confirmable) {
    await app.db.update("session", session.id, { status: "pending_confirmation", updated_at: app.now() });
    session.status = "pending_confirmation";
  } else {
    emitConfirmed(app, session);
  }
  return session;
}

/**
 * `CreateProgramItem` — an organizer creates a break, keynote or registration
 * block directly. No proposal, `origin = organizer`, review not applicable.
 */
export async function createProgramItem(
  app: AppContext,
  input: {
    event_id: string;
    title: string;
    abstract?: string;
    description?: string | null;
    subtitle?: string | null;
    session_format_id: string;
    track_id?: string | null;
    duration_minutes: number;
    visibility?: SessionVisibility;
    speakers?: { person_id?: string; full_name?: string; email?: string; speaker_role?: SpeakerRole }[];
  },
): Promise<SessionRow> {
  const session = await insertSession(app, {
    ...input,
    abstract: input.abstract ?? "",
    origin: "organizer",
    reference: await allocateReference(app, input.event_id),
    status: "confirmed", // [*] --> confirmed: created directly (organizer)
  });
  const personIds = await addSpeakerRows(app, session, input.speakers ?? []);
  await writeRevision(app, session.id, { change_kind: "organizer_edit", diff: {}, snapshot: sessionContent(session) });
  emitCreated(app, session, personIds);
  app.audit.record({
    action: "session.create_program_item",
    entity_type: "session",
    entity_id: session.id,
    after: { title: session.title, reference: session.reference },
  });
  emitConfirmed(app, session);
  return session;
}

async function addSpeakerRows(
  app: AppContext,
  session: SessionRow,
  speakers: { person_id?: string; full_name?: string; email?: string; speaker_role?: SpeakerRole }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, s] of speakers.entries()) {
    let personId = s.person_id ?? null;
    if (!personId && s.email) {
      const person = await findOrCreatePerson(app, {
        email: s.email,
        full_name: s.full_name ?? s.email,
        is_placeholder: true,
        source: "session",
      });
      personId = person.id;
    }
    if (!personId) continue;
    await app.db.insert("session_speaker", {
      id: newId("SessionSpeaker"),
      session_id: session.id,
      person_id: personId,
      speaker_role: s.speaker_role ?? (i === 0 ? "primary" : "co_speaker"),
      sort_order: i,
      confirmation_status: "pending",
      is_public: 1,
      added_at: app.now(),
    });
    ids.push(personId);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Content editing                                                             */
/* -------------------------------------------------------------------------- */

export interface UpdateContentOptions {
  change_kind?: RevisionChangeKind;
  expected_version?: number | null;
}

/**
 * The one path that edits a session's content.
 *
 *   * INV-06-13 — writes exactly one `SessionRevision` with a full snapshot.
 *   * INV-06-12 — editing any published content field of an `approved` session
 *     returns it to `draft` and clears the approver, in the same transaction.
 *   * INV-06-9 — never touches the linked proposal.
 *   * INV-06-6 — duration stays within the format's min/max.
 */
export async function updateSessionContent(
  app: AppContext,
  sessionId: string,
  patch: Record<string, unknown>,
  opts: UpdateContentOptions = {},
): Promise<{ session: SessionRow; changed: string[]; approval_revoked: boolean }> {
  const session = await getSession(app, sessionId);
  const before = sessionContent(session);

  const update: Row = {};
  for (const f of REVISION_CONTENT_FIELDS) {
    if (!(f in patch)) continue;
    const value = patch[f];
    if (f === "keywords") {
      update[f] = JSON.stringify(Array.isArray(value) ? value : []);
    } else if (f === "duration_minutes") {
      update[f] = num(value, num(session.duration_minutes));
    } else {
      update[f] = value === "" || value === undefined ? null : value;
    }
  }
  // Delivery fields carry no editorial weight and no revision.
  for (const f of ["av_requirements", "recording_consent", "recording_url", "capacity_override", "registration_url", "slides_asset_id", "visibility"]) {
    if (f in patch) update[f] = f === "av_requirements" ? JSON.stringify(patch[f] ?? []) : patch[f] ?? null;
  }
  if (Object.keys(update).length === 0) return { session, changed: [], approval_revoked: false };

  const merged: Row = { ...session, ...update };
  if ("session_format_id" in update || "duration_minutes" in update) {
    const limits = await formatLimits(app, str(merged.session_format_id));
    assertDurationWithinFormat(num(merged.duration_minutes), limits); // INV-06-6
  }

  const after = sessionContent(merged);
  const diff = diffContent(before, after);
  const changed = Object.keys(diff);
  const gated = touchesApprovedContent(diff);

  // INV-06-12: an approval granted on Monday must not silently endorse
  // Thursday's rewrite. Same transaction, always.
  let approvalRevoked = false;
  if (str(session.content_status) === "approved" && gated.length > 0) {
    update.content_status = "draft";
    update.content_approved_by_person_id = null;
    update.content_approved_at = null;
    approvalRevoked = true;
  }

  update.updated_at = app.now();
  if (opts.expected_version !== undefined && opts.expected_version !== null) {
    await app.db.updateVersioned("session", sessionId, opts.expected_version, update);
  } else {
    await app.db.update("session", sessionId, update);
  }

  if (changed.length > 0) {
    // INV-06-13 — exactly one revision per content change, with a full snapshot.
    await writeRevision(app, sessionId, {
      change_kind: opts.change_kind ?? "organizer_edit",
      diff,
      snapshot: after,
    });
  }

  const updated = await getSession(app, sessionId);
  if (changed.length > 0) {
    app.events.emit({
      type: "session.updated",
      subject: { type: "session", id: sessionId },
      event_id: str(session.event_id),
      data: { session_id: sessionId, changed_fields: changed },
    });
  }
  if (approvalRevoked) {
    app.events.emit({
      type: "session.content_approval_revoked",
      subject: { type: "session", id: sessionId },
      event_id: str(session.event_id),
      data: { session_id: sessionId, changed_fields: gated, changed_by_person_id: app.actor.id ?? null },
    });
  }
  app.audit.record({
    action: "session.update",
    entity_type: "session",
    entity_id: sessionId,
    before: pick(before, changed),
    after: pick(after, changed),
  });
  return { session: updated, changed, approval_revoked: approvalRevoked };
}

function pick(snapshot: ContentSnapshot, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = snapshot[f];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Content approval (INV-06-11, INV-06-12)                                     */
/* -------------------------------------------------------------------------- */

async function moveContentStatus(
  app: AppContext,
  sessionId: string,
  to: ContentStatus,
  extra: Row = {},
): Promise<SessionRow> {
  const session = await getSession(app, sessionId);
  const from = str(session.content_status) as ContentStatus;
  assertContentTransition(from, to); // `draft → approved` is not drawn: review first.
  await app.db.update("session", sessionId, { content_status: to, updated_at: app.now(), ...extra });
  return { ...session, content_status: to, ...extra } as SessionRow;
}

export async function submitContentForReview(app: AppContext, sessionId: string): Promise<void> {
  const session = await moveContentStatus(app, sessionId, "in_review");
  await writeRevision(app, sessionId, {
    change_kind: "approval_change",
    diff: { content_status: { from: "draft or changes_requested", to: "in_review" } },
    snapshot: sessionContent(session),
  });
  app.audit.record({
    action: "session.content_submit_for_review",
    entity_type: "session",
    entity_id: sessionId,
    after: { content_status: "in_review" },
  });
}

/** Approval answers "have we done ours"; blocking tasks answer the speaker's half. */
export async function approveContent(app: AppContext, sessionId: string): Promise<void> {
  const now = app.now();
  const session = await moveContentStatus(app, sessionId, "approved", {
    content_approved_by_person_id: app.actor.id ?? "system",
    content_approved_at: now,
  });
  const revisionNumber = await writeRevision(app, sessionId, {
    change_kind: "approval_change",
    diff: { content_status: { from: "in_review", to: "approved" } },
    snapshot: sessionContent(session),
  });
  app.events.emit({
    type: "session.content_approved",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId, approved_by_person_id: app.actor.id ?? null, revision_number: revisionNumber },
  });
  app.audit.record({
    action: "session.content_approve",
    entity_type: "session",
    entity_id: sessionId,
    after: { content_status: "approved", revision_number: revisionNumber },
  });
}

export async function requestContentChanges(app: AppContext, sessionId: string, note: string): Promise<void> {
  const session = await moveContentStatus(app, sessionId, "changes_requested");
  await writeRevision(app, sessionId, {
    change_kind: "approval_change",
    diff: { content_status: { from: "in_review", to: "changes_requested" }, note: { from: null, to: note } },
    snapshot: sessionContent(session),
  });
  app.audit.record({
    action: "session.content_request_changes",
    entity_type: "session",
    entity_id: sessionId,
    after: { content_status: "changes_requested" },
    reason: note,
  });
}

/* -------------------------------------------------------------------------- */
/* Restore (forward, always)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * "Restore is a forward operation." Restoring revision 4 writes revision 9
 * whose content equals revision 4's snapshot, with `restored_from_revision_id`
 * pointing back. History is never rewound, only extended.
 *
 * Restore covers content fields only: it never changes `status`,
 * `content_status`, placement, speakers or assets.
 */
export async function restoreRevision(app: AppContext, sessionId: string, revisionId: string): Promise<number> {
  const session = await getSession(app, sessionId);
  const revision = await app.db.byId<Row>("session_revision", revisionId);
  if (!revision || str(revision.session_id) !== sessionId) throw notFound("Session revision", revisionId);

  const snapshot = parseJson<ContentSnapshot>(revision.snapshot, {});
  const before = sessionContent(session);
  const update: Row = {};
  for (const f of REVISION_CONTENT_FIELDS) {
    if (!(f in snapshot)) continue;
    update[f] = f === "keywords" ? JSON.stringify(snapshot[f] ?? []) : (snapshot[f] ?? null);
  }
  const merged: Row = { ...session, ...update };
  const after = sessionContent(merged);
  const diff = diffContent(before, after);

  // INV-06-12 applies to a restore exactly as it does to a hand edit.
  const gated = touchesApprovedContent(diff);
  let approvalRevoked = false;
  if (str(session.content_status) === "approved" && gated.length > 0) {
    update.content_status = "draft";
    update.content_approved_by_person_id = null;
    update.content_approved_at = null;
    approvalRevoked = true;
  }
  update.updated_at = app.now();
  await app.db.update("session", sessionId, update);

  const revisionNumber = await writeRevision(app, sessionId, {
    change_kind: "restore",
    diff,
    snapshot: after,
    restored_from_revision_id: revisionId,
  });

  app.events.emit({
    type: "session.content_restored",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: {
      session_id: sessionId,
      revision_number: revisionNumber,
      restored_from_revision_id: revisionId,
      restored_by_person_id: app.actor.id ?? null,
    },
  });
  if (Object.keys(diff).length > 0) {
    app.events.emit({
      type: "session.updated",
      subject: { type: "session", id: sessionId },
      event_id: str(session.event_id),
      data: { session_id: sessionId, changed_fields: Object.keys(diff) },
    });
  }
  if (approvalRevoked) {
    app.events.emit({
      type: "session.content_approval_revoked",
      subject: { type: "session", id: sessionId },
      event_id: str(session.event_id),
      data: { session_id: sessionId, changed_fields: gated, changed_by_person_id: app.actor.id ?? null },
    });
  }
  app.audit.record({
    action: "session.restore_revision",
    entity_type: "session",
    entity_id: sessionId,
    before: pick(before, Object.keys(diff)),
    after: pick(after, Object.keys(diff)),
    reason: `Restored revision ${num(revision.revision_number)}`,
  });
  return revisionNumber;
}

/* -------------------------------------------------------------------------- */
/* Speakers                                                                    */
/* -------------------------------------------------------------------------- */

export async function addSpeaker(
  app: AppContext,
  sessionId: string,
  input: {
    person_id?: string;
    full_name?: string;
    email?: string;
    speaker_role?: SpeakerRole;
    attendance_mode?: string | null;
    is_public?: boolean;
    override_reason?: string | null;
  },
): Promise<string> {
  const session = await getSession(app, sessionId);
  let personId = input.person_id ?? null;
  if (!personId && input.email) {
    const person = await findOrCreatePerson(app, {
      email: input.email,
      full_name: input.full_name ?? input.email,
      is_placeholder: true,
      source: "session",
    });
    personId = person.id;
  }
  if (!personId) {
    throw new DomainError({ code: "person_required", message: "Name a person, or give a name and email.", status: 422 });
  }

  const existing = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: personId });
  if (existing) {
    // INV-06-3: one SessionSpeaker per (session, person).
    throw invariantError("INV-06-3", "speaker_already_credited", "That person is already credited on this session.", {
      session_id: sessionId,
      person_id: personId,
    });
  }

  const current = await liveSpeakers(app, sessionId);
  const limits = await formatLimits(app, str(session.session_format_id));
  // INV-06-3: the count may exceed max_speakers only with a recorded override
  // reason; the reason lands on the audit row (INV-11-5).
  assertSpeakerLimit(current.length + 1, limits, input.override_reason);

  const id = newId("SessionSpeaker");
  await app.db.insert("session_speaker", {
    id,
    session_id: sessionId,
    person_id: personId,
    speaker_role: input.speaker_role ?? "co_speaker",
    sort_order: current.length,
    confirmation_status: "pending",
    is_public: input.is_public === false ? 0 : 1,
    attendance_mode: input.attendance_mode ?? null,
    added_at: app.now(),
  });
  app.audit.record({
    action: "session_speaker.add",
    entity_type: "session",
    entity_id: sessionId,
    after: { person_id: personId, speaker_role: input.speaker_role ?? "co_speaker" },
    reason: input.override_reason ?? undefined,
  });
  return personId;
}

export async function updateSpeaker(
  app: AppContext,
  sessionId: string,
  personId: string,
  patch: { speaker_role?: SpeakerRole; is_public?: boolean; travel_status?: string | null; attendance_mode?: string | null; sort_order?: number },
): Promise<void> {
  const row = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: personId });
  if (!row) throw notFound("Session speaker", personId);
  const update: Row = {};
  if (patch.speaker_role) update.speaker_role = patch.speaker_role;
  if (patch.is_public !== undefined) update.is_public = patch.is_public ? 1 : 0;
  if (patch.travel_status !== undefined) update.travel_status = patch.travel_status;
  if (patch.attendance_mode !== undefined) update.attendance_mode = patch.attendance_mode;
  if (patch.sort_order !== undefined) update.sort_order = patch.sort_order;
  if (Object.keys(update).length === 0) return;
  await app.db.update("session_speaker", str(row.id), update);
  app.audit.record({ action: "session_speaker.update", entity_type: "session", entity_id: sessionId, after: { person_id: personId, ...update } });
}

export async function confirmSpeaker(app: AppContext, sessionId: string, personId: string): Promise<void> {
  const row = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: personId });
  if (!row) throw notFound("Session speaker", personId);
  if (str(row.confirmation_status) === "confirmed") return;
  const session = await getSession(app, sessionId);
  await app.db.update("session_speaker", str(row.id), { confirmation_status: "confirmed", confirmed_at: app.now(), declined_at: null });
  app.events.emit({
    type: "session_speaker.confirmed",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId, person_id: personId, speaker_role: str(row.speaker_role) },
  });
  app.audit.record({ action: "session_speaker.confirm", entity_type: "session", entity_id: sessionId, after: { person_id: personId } });
}

export async function declineSpeaker(app: AppContext, sessionId: string, personId: string, reason: string): Promise<void> {
  const row = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: personId });
  if (!row) throw notFound("Session speaker", personId);
  const session = await getSession(app, sessionId);
  await app.db.update("session_speaker", str(row.id), { confirmation_status: "declined", declined_at: app.now() });
  app.events.emit({
    type: "session_speaker.declined",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId, person_id: personId, reason },
  });
  app.audit.record({
    action: "session_speaker.decline",
    entity_type: "session",
    entity_id: sessionId,
    after: { person_id: personId },
    reason,
  });
}

/**
 * **Speaker substitution is one command**, not delete-and-add.
 *
 * "Doing it in three steps means step three gets forgotten and a former speaker
 * keeps portal access." The replacement preserves the trail
 * (`replaced_by_person_id`), transfers the outgoing speaker's incomplete task
 * instances to the incoming one, and revokes the outgoing person's
 * relationship-derived access in the same transaction (INV-06-10).
 *
 * `transferTasks` is injected by the caller so Program does not read
 * Onboarding's tables; the route and the reaction both pass Onboarding's
 * `transferInstances`.
 */
export async function replaceSpeaker(
  app: AppContext,
  sessionId: string,
  outgoingPersonId: string,
  incoming: { person_id?: string; full_name?: string; email?: string; speaker_role?: SpeakerRole },
  transferTasks: (app: AppContext, sessionId: string, from: string, to: string) => Promise<number>,
): Promise<{ incoming_person_id: string; transferred_task_count: number }> {
  const session = await getSession(app, sessionId);
  const outgoing = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: outgoingPersonId });
  if (!outgoing) throw notFound("Session speaker", outgoingPersonId);

  let incomingId = incoming.person_id ?? null;
  if (!incomingId && incoming.email) {
    const person = await findOrCreatePerson(app, {
      email: incoming.email,
      full_name: incoming.full_name ?? incoming.email,
      is_placeholder: true,
      source: "session",
    });
    incomingId = person.id;
  }
  if (!incomingId) {
    throw new DomainError({ code: "person_required", message: "Name the incoming speaker, or give a name and email.", status: 422 });
  }
  if (incomingId === outgoingPersonId) {
    throw new DomainError({ code: "invalid_replacement", message: "A speaker cannot replace themselves.", status: 422 });
  }

  const now = app.now();
  // INV-06-10: `replaced` is what ends the relationship, and with it every
  // relationship-derived permission — `loadRelationships` filters on it, so the
  // revocation is effective on the outgoing person's very next request.
  await app.db.update("session_speaker", str(outgoing.id), {
    confirmation_status: "replaced",
    replaced_by_person_id: incomingId,
  });

  const existingIncoming = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: incomingId });
  if (existingIncoming) {
    await app.db.update("session_speaker", str(existingIncoming.id), {
      speaker_role: incoming.speaker_role ?? str(outgoing.speaker_role),
      confirmation_status: "pending",
    });
  } else {
    await app.db.insert("session_speaker", {
      id: newId("SessionSpeaker"),
      session_id: sessionId,
      person_id: incomingId,
      speaker_role: incoming.speaker_role ?? str(outgoing.speaker_role),
      sort_order: num(outgoing.sort_order, 0),
      confirmation_status: "pending",
      is_public: bool(outgoing.is_public) ? 1 : 0,
      attendance_mode: strOrNull(outgoing.attendance_mode),
      added_at: now,
    });
  }

  const transferred = await transferTasks(app, sessionId, outgoingPersonId, incomingId);

  app.events.emit({
    type: "session_speaker.replaced",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: {
      session_id: sessionId,
      outgoing_person_id: outgoingPersonId,
      incoming_person_id: incomingId,
      transferred_task_count: transferred,
    },
  });
  app.audit.record({
    action: "session_speaker.replace",
    entity_type: "session",
    entity_id: sessionId,
    before: { person_id: outgoingPersonId },
    after: { person_id: incomingId, transferred_task_count: transferred },
  });
  return { incoming_person_id: incomingId, transferred_task_count: transferred };
}

/** Removing a speaker ends the relationship; INV-07-8 cancels their tasks. */
export async function removeSpeaker(app: AppContext, sessionId: string, personId: string, reason: string): Promise<void> {
  const row = await app.db.first<SpeakerRow>("session_speaker", { session_id: sessionId, person_id: personId });
  if (!row) throw notFound("Session speaker", personId);
  const session = await getSession(app, sessionId);
  await app.db.update("session_speaker", str(row.id), { confirmation_status: "withdrawn" });
  app.events.emit({
    type: "session_speaker.declined",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId, person_id: personId, reason },
  });
  app.audit.record({
    action: "session_speaker.remove",
    entity_type: "session",
    entity_id: sessionId,
    before: { person_id: personId },
    reason,
  });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

function emitConfirmed(app: AppContext, session: SessionRow): void {
  app.events.emit({
    type: "session.confirmed",
    subject: { type: "session", id: session.id },
    event_id: str(session.event_id),
    data: { session_id: session.id },
  });
}

/**
 * `pending_confirmation → confirmed` requires every `primary` speaker to be
 * `confirmed` and co-speakers to be `confirmed` or `declined` (INV-06-4). Run
 * after every speaker answer; a no-op when the session has already moved on.
 */
export async function evaluateConfirmation(app: AppContext, sessionId: string): Promise<boolean> {
  const session = await getSession(app, sessionId);
  if (str(session.status) !== "pending_confirmation") return false;
  const speakers = await liveSpeakers(app, sessionId);
  const check = confirmationCheck(str(session.origin) as SessionOrigin, speakerViews(speakers));
  if (!check.confirmable) return false;

  assertSessionTransition("pending_confirmation", "confirmed");
  await app.db.update("session", sessionId, { status: "confirmed", updated_at: app.now() });
  emitConfirmed(app, { ...session, status: "confirmed" } as SessionRow);
  app.audit.record({
    action: "session.confirm",
    entity_type: "session",
    entity_id: sessionId,
    before: { status: "pending_confirmation" },
    after: { status: "confirmed" },
  });
  return true;
}

/**
 * The generic transition, for the arrows nobody else owns. Scheduling drives
 * `confirmed ↔ scheduled` and `scheduled ↔ published`; it goes through here so
 * one table of arrows governs them all.
 */
export async function transitionSession(
  app: AppContext,
  sessionId: string,
  to: SessionStatus,
  extra: Row = {},
): Promise<void> {
  const session = await getSession(app, sessionId);
  const from = str(session.status) as SessionStatus;
  if (from === to) return;
  assertSessionTransition(from, to);
  await app.db.update("session", sessionId, { status: to, updated_at: app.now(), ...extra });
  app.audit.record({
    action: `session.${to}`,
    entity_type: "session",
    entity_id: sessionId,
    before: { status: from },
    after: { status: to },
  });
}

/**
 * INV-06-7 — cancelling releases its placement, cancels its open task
 * instances, releases any spent entitlement, and records a schedule diff if it
 * was published. All four are consumers of `session.cancelled`: the fact is
 * ours, the consequences are theirs.
 */
export async function cancelSession(app: AppContext, sessionId: string, reason: string): Promise<void> {
  const session = await getSession(app, sessionId);
  const from = str(session.status) as SessionStatus;
  if (from === "cancelled") return;
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new DomainError({ code: "reason_required", message: "Say why this session is being cancelled.", status: 422 });
  }
  assertSessionTransition(from, "cancelled");
  const wasPublished = from === "published" || !!session.published_at;
  await app.db.update("session", sessionId, {
    status: "cancelled",
    cancellation_reason: trimmed,
    updated_at: app.now(),
  });
  app.events.emit({
    type: "session.cancelled",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId, reason: trimmed, was_published: wasPublished },
  });
  app.audit.record({
    action: "session.cancel",
    entity_type: "session",
    entity_id: sessionId,
    before: { status: from },
    after: { status: "cancelled" },
    reason: trimmed, // INV-11-5
  });
}

/**
 * `delivered` is set by a scheduled job after the placement's end time passes,
 * so post-event flows have a state to hang off. The only drawn arrow into it is
 * from `published`.
 */
export async function markDelivered(app: AppContext, sessionId: string): Promise<void> {
  const session = await getSession(app, sessionId);
  if (str(session.status) !== "published") return;
  await transitionSession(app, sessionId, "delivered");
  app.events.emit({
    type: "session.delivered",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId },
  });
}

/**
 * INV-06-5 / INV-06-11 — the chair knowingly publishes past a gate, with a
 * reason. Audited, because it is an override.
 */
export async function setPublicationOverride(app: AppContext, sessionId: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw invariantError("INV-06-5", "override_reason_required", "A publication override has to say why.");
  }
  await app.db.update("session", sessionId, { publication_override_reason: trimmed, updated_at: app.now() });
  app.audit.record({
    action: "session.publication_override",
    entity_type: "session",
    entity_id: sessionId,
    after: { publication_override_reason: trimmed },
    reason: trimmed,
  });
}

export async function clearPublicationOverride(app: AppContext, sessionId: string): Promise<void> {
  await app.db.update("session", sessionId, { publication_override_reason: null, updated_at: app.now() });
  app.audit.record({ action: "session.publication_override_clear", entity_type: "session", entity_id: sessionId });
}

/* -------------------------------------------------------------------------- */
/* Relations and assets                                                        */
/* -------------------------------------------------------------------------- */

export async function addRelation(
  app: AppContext,
  sessionId: string,
  relatedSessionId: string,
  relation: string,
): Promise<void> {
  if (sessionId === relatedSessionId) {
    throw new DomainError({ code: "invalid_relation", message: "A session cannot relate to itself.", status: 422 });
  }
  await getSession(app, sessionId);
  await getSession(app, relatedSessionId);
  const existing = await app.db.first<Row>("session_relation", {
    session_id: sessionId,
    related_session_id: relatedSessionId,
    relation,
  });
  if (existing) return;
  const current = await listRelations(app, sessionId);
  await app.db.insert("session_relation", {
    id: newId("SessionRelation"),
    session_id: sessionId,
    related_session_id: relatedSessionId,
    relation,
    sort_order: current.length,
  });
  app.audit.record({
    action: "session_relation.add",
    entity_type: "session",
    entity_id: sessionId,
    after: { related_session_id: relatedSessionId, relation },
  });
}

export async function removeRelation(app: AppContext, sessionId: string, relationId: string): Promise<void> {
  await app.db.hardDelete("session_relation", { id: relationId, session_id: sessionId });
  app.audit.record({ action: "session_relation.remove", entity_type: "session", entity_id: sessionId, before: { id: relationId } });
}

/**
 * Link an already-uploaded `Asset` to the session. The Content context owns the
 * upload and the scan; INV-11-3 keeps an unscanned file off a public surface,
 * which is why `is_public` is refused until the scan passes.
 */
export async function attachAsset(
  app: AppContext,
  sessionId: string,
  input: { asset_id: string; kind: string; is_public?: boolean; public_from?: string | null },
): Promise<string> {
  const session = await getSession(app, sessionId);
  const asset = await app.db.byId<Row>("asset", input.asset_id);
  if (!asset) throw notFound("Asset", input.asset_id);
  if (input.is_public && str(asset.scan_status) !== "clean") {
    throw invariantError(
      "INV-11-3",
      "asset_not_clean",
      "That file has not passed its virus scan, so it cannot be made public yet.",
      { asset_id: input.asset_id, scan_status: str(asset.scan_status) },
    );
  }
  const existing = await app.db.first<Row>("session_asset", { session_id: sessionId, asset_id: input.asset_id });
  if (existing) return str(existing.id);
  const id = newId("SessionAsset");
  await app.db.insert("session_asset", {
    id,
    session_id: sessionId,
    asset_id: input.asset_id,
    kind: input.kind,
    uploaded_by_person_id: str(asset.uploaded_by_person_id, app.actor.id ?? "system"),
    is_public: input.is_public ? 1 : 0,
    public_from: input.public_from ?? null,
  });
  if (input.kind === "slides") {
    await app.db.update("session", sessionId, { slides_asset_id: input.asset_id, updated_at: app.now() });
  }
  app.events.emit({
    type: "session_asset.uploaded",
    subject: { type: "session", id: sessionId },
    event_id: str(session.event_id),
    data: { session_id: sessionId, asset_id: input.asset_id, kind: input.kind, is_public: !!input.is_public },
  });
  app.audit.record({
    action: "session_asset.attach",
    entity_type: "session",
    entity_id: sessionId,
    after: { asset_id: input.asset_id, kind: input.kind },
  });
  return id;
}

/* -------------------------------------------------------------------------- */
/* Small helpers the surfaces share                                            */
/* -------------------------------------------------------------------------- */

export function sessionIsSponsored(session: Row): boolean {
  return isSponsoredContent(session);
}

export function approvalGatedFieldList(): readonly string[] {
  return APPROVAL_GATED_FIELDS;
}

export async function eventStartInstant(app: AppContext, eventId: string): Promise<Instant | null> {
  const ev = await app.db.byId<Row>("event", eventId);
  if (!ev) return null;
  const startsOn = str(ev.starts_on);
  if (!startsOn) return null;
  return new Date(`${startsOn}T09:00:00.000Z`).toISOString();
}
