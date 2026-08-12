import { describe, expect, it } from "vitest";
import { assertRemovable, sessionStatusOnPlace, sessionStatusOnRemove } from "@podiumstack/domain/scheduling/placement.js";

/**
 * INV-08-3 and INV-06-7 pull in opposite directions on one case, and the
 * resolution is worth pinning down: an organizer cannot unplace a cancelled
 * session (there is no `cancelled → confirmed` edge to return it along), but
 * cancelling a session *must* release its placement.
 */
describe("removing a placement", () => {
  it("INV-08-3: placing sets scheduled, removing returns it to confirmed", () => {
    expect(sessionStatusOnPlace("confirmed")).toBe("scheduled");
    expect(sessionStatusOnRemove("scheduled")).toBe("confirmed");
  });

  it("INV-08-10: a published session is left alone in both directions", () => {
    // 06 draws no `published → confirmed` edge, and the session stays in the
    // snapshot it was published into.
    expect(sessionStatusOnPlace("published")).toBeNull();
    expect(sessionStatusOnRemove("published")).toBeNull();
  });

  it("INV-08-3: refuses an organizer unplacing a cancelled session", () => {
    expect(() => assertRemovable({ id: "ses_1", status: "cancelled" })).toThrow();
    expect(() => assertRemovable({ id: "ses_1", status: "scheduled" })).not.toThrow();
  });

  it("INV-06-7: cancelling a session may still release its placement", () => {
    // The cancellation reaction runs after the session is already `cancelled`,
    // so without this carve-out INV-06-7 would be unsatisfiable.
    expect(() => assertRemovable({ id: "ses_1", status: "cancelled" }, "session_cancelled")).not.toThrow();
    expect(sessionStatusOnRemove("cancelled")).toBeNull();
  });
});
