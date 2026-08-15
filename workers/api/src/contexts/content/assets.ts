/**
 * `Asset` + `AssetComment` — 11-cross-cutting.md, "Assets".
 *
 * Uploads are direct-to-storage; the API never proxies file bytes for the
 * presigned flow, and the no-JS multipart path writes straight to the
 * `ASSETS_BUCKET` binding without an intermediate buffer beyond what the
 * platform's request body already holds.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { num, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { sha256Hex } from "@podiumstack/domain/identity/credentials.js";
import { DomainError, invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import {
  assertAttachable,
  buildThreads,
  nextVersion,
  normaliseParent,
  resolveContentType,
  sanitiseFilename,
  supersededBy,
  type SlotMember,
} from "@podiumstack/domain/content/assets.js";
import type { AssetPurpose, AssetVisibility, ScanStatus } from "@podiumstack/domain/content/types.js";
import { resolvePlugin } from "../platform/service.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB — slide decks and task attachments, not video.

function storageKeyFor(orgId: string, slotKey: string, version: number, filename: string): string {
  return `${orgId}/${slotKey.replace(/:/g, "/")}/${version}/${filename}`;
}

/**
 * Every asset the slot has ever held, soft-deleted ones included — a deliberate
 * escape from INV-11-2's default, not an oversight.
 *
 * `nextVersion` numbers a new upload above every version the slot has *ever*
 * carried, and `supersededBy` needs the unbroken chain. Filtering `deleted_at`
 * here would let a deleted asset's version number be handed out a second time,
 * which is the one thing INV-11-9 exists to prevent. Callers wanting the live
 * asset filter it themselves — see `latestInSlot`.
 */
async function assetsInSlot(app: AppContext, slotKey: string): Promise<Row[]> {
  // nosemgrep: claude.skills.security-audit.rules.podium-raw-sql-unscoped
  return app.db.raw<Row>("SELECT * FROM asset WHERE slot_key = ?", [slotKey]);
}

export interface CreatedAsset {
  asset: Row;
  superseded: Row | null;
}

interface AssetFacts {
  slot_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  storage_key: string;
  purpose: AssetPurpose;
  visibility: AssetVisibility;
  width?: number | null;
  height?: number | null;
  expires_at?: string | null;
}

/**
 * INV-11-9: uploading into an occupied `slot_key` creates `version = max + 1`
 * with `supersedes_asset_id` set; prior versions are never overwritten.
 */
async function recordAsset(app: AppContext, facts: AssetFacts): Promise<CreatedAsset> {
  const existing = await assetsInSlot(app, facts.slot_key);
  const slotMembers: SlotMember[] = existing.map((a) => ({ id: str(a.id), version: num(a.version), deleted_at: strOrNull(a.deleted_at) }));
  const version = nextVersion(slotMembers);
  const supersedes = supersededBy(slotMembers);
  const supersededRow = supersedes ? existing.find((a) => str(a.id) === supersedes.id) ?? null : null;

  const id = newId("Asset");
  const row: Row = {
    id,
    storage_key: facts.storage_key,
    filename: facts.filename,
    content_type: facts.content_type,
    size_bytes: facts.size_bytes,
    checksum: facts.checksum,
    width: facts.width ?? null,
    height: facts.height ?? null,
    scan_status: "pending", // INV-11-3 — a scan reaction (content/reactions.ts) clears it.
    visibility: facts.visibility,
    uploaded_by_person_id: app.actor.id ?? "system",
    purpose: facts.purpose,
    expires_at: facts.expires_at ?? null,
    slot_key: facts.slot_key,
    version,
    supersedes_asset_id: supersedes?.id ?? null,
    created_at: app.now(),
  };
  await app.db.insert("asset", row);

  app.events.emit({
    type: "asset.uploaded",
    subject: { type: "asset", id },
    data: {
      asset_id: id,
      slot_key: facts.slot_key,
      version,
      purpose: facts.purpose,
      filename: facts.filename,
      size_bytes: facts.size_bytes,
      uploaded_by_person_id: app.actor.id ?? null,
    },
  });
  if (supersedes) {
    app.events.emit({
      type: "asset.version_superseded",
      subject: { type: "asset", id },
      data: { asset_id: id, superseded_asset_id: supersedes.id, slot_key: facts.slot_key, version },
    });
  }
  app.audit.record({ action: "asset.upload", entity_type: "asset", entity_id: id, after: { slot_key: facts.slot_key, version, filename: facts.filename } });
  return { asset: row, superseded: supersededRow };
}

