/**
 * `ScheduleConflict` — the materialised read model behind INV-08-14.
 *
 * "Conflicts are recomputed on every placement write and surfaced without a
 * page reload. A clash that only appears after a refresh is a clash the
 * organizer created, navigated away from, and will now discover the week of the
 * event."
 *
 * The row id is derived from `(event_id, code, sorted placement ids)`, so an
 * acknowledgement written before a recomputation is still attached after it.
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { detectConflicts, type ConflictFinding } from "@podiumconf/domain/scheduling/conflicts.js";
import { invariantError, notFound } from "@podiumconf/domain/shared/errors.js";
import type { ConflictCode, ConflictSeverity } from "@podiumconf/domain/scheduling/types.js";
import { loadScheduleFacts, type ScheduleFacts } from "./facts.js";

export interface ConflictView {
  id: string;
  code: ConflictCode;
  severity: ConflictSeverity;
  placement_ids: string[];
  session_ids: string[];
  detail: Record<string, unknown>;
  message: string;
  acknowledged_by_person_id: string | null;
  acknowledged_reason: string | null;
}

function toView(row: Row): ConflictView {
  const detail = parseJson<Record<string, unknown>>(row.detail, {});
  return {
    id: str(row.id),
    code: str(row.code) as ConflictCode,
    severity: str(row.severity) as ConflictSeverity,
    placement_ids: parseJson<string[]>(row.placement_ids, []),
    session_ids: parseJson<string[]>(detail.session_ids, []),
    detail,
    message: str(detail.message),
    acknowledged_by_person_id: strOrNull(row.acknowledged_by_person_id),
    acknowledged_reason: strOrNull(row.acknowledged_reason),
  };
}

/**
 * Recompute every conflict for the event and persist the result. Returns the
 * findings so the write that triggered it can put them in its own response
 * (INV-08-14) — the caller never has to read them back.
 */
export async function recomputeConflicts(
  app: AppContext,
  eventId: string,
  preloaded?: ScheduleFacts,
): Promise<ConflictView[]> {
  const facts = preloaded ?? (await loadScheduleFacts(app, eventId));
  const findings = detectConflicts(facts);
  return persistConflicts(app, eventId, findings);
}

export async function persistConflicts(
  app: AppContext,
  eventId: string,
  findings: ConflictFinding[],
): Promise<ConflictView[]> {
  const existing = await app.db.select<Row>("schedule_conflict", { event_id: eventId });
  const existingById = new Map(existing.map((r) => [str(r.id), r]));
  const now = app.now();
  const views: ConflictView[] = [];

  for (const f of findings) {
    const prior = existingById.get(f.id);
    const detail = { ...f.detail, message: f.message, session_ids: f.session_ids };
    if (prior) {
      await app.db.update("schedule_conflict", f.id, {
        severity: f.severity,
        placement_ids: JSON.stringify(f.placement_ids),
        detail: JSON.stringify(detail),
        computed_at: now,
      });
      views.push({
        ...f,
        detail,
        acknowledged_by_person_id: strOrNull(prior.acknowledged_by_person_id),
        acknowledged_reason: strOrNull(prior.acknowledged_reason),
      });
      existingById.delete(f.id);
      continue;
    }

    await app.db.insert("schedule_conflict", {
      id: f.id,
      event_id: eventId,
      code: f.code,
      severity: f.severity,
      placement_ids: JSON.stringify(f.placement_ids),
      detail: JSON.stringify(detail),
      computed_at: now,
    });
    app.events.emit({
      type: "schedule.conflict_detected",
      subject: { type: "event", id: eventId },
      event_id: eventId,
      data: { code: f.code, severity: f.severity, placement_ids: f.placement_ids, detail },
    });
    views.push({ ...f, detail, acknowledged_by_person_id: null, acknowledged_reason: null });
  }

  // Anything not re-detected is resolved: the rows go, so the surface never
  // shows a conflict that no longer exists.
  for (const stale of existingById.keys()) {
    await app.db.hardDelete("schedule_conflict", { id: stale, event_id: eventId });
  }

  return views.sort((a, b) => (a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === "error" ? -1 : 1));
}

export async function listConflicts(app: AppContext, eventId: string): Promise<ConflictView[]> {
  const rows = await app.db.select<Row>("schedule_conflict", { event_id: eventId }, { orderBy: "severity, code" });
  return rows.map(toView).sort((a, b) => (a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === "error" ? -1 : 1));
}

/**
 * An accepted, deliberate conflict. INV-11-5: an override carries a reason, so
 * "we know, the keynote is meant to clash with lunch" is on the record rather
 * than in somebody's head.
 */
export async function acknowledgeConflict(app: AppContext, conflictId: string, reason: string): Promise<ConflictView> {
  const row = await app.db.byId<Row>("schedule_conflict", conflictId);
  if (!row) throw notFound("Conflict", conflictId);
  if (!reason.trim()) {
    throw invariantError("INV-11-5", "reason_required", "Say why this conflict is acceptable — an override needs a reason.");
  }
  await app.db.update("schedule_conflict", conflictId, {
    acknowledged_by_person_id: app.actor.id ?? "system",
    acknowledged_reason: reason.trim(),
  });
  app.audit.record({
    action: "schedule.conflict_acknowledge",
    entity_type: "schedule_conflict",
    entity_id: conflictId,
    after: { code: str(row.code), severity: str(row.severity) },
    reason: reason.trim(),
  });
  return toView({ ...row, acknowledged_by_person_id: app.actor.id ?? "system", acknowledged_reason: reason.trim() });
}

/** Conflict ids that a publication may proceed past without an override. */
export function acknowledgedIds(conflicts: ConflictView[]): Set<string> {
  return new Set(conflicts.filter((c) => c.acknowledged_reason).map((c) => c.id));
}

/** INV-08-4: error-severity codes per session, for the publication gate. */
export function errorCodesBySession(conflicts: ConflictView[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of conflicts) {
    if (c.severity !== "error") continue;
    if (c.acknowledged_reason) continue;
    for (const sid of c.session_ids) out.set(sid, [...(out.get(sid) ?? []), c.code]);
  }
  return out;
}
