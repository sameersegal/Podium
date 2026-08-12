import { env as testEnv } from "cloudflare:test";
import { AppContext, type Env } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { beforeAll, describe, expect, it } from "vitest";
import { activationCheck, publishCfp, activateEvent } from "@podiumstack/web/contexts/event-config/service.js";
import { cloneEventConfiguration, provisionEvent } from "@podiumstack/web/contexts/event-config/provisioning.js";
import { loadPublishedForm } from "@podiumstack/web/contexts/event-config/views.js";

/**
 * 02 — "Starting an event: the starter blueprint and cloning".
 *
 * Two things are being checked, and they are the two the model promises.
 * First, that a blueprinted event is *finished enough to use*: INV-02-11
 * satisfied, a call whose form is published (INV-02-5), a rubric and a
 * checklist. Second, that a clone copies configuration and only configuration
 * (INV-02-14), with its dates rebased (INV-02-16) and its options pointing at
 * its own tracks and formats (INV-02-17).
 */

const env = testEnv as unknown as Env & typeof testEnv;

const ORG = "org_prov";
const PERSON = "per_prov_admin";

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

function app(eventId?: string): AppContext {
  return new AppContext({ env, orgId: ORG, eventId: eventId ?? null, actor: SYSTEM_ACTOR });
}

async function all(sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await env.DB.prepare(sql).bind(...params).all<Row>();
  return res.results ?? [];
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Provisioning Org", "provisioning-org", "America/Los_Angeles", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [PERSON, ORG, "prov-admin@example.com", "Pat Provisioner", "active", 0, now, now],
  );
});

