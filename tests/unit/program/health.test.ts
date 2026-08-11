import { describe, expect, it } from "vitest";
import {
  formatMixOf,
  onboardingAtRiskSessionIds,
  sessionsByStatus,
  sponsorSessionShare,
  trackBalanceOf,
  unconfirmedSpeakerCount,
  unplacedConfirmedCount,
} from "@podiumconf/web/contexts/program/views.js";

/**
 * 06-program.md, "Program health read model" — pure aggregators only. The D1
 * reads that feed them (`loadProgramHealth`) are covered by the integration
 * suite; these are plain-array tests so a signal's arithmetic is provable
 * without a database.
 */

describe("program health signals (06, Program health read model)", () => {
  it("sessions_by_status counts per status", () => {
    const out = sessionsByStatus([
      { status: "confirmed" },
      { status: "confirmed" },
      { status: "pending_confirmation" },
      { status: "cancelled" },
    ]);
    expect(out).toEqual({ confirmed: 2, pending_confirmation: 1, cancelled: 1 });
  });

  it("format_mix counts per format", () => {
    const out = formatMixOf([
      { session_format_id: "fmt_talk" },
      { session_format_id: "fmt_talk" },
      { session_format_id: "fmt_keynote" },
    ]);
    expect(out).toEqual({ fmt_talk: 2, fmt_keynote: 1 });
  });

  it("track_balance counts confirmed-or-later sessions per track, ignoring pending and cancelled", () => {
    const out = trackBalanceOf([
      { track_id: "trk_a", status: "confirmed" },
      { track_id: "trk_a", status: "scheduled" },
      { track_id: "trk_a", status: "pending_confirmation" }, // not counted
      { track_id: "trk_b", status: "cancelled" }, // not counted
      { track_id: null, status: "confirmed" }, // untracked session, not counted
    ]);
    expect(out).toEqual({ trk_a: 2 });
  });

  describe("sponsor_session_share — \"sponsored sessions / total published, per day and overall\"", () => {
    it("computes the overall ratio across published and delivered sessions only", () => {
      const share = sponsorSessionShare([
        { status: "published", sponsor_id: "spo_1" },
        { status: "published", sponsor_id: null },
        { status: "delivered", sponsor_id: "spo_1" },
        { status: "scheduled", sponsor_id: "spo_1" }, // not published yet — excluded
        { status: "cancelled", sponsor_id: "spo_1" }, // excluded
      ]);
      expect(share.overall).toEqual({ published: 3, sponsored: 2, share: 2 / 3 });
    });

    it("breaks the ratio down per day (Placement.event_day_id)", () => {
      const share = sponsorSessionShare([
        { status: "published", sponsor_id: "spo_1", day_id: "day_1" },
        { status: "published", sponsor_id: null, day_id: "day_1" },
        { status: "published", sponsor_id: "spo_1", day_id: "day_2" },
      ]);
      expect(share.by_day.day_1).toEqual({ published: 2, sponsored: 1, share: 0.5 });
      expect(share.by_day.day_2).toEqual({ published: 1, sponsored: 1, share: 1 });
    });

    it("buckets a published session with no placement as unscheduled", () => {
      const share = sponsorSessionShare([{ status: "published", sponsor_id: "spo_1", day_id: null }]);
      expect(share.by_day.unscheduled).toEqual({ published: 1, sponsored: 1, share: 1 });
    });

    it("is zero, not NaN, when nothing is published yet", () => {
      const share = sponsorSessionShare([{ status: "confirmed", sponsor_id: "spo_1" }]);
      expect(share.overall).toEqual({ published: 0, sponsored: 0, share: 0 });
    });
  });

  it("unconfirmed_speakers counts sessions still pending_confirmation", () => {
    expect(
      unconfirmedSpeakerCount([{ status: "pending_confirmation" }, { status: "confirmed" }, { status: "pending_confirmation" }]),
    ).toBe(2);
  });

  describe("onboarding_at_risk — blocking tasks overdue or due within 7 days", () => {
    const now = "2026-03-01T00:00:00.000Z";

    it("flags a session with a blocking task due within the window", () => {
      const ids = onboardingAtRiskSessionIds(
        [{ session_id: "ses_1", is_blocking: true, status: "not_started", due_at: "2026-03-05T00:00:00.000Z" }],
        now,
      );
      expect(ids.has("ses_1")).toBe(true);
    });

    it("flags an already-overdue blocking task", () => {
      const ids = onboardingAtRiskSessionIds(
        [{ session_id: "ses_1", is_blocking: true, status: "in_progress", due_at: "2026-02-01T00:00:00.000Z" }],
        now,
      );
      expect(ids.has("ses_1")).toBe(true);
    });

    it("ignores a non-blocking task, a completed task, and a task due far in the future", () => {
      const ids = onboardingAtRiskSessionIds(
        [
          { session_id: "ses_1", is_blocking: false, status: "not_started", due_at: "2026-03-02T00:00:00.000Z" },
          { session_id: "ses_2", is_blocking: true, status: "completed", due_at: "2026-02-01T00:00:00.000Z" },
          { session_id: "ses_3", is_blocking: true, status: "not_started", due_at: "2026-06-01T00:00:00.000Z" },
        ],
        now,
      );
      expect(ids.size).toBe(0);
    });
  });

  it("unplaced_confirmed counts confirmed sessions with no placement", () => {
    const placed = new Set(["ses_2"]);
    const n = unplacedConfirmedCount(
      [
        { id: "ses_1", status: "confirmed" },
        { id: "ses_2", status: "confirmed" },
        { id: "ses_3", status: "scheduled" },
      ],
      placed,
    );
    expect(n).toBe(1);
  });
});
