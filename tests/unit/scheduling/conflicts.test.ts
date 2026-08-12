import { describe, expect, it } from "vitest";
import { detectConflicts, type ConflictInputs, type DayFact, type RoomFact, type SessionFact } from "@podiumstack/domain/scheduling/conflicts.js";
import type { PlacementFact } from "@podiumstack/domain/scheduling/placement.js";
import { CONFLICT_CODE, type ConflictCode } from "@podiumstack/domain/scheduling/types.js";

/**
 * 08, "Conflict detection" — every code in the table, detected on a
 * constructed case and absent on a clean one. `detectConflicts` is pure, so
 * each case is just a fact graph, no I/O.
 */

const DAY: DayFact = { id: "day_1", date: "2027-06-01", label: "Day 1" };
const ROOM_A: RoomFact = { id: "rom_a", name: "Room A", capacity: 100, av_capabilities: ["projector"], is_public: true };
const ROOM_B: RoomFact = { id: "rom_b", name: "Room B", capacity: 20, av_capabilities: [], is_public: true };

function session(over: Partial<SessionFact> & { id: string }): SessionFact {
  return {
    title: over.id,
    duration_minutes: 30,
    av_requirements: [],
    visibility: "public",
    status: "confirmed",
    blocking_tasks_outstanding: 0,
    speaker_person_ids: [],
    ...over,
  };
}

function placement(over: Partial<PlacementFact> & { id: string; session_id: string }): PlacementFact {
  return {
    room_id: ROOM_A.id,
    event_day_id: DAY.id,
    starts_at: "2027-06-01T09:00:00.000Z",
    ends_at: "2027-06-01T09:30:00.000Z",
    setup_minutes: 0,
    teardown_minutes: 0,
    status: "tentative",
    is_public: true,
    ...over,
  };
}

function baseInputs(over: Partial<ConflictInputs> = {}): ConflictInputs {
  return {
    event_id: "evt_1",
    timezone: "UTC",
    min_transit_minutes: 10,
    placements: [],
    sessions: {},
    rooms: { [ROOM_A.id]: ROOM_A, [ROOM_B.id]: ROOM_B },
    days: { [DAY.id]: DAY },
    slots: [],
    series: [],
    people: {},
    ...over,
  };
}

function codesOf(inputs: ConflictInputs): ConflictCode[] {
  return detectConflicts(inputs).map((f) => f.code);
}

