/**
 * Per-subject adapters for the two-way sync — 09, "Two-way sync".
 *
 * One entry per `SyncSubject`. Each knows four things and nothing else: how to
 * load a record, how to list the records a mapping should mirror, how to compute
 * the subject's derived columns, and — where the subject accepts writes at all —
 * how to apply one.
 *
 * **`apply` always calls the context's own service function** (INV-09-20). That
 * is the entire point of this file existing rather than the sync writing rows
 * itself: `updateSessionContent` revokes content approval and mints a revision
 * (INV-06-12), `organizerEdit` writes a `ProposalRevision` and an audit row with
 * a reason (INV-11-5), `updateProfile` refuses `visibility` (INV-01-13). A sync
 * that wrote columns directly would quietly skip every one of those, and the
 * spreadsheet would become the one way to edit a session without leaving a trace.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import type { SyncSubject } from "@podiumconf/domain/platform/sync.js";
import { subjectSpec } from "@podiumconf/domain/platform/sync.js";

import { organizerEdit } from "../submissions/service.js";
import { updateSessionContent } from "../program/service.js";
import { setParticipantStatus, updatePersonDetails, updateProfile } from "../identity/service.js";
import { updateSponsor, updateSponsorship } from "../sponsorship/service.js";
import { updateCard } from "../crm/service.js";

/** Where a mapping's records live: one event, or the whole organization. */
export interface MappingScope {
  eventId: string | null;
  /** `SyncMapping.filter`, already parsed. Criteria, never a frozen list. */
  filter: Record<string, unknown> | null;
}

export interface SubjectAdapter {
  /** Null when the record is gone — soft-deleted, merged away, or erased. */
  load(app: AppContext, id: string): Promise<Row | null>;
  /** Every record the mapping should mirror. The backfill and the reconcile sweep. */
  list(app: AppContext, scope: MappingScope): Promise<Row[]>;
  /** Values for this subject's scalar `derived` fields. Empty when it has none. */
  derived(app: AppContext, row: Row): Promise<Record<string, unknown>>;
  /**
   * Related Podium record ids, per `link` field. The service turns these into
   * provider record ids using the target subject's own mapping, or drops the
   * field if there is no such mapping (INV-09-24).
   */
  links?(app: AppContext, row: Row): Promise<Record<string, string[]>>;
  /** Asset ids per `attachment` field; the service signs them into fetchable URLs. */
  assets?(app: AppContext, row: Row): Promise<Record<string, string[]>>;
  /**
   * Apply the writable patch and return the field names that actually changed.
   * Absent on a push-only subject (INV-09-23), where it can never be reached
   * because `writableFields` is empty and INV-09-17 refuses the mapping.
   */
  apply?(app: AppContext, row: Row, patch: Record<string, unknown>): Promise<string[]>;
  /** Record ids for one person, for the `person`-sourced dirty rules and erasure. */
  byPerson?(app: AppContext, personId: string): Promise<string[]>;
}

/* -------------------------------------------------------------------------- */
/* Shared lookups                                                              */
/* -------------------------------------------------------------------------- */

const NAME_CACHE_KEY = Symbol.for("podium.sync.names");

/**
 * Names for a batch of ids, memoised for the life of one `AppContext`.
 *
 * A push of four hundred sessions asks for the same dozen track and format
 * names four hundred times. Caching on the context keeps that to one query per
 * table per sweep without holding anything across sweeps, where a stale name
 * would be pushed as current.
 */
