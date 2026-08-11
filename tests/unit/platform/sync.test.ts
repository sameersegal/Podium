import { describe, expect, it } from "vitest";

import {
  SYNC_LINK_STATUSES,
  SYNC_SUBJECTS,
  SUBJECT_SPECS,
  canTransitionSyncLink,
  canonical,
  columnOf,
  fieldSpec,
  primaryField,
  pushableFields,
  fromExternal,
  isEcho,
  projectCanonical,
  projectForPush,
  projectInbound,
  syncHash,
  toExternal,
  validateFieldMap,
  writableFields,
  type SyncFieldMap,
} from "@podiumconf/domain/platform/sync.js";
import { DomainError } from "@podiumconf/domain/shared/errors.js";

/** The error an invariant raised, so a test can name the invariant rather than the message. */
function invariantOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.invariant ?? err.code;
    throw err;
  }
  throw new Error("expected the call to be refused, and it was not");
}

const map = (field: string, direction: "push" | "both" = "push"): SyncFieldMap => ({
  field,
  external_field: field,
  direction,
});

describe("field maps (INV-09-17)", () => {
  it("accepts a plain push map", () => {
    expect(() => validateFieldMap("session", [map("title"), map("status")], false)).not.toThrow();
  });

  it("refuses a field the subject does not have", () => {
    expect(invariantOf(() => validateFieldMap("session", [map("salary")], false))).toBe("INV-09-17");
  });

  it("refuses a derived field as writable, naming INV-11-6", () => {
    // The rule every other service satisfies by omission: a derived column has
    // no route that can write it, because nothing asks. A field map asks.
    expect(invariantOf(() => validateFieldMap("session", [map("room_name", "both")], false))).toBe("INV-11-6");
  });

  it("refuses a pushable-but-not-writable field as writable", () => {
    expect(invariantOf(() => validateFieldMap("session", [map("content_status", "both")], false))).toBe("INV-09-17");
  });

  it("refuses two Podium fields mapped onto one column", () => {
    const clash: SyncFieldMap[] = [
      { field: "title", external_field: "Name", direction: "push" },
      { field: "subtitle", external_field: "Name", direction: "push" },
    ];
    expect(invariantOf(() => validateFieldMap("session", clash, false))).toBe("INV-09-17");
  });

  it("refuses PII without include_pii, in either direction (INV-09-21)", () => {
    expect(invariantOf(() => validateFieldMap("person", [map("email")], false))).toBe("INV-09-21");
    expect(invariantOf(() => validateFieldMap("person", [map("email", "both")], true))).toBe("INV-09-21");
  });

  it("allows PII outbound once include_pii is set", () => {
    expect(() => validateFieldMap("person", [map("email")], true)).not.toThrow();
  });
});