/**
 * The no-JS path: a normal `multipart/form-data` POST that writes to
 * `ASSETS_BUCKET` and creates the row directly, so a browser with scripts
 * blocked can still upload a deck (08, "Degrade gracefully").
 */
export async function uploadAssetDirect(
  app: AppContext,
  input: { file: File; slot_key: string; purpose: AssetPurpose; visibility?: AssetVisibility },
): Promise<CreatedAsset> {
  const buffer = await input.file.arrayBuffer();
  if (buffer.byteLength === 0) throw new DomainError({ code: "empty_upload", message: "That file was empty.", status: 422 });
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new DomainError({ code: "file_too_large", message: "That file is larger than the 100 MB limit.", status: 422 });
  }
  const filename = sanitiseFilename(input.file.name || "file");
  const contentType = resolveContentType(filename, input.file.type);
  const checksum = await sha256Hex(buffer);

  const existing = await assetsInSlot(app, input.slot_key);
  const version = nextVersion(existing.map((a) => ({ id: str(a.id), version: num(a.version), deleted_at: strOrNull(a.deleted_at) })));
  const storageKey = storageKeyFor(app.orgId, input.slot_key, version, filename);
  await app.env.ASSETS_BUCKET.put(storageKey, buffer, { httpMetadata: { contentType } });

  return recordAsset(app, {
    slot_key: input.slot_key,
    filename,
    content_type: contentType,
    size_bytes: buffer.byteLength,
    checksum,
    storage_key: storageKey,
    purpose: input.purpose,
    visibility: input.visibility ?? "private",
  });
}

/**
 * The presigned flow (09, `storage` capability): reserves the slot and the
 * storage key, hands back a presigned PUT the browser (or an API client)
 * writes bytes to directly. The row exists — `scan_status = pending` — before
 * any byte has necessarily arrived, same as the direct path.
 */
export async function presignAssetUpload(
  app: AppContext,
  input: { slot_key: string; filename: string; content_type: string; size_bytes: number; purpose: AssetPurpose; visibility?: AssetVisibility },
): Promise<{ asset: Row; upload: { url: string; method: string; headers: Record<string, string>; storage_key: string; expires_at: string } }> {
  if (input.size_bytes <= 0 || input.size_bytes > MAX_UPLOAD_BYTES) {
    throw new DomainError({ code: "file_too_large", message: "That file size is not acceptable.", status: 422 });
  }
  const resolved = await resolvePlugin(app, "storage", app.eventId);
  if (!resolved || resolved.plugin.capability !== "storage") {
    throw new DomainError({ code: "no_storage_provider", message: "No storage integration is configured for presigned uploads.", status: 422 });
  }
  const storagePlugin = resolved.plugin;
  const filename = sanitiseFilename(input.filename);
  const existing = await assetsInSlot(app, input.slot_key);
  const version = nextVersion(existing.map((a) => ({ id: str(a.id), version: num(a.version), deleted_at: strOrNull(a.deleted_at) })));
  const storageKey = storageKeyFor(app.orgId, input.slot_key, version, filename);
  const contentType = resolveContentType(filename, input.content_type);

  const upload = await storagePlugin.presign_upload({ storage_key: storageKey, content_type: contentType, max_bytes: MAX_UPLOAD_BYTES }, resolved.ctx);
  const { asset } = await recordAsset(app, {
    slot_key: input.slot_key,
    filename,
    content_type: contentType,
    size_bytes: input.size_bytes,
    checksum: "", // unknown until the bytes land; the scan reaction recomputes nothing here, but a future checksum step could.
    storage_key: upload.storage_key,
    purpose: input.purpose,
    visibility: input.visibility ?? "private",
  });
  return { asset, upload };
}

