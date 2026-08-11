import { describe, expect, it } from "vitest";
import { applyResultFilters, type ResultRow, type ScopedProposal } from "@podiumconf/web/contexts/review/scoring.js";
import { resultsCsvRow, toCsv } from "@podiumconf/web/contexts/review/views.js";
import { reviewerAssignmentView } from "@podiumconf/web/contexts/review/reviewer-views.js";
import { reviewableProjection, type ReviewableProposal } from "@podiumconf/domain/review/anonymity.js";
import type { CriterionView } from "@podiumconf/domain/review/types.js";
import type { ProposalScore } from "@podiumconf/domain/review/scoring.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function proposal(overrides: Partial<ScopedProposal> = {}): ScopedProposal {
  return {
    id: "prp_1",
    reference: "EVT-0001",
    title: "A Talk",
    track_id: null,
    session_format_id: null,
    cfp_id: "cfp_1",
    status: "submitted",
    sponsor_id: null,
    submitter_person_id: "per_1",
    origin: "cfp",
    ...overrides,
  };
}

function score(overrides: Partial<ProposalScore> = {}): ProposalScore {
  return {
    proposal_id: "prp_1",
    round_id: "rnd_1",
    review_count: 2,
    submitted_count: 2,
    stale_count: 0,
    human_review_count: 2,
    ai_review_count: 0,
    mean: 3,
    median: 3,
    stddev: 0,
    weighted_mean: 3,
    per_criterion_mean: { depth: 3 },
    per_criterion_histogram: {},
    recommendation_histogram: {},
    disagreement: 0,
    has_quorum: true,
    flag_counts: {},
    target_reviews_per_proposal: 2,
    ...overrides,
  };
}

