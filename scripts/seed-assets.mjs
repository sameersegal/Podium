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
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = flag("base", `http://127.0.0.1:${process.env.PORT ?? "8787"}`);
const MANIFEST = flag("manifest", ".wrangler/seed-assets.json");

export async function pushSeededAssets({ base = BASE, manifest = MANIFEST } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifest, "utf8"));
  } catch {
    return { ok: false, why: `no manifest at ${manifest} — run \`npm run db:seed\` first`, pushed: 0 };
  }

  const dir = parsed.dir ?? path.join(path.dirname(manifest), "seed-assets");
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
  const outcome = await pushSeededAssets();
  if (!outcome.ok) {
    console.error(`seed assets not pushed: ${outcome.why}`);
    process.exit(1);
  }
  console.log(`pushed ${outcome.pushed} images into R2`);
}
