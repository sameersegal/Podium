import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AppContext } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import { editExternally, externalRecords, insertExternally, resetExternalTables, type SyncPlugin } from "@podiumstack/plugins/registry.js";
import { resolvePluginForIntegration } from "@podiumstack/web/contexts/platform/service.js";
import {
  backfillMapping,
  createMapping,
  getMapping,
  resolveConflict,
  runPull,
  runPush,
  scaffoldMapping,
} from "@podiumstack/web/contexts/platform/sync.js";
import { erasePersonEverywhere } from "@podiumstack/web/contexts/platform/sync.js";

/**
 * The two-way sync, end to end against real D1 — 09, "Two-way sync"; R31.
 *
 * The interesting behaviour here is a *loop*, and a loop cannot be tested one
 * call at a time. `sync.memory` is a real implementation of the contract with
 * an in-memory store, so a test can push, edit a cell the way a human would,
 * pull, and watch what the rules do — including the case where they are
 * supposed to do nothing at all.
 */

const ORG = "org_sync_test";
const EVENT = "evt_sync_test";
const ACTOR = "per_sync_admin";
const INTEGRATION = "itg_sync_memory";
const TABLE = "Sessions";

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

function ctx(): AppContext {
  return new AppContext({
    env,
    orgId: ORG,
    eventId: EVENT,
    actor: { type: "person", id: ACTOR, display_name: "Sync Admin" },
  });
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Sync Test Org", "sync-test-org", "UTC", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [ACTOR, "sync-admin@example.com", "Sync Admin", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, status, timezone, starts_on, ends_on, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [EVENT, "Sync Test Event", "sync-test-event", "active", "UTC", "2026-06-01", "2026-06-02", now, now],
  );
  await run("INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes) VALUES (?,?,?,?,?)", [
    "fmt_sync",
    EVENT,
    "Talk",
    "talk",
    30,
  ]);
  await run(
    "INSERT OR IGNORE INTO integration (id, plugin_key, capability, display_name, config, secret_ref, is_default_for_capability, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [INTEGRATION, "sync.memory", "sync", "Test table", "{}", "", 1, "active", now],
  );
}

async function makeSession(id: string, title: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT OR IGNORE INTO session
       (id, event_id, reference, origin, title, abstract, session_format_id, duration_minutes, keywords, status, content_status, visibility, recording_consent, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, EVENT, `ST-${id.slice(-4)}`, "cfp", title, "An abstract.", "fmt_sync", 30, '["ai"]', "confirmed", "draft", "public", "unanswered", now, now],
  );
}

/** A mapping over sessions with `title` two-way, which is the interesting shape. */
async function makeMapping(app: AppContext): Promise<Row> {
  return createMapping(app, {
    integration_id: INTEGRATION,
    subject: "session",
    external_table_id: TABLE,
    external_table_name: TABLE,
    include_pii: false,
    event_id: EVENT,
    field_map: [
      { field: "title", external_field: "Title", direction: "both" },
      { field: "keywords", external_field: "Keywords", direction: "both" },
      { field: "status", external_field: "Status", direction: "push" },
      { field: "speakers", external_field: "Speakers", direction: "push" },
      { field: "track", external_field: "Track", direction: "both" },
    ],
  });
}

async function linkFor(sessionId: string): Promise<Row> {
  const row = await env.DB.prepare("SELECT * FROM external_record_link WHERE subject_id = ?").bind(sessionId).first<Row>();
  if (!row) throw new Error(`no link for ${sessionId}`);
  return row;
}

/** What the provider now says the table has, after a scaffold. */
async function describeExternal(app: AppContext, mappingId: string): Promise<{ external_field: string; type: string }[]> {
  const mapping = await getMapping(app, mappingId);
  const integration = await app.db.byId<Row>("integration", str(mapping.integration_id));
  const resolved = await resolvePluginForIntegration(app, integration!);
  const table = await (resolved!.plugin as SyncPlugin).describe_table(str(mapping.external_table_id), resolved!.ctx);
  return table.fields.map((f) => ({ external_field: f.external_field, type: f.type }));
}

