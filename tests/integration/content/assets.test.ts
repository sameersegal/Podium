import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppContext } from "@podiumstack/data/context.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { uploadAssetDirect } from "@podiumstack/web/contexts/content/assets.js";

/**
 * INV-11-9 — uploading into an occupied `slot_key` creates a new `Asset` with
 * `version = max + 1`. Prior versions are never overwritten and stay
 * individually downloadable.
 */

const ORG = "org_asset_test";
const PERSON = "per_asset_test";
const now = () => new Date().toISOString();

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Asset Test Org", "asset-test-org", "UTC", "test@example.com", "{}", now(), now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(PERSON, "uploader@example.com", "Ann Uploader", "active", 0, now(), now())
    .run();
}

describe("INV-11-9: asset slot versioning end to end", () => {
  beforeAll(seed);

  it("a second upload into the same slot creates version 2, and version 1 stays retrievable from R2", async () => {
    const app = new AppContext({ env, orgId: ORG, actor: { type: "person", id: PERSON, display_name: "Ann Uploader" } });
    const slot = "session:ses_asset_test:slides";

    const first = await uploadAssetDirect(app, {
      file: new File(["deck v1 bytes"], "deck.pdf", { type: "application/pdf" }),
      slot_key: slot,
      purpose: "slides",
    });
    await app.flush();

    const second = await uploadAssetDirect(app, {
      file: new File(["deck v2 bytes, revised"], "deck-final.pdf", { type: "application/pdf" }),
      slot_key: slot,
      purpose: "slides",
    });
    await app.flush();

    expect(first.asset.version).toBe(1);
    expect(second.asset.version).toBe(2);
    expect(second.asset.supersedes_asset_id).toBe(first.asset.id);
    expect(second.superseded?.id).toBe(first.asset.id);

    // Both rows exist, neither deleted.
    const rows = await env.DB.prepare("SELECT id, version, deleted_at FROM asset WHERE slot_key = ? ORDER BY version").bind(slot).all<{ id: string; version: number; deleted_at: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((r) => !r.deleted_at)).toBe(true);

    // Version 1's bytes are still there, unmodified — "never overwritten".
    const v1Row = await env.DB.prepare("SELECT storage_key FROM asset WHERE id = ?").bind(first.asset.id).first<{ storage_key: string }>();
    const v1Object = await env.ASSETS_BUCKET.get(String(v1Row?.storage_key));
    expect(v1Object).not.toBeNull();
    expect(await v1Object?.text()).toBe("deck v1 bytes");

    const v2Row = await env.DB.prepare("SELECT storage_key FROM asset WHERE id = ?").bind(second.asset.id).first<{ storage_key: string }>();
    const v2Object = await env.ASSETS_BUCKET.get(String(v2Row?.storage_key));
    expect(await v2Object?.text()).toBe("deck v2 bytes, revised");
  });

  it("asset.uploaded triggers the scan reaction, which clears scan_status to clean (INV-11-3)", async () => {
    const { deliverEvent } = await import("@podiumstack/web/consumers/dispatch.js");
    const app = new AppContext({ env, orgId: ORG, actor: { type: "person", id: PERSON, display_name: "Ann Uploader" } });
    const { asset } = await uploadAssetDirect(app, {
      file: new File(["headshot bytes"], "me.png", { type: "image/png" }),
      slot_key: "person:per_asset_test:headshot",
      purpose: "headshot",
    });
    const events = await app.flush();
    expect(asset.scan_status).toBe("pending");

    const uploadedEvent = events.find((e) => e.type === "asset.uploaded");
    expect(uploadedEvent).toBeTruthy();
    await deliverEvent(env, uploadedEvent!);

    const after = await env.DB.prepare("SELECT scan_status FROM asset WHERE id = ?").bind(asset.id).first<{ scan_status: string }>();
    expect(after?.scan_status).toBe("clean");
  });
});

/**
 * `/assets/:assetId` — the route every `<img src>` on the site actually
 * points at (`headshotUrl`/`logoUrl`/`assetUrl` across identity, event-config,
 * scheduling and the public surface). It did not exist: every one of those
 * builders constructed a URL server-side, and no handler answered a request
 * to it — a broken image on every headshot, sponsor logo and public slides
 * link on the site, catchable only by requesting the URL a browser actually
 * requests, which no test here did before.
 */
describe("GET /assets/:assetId — the route every asset URL on the site points at", () => {
  beforeAll(seed);

  it("serves a public, clean asset's bytes inline, to an anonymous request", async () => {
    const app = new AppContext({ env, orgId: ORG, actor: { type: "person", id: PERSON, display_name: "Ann Uploader" } });
    const { asset } = await uploadAssetDirect(app, {
      file: new File(["headshot bytes"], "me.png", { type: "image/png" }),
      slot_key: "person:per_asset_test:headshot",
      purpose: "headshot",
      visibility: "public",
    });
    await app.flush();
    await env.DB.prepare("UPDATE asset SET scan_status = 'clean' WHERE id = ?").bind(asset.id).run();

    const res = await SELF.fetch(`http://localhost/assets/${asset.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // No content-disposition — an `<img src>` needs to render it inline, not
    // trigger a download, which is what distinguishes this from `/files/:id/download`.
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("headshot bytes");
  });

  it("refuses a private asset to a caller with no relationship to it", async () => {
    const app = new AppContext({ env, orgId: ORG, actor: { type: "person", id: PERSON, display_name: "Ann Uploader" } });
    const { asset } = await uploadAssetDirect(app, {
      file: new File(["private bytes"], "contract.pdf", { type: "application/pdf" }),
      slot_key: "task:tsk_asset_test:signed-contract",
      purpose: "task_attachment",
      visibility: "private",
    });
    await app.flush();

    const res = await SELF.fetch(`http://localhost/assets/${asset.id}`);
    expect([401, 403]).toContain(res.status);
  });
});
