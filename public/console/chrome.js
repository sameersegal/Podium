/**
 * What a screen tells the shell about itself: which section of the event nav it
 * sits under, what the document should be called, and which keycaps the top bar
 * should show.
 *
 * It is its own module rather than a pair of exports from `app.js` so that a
 * view importing it does not import the shell that imports the view. The cycle
 * would resolve — both ends are hoisted function declarations — but a cycle
 * that happens to work is a cycle waiting for someone to add a top-level
 * statement to one end of it.
 */

import { redraw } from "./kit.js";
import { boot } from "./store.js";

export const chrome = { section: "overview", title: "Admin", hints: [] };

function stamp() {
  return chrome.section + "|" + chrome.title + "|" + chrome.hints.length;
}

export function setChrome(options) {
  const before = stamp();
  if (options.section) chrome.section = options.section;
  // Kept, not only spent on `document.title`: the top bar's breadcrumb names
  // the screen, and reading it back off the document title would mean parsing a
  // string this function had just assembled.
  if (options.title) chrome.title = options.title;
  // Signage for `public/keys.js`, which is loaded on both surfaces and reads
  // its list of rows out of the DOM — a screen that draws no hints still
  // answers `J`/`K`, it just does not say so.
  chrome.hints = options.hints || [];
  // The shell draws the bar *before* it draws the screen, so a screen that
  // names itself from data it has only just loaded names itself one frame too
  // late: the breadcrumb read "Review / Review" until some unrelated redraw
  // came along. Asking for another frame when a value actually changed fixes
  // it, and terminates — the next render sets the same values and asks for
  // nothing.
  if (stamp() !== before) redraw();
  const suffix = boot.event ? " · " + boot.event.name : "";
  const title = (options.title ? options.title + suffix : "Admin") + " · Podium";
  if (document.title !== title) document.title = title;
}
