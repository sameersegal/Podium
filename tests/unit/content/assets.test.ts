import { describe, expect, it } from "vitest";
import {
  assertAttachable,
  isLatest,
  markLatest,
  nextVersion,
  parseSlotKey,
  slotKey,
  supersededBy,
} from "@podiumstack/domain/content/assets.js";

describe("asset slot versioning (INV-11-9)", () => {
  it("INV-11-9: the first upload into a slot is version 1", () => {
    expect(nextVersion([])).toBe(1);
  });

  it("INV-11-9: uploading into an occupied slot_key creates version = max + 1", () => {
    expect(nextVersion([{ id: "a", version: 1 }, { id: "b", version: 2 }])).toBe(3);
  });

  it("INV-11-9: version numbers are never reused after a soft delete — max counts deleted rows too", () => {
    expect(nextVersion([{ id: "a", version: 1 }, { id: "b", version: 2, deleted_at: "2027-01-01" }])).toBe(3);
  });

  it("supersedes the highest non-deleted version, not the highest version number", () => {
    const slot = [{ id: "v1", version: 1 }, { id: "v3-deleted", version: 3, deleted_at: "2027-01-01" }, { id: "v2", version: 2 }];
    expect(supersededBy(slot)?.id).toBe("v2");
  });

  it("INV-11-9: exactly one non-deleted asset per slot_key has is_latest = true", () => {
    const slot = [{ id: "v1", version: 1 }, { id: "v2", version: 2 }];
    expect(isLatest({ id: "v1", version: 1 }, slot)).toBe(false);
    expect(isLatest({ id: "v2", version: 2 }, slot)).toBe(true);
  });

  it("a deleted asset is never is_latest, even if it has the highest version", () => {
    const slot = [{ id: "v1", version: 1 }, { id: "v2", version: 2, deleted_at: "2027-01-01" }];
    expect(isLatest({ id: "v2", version: 2, deleted_at: "2027-01-01" }, slot)).toBe(false);
    expect(supersededBy(slot)?.id).toBe("v1");
  });

  it("markLatest annotates a whole slot in one pass, agreeing with isLatest per element", () => {
    const slot = [{ id: "v1", version: 1 }, { id: "v2", version: 2 }, { id: "v3", version: 3, deleted_at: "x" }];
    const marked = markLatest(slot);
    expect(marked.find((m) => m.id === "v2")?.is_latest).toBe(true);
    expect(marked.filter((m) => m.is_latest)).toHaveLength(1);
  });

  it("slotKey / parseSlotKey round-trip the subject and kind", () => {
    const key = slotKey("session", "ses_01H", "slides");
    expect(key).toBe("session:ses_01H:slides");
    expect(parseSlotKey(key)).toEqual({ subject_type: "session", subject_id: "ses_01H", kind: "slides" });
  });
});

describe("INV-11-3: the scan gate", () => {
  it("refuses an asset that has not passed scan_status = clean", () => {
    expect(() => assertAttachable({ id: "ast_1", scan_status: "pending" }, "a published session")).toThrowError();
    try {
      assertAttachable({ id: "ast_1", scan_status: "infected" }, "a published session");
    } catch (err) {
      expect((err as { invariant?: string }).invariant).toBe("INV-11-3");
    }
  });

  it("allows a clean asset through", () => {
    expect(() => assertAttachable({ id: "ast_1", scan_status: "clean" }, "a published session")).not.toThrow();
  });
});