describe("push-only subjects (INV-09-23)", () => {
  it.each(["decision", "entitlement", "placement"] as const)("%s has no writable field at all", (subject) => {
    expect(writableFields(subject)).toEqual([]);
  });

  it("refuses a mapping that tries to make one writable", () => {
    expect(invariantOf(() => validateFieldMap("decision", [map("outcome", "both")], false))).toBe("INV-09-23");
    expect(invariantOf(() => validateFieldMap("placement", [map("notes", "both")], false))).toBe("INV-09-23");
  });

  it("does not offer `review` as a subject in either direction", () => {
    // Push-only would not be enough: review visibility differs per reader
    // (INV-11-7) and a shared table has one visibility for everybody.
    expect(SYNC_SUBJECTS).not.toContain("review");
  });

  it("states a reason on every push-only subject", () => {
    for (const subject of SYNC_SUBJECTS) {
      const spec = SUBJECT_SPECS[subject];
      if (!spec.pushOnly) continue;
      expect(spec.pushOnly.length, `${subject} is push-only without saying why`).toBeGreaterThan(20);
    }
  });

  it("never marks PII, a relationship or a file writable, on any subject", () => {
    for (const subject of SYNC_SUBJECTS) {
      for (const f of writableFields(subject)) {
        expect(f.pii, `${subject}.${f.field}`).toBeFalsy();
        expect(f.kind, `${subject}.${f.field}`).not.toBe("link");
        expect(f.kind, `${subject}.${f.field}`).not.toBe("attachment");
      }
    }
  });

  it("allows derived and writable together only where a service exists to apply it", () => {
    // Normally derived implies push-only. Two shapes are deliberate exceptions:
    // a select showing a name and storing an id, and the Speakers table's name
    // column, which reads from `Person` and writes back to it. Anything else
    // appearing here is somebody having marked a computed column writable with
    // nowhere for the write to land.
    const found: string[] = [];
    for (const subject of SYNC_SUBJECTS) {
      for (const f of writableFields(subject)) {
        if (!f.derived) continue;
        if (f.optionsFrom) continue;
        found.push(`${subject}.${f.field}`);
      }
    }
    expect(found).toEqual(["speaker_profile.full_name"]);
  });

  it("keeps `visibility` and `is_listed` out of the writable set (INV-01-13)", () => {
    const writable = writableFields("speaker_profile").map((f) => f.field);
    expect(writable).not.toContain("visibility");
    expect(writable).not.toContain("is_listed");
  });

  it("never pushes a decision's feedback or rationale", () => {
    const fields = SUBJECT_SPECS.decision.fields.map((f) => f.field);
    expect(fields).not.toContain("feedback_for_speaker");
    expect(fields).not.toContain("rationale");
  });
});

describe("the value space", () => {
  it("reads a list from JSON, from CSV, and from an array alike", () => {
    expect(canonical("multi_select", '["ai","agents"]')).toEqual(["ai", "agents"]);
    expect(canonical("multi_select", "ai, agents")).toEqual(["ai", "agents"]);
    expect(canonical("multi_select", ["ai", " agents "])).toEqual(["ai", "agents"]);
  });

  it("treats the ways a table tool says yes as one value", () => {
    for (const yes of [true, 1, "true", "TRUE", "Yes", "checked"]) expect(canonical("boolean", yes)).toBe(true);
    for (const no of [false, 0, "false", "no", ""]) expect(canonical("boolean", no) ?? false).toBe(false);
  });

  it("normalises dates so a provider's rendering is not a change", () => {
    expect(canonical("date", "2026-03-01T09:00:00Z")).toBe(canonical("date", "2026-03-01T09:00:00.000+00:00"));
  });

  it("survives a round trip to the provider and back", () => {
    for (const [kind, value] of [
      ["text", "  Keynote  "],
      ["number", "1,200"],
      ["boolean", "yes"],
      ["multi_select", "ai, agents"],
      ["date", "2026-03-01T09:00:00Z"],
    ] as const) {
      const there = canonical(kind, value);
      expect(fromExternal(kind, toExternal(kind, there))).toEqual(there);
    }
  });
});

describe("echo suppression (INV-09-19)", () => {
  const fieldMap = [map("title"), map("keywords"), map("duration_minutes")];
  const row = { title: "Agents in production", keywords: '["ai","agents"]', duration_minutes: 30 };

  it("hashes the same values identically whatever order the map is in", async () => {
    const a = await syncHash(projectCanonical("session", row, fieldMap, { includePii: false }));
    const b = await syncHash(projectCanonical("session", row, [...fieldMap].reverse(), { includePii: false }));
    expect(a).toBe(b);
  });

  it("hashes a changed value differently", async () => {
    const a = await syncHash(projectCanonical("session", row, fieldMap, { includePii: false }));
    const b = await syncHash(projectCanonical("session", { ...row, title: "Agents in prod" }, fieldMap, { includePii: false }));
    expect(a).not.toBe(b);
  });

  it("recognises the record it just pushed, coming back in the provider's shape", async () => {
    // The loop this closes: push writes "ai, agents" into a cell, the provider
    // reports the row as changed, and the pull must see its own handwriting.
    const pushed = await syncHash(projectCanonical("session", row, fieldMap, { includePii: false }));
    const external = projectForPush("session", row, fieldMap, { includePii: false });
    const back = projectInbound("session", external, fieldMap, { includePii: false });
    expect(await syncHash(back.values)).toBe(pushed);
    expect(isEcho(pushed, { last_pushed_hash: pushed, last_pulled_hash: null })).toBe(true);
  });

  it("does not call a genuine edit an echo", async () => {
    const pushed = await syncHash(projectCanonical("session", row, fieldMap, { includePii: false }));
    const edited = projectInbound(
      "session",
      { ...projectForPush("session", row, fieldMap, { includePii: false }), title: "Agents, revisited" },
      fieldMap,
      { includePii: false },
    );
    expect(isEcho(await syncHash(edited.values), { last_pushed_hash: pushed, last_pulled_hash: null })).toBe(false);
  });
});