describe("detectConflicts (08, conflict detection)", () => {
  it("a clean, non-overlapping schedule has no conflicts at all", () => {
    const s1 = session({ id: "ses_1" });
    const s2 = session({ id: "ses_2" });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
      ],
    });
    expect(detectConflicts(inputs)).toEqual([]);
  });

  it("INV-08-4 ROOM_DOUBLE_BOOKED: two placements overlap in one room, counting setup/teardown", () => {
    const s1 = session({ id: "ses_1" });
    const s2 = session({ id: "ses_2" });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z", teardown_minutes: 15 }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:40:00.000Z", ends_at: "2027-06-01T10:00:00.000Z" }),
      ],
    });
    expect(codesOf(inputs)).toContain("ROOM_DOUBLE_BOOKED");
  });

  it("SPEAKER_DOUBLE_BOOKED: a person is a public speaker on two overlapping placements", () => {
    const s1 = session({ id: "ses_1", speaker_person_ids: ["per_1"] });
    const s2 = session({ id: "ses_2", speaker_person_ids: ["per_1"] });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:15:00.000Z", ends_at: "2027-06-01T09:45:00.000Z" }),
      ],
    });
    expect(codesOf(inputs)).toContain("SPEAKER_DOUBLE_BOOKED");
  });

  it("SPEAKER_NO_TRANSIT: same speaker, back-to-back in different rooms, gap below min_transit_minutes", () => {
    const s1 = session({ id: "ses_1", speaker_person_ids: ["per_1"] });
    const s2 = session({ id: "ses_2", speaker_person_ids: ["per_1"] });
    const inputs = baseInputs({
      min_transit_minutes: 10,
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        // Starts 5 minutes after the first ends, in a different room — below the 10-minute floor.
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:35:00.000Z", ends_at: "2027-06-01T10:05:00.000Z" }),
      ],
    });
    expect(codesOf(inputs)).toContain("SPEAKER_NO_TRANSIT");
    // A 15-minute gap clears the floor and raises no warning.
    const clear = baseInputs({
      min_transit_minutes: 10,
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:45:00.000Z", ends_at: "2027-06-01T10:15:00.000Z" }),
      ],
    });
    expect(codesOf(clear)).not.toContain("SPEAKER_NO_TRANSIT");
  });

  it("DURATION_MISMATCH: ends_at - starts_at != Session.duration_minutes", () => {
    const s1 = session({ id: "ses_1", duration_minutes: 45 });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1 },
      placements: [placement({ id: "plc_1", session_id: s1.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" })],
    });
    expect(codesOf(inputs)).toContain("DURATION_MISMATCH");
  });

  it("AV_UNSUPPORTED: Session.av_requirements not covered by Room.av_capabilities", () => {
    const s1 = session({ id: "ses_1", av_requirements: ["livestream"] });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1 },
      placements: [placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_B.id })],
    });
    expect(codesOf(inputs)).toContain("AV_UNSUPPORTED");
  });

  it("OVER_CAPACITY: expected demand exceeds Room.capacity", () => {
    const s1 = session({ id: "ses_1", capacity_override: 50 });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1 },
      placements: [placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_B.id })], // capacity 20
    });
    expect(codesOf(inputs)).toContain("OVER_CAPACITY");
  });

  it("TRACK_COLLISION: two same-track sessions run concurrently", () => {
    const s1 = session({ id: "ses_1", track_id: "trk_1", track_name: "Agents" });
    const s2 = session({ id: "ses_2", track_id: "trk_1", track_name: "Agents" });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
      ],
    });
    expect(codesOf(inputs)).toContain("TRACK_COLLISION");
  });

  it("SPONSOR_COLLISION: two sessions from the same sponsor overlap", () => {
    const s1 = session({ id: "ses_1", sponsor_id: "spo_1", sponsor_name: "Acme" });
    const s2 = session({ id: "ses_2", sponsor_id: "spo_1", sponsor_name: "Acme" });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
      ],
    });
    expect(codesOf(inputs)).toContain("SPONSOR_COLLISION");
  });

  it("SERIES_OUT_OF_ORDER: a continues_in relation is placed before its predecessor, or in a different room", () => {
    const s1 = session({ id: "ses_1" });
    const s2 = session({ id: "ses_2" });
    const beforeItsPredecessor = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      series: [{ session_id: s1.id, related_session_id: s2.id }],
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T10:00:00.000Z", ends_at: "2027-06-01T10:30:00.000Z" }),
        // part 2 starts before part 1 finishes
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
      ],
    });
    expect(codesOf(beforeItsPredecessor)).toContain("SERIES_OUT_OF_ORDER");

    const differentRoom = baseInputs({
      sessions: { [s1.id]: s1, [s2.id]: s2 },
      series: [{ session_id: s1.id, related_session_id: s2.id }],
      placements: [
        placement({ id: "plc_1", session_id: s1.id, room_id: ROOM_A.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }),
        placement({ id: "plc_2", session_id: s2.id, room_id: ROOM_B.id, starts_at: "2027-06-01T09:30:00.000Z", ends_at: "2027-06-01T10:00:00.000Z" }),
      ],
    });
    expect(codesOf(differentRoom)).toContain("SERIES_OUT_OF_ORDER");
  });

  it("OUTSIDE_EVENT_HOURS: the placement falls outside its event day's TimeSlot grid", () => {
    const s1 = session({ id: "ses_1" });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1 },
      slots: [{ id: "slt_1", event_day_id: DAY.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T17:00:00.000Z", kind: "session", room_ids: [] }],
      placements: [placement({ id: "plc_1", session_id: s1.id, starts_at: "2027-06-01T18:00:00.000Z", ends_at: "2027-06-01T18:30:00.000Z" })],
    });
    expect(codesOf(inputs)).toContain("OUTSIDE_EVENT_HOURS");

    // No grid at all — free placement, so this code never fires (08, "TimeSlot").
    const noGrid = baseInputs({
      sessions: { [s1.id]: s1 },
      placements: [placement({ id: "plc_1", session_id: s1.id, starts_at: "2027-06-01T23:00:00.000Z", ends_at: "2027-06-01T23:30:00.000Z" })],
    });
    expect(codesOf(noGrid)).not.toContain("OUTSIDE_EVENT_HOURS");
  });

  it("INV-06-5 UNPUBLISHABLE: the session has outstanding blocking onboarding tasks", () => {
    const s1 = session({ id: "ses_1", blocking_tasks_outstanding: 2 });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1 },
      placements: [placement({ id: "plc_1", session_id: s1.id })],
    });
    expect(codesOf(inputs)).toContain("UNPUBLISHABLE");

    // An override reason clears it.
    const overridden = baseInputs({
      sessions: { [s1.id]: { ...s1, publication_override_reason: "Chair sign-off; task waived offline." } },
      placements: [placement({ id: "plc_1", session_id: s1.id })],
    });
    expect(codesOf(overridden)).not.toContain("UNPUBLISHABLE");
  });

  it("every catalogued code (08) has a covering case above", () => {
    const covered: ConflictCode[] = [
      "ROOM_DOUBLE_BOOKED",
      "SPEAKER_DOUBLE_BOOKED",
      "SPEAKER_NO_TRANSIT",
      "DURATION_MISMATCH",
      "AV_UNSUPPORTED",
      "OVER_CAPACITY",
      "TRACK_COLLISION",
      "SPONSOR_COLLISION",
      "SERIES_OUT_OF_ORDER",
      "OUTSIDE_EVENT_HOURS",
      "UNPUBLISHABLE",
    ];
    expect(new Set(covered)).toEqual(new Set(CONFLICT_CODE));
  });

  it("acknowledgement survives recomputation: the finding id is stable across two runs over the same facts", () => {
    const s1 = session({ id: "ses_1", duration_minutes: 45 });
    const inputs = baseInputs({
      sessions: { [s1.id]: s1 },
      placements: [placement({ id: "plc_1", session_id: s1.id, starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" })],
    });
    const first = detectConflicts(inputs);
    const second = detectConflicts(inputs);
    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
  });
});