async function eventsOfType(type: string): Promise<Row[]> {
  const res = await env.DB.prepare("SELECT * FROM domain_event_record WHERE type = ?").bind( type).all<Row>();
  return res.results ?? [];
}

beforeEach(async () => {
  resetExternalTables();
  await run("DELETE FROM external_record_link", []);
  await run("DELETE FROM sync_run", []);
  await run("DELETE FROM sync_mapping", []);
  await run("DELETE FROM domain_event_record", []);
  await run("DELETE FROM audit_log", []);
  // Children before parents: `session_revision` and `session_speaker` both
  // reference `session`, and the schema means it.
  await run("DELETE FROM session_revision WHERE session_id IN (SELECT id FROM session)", []);
  await run("DELETE FROM session_speaker WHERE session_id IN (SELECT id FROM session)", []);
  await run("DELETE FROM session", []);
  await seed();
});

describe("push", () => {
  it("creates the external record and remembers the version it was pushed at", async () => {
    await makeSession("ses_push_1", "Agents in production");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    const counts = await runPush(app, mapping, "manual");
    await app.flush();

    expect(counts.pushed).toBe(1);
    const rows = externalRecords(INTEGRATION, TABLE);
    expect(rows).toHaveLength(1);
    expect(rows[0].fields.Title).toBe("Agents in production");
    // INV-09-24: the Speakers table is not mapped, so the relationship column is
    // left out rather than written as an empty list — which would clear links an
    // organizer had made by hand.
    expect(rows[0].fields).not.toHaveProperty("Speakers");

    const link = await linkFor("ses_push_1");
    expect(str(link.status)).toBe("in_sync");
    expect(link.last_pushed_hash).toBeTruthy();
    expect(Number(link.last_pushed_version)).toBe(1);
    expect(await eventsOfType("sync_link.created")).toHaveLength(1);
  });

  it("batches past the provider's limit rather than sending one call per record", async () => {
    // `sync.memory` caps at 3 on purpose, so five records exercise the split.
    for (let i = 0; i < 5; i++) await makeSession(`ses_batch_${i}`, `Talk ${i}`);
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    const counts = await runPush(app, mapping, "manual");
    await app.flush();

    expect(counts.pushed).toBe(5);
    expect(externalRecords(INTEGRATION, TABLE)).toHaveLength(5);
  });
});

describe("echo suppression (INV-09-19)", () => {
  it("pulls back what it just pushed and writes nothing", async () => {
    await makeSession("ses_echo", "Agents in production");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const before = await env.DB.prepare("SELECT row_version, updated_at FROM session WHERE id = ?").bind("ses_echo").first<Row>();

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    // The whole design terminates here: without this the pull would write, the
    // write would raise an event, the event would schedule a push, forever.
    expect(counts.echoed).toBe(1);
    expect(counts.pulled).toBe(0);
    expect(counts.conflicted).toBe(0);

    const after = await env.DB.prepare("SELECT row_version, updated_at FROM session WHERE id = ?").bind("ses_echo").first<Row>();
    expect(after).toEqual(before);
    expect(str((await linkFor("ses_echo")).status)).toBe("in_sync");
  });
});

