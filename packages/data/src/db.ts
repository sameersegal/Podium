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
]);

export function isOrgScoped(table: string): boolean {
  return ORG_SCOPED_TABLES.has(table);
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
  /** A view of this Db bound to a different org, for the platform surfaces. */
  readonly orgId: string;
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
    const row: Row = { ...values };
    if (ORG_SCOPED_TABLES.has(table) && row.org_id === undefined) row.org_id = this.orgId;
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
    await this.d1
      .prepare(sql)
      .bind(...keys.map((k) => encode(row[k])))
      .run();
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
    const keys = Object.keys(values);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(",");
    const params = keys.map((k) => encode(values[k]));
    let sql = `UPDATE ${table} SET ${sets} WHERE id = ?`;
    params.push(id);
    if (ORG_SCOPED_TABLES.has(table)) {
      sql += " AND org_id = ?";
      params.push(this.orgId);
    }
    await this.d1.prepare(sql).bind(...params).run();
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

  /** Batch of prepared statements, for the "one transaction per proposal" flows. */
  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
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
