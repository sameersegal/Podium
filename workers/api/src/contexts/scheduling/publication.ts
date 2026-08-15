/**
 * `SchedulePublication` — the immutable snapshot (08, "Publication").
 *
 * Publishing copies everything the public sees into the snapshot — session
 * content, speaker public profile fields, sponsor branding, room and time — so
 * that later edits to live records cannot silently rewrite what is on the
 * website, and so the embed can be served from cache with a version stamp.
 *
 * The serialised snapshot is cached in KV keyed on `content_etag`, which is why
 * the embed never touches the database (INV-09-6).
 */

import type { AppContext, Env } from "@podiumstack/data/context.js";
import { D1Db, bool, buildUpdate, num, parseJson, str, strOrNull, type Row, type Statement } from "@podiumstack/data/db.js";
import { DEFAULT_PROFILE_VISIBILITY } from "@podiumstack/domain/identity/types.js";
import {
  assertNoPrivateFields,
  computeDiff,
  contentEtag,
  pendingPublicationChanges,
  publishability,
  speakerSortKey,
  type DiffEntry,
  type PendingPublicationChanges,
  type PublishabilityVerdict,
  type PublishedAssetRef,
  type PublishedFormatRef,
  type PublishedRoomRef,
  type PublishedSessionSnapshot,
  type PublishedSpeakerSnapshot,
  type PublishedTrackRef,
  type ScheduleSnapshot,
  type SnapshotEventRef,
  type WorkingSession,
} from "@podiumstack/domain/scheduling/publication.js";
import { invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { errorCodesBySession, listConflicts, recomputeConflicts } from "./conflicts.js";
import { loadScheduleFacts, toEventFact, type EventFact, type ScheduleFacts } from "./facts.js";
import { readinessOf } from "./program-link.js";

/* -------------------------------------------------------------------------- */
/* Building a snapshot                                                         */
/* -------------------------------------------------------------------------- */

export interface SnapshotBuild {
  event: SnapshotEventRef;
  sessions: PublishedSessionSnapshot[];
  speakers: PublishedSpeakerSnapshot[];
  tracks: PublishedTrackRef[];
  formats: PublishedFormatRef[];
  rooms: PublishedRoomRef[];
  /** Every candidate's verdict, publishable or not — the publish preview. */
  verdicts: PublishabilityVerdict[];
  /**
   * Which sessions this build would publish, named rather than inferred from
   * `sessions`.
   *
   * `verdictsOnly` leaves `sessions` empty, and a caller that only wants to know
   * *which* sessions would go out — `pendingChanges` — must get the same answer
   * either way. Reading it off the payload made the answer depend on whether the
   * payload was built.
   */
  publishable_session_ids: string[];
  /**
   * The rows this build read, handed back so a caller that needs them too does
   * not read them a second time.
   *
   * `pendingChanges` did exactly that — build the snapshot, then load the same
   * sessions, placements, rooms, days and slots again to diff against it —
   * which is why `/admin` and the console dashboard each spent about twenty
   * statements twice over on every view.
   */
  facts: ScheduleFacts;
}

export interface PublishScope {
  event_day_ids?: string[];
  track_ids?: string[];
}

/**
 * `/assets/:assetId` is the one route that serves an `Asset`'s bytes inline
 * (`assertCanViewAsset`, content/routes.ts) — keyed by id, not by the R2
 * `storage_key`, which is an implementation detail of where the bytes live
 * and was never a routable path on its own.
 */
function assetUrl(assetId: string | null): string | null {
  return assetId ? `/assets/${assetId}` : null;
}

/**
 * Assemble what a publication *would* contain. Used by the publish command and,
 * unchanged, by the publish preview — so the preview cannot drift from the act.
 */
export async function buildSnapshot(
  app: AppContext,
  eventId: string,
  // `facts` lets a caller that has already loaded them say so — the same
  // `preloaded` affordance `recomputeConflicts` has, and for the same reason:
  // the fact set is two rounds of queries and nothing about it changes between
  // two reads in one request.
  opts: {
    scope?: PublishScope | null;
    overrideSessionIds?: Set<string>;
    facts?: ScheduleFacts;
    /**
     * Decide what would publish, and stop there.
     *
     * The publication diff needs the verdicts and nothing else: which sessions
     * would go out, and their times, which are their placements'. Assembling
     * the payload as well — speakers, profiles, sponsors, tiers, assets, tracks,
     * formats, the venue — is nine more statements whose result it discards.
     *
     * It is an early return from the *same* loop rather than a second
     * implementation, so the publishability rule (INV-08-4) cannot differ
     * between the preview, the act and the diff.
     */
    verdictsOnly?: boolean;
  } = {},
): Promise<SnapshotBuild> {
  const [facts, conflicts] = await Promise.all([
    opts.facts ? Promise.resolve(opts.facts) : loadScheduleFacts(app, eventId),
    listConflicts(app, eventId),
  ]);
  const event = facts.event;
  const errorCodes = errorCodesBySession(conflicts);
  const overrides = opts.overrideSessionIds ?? new Set<string>();

  const placementBySession = new Map(facts.placements.map((p) => [p.session_id, p]));
  const roomRowById = new Map(facts.roomRows.map((r) => [str(r.id), r]));
  const dayRows = facts.dayRows.filter((d) => !opts.scope?.event_day_ids?.length || opts.scope.event_day_ids.includes(str(d.id)));
  const dayIds = new Set(dayRows.map((d) => str(d.id)));

  // One round, not two: `sessionIds` is the only thing the second half needed
  // from the first, and it comes from the facts, which are already in hand.
  // Skipped entirely when only the verdicts were asked for.
  const lean = opts.verdictsOnly === true;
  const sessionIds = facts.sessionRows.map((s) => str(s.id));
  const [trackRows, formatRows, venueRow, assetRows, speakerRows, sessionAssetRows, sponsorshipRows, tierRows, sponsorRows] = lean
    ? [[] as Row[], [] as Row[], null, [] as Row[], [] as Row[], [] as Row[], [] as Row[], [] as Row[], [] as Row[]]
    : await Promise.all([
        app.db.select<Row>("track", { event_id: eventId }, { orderBy: "sort_order, name" }),
        app.db.select<Row>("session_format", { event_id: eventId }, { orderBy: "sort_order, name" }),
        event.venue_id ? app.db.byId<Row>("venue", event.venue_id) : Promise.resolve(null),
        app.db.select<Row>("asset", {}),
        sessionIds.length ? app.db.select<Row>("session_speaker", { session_id: sessionIds }, { orderBy: "sort_order" }) : Promise.resolve([] as Row[]),
        sessionIds.length ? app.db.select<Row>("session_asset", { session_id: sessionIds }) : Promise.resolve([] as Row[]),
        app.db.select<Row>("sponsorship", { event_id: eventId }),
        app.db.select<Row>("sponsorship_tier", { event_id: eventId }),
        app.db.select<Row>("sponsor", {}),
      ]);
  const assetById = new Map(assetRows.map((a) => [str(a.id), a]));
  const trackById = new Map(trackRows.map((t) => [str(t.id), t]));
  const formatById = new Map(formatRows.map((f) => [str(f.id), f]));
  const sponsorById = new Map(sponsorRows.map((s) => [str(s.id), s]));
  const tierById = new Map(tierRows.map((t) => [str(t.id), t]));
  const sponsorshipBySponsor = new Map(sponsorshipRows.map((s) => [str(s.sponsor_id), s]));

  const verdicts: PublishabilityVerdict[] = [];
  const sessions: PublishedSessionSnapshot[] = [];
  const includedSessionIds = new Set<string>();

  for (const row of facts.sessionRows) {
    const id = str(row.id);
    const fact = facts.sessions[id];
    const placement = placementBySession.get(id) ?? null;
    const roomRow = placement ? roomRowById.get(placement.room_id) : null;
    if (opts.scope?.track_ids?.length && (!row.track_id || !opts.scope.track_ids.includes(str(row.track_id)))) continue;
    if (placement && dayIds.size > 0 && !dayIds.has(placement.event_day_id)) continue;

    const verdict = publishability({
      session_id: id,
      title: str(row.title),
      visibility: str(row.visibility, "public"),
      status: str(row.status),
      content_status: str(row.content_status, "draft"),
      blocking_tasks_outstanding: fact?.blocking_tasks_outstanding ?? 0,
      publication_override_reason: strOrNull(row.publication_override_reason),
      has_placement: !!placement,
      placement_is_public: placement?.is_public ?? false,
      room_is_public: roomRow ? bool(roomRow.is_public) : false,
      error_conflict_codes: errorCodes.get(id) ?? [],
    });
    verdicts.push(verdict);

    // INV-08-4: only placed, public, error-free sessions — unless an override
    // with a reason is recorded in `override_reasons`.
    if (!verdict.publishable && !(verdict.overridable && overrides.has(id))) continue;
    if (!placement) continue;

    includedSessionIds.add(id);
    // The verdict is the answer; the payload below is not being asked for.
    if (lean) continue;
    const track = row.track_id ? trackById.get(str(row.track_id)) : null;
    const format = formatById.get(str(row.session_format_id));
    const sponsor = row.sponsor_id ? sponsorById.get(str(row.sponsor_id)) : null;
    const sponsorship = row.sponsor_id ? sponsorshipBySponsor.get(str(row.sponsor_id)) : null;
    const tier = sponsorship?.tier_id ? tierById.get(str(sponsorship.tier_id)) : null;

    const assets: PublishedAssetRef[] = (sessionAssetRows
      .filter((a) => str(a.session_id) === id)
      // Public slides/recording links only, respecting `public_from`.
      .filter((a) => bool(a.is_public) && (!a.public_from || str(a.public_from) <= app.now()))
      .map((a) => {
        const asset = assetById.get(str(a.asset_id));
        // INV-11-3: no asset reaches a public surface unless the scan is clean.
        if (!asset || str(asset.scan_status) !== "clean") return null;
        return { kind: str(a.kind), url: assetUrl(str(asset.id)) ?? "", label: strOrNull(asset.filename) };
      }) as (PublishedAssetRef | null)[])
      .filter((a): a is PublishedAssetRef => !!a && !!a.url);

    if (str(row.recording_url)) assets.push({ kind: "recording", url: str(row.recording_url), label: "Recording" });

    sessions.push({
      session_id: id,
      reference: str(row.reference),
      title: str(row.title),
      subtitle: strOrNull(row.subtitle),
      abstract: strOrNull(row.abstract),
      description: strOrNull(row.description),
      track: track ? trackRef(track) : null,
      format: format ? { id: str(format.id), name: str(format.name), slug: str(format.slug) } : null,
      room: roomRow ? roomRef(roomRow) : null,
      starts_at: placement.starts_at,
      ends_at: placement.ends_at,
      duration_minutes: num(row.duration_minutes),
      audience_level: strOrNull(row.audience_level),
      keywords: parseJson<string[]>(row.keywords, []),
      language: strOrNull(row.language),
      speaker_refs: [],
      sponsor:
        sponsor && str(row.sponsor_id)
          ? {
              id: str(sponsor.id),
              name: str(sponsor.display_name) || str(sponsor.name),
              slug: str(sponsor.slug),
              logo_url: assetUrl(sponsor.logo_asset_id ? str(sponsor.logo_asset_id) : null),
              tier_name: tier ? str(tier.name) : null,
            }
          : null,
      // INV-08-7: the disclosure flag, derived from `sponsor_id` (INV-06-1's
      // `is_sponsored_content`), rendered in every output format.
      is_sponsored_content: !!strOrNull(row.sponsor_id),
      assets,
      registration_url: strOrNull(row.registration_url),
      capacity: row.capacity_override === null || row.capacity_override === undefined ? (roomRow ? (roomRow.capacity === null ? null : num(roomRow.capacity)) : null) : num(row.capacity_override),
    });
  }

  /* Speakers ---------------------------------------------------------------- */

  const relevantSpeakers = speakerRows.filter(
    (sp) =>
      includedSessionIds.has(str(sp.session_id)) &&
      // "a speaker may be on the run sheet but not the website"
      bool(sp.is_public) &&
      !["declined", "withdrawn", "replaced"].includes(str(sp.confirmation_status)),
  );
  const personIds = [...new Set(relevantSpeakers.map((sp) => str(sp.person_id)))];
  const [personRows, profileRows] = await Promise.all([
    personIds.length ? app.db.select<Row>("person", { id: personIds }) : Promise.resolve([] as Row[]),
    personIds.length ? app.db.select<Row>("speaker_profile", { person_id: personIds }) : Promise.resolve([] as Row[]),
  ]);
  const profileByPerson = new Map(profileRows.map((p) => [str(p.person_id), p]));
  const profileIds = profileRows.map((p) => str(p.id));
  const linkRows = profileIds.length ? await app.db.select<Row>("profile_link", { speaker_profile_id: profileIds }, { orderBy: "sort_order" }) : [];

  const speakers: PublishedSpeakerSnapshot[] = [];
  for (const person of personRows) {
    const personId = str(person.id);
    const profile = profileByPerson.get(personId);
    // INV-08-8: no unlisted speaker in a publication payload. R15 removes them
    // from the directory; the invariant is the stricter of the two and wins.
    if (profile && !bool(profile.is_listed)) continue;

    const visibility = { ...DEFAULT_PROFILE_VISIBILITY, ...parseJson<Record<string, string>>(profile?.visibility, {}) };
    const shown = (field: string, value: string | null): string | null =>
      value && visibility[field as keyof typeof visibility] !== "private" ? value : null;

    const headshot = profile?.headshot_asset_id ? assetById.get(str(profile.headshot_asset_id)) : null;
    const display_name = str(person.display_name) || str(person.full_name);

    speakers.push({
      person_id: personId,
      display_name,
      pronouns: shown("pronouns", strOrNull(person.pronouns)),
      headline: shown("headline", strOrNull(profile?.headline)),
      job_title: shown("job_title", strOrNull(profile?.job_title)),
      company: shown("company", strOrNull(profile?.company)),
      short_bio: shown("short_bio", strOrNull(profile?.short_bio)),
      bio: shown("bio", strOrNull(profile?.bio)),
      // INV-11-3: an infected or unscanned headshot never reaches the website.
      headshot_url: headshot && str(headshot.scan_status) === "clean" ? assetUrl(str(headshot.id)) : null,
      links: linkRows
        .filter((l) => profile && str(l.speaker_profile_id) === str(profile.id) && bool(l.is_public))
        .map((l) => ({ kind: str(l.kind), url: str(l.url), label: strOrNull(l.label) })),
      session_refs: relevantSpeakers.filter((sp) => str(sp.person_id) === personId).map((sp) => str(sp.session_id)),
      sort_key: speakerSortKey(display_name),
    });
  }
  speakers.sort((a, b) => a.sort_key.localeCompare(b.sort_key));

  const publishedPersonIds = new Set(speakers.map((s) => s.person_id));
  for (const s of sessions) {
    s.speaker_refs = relevantSpeakers
      .filter((sp) => str(sp.session_id) === s.session_id && publishedPersonIds.has(str(sp.person_id)))
      .map((sp) => str(sp.person_id));
  }
  sessions.sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "") || (a.room?.name ?? "").localeCompare(b.room?.name ?? ""));

  const snapshotEvent: SnapshotEventRef = {
    id: event.id,
    name: event.name,
    slug: event.slug,
    tagline: event.tagline,
    // "Never publish local times without the zone."
    timezone: event.timezone,
    starts_on: event.starts_on,
    ends_on: event.ends_on,
    website_url: event.website_url,
    venue: venueRow ? { name: str(venueRow.name), address: strOrNull(venueRow.address), map_url: strOrNull(venueRow.map_url) } : null,
    days: dayRows.filter((d) => bool(d.is_public)).map((d) => ({ id: str(d.id), date: str(d.date), label: strOrNull(d.label) })),
  };

  const usedRoomIds = new Set(sessions.map((s) => s.room?.id).filter(Boolean) as string[]);
  const build: SnapshotBuild = {
    event: snapshotEvent,
    sessions,
    speakers,
    tracks: trackRows.filter((t) => bool(t.is_public) && sessions.some((s) => s.track?.id === str(t.id))).map(trackRef),
    formats: formatRows.filter((f) => bool(f.is_public) && sessions.some((s) => s.format?.id === str(f.id))).map((f) => ({ id: str(f.id), name: str(f.name), slug: str(f.slug) })),
    rooms: facts.roomRows.filter((r) => bool(r.is_public) && usedRoomIds.has(str(r.id))).map(roomRef),
    verdicts,
    publishable_session_ids: [...includedSessionIds],
    facts,
  };

  // INV-08-8, belt and braces: nothing whose audience is not public, and none
  // of the INV-01-4 fields, may be in the payload. `facts` is deliberately not
  // passed: it is the working rows this build read, not the payload, and it is
  // never serialised into a publication.
  assertNoPrivateFields({ event: build.event, sessions: build.sessions, speakers: build.speakers });
  return build;
}

