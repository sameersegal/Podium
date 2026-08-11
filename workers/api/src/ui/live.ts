/**
 * The server half of the live-update contract — `public/live.js` is the other.
 *
 * A page opts in by passing `live` to `page()`. Everything the client needs is
 * in data attributes on one empty element: no inline script, no JSON blob, and
 * nothing at all in the markup of a page that did not opt in. Public surfaces
 * never opt in, so "renders fully with scripts blocked" (08, "Degrade
 * gracefully") holds structurally rather than by anyone remembering it.
 */

import { html, type SafeHtml } from "./html.js";

export interface LiveOptions {
  /** The room. Omit for org-level screens. */
  eventId?: string | null;
  /**
   * `nudge` shows a bar offering a reload — the safe default, and the only
   * correct one on a screen with a form the reader may be typing into.
   * `refresh` re-fetches the current URL and swaps `<main>`, for read-only
   * dashboards where staleness is the whole complaint.
   */
  mode?: "nudge" | "refresh";
  /**
   * Subject types this screen cares about, e.g. `["review", "review_assignment"]`.
   * Rooms are per event, so the client drops everything else without touching
   * the DOM. Empty means "anything in this room".
   */
  subjects?: string[];
}

/**
 * The element the client binds to, plus the script tag. `hidden` and empty
 * until something happens, so it occupies no space and reads as nothing to a
 * screen reader; `public/live.js` fills it and unhides it.
 */
export function liveRegion(opts: LiveOptions): SafeHtml {
  const params = new URLSearchParams();
  if (opts.eventId) params.set("event", opts.eventId);
  const query = params.toString();
  return html`<div
      id="podium-live"
      class="live-bar"
      role="status"
      aria-live="polite"
      hidden
      data-live-url="/live/subscribe${query ? `?${query}` : ""}"
      data-live-mode="${opts.mode ?? "nudge"}"
      data-live-subjects="${(opts.subjects ?? []).join(",")}"
    ></div>
    <script src="/live.js" defer></script>`;
}
