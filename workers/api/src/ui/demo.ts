/**
 * The bar that says where you are — 09, "Demonstration deployments" (R32).
 *
 * Injected once into every HTML response rather than passed through `page()`,
 * because it belongs to the deployment and not to any screen: threading an
 * option through several hundred `page({...})` calls would mean the one screen
 * somebody forgot is the one where a visitor types something real. `page()`
 * takes no environment and should not — it renders fragments — so the
 * substitution happens where the response is already being buffered to swap the
 * CSP nonce (`http/headers.ts`).
 *
 * What it has to say is not "demo": it is the two things a visitor cannot find
 * out by looking, and both of them are warnings. What you type here is public
 * and temporary, and nothing you do here reaches anybody by email (INV-09-28).
 */

import { html, type SafeHtml } from "./html.js";

/**
 * Mobile-first, and the split is not arbitrary: the short form is what a
 * visitor must have before they type, and at 320px the long form was 167px of
 * warning above a sign-in form — a fifth of the screen, spent on text somebody
 * reads once. The sentence that survives to the narrow layout is the one with a
 * consequence attached; the explanation of where the mail went waits for the
 * room to say it.
 */
export function demoBanner(): SafeHtml {
  return html`<div class="demo-bar" role="status">
    <span class="demo-bar-tag">Demo</span>
    <span>Shared with everyone and reset every hour. Nothing is emailed. Don't enter anything real.</span>
    <span class="demo-bar-more">Messages are written to the outbox instead — where you can read them.</span>
    <a href="https://podiumstack.com">What is Podium?</a>
  </div>`;
}

/**
 * Put the bar at the top of the page body.
 *
 * Matches the opening `<body>` tag and inserts after it, so the bar sits above
 * the top bar and inside the document flow — a fixed or sticky element would
 * cover content at the 320px floor and fight the keyboard on a phone.
 *
 * Returns the html unchanged when there is no `<body>`: an embed fragment, a
 * console partial or an error snippet is HTML that lives inside somebody else's
 * document, and a banner injected into it would be a banner in a page that is
 * not ours.
 */
export function withDemoBanner(body: string): string {
  const match = /<body[^>]*>/i.exec(body);
  if (!match) return body;
  const at = match.index + match[0].length;
  return body.slice(0, at) + demoBanner().toString() + body.slice(at);
}
