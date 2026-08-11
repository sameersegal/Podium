/**
 * Read models for 04 — chiefly `SubmitterDashboard` (J3): "one page that
 * answers 'what have I got outstanding'".
 *
 * "This read model is the portal. It must be assemblable in one round trip per
 * person" — so it is five prepared statements, not a query per row, and the
 * only per-proposal work is loading the bound form for drafts (to derive
 * `percent_complete`, which has no column).
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import {
  acceptsSubmission,
  cfpStatus,
  percentComplete,
  visibleSteps,
  type EventStatus,
  type FormSpec,
} from "@podiumconf/domain/event-config/types.js";
import { REDACTED, redactRecord } from "@podiumconf/domain/shared/pii.js";
import { answerDisplay } from "@podiumconf/domain/submissions/answer-display.js";
import { visibleAnswers, type AnswerMap } from "@podiumconf/domain/submissions/answers.js";
import {
  canWithdraw,
  editAffordance,
  nextAction,
  type EditAffordance,
  type NextAction,
} from "@podiumconf/domain/submissions/types.js";
import { loadFormSpec } from "../event-config/views.js";
import { referenceLabels } from "./answer-labels.js";
import { answersOf, contentHashOf, revisionsOf, speakersOf } from "./service.js";

/* -------------------------------------------------------------------------- */
/* A tiny per-request form cache                                               */
/* -------------------------------------------------------------------------- */

export class FormCache {
  private readonly cache = new Map<string, Promise<FormSpec>>();
  constructor(private readonly app: AppContext) {}
  get(formId: string): Promise<FormSpec> {
    let p = this.cache.get(formId);
    if (!p) {
      p = loadFormSpec(this.app, formId);
      this.cache.set(formId, p);
    }
    return p;
  }
}

/* -------------------------------------------------------------------------- */
/* SubmitterDashboard                                                          */
/* -------------------------------------------------------------------------- */

export interface DashboardProposal {
  id: string;
  reference: string;
  title: string;
  status: string;
  origin: string;
  event_id: string;
  event_name: string;
  event_slug: string;
  event_timezone: string;
  cfp_name: string;
  cfp_status: string;
  percent_complete: number | null;
  next_action: NextAction;
  deadline: string | null;
  edit: EditAffordance;
  can_withdraw: boolean;
  is_submitter: boolean;
  /** Only ever `Decision.feedback_for_speaker`, and only once published (INV-04-11). */
  feedback_for_speaker: string | null;
  submitted_at: string | null;
}

export interface DashboardInvitation {
  proposal_id: string;
  reference: string;
  title: string;
  event_name: string;
  speaker_role: string;
  invited_by: string | null;
  added_at: string;
}

export interface DashboardSession {
  id: string;
  reference: string;
  title: string;
  event_name: string;
  event_timezone: string;
  status: string;
  confirmation_status: string;
  starts_at: string | null;
  ends_at: string | null;
  room_name: string | null;
}

export interface DashboardTask {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  is_blocking: boolean;
  event_name: string;
  session_id: string | null;
  overdue: boolean;
}

export interface SubmitterDashboard {
  proposals: DashboardProposal[];
  invitations: DashboardInvitation[];
  sessions: DashboardSession[];
  tasks: DashboardTask[];
  profile: { completeness: number; is_listed: boolean; public_fields: string[] };
}

