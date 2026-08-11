/**
 * 14 — Speaker CRM. Enums and entity shapes.
 *
 * This context is deliberately **not** event-scoped (INV-14-7): it reads and
 * writes org-scoped data only, and grants no access to any event's proposals,
 * reviews or decisions.
 *
 * Enum members are written out here because the model writes them out; adding
 * one is additive, removing or renaming one is breaking (docs/domain/README.md).
 */

export const SEGMENT_KIND = ["dynamic", "static"] as const;
export type SegmentKind = (typeof SEGMENT_KIND)[number];

export const SEGMENT_VISIBILITY = ["private", "shared"] as const;
export type SegmentVisibility = (typeof SEGMENT_VISIBILITY)[number];

export const PIPELINE_STATUS = ["active", "archived"] as const;
export type PipelineStatus = (typeof PIPELINE_STATUS)[number];

export const STAGE_KIND = ["open", "won", "lost"] as const;
export type StageKind = (typeof STAGE_KIND)[number];

/**
 * The `SourcingPipeline` state diagram (14). Archiving hides the board and
 * stops its follow-up nudges; it deletes nothing, because next year's pipeline
 * starts by reading last year's.
 */
export const PIPELINE_TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
  active: ["archived"],
  archived: ["active"],
};

export function canTransitionPipeline(from: PipelineStatus, to: PipelineStatus): boolean {
  return PIPELINE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The `ProspectCard` stage diagram (14), expressed over `PipelineStage.kind`
 * because terminal semantics come from `kind`, never from the stage's name
 * (INV-14-2).
 *
 * A transition that is not drawn does not exist: `won → lost` is not drawn, so
 * a card that was landed and then fell through is reopened first and then lost,
 * and both moves are in its history.
 */
export const CARD_KIND_TRANSITIONS: Record<StageKind, StageKind[]> = {
  open: ["open", "won", "lost"],
  won: ["open"],
  lost: ["open"],
};

export function canMoveCard(from: StageKind, to: StageKind): boolean {
  return CARD_KIND_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface StageSpec {
  id?: string;
  name: string;
  kind: StageKind;
  sort_order: number;
  wip_limit?: number | null;
}

/**
 * "A default set ships, because an empty board is where this feature dies."
 * (14, `PipelineStage`.)
 */
export const DEFAULT_PIPELINE_STAGES: StageSpec[] = [
  { name: "Researching", kind: "open", sort_order: 0 },
  { name: "Identified", kind: "open", sort_order: 1 },
  { name: "Contacted", kind: "open", sort_order: 2 },
  { name: "Interested", kind: "open", sort_order: 3 },
  { name: "Confirmed", kind: "won", sort_order: 4 },
  { name: "Declined", kind: "lost", sort_order: 5 },
];

/**
 * `ContactSegment.criteria` — the saved filter, and the same shape the
 * directory's own query string uses. Filters compose with AND (14, "The
 * directory").
 */
export interface DirectoryCriteria {
  /** Free text across name, email, company and bio. */
  q?: string | null;
  company?: string | null;
  job_title?: string | null;
  tag?: string | null;
  custom_field_key?: string | null;
  custom_field_value?: string | null;
  event_id?: string | null;
  participant_status?: string | null;
  /** `yes` — has spoken; `no` — has never spoken. */
  spoken?: "yes" | "no" | null;
  /** Nobody has sent them anything on or after this instant. */
  last_contacted_before?: string | null;
}

export const DIRECTORY_CRITERIA_KEYS: readonly (keyof DirectoryCriteria)[] = [
  "q",
  "company",
  "job_title",
  "tag",
  "custom_field_key",
  "custom_field_value",
  "event_id",
  "participant_status",
  "spoken",
  "last_contacted_before",
];

/** Keep only the criteria keys the model knows about, dropping empties. */
export function normaliseCriteria(raw: Record<string, unknown> | null | undefined): DirectoryCriteria {
  const out: Record<string, unknown> = {};
  for (const key of DIRECTORY_CRITERIA_KEYS) {
    const value = raw?.[key];
    if (value === undefined || value === null) continue;
    const s = String(value).trim();
    if (s === "") continue;
    out[key] = s;
  }
  return out as DirectoryCriteria;
}

export function criteriaIsEmpty(c: DirectoryCriteria): boolean {
  return Object.keys(normaliseCriteria(c as Record<string, unknown>)).length === 0;
}

/** A human sentence for a saved filter, so a segment's name is not the only clue. */
export function describeCriteria(c: DirectoryCriteria): string {
  const parts: string[] = [];
  if (c.q) parts.push(`matching “${c.q}”`);
  if (c.company) parts.push(`at ${c.company}`);
  if (c.job_title) parts.push(`whose title mentions “${c.job_title}”`);
  if (c.tag) parts.push(`tagged ${c.tag}`);
  if (c.custom_field_key) parts.push(`with ${c.custom_field_key}${c.custom_field_value ? ` = ${c.custom_field_value}` : " set"}`);
  if (c.event_id) parts.push(`on the roster of ${c.event_id}${c.participant_status ? ` as ${c.participant_status}` : ""}`);
  else if (c.participant_status) parts.push(`with a roster row that is ${c.participant_status}`);
  if (c.spoken === "yes") parts.push("who have spoken");
  if (c.spoken === "no") parts.push("who have never spoken");
  if (c.last_contacted_before) parts.push(`not contacted since ${c.last_contacted_before.slice(0, 10)}`);
  return parts.length ? `Everyone ${parts.join(", ")}` : "Everyone in the directory";
}
