import { describe, expect, it } from "vitest";
import {
  appliesTo,
  assertAcyclic,
  assertMayComplete,
  checkCompletion,
  completionStats,
  findDependencyCycle,
  onboardingProgress,
  resolveDueAt,
  submissionPayloadIsPii,
  taskVisibility,
  type ProgressInput,
} from "@podiumstack/domain/onboarding/types.js";
import { assertNamedPeople } from "@podiumstack/web/contexts/onboarding/service.js";

/** Typed errors carry their invariant id (11-cross-cutting.md); assert on that, not on prose. */
function expectInvariant(fn: () => unknown, invariant: string): void {
  try {
    fn();
    throw new Error(`expected ${invariant} to be thrown`);
  } catch (err) {
    expect((err as { invariant?: string }).invariant).toBe(invariant);
  }
}

describe("checkCompletion — one condition per requirement_type (07's config table)", () => {
  it("acknowledgement: needs the box ticked, and a typed name when required", () => {
    expect(checkCompletion({ requirement_type: "acknowledgement", config: {}, payload: { accepted: false } }).satisfied).toBe(false);
    expect(checkCompletion({ requirement_type: "acknowledgement", config: {}, payload: { accepted: true } }).satisfied).toBe(true);
    expect(
      checkCompletion({ requirement_type: "acknowledgement", config: { require_typed_name: true }, payload: { accepted: true } }).satisfied,
    ).toBe(false);
    expect(
      checkCompletion({
        requirement_type: "acknowledgement",
        config: { require_typed_name: true },
        payload: { accepted: true, typed_name: "Ada Lovelace" },
      }).satisfied,
    ).toBe(true);
  });

  it("form: every required field key must be answered", () => {
    const config = { required_field_keys: ["bio", "headshot"] };
    expect(checkCompletion({ requirement_type: "form", config, payload: { answers: { bio: "hi" } } }).satisfied).toBe(false);
    expect(checkCompletion({ requirement_type: "form", config, payload: { answers: { bio: "hi", headshot: "ast_1" } } }).satisfied).toBe(true);
  });

  it("INV-07-9: file_upload requires every asset scan_status = clean", () => {
    const noAssets = checkCompletion({ requirement_type: "file_upload", config: {}, payload: {}, assets: [] });
    expect(noAssets.satisfied).toBe(false);

    const pending = checkCompletion({
      requirement_type: "file_upload",
      config: {},
      payload: {},
      assets: [{ id: "ast_1", scan_status: "pending" }],
    });
    expect(pending.satisfied).toBe(false);
    expect(pending.invariant).toBe("INV-07-9");
    expect(pending.message).toMatch(/still being scanned/);

    const infected = checkCompletion({
      requirement_type: "file_upload",
      config: {},
      payload: {},
      assets: [{ id: "ast_1", scan_status: "infected" }],
    });
    expect(infected.invariant).toBe("INV-07-9");
    expect(infected.message).toMatch(/failed/);

    const clean = checkCompletion({
      requirement_type: "file_upload",
      config: { min_width: 800, min_height: 800 },
      payload: {},
      assets: [{ id: "ast_1", scan_status: "clean", width: 800, height: 800 }],
    });
    expect(clean.satisfied).toBe(true);

    const tooSmall = checkCompletion({
      requirement_type: "file_upload",
      config: { min_width: 800, min_height: 800 },
      payload: {},
      assets: [{ id: "ast_1", scan_status: "clean", width: 200, height: 200 }],
    });
    expect(tooSmall.satisfied).toBe(false);
  });

  it("external_link: the assignee must confirm", () => {
    expect(checkCompletion({ requirement_type: "external_link", config: {}, payload: {} }).satisfied).toBe(false);
    expect(checkCompletion({ requirement_type: "external_link", config: {}, payload: { confirmed: true } }).satisfied).toBe(true);
  });

  it("scheduling: a slot must be booked", () => {
    expect(checkCompletion({ requirement_type: "scheduling", config: {}, payload: {} }).satisfied).toBe(false);
    expect(checkCompletion({ requirement_type: "scheduling", config: {}, payload: { booked: true } }).satisfied).toBe(true);
  });

  it("text_response: length bounds are enforced", () => {
    const config = { min_length: 10, max_length: 20 };
    expect(checkCompletion({ requirement_type: "text_response", config, payload: { text: "too short" } }).satisfied).toBe(false);
    expect(checkCompletion({ requirement_type: "text_response", config, payload: { text: "this is long enough" } }).satisfied).toBe(true);
    expect(checkCompletion({ requirement_type: "text_response", config, payload: { text: "this is far too long for the limit" } }).satisfied).toBe(false);
  });

  it("speaker_nomination: needs min_speakers named with a name and email", () => {
    const config = { min_speakers: 1, max_speakers: 2 };
    expect(checkCompletion({ requirement_type: "speaker_nomination", config, payload: { nominees: [] } }).satisfied).toBe(false);
    expect(
      checkCompletion({
        requirement_type: "speaker_nomination",
        config,
        payload: { nominees: [{ full_name: "Grace Hopper", email: "grace@example.com" }] },
      }).satisfied,
    ).toBe(true);
    expect(
      checkCompletion({
        requirement_type: "speaker_nomination",
        config,
        payload: {
          nominees: [
            { full_name: "A", email: "a@example.com" },
            { full_name: "B", email: "b@example.com" },
            { full_name: "C", email: "c@example.com" },
          ],
        },
      }).satisfied,
    ).toBe(false);
  });
});