function trackRef(row: Row): PublishedTrackRef {
  return { id: str(row.id), name: str(row.name), slug: str(row.slug), color: strOrNull(row.color) };
}

function roomRef(row: Row): PublishedRoomRef {
  return { id: str(row.id), name: str(row.name), slug: str(row.slug), floor: strOrNull(row.floor) };
}

/* -------------------------------------------------------------------------- */
/* Publish                                                                     */
/* -------------------------------------------------------------------------- */

export interface PublishInput {
  note?: string | null;
  scope?: PublishScope | null;
  /** `{session_id: reason}` — error conflicts and gates knowingly published. */
  override_reasons?: Record<string, string>;
}

export interface PublishOutcome {
  publication_id: string;
  version: number;
  content_etag: string;
  session_count: number;
  diff: DiffEntry[];
  skipped: PublishabilityVerdict[];
}

/**
 * Publishing is a single, always-available action (R25). It builds the
 * snapshot, computes the diff against the previous `live` publication, and
 * flips exactly one publication to `live` (INV-08-9).
 */
export async function publishSchedule(app: AppContext, eventId: string, input: PublishInput = {}): Promise<PublishOutcome> {
  const overrides = new Set(Object.keys(input.override_reasons ?? {}));
  for (const [sessionId, reason] of Object.entries(input.override_reasons ?? {})) {
    // INV-11-5: an override carries a reason.
    if (!String(reason).trim()) {
      throw invariantError("INV-11-5", "reason_required", "An override needs a reason.", { session_id: sessionId });
    }
  }

  // Conflicts are recomputed first so a publish can never be waved through on
  // a stale read model (INV-08-4).
  await recomputeConflicts(app, eventId);
  const build = await buildSnapshot(app, eventId, { scope: input.scope, overrideSessionIds: overrides });

  const previous = await liveRow(app, eventId);
  const previousSessions = previous ? await snapshotSessions(app, str(previous.id)) : [];
  const cancelled = new Set(
    (await app.db.select<Row>("session", { event_id: eventId, status: "cancelled" })).map((s) => str(s.id)),
  );
  const diff = computeDiff(previousSessions, build.sessions, cancelled);

  const etag = await contentEtag({ event: build.event, sessions: build.sessions, speakers: build.speakers });
  const versionRows = await app.db.raw<{ v: number }>("SELECT MAX(version) AS v FROM schedule_publication WHERE event_id = ?", [eventId]);
  const version = num(versionRows[0]?.v, 0) + 1;
  const now = app.now();
  const id = newId("SchedulePublication");

  await app.db.insert("schedule_publication", {
    id,
    event_id: eventId,
    version,
    status: "building",
    scope: input.scope ? JSON.stringify(input.scope) : null,
    published_by_person_id: app.actor.id ?? "system",
    published_at: now,
    note: input.note ?? null,
    override_reasons: input.override_reasons ? JSON.stringify(input.override_reasons) : null,
    content_etag: etag,
  });

  await writeSnapshotRows(app, id, build);
  await app.db.insertMany(
    "schedule_diff_entry",
    diff.map((d) => ({
      id: newId("ScheduleDiffEntry"),
      publication_id: id,
      change_type: d.change_type,
      session_id: d.session_id,
      before: d.before === null ? null : JSON.stringify(d.before),
      after: d.after === null ? null : JSON.stringify(d.after),
    })),
  );

  // INV-08-9: exactly one `live` publication per event. The previous one is
  // superseded first, so the unique index is never momentarily violated.
  if (previous) await app.db.update("schedule_publication", str(previous.id), { status: "superseded" });
  await app.db.update("schedule_publication", id, { status: "live" });

  // INV-08-5: `published` is where a session lands once it is in a snapshot.
  //
  // One read and one batched write for the whole snapshot, rather than a read
  // and a write per session: publishing a 200-session conference was 400
  // statements here alone, on the one write in the product that most wants to
  // be quick. `db.batch` is also all-or-nothing, so a snapshot can no longer
  // half-move its sessions to `published`.
  const publishedIds = build.sessions.map((s) => s.session_id);
  if (publishedIds.length) {
    const rows = await app.db.select<Row>("session", { id: publishedIds });
    const patches: Statement[] = [];
    for (const row of rows) {
      const patch: Row = { updated_at: now };
      if (str(row.status) === "scheduled") patch.status = "published";
      if (!row.published_at) patch.published_at = now;
      patches.push(buildUpdate("session", str(row.id), patch, app.db.orgId));
    }
    await app.db.batch(patches);
  }

  app.events.emit({
    type: "schedule.published",
    subject: { type: "publication", id },
    event_id: eventId,
    data: {
      publication_id: id,
      version,
      session_count: build.sessions.length,
      content_etag: etag,
      override_reasons: input.override_reasons ?? null,
    },
  });
  if (diff.length > 0) {
    app.events.emit({
      type: "schedule.changed",
      subject: { type: "publication", id },
      event_id: eventId,
      data: { publication_id: id, version, diff },
    });
    // `session.time_changed` and `session.room_changed` fire **only on
    // publication**, not on every drag (10-domain-events.md).
    for (const d of diff) {
      if (d.change_type === "time_changed") {
        app.events.emit({
          type: "session.time_changed",
          subject: { type: "session", id: d.session_id },
          event_id: eventId,
          data: { session_id: d.session_id, from: d.before, to: d.after, publication_id: id },
        });
      }
      if (d.change_type === "room_changed") {
        app.events.emit({
          type: "session.room_changed",
          subject: { type: "session", id: d.session_id },
          event_id: eventId,
          data: { session_id: d.session_id, from_room: d.before, to_room: d.after, publication_id: id },
        });
      }
    }
  }
  app.audit.record({
    action: "schedule.publish",
    entity_type: "schedule_publication",
    entity_id: id,
    after: { version, session_count: build.sessions.length, content_etag: etag },
    // INV-11-5: a publication with overrides is an audited override.
    reason: input.override_reasons && Object.keys(input.override_reasons).length ? JSON.stringify(input.override_reasons) : undefined,
  });

  await cacheSnapshot(app.env, eventId, await readSnapshot(app, id));
  return {
    publication_id: id,
    version,
    content_etag: etag,
    session_count: build.sessions.length,
    diff,
    skipped: build.verdicts.filter((v) => !v.publishable && !overrides.has(v.session_id)),
  };
}

