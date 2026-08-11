/**
 * The AI first-pass evaluator contract — 05, "AI first-pass evaluation", R24.
 *
 * `AiEvaluator` configuration is an `Integration` with `capability = analytics`
 * ([`09`](../../../../docs/domain/09-api-and-integrations.md)); the core calls
 * the contract and stores the result. No vendor SDK is imported anywhere, here
 * or in the plugins package — this file is the seam.
 *
 * Shipped behind `Organization.settings.review.ai_evaluation_enabled`, default
 * off. The guardrails live in the service that calls this: INV-05-16 (labelled,
 * with a rationale and a model identifier) and INV-05-17 (never counts toward
 * quorum).
 */

import type { Confidence, CriterionView, Recommendation, ReviewFlag, RubricView } from "./types.js";

export interface AiEvaluationSubject {
  proposal_id: string;
  reference: string;
  title: string;
  abstract: string;
  description: string | null;
  keywords: string[];
  track_id: string | null;
  session_format_id: string | null;
}

export interface AiEvaluationRequest {
  rubric: RubricView;
  criteria: CriterionView[];
  proposal: AiEvaluationSubject;
  /** Free-form persona / instruction from `Integration.config`. Never a secret (INV-09-3). */
  persona?: string | null;
}

export interface AiCriterionScore {
  criterion_id: string;
  value_number?: number | null;
  value_option?: string | null;
  value_text?: string | null;
  value_bool?: boolean | null;
  note?: string | null;
}

export interface AiEvaluationResult {
  /** Recorded as `Review.ai_evaluator_key` — required by INV-05-16. */
  evaluator_key: string;
  /** Recorded as `Review.ai_model`, for reproducibility — required by INV-05-16. */
  model: string;
  /** Recorded as `Review.ai_rationale` — required by INV-05-16. */
  rationale: string;
  scores: AiCriterionScore[];
  recommendation: Recommendation | null;
  confidence: Confidence | null;
  flags: ReviewFlag[];
}

/** The narrow contract an `analytics` plugin satisfies. One method. */
export interface AiEvaluator {
  readonly key: string;
  readonly model: string;
  evaluate(request: AiEvaluationRequest): Promise<AiEvaluationResult>;
}

/* -------------------------------------------------------------------------- */
/* The shipped stub                                                            */
/* -------------------------------------------------------------------------- */

/** FNV-1a, so the stub is deterministic across runs and machines. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: string): T {
  return items[hash32(seed) % items.length];
}

const PITCH_MARKERS = [
  "our platform",
  "our product",
  "our solution",
  "book a demo",
  "customers love",
  "industry leading",
  "revolutionary",
  "game-changing",
];

const DEPTH_MARKERS = [
  "benchmark",
  "latency",
  "architecture",
  "trade-off",
  "tradeoff",
  "failure mode",
  "evaluation",
  "postmortem",
  "we measured",
  "open source",
];

/**
 * A deterministic local evaluator, so the whole AI flow is testable without a
 * provider. It is a keyword heuristic and says so in its rationale — the model
 * is explicit that "a rationale generic enough to apply to any proposal is a
 * defect in the evaluator", so this one names the evidence it actually found.
 */
export function localHeuristicEvaluator(
  opts: { key?: string; model?: string } = {},
): AiEvaluator {
  const key = opts.key ?? "analytics.local_heuristic";
  const model = opts.model ?? "podium-heuristic-v1";

  return {
    key,
    model,
    async evaluate(request: AiEvaluationRequest): Promise<AiEvaluationResult> {
      const text = [request.proposal.title, request.proposal.abstract, request.proposal.description ?? ""]
        .join("\n")
        .toLowerCase();
      const pitch = PITCH_MARKERS.filter((m) => text.includes(m));
      const depth = DEPTH_MARKERS.filter((m) => text.includes(m));
      const words = text.split(/\s+/).filter(Boolean).length;

      const seed = `${key}:${request.proposal.proposal_id}`;
      const scores: AiCriterionScore[] = [];

      for (const criterion of request.criteria) {
        const criterionSeed = `${seed}:${criterion.key}`;
        switch (criterion.type) {
          case "numeric": {
            const min = criterion.scale_min ?? 1;
            const max = criterion.scale_max ?? 5;
            const span = Math.max(1, max - min);
            // Centre on the midpoint, nudged by the evidence, jittered
            // deterministically so a rubric of five criteria is not five
            // identical numbers.
            const base = min + span / 2;
            const nudge = (depth.length - pitch.length) * (span / 8);
            const jitter = ((hash32(criterionSeed) % 100) / 100 - 0.5) * (span / 6);
            const value = Math.round(Math.min(max, Math.max(min, base + nudge + jitter)));
            scores.push({ criterion_id: criterion.id, value_number: value });
            break;
          }
          case "select": {
            const scored = criterion.options.filter((o) => o.score !== null && o.score !== undefined);
            const options = scored.length > 0 ? scored : criterion.options;
            if (options.length === 0) break;
            const sorted = [...options].sort((a, b) => Number(a.score ?? 0) - Number(b.score ?? 0));
            const chosen =
              pitch.length > depth.length
                ? sorted[0]
                : depth.length > pitch.length
                  ? sorted[sorted.length - 1]
                  : pick(sorted, criterionSeed);
            scores.push({ criterion_id: criterion.id, value_option: chosen.value });
            break;
          }
          case "boolean":
            scores.push({ criterion_id: criterion.id, value_bool: pitch.length === 0 });
            break;
          case "text":
            scores.push({
              criterion_id: criterion.id,
              value_text: depth.length
                ? `Concrete signals present: ${depth.join(", ")}.`
                : "No concrete technical signals found in the abstract.",
            });
            break;
        }
      }

      const evidence: string[] = [];
      evidence.push(`Abstract is ${words} words.`);
      if (depth.length) evidence.push(`Technical signals: ${depth.join(", ")}.`);
      else evidence.push("No technical signals (benchmarks, trade-offs, failure modes) found.");
      if (pitch.length) evidence.push(`Promotional language: ${pitch.join(", ")}.`);
      if (words < 60) evidence.push("The abstract is short enough that a human should read it before trusting any score here.");

      const flags: ReviewFlag[] = [];
      if (pitch.length >= 2) flags.push("product_pitch");

      const recommendation: Recommendation | null =
        request.rubric.overall_scale === "recommendation"
          ? pitch.length > depth.length
            ? "weak_reject"
            : depth.length >= 2
              ? "weak_accept"
              : "neutral"
          : null;

      return {
        evaluator_key: key,
        model,
        // INV-05-17 — the rationale is read by reviewers, so it states the rule's effect, not its name.
        rationale: `Keyword triage by ${model}, not a judgement. ${evidence.join(" ")} This is a first pass over the abstract only; it never counts toward quorum.`,
        scores,
        recommendation,
        // A heuristic is never more than low confidence, and saying so is the
        // point: the weighted mean must not let a machine outweigh a human.
        confidence: "low",
        flags,
      };
    },
  };
}
