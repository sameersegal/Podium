import { describe, expect, it } from "vitest";
import { sessionRecords } from "@podiumstack/web/contexts/submissions/views.js";
import type {
  DashboardProposal,
  DashboardSession,
  DashboardTask,
  SubmitterDashboard,
} from "@podiumstack/web/contexts/submissions/views.js";

/**
 * R13 — `Proposal` and `Session` stay separate in the model **and are presented
 * as one session record**. The rule has a second half that the portal was
 * breaking: the split "must not leak into the UI as two rows a user has to
 * reconcile". `sessionRecords` is the join that closes it.
 */

const proposal = (over: Partial<DashboardProposal> = {}): DashboardProposal => ({
  id: "prp_1",
  reference: "DFC-0001",
  title: "A talk",
  status: "submitted",
  origin: "cfp",
  event_id: "evt_1",
  event_name: "DevFlow",
  event_slug: "devflow",
  event_timezone: "America/Los_Angeles",
  cfp_name: "Main call",
  cfp_status: "open",
  percent_complete: null,
  next_action: { label: "Nothing to do", urgency: "info", deadline: null },
  deadline: null,
  edit: { editable: false, requires_unsubmit: false },
  can_withdraw: true,
  is_submitter: true,
  feedback_for_speaker: null,
  submitted_at: "2026-01-01T00:00:00.000Z",
  decision_published_at: null,
  session_id: null,
  ...over,
});

const session = (over: Partial<DashboardSession> = {}): DashboardSession => ({
  id: "ses_1",
  reference: "DFC-0001",
  title: "A talk",
  event_name: "DevFlow",
  event_timezone: "America/Los_Angeles",
  status: "confirmed",
  confirmation_status: "confirmed",
  starts_at: null,
  ends_at: null,
  room_name: null,
  ...over,
});

const task = (over: Partial<DashboardTask> = {}): DashboardTask => ({
  id: "tsk_1",
  title: "Upload your slides",
  status: "not_started",
  due_at: null,
  is_blocking: false,
  event_name: "DevFlow",
  session_id: "ses_1",
  overdue: false,
  ...over,
});

const dash = (over: Partial<SubmitterDashboard> = {}): SubmitterDashboard => ({
  proposals: [],
  invitations: [],
  sessions: [],
  tasks: [],
  profile: { completeness: 0, is_listed: true, public_fields: [] },
  ...over,
});

describe("R13: one session record per talk", () => {
  it("collapses a proposal and the session it became into a single row", () => {
    const records = sessionRecords(
      dash({
        proposals: [proposal({ status: "accepted", session_id: "ses_1" })],
        sessions: [session({ status: "scheduled", starts_at: "2027-05-13T17:00:00.000Z", room_name: "Room 2B" })],
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].proposal?.id).toBe("prp_1");
    expect(records[0].session?.id).toBe("ses_1");
    expect(records[0].stage).toBe("Scheduled");
    expect(records[0].room_name).toBe("Room 2B");
  });

  it("keeps a proposal that has no session yet", () => {
    const records = sessionRecords(dash({ proposals: [proposal({ status: "in_review" })] }));
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe("In review");
    expect(records[0].session).toBeNull();
    expect(records[0].href).toBe("/portal/proposals/prp_1");
  });

  it("keeps a session that has no proposal — an invited or sponsor talk", () => {
    // Dropping these would hide the talks whose owners are least likely to know
    // where else to look for them.
    const records = sessionRecords(dash({ sessions: [session({ status: "confirmed" })] }));
    expect(records).toHaveLength(1);
    expect(records[0].proposal).toBeNull();
    expect(records[0].stage).toBe("Confirmed");
    expect(records[0].href).toBe("/portal/sessions/ses_1");
  });

  it("shows the session's stage once there is one, not the proposal's frozen status", () => {
    // `Proposal.status` stops at `accepted` by design — the review record is
    // frozen against what was reviewed — so reading it after acceptance tells a
    // speaker less than the session does.
    const records = sessionRecords(
      dash({ proposals: [proposal({ status: "accepted", session_id: "ses_1" })], sessions: [session({ status: "published" })] }),
    );
    expect(records[0].stage).toBe("On the public schedule");
  });

  it("drops the proposal's next action once the session has moved past confirmation", () => {
    // The bug this prevents: a talk already on the public schedule still being
    // told to "Confirm by 31 August", a date that had passed.
    const records = sessionRecords(
      dash({
        proposals: [proposal({ status: "accepted", session_id: "ses_1", next_action: { label: "Confirm by 31 August", urgency: "warn", deadline: null } })],
        sessions: [session({ status: "scheduled" })],
      }),
    );
    expect(records[0].next_action).toBeNull();
  });

  it("keeps the confirmation prompt while the session is still waiting for an answer", () => {
    const records = sessionRecords(
      dash({
        proposals: [proposal({ status: "accepted", session_id: "ses_1", next_action: { label: "Confirm by 31 August", urgency: "warn", deadline: null } })],
        sessions: [session({ status: "pending_confirmation", confirmation_status: "pending" })],
      }),
    );
    expect(records[0].stage).toBe("Awaiting your confirmation");
    expect(records[0].next_action?.label).toBe("Confirm by 31 August");
  });

  it("attaches a session's tasks to its own row", () => {
    const records = sessionRecords(
      dash({
        proposals: [proposal({ status: "accepted", session_id: "ses_1" })],
        sessions: [session()],
        tasks: [task(), task({ id: "tsk_2", session_id: null, title: "Sign the org-wide code of conduct" })],
      }),
    );
    expect(records[0].tasks.map((t) => t.id)).toEqual(["tsk_1"]);
  });

  it("raises a row that has an overdue task above one that does not", () => {
    const records = sessionRecords(
      dash({
        proposals: [proposal({ id: "prp_calm", status: "accepted", session_id: "ses_calm", title: "Calm" }), proposal({ id: "prp_late", status: "accepted", session_id: "ses_late", title: "Late" })],
        sessions: [session({ id: "ses_calm", title: "Calm" }), session({ id: "ses_late", title: "Late" })],
        tasks: [task({ id: "tsk_late", session_id: "ses_late", overdue: true, due_at: "2026-01-01T00:00:00.000Z" })],
      }),
    );
    expect(records.map((r) => r.title)).toEqual(["Late", "Calm"]);
    expect(records[0].tone).toBe("err");
  });
});