async function writeSnapshotRows(app: AppContext, publicationId: string, build: SnapshotBuild): Promise<void> {
  await app.db.insertMany(
    "published_session",
    build.sessions.map((s, i) => ({
      id: newId("PublishedSession"),
      publication_id: publicationId,
      session_id: s.session_id,
      reference: s.reference,
      title: s.title,
      subtitle: s.subtitle,
      abstract: s.abstract,
      description: s.description,
      track: s.track ? JSON.stringify(s.track) : null,
      format: s.format ? JSON.stringify(s.format) : null,
      room: s.room ? JSON.stringify(s.room) : null,
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      duration_minutes: s.duration_minutes,
      audience_level: s.audience_level,
      keywords: JSON.stringify(s.keywords),
      language: s.language,
      speaker_refs: JSON.stringify(s.speaker_refs),
      sponsor: s.sponsor ? JSON.stringify(s.sponsor) : null,
      is_sponsored_content: s.is_sponsored_content ? 1 : 0,
      assets: JSON.stringify(s.assets),
      registration_url: s.registration_url,
      capacity: s.capacity,
      sort_order: i,
    })),
  );
  await app.db.insertMany(
    "published_speaker",
    build.speakers.map((s) => ({
      id: newId("PublishedSpeaker"),
      publication_id: publicationId,
      person_id: s.person_id,
      display_name: s.display_name,
      pronouns: s.pronouns,
      headline: s.headline,
      job_title: s.job_title,
      company: s.company,
      short_bio: s.short_bio,
      bio: s.bio,
      headshot_url: s.headshot_url,
      links: JSON.stringify(s.links),
      session_refs: JSON.stringify(s.session_refs),
      sort_key: s.sort_key,
    })),
  );
}

