import { describe, expect, it } from "vitest";
import {
  assertNoPrivateFields,
  computeDiff,
  contentEtag,
  pendingPublicationChanges,
  publishability,
  speakerSortKey,
  type PublishedSessionSnapshot,
  type PublishedSpeakerSnapshot,
  type SnapshotEventRef,
} from "@podiumstack/domain/scheduling/publication.js";

/**
 * 08, "Publication" — the pure rules a `SchedulePublication` snapshot obeys:
 * INV-08-11 (`content_etag`), INV-08-8 (no private field ever enters a
 * snapshot), INV-08-4 (what may publish), and the diffs that drive the public
 * "what changed" list.
 */

const EVENT: SnapshotEventRef = {
  id: "evt_1",
  name: "DevFlow Conf",
  slug: "devflow-conf",
  tagline: null,
  timezone: "UTC",
  starts_on: "2027-06-01",
  ends_on: "2027-06-03",
  website_url: null,
  venue: null,
  days: [{ id: "day_1", date: "2027-06-01", label: "Day 1" }],
};

function session(over: Partial<PublishedSessionSnapshot> & { session_id: string }): PublishedSessionSnapshot {
  return {
    reference: over.session_id,
    title: "A talk",
    subtitle: null,
    abstract: null,
    description: null,
    track: null,
    format: null,
    room: null,
    starts_at: "2027-06-01T09:00:00.000Z",
    ends_at: "2027-06-01T09:30:00.000Z",
    duration_minutes: 30,
    audience_level: null,
    keywords: [],
    language: null,
    speaker_refs: [],
    sponsor: null,
    is_sponsored_content: false,
    assets: [],
    registration_url: null,
    capacity: null,
    ...over,
  };
}

function speaker(over: Partial<PublishedSpeakerSnapshot> & { person_id: string; display_name: string }): PublishedSpeakerSnapshot {
  return {
    pronouns: null,
    headline: null,
    job_title: null,
    company: null,
    short_bio: null,
    bio: null,
    headshot_url: null,
    links: [],
    session_refs: [],
    sort_key: speakerSortKey(over.display_name),
    ...over,
  };
}

describe("INV-08-11: content_etag changes if and only if the snapshot content changes", () => {
  it("is stable across two computations of the same content", async () => {
    const content = { event: EVENT, sessions: [session({ session_id: "ses_1" })], speakers: [] };
    const a = await contentEtag(content);
    const b = await contentEtag(content);
    expect(a).toBe(b);
  });

  it("is unaffected by array order — the hash is over sorted content", async () => {
    const s1 = session({ session_id: "ses_1", title: "Talk one" });
    const s2 = session({ session_id: "ses_2", title: "Talk two" });
    const forward = await contentEtag({ event: EVENT, sessions: [s1, s2], speakers: [] });
    const backward = await contentEtag({ event: EVENT, sessions: [s2, s1], speakers: [] });
    expect(forward).toBe(backward);
  });

  it("changes when a session's content changes", async () => {
    const before = await contentEtag({ event: EVENT, sessions: [session({ session_id: "ses_1", title: "Original title" })], speakers: [] });
    const after = await contentEtag({ event: EVENT, sessions: [session({ session_id: "ses_1", title: "Retitled" })], speakers: [] });
    expect(after).not.toBe(before);
  });

  it("changes when a session is added or removed", async () => {
    const one = await contentEtag({ event: EVENT, sessions: [session({ session_id: "ses_1" })], speakers: [] });
    const two = await contentEtag({ event: EVENT, sessions: [session({ session_id: "ses_1" }), session({ session_id: "ses_2" })], speakers: [] });
    expect(two).not.toBe(one);
  });

  it("changes when a speaker's public field changes, even with sessions unchanged", async () => {
    const before = await contentEtag({ event: EVENT, sessions: [], speakers: [speaker({ person_id: "per_1", display_name: "Ada Lovelace", job_title: "Engineer" })] });
    const after = await contentEtag({ event: EVENT, sessions: [], speakers: [speaker({ person_id: "per_1", display_name: "Ada Lovelace", job_title: "Staff Engineer" })] });
    expect(after).not.toBe(before);
  });

  it("does not change for content unrelated to the snapshot — same content twice is idempotent", async () => {
    const content = { event: EVENT, sessions: [session({ session_id: "ses_1" })], speakers: [speaker({ person_id: "per_1", display_name: "Ada Lovelace" })] };
    const first = await contentEtag(content);
    const second = await contentEtag({ ...content });
    expect(first).toBe(second);
  });
});

