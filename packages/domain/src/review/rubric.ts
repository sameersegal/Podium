/**
 * Rubric shape rules — INV-05-13, INV-05-5 and the sponsor compliance preset
 * from R17.
 */

import { invariantError, validationError, type FieldError } from "../shared/errors.js";
import type { CriterionOption, CriterionType, CriterionView, RubricView, ScoreView } from "./types.js";

/** A criterion as the builder submits it, before it has an id. */
export interface CriterionDraft {
  key: string;
  label: string;
  description?: string | null;
  type: CriterionType;
  scale_min?: number | null;
  scale_max?: number | null;
  options?: CriterionOption[];
  max_length?: number | null;
  weight?: number;
  is_required?: boolean;
  allows_na?: boolean;
  sort_order?: number;
}

/**
 * INV-05-13 (first half) — a `RubricCriterion` must carry the configuration its
 * `type` requires: `scale_min`/`scale_max` for `numeric`, at least two
 * `options` for `select`.
 */
export function validateCriterion(draft: CriterionDraft): void {
  if (draft.type === "numeric") {
    if (
      draft.scale_min === null ||
      draft.scale_min === undefined ||
      draft.scale_max === null ||
      draft.scale_max === undefined
    ) {
      throw invariantError(
        "INV-05-13",
        "criterion_missing_scale",
        `"${draft.label}" is a numeric criterion and needs both a minimum and a maximum.`,
        { key: draft.key },
      );
    }
    if (draft.scale_max <= draft.scale_min) {
      throw invariantError(
        "INV-05-13",
        "criterion_invalid_scale",
        `"${draft.label}" needs a maximum above its minimum.`,
        { key: draft.key, scale_min: draft.scale_min, scale_max: draft.scale_max },
      );
    }
  }
  if (draft.type === "select") {
    const options = draft.options ?? [];
    if (options.length < 2) {
      throw invariantError(
        "INV-05-13",
        "criterion_needs_options",
        `"${draft.label}" is a select criterion and needs at least two options.`,
        { key: draft.key, option_count: options.length },
      );
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (!option.value) {
        throw invariantError("INV-05-13", "criterion_option_invalid", `An option of "${draft.label}" has no value.`);
      }
      if (seen.has(option.value)) {
        throw invariantError(
          "INV-05-13",
          "criterion_option_duplicate",
          `"${draft.label}" repeats the option value "${option.value}".`,
        );
      }
      seen.add(option.value);
    }
  }
  if (draft.weight !== undefined && draft.weight !== null && draft.weight < 0) {
    throw validationError(`"${draft.label}" cannot have a negative weight.`, [
      { field_key: `criterion.${draft.key}.weight`, message: "Weight must be zero or more." },
    ]);
  }
}

/**
 * INV-05-13 (second half) — a `CriterionScore` may populate only the `value_*`
 * column matching its criterion's type. A number written into a select
 * criterion is a bug that would otherwise surface as a silently missing score.
 */
export function assertScoreMatchesType(criterion: CriterionView, score: ScoreView): void {
  const populated: string[] = [];
  if (score.value_number !== null && score.value_number !== undefined) populated.push("value_number");
  if (score.value_option !== null && score.value_option !== undefined && score.value_option !== "") {
    populated.push("value_option");
  }
  if (score.value_text !== null && score.value_text !== undefined && score.value_text !== "") {
    populated.push("value_text");
  }
  if (score.value_bool !== null && score.value_bool !== undefined) populated.push("value_bool");

  const expected: Record<CriterionType, string> = {
    numeric: "value_number",
    select: "value_option",
    text: "value_text",
    boolean: "value_bool",
  };
  const wrong = populated.filter((p) => p !== expected[criterion.type]);
  if (wrong.length > 0) {
    throw invariantError(
      "INV-05-13",
      "score_wrong_value_column",
      `"${criterion.label}" is a ${criterion.type} criterion; ${wrong.join(", ")} may not be set on it.`,
      { criterion_key: criterion.key, criterion_type: criterion.type, populated: wrong },
    );
  }

  if (criterion.type === "numeric" && score.value_number !== null && score.value_number !== undefined) {
    const min = criterion.scale_min ?? Number.NEGATIVE_INFINITY;
    const max = criterion.scale_max ?? Number.POSITIVE_INFINITY;
    if (score.value_number < min || score.value_number > max) {
      throw invariantError(
        "INV-05-13",
        "score_out_of_scale",
        `"${criterion.label}" accepts ${criterion.scale_min}–${criterion.scale_max}.`,
        { criterion_key: criterion.key, value: score.value_number },
      );
    }
  }
  if (criterion.type === "select" && score.value_option) {
    if (!criterion.options.some((o) => o.value === score.value_option)) {
      throw invariantError(
        "INV-05-13",
        "score_unknown_option",
        `"${score.value_option}" is not an option of "${criterion.label}".`,
        { criterion_key: criterion.key, value: score.value_option },
      );
    }
  }
  if (criterion.type === "text" && criterion.max_length && score.value_text) {
    if (score.value_text.length > criterion.max_length) {
      throw validationError(`"${criterion.label}" is limited to ${criterion.max_length} characters.`, [
        { field_key: `criterion.${criterion.key}`, message: `At most ${criterion.max_length} characters.` },
      ]);
    }
  }
}

