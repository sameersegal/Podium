/**
 * Publication — 08, "Publication".
 *
 * A publication is an **immutable snapshot**. Everything here is pure: the
 * shape of the snapshot, the rule about what may enter it (INV-08-4, INV-08-8),
 * the etag over its content (INV-08-11), the diff against the previous `live`
 * version, and `PendingPublicationChanges` (R25).
 */

import { NEVER_PUBLIC_PROFILE_FIELDS } from "../shared/pii.js";
import type { Instant } from "../shared/time.js";
import type { DiffChangeType } from "./types.js";

/* -------------------------------------------------------------------------- */
/* The snapshot                                                                */
/* -------------------------------------------------------------------------- */

export interface PublishedTrackRef {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

export interface PublishedFormatRef {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
}

export interface PublishedRoomRef {
  id: string;
  name: string;
  slug: string;
  floor: string | null;
}

export interface PublishedSponsorRef {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  tier_name: string | null;
}

export interface PublishedAssetRef {
  kind: string;
  url: string;
  label?: string | null;
}

export interface PublishedSessionSnapshot {
  session_id: string;
  reference: string;
  title: string;
  subtitle: string | null;
  abstract: string | null;
  description: string | null;
  track: PublishedTrackRef | null;
  format: PublishedFormatRef | null;
  /** null for online sessions. */
  room: PublishedRoomRef | null;
  starts_at: Instant | null;
  ends_at: Instant | null;
  duration_minutes: number;
  audience_level: string | null;
  keywords: string[];
  language: string | null;
  speaker_refs: string[];
  sponsor: PublishedSponsorRef | null;
  /** INV-08-7 — always rendered as a disclosure label, in every output format. */
  is_sponsored_content: boolean;
  assets: PublishedAssetRef[];
  registration_url: string | null;
  capacity: number | null;
}

export interface PublishedSpeakerSnapshot {
  person_id: string;
  display_name: string;
  pronouns: string | null;
  headline: string | null;
  job_title: string | null;
  company: string | null;
  short_bio: string | null;
  bio: string | null;
  headshot_url: string | null;
  links: { kind: string; url: string; label: string | null }[];
  session_refs: string[];
  /** Surname-ish sort key — R15: the directory is ordered by surname. */
  sort_key: string;
}

export interface SnapshotEventRef {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  /** The published payload carries UTC instants **plus** the event timezone. */
  timezone: string;
  starts_on: string;
  ends_on: string;
  website_url: string | null;
  venue: { name: string; address: string | null; map_url: string | null } | null;
  days: { id: string; date: string; label: string | null }[];
}

export interface ScheduleSnapshot {
  publication_id: string;
  version: number;
  published_at: Instant;
  content_etag: string;
  event: SnapshotEventRef;
  sessions: PublishedSessionSnapshot[];
  speakers: PublishedSpeakerSnapshot[];
  /** Denormalised so the embed needs no joins. */
  tracks: PublishedTrackRef[];
  formats: PublishedFormatRef[];
  rooms: PublishedRoomRef[];
}

/* -------------------------------------------------------------------------- */
/* INV-08-8 — what may not enter a snapshot                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fields that may never appear in a publication payload, whatever any
 * visibility setting says: the INV-01-4 trio, plus the contact PII from the
 * table in 11-cross-cutting.md.
 */
export const NEVER_PUBLISHED_FIELDS: readonly string[] = [
  ...NEVER_PUBLIC_PROFILE_FIELDS,
  "email",
  "email_at_provider",
  "travel_status",
  "attendance_mode",
  "notes",
  "custom_field_values",
];

/**
 * INV-08-8 — a defensive final pass over an assembled payload. The builder is
 * already field-by-field explicit; this catches a field someone adds later and
 * forgets to classify.
 */
export function assertNoPrivateFields(payload: unknown, path = "$"): void {
  if (payload === null || payload === undefined) return;
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoPrivateFields(v, `${path}[${i}]`));
    return;
  }
  if (typeof payload !== "object") return;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (NEVER_PUBLISHED_FIELDS.includes(k)) {
      const err = new Error(`Publication payload contains "${k}" at ${path}, which is never public (INV-08-8).`);
      (err as Error & { invariant?: string }).invariant = "INV-08-8";
      throw err;
    }
    assertNoPrivateFields(v, `${path}.${k}`);
  }
}

export interface PublishabilityInput {
  session_id: string;
  title: string;
  visibility: string;
  status: string;
  content_status: string;
  blocking_tasks_outstanding: number;
  publication_override_reason?: string | null;
  has_placement: boolean;
  placement_is_public: boolean;
  room_is_public: boolean;
  error_conflict_codes: string[];
}

export interface PublishabilityVerdict {
  session_id: string;
  publishable: boolean;
  /** Machine-readable reasons, each naming the invariant it comes from. */
  reasons: { code: string; invariant: string; message: string }[];
  /** True when an override in `override_reasons` would let it through. */
  overridable: boolean;
}

