/**
 * Optimistic concurrency for the HTML forms — 11-cross-cutting.md,
 * "Concurrency", INV-11-14.
 *
 * The repository layer has had compare-and-set since the first migration
 * (`Db.updateVersioned`), but a form that does not send back the `row_version`
 * it rendered gives it nothing to compare, so the write falls through to a
 * plain `UPDATE` and the second of two organizers editing the same session
 * wins silently. These three functions are the round trip: render the version
 * into the form, read it back off the submission, and turn the 409 into
 * something a person can act on.
 *
 * The shape is the submission wizard's `stale_draft` handling
 * (`contexts/submissions/routes.ts`, INV-04-6) generalised — that is the one
 * path in the repo that already got this right, down to the copy.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { num, type Row } from "@podiumconf/data/db.js";
import { DomainError } from "@podiumconf/domain/shared/errors.js";
import { flashCookie } from "./context.js";
import type { Input } from "./input.js";
import { redirect } from "./responses.js";
import { html, type SafeHtml } from "../ui/html.js";

/**
 * The hidden field that makes a form's write compare-and-set. Render it inside
 * any `<form>` whose POST reaches `updateVersioned`; without it the write is
 * last-write-wins and INV-11-14 does not hold for that screen.
 */
export function versionField(row: { row_version?: unknown }): SafeHtml {
  // Structural rather than `Row`, so the views that have already projected a
  // database row into a typed shape (`RoundView`, `SessionRow`) can pass it
  // straight through — an interface is not assignable to `Record<string, unknown>`.
  return html`<input type="hidden" name="row_version" value="${String(num(row.row_version, 1))}">`;
}

/**
 * The version the browser rendered, or `null` when the form did not carry one.
 *
 * `null` is deliberately permissive rather than a hard failure: the JSON API
 * (`PATCH /v1/events/:id`) has always accepted the field as optional, and
 * making it required would break every existing integration. An HTML form that
 * omits it has simply not been migrated yet.
 */
export function expectedVersion(input: Input): number | null {
  return input.int("row_version");
}

/**
 * Turns a compare-and-set failure into a 303 back to the screen with a warning
 * flash; returns `null` for anything else, so the caller rethrows.
 *
 *     try {
 *       await updateEvent(app, id, patch, expectedVersion(input));
 *     } catch (err) {
 *       const stale = await staleWriteRedirect(err, app, `/admin/events/${id}`);
 *       if (stale) return stale;
 *       throw err;
 *     }
 *
 * It flushes on the way out because the service may already have raised audit
 * entries or events before the conflicting write threw, and a context that is
 * never flushed drops them — the failure `tests/unit/shared/unit-of-work.test.ts`
 * exists to catch. The wizard does the same at its own `stale_draft` branch.
 *
 * The redirect is what shows the current server state: the screen re-reads the
 * row, so the reader sees what the other writer actually saved rather than a
 * diff they have to reconstruct.
 */
export async function staleWriteRedirect(err: unknown, app: AppContext, backTo: string): Promise<Response | null> {
  if (!(err instanceof DomainError) || err.code !== "version_conflict") return null;
  await app.flush();
  return redirect(backTo, 303, { "set-cookie": flashCookie("warn", STALE_WRITE_MESSAGE) });
}

/**
 * Near-verbatim from the wizard's INV-04-6 message, which is the copy in this
 * repo that has already been through this problem. It says where the change
 * came from and that the refusal is why nothing of theirs landed — the version
 * numbers stay in the JSON `details`, where a person editing a session has no
 * use for them. It avoids promising "shown below" because the same string also
 * backs the error page in `index.ts`, which has no form on it.
 */
export const STALE_WRITE_MESSAGE =
  "Someone else changed this since you loaded it, so your edit was not applied. Check their version before reapplying your change.";
