import { describe, expect, it } from "vitest";
import {
  answerDisplay,
  isReferenceField,
  referenceIdsIn,
  UNRESOLVED_REFERENCE,
} from "@podiumconf/domain/submissions/answer-display.js";

/**
 * 04, "An answer's value is not what a reader sees" — `ProposalAnswer.value`
 * stores ids for the four reference-valued field types, and every human-facing
 * surface renders `display` instead.
 */

describe("answerDisplay resolves references to names", () => {
  const labels = { trk_ai: "Applied AI", fmt_talk: "Conference talk", per_1: "Ada Lovelace", ast_1: "slides.pdf" };

  it("renders a track and a format as their names", () => {
    expect(answerDisplay({ type: "track_picker" }, "trk_ai", labels)).toBe("Applied AI");
    expect(answerDisplay({ type: "format_picker" }, "fmt_talk", labels)).toBe("Conference talk");
  });

  it("renders a speaker_list as names in the order the answer holds them", () => {
    expect(answerDisplay({ type: "speaker_list" }, ["per_1"], labels)).toBe("Ada Lovelace");
  });

  it("never falls back to the id when a reference no longer resolves", () => {
    const display = answerDisplay({ type: "track_picker" }, "trk_archived", labels);
    expect(display).toBe(UNRESOLVED_REFERENCE);
    expect(display).not.toContain("trk_archived");
  });

  it("names attached files, and falls back to a count when the names are withheld", () => {
    const value = { asset_ids: ["ast_1"] };
    expect(answerDisplay({ type: "file" }, value, labels)).toBe("slides.pdf");
    expect(answerDisplay({ type: "file" }, value, {})).toBe("1 file");
    expect(answerDisplay({ type: "file" }, { asset_ids: ["ast_1", "ast_2"] }, {})).toBe("2 files");
  });

  it("renders option labels rather than the stored option values", () => {
    const field = {
      type: "multi_select" as const,
      options: [
        { value: "projector", label: "Projector" },
        { value: "stage_mics", label: "Stage microphones" },
      ],
    };
    expect(answerDisplay(field, ["projector", "stage_mics"])).toBe("Projector, Stage microphones");
    expect(answerDisplay({ ...field, type: "single_select" }, "projector")).toBe("Projector");
  });

  it("renders a consent as Yes/No, so `false` does not read as unanswered", () => {
    expect(answerDisplay({ type: "consent" }, true)).toBe("Yes");
    expect(answerDisplay({ type: "consent" }, false)).toBe("No");
    expect(answerDisplay({ type: "consent" }, null)).toBeNull();
  });

  it("returns null for an unanswered field, whatever shape 'empty' takes for its type", () => {
    expect(answerDisplay({ type: "short_text" }, "")).toBeNull();
    expect(answerDisplay({ type: "speaker_list" }, [])).toBeNull();
    expect(answerDisplay({ type: "file" }, { asset_ids: [] })).toBeNull();
  });

  it("leaves a value the submitter typed exactly as they typed it", () => {
    expect(answerDisplay({ type: "long_text" }, "We cut inference cost in half.")).toBe(
      "We cut inference cost in half.",
    );
    expect(answerDisplay({ type: "duration_picker" }, 45)).toBe("45 minutes");
  });
});

describe("referenceIdsIn collects every id a caller has to look up", () => {
  it("knows which field types hold references", () => {
    expect(isReferenceField("track_picker")).toBe(true);
    expect(isReferenceField("speaker_list")).toBe(true);
    expect(isReferenceField("long_text")).toBe(false);
  });

  it("returns the ids for each reference-valued type and nothing for the rest", () => {
    expect(referenceIdsIn("track_picker", "trk_ai")).toEqual(["trk_ai"]);
    expect(referenceIdsIn("speaker_list", ["per_1", "per_2"])).toEqual(["per_1", "per_2"]);
    expect(referenceIdsIn("file", { asset_ids: ["ast_1"] })).toEqual(["ast_1"]);
    expect(referenceIdsIn("long_text", "trk_ai")).toEqual([]);
    expect(referenceIdsIn("track_picker", null)).toEqual([]);
  });
});
