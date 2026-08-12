import { describe, expect, it } from "vitest";
import { applyResultFilters, type ResultRow, type ScopedProposal } from "@podiumconf/web/contexts/review/scoring.js";
import { resultsCsvRow, toCsv } from "@podiumconf/web/contexts/review/views.js";
import { reviewerAssignmentView } from "@podiumconf/web/contexts/review/reviewer-views.js";
import {
  reviewableContentHash,
  reviewableProjection,
  type ReviewableProposal,
} from "@podiumconf/domain/review/anonymity.js";
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

function reviewableFixture(overrides: Partial<ReviewableProposal> = {}): ReviewableProposal {
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
    reference_labels: {},
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
    ...overrides,
  };
}

/** The reference-valued answers a seeded form actually produces (04). */
function referenceAnswers(): Pick<ReviewableProposal, "answers" | "reference_labels"> {
  return {
    answers: [
      { field_key: "track", label: "Track", type: "track_picker", value: "trk_ai", pii: false, identifies_speaker: false },
      { field_key: "format", label: "Session format", type: "format_picker", value: "fmt_talk", pii: false, identifies_speaker: false },
      { field_key: "speakers", label: "Speakers", type: "speaker_list", value: ["per_speaker"], pii: false, identifies_speaker: false },
      { field_key: "slides", label: "Draft slides", type: "file", value: { asset_ids: ["ast_1"] }, pii: false, identifies_speaker: false },
      {
        field_key: "level",
        label: "Audience level",
        type: "single_select",
        options: [{ value: "intermediate", label: "Intermediate" }],
        value: "intermediate",
        pii: false,
      identifies_speaker: false,
      },
    ],
    reference_labels: {
      trk_ai: "Applied AI",
      fmt_talk: "Conference talk",
      per_speaker: "Kenji Watanabe",
      ast_1: "kenji-watanabe-slides.pdf",
    },
  };
}

function scorecardHtml(
  anonymity: "open" | "single_blind" | "double_blind",
  overrides: Partial<ReviewableProposal> = {},
): string {
  const projection = reviewableProjection(reviewableFixture(overrides), anonymity);
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
    position: null,
    now: "2027-01-01T00:00:00.000Z",
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

  /**
   * The roster was dropped and the bio *answer* was not, so the one field
   * guaranteed to open with the speaker's own name survived every other
   * precaution. `pii` could not fix it — a bio is published beside the talk —
   * so the form says so with `identifies_speaker` instead.
   */
  it("drops an answer the form flags as identifying, even though it is public rather than pii", () => {
    const bioAnswer = {
      answers: [
        {
          field_key: "speaker_bio",
          label: "Speaker bio",
          type: "long_text" as const,
          value: "Kenji Watanabe runs the platform team at Orbital.",
          pii: false,
          identifies_speaker: true,
        },
      ],
      reference_labels: {},
    };
    const blind = scorecardHtml("double_blind", bioAnswer);
    expect(blind).not.toContain("Kenji Watanabe");
    expect(blind).not.toContain("Orbital");
    expect(blind).not.toContain("Speaker bio");

    // Not blind, not hidden — the flag is about anonymity, not secrecy.
    expect(scorecardHtml("open", bioAnswer)).toContain("Kenji Watanabe");
  });
});

describe("a reviewer reads answers, not ids (04, `ProposalAnswer.display`)", () => {
  it("renders reference-valued answers as names, never as the id the answer stores", () => {
    const html = scorecardHtml("open", referenceAnswers());
    expect(html).toContain("Applied AI");
    expect(html).toContain("Conference talk");
    expect(html).toContain("Intermediate");
    expect(html).toContain("kenji-watanabe-slides.pdf");
    expect(html).not.toContain("trk_ai");
    expect(html).not.toContain("fmt_talk");
    expect(html).not.toContain("per_speaker");
    expect(html).not.toContain("ast_1");
    expect(html).not.toContain("asset_ids");
  });

  it("drops the speaker_list answer and withholds filenames under double_blind, rather than naming the speaker twice over", () => {
    const html = scorecardHtml("double_blind", referenceAnswers());
    expect(html).not.toContain("Kenji Watanabe");
    expect(html).not.toContain("kenji-watanabe-slides.pdf");
    expect(html).not.toContain("per_speaker");
    expect(html).toContain("1 file");
    // Everything that is not identity still reads normally.
    expect(html).toContain("Applied AI");
  });

  it("INV-05-8: a blind round's content_hash covers only the answers it shows, so a new co-speaker does not stale it", () => {
    const shown = reviewableProjection(reviewableFixture(referenceAnswers()), "double_blind");
    expect(shown.answers.map((a) => a.field_key)).not.toContain("speakers");

    const withCoSpeaker = reviewableFixture(referenceAnswers());
    withCoSpeaker.answers = withCoSpeaker.answers.map((a) =>
      a.field_key === "speakers" ? { ...a, value: ["per_speaker", "per_new_cospeaker"] } : a,
    );
    expect(reviewableContentHash(reviewableProjection(withCoSpeaker, "double_blind"))).toBe(
      reviewableContentHash(shown),
    );
    expect(reviewableContentHash(reviewableProjection(withCoSpeaker, "open"))).not.toBe(
      reviewableContentHash(reviewableProjection(reviewableFixture(referenceAnswers()), "open")),
    );
  });
});
