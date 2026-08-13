#!/usr/bin/env node
/**
 * Publish the seeded programmes, against any instance.
 *
 * The public schedule, the embeds and the ICS feed serve the `live` publication
 * and nothing else (INV-09-6), and the seed's teardown drops the publications
 * with the rest of the org. So a re-seed leaves every public surface correctly,
 * and unhelpfully, empty until this runs. Both editions: the archived one reads
 * the same snapshot the current one does, so an unpublished 2026 is a
 * conference that visibly did not happen.
 *
 * `scripts/dev.mjs` does this for the local server already and keeps doing it —
 * it can ask `/dev/ids` which events exist. This one cannot: `/dev/*` is refused
 * when `ENVIRONMENT === "production"`, which is precisely the instance worth
 * having a publish step for. It reads the ids out of the manifest the seed
 * writes instead, and otherwise drives the same organizer route a person would.
 *
 *   Usage:  node scripts/seed-publish.mjs [--base https://app.podiumstack.com]
 *                                         [--manifest .wrangler/seed-assets.json]
 */

import { readFile } from "node:fs/promises";

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = flag("base", process.env.PUBLIC_BASE_URL || "https://app.podiumstack.com");
const MANIFEST = flag("manifest", ".wrangler/seed-assets.json");

/** The seeded organizer, who is the one with `schedule.publish` on both events. */
const ORGANIZER = { email: "organizer@devflowconf.example", password: "PodiumDemo2027!" };

export async function publishSeededProgrammes({ base = BASE, manifest = MANIFEST } = {}) {
  let events;
  try {
    events = JSON.parse(await readFile(manifest, "utf8")).events ?? [];
  } catch {
    return { ok: false, why: `no manifest at ${manifest} — run the seed first`, published: 0 };
  }
  if (!events.length) return { ok: false, why: "the manifest names no events", published: 0 };

  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(ORGANIZER),
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) return { ok: false, why: `could not sign in at ${base} (${login.status})`, published: 0 };

  let published = 0;
  for (const event of events) {
    const res = await fetch(`${base}/admin/events/${event.id}/publications`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ note: "Initial publication of the seeded programme." }),
      redirect: "manual",
    });
    if (res.status !== 303) return { ok: false, why: `publishing ${event.slug} returned ${res.status}`, published };
    published++;
  }
  return { ok: true, published };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = await publishSeededProgrammes();
  if (!outcome.ok) {
    console.error(`seeded programmes not published: ${outcome.why}`);
    process.exit(1);
  }
  console.log(`published ${outcome.published} programmes at ${BASE}`);
}
