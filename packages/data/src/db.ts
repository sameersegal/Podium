/**
 * The repository layer over D1 (R16).
 *
 * No D1-specific SQL escapes above this package: the domain layer never sees a
 * `D1Database`. Swapping in Postgres via Hyperdrive means reimplementing this
 * file, not the model.
 *
 * One rule is enforced here, once, rather than per endpoint:
 *   * INV-11-2 — soft-deleted rows are excluded from every read.
 *
 * There was a second until R9 was amended: every query was scoped by `org_id`.
 * INV-01-16 has always guaranteed one Organization per deployment, so that
 * predicate compared a column to the only value it held and could never
 * exclude a row. Migration 0012 drops the column; see its header for what
 * survived and why.
 */

import { versionConflict } from "@podiumstack/domain/shared/errors.js";

export type Row = Record<string, unknown>;

/** One prepared statement, for `Db.batch()` — see its doc comment. */
export interface Statement {
  sql: string;
  params?: unknown[];
}

export interface QueryOptions {
  /** Admin-only escape hatch for INV-11-2. */
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: string;
}

/** Tables carrying `deleted_at`. Reads exclude those rows by default. */
const SOFT_DELETE_TABLES = new Set([
  "person",
  "person_note",
  "event",
  "track",
  "session_format",
  "room",
  "call_for_proposals",
  "sponsor",
  "proposal",
  "session",
  "asset",
  "asset_comment",
  "review_comment",
]);

/**
 * Aggregate roots carrying `row_version` — 11-cross-cutting.md, "Concurrency".
 *
 * Every write to one of these bumps the counter, not just the compare-and-set
 * writes: a version that only moves on `updateVersioned` is a version that
 * misses the concurrent status transition, and a compare against it then passes
 * for an edit that was in fact stale. `tests/unit/data/versioned-tables.test.ts`
 * reads the migrations and fails if this set and the schema disagree.
 */
const VERSIONED_TABLES = new Set([
  "bulk_import",
  "call_for_proposals",
  "campaign",
  "contact_segment",
  "decision",
  "entitlement",
  "event",
  "event_participant",
  "integration",
  "invitation",
  "notification_template",
  "organization",
  "person",
  "placement",
  "proposal",
  "prospect_card",
  "review",
  "review_round",
  "rubric",
  "schedule_publication",
  "session",
  "sourcing_pipeline",
  "speaker_profile",
  "sponsor",
  "sponsorship",
  "submission_form",
  "sync_mapping",
  "task_definition",
  "task_instance",
  "webhook",
]);

export function isVersioned(table: string): boolean {
  return VERSIONED_TABLES.has(table);
}

export function hasSoftDelete(table: string): boolean {
  return SOFT_DELETE_TABLES.has(table);
}

export interface Db {
  /** Rows matching `where`, excluding soft-deleted rows. */
  select<T extends Row = Row>(table: string, where?: Row, opts?: QueryOptions): Promise<T[]>;
  first<T extends Row = Row>(table: string, where: Row, opts?: QueryOptions): Promise<T | null>;
  byId<T extends Row = Row>(table: string, id: string, opts?: QueryOptions): Promise<T | null>;
  count(table: string, where?: Row, opts?: QueryOptions): Promise<number>;
  insert<T extends Row = Row>(table: string, values: Row): Promise<T>;
  insertMany(table: string, rows: Row[]): Promise<void>;
  update(table: string, id: string, values: Row): Promise<void>;
  /** Compare-and-set on `row_version` — 409 with the current state on conflict. */
  updateVersioned(table: string, id: string, expectedVersion: number, values: Row): Promise<number>;
  softDelete(table: string, id: string, at: string): Promise<void>;
  hardDelete(table: string, where: Row): Promise<void>;
  /** Escape hatch for reads the generic helpers cannot express. */
  raw<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  rawRun(sql: string, params?: unknown[]): Promise<void>;
  /**
   * Every statement commits or none do — the one escape from "every helper
   * writes immediately" for flows that must not leave partial state (e.g.
   * first-run bootstrap, 01-identity-and-access.md, "First-run setup").
   * Build statements with `buildInsert`/`buildUpdate` rather than hand-rolled
   * SQL, so this stays the single place column lists and placeholders are
   * assembled.
   */
  batch(statements: Statement[]): Promise<void>;
}

/**
 * Builds an `INSERT` statement without executing it, for callers assembling a
 * `Db.batch()` — the same column/placeholder logic `D1Db.insert` uses, so a
 * batched insert and an immediate one can never drift apart. Returns the row
 * alongside the statement, since the caller usually needs the row's id before
 * the batch has actually run.
 */