describe("completionStats — waived is reported separately from completed", () => {
  it("does not fold waived into completed", () => {
    const tasks: ProgressInput[] = [
      { status: "completed", is_blocking: true, is_required: true },
      { status: "completed", is_blocking: true, is_required: true },
      { status: "waived", is_blocking: true, is_required: true },
      { status: "not_started", is_blocking: false, is_required: true },
      { status: "cancelled", is_blocking: false, is_required: true },
    ];
    const stats = completionStats(tasks);
    expect(stats.completed).toBe(2);
    expect(stats.waived).toBe(1);
    expect(stats.outstanding).toBe(1);
    expect(stats.cancelled).toBe(1);
    // percent counts completed + waived out of live (non-cancelled) tasks.
    expect(stats.percent).toBe(onboardingProgress(tasks));
    expect(stats.percent).toBe(75);
  });
});

describe("INV-07-4 — dependency graphs must be acyclic", () => {
  it("finds a direct cycle", () => {
    const cycle = findDependencyCycle([
      { key: "a", depends_on_task_keys: ["b"] },
      { key: "b", depends_on_task_keys: ["a"] },
    ]);
    expect(cycle).not.toBeNull();
    expectInvariant(
      () => assertAcyclic([{ key: "a", depends_on_task_keys: ["b"] }, { key: "b", depends_on_task_keys: ["a"] }]),
      "INV-07-4",
    );
  });

  it("accepts a valid chain with no cycle", () => {
    expect(
      findDependencyCycle([
        { key: "a", depends_on_task_keys: [] },
        { key: "b", depends_on_task_keys: ["a"] },
        { key: "c", depends_on_task_keys: ["b"] },
      ]),
    ).toBeNull();
  });

  it("an unknown dependency key is not treated as a cycle", () => {
    expect(findDependencyCycle([{ key: "a", depends_on_task_keys: ["nonexistent"] }])).toBeNull();
  });
});

describe("INV-07-12 — named_people requires a non-empty list", () => {
  it("refuses an empty list", () => {
    expectInvariant(() => assertNamedPeople("named_people", []), "INV-07-12");
    expectInvariant(() => assertNamedPeople("named_people", undefined), "INV-07-12");
  });

  it("accepts a non-empty list, and ignores the rule entirely for other assignee_rules", () => {
    expect(() => assertNamedPeople("named_people", ["per_1"])).not.toThrow();
    expect(() => assertNamedPeople("each_speaker", [])).not.toThrow();
  });
});