async function nameOf(app: AppContext, table: string, id: string | null, column = "name"): Promise<string | null> {
  if (!id) return null;
  const store = (app as unknown as Record<symbol, Map<string, string | null>>);
  const cache = (store[NAME_CACHE_KEY] ??= new Map());
  const key = `${table}:${column}:${id}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const row = await app.db.byId<Row>(table, id);
  const value = row ? strOrNull(row[column]) : null;
  cache.set(key, value);
  return value;
}

/**
 * The speakers on a proposal or session, as `SpeakerProfile` ids.
 *
 * Profiles rather than people, because the Speakers table an organizer builds is
 * the one with the bio, the company and the headshot — that is `SpeakerProfile`.
 * A speaker with no profile row yet contributes no link: profiles are created
 * lazily when somebody first edits one, and a read path must not write.
 * `ORDER BY sort_order` is kept so the chips appear in billing order.
 */
async function speakerProfileIds(
  app: AppContext,
  table: "proposal_speaker" | "session_speaker",
  key: string,
  id: string,
): Promise<string[]> {
  const rows = await app.db.raw<Row>(
    `SELECT sp.id AS profile_id
       FROM ${table} s
       JOIN person p ON p.id = s.person_id
       JOIN speaker_profile sp ON sp.person_id = p.id
      WHERE s.${key} = ? AND p.deleted_at IS NULL
      ORDER BY s.sort_order, s.id`,
    [id],
  );
  return rows.map((r) => str(r.profile_id)).filter(Boolean);
}

/** Rows of an event-scoped table that has no `org_id` column of its own. */
async function byEvent(app: AppContext, table: string, scope: MappingScope, extra = ""): Promise<Row[]> {
  if (!scope.eventId) return [];
  return app.db.raw<Row>(`SELECT * FROM ${table} WHERE event_id = ?${extra} ORDER BY id`, [scope.eventId]);
}

/** `SyncMapping.filter` — criteria resolved now, never a list frozen at save time. */
function matchesFilter(row: Row, filter: Record<string, unknown> | null): boolean {
  if (!filter) return true;
  for (const [key, want] of Object.entries(filter)) {
    if (want === null || want === undefined || (Array.isArray(want) && want.length === 0)) continue;
    const have = row[key] === null || row[key] === undefined ? null : String(row[key]);
    if (Array.isArray(want)) {
      if (!want.map(String).includes(String(have))) return false;
    } else if (String(want) !== String(have)) {
      return false;
    }
  }
  return true;
}

function applyFilter(rows: Row[], scope: MappingScope): Row[] {
  return rows.filter((r) => matchesFilter(r, scope.filter));
}

/* -------------------------------------------------------------------------- */
/* Adapters                                                                    */
/* -------------------------------------------------------------------------- */

export const SUBJECT_ADAPTERS: Record<SyncSubject, SubjectAdapter> = {
  proposal: {
    async load(app, id) {
      return app.db.byId<Row>("proposal", id);
    },
    async list(app, scope) {
      if (!scope.eventId) return [];
      return applyFilter(await app.db.select<Row>("proposal", { event_id: scope.eventId }), scope);
    },
    async derived(app, row) {
      const submitter = strOrNull(row.submitter_person_id)
        ? await app.db.byId<Row>("person", str(row.submitter_person_id))
        : null;
      const decision = strOrNull(row.decision_id) ? await app.db.byId<Row>("decision", str(row.decision_id)) : null;
      return {
        submitter_name: submitter ? str(submitter.full_name) : null,
        submitter_email: submitter ? str(submitter.email) : null,
        // Names, not ids: these render as a dropdown an organizer picks from.
        track: await nameOf(app, "track", strOrNull(row.track_id)),
        assigned_track: await nameOf(app, "track", strOrNull(row.assigned_track_id)),
        format: await nameOf(app, "session_format", strOrNull(row.session_format_id)),
        decision_outcome: decision ? str(decision.outcome) : null,
      };
    },
    async links(app, row) {
      return { speakers: await speakerProfileIds(app, "proposal_speaker", "proposal_id", str(row.id)) };
    },
    async apply(app, row, patch) {
      // INV-11-5: an organizer edit of submitter-owned content carries a reason,
      // and `organizerEdit` is what writes the revision that makes it reversible.
      const result = await organizerEdit(app, str(row.id), patch, "Applied from the linked external table.");
      return result.changed_fields;
    },
  },

  session: {
    async load(app, id) {
      return app.db.byId<Row>("session", id);
    },
    async list(app, scope) {
      if (!scope.eventId) return [];
      return applyFilter(await app.db.select<Row>("session", { event_id: scope.eventId }), scope);
    },
    async derived(app, row) {
      const placement = await app.db.first<Row>("placement", { session_id: str(row.id) });
      return {
        track: await nameOf(app, "track", strOrNull(row.track_id)),
        format: await nameOf(app, "session_format", strOrNull(row.session_format_id)),
        room_name: placement ? await nameOf(app, "room", strOrNull(placement.room_id)) : null,
        starts_at: placement ? strOrNull(placement.starts_at) : null,
        ends_at: placement ? strOrNull(placement.ends_at) : null,
      };
    },
    async links(app, row) {
      const proposalId = strOrNull(row.proposal_id);
      return {
        speakers: await speakerProfileIds(app, "session_speaker", "session_id", str(row.id)),
        proposal: proposalId ? [proposalId] : [],
      };
    },
    async assets(app, row) {
      const slides = strOrNull(row.slides_asset_id);
      return { slides: slides ? [slides] : [] };
    },
    async apply(app, row, patch) {
      // The compare-and-set the whole authority rule rests on happens here
      // rather than in a pre-check, because `updateSessionContent` takes an
      // expected version and does it in the same statement as the write.
      const result = await updateSessionContent(app, str(row.id), patch, {
        expected_version: num(row.row_version, 1),
        change_kind: "organizer_edit",
      });
      return result.changed;
    },
  },

  person: {
    async load(app, id) {
      return app.db.byId<Row>("person", id);
    },
    async list(app, scope) {
      return applyFilter(await app.db.select<Row>("person", {}), scope);
    },
    async derived() {
      return {};
    },
    async apply(app, row, patch) {
      return updatePersonDetails(app, str(row.id), patch);
    },
    async byPerson(_app, personId) {
      return [personId];
    },
  },

  speaker_profile: {
    async load(app, id) {
      return app.db.byId<Row>("speaker_profile", id);
    },
    async list(app, scope) {
      return applyFilter(await app.db.select<Row>("speaker_profile", {}), scope);
    },
    async derived(app, row) {
      const person = await app.db.byId<Row>("person", str(row.person_id));
      return { full_name: person ? str(person.full_name) : null, email: person ? str(person.email) : null };
    },
    async assets(_app, row) {
      const headshot = strOrNull(row.headshot_asset_id);
      return { headshot: headshot ? [headshot] : [] };
    },
    async apply(app, row, patch) {
      const personId = str(row.person_id);
      const changed: string[] = [];

      // The Speakers table is where somebody notices a misspelled name, and the
      // name lives on `Person`. Splitting the patch here rather than pretending
      // one table owns both is what keeps the identity write on its own service.
      if ("full_name" in patch) {
        const applied = await updatePersonDetails(app, personId, { full_name: patch.full_name });
        changed.push(...applied);
      }

      const profilePatch = { ...patch };
      delete profilePatch.full_name;
      if (Object.keys(profilePatch).length > 0) {
        // `isOwner: false` is the truthful argument for an integration, and it
        // is what makes `updateProfile` refuse `visibility` and `is_listed`
        // under INV-01-13 — a second guard behind the writable-field set.
        await updateProfile(app, personId, profilePatch, { isOwner: false, editedByRole: "integration" });
        changed.push(...Object.keys(profilePatch));
      }
      return changed;
    },
    async byPerson(app, personId) {
      const row = await app.db.first<Row>("speaker_profile", { person_id: personId });
      return row ? [str(row.id)] : [];
    },
  },

  event_participant: {
    async load(app, id) {
      return app.db.byId<Row>("event_participant", id);
    },
    async list(app, scope) {
      if (!scope.eventId) return [];
      return applyFilter(await app.db.select<Row>("event_participant", { event_id: scope.eventId }), scope);
    },
    async derived(app, row) {
      const person = await app.db.byId<Row>("person", str(row.person_id));
      return { full_name: person ? str(person.full_name) : null, email: person ? str(person.email) : null };
    },
    async links(_app, row) {
      return { person: [str(row.person_id)] };
    },
    async apply(app, row, patch) {
      if (!("status" in patch)) return [];
      const to = str(patch.status);
      if (to === str(row.status)) return [];
      // Validates the transition and emits `event_participant.status_changed`.
      await setParticipantStatus(app, str(row.id), to as Parameters<typeof setParticipantStatus>[2]);
      return ["status"];
    },
    async byPerson(app, personId) {
      const rows = await app.db.select<Row>("event_participant", { person_id: personId });
      return rows.map((r) => str(r.id));
    },
  },

  sponsor: {
    async load(app, id) {
      return app.db.byId<Row>("sponsor", id);
    },
    async list(app, scope) {
      return applyFilter(await app.db.select<Row>("sponsor", {}), scope);
    },
    async derived() {
      return {};
    },
    async assets(_app, row) {
      const logo = strOrNull(row.logo_asset_id);
      return { logo: logo ? [logo] : [] };
    },
    async apply(app, row, patch) {
      const input = { ...patch } as Record<string, unknown>;
      if ("industry_tags" in input) input.industry_tags = parseJson<string[]>(input.industry_tags, []);
      await updateSponsor(app, str(row.id), input);
      return Object.keys(patch);
    },
  },

  sponsorship: {
    async load(app, id) {
      return app.db.byId<Row>("sponsorship", id);
    },
    async list(app, scope) {
      return applyFilter(await byEvent(app, "sponsorship", scope), scope);
    },
    async derived(app, row) {
      const sponsor = await app.db.byId<Row>("sponsor", str(row.sponsor_id));
      return {
        sponsor_name: sponsor ? str(sponsor.name) : null,
        tier_name: await nameOf(app, "sponsorship_tier", strOrNull(row.tier_id)),
      };
    },
    async links(_app, row) {
      return { sponsor: [str(row.sponsor_id)] };
    },
    async apply(app, row, patch) {
      await updateSponsorship(app, str(row.id), patch as Parameters<typeof updateSponsorship>[2]);
      return Object.keys(patch);
    },
  },

  entitlement: {
    async load(app, id) {
      return app.db.byId<Row>("entitlement", id);
    },
    async list(app, scope) {
      if (!scope.eventId) return [];
      return applyFilter(
        await app.db.raw<Row>(
          `SELECT e.* FROM entitlement e JOIN sponsorship s ON s.id = e.sponsorship_id
            WHERE s.event_id = ? ORDER BY e.id`,
          [scope.eventId],
        ),
        scope,
      );
    },
    async derived(app, row) {
      // Never a stored counter (03, INV-11-6): counted from the proposals
      // pointing at this entitlement, every time it is read.
      const used = await app.db.raw<Row>(
        `SELECT COUNT(*) AS n FROM proposal
          WHERE entitlement_id = ? AND deleted_at IS NULL
            AND status NOT IN ('withdrawn', 'rejected', 'expired')`,
        [str(row.id)],
      );
      const consumed = num(used[0]?.n, 0);
      const sponsorship = await app.db.byId<Row>("sponsorship", str(row.sponsorship_id));
      const sponsor = sponsorship ? await app.db.byId<Row>("sponsor", str(sponsorship.sponsor_id)) : null;
      return {
        consumed_count: consumed,
        remaining: Math.max(0, num(row.quantity, 0) - consumed),
        sponsor_name: sponsor ? str(sponsor.name) : null,
      };
    },
    async links(_app, row) {
      return { sponsorship: [str(row.sponsorship_id)] };
    },
  },

  placement: {
    async load(app, id) {
      return app.db.byId<Row>("placement", id);
    },
    async list(app, scope) {
      return applyFilter(await byEvent(app, "placement", scope), scope);
    },
    async derived(app, row) {
      const session = await app.db.byId<Row>("session", str(row.session_id));
      const day = await app.db.byId<Row>("event_day", str(row.event_day_id));
      return {
        session_title: session ? str(session.title) : null,
        room_name: await nameOf(app, "room", strOrNull(row.room_id)),
        day: day ? strOrNull(day.date) : null,
      };
    },
    async links(_app, row) {
      return { session: [str(row.session_id)] };
    },
  },

  decision: {
    async load(app, id) {
      return app.db.byId<Row>("decision", id);
    },
    async list(app, scope) {
      if (!scope.eventId) return [];
      return applyFilter(
        await app.db.raw<Row>(
          `SELECT d.* FROM decision d JOIN proposal p ON p.id = d.proposal_id
            WHERE p.event_id = ? AND p.deleted_at IS NULL ORDER BY d.id`,
          [scope.eventId],
        ),
        scope,
      );
    },
    async derived(app, row) {
      const proposal = await app.db.byId<Row>("proposal", str(row.proposal_id));
      return {
        proposal_reference: proposal ? str(proposal.reference) : null,
      };
    },
    async links(_app, row) {
      return { proposal: [str(row.proposal_id)] };
    },
  },

  prospect_card: {
    async load(app, id) {
      return app.db.byId<Row>("prospect_card", id);
    },
    async list(app, scope) {
      const rows = await app.db.raw<Row>(
        `SELECT c.* FROM prospect_card c JOIN sourcing_pipeline p ON p.id = c.pipeline_id
          WHERE p.org_id = ? ORDER BY c.id`,
        [app.orgId],
      );
      return applyFilter(rows, scope);
    },
    async derived(app, row) {
      const person = await app.db.byId<Row>("person", str(row.person_id));
      return {
        full_name: person ? str(person.full_name) : null,
        stage_name: await nameOf(app, "pipeline_stage", strOrNull(row.stage_id)),
        pipeline_name: await nameOf(app, "sourcing_pipeline", strOrNull(row.pipeline_id)),
      };
    },
    async links(_app, row) {
      return { person: [str(row.person_id)] };
    },
    async apply(app, row, patch) {
      await updateCard(app, str(row.id), patch as Parameters<typeof updateCard>[2]);
      return Object.keys(patch);
    },
    async byPerson(app, personId) {
      const rows = await app.db.select<Row>("prospect_card", { person_id: personId });
      return rows.map((r) => str(r.id));
    },
  },
};

export function adapterFor(subject: string): SubjectAdapter {
  subjectSpec(subject); // throws the typed error for an unknown subject
  return SUBJECT_ADAPTERS[subject as SyncSubject];
}

/** Subjects whose records belong to a person, for erasure propagation (INV-09-22). */
export function personLinkedSubjects(): SyncSubject[] {
  return (Object.keys(SUBJECT_ADAPTERS) as SyncSubject[]).filter((s) => SUBJECT_ADAPTERS[s].byPerson);
}