export function buildInsert(table: string, values: Row): { statement: Statement; row: Row } {
  const keys = Object.keys(values);
  return {
    statement: {
      sql: `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      params: keys.map((k) => encode(values[k])),
    },
    row: values,
  };
}

/** Builds an `UPDATE` statement without executing it — see `buildInsert`. */
export function buildUpdate(table: string, id: string, values: Row): Statement {
  const keys = Object.keys(values);
  // An unversioned write to a versioned row still has to move the counter, or a
  // later compare-and-set silently compares against a version that never saw it
  // (VERSIONED_TABLES). `updateVersioned` assembles its own SQL and sets
  // `row_version` explicitly, so it never reaches this branch.
  const sets = [...keys.map((k) => `${k} = ?`), ...(VERSIONED_TABLES.has(table) ? ["row_version = row_version + 1"] : [])].join(",");
  const params: unknown[] = keys.map((k) => encode(values[k]));
  const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`;
  params.push(id);
  return { sql, params };
}

function buildWhere(table: string, where: Row, opts: QueryOptions): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (SOFT_DELETE_TABLES.has(table) && !opts.includeDeleted) {
    clauses.push("deleted_at IS NULL"); // INV-11-2
  }
  for (const [k, v] of Object.entries(where)) {
    if (v === null) {
      clauses.push(`${k} IS NULL`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        clauses.push("0 = 1");
      } else {
        clauses.push(`${k} IN (${v.map(() => "?").join(",")})`);
        params.push(...v);
      }
    } else {
      clauses.push(`${k} = ?`);
      params.push(v);
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function encode(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) return JSON.stringify(value);
  return value;
}

/* -------------------------------------------------------------------------- */
/* The per-request identity map                                                */
/* -------------------------------------------------------------------------- */

/**
 * One row, read once per request, however many layers ask for it.
 *
 * A request builds several `AppContext`s — `ctx.app()` returns a fresh one on
 * every call — and each builds its own `D1Db`, so nothing was in a position to
 * notice that the route guard, the page shell and the handler had all just read
 * the same `event` row. Profiling put that at the top of the list: the single
 * most repeated statement in the whole product was `SELECT * FROM event WHERE
 * id = ?`, up to four times in one request.
 *
 * Three rules keep it from becoming a staleness bug:
 *
 *   1. **Primary key reads only.** `byId` and nothing else. A `select` with a
 *      `where` is a question about a set, and a set can change under any write;
 *      one row identified by its id cannot change except by a write to that
 *      row, which is rule 2.
 *   2. **Any write to a table drops that table's rows.** Insert, update,
 *      versioned update, soft delete, hard delete — all of them. `rawRun` and
 *      `batch` carry SQL this layer does not parse, so they drop *everything*.
 *      Read-modify-write within a request therefore always re-reads.
 *   3. **Opt-in, per request.** `buildContext` enables it for safe methods
 *      (GET/HEAD) only. Queue consumers, cron sweeps and every mutating
 *      request run with no cache at all, exactly as before.
 *
 * Keyed on the `D1Database` binding rather than plumbed through constructors,
 * because the per-request binding proxy is already the one object every
 * `AppContext` of a request shares — the same seam `countingEnv` uses. A
 * `WeakMap` means the cache dies with the request that made it.
 */
const ROW_CACHES = new WeakMap<D1Database, Map<string, Row | null>>();

/** Turns the identity map on for everything sharing this binding. */
export function enableRowCache(d1: D1Database): void {
  if (!ROW_CACHES.has(d1)) ROW_CACHES.set(d1, new Map());
}

export function rowCacheSize(d1: D1Database): number {
  return ROW_CACHES.get(d1)?.size ?? 0;
}

export class D1Db implements Db {
  constructor(private readonly d1: D1Database) {}

  /** Rule 2 — a write to `table` invalidates every cached row of it. */
  private invalidate(table: string | null): void {
    const cache = ROW_CACHES.get(this.d1);
    if (!cache) return;
    if (table === null) {
      cache.clear();
      return;
    }
    const prefix = `${table} `;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  async select<T extends Row = Row>(table: string, where: Row = {}, opts: QueryOptions = {}): Promise<T[]> {
    const { sql, params } = buildWhere(table, where, opts);
    let q = `SELECT * FROM ${table}${sql}`;
    if (opts.orderBy) q += ` ORDER BY ${opts.orderBy}`;
    if (opts.limit) q += ` LIMIT ${Math.floor(opts.limit)}`;
    if (opts.offset) q += ` OFFSET ${Math.floor(opts.offset)}`;
    const res = await this.d1.prepare(q).bind(...params).all<T>();
    return res.results ?? [];
  }

  async first<T extends Row = Row>(table: string, where: Row, opts: QueryOptions = {}): Promise<T | null> {
    const rows = await this.select<T>(table, where, { ...opts, limit: 1 });
    return rows[0] ?? null;
  }

  async byId<T extends Row = Row>(table: string, id: string, opts: QueryOptions = {}): Promise<T | null> {
    if (!id) return null;
    const cache = ROW_CACHES.get(this.d1);
    // `includeDeleted` is part of the key because it changes the predicate: a
    // hit on the ordinary read must never answer the admin escape from
    // INV-11-2, or a soft-deleted row would become invisible to the one caller
    // entitled to see it. Nothing else varies the query — since migration 0012
    // there is no org to scope by.
    const key = cache ? `${table} ${opts.includeDeleted ? 1 : 0} ${id}` : "";
    if (cache && cache.has(key)) return cache.get(key) as T | null;
    const row = await this.first<T>(table, { id }, opts);
    if (cache) cache.set(key, row);
    return row;
  }

  async count(table: string, where: Row = {}, opts: QueryOptions = {}): Promise<number> {
    const { sql, params } = buildWhere(table, where, opts);
    const res = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM ${table}${sql}`)
      .bind(...params)
      .first<{ n: number }>();
    return res?.n ?? 0;
  }

  async insert<T extends Row = Row>(table: string, values: Row): Promise<T> {
    const { statement, row } = buildInsert(table, values);
    await this.d1.prepare(statement.sql).bind(...(statement.params ?? [])).run();
    this.invalidate(table);
    return row as T;
  }

  async insertMany(table: string, rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const statements = rows.map((row) => {
      const keys = Object.keys(row);
      return this.d1
        .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .bind(...keys.map((k) => encode(row[k])));
    });
    await this.d1.batch(statements);
    this.invalidate(table);
  }

  async update(table: string, id: string, values: Row): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const { sql, params } = buildUpdate(table, id, values);
    await this.d1.prepare(sql).bind(...(params ?? [])).run();
    this.invalidate(table);
  }

  /**
   * 11-cross-cutting.md, "Concurrency": aggregate roots carry a version
   * integer; writes are compare-and-set and a conflicting write returns 409
   * with the current state, never a silent overwrite.
   */
  async updateVersioned(table: string, id: string, expectedVersion: number, values: Row): Promise<number> {
    const next = expectedVersion + 1;
    const keys = Object.keys(values);
    const sets = [...keys.map((k) => `${k} = ?`), "row_version = ?"].join(",");
    const params: unknown[] = [...keys.map((k) => encode(values[k])), next, id, expectedVersion];
    const sql = `UPDATE ${table} SET ${sets} WHERE id = ? AND row_version = ?`;
    const res = await this.d1.prepare(sql).bind(...params).run();
    this.invalidate(table);
    const changed = res.meta?.changes ?? 0;
    if (changed === 0) {
      const current = await this.byId(table, id, { includeDeleted: true });
      throw versionConflict(table, expectedVersion, Number(current?.row_version ?? -1), current);
    }
    return next;
  }

  async softDelete(table: string, id: string, at: string): Promise<void> {
    await this.update(table, id, { deleted_at: at });
  }

  async hardDelete(table: string, where: Row): Promise<void> {
    const { sql, params } = buildWhere(table, where, { includeDeleted: true });
    await this.d1.prepare(`DELETE FROM ${table}${sql}`).bind(...params).run();
    this.invalidate(table);
  }

  async raw<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.d1.prepare(sql).bind(...params.map(encode)).all<T>();
    return res.results ?? [];
  }

  async rawRun(sql: string, params: unknown[] = []): Promise<void> {
    await this.d1.prepare(sql).bind(...params.map(encode)).run();
    this.invalidate(null); // Rule 2 — SQL this layer does not parse drops everything.
  }

  /**
   * `d1.batch()` runs every statement as one SQL transaction: if any fails,
   * none of the writes are applied. This is the only all-or-nothing
   * primitive `D1Db` offers — see the interface doc comment on `batch`.
   * Params passed through `buildInsert`/`buildUpdate` are already `encode`d;
   * running them through `encode` again here is idempotent, so raw callers
   * building a `Statement` by hand don't have to remember to do it themselves.
   */
  async batch(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.d1.batch(statements.map((s) => this.d1.prepare(s.sql).bind(...(s.params ?? []).map(encode))));
    this.invalidate(null); // Rule 2 — SQL this layer does not parse drops everything.
  }
}

/** JSON column helpers — `T[]` and `json` fields are stored as text. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function str(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}
