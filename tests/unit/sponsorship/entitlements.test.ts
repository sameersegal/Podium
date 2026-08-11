import { describe, expect, it } from "vitest";
import {
  checkFormatAndDeadline,
  checkMaySubmitForSponsor,
  checkQuantityAvailable,
  checkQuantityReduction,
  checkSponsorDeletable,
  checkSponsorNotBlocked,
  checkSponsorshipUsable,
  consumedCount,
  entitlementState,
  expiringSoon,
  isPubliclyVisible,
  usageOf,
} from "@podiumconf/domain/sponsorship/types.js";

const NOW = "2027-03-01T00:00:00.000Z";
const ENTITLEMENT = {
  id: "ent_1",
  entitlement_type: "session_slot",
  quantity: 2,
  allowed_format_ids: ["fmt_sponsor"],
  submission_deadline: "2027-04-10T23:59:00.000Z",
  expires_at: "2027-04-30T23:59:00.000Z",
  label: "session slots",
};

describe("Entitlement is a countable right (03)", () => {
  it("counts a hold, not a decrement — a draft already holds the slot", () => {
    // Otherwise three contacts at the same company race for two slots and two
    // of them waste an afternoon writing.
    expect(consumedCount({ held_count: 1, spent_count: 0 })).toBe(1);
    expect(consumedCount({ held_count: 1, spent_count: 1 })).toBe(2);
  });

  it("derives consumed_count and remaining from the proposals, never a stored counter", () => {
    const usage = usageOf(ENTITLEMENT, { held_count: 1, spent_count: 0 }, NOW);
    expect(usage).toMatchObject({ quantity: 2, consumed_count: 1, remaining: 1, state: "held" });
  });

  it("reads the state diagram off the counts", () => {
    expect(entitlementState(ENTITLEMENT, { held_count: 0, spent_count: 0 }, NOW)).toBe("available");
    expect(entitlementState(ENTITLEMENT, { held_count: 1, spent_count: 0 }, NOW)).toBe("held");
    expect(entitlementState(ENTITLEMENT, { held_count: 0, spent_count: 2 }, NOW)).toBe("spent");
    // available --> forfeited when expires_at passes unspent
    expect(entitlementState(ENTITLEMENT, { held_count: 0, spent_count: 0 }, "2027-05-01T00:00:00.000Z")).toBe("forfeited");
    // A held slot past the date is not silently forfeited out from under a draft.
    expect(entitlementState(ENTITLEMENT, { held_count: 1, spent_count: 0 }, "2027-05-01T00:00:00.000Z")).toBe("held");
  });

  it("INV-03-3: rejects a sponsor session beyond the entitlement quantity, naming the entitlement", () => {
    expect(checkQuantityAvailable(ENTITLEMENT, { held_count: 1, spent_count: 0 }, "Acme Corp", "DevFlow Conf 2027")).toBeNull();
    const failure = checkQuantityAvailable(ENTITLEMENT, { held_count: 1, spent_count: 1 }, "Acme Corp", "DevFlow Conf 2027");
    expect(failure).toMatchObject({ invariant: "INV-03-3", code: "entitlement_exhausted" });
    // Not a generic 400: the message says who, how many, and for which event.
    expect(failure?.message).toBe("Acme Corp has used all 2 session slots for DevFlow Conf 2027.");
    expect(failure?.details).toMatchObject({ entitlement_id: "ent_1", quantity: 2, consumed_count: 2 });
  });

  it("INV-03-4: refuses to lower quantity below consumed_count", () => {
    expect(checkQuantityReduction("ent_1", 2, { held_count: 1, spent_count: 1 })).toBeNull();
    const failure = checkQuantityReduction("ent_1", 1, { held_count: 1, spent_count: 1 });
    expect(failure).toMatchObject({ invariant: "INV-03-4", code: "quantity_below_consumed" });
    expect(failure?.message).toMatch(/Release 1 before lowering/);
  });

  it("INV-03-2: only a confirmed, unexpired sponsorship may hold or spend", () => {
    expect(checkSponsorshipUsable({ status: "confirmed" }, ENTITLEMENT, NOW)).toBeNull();
    expect(checkSponsorshipUsable({ status: "pending" }, ENTITLEMENT, NOW)).toMatchObject({ invariant: "INV-03-2" });
    expect(checkSponsorshipUsable({ status: "cancelled" }, ENTITLEMENT, NOW)).toMatchObject({ invariant: "INV-03-2" });
    expect(checkSponsorshipUsable({ status: "confirmed" }, ENTITLEMENT, "2027-05-02T00:00:00.000Z")).toMatchObject({
      invariant: "INV-03-2",
    });
  });

  it("INV-03-5: the format must be allowed and the sponsor deadline unexpired", () => {
    expect(checkFormatAndDeadline(ENTITLEMENT, "fmt_sponsor", NOW)).toBeNull();
    expect(checkFormatAndDeadline(ENTITLEMENT, "fmt_keynote", NOW)).toMatchObject({
      invariant: "INV-03-5",
      code: "format_not_allowed_for_entitlement",
    });
    expect(checkFormatAndDeadline(ENTITLEMENT, "fmt_sponsor", "2027-04-11T00:00:00.000Z")).toMatchObject({
      code: "sponsor_submission_deadline_passed",
    });
    // An empty allowlist means any format.
    expect(checkFormatAndDeadline({ ...ENTITLEMENT, allowed_format_ids: [] }, "fmt_keynote", NOW)).toBeNull();
  });

  it("INV-03-6: only an active contact who may submit, or a sponsor manager, may use the entitlement", () => {
    const active = { status: "active", can_submit_sessions: true, event_id: null };
    expect(checkMaySubmitForSponsor(active, false, "evt_1")).toBeNull();
    expect(checkMaySubmitForSponsor(null, true, "evt_1")).toBeNull(); // staff
    expect(checkMaySubmitForSponsor(null, false, "evt_1")).toMatchObject({ invariant: "INV-03-6" });
    expect(checkMaySubmitForSponsor({ ...active, status: "revoked" }, false, "evt_1")).toMatchObject({ invariant: "INV-03-6" });
    expect(checkMaySubmitForSponsor({ ...active, can_submit_sessions: false }, false, "evt_1")).toMatchObject({
      invariant: "INV-03-6",
    });
    // A contact scoped to one event cannot submit for another.
    expect(checkMaySubmitForSponsor({ ...active, event_id: "evt_other" }, false, "evt_1")).toMatchObject({
      invariant: "INV-03-6",
    });
  });

  it("INV-03-7: a blocked sponsor may not hold entitlements or submit", () => {
    expect(checkSponsorNotBlocked({ name: "Acme", status: "active" })).toBeNull();
    expect(checkSponsorNotBlocked({ name: "Acme", status: "blocked" })).toMatchObject({ invariant: "INV-03-7" });
  });

  it("INV-03-8: a sponsor is public only once confirmed and past public_from", () => {
    expect(isPubliclyVisible({ status: "confirmed", public_from: null }, NOW)).toBe(true);
    expect(isPubliclyVisible({ status: "pending", public_from: null }, NOW)).toBe(false);
    expect(isPubliclyVisible({ status: "confirmed", public_from: "2027-06-01T00:00:00.000Z" }, NOW)).toBe(false);
    expect(isPubliclyVisible({ status: "confirmed", public_from: "2027-01-01T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("INV-03-9: a sponsor with live sessions cannot be deleted", () => {
    expect(checkSponsorDeletable("Acme", [])).toBeNull();
    expect(checkSponsorDeletable("Acme", ["ses_1", "ses_2"])).toMatchObject({ invariant: "INV-03-9" });
  });

  it("hooks entitlement.expiring_soon on the nearest of the two deadlines", () => {
    // The sponsor-chasing job is mostly "who has unspent slots and a deadline
    // next week", and that should be a subscription, not a spreadsheet.
    const soon = expiringSoon(ENTITLEMENT, 1, "2027-04-05T00:00:00.000Z");
    expect(soon.due).toBe(true);
    expect(soon.at).toBe("2027-04-10T23:59:00.000Z");
    expect(expiringSoon(ENTITLEMENT, 0, "2027-04-05T00:00:00.000Z").due).toBe(false);
    expect(expiringSoon(ENTITLEMENT, 1, "2027-01-01T00:00:00.000Z").due).toBe(false);
  });
});