describe("the starter blueprint", () => {
  let eventId = "";

  beforeAll(async () => {
    const ctx = app();
    const { event, summary } = await provisionEvent(ctx, {
      name: "Blueprint Conf 2027",
      timezone: "America/Los_Angeles",
      starts_on: "2027-11-01",
      ends_on: "2027-11-03",
      mode: "in_person",
    });
    await ctx.flush();
    eventId = str(event.id);
    expect(summary.source).toBe("starter");
  });

  /** INV-02-11 — this is the whole point: no list of what is still missing. */
  it("INV-02-11 — leaves the event ready to activate", async () => {
    const check = await activationCheck(app(eventId), eventId);
    expect(check.blockers).toEqual([]);
    expect(check.ready).toBe(true);
    expect(check.day_count).toBe(3);
  });

  it("writes one day per date of the event's own range", async () => {
    const days = await all("SELECT date, label FROM event_day WHERE event_id = ? ORDER BY sort_order", [eventId]);
    expect(days.map((d) => str(d.date))).toEqual(["2027-11-01", "2027-11-02", "2027-11-03"]);
    expect(str(days[0].label)).toBe("Day 1");
  });

  it("creates one track to rename, not five to delete", async () => {
    const tracks = await all("SELECT name FROM track WHERE event_id = ?", [eventId]);
    expect(tracks.map((t) => str(t.name))).toEqual(["General"]);
  });

  it("creates a venue with rooms, since INV-02-11 asks for a room off-line events do not need", async () => {
    const rooms = await all("SELECT name FROM room WHERE event_id = ? ORDER BY sort_order", [eventId]);
    expect(rooms.length).toBeGreaterThan(0);
    expect(str(rooms[0].name)).toBe("Main Stage");
  });

  /** INV-02-5 — a call cannot open without a published form; the blueprint publishes it. */
  it("INV-02-5 — leaves the call's form published, so the call is one click from open", async () => {
    const ctx = app(eventId);
    const cfps = await all("SELECT id FROM call_for_proposals WHERE event_id = ?", [eventId]);
    expect(cfps).toHaveLength(1);
    const published = await loadPublishedForm(ctx, str(cfps[0].id));
    expect(published?.version).toBe(1);
    expect(published?.status).toBe("published");

    // And it really does open, rather than merely looking finished.
    await activateEvent(ctx, eventId);
    const cfp = await publishCfp(ctx, str(cfps[0].id));
    await ctx.flush();
    expect(str(cfp.published_at)).not.toBe("");
  });

  it("ships the review scorecard and the speaker checklist", async () => {
    const rubrics = await all("SELECT name FROM rubric WHERE event_id = ? ORDER BY name", [eventId]);
    expect(rubrics.map((r) => str(r.name))).toContain("Programme scorecard");
    const tasks = await all("SELECT status FROM task_definition WHERE event_id = ?", [eventId]);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => str(t.status) === "active")).toBe(true);
  });

  /**
   * 02 — a `NotificationTemplate` row is an override; every key already
   * resolves to a shipped default, so seeding one per key would replace
   * working defaults with copies that stop tracking them.
   */
  it("writes no message templates, because every key already has a shipped default", async () => {
    const templates = await all("SELECT id FROM notification_template WHERE event_id = ?", [eventId]);
    expect(templates).toEqual([]);
  });

  it("writes no sponsorship tiers, because a tier is a commercial term", async () => {
    const tiers = await all("SELECT id FROM sponsorship_tier WHERE event_id = ?", [eventId]);
    expect(tiers).toEqual([]);
  });

  it("leaves an online event without a venue it would never correct", async () => {
    const ctx = app();
    const { event } = await provisionEvent(ctx, {
      name: "Blueprint Online 2027",
      timezone: "UTC",
      starts_on: "2027-06-01",
      ends_on: "2027-06-01",
      mode: "online",
    });
    await ctx.flush();
    const venues = await all("SELECT id FROM venue WHERE event_id = ?", [str(event.id)]);
    expect(venues).toEqual([]);
    const check = await activationCheck(app(str(event.id)), str(event.id));
    expect(check.blockers).toEqual([]);
  });

  it("creates nothing but the event when asked for an empty one", async () => {
    const ctx = app();
    const { event, summary } = await provisionEvent(ctx, {
      name: "Empty Conf 2027",
      timezone: "UTC",
      starts_on: "2027-07-01",
      ends_on: "2027-07-02",
      source: "empty",
    });
    await ctx.flush();
    expect(summary.counts).toEqual({});
    expect(await all("SELECT id FROM event_day WHERE event_id = ?", [str(event.id)])).toEqual([]);
    expect(await all("SELECT id FROM track WHERE event_id = ?", [str(event.id)])).toEqual([]);
  });
});

