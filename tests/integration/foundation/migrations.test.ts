import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * implementer.md, C: "Migrations applied from scratch, and applied over a
 * database holding representative rows."
 */
describe("migrations", () => {
  it("applies from scratch and creates a table per entity anchor", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const tables = new Set(results.map((r: { name: string }) => r.name));
    for (const expected of [
      "organization",
      "person",
      "event",
      "call_for_proposals",
      "submission_form",
      "form_field",
      "proposal",
      "review",
      "decision",
      "session",
      "task_instance",
      "placement",
      "schedule_publication",
      "domain_event_record",
      "audit_log",
      "asset",
      "contact_segment",
    ]) {
      expect(tables.has(expected), `missing table ${expected}`).toBe(true);
    }
  });

  it("INV-11-1 (amended, R9): entities carry no org_id — one Organization per deployment", async () => {
    // The inverse of what this test asserted until migration 0011. INV-01-16
    // allows exactly one Organization, so `WHERE org_id = ?` compared a column
    // to the only value it held; keeping it read as tenant-safety the code did
    // not have. Isolation is now a property of deployment, not of a predicate.
    for (const table of ["person", "proposal", "session", "task_instance", "asset", "audit_log", "event", "sponsor", "role_grant"]) {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(results.some((c: { name: string }) => c.name === "org_id"), `${table} still carries org_id`).toBe(false);
    }
  });

  it("the domain event envelope keeps its org_id, because webhook consumers receive it", async () => {
    // Deliberately the one survivor (R9): `DomainEvent.org_id` is a published
    // field (10-domain-events.md), so dropping it would be a major version of
    // every event type in the catalogue.
    const { results } = await env.DB.prepare("PRAGMA table_info(domain_event_record)").all<{ name: string }>();
    expect(results.some((c: { name: string }) => c.name === "org_id")).toBe(true);
  });

  it("R8: derived fields get no column — Entitlement stores no consumed_count", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(entitlement)").all<{ name: string }>();
    const columns = results.map((c: { name: string }) => c.name);
    expect(columns).not.toContain("consumed_count");
    expect(columns).not.toContain("remaining");
  });

  it("INV-07-3: is_overdue is never persisted as a task status column", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(task_instance)").all<{ name: string }>();
    expect(results.map((c: { name: string }) => c.name)).not.toContain("is_overdue");
  });

  it("applies over a database already holding representative rows", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind("org_test1", "Test Org", "test-org", "UTC", "a@b.example", "{}", now, now)
      .run();
    const row = await env.DB.prepare("SELECT slug FROM organization WHERE id = ?").bind("org_test1").first<{ slug: string }>();
    expect(row?.slug).toBe("test-org");
  });
});