describe("inbound projection", () => {
  const fieldMap = [map("title", "both"), map("status"), map("room_name")];

  it("patches only the fields marked two-way", () => {
    const result = projectInbound(
      "session",
      { title: "New title", status: "cancelled", room_name: "Hall B" },
      fieldMap,
      { includePii: false },
    );
    // `status` is pushable but not writable; `room_name` is derived from the
    // placement. Both are hashed — the echo check has to cover what the push
    // covered — and neither reaches the patch.
    expect(Object.keys(result.patch)).toEqual(["title"]);
    expect(Object.keys(result.values).sort()).toEqual(["room_name", "status", "title"]);
  });

  it("tells absent from blank", () => {
    const result = projectInbound("session", { title: "" }, fieldMap, { includePii: false });
    expect(result.absent).toContain("status");
    expect(result.patch.title).toBe(null);
  });

  it("drops PII from the projection entirely when the mapping may not carry it", () => {
    const result = projectInbound("person", { email: "a@example.com" }, [map("email")], { includePii: false });
    expect(result.values).toEqual({});
  });
});

describe("the link state machine", () => {
  it("draws every status the enum allows", () => {
    for (const status of SYNC_LINK_STATUSES) {
      const reachable = SYNC_LINK_STATUSES.some((from) => from !== status && canTransitionSyncLink(from, status));
      expect(reachable || status === "pending_push", `nothing reaches ${status}`).toBe(true);
    }
  });

  it("lets a conflict be resolved back into the push queue", () => {
    expect(canTransitionSyncLink("conflict", "pending_push")).toBe(true);
  });

  it("never resurrects an unlinked record", () => {
    // INV-09-22: erasure is the end of the line, not a pause.
    for (const to of SYNC_LINK_STATUSES) {
      if (to === "unlinked") continue;
      expect(canTransitionSyncLink("unlinked", to), `unlinked → ${to}`).toBe(false);
    }
  });

  it("refuses to move straight from in_sync to error without a push", () => {
    expect(canTransitionSyncLink("in_sync", "error")).toBe(false);
  });
});

describe("the shape a table tool actually wants", () => {
  it("gives every subject exactly one primary field, and a scalar one", () => {
    // Providers show the primary field in every linked-record chip, and refuse
    // to make a select, a link or an attachment primary.
    for (const subject of SYNC_SUBJECTS) {
      const primaries = SUBJECT_SPECS[subject].fields.filter((f) => f.primary);
      expect(primaries.length, `${subject} declares ${primaries.length} primary fields`).toBe(1);
      expect(["text", "number", "date", "url", "email"]).toContain(primaries[0].kind);
    }
  });

  it("names a human-readable thing as primary, never an id or a status", () => {
    expect(primaryField("session").field).toBe("title");
    expect(primaryField("speaker_profile").field).toBe("full_name");
    expect(primaryField("sponsor").field).toBe("name");
    expect(primaryField("proposal").field).toBe("reference");
  });

  it("carries speakers as a relationship rather than a comma-joined string", () => {
    const speakers = fieldSpec("session", "speakers")!;
    expect(speakers.kind).toBe("link");
    expect(speakers.linkTo).toBe("speaker_profile");
  });

  it("maps a relationship from one side only", () => {
    // Providers create the reverse column automatically, so declaring both ends
    // would put two mappings on one pair of columns, each undoing the other.
    const speakersSide = SUBJECT_SPECS.speaker_profile.fields.filter((f) => f.kind === "link");
    expect(speakersSide).toEqual([]);
  });

  it("offers tracks and formats as named options, not raw ids", () => {
    const track = fieldSpec("session", "track")!;
    expect(track.kind).toBe("select");
    expect(track.optionsFrom).toBe("track");
    expect(track.writable).toBe(true);
    // The value on the wire is the name; the column behind it is the id.
    expect(columnOf(track)).toBe("track_id");
    expect(SUBJECT_SPECS.session.fields.map((f) => f.field)).not.toContain("track_id");
  });

  it("sends a multi-select as a list, so it renders as chips", () => {
    expect(toExternal("multi_select", ["ai", "agents"])).toEqual(["ai", "agents"]);
  });

  it("sends an attachment as something the provider will go and fetch", () => {
    expect(toExternal("attachment", ["https://example.test/a.png"])).toEqual([{ url: "https://example.test/a.png" }]);
  });

  it("reads a link back whether the provider gives ids or objects", () => {
    expect(fromExternal("link", ["rec1", { id: "rec2" }])).toEqual(["rec1", "rec2"]);
  });
});

