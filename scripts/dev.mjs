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
import { networkInterfaces } from "node:os";
import process from "node:process";

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = flag("port", process.env.PORT ?? "8787");
/** `--host 0.0.0.0` to reach the dev server from another machine. */
const HOST = flag("host", process.env.HOST ?? "127.0.0.1");

/** Where this script talks to the Worker — always locally, whatever it binds to. */
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * What the Worker puts *inside* links: invitation `accept_url`s (INV-01-15),
 * unsubscribe links, portal URLs in email bodies. Binding to 0.0.0.0 without
 * changing this hands a tester on another machine a pile of links pointing at
 * their own localhost, which is a confusing way to discover the difference
 * between a bind address and a public address.
 */
const PUBLIC_BASE_URL = flag(
  "public-url",
  process.env.PUBLIC_BASE_URL ?? (HOST === "0.0.0.0" ? `http://${lanAddress() ?? "localhost"}:${PORT}` : `http://localhost:${PORT}`),
);

function lanAddress() {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr.address)) {
        return addr.address;
      }
    }
  }
  return null;
}

const ORGANIZER = { email: "organizer@devflowconf.example", password: "PodiumDemo2027!" };

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

const skipReset = process.argv.includes("--no-reset");

if (!skipReset) {
  run("node", ["scripts/reset-db.mjs"]);
  run("npx", ["wrangler", "d1", "migrations", "apply", "podium", "--local"]);
  run("node", ["scripts/seed.mjs"]);
}

const wrangler = spawn(
  "npx",
  ["wrangler", "dev", "--ip", HOST, "--port", PORT, "--var", `PUBLIC_BASE_URL:${PUBLIC_BASE_URL}`],
  { stdio: "inherit" },
);

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

if (await waitForReady()) {
  console.log(
    `\n🎤  Podium is up.\n    local        http://localhost:${PORT}\n${
      HOST === "0.0.0.0" ? `    from the LAN ${PUBLIC_BASE_URL}\n` : ""
    }    links use    ${PUBLIC_BASE_URL}\n`,
  );
}

// Runs on every start, not just after a reset: `publishSeededSchedule` returns
// early when a publication already exists, and `--no-reset` against a database
// that has never been published is exactly the case that leaves every public
// surface correctly, and confusingly, empty.
if (await waitForReady()) {
  try {
    const outcome = await publishSeededSchedule();
    console.log(
      outcome.ok
        ? `\n📅  Seeded schedule published — ${PUBLIC_BASE_URL}/e/devflow-conf-2027/schedule\n`
        : `\n⚠️   Seeded schedule not published (${outcome.why}). Publish it from ${BASE}/admin.\n`,
    );
  } catch (err) {
    console.log(`\n⚠️   Seeded schedule not published (${err}). Publish it from ${BASE}/admin.\n`);
  }
}