describe("write-back", () => {
  it("applies an external edit through the session service and re-pushes", async () => {
    await makeSession("ses_write", "Original title");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const link = await linkFor("ses_write");
    editExternally(INTEGRATION, TABLE, str(link.external_id), { Title: "Edited in the table" });

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    expect(counts.pulled).toBe(1);
    const session = await env.DB.prepare("SELECT title FROM session WHERE id = ?").bind("ses_write").first<Row>();
    expect(str(session!.title)).toBe("Edited in the table");

    // INV-09-20: through the service, so the revision and the audit row exist.
    const revisions = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_revision WHERE session_id = ?")
      .bind("ses_write")
      .first<{ n: number }>();
    expect(Number(revisions?.n ?? 0)).toBeGreaterThan(0);
    expect(await eventsOfType("session.updated")).toHaveLength(1);

    // Left dirty on purpose: the service may have normalised the value, so
    // Podium re-pushes what it actually stored rather than what was proposed.
    expect(str((await linkFor("ses_write")).status)).toBe("pending_push");
    expect((await linkFor("ses_write")).last_pulled_hash).toBeTruthy();
  });

  it("ignores a column that is pushed but not accepted back", async () => {
    await makeSession("ses_readonly", "Fixed");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const link = await linkFor("ses_readonly");
    editExternally(INTEGRATION, TABLE, str(link.external_id), { Status: "cancelled", Speakers: ["recFake"] });

    const puller = ctx();
    await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    // `status` is push-only and `speaker_names` is derived. Neither is written,
    // and a cancelled session has consequences a spreadsheet cannot mean.
    const session = await env.DB.prepare("SELECT status FROM session WHERE id = ?").bind("ses_readonly").first<Row>();
    expect(str(session!.status)).toBe("confirmed");
  });

  it("does not invent a record from a row somebody typed by hand", async () => {
    await makeSession("ses_known", "Known");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    insertExternally(INTEGRATION, TABLE, { Title: "A talk somebody typed into the grid" });

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    expect(counts.skipped).toBe(1);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM session").bind().first<{ n: number }>();
    expect(Number(sessions?.n ?? 0)).toBe(1);
  });
});

describe("conflict (INV-09-18)", () => {
  it("refuses an external edit written against a value Podium has since changed", async () => {
    await makeSession("ses_conflict", "Original");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const link = await linkFor("ses_conflict");
    editExternally(INTEGRATION, TABLE, str(link.external_id), { Title: "Their title" });
    // Meanwhile, here. This is the edit that must not be lost.
    await run("UPDATE session SET title = ?, row_version = row_version + 1 WHERE id = ?", ["Our title", "ses_conflict"]);

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    expect(counts.conflicted).toBe(1);
    expect(counts.pulled).toBe(0);

    const session = await env.DB.prepare("SELECT title FROM session WHERE id = ?").bind("ses_conflict").first<Row>();
    expect(str(session!.title)).toBe("Our title");

    const after = await linkFor("ses_conflict");
    expect(str(after.status)).toBe("conflict");
    // Refused, not discarded: the organizer is shown what lost.
    expect(JSON.parse(str(after.conflict_payload)).rejected.title).toBe("Their title");
    expect(await eventsOfType("sync_link.conflicted")).toHaveLength(1);
  });

  it("resolving in Podium's favour queues a re-push and leaves the record alone", async () => {
    await makeSession("ses_resolve", "Original");
    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const link = await linkFor("ses_resolve");
    editExternally(INTEGRATION, TABLE, str(link.external_id), { Title: "Theirs" });
    await run("UPDATE session SET title = ?, row_version = row_version + 1 WHERE id = ?", ["Ours", "ses_resolve"]);

    const puller = ctx();
    await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    const resolver = ctx();
    await resolveConflict(resolver, str((await linkFor("ses_resolve")).id), "keep_podium");
    await resolver.flush();

    expect(str((await linkFor("ses_resolve")).status)).toBe("pending_push");

    const pusher = ctx();
    await runPush(pusher, await getMapping(pusher, str(mapping.id)), "manual");
    await pusher.flush();

    // The table now agrees with Podium rather than sitting on a lie.
    expect(externalRecords(INTEGRATION, TABLE)[0].fields.Title).toBe("Ours");
    expect(await eventsOfType("sync_link.resolved")).toHaveLength(1);
  });
});