/* -------------------------------------------------------------------------- */
/* Rollback                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * "Publishing a wrong schedule an hour before doors open is a real event, and
 * the fix must be one button." Because publications are immutable snapshots,
 * rollback is just pointing `live` at an earlier version.
 */
export async function rollbackPublication(app: AppContext, eventId: string, targetId: string, reason?: string | null): Promise<{ restored_version: number; rolled_back_from_version: number | null }> {
  const target = await app.db.byId<Row>("schedule_publication", targetId);
  if (!target || str(target.event_id) !== eventId) throw notFound("Publication", targetId);
  const current = await liveRow(app, eventId);
  if (current && str(current.id) === targetId) {
    throw invariantError("INV-08-9", "already_live", "That version is already live.");
  }

  if (current) await app.db.update("schedule_publication", str(current.id), { status: "rolled_back" });
  await app.db.update("schedule_publication", targetId, { status: "live" });

  const restoredVersion = num(target.version);
  app.events.emit({
    type: "schedule.rolled_back",
    subject: { type: "publication", id: targetId },
    event_id: eventId,
    data: {
      publication_id: targetId,
      restored_version: restoredVersion,
      rolled_back_from_version: current ? num(current.version) : null,
    },
  });
  app.audit.record({
    action: "schedule.rollback",
    entity_type: "schedule_publication",
    entity_id: targetId,
    before: current ? { version: num(current.version) } : undefined,
    after: { version: restoredVersion },
    // 11-cross-cutting.md: schedule rollback must be audited, with a reason.
    reason: reason?.trim() || "Rolled back to an earlier published version.",
  });

  await cacheSnapshot(app.env, eventId, await readSnapshot(app, targetId));
  return { restored_version: restoredVersion, rolled_back_from_version: current ? num(current.version) : null };
}

