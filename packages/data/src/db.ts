/**
 * The repository layer over D1 (R16).
 *
 * No D1-specific SQL escapes above this package: the domain layer never sees a
 * `D1Database`. Swapping in Postgres via Hyperdrive means reimplementing this
 * file, not the model.
 *
 * Two rules are enforced here, once, rather than per endpoint:
 *   * INV-11-1 — every query is org-scoped.
 *   * INV-11-2 — soft-deleted rows are excluded from every read.
 */

import { versionConflict } from "@podiumconf/domain/shared/errors.js";

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

/** Tables with a direct `org_id` column. Everything else is scoped by joining. */
const ORG_SCOPED_TABLES = new Set([
  "person",
  "person_note",
  "role_grant",
  "invitation",
  "event",
  "sponsor",
  "proposal",
  "session",
  "task_instance",
  "api_key",
  "webhook",
  "integration",
  "notification_template",
  "notification_delivery",
  "campaign",
  "asset",
  "custom_field_definition",
  "audit_log",
  "bulk_import",
  "export",
  "contact_segment",
  "sourcing_pipeline",
  "domain_event_record",
  "event_participant",
  "speaker_profile",
  "sync_mapping",
  "external_record_link",
  "sync_run",
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

export function isOrgScoped(table: string): boolean {
  return ORG_SCOPED_TABLES.has(table);
}

export function isVersioned(table: string): boolean {
  return VERSIONED_TABLES.has(table);
}

export function hasSoftDelete(table: string): boolean {
  return SOFT_DELETE_TABLES.has(table);
}

export interface Db {
  /** Rows matching `where`, org-scoped and excluding soft-deleted rows. */
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
  /** Escape hatch for reads the generic helpers cannot express. Still org-scoped by the caller. */
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
  /** A view of this Db bound to a different org, for the platform surfaces. */
  readonly orgId: string;
}

/** Applies the same "inject org_id for org-scoped tables" rule as `insert`. */
function withOrgId(table: string, values: Row, orgId: string): Row {
  if (ORG_SCOPED_TABLES.has(table) && values.org_id === undefined) return { ...values, org_id: orgId };
  return values;
}

/**
 * Builds an `INSERT` statement without executing it, for callers assembling a
 * `Db.batch()` — the same column/placeholder logic `D1Db.insert` uses, so a
 * batched insert and an immediate one can never drift apart. Returns the
 * finalised row (with `org_id` applied) alongside the statement, since the
 * caller usually needs the row's id before the batch has actually run.
 */
export function buildInsert(table: string, values: Row, orgId: string): { statement: Statement; row: Row } {
  const row = withOrgId(table, values, orgId);
  const keys = Object.keys(row);
  return {
    statement: {
      sql: `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      params: keys.map((k) => encode(row[k])),
    },
    row,
  };
}

/** Builds an `UPDATE` statement without executing it — see `buildInsert`. */
export function buildUpdate(table: string, id: string, values: Row, orgId: string): Statement {
  const keys = Object.keys(values);
  // An unversioned write to a versioned row still has to move the counter, or a
  // later compare-and-set silently compares against a version that never saw it
  // (VERSIONED_TABLES). `updateVersioned` assembles its own SQL and sets
  // `row_version` explicitly, so it never reaches this branch.
  const sets = [...keys.map((k) => `${k} = ?`), ...(VERSIONED_TABLES.has(table) ? ["row_version = row_version + 1"] : [])].join(",");
  const params: unknown[] = keys.map((k) => encode(values[k]));
  let sql = `UPDATE ${table} SET ${sets} WHERE id = ?`;
  params.push(id);
  if (ORG_SCOPED_TABLES.has(table)) {
    sql += " AND org_id = ?";
    params.push(orgId);
  }
  return { sql, params };
}

function buildWhere(table: string, orgId: string, where: Row, opts: QueryOptions): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (ORG_SCOPED_TABLES.has(table)) {
    clauses.push("org_id = ?"); // INV-11-1
    params.push(orgId);
  }
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

export class D1Db implements Db {
  constructor(
    private readonly d1: D1Database,
    readonly orgId: string,
  ) {}

  forOrg(orgId: string): D1Db {
    return new D1Db(this.d1, orgId);
  }

  async select<T extends Row = Row>(table: string, where: Row = {}, opts: QueryOptions = {}): Promise<T[]> {
    const { sql, params } = buildWhere(table, this.orgId, where, opts);
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
    return this.first<T>(table, { id }, opts);
  }

  async count(table: string, where: Row = {}, opts: QueryOptions = {}): Promise<number> {
    const { sql, params } = buildWhere(table, this.orgId, where, opts);
    const res = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM ${table}${sql}`)
      .bind(...params)
      .first<{ n: number }>();
    return res?.n ?? 0;
  }

  async insert<T extends Row = Row>(table: string, values: Row): Promise<T> {
    const { statement, row } = buildInsert(table, values, this.orgId);
    await this.d1.prepare(statement.sql).bind(...(statement.params ?? [])).run();
    return row as T;
  }

  async insertMany(table: string, rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const statements = rows.map((r) => {
      const row: Row = { ...r };
      if (ORG_SCOPED_TABLES.has(table) && row.org_id === undefined) row.org_id = this.orgId;
      const keys = Object.keys(row);
      return this.d1
        .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .bind(...keys.map((k) => encode(row[k])));
    });
    await this.d1.batch(statements);
  }

  async update(table: string, id: string, values: Row): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const { sql, params } = buildUpdate(table, id, values, this.orgId);
    await this.d1.prepare(sql).bind(...(params ?? [])).run();
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
    let sql = `UPDATE ${table} SET ${sets} WHERE id = ? AND row_version = ?`;
    if (ORG_SCOPED_TABLES.has(table)) {
      sql += " AND org_id = ?";
      params.push(this.orgId);
    }
    const res = await this.d1.prepare(sql).bind(...params).run();
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
    const { sql, params } = buildWhere(table, this.orgId, where, { includeDeleted: true });
    await this.d1.prepare(`DELETE FROM ${table}${sql}`).bind(...params).run();
  }

  async raw<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.d1.prepare(sql).bind(...params.map(encode)).all<T>();
    return res.results ?? [];
  }

  async rawRun(sql: string, params: unknown[] = []): Promise<void> {
    await this.d1.prepare(sql).bind(...params.map(encode)).run();
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