describe("INV-08-8 / INV-01-4: no publication payload may carry a private field", () => {
  it("passes a payload built only from public fields", () => {
    expect(() => assertNoPrivateFields({ event: EVENT, sessions: [session({ session_id: "ses_1" })], speakers: [speaker({ person_id: "per_1", display_name: "Ada" })] })).not.toThrow();
  });

  it("rejects a payload carrying a speaker's email", () => {
    const payload = { speakers: [{ ...speaker({ person_id: "per_1", display_name: "Ada" }), email: "ada@example.com" }] };
    expect(() => assertNoPrivateFields(payload)).toThrow(/INV-08-8|email/);
  });

  it("rejects a payload carrying the INV-01-4 fields at any depth", () => {
    for (const field of ["phone", "dietary_notes", "accessibility_notes", "travel_status", "attendance_mode"]) {
      const payload = { sessions: [{ nested: { [field]: "private value" } }] };
      expect(() => assertNoPrivateFields(payload), `expected ${field} to be rejected`).toThrow();
    }
  });

  it("names the invariant on the thrown error", () => {
    try {
      assertNoPrivateFields({ notes: "a private run-sheet note" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error & { invariant?: string }).invariant).toBe("INV-08-8");
    }
  });
});

describe("INV-08-4: publishability", () => {
  const READY = {
    session_id: "ses_1",
    title: "A talk",
    visibility: "public",
    status: "confirmed",
    content_status: "approved",
    blocking_tasks_outstanding: 0,
    has_placement: true,
    placement_is_public: true,
    room_is_public: true,
    error_conflict_codes: [],
  };

  it("a placed, public, approved, error-free session is publishable", () => {
    expect(publishability(READY).publishable).toBe(true);
  });

  it("INV-06-8: an internal session is never publishable, and never overridable", () => {
    const verdict = publishability({ ...READY, visibility: "internal" });
    expect(verdict.publishable).toBe(false);
    expect(verdict.overridable).toBe(false);
  });

  it("an unplaced session is not publishable", () => {
    expect(publishability({ ...READY, has_placement: false }).publishable).toBe(false);
  });

  it("an error-severity conflict blocks publication but is overridable with a reason", () => {
    const verdict = publishability({ ...READY, error_conflict_codes: ["ROOM_DOUBLE_BOOKED"] });
    expect(verdict.publishable).toBe(false);
    expect(verdict.overridable).toBe(true);
  });
});

describe("diffs and PendingPublicationChanges (R25)", () => {
  it("computeDiff reports session_added for a session absent from the previous publication", () => {
    const diff = computeDiff([], [session({ session_id: "ses_1" })]);
    expect(diff).toEqual([{ change_type: "session_added", session_id: "ses_1", before: null, after: expect.objectContaining({ title: "A talk" }) }]);
  });

  it("INV-08-10: a cancelled session reads session_cancelled rather than session_removed, so links do not silently 404", () => {
    const prev = [session({ session_id: "ses_1" })];
    const diff = computeDiff(prev, [], new Set(["ses_1"]));
    expect(diff[0].change_type).toBe("session_cancelled");
  });

  it("pendingPublicationChanges is zero once the working schedule matches what is live", () => {
    const live = [session({ session_id: "ses_1", title: "Talk" })];
    const working = [{ session_id: "ses_1", title: "Talk", starts_at: live[0].starts_at, ends_at: live[0].ends_at, room_id: null, room_name: null, content_status: "approved", content_approved_at: null, status: "published", publishable: true }];
    expect(pendingPublicationChanges(live, working, 1).count).toBe(0);
  });

  it("counts a retitled, published session as one pending change", () => {
    const live = [session({ session_id: "ses_1", title: "Old title" })];
    const working = [{ session_id: "ses_1", title: "New title", starts_at: live[0].starts_at, ends_at: live[0].ends_at, room_id: null, room_name: null, content_status: "approved", content_approved_at: null, status: "published", publishable: true }];
    const pending = pendingPublicationChanges(live, working, 1);
    expect(pending.count).toBe(1);
    expect(pending.changes[0].kind).toBe("retitled");
  });
});

describe("speakerSortKey — R15: the directory is ordered by surname", () => {
  it("sorts by the last word of the display name", () => {
    const names = ["Ada Lovelace", "Barbara Liskov", "Grace Hopper"].map(speakerSortKey).sort();
    expect(names[0]).toMatch(/^hopper/);
    expect(names[1]).toMatch(/^liskov/);
    expect(names[2]).toMatch(/^lovelace/);
  });
});
