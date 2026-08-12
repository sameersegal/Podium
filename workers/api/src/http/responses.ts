import { DomainError } from "@podiumstack/domain/shared/errors.js";
import type { SafeHtml } from "../ui/html.js";

export function htmlResponse(body: SafeHtml | string, init: ResponseInit = {}): Response {
  return new Response(String(body), {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

export function text(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/plain; charset=utf-8", ...(init.headers ?? {}) },
  });
}

export function redirect(location: string, status: 302 | 303 | 307 = 303, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { location, ...headers } });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

/** Typed errors carrying the invariant — 11-cross-cutting.md. */
export function errorResponse(err: unknown): Response {
  if (err instanceof DomainError) return json(err.toJSON(), { status: err.status });
  const message = err instanceof Error ? err.message : String(err);
  console.error("unhandled error", message, err instanceof Error ? err.stack : undefined);
  return json({ error: "internal_error", message: "Something went wrong." }, { status: 500 });
}

export function wantsJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  const url = new URL(req.url);
  return url.pathname.startsWith("/v1/") || (accept.includes("application/json") && !accept.includes("text/html"));
}
