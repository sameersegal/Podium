import { describe, expect, it } from "vitest";
import { narrowExport, project, EXPORT_COLUMNS, PII_COLUMNS } from "@podiumconf/domain/content/export.js";
import type { Principals } from "@podiumconf/domain/shared/authorization.js";

const NOW = "2027-03-01T00:00:00.000Z";

const owner: Principals = {
  org_id: "org_1",
  person_id: "per_owner",
  grants: [{ role: "owner", scope_type: "org", scope_id: "org_1", expires_at: null, revoked_at: null }],
  relationships: { session_ids: [], proposal_ids: [], sponsor_ids: [], participant_event_ids: [] },
};

const speaker: Principals = {
  org_id: "org_1",
  person_id: "per_speaker",
  grants: [],
  relationships: { session_ids: ["ses_1"], proposal_ids: ["prp_1"], sponsor_ids: [], participant_event_ids: [] },
};

/** A chair who also submitted a talk — INV-11-7's actual scenario. */
const chairWhoSubmitted: Principals = {
  org_id: "org_1",
  person_id: "per_chair",
  grants: [{ role: "program_chair", scope_type: "org", scope_id: "org_1", expires_at: null, revoked_at: null }],
  relationships: { session_ids: [], proposal_ids: ["prp_own"], sponsor_ids: [], participant_event_ids: [] },
};

const reviewer: Principals = {
  org_id: "org_1",
  person_id: "per_reviewer",
  grants: [{ role: "reviewer", scope_type: "org", scope_id: "org_1", expires_at: null, revoked_at: null }],
  relationships: { session_ids: [], proposal_ids: [], sponsor_ids: [], participant_event_ids: [] },
};

const nobody: Principals = {
  org_id: "org_1",
  person_id: "per_nobody",
  grants: [],
  relationships: { session_ids: [], proposal_ids: [], sponsor_ids: [], participant_event_ids: [] },
};

describe("export permission narrowing (INV-11-12)", () => {
  it("INV-11-12: an export is generated under the requester's own permissions — someone with no access to the subject is refused outright", () => {
    expect(() => narrowExport(nobody, { subject: "review_results", format: "csv", include_pii: false }, NOW)).toThrowError(/cannot export/);
  });

  it("INV-11-12: include_pii is honoured only when the requester holds pii:read, and PII columns are dropped when it is not", () => {
    const owned = narrowExport(owner, { subject: "speakers", format: "csv", include_pii: true }, NOW);
    expect(owned.include_pii).toBe(true);
    expect(owned.columns).toEqual([...EXPORT_COLUMNS.speakers]);

    const redacted = narrowExport(owner, { subject: "speakers", format: "csv", include_pii: false }, NOW);
    expect(redacted.include_pii).toBe(false);
    for (const col of PII_COLUMNS.speakers) expect(redacted.columns).not.toContain(col);
    // Non-PII columns still make it through.
    expect(redacted.columns).toContain("full_name");
  });

  it("INV-11-12: asking for personal data without pii:read is rejected with the invariant, not silently downgraded", () => {
    let threw = false;
    try {
      // A reviewer can read review results (assigned, `O`) but the matrix
      // grants them no `pii.read` row at all.
      narrowExport(reviewer, { subject: "review_results", format: "csv", include_pii: true }, NOW);
    } catch (err) {
      threw = true;
      expect((err as { invariant?: string }).invariant).toBe("INV-11-12");
    }
    expect(threw).toBe(true);
  });

  it("INV-11-7: a chair who also submitted a talk can export review_results, but their own proposal is excluded from the surface entirely", () => {
    const perm = narrowExport(chairWhoSubmitted, { subject: "review_results", format: "csv", include_pii: false }, NOW);
    expect(perm.access).not.toBe("none");
    expect(perm.excluded_proposal_ids).toContain("prp_own");
  });

  it("narrows to relationship-derived record sets for `own` access", () => {
    const perm = narrowExport(speaker, { subject: "proposals", format: "csv", include_pii: false }, NOW);
    expect(perm.access).toBe("own");
    expect(perm.own_proposal_ids).toEqual(["prp_1"]);
  });

  it("`project` strips a row down to exactly the permitted columns, nothing else", () => {
    const row = { id: "1", title: "Talk", speaker_emails: "leaked@example.com", extra: "not requested" };
    expect(project(row, ["id", "title"])).toEqual({ id: "1", title: "Talk" });
  });
});