describe("erasure (INV-09-22)", () => {
  it("removes the person's external records, including from a paused mapping", async () => {
    const now = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ["per_erase_me", "erase@example.com", "Erase Me", "active", 0, now, now],
    );

    const app = ctx();
    const mapping = await createMapping(app, {
      integration_id: INTEGRATION,
      subject: "person",
      external_table_id: "People",
      external_table_name: "People",
      include_pii: false,
      field_map: [{ field: "full_name", external_field: "Name", direction: "push" }],
    });
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    expect(externalRecords(INTEGRATION, "People").length).toBeGreaterThan(0);

    // Paused, not deleted — and a paused mapping still holds the data.
    await run("UPDATE sync_mapping SET is_active = 0 WHERE id = ?", [str(mapping.id)]);

    const eraser = ctx();
    const result = await erasePersonEverywhere(eraser, "per_erase_me");
    await eraser.flush();

    expect(result.failed).toBe(0);
    expect(result.deleted).toBeGreaterThan(0);
    expect(externalRecords(INTEGRATION, "People").some((r) => r.fields.Name === "Erase Me")).toBe(false);

    const link = await env.DB.prepare("SELECT * FROM external_record_link WHERE subject_id = ?").bind("per_erase_me").first<Row>();
    expect(str(link!.status)).toBe("unlinked");
    expect(link!.external_id).toBeNull();
  });
});

describe("push-only subjects (INV-09-23)", () => {
  it("refuses a mapping that would let a decision be written from a table", async () => {
    const app = ctx();
    await expect(
      createMapping(app, {
        integration_id: INTEGRATION,
        subject: "decision",
        external_table_id: "Decisions",
        field_map: [{ field: "outcome", external_field: "Outcome", direction: "both" }],
        event_id: EVENT,
      }),
    ).rejects.toMatchObject({ invariant: "INV-09-23" });
  });

  it("reads nothing back for a push-only mapping", async () => {
    const app = ctx();
    const mapping = await createMapping(app, {
      integration_id: INTEGRATION,
      subject: "decision",
      external_table_id: "Decisions",
      field_map: [{ field: "outcome", external_field: "Outcome", direction: "push" }],
      event_id: EVENT,
    });
    await app.flush();

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();
    expect(counts).toMatchObject({ pulled: 0, conflicted: 0, echoed: 0 });
  });
});

describe("relationships (INV-09-24)", () => {
  async function makeSpeaker(personId: string, profileId: string, name: string, sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [personId, `${personId}@example.com`, name, "active", 0, now, now],
    );
    await run("INSERT OR IGNORE INTO speaker_profile (id, person_id, bio, visibility, is_listed, updated_at) VALUES (?,?,?,?,?,?)", [
      profileId,
      personId,
      "A bio.",
      "{}",
      1,
      now,
    ]);
    await run(
      "INSERT OR IGNORE INTO session_speaker (id, session_id, person_id, speaker_role, sort_order, confirmation_status, added_at) VALUES (?,?,?,?,?,?,?)",
      [`ssp_${profileId}`, sessionId, personId, "primary", 0, "confirmed", now],
    );
  }

  async function speakerMapping(app: AppContext): Promise<Row> {
    return createMapping(app, {
      integration_id: INTEGRATION,
      subject: "speaker_profile",
      external_table_id: "Speakers",
      external_table_name: "Speakers",
      include_pii: false,
      field_map: [
        { field: "full_name", external_field: "Name", direction: "both" },
        { field: "bio", external_field: "Bio", direction: "both" },
      ],
    });
  }

  it("pushes speakers as links to the Speakers table once it is mapped", async () => {
    await makeSession("ses_linked", "A linked talk");
    await makeSpeaker("per_link_a", "spk_link_a", "Ada Speaker", "ses_linked");
    await makeSpeaker("per_link_b", "spk_link_b", "Bea Speaker", "ses_linked");

    // The Speakers table has to exist and be pushed first: a record id means
    // nothing until the record on the other end is there.
    const app = ctx();
    const speakers = await speakerMapping(app);
    await backfillMapping(app, speakers);
    await runPush(app, speakers, "manual");
    await app.flush();

    const sessions = ctx();
    const mapping = await makeMapping(sessions);
    await backfillMapping(sessions, mapping);
    await runPush(sessions, mapping, "manual");
    await sessions.flush();

    const record = externalRecords(INTEGRATION, TABLE).find((r) => r.fields.Title === "A linked talk")!;
    const speakerRows = externalRecords(INTEGRATION, "Speakers");
    const expected = ["spk_link_a", "spk_link_b"].map(
      (id) => speakerRows.find((r) => r.fields.Name === (id === "spk_link_a" ? "Ada Speaker" : "Bea Speaker"))!.external_id,
    );

    // Real record ids, in billing order — not a comma-joined string.
    expect(record.fields.Speakers).toEqual(expected);
  });

  it("leaves the relationship out of the hash, so linking is not an edit", async () => {
    await makeSession("ses_hash", "Hash me");
    await makeSpeaker("per_hash", "spk_hash", "Cy Speaker", "ses_hash");

    const app = ctx();
    const speakers = await speakerMapping(app);
    await backfillMapping(app, speakers);
    await runPush(app, speakers, "manual");
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    // A record whose only unhashable column is populated must still read as an
    // echo, or every pull would look like a change forever.
    expect(counts.conflicted).toBe(0);
    expect(counts.pulled).toBe(0);
    expect(counts.echoed).toBeGreaterThan(0);
  });
});

