import { describe, expect, it } from "vitest";
import { contentDiverged, contentSnapshot } from "@podiumstack/domain/program/types.js";

/**
 * 06, `content_diverged` — "the session has been edited since it was
 * accepted". The signal is only worth anything if it is quiet when nothing
 * was edited.
 */

const SESSION = {
  title: "Taming 40-Minute CI",
  abstract: "How we cut it to six minutes.",
  description: null,
  session_format_id: "fmt_talk",
  track_id: "trk_infra",
  duration_minutes: 30,
  subtitle: null,
  audience_level: "intermediate",
  keywords: null,
  language: null,
};

/** What the routes build: the accepted decision, falling back to the proposal. */
function baseline(overrides: Record<string, unknown> = {}) {
  return {
    title: "Taming 40-Minute CI",
    abstract: "How we cut it to six minutes.",
    description: null,
    session_format_id: "fmt_talk",
    duration_minutes: 30,
    track_id: "trk_infra",
    ...overrides,
  };
}

describe("contentDiverged (06, `content_diverged`)", () => {
  it("is quiet for a session that still matches what was accepted", () => {
    expect(contentDiverged(contentSnapshot(SESSION), baseline())).toBe(false);
  });

  it("fires when the title was edited after acceptance", () => {
    expect(contentDiverged(contentSnapshot(SESSION), baseline({ title: "Something else entirely" }))).toBe(true);
  });

  /**
   * `num(null, fallback)` returns 0 rather than the fallback, because
   * `Number(null)` is a finite 0. A proposal that never named a duration used
   * to produce a baseline of 0 minutes, so every session built from one was
   * flagged as edited forever — nine of eleven in the seeded event.
   */
  it("does not fire merely because the proposal never requested a duration", () => {
    const requested = null;
    const resolved = requested === null || requested === undefined ? SESSION.duration_minutes : requested;
    expect(contentDiverged(contentSnapshot(SESSION), baseline({ duration_minutes: resolved }))).toBe(false);
  });

  it("still fires when the accepted duration genuinely differs", () => {
    expect(contentDiverged(contentSnapshot(SESSION), baseline({ duration_minutes: 45 }))).toBe(true);
  });

  it("treats a null description and an empty one as the same answer", () => {
    expect(contentDiverged(contentSnapshot({ ...SESSION, description: "" }), baseline({ description: null }))).toBe(false);
  });

  it("returns false with no baseline at all — a session with no decision behind it cannot have diverged", () => {
    expect(contentDiverged(contentSnapshot(SESSION), null)).toBe(false);
  });
});