/* -------------------------------------------------------------------------- */
/* Reading snapshots                                                           */
/* -------------------------------------------------------------------------- */

export async function liveRow(app: AppContext, eventId: string): Promise<Row | null> {
  return app.db.first<Row>("schedule_publication", { event_id: eventId, status: "live" });
}

export async function listPublications(app: AppContext, eventId: string): Promise<Row[]> {
  return app.db.select<Row>("schedule_publication", { event_id: eventId }, { orderBy: "version DESC" });
}

export async function snapshotSessions(app: AppContext, publicationId: string): Promise<PublishedSessionSnapshot[]> {
  const rows = await app.db.select<Row>("published_session", { publication_id: publicationId }, { orderBy: "sort_order" });
  return rows.map(toSessionSnapshot);
}

export function toSessionSnapshot(row: Row): PublishedSessionSnapshot {
  return {
    session_id: str(row.session_id),
    reference: str(row.reference),
    title: str(row.title),
    subtitle: strOrNull(row.subtitle),
    abstract: strOrNull(row.abstract),
    description: strOrNull(row.description),
    track: parseJson<PublishedTrackRef | null>(row.track, null),
    format: parseJson<PublishedFormatRef | null>(row.format, null),
    room: parseJson<PublishedRoomRef | null>(row.room, null),
    starts_at: strOrNull(row.starts_at),
    ends_at: strOrNull(row.ends_at),
    duration_minutes: num(row.duration_minutes),
    audience_level: strOrNull(row.audience_level),
    keywords: parseJson<string[]>(row.keywords, []),
    language: strOrNull(row.language),
    speaker_refs: parseJson<string[]>(row.speaker_refs, []),
    sponsor: parseJson<PublishedSessionSnapshot["sponsor"]>(row.sponsor, null),
    is_sponsored_content: bool(row.is_sponsored_content),
    assets: parseJson<PublishedAssetRef[]>(row.assets, []),
    registration_url: strOrNull(row.registration_url),
    capacity: row.capacity === null || row.capacity === undefined ? null : num(row.capacity),
  };
}