describe("named options", () => {
  async function makeTrack(id: string, name: string): Promise<void> {
    await run("INSERT OR IGNORE INTO track (id, event_id, name, slug, sort_order) VALUES (?,?,?,?,?)", [id, EVENT, name, id, 0]);
  }

  it("resolves a track picked by name in the table", async () => {
    await makeTrack("trk_platform", "Platform Engineering");
    await makeSession("ses_track", "Needs a track");

    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const link = await linkFor("ses_track");
    editExternally(INTEGRATION, TABLE, str(link.external_id), { Track: "Platform Engineering" });

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    expect(counts.pulled).toBe(1);
    const session = await env.DB.prepare("SELECT track_id FROM session WHERE id = ?").bind("ses_track").first<Row>();
    expect(str(session!.track_id)).toBe("trk_platform");
  });

  it("pushes the track back as its name, not its id", async () => {
    await makeTrack("trk_named", "Developer Experience");
    await makeSession("ses_named", "Already tracked");
    await run("UPDATE session SET track_id = ? WHERE id = ?", ["trk_named", "ses_named"]);

    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const record = externalRecords(INTEGRATION, TABLE).find((r) => r.fields.Title === "Already tracked")!;
    expect(record.fields.Track).toBe("Developer Experience");
  });

  it("refuses a track this event does not have, rather than clearing the field", async () => {
    await makeTrack("trk_real", "Real Track");
    await makeSession("ses_bad_track", "Mistyped");
    await run("UPDATE session SET track_id = ? WHERE id = ?", ["trk_real", "ses_bad_track"]);

    const app = ctx();
    const mapping = await makeMapping(app);
    await backfillMapping(app, mapping);
    await runPush(app, mapping, "manual");
    await app.flush();

    const link = await linkFor("ses_bad_track");
    editExternally(INTEGRATION, TABLE, str(link.external_id), { Track: "Trakc Nmae Typo" });

    const puller = ctx();
    const counts = await runPull(puller, await getMapping(puller, str(mapping.id)), "manual");
    await puller.flush();

    // Somebody typing a track that does not exist means something. Guessing is
    // wrong and silently nulling the field loses both the value and the intent.
    expect(counts.conflicted).toBe(1);
    const session = await env.DB.prepare("SELECT track_id FROM session WHERE id = ?").bind("ses_bad_track").first<Row>();
    expect(str(session!.track_id)).toBe("trk_real");

    const after = await linkFor("ses_bad_track");
    expect(str(after.status)).toBe("conflict");
    expect(str(after.last_error)).toContain("Trakc Nmae Typo");
  });
});

describe("scaffolding", () => {
  it("declares the columns the mapping needs, with the primary field first", async () => {
    const app = ctx();
    const mapping = await makeMapping(app);
    const result = await scaffoldMapping(app, mapping);
    await app.flush();

    expect(result.created).toBe(false); // the table id was given, so it extended it
    // Speakers is not mapped yet, so its link column cannot be declared.
    expect(result.skipped).toContain("Speakers");

    const declared = await describeExternal(app, str(mapping.id));
    expect(declared.map((c) => c.external_field)).toContain("Title");
    expect(declared.find((c) => c.external_field === "Track")?.type).toBe("select");
    expect(declared.find((c) => c.external_field === "Keywords")?.type).toBe("multi_select");
  });
});