/**
 * INV-08-4 — a publication may only include sessions that are placed, public
 * and free of `error`-severity conflicts, unless an override with a reason is
 * recorded. INV-06-5 and INV-06-11 are the two upstream gates, and INV-06-8 /
 * INV-08-8 exclude internal sessions and private rooms outright.
 */
export function publishability(input: PublishabilityInput): PublishabilityVerdict {
  const reasons: PublishabilityVerdict["reasons"] = [];
  let overridable = true;

  if (input.visibility !== "public") {
    // INV-06-8: internal sessions never appear in a snapshot, at any override.
    reasons.push({ code: "session_internal", invariant: "INV-06-8", message: "The session is internal." });
    overridable = false;
  }
  if (input.status === "cancelled") {
    reasons.push({ code: "session_cancelled", invariant: "INV-08-10", message: "The session is cancelled." });
    overridable = false;
  }
  if (!input.has_placement) {
    reasons.push({ code: "not_placed", invariant: "INV-08-4", message: "The session has no placement." });
    overridable = false;
  }
  if (input.has_placement && !input.placement_is_public) {
    reasons.push({ code: "placement_not_public", invariant: "INV-08-4", message: "The placement is not public." });
    overridable = false;
  }
  if (input.has_placement && !input.room_is_public) {
    // INV-08-8: no private room in a publication payload.
    reasons.push({ code: "room_not_public", invariant: "INV-08-8", message: "The room is not public." });
    overridable = false;
  }
  if (input.blocking_tasks_outstanding > 0 && !input.publication_override_reason) {
    reasons.push({
      code: "blocking_tasks_outstanding",
      invariant: "INV-06-5",
      message: `${input.blocking_tasks_outstanding} blocking onboarding task${input.blocking_tasks_outstanding === 1 ? "" : "s"} outstanding.`,
    });
  }
  if (input.content_status !== "approved" && !input.publication_override_reason) {
    reasons.push({ code: "content_not_approved", invariant: "INV-06-11", message: `Content is ${input.content_status.replace(/_/g, " ")}, not approved.` });
  }
  for (const code of input.error_conflict_codes) {
    reasons.push({ code: `conflict_${code.toLowerCase()}`, invariant: "INV-08-4", message: `Unresolved ${code.replace(/_/g, " ").toLowerCase()} conflict.` });
  }

  return { session_id: input.session_id, publishable: reasons.length === 0, reasons, overridable: overridable && reasons.length > 0 };
}

/* -------------------------------------------------------------------------- */
/* INV-08-11 — the content etag                                                */
/* -------------------------------------------------------------------------- */

/** Deterministic JSON: object keys sorted, so key order can never move the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * INV-08-11 — `content_etag` changes **if and only if** the snapshot content
 * changes, so caches never serve stale content and never miss unnecessarily.
 *
 * It is therefore computed over the content only: not the publication id, not
 * the version, not `published_at`, none of which the reader can see.
 */