export function toSpeakerSnapshot(row: Row): PublishedSpeakerSnapshot {
  return {
    person_id: str(row.person_id),
    display_name: str(row.display_name),
    pronouns: strOrNull(row.pronouns),
    headline: strOrNull(row.headline),
    job_title: strOrNull(row.job_title),
    company: strOrNull(row.company),
    short_bio: strOrNull(row.short_bio),
    bio: strOrNull(row.bio),
    headshot_url: strOrNull(row.headshot_url),
    links: parseJson<PublishedSpeakerSnapshot["links"]>(row.links, []),
    session_refs: parseJson<string[]>(row.session_refs, []),
    sort_key: str(row.sort_key),
  };
}

/** The whole snapshot, as the public payload. */
export async function readSnapshot(app: AppContext, publicationId: string): Promise<ScheduleSnapshot | null> {
  const pub = await app.db.byId<Row>("schedule_publication", publicationId);
  if (!pub) return null;
  const eventRow = await app.db.byId<Row>("event", str(pub.event_id));
  if (!eventRow) return null;
  const event = toEventFact(eventRow);
  const [sessionRows, speakerRows, dayRows, venueRow] = await Promise.all([
    app.db.select<Row>("published_session", { publication_id: publicationId }, { orderBy: "sort_order" }),
    app.db.select<Row>("published_speaker", { publication_id: publicationId }, { orderBy: "sort_key" }),
    app.db.select<Row>("event_day", { event_id: event.id }, { orderBy: "sort_order, date" }),
    event.venue_id ? app.db.byId<Row>("venue", event.venue_id) : Promise.resolve(null),
  ]);

  const sessions = sessionRows.map(toSessionSnapshot);
  const tracks = new Map<string, PublishedTrackRef>();
  const formats = new Map<string, PublishedFormatRef>();
  const rooms = new Map<string, PublishedRoomRef>();
  for (const s of sessions) {
    if (s.track) tracks.set(s.track.id, s.track);
    if (s.format) formats.set(s.format.id, s.format);
    if (s.room) rooms.set(s.room.id, s.room);
  }

  return {
    publication_id: publicationId,
    version: num(pub.version),
    published_at: str(pub.published_at),
    content_etag: str(pub.content_etag),
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      tagline: event.tagline,
      timezone: event.timezone,
      starts_on: event.starts_on,
      ends_on: event.ends_on,
      website_url: event.website_url,
      venue: venueRow ? { name: str(venueRow.name), address: strOrNull(venueRow.address), map_url: strOrNull(venueRow.map_url) } : null,
      days: dayRows.filter((d) => bool(d.is_public)).map((d) => ({ id: str(d.id), date: str(d.date), label: strOrNull(d.label) })),
    },
    sessions,
    speakers: speakerRows.map(toSpeakerSnapshot),
    tracks: [...tracks.values()],
    formats: [...formats.values()],
    rooms: [...rooms.values()],
  };
}