describe("cloning an edition", () => {
  let sourceId = "";
  let cloneId = "";

  beforeAll(async () => {
    const ctx = app();
    const { event } = await provisionEvent(ctx, {
      name: "Clone Source 2027",
      timezone: "America/Los_Angeles",
      starts_on: "2027-05-12",
      ends_on: "2027-05-14",
      mode: "in_person",
      visibility: "public",
    });
    await ctx.flush();
    sourceId = str(event.id);

    // Make the source look lived-in: a second track that a CFP declines to
    // offer, an event-scoped message template, a sponsorship tier, and a
    // proposal — the thing a clone must not copy (INV-02-14).
    const seed = app(sourceId);
    await run(
      "INSERT INTO track (id, event_id, name, slug, sort_order, is_public) VALUES (?,?,?,?,?,?)",
      ["trk_prov_extra", sourceId, "Retired Lane", "retired-lane", 1, 0],
    );
    const now = new Date().toISOString();
    await run(
      `INSERT INTO notification_template (id, org_id, event_id, key, channel, subject, body_markdown, locale, is_active, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["ntp_prov", ORG, sourceId, "proposal.submitted", "email", "Got it", "Hi {{recipient.first_name}}, we have it.", "en", 1, 1, now, now],
    );
    await run("INSERT INTO sponsorship_tier (id, event_id, name, slug, level, is_public, sort_order) VALUES (?,?,?,?,?,?,?)", [
      "tir_prov",
      sourceId,
      "Gold",
      "gold",
      3,
      1,
      0,
    ]);
    const cfp = (await all("SELECT id, active_form_id FROM call_for_proposals WHERE event_id = ?", [sourceId]))[0];
    await run(
      `INSERT INTO proposal (id, org_id, event_id, cfp_id, form_id, reference, origin, status, title, abstract, submitter_person_id, last_activity_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["prp_prov", ORG, sourceId, str(cfp.id), str(cfp.active_form_id), "CS-1", "cfp", "submitted", "A talk", "About things", PERSON, now, now, now],
    );
    await seed.flush();

    const target = app();
    const created = await provisionEvent(target, {
      name: "Clone Target 2028",
      timezone: "America/Los_Angeles",
      starts_on: "2028-05-10",
      ends_on: "2028-05-12",
      mode: "in_person",
      source: "clone",
      clone_from_event_id: sourceId,
    });
    await target.flush();
    cloneId = str(created.event.id);
    expect(created.summary.day_shift).toBe(364);
  });

  it("copies the configuration surface", async () => {
    const count = async (table: string) =>
      (await all(`SELECT id FROM ${table} WHERE event_id = ?`, [cloneId])).length;
    expect(await count("track")).toBe(2);
    expect(await count("session_format")).toBe(5);
    expect(await count("room")).toBe(3);
    expect(await count("call_for_proposals")).toBe(1);
    expect(await count("rubric")).toBe(2);
    expect(await count("sponsorship_tier")).toBe(1);
    expect((await all("SELECT id FROM notification_template WHERE event_id = ?", [cloneId])).length).toBe(1);
    expect(await count("task_definition")).toBeGreaterThan(0);
  });

  /** INV-02-14 — a copied record would be a fabricated fact about a real person. */
  it("INV-02-14 — copies no proposal, session, review or participant", async () => {
    for (const table of ["proposal", "session", "event_participant", "task_instance", "placement", "schedule_publication"]) {
      expect(await all(`SELECT id FROM ${table} WHERE event_id = ?`, [cloneId])).toEqual([]);
    }
    // `review` and `decision` hang off a proposal rather than an event, so
    // they are checked the way they are reached.
    for (const table of ["review", "decision"]) {
      expect(
        await all(`SELECT id FROM ${table} WHERE proposal_id IN (SELECT id FROM proposal WHERE event_id = ?)`, [cloneId]),
      ).toEqual([]);
    }
    // …and leaves the source's own record alone.
    expect(await all("SELECT id FROM proposal WHERE event_id = ?", [sourceId])).toHaveLength(1);
  });

  /** INV-02-15 — the clone lands draft and private, unpublished, with provenance. */
  it("INV-02-15 — lands draft, private and unpublished, whatever the source was", async () => {
    const [clone] = await all("SELECT status, visibility, slug, cloned_from_event_id FROM event WHERE id = ?", [cloneId]);
    expect(str(clone.status)).toBe("draft");
    expect(str(clone.visibility)).toBe("private");
    expect(str(clone.cloned_from_event_id)).toBe(sourceId);
    const [source] = await all("SELECT visibility, slug FROM event WHERE id = ?", [sourceId]);
    expect(str(source.visibility)).toBe("public");
    expect(str(clone.slug)).not.toBe(str(source.slug));

    const cfps = await all("SELECT published_at FROM call_for_proposals WHERE event_id = ?", [cloneId]);
    expect(cfps.every((c) => c.published_at === null)).toBe(true);
  });

  /** INV-02-16 — the window moves with the event, not with the calendar. */
  it("INV-02-16 — rebases the call's window by the day shift, keeping wall-clock time", async () => {
    const [source] = await all("SELECT opens_at, closes_at FROM call_for_proposals WHERE event_id = ?", [sourceId]);
    const [clone] = await all("SELECT opens_at, closes_at FROM call_for_proposals WHERE event_id = ?", [cloneId]);
    // 364 days later, and still 23:59 in Los Angeles.
    const shiftDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    expect(shiftDays(str(source.closes_at), str(clone.closes_at))).toBe(364);
    expect(str(clone.closes_at) > str(clone.opens_at)).toBe(true);
  });

  /** INV-02-17 — an option pointing across events is a configuration leak. */
  it("INV-02-17 — points every copied option at the clone's own track and format", async () => {
    const cloneTrackIds = new Set((await all("SELECT id FROM track WHERE event_id = ?", [cloneId])).map((t) => str(t.id)));
    const [cfp] = await all("SELECT id FROM call_for_proposals WHERE event_id = ?", [cloneId]);
    const options = await all("SELECT track_id, is_available FROM cfp_track_option WHERE cfp_id = ?", [str(cfp.id)]);
    expect(options.length).toBe(2);
    for (const o of options) expect(cloneTrackIds.has(str(o.track_id))).toBe(true);

    const formatIds = new Set((await all("SELECT id FROM session_format WHERE event_id = ?", [cloneId])).map((f) => str(f.id)));
    const formatOptions = await all("SELECT session_format_id FROM cfp_format_option WHERE cfp_id = ?", [str(cfp.id)]);
    for (const o of formatOptions) expect(formatIds.has(str(o.session_format_id))).toBe(true);
  });

  it("copies the call's form as version 1, published", async () => {
    const ctx = app(cloneId);
    const [cfp] = await all("SELECT id FROM call_for_proposals WHERE event_id = ?", [cloneId]);
    const forms = await all("SELECT version, status FROM submission_form WHERE cfp_id = ?", [str(cfp.id)]);
    expect(forms).toHaveLength(1); // no throwaway default version to retire
    const published = await loadPublishedForm(ctx, str(cfp.id));
    expect(published?.version).toBe(1);
    const keys = published?.steps.flatMap((s) => s.fields.map((f) => f.key)) ?? [];
    expect(keys).toContain("title");
    expect(keys).toContain("track");
  });

  it("leaves the clone ready to activate", async () => {
    const check = await activationCheck(app(cloneId), cloneId);
    expect(check.blockers).toEqual([]);
  });

  it("emits event.cloned with what it copied", async () => {
    const [ev] = await all("SELECT data FROM domain_event_record WHERE type = 'event.cloned' AND event_id = ?", [cloneId]);
    const data = JSON.parse(str(ev.data)) as { source_event_id: string; day_shift: number; copied: Record<string, number> };
    expect(data.source_event_id).toBe(sourceId);
    expect(data.day_shift).toBe(364);
    expect(data.copied.track).toBe(2);
    expect(data.copied.session_format).toBe(5);
  });

  it("INV-02-15 — lands private even when the caller asks for public", async () => {
    const ctx = app();
    const { event } = await provisionEvent(ctx, {
      name: "Insistently Public 2029",
      timezone: "America/Los_Angeles",
      starts_on: "2029-05-08",
      ends_on: "2029-05-10",
      visibility: "public",
      source: "clone",
      clone_from_event_id: sourceId,
    });
    await ctx.flush();
    const [row] = await all("SELECT visibility FROM event WHERE id = ?", [str(event.id)]);
    expect(str(row.visibility)).toBe("private");
  });

  it("refuses to clone an event onto itself", async () => {
    await expect(cloneEventConfiguration(app(cloneId), cloneId, cloneId)).rejects.toThrow(/cannot be cloned onto itself/);
  });

  it("refuses a clone with no source, rather than quietly creating an empty event", async () => {
    const ctx = app();
    const failure = await provisionEvent(ctx, {
      name: "No Source 2028",
      timezone: "UTC",
      starts_on: "2028-01-01",
      ends_on: "2028-01-02",
      source: "clone",
    }).catch((err: unknown) => err as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Choose the event to copy/);
    // Refused before anything was written, not half-created.
    expect(await all("SELECT id FROM event WHERE name = ?", ["No Source 2028"])).toEqual([]);
  });
});