describe("applies_to filtering (materialisation step 1)", () => {
  it("an empty filter matches everything", () => {
    expect(appliesTo(null, {})).toBe(true);
    expect(appliesTo({}, { origin: "cfp" })).toBe(true);
  });

  it("filters on attendance_mode per speaker, not per session", () => {
    const filter = { attendance_modes: ["in_person"] };
    expect(appliesTo(filter, { attendance_mode: "in_person" })).toBe(true);
    expect(appliesTo(filter, { attendance_mode: "remote" })).toBe(false);
    expect(appliesTo(filter, { attendance_mode: null })).toBe(false);
  });
});

describe("resolveDueAt (materialisation step 4)", () => {
  const ctx = { assigned_at: "2027-01-01T00:00:00.000Z" };

  it("relative_to_assignment offsets from when the instance is materialised", () => {
    expect(resolveDueAt("relative_to_assignment", { offset_days: 7 }, ctx)).toBe("2027-01-08T00:00:00.000Z");
  });

  it("relative_to_session_start is null until the session has a placement", () => {
    expect(resolveDueAt("relative_to_session_start", { offset_days: -7 }, { ...ctx, session_start: null })).toBeNull();
  });

  it("none never has a due date", () => {
    expect(resolveDueAt("none", {}, ctx)).toBeNull();
  });
});

describe("INV-07-10 — task visibility", () => {
  const task = { assignee_person_id: "per_speaker", session_id: "ses_1", sponsor_id: null };

  it("is full for the assignee and for event staff", () => {
    expect(taskVisibility(task, { person_id: "per_speaker", is_event_staff: false, session_ids: [], sponsor_ids: [] })).toBe("full");
    expect(taskVisibility(task, { person_id: null, is_event_staff: true, session_ids: [], sponsor_ids: [] })).toBe("full");
  });

  it("is status_only for that session's other speakers", () => {
    expect(taskVisibility(task, { person_id: "per_cospeaker", is_event_staff: false, session_ids: ["ses_1"], sponsor_ids: [] })).toBe("status_only");
  });

  it("is status_only for a sponsor contact who nominated this person, but never the payload", () => {
    expect(
      taskVisibility(task, {
        person_id: "per_wrangler",
        is_event_staff: false,
        session_ids: [],
        sponsor_ids: [],
        nominated_person_ids: ["per_speaker"],
      }),
    ).toBe("status_only");
  });

  it("is full for a sponsor contact of the task's own sponsor", () => {
    const sponsorTask = { assignee_person_id: "per_wrangler", session_id: null, sponsor_id: "spo_1" };
    expect(taskVisibility(sponsorTask, { person_id: "per_contact", is_event_staff: false, session_ids: [], sponsor_ids: ["spo_1"] })).toBe("full");
  });

  it("is none for an unrelated logged-in person, and none when logged out", () => {
    expect(taskVisibility(task, { person_id: "per_stranger", is_event_staff: false, session_ids: [], sponsor_ids: [] })).toBe("none");
    expect(taskVisibility(task, { person_id: null, is_event_staff: false, session_ids: [], sponsor_ids: [] })).toBe("none");
  });
});

describe("INV-07-5 — only the assignee, or staff acting explicitly, may complete a task", () => {
  it("allows the assignee", () => {
    expect(() => assertMayComplete("per_1", "per_1", false)).not.toThrow();
  });
  it("allows staff on someone else's task", () => {
    expect(() => assertMayComplete("per_1", "per_organizer", true)).not.toThrow();
  });
  it("refuses another speaker who is not staff", () => {
    expectInvariant(() => assertMayComplete("per_1", "per_2", false), "INV-07-5");
  });
});

describe("PII — TaskSubmission.payload only when the definition's category is travel or legal", () => {
  it("flags travel and legal, nothing else", () => {
    expect(submissionPayloadIsPii("travel")).toBe(true);
    expect(submissionPayloadIsPii("legal")).toBe(true);
    expect(submissionPayloadIsPii("content")).toBe(false);
    expect(submissionPayloadIsPii("marketing")).toBe(false);
  });
});
