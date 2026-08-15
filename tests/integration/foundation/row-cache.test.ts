import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { D1Db, enableRowCache } from "@podiumstack/data/db.js";

/**
 * The per-request identity map (`packages/data/src/db.ts`).
 *
 * It exists because profiling found the same `SELECT * FROM event WHERE id = ?`
 * prepared up to four times in one request — one per layer that needed the
 * event, each holding its own `AppContext`. Caching a row is also the easiest
 * way to serve a stale one, so the three rules that make it safe are the thing
 * worth testing, not the saving:
 *
 *   1. Primary key reads only — `byId`, never `select`/`first`/`count`.
 *   2. Any write to a table drops that table's cached rows. `rawRun` and
 *      `batch` carry SQL this layer does not parse, so they drop everything.
 *   3. Opt-in — a `D1Db` on a binding nobody enabled caches nothing.
 *
 * Rule 2 is the one with teeth: without it, read-modify-write inside a request
 * reads its own stale copy, and every `updateVersioned` in the product is a
 * read-modify-write.
 */

const ORG = "org_rowcache";
const EVENT = "evt_rowcache";

async function run(sql: string, params: unknown[] = []) {
  await env.DB.prepare(sql).bind(...params).run();
}

/** A binding that counts what reaches D1, so a cache hit is observable. */
function counting(): { db: D1Database; reads: () => number } {
  let n = 0;
  const proxy = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        n++;
        return (value as D1Database["prepare"]).call(target, sql);
      };
    },
  });
  return { db: proxy as D1Database, reads: () => n };
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Row Cache Org", "row-cache-org", "UTC", "a@b.example", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Row Cache Conf", "row-cache-conf", "UTC", "2027-06-01", "2027-06-02", "in_person", "active", "public", "{}", now, now],
  );
});

describe("the per-request identity map", () => {
  it("reads a row once however many layers ask for it", async () => {
    const { db, reads } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);

    const first = await repo.byId("event", EVENT);
    const second = await repo.byId("event", EVENT);
    const third = await repo.byId("event", EVENT);

    expect(first?.id).toBe(EVENT);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(reads()).toBe(1);
  });

  it("is off unless the request turned it on", async () => {
    const { db, reads } = counting();
    const repo = new D1Db(db, ORG);
    await repo.byId("event", EVENT);
    await repo.byId("event", EVENT);
    expect(reads()).toBe(2);
  });

  it("separates `includeDeleted` from the ordinary read (INV-11-2)", async () => {
    const { db, reads } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);
    await repo.byId("event", EVENT);
    await repo.byId("event", EVENT, { includeDeleted: true });
    // Different predicates, so a hit on one must never answer the other.
    expect(reads()).toBe(2);
  });

  it("separates orgs, so a `forOrg` view never answers with another org's row (INV-11-1)", async () => {
    const { db, reads } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);
    expect((await repo.byId("event", EVENT))?.id).toBe(EVENT);
    // The same id, read as a different org, must miss and come back empty.
    expect(await repo.forOrg("org_someone_else").byId("event", EVENT)).toBeNull();
    expect(reads()).toBe(2);
  });

  it("never serves a row an update in the same request has already changed", async () => {
    const { db } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);

    expect((await repo.byId("event", EVENT))?.name).toBe("Row Cache Conf");
    await repo.update("event", EVENT, { name: "Renamed mid-request" });
    // Rule 2. Without it this is still "Row Cache Conf", and every
    // read-modify-write in the product compares against a row it has stale.
    expect((await repo.byId("event", EVENT))?.name).toBe("Renamed mid-request");

    await repo.update("event", EVENT, { name: "Row Cache Conf" });
  });

  it("drops everything after a `rawRun`, whose SQL this layer does not parse", async () => {
    const { db } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);

    await repo.byId("event", EVENT);
    await repo.rawRun("UPDATE event SET name = ? WHERE id = ?", ["Raw rename", EVENT]);
    expect((await repo.byId("event", EVENT))?.name).toBe("Raw rename");

    await repo.rawRun("UPDATE event SET name = ? WHERE id = ?", ["Row Cache Conf", EVENT]);
  });

  it("drops everything after a `batch`, for the same reason", async () => {
    const { db } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);

    await repo.byId("event", EVENT);
    await repo.batch([{ sql: "UPDATE event SET name = ? WHERE id = ?", params: ["Batched rename", EVENT] }]);
    expect((await repo.byId("event", EVENT))?.name).toBe("Batched rename");

    await repo.batch([{ sql: "UPDATE event SET name = ? WHERE id = ?", params: ["Row Cache Conf", EVENT] }]);
  });

  it("caches the absence of a row as firmly as its presence", async () => {
    const { db, reads } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);
    expect(await repo.byId("event", "evt_does_not_exist")).toBeNull();
    expect(await repo.byId("event", "evt_does_not_exist")).toBeNull();
    expect(reads()).toBe(1);
  });

  it("leaves set reads alone — only a primary key read is cacheable", async () => {
    const { db, reads } = counting();
    enableRowCache(db);
    const repo = new D1Db(db, ORG);
    await repo.select("event", { status: "active" });
    await repo.select("event", { status: "active" });
    await repo.count("event", {});
    await repo.count("event", {});
    expect(reads()).toBe(4);
  });
});
