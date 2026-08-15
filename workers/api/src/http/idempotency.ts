/**
 * INV-09-7 — every mutating request accepts `Idempotency-Key`; a repeat within
 * 24h replays the stored response and performs no new writes.
 *
 * KV is the replay cache (09, platform mapping).
 */

import type { Env } from "@podiumstack/data/context.js";

const TTL_SECONDS = 24 * 60 * 60;

interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function cacheKey(method: string, path: string, key: string): string {
  return `idem:${method}:${path}:${key}`;
}

export async function replayIfSeen(env: Env, req: Request): Promise<Response | null> {
  const key = req.headers.get("idempotency-key");
  if (!key) return null;
  const url = new URL(req.url);
  const stored = await env.CACHE.get<StoredResponse>(cacheKey(req.method, url.pathname, key), "json");
  if (!stored) return null;
  return new Response(stored.body, {
    status: stored.status,
    headers: { ...stored.headers, "idempotent-replay": "true" },
  });
}

export async function remember(env: Env, req: Request, res: Response): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) return res;
  if (res.status >= 500) return res;
  const url = new URL(req.url);
  const clone = res.clone();
  const body = await clone.text();
  const headers: Record<string, string> = {};
  clone.headers.forEach((v, k) => {
    headers[k] = v;
  });
  await env.CACHE.put(
    cacheKey(req.method, url.pathname, key),
    JSON.stringify({ status: res.status, headers, body } satisfies StoredResponse),
    { expirationTtl: TTL_SECONDS },
  );
  return res;
}

export function isMutating(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
