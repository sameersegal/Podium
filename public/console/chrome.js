/**
 * What a screen tells the shell about itself: which section of the event nav it
 * sits under, and what the document should be called.
 *
 * It is its own module rather than a pair of exports from `app.js` so that a
 * view importing it does not import the shell that imports the view. The cycle
 * would resolve — both ends are hoisted function declarations — but a cycle
 * that happens to work is a cycle waiting for someone to add a top-level
 * statement to one end of it.
 */

import { boot } from "./store.js";

export const chrome = { section: "overview" };

export function setChrome(options) {
  if (options.section) chrome.section = options.section;
  const suffix = boot.event ? " · " + boot.event.name : "";
  const title = (options.title ? options.title + suffix : "Admin") + " · Podium";
  if (document.title !== title) document.title = title;
}
