import { describe, expect, it } from "vitest";
import { autoMapColumns, dedupeValueOf, previewRows, summarise, validateRow } from "@podiumstack/domain/content/import.js";
import { parseCsv } from "@podiumstack/domain/content/csv.js";

const CSV = `name,email,title,company,bio
Ada Lovelace,ada@example.com,Engineer,Analytical Engines,Pioneer.
,missing-name@example.com,Engineer,Acme,No name here.
Grace Hopper,not-an-email,Rear Admiral,Navy,Compiler pioneer.
Ada Lovelace,ada@example.com,Engineer,Analytical Engines,Duplicate of row 1.
`;

describe("per-row import errors (INV-11-13)", () => {
  it("INV-11-13: a malformed row is rejected without aborting the rows around it", () => {
    const parsed = parseCsv(CSV);
    const mapping = autoMapColumns(parsed.headers, "person");
    const rows = previewRows(parsed.headers, parsed.rows, mapping, {
      subject: "person",
      dedupe_key: "email",
      on_duplicate: "update",
      existing: new Map(),
    });

    // Row 1 (Ada): fine, would create.
    expect(rows[0]).toMatchObject({ outcome: "create" });
    // Row 2: missing the required name — an error, not a whole-file rejection.
    expect(rows[1]).toMatchObject({ outcome: "error", column: "full_name" });
    // Row 3: a malformed email — also just that row's error.
    expect(rows[2]).toMatchObject({ outcome: "error", column: "email" });
    // Row 4: the same email as row 1, so it is a duplicate *within the file*.
    expect(rows[3].outcome).toBe("skip");

    // The good row and the bad rows coexist — nothing aborted the batch.
    const summary = summarise(rows);
    expect(summary.row_count).toBe(4);
    expect(summary.create_count).toBe(1);
    expect(summary.error_count).toBe(2);
    expect(summary.skip_count).toBe(1);
  });

  it("INV-11-13: writes nothing — previewRows is pure and returns a plan, not a mutation", () => {
    const parsed = parseCsv(CSV);
    const mapping = autoMapColumns(parsed.headers, "person");
    const before = JSON.stringify(parsed);
    previewRows(parsed.headers, parsed.rows, mapping, { subject: "person", dedupe_key: "email", on_duplicate: "update", existing: new Map() });
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("deduplication defaults to matching on email, and on_duplicate = update maps an existing match", () => {
    const parsed = parseCsv(CSV);
    const mapping = autoMapColumns(parsed.headers, "person");
    const existing = new Map([["ada@example.com", "per_ada"]]);
    const rows = previewRows(parsed.headers, parsed.rows, mapping, { subject: "person", dedupe_key: "email", on_duplicate: "update", existing });
    expect(rows[0]).toMatchObject({ outcome: "update", matched_id: "per_ada" });
  });

  it("on_duplicate = skip leaves the existing record alone instead of updating it", () => {
    const parsed = parseCsv(CSV);
    const mapping = autoMapColumns(parsed.headers, "person");
    const existing = new Map([["ada@example.com", "per_ada"]]);
    const rows = previewRows(parsed.headers, parsed.rows, mapping, { subject: "person", dedupe_key: "email", on_duplicate: "skip", existing });
    expect(rows[0].outcome).toBe("skip");
  });

  it("a required field with no value fails validation, naming the field", () => {
    expect(validateRow("person", { email: "a@b.com" })).toMatchObject({ column: "full_name" });
    expect(validateRow("person", { full_name: "A", email: "a@b.com" })).toBeNull();
  });

  it("dedupeValueOf is case- and whitespace-insensitive for email", () => {
    expect(dedupeValueOf("person", { email: "  Ada@Example.com  " }, "email")).toBe("ada@example.com");
  });

  it("auto-mapping recognises common header spellings", () => {
    const mapping = autoMapColumns(["Full name", "E-mail", "Company"], "person");
    expect(mapping["Full name"]).toBe("full_name");
    expect(mapping["E-mail"]).toBe("email");
    expect(mapping["Company"]).toBe("company");
  });
});