function row(overrides: { proposal?: Partial<ScopedProposal>; score?: Partial<ProposalScore>; decision?: ResultRow["decision"] } = {}): ResultRow {
  return {
    proposal: proposal(overrides.proposal),
    score: score(overrides.score),
    reviews: [],
    decision: overrides.decision ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Results-table sorting                                                      */
/* -------------------------------------------------------------------------- */

describe("the results table sorts on every column (05, 'The results table')", () => {
  const rows: ResultRow[] = [
    row({ proposal: { id: "prp_a", reference: "EVT-0003", title: "Zeta talk" }, score: { mean: 4.5, human_review_count: 3, has_quorum: true, disagreement: 0.6 } }),
    row({ proposal: { id: "prp_b", reference: "EVT-0001", title: "Alpha talk" }, score: { mean: 2.1, human_review_count: 1, has_quorum: false, disagreement: 0.1 } }),
    row({ proposal: { id: "prp_c", reference: "EVT-0002", title: "Middle talk" }, score: { mean: 3.3, human_review_count: 2, has_quorum: true, disagreement: 0.3 } }),
  ];

  it("defaults to proposal reference, ascending", () => {
    const sorted = applyResultFilters(rows, {});
    expect(sorted.map((r) => r.proposal.reference)).toEqual(["EVT-0001", "EVT-0002", "EVT-0003"]);
  });

  it("sorts on mean, ascending and descending", () => {
    const asc = applyResultFilters(rows, { sort: "mean", direction: "asc" });
    expect(asc.map((r) => r.proposal.reference)).toEqual(["EVT-0001", "EVT-0002", "EVT-0003"]);
    const desc = applyResultFilters(rows, { sort: "mean", direction: "desc" });
    expect(desc.map((r) => r.proposal.reference)).toEqual(["EVT-0003", "EVT-0002", "EVT-0001"]);
  });

  it("sorts on disagreement — the chair's triage signal", () => {
    const desc = applyResultFilters(rows, { sort: "disagreement", direction: "desc" });
    expect(desc[0].proposal.reference).toBe("EVT-0003");
  });

  it("sorts on review_count and on quorum", () => {
    const byCount = applyResultFilters(rows, { sort: "review_count", direction: "desc" });
    expect(byCount.map((r) => r.score.human_review_count)).toEqual([3, 2, 1]);
    const byQuorum = applyResultFilters(rows, { sort: "quorum", direction: "desc" });
    expect(byQuorum[byQuorum.length - 1].score.has_quorum).toBe(false);
  });

  it("filters by quorum without losing the sort", () => {
    const filtered = applyResultFilters(rows, { quorum: "no" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].proposal.reference).toBe("EVT-0001");
  });
});

/* -------------------------------------------------------------------------- */
/* CSV row shape                                                              */
/* -------------------------------------------------------------------------- */

describe("the review_results export row shape (05, 'Aggregation')", () => {
  const criteria: CriterionView[] = [
    {
      id: "crt_depth",
      rubric_id: "rub_1",
      key: "depth",
      label: "Technical depth",
      description: null,
      type: "numeric",
      scale_min: 1,
      scale_max: 5,
      options: [],
      max_length: null,
      weight: 1,
      is_required: true,
      allows_na: false,
      sort_order: 0,
    },
  ];

  it("carries the aggregate, per-criterion means, quorum and decision state — one row per proposal", () => {
    const r = row({ decision: { id: "dec_1", outcome: "accept", status: "provisional" } as ResultRow["decision"] });
    const csvRow = resultsCsvRow(r, criteria, true);
    expect(csvRow).toMatchObject({
      reference: "EVT-0001",
      title: "A Talk",
      mean: 3,
      human_review_count: 2,
      ai_review_count: 0,
      has_quorum: "yes",
      decision_outcome: "accept",
      decision_status: "provisional",
      "criterion:depth": 3,
    });
  });

  it("omits the title when the requester lacks pii:read — an export is a read (INV-11-12)", () => {
    const csvRow = resultsCsvRow(row(), criteria, false);
    expect(csvRow.title).toBe("");
    expect(csvRow.reference).toBe("EVT-0001"); // the reference is an identifier, not personal data
  });

  it("AI reviews are counted and reported separately, never pooled into the human count", () => {
    const csvRow = resultsCsvRow(row({ score: { human_review_count: 2, ai_review_count: 3 } }), criteria, true);
    expect(csvRow.human_review_count).toBe(2);
    expect(csvRow.ai_review_count).toBe(3);
  });

  it("serialises to CSV with the header row and quotes fields containing commas", () => {
    const csv = toCsv([{ reference: "EVT-0001", title: "Talks, and more talks" }]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("reference,title");
    expect(lines[1]).toBe('EVT-0001,"Talks, and more talks"');
  });

  it("returns an empty string for no rows rather than a bare header", () => {
    expect(toCsv([])).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* Anonymity — stripping speaker identity from a reviewer's view              */
/* -------------------------------------------------------------------------- */

function reviewableFixture(): ReviewableProposal {
  return {
    id: "prp_1",
    reference: "EVT-0001",
    title: "Serving Models on a Budget",
    abstract: "How we cut inference cost in half.",
    description: null,
    session_format_id: null,
    track_id: null,
    requested_duration_minutes: 30,
    audience_level: "intermediate",
    keywords: ["ml"],
    language: "en",
    coi_disclosure: null,
    sponsor_id: null,
    sponsor_name: null,
    answers: [],
    speakers: [
      {
        person_id: "per_speaker",
        full_name: "Kenji Watanabe",
        company: "Orbital",
        headline: "ML Infrastructure Engineer",
        bio: "Trains and serves large models on a budget.",
        links: ["https://example.com/kenji"],
        email: "kenji@orbital.example",
      },
    ],
  };
}

function scorecardHtml(anonymity: "open" | "single_blind" | "double_blind"): string {
  const projection = reviewableProjection(reviewableFixture(), anonymity);
  const view = reviewerAssignmentView({
    assignment: { id: "asg_1", status: "assigned", due_at: null },
    roundName: "Screening",
    anonymity,
    proposal: projection,
    rubric: { id: "rub_1", event_id: "evt_1", name: "Screening rubric", description: null, version: 1, overall_scale: "none", requires_comment: false },
    criteria: [],
    existing: { review: null, scores: [], naCriterionIds: [] },
    canSeeOthers: false,
    otherReviews: [],
    aggregate: null,
    comments: [],
    discussionEnabled: false,
  });
  return String(view);
}

describe("INV-05-8 / 'Fairness rules made explicit': double_blind hides speaker identity from the reviewer's own scorecard", () => {
  it("shows no speaker name, company or bio when the round is double_blind", () => {
    const html = scorecardHtml("double_blind");
    expect(html).not.toContain("Kenji Watanabe");
    expect(html).not.toContain("Orbital");
    expect(html).not.toContain("kenji@orbital.example");
    expect(html).toContain("double-blind");
  });

  it("shows the speaker when the round is open", () => {
    const html = scorecardHtml("open");
    expect(html).toContain("Kenji Watanabe");
    expect(html).toContain("Orbital");
  });

  it("shows the speaker under single_blind — only double_blind hides speakers from reviewers", () => {
    const html = scorecardHtml("single_blind");
    expect(html).toContain("Kenji Watanabe");
  });
});
