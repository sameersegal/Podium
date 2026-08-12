/**
 * Response hardening, applied once in `index.ts` to everything the Worker
 * returns.
 *
 * Before this file the app set no security headers at all: no CSP, no
 * `nosniff`, no HSTS, no framing policy. That is what turned "an uploaded SVG
 * is served inline" from a containable bug into script execution in an
 * organizer's session, so the two fixes belong together — see `assets.ts` for
 * the other half.
 *
 * Two routes need something other than the default and get it here rather than
 * by each handler remembering:
 *
 *   /embed/:key   exists to be put in someone else's page (08, "The embed"),
 *                 so it must NOT be frame-denied. Everything else must be.
 *   /assets/:id   serves bytes an untrusted person uploaded. It gets a sandbox
 *                 CSP, which neutralises script in an SVG even if the type
 *                 negotiation above it is ever wrong again.
 */

/**
 * `script-src` still carries `'unsafe-inline'`, and that is a real hole, not an
 * oversight: 8 inline `<script>` blocks, 8 `onsubmit="return confirm(...)"`
 * handlers and one `href="javascript:history.back()"` would all stop working
 * without it, and silently breaking the confirm-before-delete dialogs is a
 * worse outcome than the header it buys. Closing it means giving the generated
 * blocks a per-request nonce and converting the inline handlers to listeners;
 * until then the directives that DO bite are the rest of this list.
 *
 * `object-src 'none'` and `base-uri 'self'` block two injection routes that do
 * not need inline script at all. `form-action 'self'` stops an injected form
 * posting a session elsewhere, and is the same property the `next=` fix
 * enforces on redirects.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Assets are same-origin (`/assets/:id`); `data:` covers the inline SVG icons
  // in `ui/layout.ts`.
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Uploaded bytes: no script, no plugins, no same-origin privileges at all. */
const UPLOAD_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:";

function isEmbed(pathname: string): boolean {
  return pathname === "/embed.js" || pathname.startsWith("/embed/");
}

function isUpload(pathname: string): boolean {
  return pathname.startsWith("/assets/") || pathname.startsWith("/files/");
}

/**
 * Returns a response carrying the hardening headers. Never overwrites a header
 * a handler set deliberately — `/assets/:id` picks its own `content-type`, and
 * a handler that has already reasoned about its CSP knows more than this does.
 */
export function withSecurityHeaders(req: Request, res: Response): Response {
  // 101 responses carry a socket that `new Response(...)` drops on the floor.
  // `index.ts` returns those before reaching here; this is the second belt.
  if (res.status === 101) return res;

  const url = new URL(req.url);
  const out = new Response(res.body, res);

  // MIME sniffing is what lets a `text/plain` upload be executed as HTML
  // because it happens to start with `<html>`. There is no route in this app
  // that wants it.
  if (!out.headers.has("x-content-type-options")) out.headers.set("x-content-type-options", "nosniff");

  if (!out.headers.has("referrer-policy")) {
    // Paths here carry proposal, session and person ids. `strict-origin-when-
    // cross-origin` keeps the full URL for same-origin navigation (so in-app
    // `Referer` checks in `recoverableRedirect` still work) and sends only the
    // origin outward.
    out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }

  if (!out.headers.has("content-security-policy")) {
    out.headers.set("content-security-policy", isUpload(url.pathname) ? UPLOAD_CSP : CSP);
  }

  if (!out.headers.has("x-frame-options") && !isEmbed(url.pathname)) {
    out.headers.set("x-frame-options", "DENY");
    out.headers.append("content-security-policy", "; frame-ancestors 'none'");
  }

  // Only over https, and only for a real hostname: a `Strict-Transport-Security`
  // pinned against `localhost` would make every other local dev server on the
  // machine https-only, which is a hard-to-diagnose way to ruin someone's day.
  if (url.protocol === "https:" && url.hostname !== "localhost" && !out.headers.has("strict-transport-security")) {
    out.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  return out;
}
