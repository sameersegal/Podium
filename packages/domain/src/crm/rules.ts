/**
 * 14 — Speaker CRM: the pure rules.
 *
 * Total functions over plain data. The aggregate roots (`ContactSegment`,
 * `SourcingPipeline`) call into this from
 * `workers/api/src/contexts/crm/service.ts`, which is where the invariants are
 * enforced against persisted state.
 */

import { diffDays } from "../shared/time.js";
import { canMoveCard, type SegmentKind, type StageKind, type StageSpec } from "./types.js";

/* -------------------------------------------------------------------------- */
/* ContactSegment                                                              */
/* -------------------------------------------------------------------------- */

export interface SegmentShape {
  criteria?: Record<string, unknown> | null;
  member_person_ids?: string[] | null;
}

/**
 * INV-14-1 — a `ContactSegment` is `dynamic` (criteria, resolved at read) or
 * `static` (a frozen member list) and never both.
 *
 * "Choosing the wrong one is a real failure in both directions, which is why
 * the choice is explicit at creation rather than inferred."
 */
export function segmentShapeProblems(kind: SegmentKind, shape: SegmentShape): string[] {
  const hasCriteria = !!shape.criteria && Object.keys(shape.criteria).length > 0;
  const hasMembers = !!shape.member_person_ids && shape.member_person_ids.length > 0;
  const problems: string[] = [];
  if (kind === "dynamic") {
    if (hasMembers) problems.push("A dynamic segment resolves its members from criteria and may not carry a frozen member list.");
    if (!hasCriteria) problems.push("A dynamic segment needs at least one filter — otherwise it is every contact, which is the directory.");
  } else {
    if (hasCriteria) problems.push("A static segment is a decision somebody made and may not carry criteria.");
  }
  return problems;
}

/**
 * The shape a segment must be stored with. Nulling the other half is what
 * makes INV-14-1 true of the row, not just of the request.
 */
export function segmentColumnsFor(kind: SegmentKind, shape: SegmentShape): {
  criteria: Record<string, unknown> | null;
  member_person_ids: string[] | null;
} {
  return kind === "dynamic"
    ? { criteria: shape.criteria ?? {}, member_person_ids: null }
    : { criteria: null, member_person_ids: [...new Set(shape.member_person_ids ?? [])] };
}

export function otherKind(kind: SegmentKind): SegmentKind {
  return kind === "dynamic" ? "static" : "dynamic";
}

/* -------------------------------------------------------------------------- */
/* PipelineStage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * INV-14-2 — every `PipelineStage` declares a `kind`; a pipeline must have at
 * least one `open`, one `won` and one `lost` stage. Terminal semantics come
 * from `kind`, never from the stage's name.
 */
export function stageSetProblems(stages: StageSpec[]): string[] {
  const problems: string[] = [];
  if (stages.length === 0) return ["A pipeline needs stages."];
  for (const s of stages) {
    if (!s.name?.trim()) problems.push("Every stage needs a name.");
    if (!s.kind) problems.push(`Stage "${s.name}" must declare whether it is open, won or lost.`);
  }
  for (const kind of ["open", "won", "lost"] as StageKind[]) {
    if (!stages.some((s) => s.kind === kind)) {
      problems.push(`A pipeline needs at least one ${kind} stage — "did we land them" must not depend on a column header.`);
    }
  }
  return problems;
}

export function firstOpenStage(stages: StageSpec[]): StageSpec | null {
  return [...stages].sort((a, b) => a.sort_order - b.sort_order).find((s) => s.kind === "open") ?? null;
}

/* -------------------------------------------------------------------------- */
/* ProspectCard                                                                */
/* -------------------------------------------------------------------------- */

export interface TransitionRecord {
  to_stage_id: string;
  created_at: string;
}

/**
 * INV-14-4 — `entered_stage_at` equals the latest transition's `created_at`.
 * The set of transitions is the card's history and is never mutated or
 * deleted, so this is always recomputable from it.
 */
export function enteredStageAt(transitions: TransitionRecord[], fallback: string): string {
  let latest: string | null = null;
  for (const t of transitions) {
    if (latest === null || t.created_at > latest) latest = t.created_at;
  }
  return latest ?? fallback;
}

export function daysInStage(enteredAt: string, now: string): number {
  return Math.max(0, diffDays(now, enteredAt));
}

export interface StallCheck {
  stage_kind: StageKind;
  entered_stage_at: string;
  next_action_at?: string | null;
}

/**
 * `stalled_cards` (14, "CRM dashboard") — open cards past `next_action_at`, or
 * in stage beyond a threshold. Won and lost cards are not stalled; they are
 * finished.
 */
export function isStalled(card: StallCheck, now: string, thresholdDays = 30): boolean {
  if (card.stage_kind !== "open") return false;
  if (card.next_action_at && card.next_action_at <= now) return true;
  return daysInStage(card.entered_stage_at, now) >= thresholdDays;
}

/** Re-exported so a caller needs one import from this context's rules. */
export { canMoveCard };

/** A score is an organizer's own prioritisation, 0–100 (14, `ProspectCard`). */
export function normaliseScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