export async function submitterDashboard(app: AppContext, personId: string): Promise<SubmitterDashboard> {
  const now = app.now();
  const forms = new FormCache(app);

  const [proposalRows, invitationRows, sessionRows, taskRows, profileRows, linkRows] = await Promise.all([
    app.db.raw<Row>(
      `SELECT p.id, p.reference, p.title, p.status, p.origin, p.event_id, p.cfp_id, p.form_id,
              p.submitter_person_id, p.submitted_at, p.confirmation_deadline, p.decision_id,
              e.name AS event_name, e.slug AS event_slug, e.timezone AS event_timezone, e.status AS event_status,
              c.name AS cfp_name, c.opens_at, c.closes_at, c.closed_early_at, c.published_at,
              c.grace_period_minutes, c.late_submission_policy, c.allow_edit_after_submit, c.withdraw_allowed_until,
              d.outcome AS decision_outcome, d.feedback_for_speaker, d.status AS decision_status,
              d.published_at AS decision_published_at
         FROM proposal p
         JOIN event e ON e.id = p.event_id
         JOIN call_for_proposals c ON c.id = p.cfp_id
    LEFT JOIN decision d ON d.id = p.decision_id
        WHERE p.org_id = ? AND p.deleted_at IS NULL
          AND (p.submitter_person_id = ?
               OR p.id IN (SELECT proposal_id FROM proposal_speaker
                            WHERE person_id = ? AND participation_status != 'removed'))
        ORDER BY p.created_at DESC`,
      [app.orgId, personId, personId],
    ),
    app.db.raw<Row>(
      `SELECT ps.proposal_id, ps.speaker_role, ps.added_at, ps.added_by_person_id,
              p.reference, p.title, e.name AS event_name, inviter.full_name AS invited_by
         FROM proposal_speaker ps
         JOIN proposal p ON p.id = ps.proposal_id AND p.deleted_at IS NULL
         JOIN event e ON e.id = p.event_id
    LEFT JOIN person inviter ON inviter.id = ps.added_by_person_id
        WHERE ps.person_id = ? AND ps.participation_status = 'pending' AND p.org_id = ?
        ORDER BY ps.added_at DESC`,
      [personId, app.orgId],
    ),
    app.db.raw<Row>(
      `SELECT s.id, s.reference, s.title, s.status, e.name AS event_name, e.timezone AS event_timezone,
              ss.confirmation_status, pl.starts_at, pl.ends_at, r.name AS room_name
         FROM session_speaker ss
         JOIN session s ON s.id = ss.session_id AND s.deleted_at IS NULL
         JOIN event e ON e.id = s.event_id
    LEFT JOIN placement pl ON pl.session_id = s.id
    LEFT JOIN room r ON r.id = pl.room_id
        WHERE ss.person_id = ? AND s.org_id = ? AND ss.confirmation_status != 'replaced'
        ORDER BY pl.starts_at`,
      [personId, app.orgId],
    ),
    app.db.raw<Row>(
      `SELECT t.id, t.title, t.status, t.due_at, t.is_blocking, t.session_id, e.name AS event_name
         FROM task_instance t
         JOIN event e ON e.id = t.event_id
        WHERE t.org_id = ? AND t.assignee_person_id = ?
          AND t.status NOT IN ('completed','waived','cancelled')`,
      [app.orgId, personId],
    ),
    app.db.raw<Row>("SELECT * FROM speaker_profile WHERE org_id = ? AND person_id = ?", [app.orgId, personId]),
    app.db.raw<Row>(
      `SELECT l.is_public FROM profile_link l
         JOIN speaker_profile sp ON sp.id = l.speaker_profile_id
        WHERE sp.org_id = ? AND sp.person_id = ?`,
      [app.orgId, personId],
    ),
  ]);

  const proposals: DashboardProposal[] = [];
  for (const r of proposalRows) {
    const eventStatus = str(r.event_status, "draft") as EventStatus;
    const cfpSpec = {
      opens_at: str(r.opens_at),
      closes_at: str(r.closes_at),
      closed_early_at: strOrNull(r.closed_early_at),
      published_at: strOrNull(r.published_at),
      grace_period_minutes: num(r.grace_period_minutes),
      late_submission_policy: str(r.late_submission_policy, "reject") as "reject" | "allow_with_flag",
    };
    const status = str(r.status);
    const accepts = acceptsSubmission(cfpSpec, eventStatus, now);
    const edit = editAffordance(status, {
      accepts_edit: accepts.allowed,
      allow_edit_after_submit: bool(r.allow_edit_after_submit),
    });

    let pct: number | null = null;
    if (status === "draft") {
      try {
        const form = await forms.get(str(r.form_id));
        pct = percentComplete(form, await answersOf(app, str(r.id)));
      } catch {
        pct = null;
      }
    }

    // INV-04-11 — only `feedback_for_speaker` from a **published** decision is
    // ever visible to a submitter. Nothing else from the review context leaves.
    const decisionPublished = str(r.decision_status) === "published" && !!r.decision_published_at;

    proposals.push({
      id: str(r.id),
      reference: str(r.reference),
      title: str(r.title) || "Untitled proposal",
      status,
      origin: str(r.origin),
      event_id: str(r.event_id),
      event_name: str(r.event_name),
      event_slug: str(r.event_slug),
      event_timezone: str(r.event_timezone, "UTC"),
      cfp_name: str(r.cfp_name),
      cfp_status: cfpStatus(cfpSpec, eventStatus, now),
      percent_complete: pct,
      next_action: nextAction({
        status,
        percent_complete: pct ?? 0,
        confirmation_deadline: strOrNull(r.confirmation_deadline),
        cfp_closes_at: str(r.closes_at),
        now,
        timezone: str(r.event_timezone, "UTC"),
      }),
      deadline: status === "accepted" ? strOrNull(r.confirmation_deadline) : status === "draft" ? str(r.closes_at) : null,
      edit,
      can_withdraw: canWithdraw(status, str(r.withdraw_allowed_until, "always")),
      is_submitter: str(r.submitter_person_id) === personId,
      feedback_for_speaker: decisionPublished ? strOrNull(r.feedback_for_speaker) : null,
      submitted_at: strOrNull(r.submitted_at),
    });
  }

  const tasks: DashboardTask[] = taskRows
    .map((t) => ({
      id: str(t.id),
      title: str(t.title),
      status: str(t.status),
      due_at: strOrNull(t.due_at),
      is_blocking: bool(t.is_blocking),
      event_name: str(t.event_name),
      session_id: strOrNull(t.session_id),
      overdue: !!t.due_at && str(t.due_at) <= now,
    }))
    // "sorted by due date, with the overdue ones first".
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (!a.due_at) return b.due_at ? 1 : 0;
      if (!b.due_at) return -1;
      return a.due_at.localeCompare(b.due_at);
    });

  const profile = profileRows[0] ?? null;
  const visibility = parseJson<Record<string, string>>(profile?.visibility, {});
  const completeness = profileCompletenessOf(profile, linkRows.length);

  return {
    proposals,
    invitations: invitationRows.map((r) => ({
      proposal_id: str(r.proposal_id),
      reference: str(r.reference),
      title: str(r.title) || "Untitled proposal",
      event_name: str(r.event_name),
      speaker_role: str(r.speaker_role),
      invited_by: strOrNull(r.invited_by),
      added_at: str(r.added_at),
    })),
    sessions: sessionRows.map((r) => ({
      id: str(r.id),
      reference: str(r.reference),
      title: str(r.title),
      event_name: str(r.event_name),
      event_timezone: str(r.event_timezone, "UTC"),
      status: str(r.status),
      confirmation_status: str(r.confirmation_status),
      starts_at: strOrNull(r.starts_at),
      ends_at: strOrNull(r.ends_at),
      room_name: strOrNull(r.room_name),
    })),
    tasks,
    profile: {
      completeness,
      is_listed: profile ? bool(profile.is_listed) : true,
      public_fields: Object.entries(visibility)
        .filter(([, v]) => v === "public")
        .map(([k]) => k),
    },
  };
}

