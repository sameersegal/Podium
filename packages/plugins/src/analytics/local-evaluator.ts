/**
 * `analytics.local_evaluator` — the AI evaluator seam, offline.
 *
 * R24 ships AI first-pass review behind an org setting, default off, with the
 * guardrails in the model: never counts toward quorum, always labelled, always
 * overridable. Those guardrails belong to the review context; what belongs here
 * is a deterministic, rubric-shaped implementation of the seam, so the whole
 * path is testable without a model provider and without a network call.
 *
 * It is deliberately, visibly not intelligent: it scores structural signals
 * (length, specificity markers, whether the abstract says what the audience
 * will leave with) and says so in its summary. Anyone reading its output should
 * be able to tell instantly that no model was involved.
 */

import type { AnalyticsPlugin, EvaluationRequest, EvaluationResult, PluginContext } from "../contracts.js";

const MARKERS = ["we built", "benchmark", "in production", "latency", "cost", "failure", "lesson", "case study", "evaluation"];
const PITCH_MARKERS = ["our platform", "our product", "sign up", "book a demo", "industry-leading", "revolutionary"];

function scoreText(title: string, abstract: string): { specificity: number; concreteness: number; pitchiness: number } {
  const text = `${title}\n${abstract}`.toLowerCase();
  const words = abstract.trim().split(/\s+/).filter(Boolean).length;
  const markers = MARKERS.filter((m) => text.includes(m)).length;
  const pitch = PITCH_MARKERS.filter((m) => text.includes(m)).length;
  const numbers = (abstract.match(/\b\d+(\.\d+)?(%|x|ms|s|k|m)?\b/gi) ?? []).length;
  return {
    // Length alone is a weak signal, so it saturates fast.
    specificity: clamp01(Math.min(words, 220) / 220),
    concreteness: clamp01((markers * 0.15 + Math.min(numbers, 6) * 0.08) as number),
    pitchiness: clamp01(pitch * 0.34),
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export const analyticsLocalEvaluatorPlugin: AnalyticsPlugin = {
  key: "analytics.local_evaluator",
  capability: "analytics",
  display_name: "First-pass triage (local, no model)",
  requires_secret: false,
  config_fields: [],

  async evaluate(req: EvaluationRequest, _ctx: PluginContext): Promise<EvaluationResult> {
    const signals = scoreText(req.title, req.abstract);
    const base = clamp01(0.35 + signals.specificity * 0.3 + signals.concreteness * 0.45 - signals.pitchiness * 0.4);

    const criterion_scores = req.criteria.map((c) => {
      if (c.kind === "boolean") return { key: c.key, value: signals.pitchiness < 0.34, comment: null };
      if (c.kind === "text") {
        return {
          key: c.key,
          value: null,
          comment: "No model was consulted; this is a structural pass only.",
        };
      }
      if (c.kind === "select") {
        return { key: c.key, value: base > 0.66 ? "strong" : base > 0.4 ? "adequate" : "weak", comment: null };
      }
      const min = c.min ?? 1;
      const max = c.max ?? 5;
      return { key: c.key, value: Math.round(min + base * (max - min)), comment: null };
    });

    const numeric = criterion_scores.map((s) => s.value).filter((v): v is number => typeof v === "number");
    const overall = numeric.length ? Number((numeric.reduce((a, b) => a + b, 0) / numeric.length).toFixed(2)) : null;

    return {
      ai_evaluator_key: "analytics.local_evaluator",
      ai_model: "local-structural-v1",
      overall_score: overall,
      criterion_scores,
      summary: [
        "Structural triage only — no language model was called, and this score reflects nothing about the idea.",
        `Abstract length scores ${pct(signals.specificity)}; concrete detail (numbers, production references) ${pct(signals.concreteness)}.`,
        signals.pitchiness > 0
          ? "Contains marketing phrasing, which the compliance criterion flags."
          : "No obvious marketing phrasing.",
      ].join(" "),
      confidence: 0.2,
    };
  },

  async health() {
    return { ok: true };
  },
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