export async function getAsset(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("asset", id, { includeDeleted: true });
  if (!row) throw notFound("Asset", id);
  return row;
}

export async function listSlotVersions(app: AppContext, slotKey: string): Promise<Row[]> {
  const rows = await assetsInSlot(app, slotKey);
  return rows.sort((a, b) => num(b.version) - num(a.version));
}

export async function latestInSlot(app: AppContext, slotKey: string): Promise<Row | null> {
  const rows = await listSlotVersions(app, slotKey);
  return rows.find((a) => !a.deleted_at) ?? null;
}

/** INV-11-3 gate, applied wherever an asset is about to reach a public or gating surface. */
export function assertAssetClean(asset: Row, where: string): void {
  assertAttachable({ id: str(asset.id), scan_status: str(asset.scan_status) as ScanStatus }, where);
}

export async function markScanned(app: AppContext, assetId: string, status: "clean" | "infected" | "failed"): Promise<void> {
  const asset = await getAsset(app, assetId);
  if (str(asset.scan_status) === status) return; // idempotent
  await app.db.update("asset", assetId, { scan_status: status });
  app.events.emit({ type: "asset.scan_completed", subject: { type: "asset", id: assetId }, data: { asset_id: assetId, scan_status: status } });
}

export async function softDeleteAsset(app: AppContext, assetId: string, reason: string): Promise<void> {
  const asset = await getAsset(app, assetId);
  await app.db.softDelete("asset", assetId, app.now());
  app.audit.record({ action: "asset.delete", entity_type: "asset", entity_id: assetId, before: { filename: asset.filename }, reason });
}

/* -------------------------------------------------------------------------- */
/* AssetComment — INV-11-10, belongs to the slot, not the version              */
/* -------------------------------------------------------------------------- */

export async function listComments(app: AppContext, slotKey: string): Promise<Row[]> {
  return app.db.raw<Row>("SELECT * FROM asset_comment WHERE slot_key = ? AND deleted_at IS NULL ORDER BY created_at", [slotKey]);
}

interface CommentNodeRow {
  id: string;
  parent_id: string | null;
  created_at: string;
  row: Row;
}

export async function threadedComments(app: AppContext, slotKey: string): Promise<{ comment: Row; replies: Row[] }[]> {
  const comments = await listComments(app, slotKey);
  const nodes: CommentNodeRow[] = comments.map((c) => ({ id: str(c.id), parent_id: strOrNull(c.parent_id), created_at: str(c.created_at), row: c }));
  return buildThreads(nodes).map((t) => ({ comment: t.comment.row, replies: t.replies.map((r) => r.row) }));
}

export async function addComment(
  app: AppContext,
  input: { asset_id: string; body: string; parent_id?: string | null },
): Promise<string> {
  const asset = await getAsset(app, input.asset_id);
  const slotKey = str(asset.slot_key);
  const existing = await listComments(app, slotKey);
  const parsed = existing.map((c) => ({ id: str(c.id), parent_id: strOrNull(c.parent_id), created_at: str(c.created_at) }));
  const parentId = normaliseParent(parsed, input.parent_id ?? null); // INV-11-10: one level of threading.

  const id = newId("AssetComment");
  await app.db.insert("asset_comment", {
    id,
    asset_id: input.asset_id,
    slot_key: slotKey,
    author_person_id: app.actor.id ?? "system",
    body: input.body,
    parent_id: parentId,
    created_at: app.now(),
  });
  app.events.emit({
    type: "asset_comment.added",
    subject: { type: "asset", id: input.asset_id },
    data: { comment_id: id, asset_id: input.asset_id, slot_key: slotKey, author_person_id: app.actor.id ?? null, parent_id: parentId },
  });
  return id;
}

export async function editComment(app: AppContext, commentId: string, body: string): Promise<void> {
  const comment = await app.db.byId<Row>("asset_comment", commentId);
  if (!comment) throw notFound("Comment", commentId);
  if (str(comment.author_person_id) !== app.actor.id) {
    throw invariantError("INV-11-10", "not_your_comment", "Only the author may edit this comment.", { comment_id: commentId }, 403);
  }
  await app.db.update("asset_comment", commentId, { body, edited_at: app.now() });
}
