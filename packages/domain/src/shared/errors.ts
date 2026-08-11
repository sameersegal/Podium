/**
 * Typed domain errors — 11-cross-cutting.md, "Validation and errors".
 *
 * Every error carries the invariant it enforces, so `entitlement_exhausted`
 * beats `400 Bad Request`.
 */

export interface DomainErrorBody {
  error: string;
  message: string;
  invariant?: string;
  details?: Record<string, unknown>;
  /** Field-level errors keyed by `field_key`, so a multi-step form can route each one. */
  field_errors?: FieldError[];
}

export interface FieldError {
  field_key: string;
  message: string;
  step_key?: string;
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly invariant?: string;
  readonly details?: Record<string, unknown>;
  readonly fieldErrors?: FieldError[];

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    invariant?: string;
    details?: Record<string, unknown>;
    fieldErrors?: FieldError[];
  }) {
    super(opts.message);
    this.name = "DomainError";
    this.code = opts.code;
    this.status = opts.status ?? 422;
    this.invariant = opts.invariant;
    this.details = opts.details;
    this.fieldErrors = opts.fieldErrors;
  }

  toJSON(): DomainErrorBody {
    const body: DomainErrorBody = { error: this.code, message: this.message };
    if (this.invariant) body.invariant = this.invariant;
    if (this.details) body.details = this.details;
    if (this.fieldErrors?.length) body.field_errors = this.fieldErrors;
    return body;
  }
}

export const invariantError = (
  invariant: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 422,
) => new DomainError({ code, message, invariant, details, status });

export const notFound = (what: string, id?: string) =>
  new DomainError({
    code: "not_found",
    message: id ? `${what} ${id} was not found.` : `${what} was not found.`,
    status: 404,
  });

export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new DomainError({ code: "forbidden", message, status: 403, details });

export const unauthorized = (message = "Authentication is required.") =>
  new DomainError({ code: "unauthorized", message, status: 401 });

export const validationError = (message: string, fieldErrors: FieldError[] = []) =>
  new DomainError({ code: "validation_failed", message, status: 422, fieldErrors });

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError({ code, message, status: 409, details });

/**
 * Compare-and-set failure — 11-cross-cutting.md, "Concurrency": a conflicting
 * write returns 409 with the current state, never a silent overwrite
 * (INV-11-14). The HTML surfaces render this as a warning and re-read the row
 * (`workers/api/src/http/concurrency.ts`); the version numbers below are for
 * the JSON API, which is where a caller can actually retry with them.
 */
export const versionConflict = (entity: string, expected: number, current: number, state?: unknown) =>
  new DomainError({
    code: "version_conflict",
    message: `${entity} has changed since you loaded it (expected version ${expected}, current ${current}).`,
    status: 409,
    invariant: "INV-11-14",
    details: { expected_version: expected, current_version: current, current_state: state },
  });

export const illegalTransition = (entity: string, from: string, to: string, invariant?: string) =>
  new DomainError({
    code: "illegal_transition",
    message: `${entity} cannot move from ${from} to ${to}.`,
    status: 422,
    invariant,
    details: { from, to },
  });

export const derivedFieldWrite = (field: string) =>
  invariantError("INV-11-6", "derived_field_not_writable", `${field} is derived and cannot be written.`, { field });
