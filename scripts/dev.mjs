#!/usr/bin/env node
/**
 * One command to a running, populated Podium.
 *
 *   reset local state → apply migrations → seed → start the Worker →
 *   publish the seeded schedule → hand the terminal to wrangler
 *
 * The last step matters: the public schedule, the embeds and the ICS feed all
 * serve the `live` publication and nothing else (INV-09-6), so an unpublished
 * seed leaves every public surface correctly, and unhelpfully, empty. Rather
 * than fake a snapshot in SQL, this drives the real publish command through the
 * real HTTP surface, exactly as an organizer would.
 */

import { spawn, execFileSync } from "node:child_process";
import process from "node:process";

const PORT = process.env.PORT ?? "8787";
const BASE = `http://localhost:${PORT}`;
const ORGANIZER = { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" };

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

const skipReset = process.argv.includes("--no-reset");

if (!skipReset) {
  run("node", ["scripts/reset-db.mjs"]);
  run("npx", ["wrangler", "d1", "migrations", "apply", "podium", "--local"]);
  run("node", ["scripts/seed.mjs"]);
}

const wrangler = spawn("npx", ["wrangler", "dev", "--port", PORT], { stdio: "inherit" });

let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  wrangler.kill("SIGTERM");
  process.exit(code ?? 0);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
wrangler.on("exit", (code) => stop(code ?? 0));

async function waitForReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/dev/status`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function publishSeededSchedule() {
  const login = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(ORGANIZER),
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) return { ok: false, why: "could not sign in as the seeded organizer" };

  const ids = await (await fetch(`${BASE}/dev/ids`, { headers: { cookie } })).json();
  if (!ids.event_id) return { ok: false, why: "no active event to publish" };

  const existing = await (await fetch(`${BASE}/dev/status`, { headers: { cookie } })).json();
  if ((existing.counts?.schedule_publication ?? 0) > 0) return { ok: true, why: "already published" };

  const res = await fetch(`${BASE}/admin/events/${ids.event_id}/publications`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ note: "Initial publication of the seeded programme." }),
    redirect: "manual",
  });
  return res.status === 303 ? { ok: true } : { ok: false, why: `publish returned ${res.status}` };
}

if (!skipReset && (await waitForReady())) {
  try {
    const outcome = await publishSeededSchedule();
    console.log(
      outcome.ok
        ? `\n📅  Seeded schedule published — ${BASE}/e/devflow-conf-2027/schedule\n`
        : `\n⚠️   Seeded schedule not published (${outcome.why}). Publish it from ${BASE}/admin.\n`,
    );
  } catch (err) {
    console.log(`\n⚠️   Seeded schedule not published (${err}). Publish it from ${BASE}/admin.\n`);
  }
}
