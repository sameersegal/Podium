import { describe, expect, it } from "vitest";
import {
  assertStartable,
  assertTaskTransition,
  assertWaiverReason,
  canTransitionTask,
  daysOverdue,
  isNonTerminalTask,
  isOverdue,
  isTerminalTask,
  nextStatusOnSubmit,
  TASK_TRANSITIONS,
  type TaskInstanceStatus,
} from "@podiumstack/domain/onboarding/types.js";

/** Typed errors carry their invariant id (11-cross-cutting.md); assert on that, not on prose. */
function expectInvariant(fn: () => unknown, invariant: string): void {
  try {
    fn();
    throw new Error(`expected ${invariant} to be thrown`);
  } catch (err) {
    expect((err as { invariant?: string }).invariant).toBe(invariant);
  }
}

/**
 * 07-onboarding.md, `TaskInstance` state diagram — every arrow drawn is
 * legal, and cancellation now reaches every non-terminal state (C7 in
 * 13-open-questions.md).
 */

const DRAWN: [TaskInstanceStatus, TaskInstanceStatus][] = [
  ["blocked", "not_started"],
  ["blocked", "cancelled"],
  ["not_started", "in_progress"],
  ["not_started", "completed"],
  ["not_started", "waived"],
  ["not_started", "cancelled"],
  ["in_progress", "submitted"],
  ["in_progress", "completed"],
  ["in_progress", "waived"],
  ["in_progress", "cancelled"],
  ["submitted", "completed"],
  ["submitted", "changes_requested"],
  ["submitted", "waived"],
  ["submitted", "cancelled"],
  ["changes_requested", "in_progress"],
  ["changes_requested", "cancelled"],
  ["completed", "in_progress"],
];

describe("TaskInstance state machine (07)", () => {
  it("draws exactly the transitions in 07's diagram", () => {
    const flattened = new Set(Object.entries(TASK_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)));
    expect(flattened.size).toBe(DRAWN.length);
    for (const [from, to] of DRAWN) expect(flattened.has(`${from}->${to}`)).toBe(true);
  });

  it.each(DRAWN)("allows the drawn transition %s -> %s", (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
    expect(() => assertTaskTransition(from, to)).not.toThrow();
  });

  it("C7: cancellation reaches every non-terminal state, including blocked, submitted and changes_requested", () => {
    for (const from of ["blocked", "not_started", "in_progress", "submitted", "changes_requested"] as TaskInstanceStatus[]) {
      expect(canTransitionTask(from, "cancelled")).toBe(true);
    }
  });

  it("rejects undrawn transitions", () => {
    const undrawn: [TaskInstanceStatus, TaskInstanceStatus][] = [
      ["blocked", "completed"],
      ["blocked", "in_progress"], // must pass through not_started first
      ["not_started", "submitted"], // must pass through in_progress
      ["not_started", "changes_requested"],
      ["completed", "waived"],
      ["completed", "cancelled"],
      ["waived", "not_started"],
      ["waived", "completed"],
      ["cancelled", "not_started"],
      ["changes_requested", "submitted"], // must pass through in_progress again
      ["changes_requested", "completed"],
    ];
    for (const [from, to] of undrawn) {
      expect(canTransitionTask(from, to)).toBe(false);
      expect(() => assertTaskTransition(from, to)).toThrow();
    }
  });

  it("terminal statuses have no drawn arrow out", () => {
    for (const status of ["completed", "waived", "cancelled"] as TaskInstanceStatus[]) {
      if (status === "completed") continue; // completed -> in_progress is the one reopen arrow
      expect(TASK_TRANSITIONS[status]).toEqual([]);
      expect(isTerminalTask(status)).toBe(true);
    }
  });

  it("isNonTerminalTask is the complement of isTerminalTask", () => {
    for (const status of Object.keys(TASK_TRANSITIONS) as TaskInstanceStatus[]) {
      expect(isNonTerminalTask(status)).toBe(!isTerminalTask(status));
    }
  });

  it("INV-07-4: a blocked task cannot be started", () => {
    expectInvariant(() => assertStartable("blocked"), "INV-07-4");
    expect(() => assertStartable("not_started")).not.toThrow();
  });

  it("INV-07-3: is_overdue compares due_at to now at read time and is never terminal-overdue", () => {
    const now = "2027-03-01T00:00:00.000Z";
    expect(isOverdue({ due_at: "2027-02-01T00:00:00.000Z", status: "not_started" }, now)).toBe(true);
    expect(isOverdue({ due_at: "2027-04-01T00:00:00.000Z", status: "not_started" }, now)).toBe(false);
    expect(isOverdue({ due_at: null, status: "not_started" }, now)).toBe(false);
    // A completed task past its due date is not overdue — the obligation is closed.
    expect(isOverdue({ due_at: "2027-02-01T00:00:00.000Z", status: "completed" }, now)).toBe(false);
  });

  it("daysOverdue floors to whole days and never goes negative", () => {
    expect(daysOverdue("2027-02-01T00:00:00.000Z", "2027-02-04T12:00:00.000Z")).toBe(3);
    expect(daysOverdue("2027-02-10T00:00:00.000Z", "2027-02-04T00:00:00.000Z")).toBe(0);
  });

  it("INV-07-6: requires_review tasks reach completed only via nextStatusOnSubmit's submitted path", () => {
    expect(nextStatusOnSubmit(true)).toBe("submitted");
    expect(nextStatusOnSubmit(false)).toBe("completed");
  });

  it("INV-07-7: waiving requires a non-blank reason", () => {
    expectInvariant(() => assertWaiverReason(""), "INV-07-7");
    expectInvariant(() => assertWaiverReason("   "), "INV-07-7");
    expect(assertWaiverReason(" travel fell through ")).toBe("travel fell through");
  });
});