export async function contentEtag(content: {
  sessions: PublishedSessionSnapshot[];
  speakers: PublishedSpeakerSnapshot[];
  event: SnapshotEventRef;
}): Promise<string> {
  const canonical = stableStringify({
    event: content.event,
    sessions: [...content.sessions].sort((a, b) => (a.session_id < b.session_id ? -1 : 1)),
    speakers: [...content.speakers].sort((a, b) => (a.person_id < b.person_id ? -1 : 1)),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

/* -------------------------------------------------------------------------- */
/* Diffs                                                                       */
/* -------------------------------------------------------------------------- */

export interface DiffEntry {
  change_type: DiffChangeType;
  session_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const CONTENT_FIELDS = ["title", "subtitle", "abstract", "description"] as const;

/**
 * Diffs are computed at publish time against the previous `live` publication.
 * They drive the public "what changed" list, the "your talk moved to Room 3"
 * notification, and the `schedule.changed` webhook payload.
 *
 * `cancelledSessionIds` realises INV-08-10: a session cancelled after being
 * published is not removed from the old snapshot, it appears here as
 * `session_cancelled` so links do not 404.
 */
export function computeDiff(
  previous: PublishedSessionSnapshot[],
  next: PublishedSessionSnapshot[],
  cancelledSessionIds: Set<string> = new Set(),
): DiffEntry[] {
  const before = new Map(previous.map((s) => [s.session_id, s]));
  const after = new Map(next.map((s) => [s.session_id, s]));
  const out: DiffEntry[] = [];

  for (const [id, s] of after) {
    if (!before.has(id)) {
      out.push({ change_type: "session_added", session_id: id, before: null, after: { title: s.title, starts_at: s.starts_at, room: s.room?.name ?? null } });
    }
  }

  for (const [id, prev] of before) {
    const now = after.get(id);
    if (!now) {
      out.push({
        change_type: cancelledSessionIds.has(id) ? "session_cancelled" : "session_removed",
        session_id: id,
        before: { title: prev.title, starts_at: prev.starts_at, room: prev.room?.name ?? null },
        after: null,
      });
      continue;
    }
    if (prev.starts_at !== now.starts_at || prev.ends_at !== now.ends_at) {
      out.push({
        change_type: "time_changed",
        session_id: id,
        before: { starts_at: prev.starts_at, ends_at: prev.ends_at },
        after: { starts_at: now.starts_at, ends_at: now.ends_at },
      });
    }
    if ((prev.room?.id ?? null) !== (now.room?.id ?? null)) {
      out.push({
        change_type: "room_changed",
        session_id: id,
        before: { room: prev.room?.name ?? null, room_id: prev.room?.id ?? null },
        after: { room: now.room?.name ?? null, room_id: now.room?.id ?? null },
      });
    }
    if (stableStringify(prev.speaker_refs) !== stableStringify(now.speaker_refs)) {
      out.push({
        change_type: "speaker_changed",
        session_id: id,
        before: { speaker_refs: prev.speaker_refs },
        after: { speaker_refs: now.speaker_refs },
      });
    }
    const changed: Record<string, unknown> = {};
    const was: Record<string, unknown> = {};
    for (const f of CONTENT_FIELDS) {
      if (prev[f] !== now[f]) {
        was[f] = prev[f];
        changed[f] = now[f];
      }
    }
    if (Object.keys(changed).length > 0) {
      out.push({ change_type: "content_changed", session_id: id, before: was, after: changed });
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* PendingPublicationChanges (R25)                                             */
/* -------------------------------------------------------------------------- */

export interface WorkingSession {
  session_id: string;
  title: string;
  starts_at: Instant | null;
  ends_at: Instant | null;
  room_id: string | null;
  room_name: string | null;
  content_status: string;
  content_approved_at: Instant | null;
  status: string;
  publishable: boolean;
}

export const PENDING_CHANGE_KINDS = ["added", "removed", "retitled", "retimed", "reroomed", "reapproved"] as const;
export type PendingChangeKind = (typeof PENDING_CHANGE_KINDS)[number];

export interface PendingChange {
  kind: PendingChangeKind;
  session_id: string;
  title: string;
  detail: string;
}

export interface PendingPublicationChanges {
  count: number;
  changes: PendingChange[];
  /** Null when nothing has ever been published. */
  live_version: number | null;
  by_kind: Record<PendingChangeKind, number>;
}

/**
 * Derived, per event: diffs the live working state against the `live`
 * publication and reports what is unpublished — added, removed, retitled,
 * re-timed, re-roomed and re-approved sessions, with a count.
 *
 * "Every admin surface that shows publishable content shows this count, and
 * every edit to a published session says, at the point of editing, that the
 * change is not live yet" (R25).
 */
export function pendingPublicationChanges(
  live: PublishedSessionSnapshot[] | null,
  working: WorkingSession[],
  liveVersion: number | null,
  livePublishedAt: Instant | null = null,
): PendingPublicationChanges {
  const changes: PendingChange[] = [];
  const published = new Map((live ?? []).map((s) => [s.session_id, s]));
  const publishable = working.filter((w) => w.publishable);
  const publishableIds = new Set(publishable.map((w) => w.session_id));

  for (const w of publishable) {
    const prev = published.get(w.session_id);
    if (!prev) {
      changes.push({ kind: "added", session_id: w.session_id, title: w.title, detail: "not yet on the published schedule" });
      continue;
    }
    if (prev.title !== w.title) {
      changes.push({ kind: "retitled", session_id: w.session_id, title: w.title, detail: `published as "${prev.title}"` });
    }
    if (prev.starts_at !== w.starts_at || prev.ends_at !== w.ends_at) {
      changes.push({ kind: "retimed", session_id: w.session_id, title: w.title, detail: `published as ${prev.starts_at ?? "unscheduled"}` });
    }
    if ((prev.room?.id ?? null) !== w.room_id) {
      changes.push({
        kind: "reroomed",
        session_id: w.session_id,
        title: w.title,
        detail: `published in ${prev.room?.name ?? "no room"}, now ${w.room_name ?? "no room"}`,
      });
    }
    if (livePublishedAt && w.content_approved_at && w.content_approved_at > livePublishedAt) {
      changes.push({ kind: "reapproved", session_id: w.session_id, title: w.title, detail: "content approved again since the last publication" });
    }
  }

  for (const [id, prev] of published) {
    if (publishableIds.has(id)) continue;
    const w = working.find((x) => x.session_id === id);
    changes.push({
      kind: "removed",
      session_id: id,
      title: prev.title,
      detail: w ? (w.status === "cancelled" ? "cancelled since publication" : "no longer publishable") : "no longer in the programme",
    });
  }

  const by_kind = Object.fromEntries(PENDING_CHANGE_KINDS.map((k) => [k, 0])) as Record<PendingChangeKind, number>;
  for (const c of changes) by_kind[c.kind] += 1;
  return { count: changes.length, changes, live_version: liveVersion, by_kind };
}

/** Sort key for the speaker directory: surname first, then the whole name. */
export function speakerSortKey(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const surname = parts[parts.length - 1].toLowerCase();
  return `${surname} ${displayName.toLowerCase()}`;
}
