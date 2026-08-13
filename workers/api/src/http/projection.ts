/**
 * `?fields=` — a caller asking a list for less than the whole row.
 *
 * The proposal board is the reason. It draws a table whose columns the reader
 * picks, and `abstract` is not one of them — yet the list answered with every
 * column of the entity, so a hundred rows of a real event's proposals crossed
 * the wire at 184 KB, most of it prose nothing on the screen renders.
 *
 * The shape of the fix matters more than the saving. Dropping fields from the
 * default response is not available: `/v1` is a published contract and an
 * integration reading `abstract` from this list today would stop working, which
 * is the same rule that makes domain events additive-only
 * ([`10`](../../../../docs/domain/10-domain-events.md)). So the default is
 * unchanged and a caller that wants less says so.
 *
 * Two properties make this safe to apply to a serialised row:
 *
 * - **It only ever removes.** Redaction and visibility have already run by the
 *   time a row reaches here — `includePii` decided what the row contains — so
 *   projection cannot widen what a reader sees, whatever they name. A `fields`
 *   list that asks for something the reader was not given still does not get it,
 *   because the value is not in the row to keep.
 * - **The vocabulary is the response, not a second list.** Legal names are the
 *   keys the serialiser produced, so a field added to a row is askable the same
 *   day, and there is no allow-list to drift out of step with the payload.
 *
 * An unknown name is a validation error rather than a silent omission: a client
 * that misspells a column should be told, not handed rows missing it.
 */

import { validationError } from "@podiumstack/domain/shared/errors.js";

/** Always present, whatever is asked for — a row nobody can address is not useful. */
const ALWAYS = ["id"];

export type Projection = Set<string> | null;

/**
 * Reads `?fields=a,b,c`. `null` means "everything", which is what a request
 * without the parameter has always meant and still does.
 */
export function projectionFrom(url: URL): Projection {
  const raw = url.searchParams.get("fields");
  if (raw === null) return null;
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) return null;
  return new Set([...ALWAYS, ...names]);
}

/**
 * Narrows one serialised row. Call it *after* the row is built, never before —
 * see the note above on why that ordering is the safety property.
 *
 * `known` is the full set of keys this endpoint can produce, used to reject a
 * name the caller invented. It is derived from a row rather than declared, so
 * pass the unprojected row of the same endpoint.
 */
export function project(row: Record<string, unknown>, fields: Projection): Record<string, unknown> {
  if (!fields) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (fields.has(key)) out[key] = row[key];
  }
  return out;
}

/**
 * Fails the request if the caller named a field this endpoint does not produce.
 * Checked once against a sample row rather than per row, and skipped entirely
 * when the list came back empty — there is nothing to be wrong about, and
 * guessing the vocabulary from an empty result would mean keeping a second copy
 * of it here.
 */
export function assertKnownFields(fields: Projection, sample: Record<string, unknown> | undefined): void {
  if (!fields || !sample) return;
  const unknown = [...fields].filter((f) => !(f in sample));
  if (unknown.length) {
    throw validationError(`Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`, [
      { field_key: "fields", message: `This list has no ${unknown.join(", ")}. Ask for names it returns, or omit \`fields\` for all of them.` },
    ]);
  }
}