/* -------------------------------------------------------------------------- */
/* KV cache — INV-09-6                                                         */
/* -------------------------------------------------------------------------- */

const CACHE_PREFIX = "snapshot:";

function cacheKeyFor(eventId: string): string {
  return `${CACHE_PREFIX}${eventId}`;
}

export async function cacheSnapshot(env: Env, eventId: string, snapshot: ScheduleSnapshot | null): Promise<void> {
  if (!snapshot) {
    await env.CACHE.delete(cacheKeyFor(eventId));
    return;
  }
  await env.CACHE.put(cacheKeyFor(eventId), JSON.stringify(snapshot));
}

export async function invalidateSnapshot(env: Env, eventId: string): Promise<void> {
  await env.CACHE.delete(cacheKeyFor(eventId));
}

/**
 * INV-09-6 — public endpoints serve programme data only from the `live`
 * publication, and serve it from cache: the embed never touches the database on
 * a warm read.
 */
export async function liveSnapshot(env: Env, orgId: string, eventId: string): Promise<ScheduleSnapshot | null> {
  const cached = await env.CACHE.get<ScheduleSnapshot>(cacheKeyFor(eventId), "json");
  if (cached) return cached;

  const db = new D1Db(env.DB, orgId);
  const pub = await db.first<Row>("schedule_publication", { event_id: eventId, status: "live" });
  if (!pub) return null;
  const app = { db, env, now: () => new Date().toISOString() } as unknown as AppContext;
  const snapshot = await readSnapshot(app, str(pub.id));
  if (snapshot) await cacheSnapshot(env, eventId, snapshot);
  return snapshot;
}

