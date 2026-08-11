import { describe, expect, it } from "vitest";
import { nextAction } from "@podiumconf/domain/submissions/types.js";

/**
 * 04, "Submitter portal read model" — "a plain-language next action ('Awaiting
 * decision', 'Confirm by 14 April', '3 changes requested')" for every
 * `Proposal.status`.
 */

const NOW = "2027-03-01T00:00:00.000Z";

describe("nextAction (04, Submitter portal read model)", () => {
  it("draft: prompts to finish and submit, with the CFP deadline", () => {
    const result = nextAction({ status: "draft", percent_complete: 40, cfp_closes_at: "2027-03-10T00:00:00.000Z", now: NOW });
    expect(result.label).toMatch(/Finish and submit/);
    expect(result.urgency).not.toBe("err");
    expect(result.deadline).toBe("2027-03-10T00:00:00.000Z");
  });

  it("draft: flags urgency once the CFP has already closed", () => {
    const result = nextAction({ status: "draft", percent_complete: 40, cfp_closes_at: "2027-02-01T00:00:00.000Z", now: NOW });
    expect(result.label).toMatch(/closed/);
    expect(result.urgency).toBe("err");
  });

  it("submitted: awaiting review, no deadline", () => {
    const result = nextAction({ status: "submitted", now: NOW });
    expect(result.label).toBe("Submitted — awaiting review");
    expect(result.urgency).toBe("none");
    expect(result.deadline).toBeNull();
  });

  it("in_review: awaiting decision", () => {
    const result = nextAction({ status: "in_review", now: NOW });
    expect(result.label).toBe("Awaiting decision");
  });

  it("changes_requested: names the count and tells the submitter to act", () => {
    const result = nextAction({ status: "changes_requested", changes_requested_count: 3, now: NOW });
    expect(result.label).toBe("3 changes requested — update and resubmit");
    expect(result.urgency).toBe("warn");
  });

  it("changes_requested: still actionable with no count given", () => {
    const result = nextAction({ status: "changes_requested", now: NOW });
    expect(result.label).toBe("Changes requested — update and resubmit");
  });

  it("accepted: prompts to confirm by the confirmation_deadline", () => {
    const result = nextAction({ status: "accepted", confirmation_deadline: "2027-04-14T00:00:00.000Z", now: NOW });
    expect(result.label).toMatch(/^Confirm by/);
    expect(result.urgency).toBe("warn");
    expect(result.deadline).toBe("2027-04-14T00:00:00.000Z");
  });

  it("accepted: overdue once the confirmation deadline has passed", () => {
    const result = nextAction({ status: "accepted", confirmation_deadline: "2027-02-01T00:00:00.000Z", now: NOW });
    expect(result.label).toMatch(/overdue/);
    expect(result.urgency).toBe("err");
  });

  it("accepted: prompts to confirm even with no deadline set yet", () => {
    const result = nextAction({ status: "accepted", now: NOW });
    expect(result.label).toBe("Accepted — confirm your session");
  });

  it("waitlisted: says so and gives no deadline", () => {
    const result = nextAction({ status: "waitlisted", now: NOW });
    expect(result.label).toMatch(/waitlist/);
    expect(result.urgency).toBe("info");
  });

  it("rejected: plain statement, no urgency", () => {
    const result = nextAction({ status: "rejected", now: NOW });
    expect(result.label).toBe("Not selected for this event");
    expect(result.urgency).toBe("none");
  });

  it("withdrawn: plain statement", () => {
    const result = nextAction({ status: "withdrawn", now: NOW });
    expect(result.label).toBe("Withdrawn");
  });

  it("expired: names the confirmation_deadline that passed", () => {
    const result = nextAction({ status: "expired", confirmation_deadline: "2027-02-01T00:00:00.000Z", now: NOW });
    expect(result.label).toMatch(/Expired/);
    expect(result.urgency).toBe("err");
    expect(result.deadline).toBe("2027-02-01T00:00:00.000Z");
  });
});
