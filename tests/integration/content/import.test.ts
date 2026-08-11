import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumconf/data/context.js";
import { SYSTEM_ACTOR } from "@podiumconf/domain/events/envelope.js";
import { createImport, previewImport, runImport } from "@podiumconf/web/contexts/content/import.js";

/**
 * INV-11-13 — a `BulkImport` writes nothing before the operator confirms its
 * preview, and reports failures per row.
 */

const ORG = "org_import_test";
const now = () => new Date().toISOString();

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Import Test Org", "import-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("per_import_operator", ORG, "operator@example.com", "Ivy Operator", "active", 0, now(), now())
    .run();
}

const CSV = `name,email,title,company,bio
Ada Lovelace,ada-import@example.com,Engineer,Analytical Engines,Pioneer of computing.
Grace Hopper,not-an-email,Rear Admiral,Navy,Compiler pioneer.
Alan Turing,alan-import@example.com,Mathematician,Bletchley,Codebreaker.
`;

function appFor() {
  return new AppContext({ env, orgId: ORG, actor: { type: "person", id: "per_import_operator", display_name: "Ivy Operator" } });
}

async function personCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM person WHERE org_id = ?").bind(ORG).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("INV-11-13: an import previews before writing", () => {
  beforeAll(seed);

  it("preview writes only to bulk_import_row, never to the target person table", async () => {
    const app = appFor();
    const before = await personCount();

    const imp = await createImport(app, { subject: "person", csvText: CSV });
    await app.flush();
    expect(imp.status).toBe("mapping");

    // Nothing written to `person` yet, even though the row was uploaded and mapped.
    expect(await personCount()).toBe(before);

    const preview = await previewImport(app, String(imp.id));
    await app.flush();

    expect(preview.summary.row_count).toBe(3);
    expect(preview.summary.create_count).toBe(2);
    expect(preview.summary.error_count).toBe(1); // Grace Hopper's malformed email
    const errorRow = preview.rows.find((r) => r.outcome === "error");
    expect(errorRow?.column).toBe("email");

    // Still nothing written to `person` — preview is read-only (INV-11-13).
    expect(await personCount()).toBe(before);

    const afterPreview = await env.DB.prepare("SELECT status FROM bulk_import WHERE id = ?").bind(imp.id).first<{ status: string }>();
    expect(afterPreview?.status).toBe("previewing");
  });

  it("run then writes exactly the previewed rows, per row — one bad row does not block the rest", async () => {
    const app = appFor();
    const before = await personCount();
    const imp = await createImport(app, { subject: "person", csvText: CSV });
    await app.flush();
    await previewImport(app, String(imp.id));
    await app.flush();

    const result = await runImport(app, String(imp.id));
    await app.flush();

    expect(result.created_count).toBe(2);
    expect(result.error_count).toBe(1);
    expect(await personCount()).toBe(before + 2);

    const ada = await env.DB.prepare("SELECT * FROM person WHERE email = ?").bind("ada-import@example.com").first<Record<string, unknown>>();
    expect(ada).toBeTruthy();
    expect(ada?.full_name).toBe("Ada Lovelace");

    // A speaker profile came along with the person, per the import's field mapping.
    const profile = await env.DB.prepare("SELECT * FROM speaker_profile WHERE person_id = ?").bind(ada?.id).first<Record<string, unknown>>();
    expect(profile?.company).toBe("Analytical Engines");

    const finalStatus = await env.DB.prepare("SELECT status FROM bulk_import WHERE id = ?").bind(imp.id).first<{ status: string }>();
    expect(finalStatus?.status).toBe("completed_with_errors");
  });

  it("running before previewing is refused (INV-11-13)", async () => {
    const app = appFor();
    const imp = await createImport(app, { subject: "person", csvText: CSV });
    await app.flush();
    await expect(runImport(app, String(imp.id))).rejects.toMatchObject({ invariant: "INV-11-13" });
  });
});
