/**
 * The console's `/v1` client.
 *
 * R30 leans on two properties of the management surface, and this module is
 * where both are relied upon rather than assumed:
 *
 * - **`/v1` already authenticates a browser session**, not only an API key, so
 *   every request here is a same-origin cookie request and there is no token to
 *   hold, refresh or leak into storage.
 * - **`SameSite=Lax` plus a JSON content type is the CSRF defence.** Lax
 *   withholds the cookie from a cross-site POST, and `application/json` is not
 *   a form-encodable content type, so a cross-origin write needs a preflight
 *   that will not be granted. That is now load-bearing and not an accident —
 *   which is why writes here always send JSON, never `FormData`.
 */

/** A typed error from the API — carries the invariant the server named. */
export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || "Something went wrong.");
    this.name = "ApiError";
    this.status = status;
    this.code = (body && body.error) || "error";
    this.invariant = (body && body.invariant) || null;
    this.details = (body && body.details) || null;
    this.fieldErrors = (body && body.field_errors) || [];
  }
}

function idempotencyKey() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return String(Date.now()) + "-" + Math.random().toString(36).slice(2);
}

async function request(method, path, body, options) {
  const opts = options || {};
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // INV-09-7 — a write carries a key so a retry replays rather than repeats.
  // The caller may pin one across its own retries; otherwise each attempt is a
  // distinct intent.
  if (method !== "GET") headers["idempotency-key"] = opts.idempotencyKey || idempotencyKey();

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, { error: "offline", message: "Could not reach the server. Check your connection." });
  }

  if (res.status === 401) {
    // The session went away underneath a long-lived console. Bounce, keeping
    // the place — permissions are recomputed per request, so there is no
    // client-side authority to clear.
    window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    throw new ApiError(401, { error: "unauthorized", message: "Sign in again." });
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) throw new ApiError(res.status, payload || { message: res.statusText });
  return payload;
}

export const api = {
  get: (path, options) => request("GET", path, undefined, options),
  post: (path, body, options) => request("POST", path, body || {}, options),
  patch: (path, body, options) => request("PATCH", path, body || {}, options),
  del: (path, options) => request("DELETE", path, undefined, options),
};

/** `{data: …}` is the envelope every list and most singles use. */
export function unwrap(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}
