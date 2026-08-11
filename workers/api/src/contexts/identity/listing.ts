/**
 * The management-API list envelope.
 *
 * 09: "List endpoints are cursor-paginated. Offsets over a growing proposal
 * table produce duplicates and gaps during a review round." The cursor is the
 * last id on the page, which works without a secondary index because ULIDs
 * sort by creation time (11, "Identifiers").
 *
 * It lives in Identity because Identity is the shared kernel — the Speaker CRM
 * surfaces are org-level views over `Person` and use the same envelope.
 */

import { str } from "@podiumconf/data/db.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PageRequest {
  limit: number;
  cursor: string | null;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export function pageRequest(url: URL): PageRequest {
  const raw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor: cursor && cursor.trim() !== "" ? cursor.trim() : null };
}

/**
 * Take one more row than asked for; if it came back, there is another page and
 * its cursor is the last id we are actually returning.
 */
export function pageOf<T extends Record<string, unknown>>(rows: T[], limit: number): Page<T> {
  const data = rows.slice(0, limit);
  const next = rows.length > limit && data.length > 0 ? str(data[data.length - 1].id) : null;
  return { data, next_cursor: next };
}
