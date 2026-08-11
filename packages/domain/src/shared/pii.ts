/**
 * PII classification and redaction — 11-cross-cutting.md, "PII".
 *
 * Redaction is default-on: every response and payload without `pii:read`
 * (or `include_pii`) drops these fields (INV-09-5, INV-11-4).
 */

/** The table from 11-cross-cutting.md, as `Entity.field` keys. */
export const PII_FIELDS: Record<string, readonly string[]> = {
  Person: ["email"],
  AuthIdentity: ["email_at_provider"],
  SpeakerProfile: ["phone", "dietary_notes", "accessibility_notes"],
  Invitation: ["email"],
  NotificationDelivery: ["recipient_email", "rendered_body"],
  CampaignRecipient: ["resolved_email"],
  SessionSpeaker: ["travel_status"],
  AuditLog: ["ip", "user_agent"],
  TaskSubmission: ["payload"], // when the definition's category is travel or legal
  ProposalAnswer: ["value"], // when the FormField is flagged pii
  Person_custom: ["custom_field_values"], // per CustomFieldDefinition.pii
};

/**
 * Fields that are **never public**, whatever `SpeakerProfile.visibility` says
 * (INV-01-4).
 */
export const NEVER_PUBLIC_PROFILE_FIELDS = ["phone", "dietary_notes", "accessibility_notes"] as const;

export const REDACTED = "[redacted]";

export interface RedactionContext {
  /** The caller holds `pii:read`, or the webhook has `include_pii`. */
  includePii: boolean;
}

/**
 * Redact a plain record. Absent PII is not an error; present PII becomes
 * `[redacted]` rather than being deleted, so consumers see the shape.
 */
export function redactRecord<T extends Record<string, unknown>>(
  entity: string,
  row: T,
  ctx: RedactionContext,
  extraPiiFields: readonly string[] = [],
): T {
  if (ctx.includePii) return row;
  const fields = [...(PII_FIELDS[entity] ?? []), ...extraPiiFields];
  if (fields.length === 0) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (f in out && out[f] !== null && out[f] !== undefined) out[f] = REDACTED;
  }
  return out as T;
}

export function redactList<T extends Record<string, unknown>>(
  entity: string,
  rows: T[],
  ctx: RedactionContext,
  extraPiiFields: readonly string[] = [],
): T[] {
  return rows.map((r) => redactRecord(entity, r, ctx, extraPiiFields));
}

/**
 * Strip the never-public profile fields regardless of scope. Used when
 * assembling publication snapshots (INV-08-8).
 */
export function stripNeverPublic<T extends Record<string, unknown>>(profile: T): T {
  const out: Record<string, unknown> = { ...profile };
  for (const f of NEVER_PUBLIC_PROFILE_FIELDS) delete out[f];
  return out as T;
}

/**
 * Application logs carry ids, not values (11-cross-cutting.md, "Never logged").
 */
export function safeLogValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.includes("@")) return REDACTED;
  return value;
}