function profileCompletenessOf(profile: Row | null, linkCount: number): number {
  if (!profile) return 0;
  const checks = [
    !!profile.headline,
    !!profile.job_title,
    !!profile.company,
    !!profile.bio,
    !!profile.short_bio,
    !!profile.headshot_asset_id,
    !!profile.location,
    linkCount > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/* -------------------------------------------------------------------------- */
/* One proposal, fully assembled                                               */
/* -------------------------------------------------------------------------- */

export interface AnswerView {
  step_key: string;
  step_title: string;
  field_key: string;
  label: string;
  type: string;
  audience: string;
  pii: boolean;
  value: unknown;
  /** `ProposalAnswer.display` — what a reader sees; `null` when unanswered. */
  display: string | null;
  visible: boolean;
}

export interface ProposalDetail {
  proposal: Row;
  form: FormSpec;
  answers: AnswerMap;
  answer_views: AnswerView[];
  speakers: (Row & { person: Row | null })[];
  revisions: Row[];
  progress: Row | null;
  content_hash: string;
  event: Row | null;
  cfp: Row | null;
  format: Row | null;
  track: Row | null;
  sponsor: Row | null;
  entitlement: Row | null;
  decision: Row | null;
}

/**
 * `include_pii` drives whether `ProposalAnswer` values for fields flagged
 * `FormField.pii` come back at all (11-cross-cutting.md, "Free-text answers").
 */
export async function proposalDetail(
  app: AppContext,
  proposalId: string,
  opts: { includePii: boolean; audience?: "submitter" | "committee" },
): Promise<ProposalDetail> {
  const proposal = await app.db.byId<Row>("proposal", proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  const form = await loadFormSpec(app, str(proposal.form_id));
  const answers = await answersOf(app, proposalId);
  const visibleKeys = new Set(visibleSteps(form, answers).flatMap((s) => s.fields.map((f) => f.key)));

  // The names behind `trk_…` / `fmt_…` / `per_…` / `ast_…`, in one pass over the
  // whole form rather than a lookup per row while rendering.
  const labels = await referenceLabels(
    app,
    form.steps.flatMap((s) => s.fields.map((f) => ({ type: f.type, value: answers[f.key] }))),
  );

  const answer_views: AnswerView[] = [];
  for (const step of form.steps) {
    for (const field of step.fields) {
      // A submitter never sees committee-only or organizer-only questions.
      if (opts.audience === "submitter" && field.audience !== "public") continue;
      const raw = answers[field.key];
      const redacted = field.pii
        ? (redactRecord("ProposalAnswer", { value: raw }, { includePii: opts.includePii }).value as unknown)
        : raw;
      answer_views.push({
        step_key: step.key,
        step_title: step.title,
        field_key: field.key,
        label: field.label,
        type: field.type,
        audience: field.audience,
        pii: field.pii,
        value: redacted,
        // A redacted value has no display of its own — resolving it would print
        // "(no longer available)" for a value that is present and withheld.
        display: redacted === REDACTED ? REDACTED : answerDisplay(field, redacted, labels),
        // Retained but invisible answers are excluded from committee views.
        visible: visibleKeys.has(field.key),
      });
    }
  }

  const speakerRows = await speakersOf(app, proposalId);
  const speakers: (Row & { person: Row | null })[] = [];
  for (const s of speakerRows) {
    const person = await app.db.byId<Row>("person", str(s.person_id));
    speakers.push({
      ...s,
      person: person ? redactRecord("Person", person, { includePii: opts.includePii }) : null,
      // `is_submitter` is derived (04, `ProposalSpeaker`).
      is_submitter: str(s.person_id) === str(proposal.submitter_person_id),
    });
  }

  const [event, cfp, format, track, sponsor, entitlement, decision] = await Promise.all([
    app.db.byId<Row>("event", str(proposal.event_id)),
    app.db.byId<Row>("call_for_proposals", str(proposal.cfp_id)),
    proposal.session_format_id ? app.db.byId<Row>("session_format", str(proposal.session_format_id)) : Promise.resolve(null),
    proposal.track_id ? app.db.byId<Row>("track", str(proposal.track_id)) : Promise.resolve(null),
    proposal.sponsor_id ? app.db.byId<Row>("sponsor", str(proposal.sponsor_id)) : Promise.resolve(null),
    proposal.entitlement_id ? app.db.byId<Row>("entitlement", str(proposal.entitlement_id)) : Promise.resolve(null),
    proposal.decision_id ? app.db.byId<Row>("decision", str(proposal.decision_id)) : Promise.resolve(null),
  ]);

  return {
    proposal,
    form,
    answers: opts.audience === "committee" ? visibleAnswers(form, answers) : answers,
    answer_views,
    speakers,
    revisions: await revisionsOf(app, proposalId),
    progress: await app.db.first<Row>("draft_progress", { proposal_id: proposalId }),
    content_hash: contentHashOf(proposal),
    event,
    cfp,
    format,
    track,
    sponsor,
    entitlement,
    decision,
  };
}

/* -------------------------------------------------------------------------- */
/* The admin proposal queue                                                    */
/* -------------------------------------------------------------------------- */

export interface QueueFilters {
  status?: string[];
  track_id?: string[];
  format_id?: string[];
  origin?: string[];
  cfp_id?: string[];
  q?: string | null;
  sort?: string;
  limit?: number;
  cursor?: string | null;
}

export interface QueueRow extends Row {
  submitter_name: string;
  submitter_email: string;
  speaker_names: string | null;
  track_name: string | null;
  format_name: string | null;
  sponsor_name: string | null;
  review_count: number;
  target_reviews: number;
}

const SORTS: Record<string, string> = {
  newest: "p.created_at DESC",
  oldest: "p.created_at ASC",
  reference: "p.reference ASC",
  title: "p.title ASC",
  submitted: "p.submitted_at DESC",
  status: "p.status ASC, p.created_at DESC",
};

export async function proposalQueue(
  app: AppContext,
  eventId: string,
  filters: QueueFilters,
): Promise<{ rows: QueueRow[]; next_cursor: string | null; total: number }> {
  const where: string[] = ["p.org_id = ?", "p.event_id = ?", "p.deleted_at IS NULL"];
  const params: unknown[] = [app.orgId, eventId];

  const inClause = (column: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return;
    where.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inClause("p.status", filters.status);
  inClause("p.track_id", filters.track_id);
  inClause("p.session_format_id", filters.format_id);
  inClause("p.origin", filters.origin);
  inClause("p.cfp_id", filters.cfp_id);

  if (filters.q) {
    where.push("(p.title LIKE ? OR p.reference LIKE ? OR p.abstract LIKE ? OR sub.full_name LIKE ?)");
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  // Cursor pagination: ULIDs sort by creation time, so the id is the cursor
  // (09, "List endpoints are cursor-paginated").
  if (filters.cursor) {
    where.push("p.id < ?");
    params.push(filters.cursor);
  }

  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const order = SORTS[filters.sort ?? "newest"] ?? SORTS.newest;

  const sql = `
    SELECT p.*,
           sub.full_name AS submitter_name, sub.email AS submitter_email,
           t.name AS track_name, f.name AS format_name, spo.name AS sponsor_name,
           (SELECT GROUP_CONCAT(pe.full_name, ', ')
              FROM proposal_speaker ps JOIN person pe ON pe.id = ps.person_id
             WHERE ps.proposal_id = p.id AND ps.participation_status != 'removed') AS speaker_names,
           (SELECT COUNT(*) FROM review r WHERE r.proposal_id = p.id AND r.status = 'submitted') AS review_count
      FROM proposal p
      JOIN person sub ON sub.id = p.submitter_person_id
 LEFT JOIN track t ON t.id = p.track_id
 LEFT JOIN session_format f ON f.id = p.session_format_id
 LEFT JOIN sponsor spo ON spo.id = p.sponsor_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${order}
     LIMIT ${limit + 1}`;

  const rows = await app.db.raw<QueueRow>(sql, params);
  const countRows = await app.db.raw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM proposal p JOIN person sub ON sub.id = p.submitter_person_id WHERE ${where.join(" AND ")}`,
    params,
  );

  const page = rows.slice(0, limit);
  return {
    rows: page.map((r) => ({ ...r, target_reviews: 2 })),
    next_cursor: rows.length > limit ? str(page[page.length - 1]?.id) : null,
    total: num(countRows[0]?.n, 0),
  };
}

/** Proposals a person may see in the portal — the `O` row of the matrix. */
export async function myProposals(app: AppContext, personId: string): Promise<Row[]> {
  return app.db.raw<Row>(
    `SELECT p.*, e.name AS event_name, e.timezone AS event_timezone
       FROM proposal p JOIN event e ON e.id = p.event_id
      WHERE p.org_id = ? AND p.deleted_at IS NULL
        AND (p.submitter_person_id = ?
             OR p.id IN (SELECT proposal_id FROM proposal_speaker WHERE person_id = ? AND participation_status != 'removed'))
      ORDER BY p.created_at DESC`,
    [app.orgId, personId, personId],
  );
}

/** Open calls a person may submit to, honouring `CallForProposals.audience` (INV-02-3). */
export async function openCallsFor(app: AppContext, personId: string | null, isStaff: boolean): Promise<Row[]> {
  const rows = await app.db.raw<Row>(
    `SELECT c.*, e.name AS event_name, e.slug AS event_slug, e.status AS event_status, e.timezone AS event_timezone
       FROM call_for_proposals c
       JOIN event e ON e.id = c.event_id
      WHERE c.deleted_at IS NULL AND e.deleted_at IS NULL AND e.org_id = ?
      ORDER BY c.closes_at`,
    [app.orgId],
  );
  const now = app.now();
  const sponsorIds = personId
    ? (await app.db.raw<{ sponsor_id: string }>(
        "SELECT sponsor_id FROM sponsor_contact WHERE person_id = ? AND status = 'active'",
        [personId],
      )).map((r) => r.sponsor_id)
    : [];

  const out: Row[] = [];
  for (const c of rows) {
    const accepts = acceptsSubmission(
      {
        opens_at: str(c.opens_at),
        closes_at: str(c.closes_at),
        closed_early_at: strOrNull(c.closed_early_at),
        published_at: strOrNull(c.published_at),
        grace_period_minutes: num(c.grace_period_minutes),
        late_submission_policy: str(c.late_submission_policy, "reject") as "reject" | "allow_with_flag",
      },
      str(c.event_status, "draft") as EventStatus,
      now,
    );
    if (!accepts.allowed) continue;
    const audience = str(c.audience, "public");
    if (audience === "sponsors_only" && !isStaff) {
      // INV-02-3: visible only to an active SponsorContact for a sponsor of that event.
      if (sponsorIds.length === 0) continue;
      const hasSponsorship = await app.db.raw<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sponsorship
          WHERE event_id = ? AND status = 'confirmed' AND sponsor_id IN (${sponsorIds.map(() => "?").join(",")})`,
        [str(c.event_id), ...sponsorIds],
      );
      if (num(hasSponsorship[0]?.n, 0) === 0) continue;
    }
    if (audience === "invite_only" && !isStaff) {
      const invited = personId
        ? await app.db.raw<{ n: number }>(
            `SELECT COUNT(*) AS n FROM invitation
              WHERE org_id = ? AND person_id = ? AND context_type = 'event' AND context_id = ? AND status IN ('pending','accepted')`,
            [app.orgId, personId, str(c.event_id)],
          )
        : [];
      if (num(invited[0]?.n, 0) === 0) continue;
    }
    out.push({ ...c, is_late: accepts.late ? 1 : 0 });
  }
  return out;
}

/** Sponsor entitlements this person may submit against, for the "new proposal" screen. */
export async function submittableEntitlements(
  app: AppContext,
  personId: string,
  eventId: string,
): Promise<Row[]> {
  return app.db.raw<Row>(
    `SELECT en.*, sp.id AS sponsorship_id, s.id AS sponsor_id, s.name AS sponsor_name
       FROM sponsor_contact sc
       JOIN sponsor s ON s.id = sc.sponsor_id AND s.deleted_at IS NULL AND s.status != 'blocked'
       JOIN sponsorship sp ON sp.sponsor_id = s.id AND sp.event_id = ? AND sp.status = 'confirmed'
       JOIN entitlement en ON en.sponsorship_id = sp.id
      WHERE sc.person_id = ? AND sc.status = 'active' AND sc.can_submit_sessions = 1
        AND (sc.event_id IS NULL OR sc.event_id = ?)
        AND s.org_id = ?`,
    [eventId, personId, eventId, app.orgId],
  );
}
