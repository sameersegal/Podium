/**
 * `Asset` — slot versioning and the scan gate (11, "Assets").
 *
 * Pure. Storage, checksums over real bytes and the R2 write live in the worker;
 * what is here is the arithmetic INV-11-9 and INV-11-3 turn on.
 */

import { invariantError } from "../shared/errors.js";
import type { AssetPurpose, ScanStatus } from "./types.js";

/**
 * `slot_key` says what a file *is an instance of* — `task:tsk_01H…`,
 * `session:ses_01H…:slides`, `person:per_01H…:headshot`. Re-uploading into the
 * same slot creates a version; the comment thread belongs to the slot.
 */
export function slotKey(subjectType: string, subjectId: string, kind?: string | null): string {
  return kind ? `${subjectType}:${subjectId}:${kind}` : `${subjectType}:${subjectId}`;
}

export interface ParsedSlot {
  subject_type: string;
  subject_id: string;
  kind: string | null;
}

export function parseSlotKey(key: string): ParsedSlot {
  const [subject_type = "", subject_id = "", kind] = key.split(":");
  return { subject_type, subject_id, kind: kind ?? null };
}

export interface SlotMember {
  id: string;
  version: number;
  deleted_at?: string | null;
}

/**
 * INV-11-9: uploading into an occupied `slot_key` creates a new `Asset` with
 * `version = max + 1` and `supersedes_asset_id` set. Prior versions are never
 * overwritten. `max` counts deleted rows too, so a version number is never
 * reused after a soft delete.
 */
export function nextVersion(existing: SlotMember[]): number {
  return existing.reduce((max, a) => Math.max(max, a.version), 0) + 1;
}

/** The asset the new version supersedes: the highest non-deleted one, if any. */
export function supersededBy(existing: SlotMember[]): SlotMember | null {
  const live = existing.filter((a) => !a.deleted_at).sort((a, b) => b.version - a.version);
  return live[0] ?? null;
}

/**
 * INV-11-9, second half: exactly one non-deleted asset per `slot_key` has
 * `is_latest`. It is derived (`D`) — no column, computed at read time.
 */
export function isLatest(asset: SlotMember, slot: SlotMember[]): boolean {
  if (asset.deleted_at) return false;
  const top = supersededBy(slot);
  return top?.id === asset.id;
}

export function markLatest<T extends SlotMember>(slot: T[]): (T & { is_latest: boolean })[] {
  const top = supersededBy(slot);
  return slot.map((a) => ({ ...a, is_latest: !a.deleted_at && a.id === top?.id }));
}

/* -------------------------------------------------------------------------- */
/* Scan gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * INV-11-3: an asset may not be attached to a completed task, a published
 * session, or any public surface unless `scan_status = clean`.
 */
export function assertAttachable(asset: { id: string; scan_status: ScanStatus }, where: string): void {
  if (asset.scan_status === "clean") return;
  throw invariantError(
    "INV-11-3",
    "asset_not_scanned",
    asset.scan_status === "infected"
      ? "That file failed its virus scan and cannot be used."
      : `That file is still being scanned (${asset.scan_status}), so it cannot be attached to ${where} yet.`,
    { asset_id: asset.id, scan_status: asset.scan_status, target: where },
  );
}

export function mayServePublicly(asset: { scan_status: ScanStatus; visibility: string }): boolean {
  return asset.scan_status === "clean" && asset.visibility === "public";
}

/* -------------------------------------------------------------------------- */
/* Filenames and types                                                         */
/* -------------------------------------------------------------------------- */

/** `filename` is stored "as uploaded, sanitised" (11, `Asset`). */
export function sanitiseFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/[^\w.\- ()\[\]]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || "file").slice(0, 200);
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  // Note what is absent: `svg`. See RENDERS_AS_MARKUP below.
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  zip: "application/zip",
  key: "application/vnd.apple.keynote",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/**
 * Types a browser will parse as a document rather than paint as an image, and
 * therefore types this app must never hand back for bytes somebody uploaded.
 *
 * INV-11-15: neither direction may resolve to a type the browser parses as a
 * document.
 *
 * `image/svg+xml` is the one that bites, because an SVG is an image everywhere
 * a person reasons about it and a scriptable XML document everywhere a browser
 * does. A headshot named `me.svg` used to be stored as `image/svg+xml` and
 * served inline, same-origin, by `GET /assets/:id` — so any speaker could run
 * script in an organizer's session on every screen that rendered their photo.
 */
const RENDERS_AS_MARKUP = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|.*javascript|.*\bxml)$/;

/**
 * `content_type` is "validated server-side, never trusted from the client":
 * the extension decides where we know it, and anything unrecognised falls back
 * to a type the browser will not execute.
 *
 * The claimed type and the extension map used to be checked by different rules
 * — the claimed one was screened for markup, the extension map was trusted
 * outright — so `.svg` walked straight past a guard written to stop exactly it.
 * One screen now applies to both, which is why it is the last thing this
 * function does rather than a branch inside one arm.
 */
export function resolveContentType(filename: string, claimed: string | null | undefined): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const known = EXTENSION_TYPES[ext];
  const c = (claimed ?? "").split(";")[0].trim().toLowerCase();
  const resolved = known || (!c || c === "application/octet-stream" ? "application/octet-stream" : c);
  // `application/octet-stream` rather than `text/plain`: an octet-stream is
  // downloaded, and a legitimate SVG logo stays a working file the organizer
  // can retrieve — it simply stops being something the browser will paint
  // inline on this origin.
  return RENDERS_AS_MARKUP.test(resolved) ? "application/octet-stream" : resolved;
}

/**
 * The type to actually put on the wire when serving a stored asset.
 *
 * `resolveContentType` fixes what gets *written*; rows written before it did
 * are still sitting in the table saying `image/svg+xml`, and a migration cannot
 * be the only answer because the read path is where the damage happens. So the
 * screen runs again at serve time. Belt and braces is the correct posture for
 * "bytes a stranger uploaded, rendered on our origin".
 */
export function safeServeContentType(stored: string | null | undefined): string {
  const c = (stored ?? "").split(";")[0].trim().toLowerCase();
  if (!c) return "application/octet-stream";
  return RENDERS_AS_MARKUP.test(c) ? "application/octet-stream" : c;
}

/** Purposes whose slot lives on a public surface, so the scan gate matters most. */
export const PUBLIC_PURPOSES: readonly AssetPurpose[] = ["headshot", "logo", "cover_image"];

/** Human size, for the files library. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

export interface CommentNode {
  id: string;
  parent_id: string | null;
  created_at: string;
}

/**
 * INV-11-10: one level of threading. A reply to a reply attaches to the top of
 * that thread rather than nesting, because two levels of indentation in a
 * conversation about a slide deck helps nobody.
 */
export function normaliseParent<T extends CommentNode>(comments: T[], parentId: string | null): string | null {
  if (!parentId) return null;
  const parent = comments.find((c) => c.id === parentId);
  if (!parent) return null;
  return parent.parent_id ?? parent.id;
}

export interface Thread<T extends CommentNode> {
  comment: T;
  replies: T[];
}

export function buildThreads<T extends CommentNode>(comments: T[]): Thread<T>[] {
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const roots = sorted.filter((c) => !c.parent_id);
  return roots.map((comment) => ({ comment, replies: sorted.filter((c) => c.parent_id === comment.id) }));
}
