/**
 * `storage.r2` — the default storage implementation (09, platform mapping).
 *
 * 11 requires that "uploads are direct-to-storage via presigned URLs; the API
 * never proxies file bytes" and that "private assets [are served] only via
 * short-lived signed URLs".
 *
 * R2's *binding* has no S3-style presigner, so the presigned URL this plugin
 * mints is an HMAC-signed, short-lived, single-purpose URL back into the
 * deployment, whose handler streams the body straight into and out of the
 * bucket without buffering it. The properties the model asks for — the bytes do
 * not pass through application logic, and a private asset is reachable only
 * with a signature that expires — hold; what differs is who signs. A
 * self-hoster who wants true S3 presigning points `storage` at a plugin that
 * does it, which is exactly why the contract exists.
 */

import { PluginError, type PluginContext, type PresignedDownload, type PresignedUpload, type StoragePlugin } from "../contracts.js";

const DEFAULT_UPLOAD_TTL = 15 * 60;
const DEFAULT_DOWNLOAD_TTL = 5 * 60;

function bucketOf(ctx: PluginContext): R2Bucket {
  const bucket = ctx.bindings?.bucket;
  if (!bucket) throw new PluginError("storage.r2", "No object storage binding is available.");
  return bucket;
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `<storage_key>.<expiry>.<purpose>` is what the signature covers. */
export async function signStorageUrl(
  secret: string,
  purpose: "upload" | "download",
  storageKey: string,
  expiresAtSeconds: number,
): Promise<string> {
  return sign(secret, `${purpose}.${storageKey}.${expiresAtSeconds}`);
}

export async function verifyStorageUrl(
  secret: string,
  purpose: "upload" | "download",
  storageKey: string,
  expiresAtSeconds: number,
  signature: string,
  nowMs: number,
): Promise<boolean> {
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds * 1000 < nowMs) return false;
  const expected = await signStorageUrl(secret, purpose, storageKey, expiresAtSeconds);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export const storageR2Plugin: StoragePlugin = {
  key: "storage.r2",
  capability: "storage",
  display_name: "Object storage (R2)",
  requires_secret: false,
  config_fields: [],

  async presign_upload(req, ctx): Promise<PresignedUpload> {
    if (!ctx.secret) throw new PluginError("storage.r2", "No URL signing key is available.");
    const expires = Math.floor(Date.now() / 1000) + (req.expires_in_seconds ?? DEFAULT_UPLOAD_TTL);
    const sig = await signStorageUrl(ctx.secret, "upload", req.storage_key, expires);
    const url = new URL(`${ctx.base_url}/files/upload`);
    url.searchParams.set("key", req.storage_key);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("sig", sig);
    return {
      url: url.toString(),
      method: "PUT",
      headers: { "content-type": req.content_type },
      storage_key: req.storage_key,
      expires_at: new Date(expires * 1000).toISOString(),
    };
  },

  async presign_download(req, ctx): Promise<PresignedDownload> {
    if (!ctx.secret) throw new PluginError("storage.r2", "No URL signing key is available.");
    const expires = Math.floor(Date.now() / 1000) + (req.expires_in_seconds ?? DEFAULT_DOWNLOAD_TTL);
    const sig = await signStorageUrl(ctx.secret, "download", req.storage_key, expires);
    const url = new URL(`${ctx.base_url}/files/blob`);
    url.searchParams.set("key", req.storage_key);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("sig", sig);
    url.searchParams.set("filename", req.filename);
    return { url: url.toString(), expires_at: new Date(expires * 1000).toISOString() };
  },

  async delete(storageKey, ctx) {
    await bucketOf(ctx).delete(storageKey);
  },

  async get(storageKey, ctx) {
    const object = await bucketOf(ctx).get(storageKey);
    if (!object) return null;
    return { body: object.body, size: object.size };
  },

  async put(storageKey, data, contentType, ctx) {
    await bucketOf(ctx).put(storageKey, data as ReadableStream, {
      httpMetadata: { contentType },
    });
  },

  async health(ctx) {
    try {
      bucketOf(ctx);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  },
};