function isAnswered(criterion: CriterionView, score: ScoreView | undefined): boolean {
  if (!score) return false;
  switch (criterion.type) {
    case "numeric":
      return score.value_number !== null && score.value_number !== undefined;
    case "select":
      return !!score.value_option;
    case "text":
      return !!score.value_text && score.value_text.trim().length > 0;
    case "boolean":
      return score.value_bool !== null && score.value_bool !== undefined;
  }
}

export interface ReviewSubmissionDraft {
  scores: ScoreView[];
  recommendation?: string | null;
  comments_for_committee?: string | null;
  comments_for_speaker?: string | null;
  /** Set when the reviewer ticked "can't judge this" for a criterion. */
  na_criterion_ids?: string[];
}

/**
 * INV-05-5 — every required criterion has a `CriterionScore` before a review may
 * be submitted; `null` only where `allows_na`.
 *
 * Also enforces the two rubric-level requirements: `requires_comment`, and a
 * `recommendation` when `overall_scale = recommendation`.
 */
export function validateReviewForSubmit(
  rubric: RubricView,
  criteria: CriterionView[],
  draft: ReviewSubmissionDraft,
): void {
  const byCriterion = new Map(draft.scores.map((s) => [s.criterion_id, s]));
  const na = new Set(draft.na_criterion_ids ?? []);
  const errors: FieldError[] = [];

  for (const criterion of criteria) {
    const score = byCriterion.get(criterion.id);
    if (score) assertScoreMatchesType(criterion, score);
    if (!criterion.is_required) continue;
    if (isAnswered(criterion, score)) continue;
    if (na.has(criterion.id)) {
      if (!criterion.allows_na) {
        errors.push({
          field_key: `criterion.${criterion.key}`,
          message: `"${criterion.label}" cannot be marked not applicable.`,
        });
      }
      continue;
    }
    errors.push({ field_key: `criterion.${criterion.key}`, message: `"${criterion.label}" needs a score.` });
  }

  if (errors.length > 0) {
    throw invariantError(
      "INV-05-5",
      "review_incomplete",
      "Every required criterion needs a score before this review can be submitted.",
      { field_errors: errors },
    );
  }

  if (rubric.overall_scale === "recommendation" && !draft.recommendation) {
    throw invariantError(
      "INV-05-5",
      "recommendation_required",
      "This rubric asks for an overall recommendation.",
    );
  }

  if (rubric.requires_comment) {
    const written = [draft.comments_for_committee, draft.comments_for_speaker].some(
      (c) => !!c && c.trim().length > 0,
    );
    const textCriterionWritten = criteria.some(
      (c) => c.type === "text" && isAnswered(c, byCriterion.get(c.id)),
    );
    if (!written && !textCriterionWritten) {
      throw invariantError(
        "INV-05-5",
        "comment_required",
        "This rubric requires at least one written comment.",
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The sponsor compliance rubric (R17)                                         */
/* -------------------------------------------------------------------------- */

/**
 * R17 — "Sponsor sessions get a one-criterion compliance rubric, run by one
 * organizer." One criterion is the whole design: scaling it up to a real
 * scorecard would imply the session is competing for a slot it already owns.
 */
export const SPONSOR_COMPLIANCE_RUBRIC: {
  name: string;
  description: string;
  overall_scale: RubricView["overall_scale"];
  requires_comment: boolean;
  criteria: CriterionDraft[];
} = {
  name: "Sponsor session compliance",
  description:
    "One question, asked of every sponsor session: is this a technical talk or a product pitch? " +
    "The sponsor already owns the slot — this is a compliance check, not selection.",
  overall_scale: "none",
  requires_comment: true,
  criteria: [
    {
      key: "technical-vs-pitch",
      label: "Technical talk or product pitch?",
      description:
        "Judge the abstract as an attendee would hear it. The anchors below are the whole rubric; " +
        "a recorded judgement against a written anchor is a very different conversation from an opinion.",
      type: "select",
      options: [
        {
          value: "technical",
          label: "Technical talk",
          description:
            "Teaches something an attendee could apply without buying anything. The product may appear; it is not the subject.",
          score: 3,
        },
        {
          value: "mixed",
          label: "Mixed — needs rework",
          description:
            "Real content wrapped in a pitch, or a case study that only works if you already use the product. Ask for a rework.",
          score: 2,
        },
        {
          value: "pitch",
          label: "Product pitch",
          description:
            "A demo, a feature tour, or a customer-logo parade. Not acceptable as a session; ask for a replacement talk.",
          score: 1,
        },
      ],
      weight: 1,
      is_required: true,
      allows_na: false,
      sort_order: 0,
    },
  ],
};