/** A pinned or preview publication, read directly rather than from the live cache. */
export async function snapshotById(env: Env, orgId: string, publicationId: string): Promise<ScheduleSnapshot | null> {
  const db = new D1Db(env.DB, orgId);
  const app = { db, env, now: () => new Date().toISOString() } as unknown as AppContext;
  return readSnapshot(app, publicationId);
}

/* -------------------------------------------------------------------------- */
/* PendingPublicationChanges (R25)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Derived, never stored. Diffs the live working state against the `live`
 * publication so the staleness is impossible to miss.
 */
export async function pendingChanges(
  app: AppContext,
  eventId: string,
  preloaded?: { facts: ScheduleFacts },
): Promise<PendingPublicationChanges> {
  // The schedule facts are loaded once and handed to the snapshot build, rather
  // than each of them loading their own. This function used to read the whole
  // fact set twice — once here, once inside `buildSnapshot` — and wait for the
  // live publication before starting either, which is four sequential rounds of
  // queries for a diff of one event. It is on the event dashboard as a single
  // count, where it was the slowest thing on the screen by a factor of three.
  //
  // `verdictsOnly` is the other half of the same saving: this needs to know
  // *which* sessions would publish, not what the payload would say about them,
  // so the build stops once it has decided.
  //
  // `preloaded.facts` extends the same rule one caller outwards: the agenda
  // builder has just read the whole fact set to draw the grid, and asking for
  // the pending count made it read it a second time — eleven statements to
  // answer a question its caller already held the inputs to.
  const [facts, live] = await Promise.all([
    preloaded?.facts ? Promise.resolve(preloaded.facts) : loadScheduleFacts(app, eventId),
    liveRow(app, eventId),
  ]);
  const [liveSessions, build] = await Promise.all([
    live ? snapshotSessions(app, str(live.id)) : Promise.resolve(null),
    buildSnapshot(app, eventId, { facts, verdictsOnly: true }),
  ]);
  // Named rather than read off `build.sessions`, which `verdictsOnly` leaves
  // empty — the answer must not depend on whether the payload was assembled.
  const publishableIds = new Set(build.publishable_session_ids);

  const placementBySession = new Map(facts.placements.map((p) => [p.session_id, p]));
  const roomById = new Map(facts.roomRows.map((r) => [str(r.id), r]));

  const working: WorkingSession[] = facts.sessionRows.map((row) => {
    const id = str(row.id);
    const placement = placementBySession.get(id);
    // A published session's times *are* its placement's (`buildSnapshot`:
    // `starts_at: placement.starts_at`), so the placement is the whole answer
    // and the payload does not have to be built to read it back.
    return {
      session_id: id,
      title: str(row.title),
      starts_at: placement?.starts_at ?? null,
      ends_at: placement?.ends_at ?? null,
      room_id: placement ? placement.room_id : null,
      room_name: placement ? str(roomById.get(placement.room_id)?.name) || null : null,
      content_status: str(row.content_status, "draft"),
      content_approved_at: strOrNull(row.content_approved_at),
      status: str(row.status),
      publishable: publishableIds.has(id),
    };
  });

  return pendingPublicationChanges(liveSessions, working, live ? num(live.version) : null, live ? str(live.published_at) : null);
}

/**
 * The Program context owns publication readiness (INV-06-5, INV-06-11). This is
 * the authoritative per-session check, used where one session is in question —
 * the bulk path uses the same facts through `buildSnapshot`.
 */
export async function sessionReadiness(app: AppContext, sessionId: string) {
  return readinessOf(app, sessionId);
}
