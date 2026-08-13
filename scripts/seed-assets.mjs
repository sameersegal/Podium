#!/usr/bin/env node
/**
 * Put the seeded images into R2.
 *
 * `scripts/seed.mjs` writes the `asset` rows and the image files; this puts the
 * bytes where those rows say they live, through the running Worker's own
 * binding (`PUT /dev/assets/:id`, non-production only). Two processes because
 * the two halves happen at different times: the rows go in before the Worker
 * starts, the bytes can only go in once it has.
 *
 * Idempotent — the keys are deterministic, so running it twice overwrites the
 * same objects with identical bytes.
 *
 *   Usage:  node scripts/seed-assets.mjs [--base http://127.0.0.1:8787]
 *                                        [--manifest .wrangler/seed-assets.json]
 *                                        [--remote]
 *
 *   --remote   push to the deployed bucket with `wrangler r2 object put`
 *              instead, because `/dev/*` is refused in production. Needs the
 *              account credentials and `wrangler.production.jsonc`, like
 *              `npm run deploy`.
 */

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = flag("base", `http://127.0.0.1:${process.env.PORT ?? "8787"}`);
const MANIFEST = flag("manifest", ".wrangler/seed-assets.json");

/**
 * The bucket, read from the checked-in wrangler config rather than repeated
 * here — the remote push names it on the command line, where the local push
 * gets it from the Worker's binding and never has to know.
 */
async function bucketName() {
  const config = await readFile("wrangler.jsonc", "utf8");
  const match = config.match(/"bucket_name"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error("wrangler.jsonc names no r2 bucket_name");
  return match[1];
}

/**
 * Deployed R2, one `wrangler r2 object put` per object.
 *
 * The dev route is not available here — `guard()` in `surfaces/dev.ts` refuses
 * every `/dev/*` route when `ENVIRONMENT === "production"`, which is correct and
 * is the whole reason this second path exists. Each invocation costs a couple of
 * seconds of process startup, so they go eight at a time; for the couple of
 * dozen objects the seed makes, that is seconds rather than a minute.
 */
async function pushRemote(parsed, dir) {
  const bucket = await bucketName();
  const queue = [...(parsed.assets ?? [])];
  let pushed = 0;
  let failure = null;

  const worker = async () => {
    for (;;) {
      const asset = queue.shift();
      if (!asset || failure) return;
      const file = path.join(dir, asset.filename);
      try {
        await run("npx", [
          "wrangler",
          "r2",
          "object",
          "put",
          `${bucket}/${asset.storage_key}`,
          `--file=${file}`,
          `--content-type=${asset.content_type ?? "application/octet-stream"}`,
          "--remote",
          "--config",
          "wrangler.production.jsonc",
        ]);
        pushed++;
      } catch (err) {
        failure ??= `${asset.filename} → ${err.stderr || err.message}`;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return failure ? { ok: false, why: failure, pushed } : { ok: true, pushed };
}

export async function pushSeededAssets({ base = BASE, manifest = MANIFEST, remote = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifest, "utf8"));
  } catch {
    return { ok: false, why: `no manifest at ${manifest} — run \`npm run db:seed\` first`, pushed: 0 };
  }

  const dir = parsed.dir ?? path.join(path.dirname(manifest), "seed-assets");
  if (remote) return pushRemote(parsed, dir);

  let pushed = 0;
  for (const asset of parsed.assets ?? []) {
    const bytes = await readFile(path.join(dir, asset.filename));
    const res = await fetch(`${base}/dev/assets/${asset.id}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) return { ok: false, why: `${asset.filename} → ${res.status} ${await res.text()}`, pushed };
    pushed++;
  }
  return { ok: true, pushed };
}

// Runs standalone as well as being imported by `scripts/dev.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = await pushSeededAssets({ remote: process.argv.includes("--remote") });
  if (!outcome.ok) {
    console.error(`seed assets not pushed: ${outcome.why}`);
    process.exit(1);
  }
  console.log(`pushed ${outcome.pushed} images into R2`);
}