describe("links and attachments stay out of the hash (INV-09-19)", () => {
  const fieldMap = [map("title"), map("speakers"), map("slides")];
  const row = { title: "Agents in production" };

  it("hashes only what Podium can reproduce", async () => {
    const values = projectCanonical("session", row, fieldMap, { includePii: false });
    // A provider record id and a fetched file copy are the provider's, not
    // ours. Hashing them would make every record look changed on every pull.
    expect(Object.keys(values)).toEqual(["title"]);
  });

  it("hashes the same whether or not the related records exist yet", async () => {
    const before = await syncHash(projectCanonical("session", row, fieldMap, { includePii: false, links: {} }));
    const after = await syncHash(
      projectCanonical("session", row, fieldMap, { includePii: false, links: { speakers: ["recA", "recB"] } }),
    );
    expect(before).toBe(after);
  });

  it("omits an unresolved link rather than blanking the column (INV-09-24)", () => {
    // The target table is not mapped yet. Writing `[]` would clear whatever an
    // organizer had linked by hand; leaving the column out lets a later mapping
    // fill it in.
    const withoutTarget = projectForPush("session", row, fieldMap, { includePii: false });
    expect(withoutTarget).not.toHaveProperty("speakers");

    const withTarget = projectForPush("session", row, fieldMap, {
      includePii: false,
      links: { speakers: ["recA"] },
    });
    expect(withTarget.speakers).toEqual(["recA"]);
  });
});

describe("relationships and files are never accepted back", () => {
  it("refuses a link mapped two-way, naming INV-09-24", () => {
    expect(invariantOf(() => validateFieldMap("session", [map("speakers", "both")], false))).toBe("INV-09-24");
  });

  it("refuses an attachment mapped two-way", () => {
    expect(invariantOf(() => validateFieldMap("speaker_profile", [map("headshot", "both")], false))).toBe("INV-09-17");
  });

  it("still pushes both, so the grid is worth opening", () => {
    const pushable = pushableFields("speaker_profile").map((f) => f.field);
    expect(pushable).toContain("headshot");
    expect(pushableFields("session").map((f) => f.field)).toContain("speakers");
  });
});

describe("named options come back as names", () => {
  const fieldMap = [map("track", "both"), map("title", "both")];

  it("hands the name to the caller to resolve, and keeps it out of the patch", () => {
    const result = projectInbound("session", { track: "Platform Engineering", title: "A talk" }, fieldMap, {
      includePii: false,
    });
    // Resolving a name needs the event's tracks, which is a query — so it is
    // carried out separately rather than guessed at here.
    expect(result.patch).toEqual({ title: "A talk" });
    expect(result.options.track).toEqual({ optionsFrom: "track", name: "Platform Engineering" });
  });

  it("treats a cleared dropdown as a null, not as a missing field", () => {
    const result = projectInbound("session", { track: "", title: "A talk" }, fieldMap, { includePii: false });
    expect(result.options.track.name).toBeNull();
    expect(result.absent).not.toContain("track");
  });
});
