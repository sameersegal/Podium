#!/usr/bin/env node
/**
 * Inflate the local database to conference scale, for `perf-console.mjs`.
 *
 * The seed is deliberately small — it exists so every screen has something
 * true on it, not so a benchmark has something to strain against. Thirteen
 * proposals tells you nothing about the screen an organizer actually meets in
 * week three of an open call, which is the screen worth measuring: the board
 * with eight hundred rows on it.
 *
 * This writes rows straight into D1, below the domain layer, and that is a
 * deliberate exception rather than an oversight. The rows it writes are
 * copies of a seeded proposal with a new id, reference and title — no state
 * machine is being driven, no event raised, nothing is being asserted about
 * behaviour. Anything that needs to be *true* goes through the service layer;
 * a fixture that needs to be *large* does not, and routing eight hundred
 * inserts through the submission pipeline would measure the pipeline.
 *
 * It is one-way. `npm run db:reset` puts the seed back.
 *
 * Usage:
 *   node scripts/perf-seed-scale.mjs [--proposals 800] [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const COUNT = Number(flag("proposals", "800"));
const DRY = argv.includes("--dry-run");
const BASE = flag("base", process.env.PODIUM_BASE ?? "http://127.0.0.1:8787");

/* Crockford base32, the alphabet the app's own ids use. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function suffix(n) {
  // A fixed prefix keeps generated ids sorted after the seed's and makes them
  // obvious in a query: everything this script writes starts `01KP`.
  let s = "";
  let v = n;
  for (let i = 0; i < 22; i++) {
    s = B32[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return "01KP" + s;
}

const sql = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const TITLES = [
  "Shipping %s Without a Rewrite",
  "What %s Cost Us in Production",
  "The %s Migration Nobody Wanted",
  "Measuring %s When the Metrics Lie",
  "%s at Ten Thousand Requests a Second",
  "Debugging %s Under Load",
  "A Postmortem on %s",
  "Why We Deleted Our %s Layer",
];
const SUBJECTS = [
  "Retrieval", "Evals", "Agents", "Streaming", "Fine-Tuning", "Guardrails", "Caching", "Observability",
  "Vector Search", "Prompt Routing", "Tool Calling", "Batch Inference", "Model Fallbacks", "Rate Limits",
];
const STATUSES = ["submitted", "submitted", "submitted", "under_review", "under_review", "accepted", "rejected", "waitlisted"];
const LEVELS = ["beginner", "intermediate", "advanced"];

async function main() {
  const idsRes = await fetch(`${BASE}/dev/ids`);
  if (!idsRes.ok) {
    console.error(`${BASE}/dev/ids answered ${idsRes.status} — is \`npm run dev\` up?`);
    process.exit(2);
  }
  const ids = await idsRes.json();

  // Everything a copied proposal needs to point at, read off the seeded one so
  // this script carries no knowledge of the seed's shape beyond "one exists".
  const template = execFileSync(
    "npx",
    [
      "wrangler", "d1", "execute", "podium", "--local", "--json",
      "--command",
      `SELECT p.*, (SELECT person_id FROM proposal_speaker WHERE proposal_id = p.id LIMIT 1) AS speaker_person_id FROM proposal p WHERE p.id = '${ids.proposal_id}'`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const row = JSON.parse(template.slice(template.indexOf("[")))[0].results[0];

  const people = JSON.parse(
    (() => {
      const out = execFileSync(
        "npx",
        ["wrangler", "d1", "execute", "podium", "--local", "--json", "--command", "SELECT id FROM person LIMIT 50"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      return out.slice(out.indexOf("["));
    })(),
  )[0].results.map((r) => r.id);

  const now = new Date().toISOString();
  const lines = ["PRAGMA defer_foreign_keys = TRUE;", "BEGIN TRANSACTION;"];

  for (let i = 0; i < COUNT; i++) {
    const id = "prp_" + suffix(i + 1);
    const person = people[i % people.length];
    const title = TITLES[i % TITLES.length].replace("%s", SUBJECTS[(i * 7) % SUBJECTS.length]);
    const status = STATUSES[i % STATUSES.length];
    const submitted = new Date(Date.parse(row.submitted_at || now) + i * 60_000).toISOString();

    lines.push(
      `INSERT INTO proposal (id, event_id, cfp_id, form_id, reference, origin, submitter_person_id, title, abstract, session_format_id, track_id, audience_level, keywords, language, recording_consent, status, is_late, submitted_at, last_activity_at, created_at, updated_at) VALUES (` +
        [
          sql(id),
          sql(row.event_id),
          sql(row.cfp_id),
          sql(row.form_id),
          sql(`PERF-${String(i + 1).padStart(5, "0")}`),
          sql("cfp"),
          sql(person),
          sql(title),
          sql(
            `A talk about ${SUBJECTS[(i * 7) % SUBJECTS.length].toLowerCase()}, written to be about as long as a real abstract is: two or three sentences of what the talk covers, one of what the audience leaves with, and enough words that a list of eight hundred of them weighs what a real one weighs.`,
          ),
          sql(row.session_format_id),
          sql(row.track_id),
          sql(LEVELS[i % LEVELS.length]),
          sql("[]"),
          sql("en"),
          sql("granted"),
          sql(status),
          "0",
          sql(submitted),
          sql(submitted),
          sql(submitted),
          sql(now),
        ].join(", ") +
        `);`,
    );
    lines.push(
      `INSERT INTO proposal_speaker (id, proposal_id, person_id, speaker_role, sort_order, participation_status, added_by_person_id, added_at) VALUES (` +
        [sql("psp_" + suffix(i + 1)), sql(id), sql(person), sql("primary"), "0", sql("accepted"), sql(person), sql(submitted)].join(", ") +
        `);`,
    );
  }

  lines.push("COMMIT;");

  mkdirSync(".wrangler", { recursive: true });
  const file = ".wrangler/perf-scale.sql";
  writeFileSync(file, lines.join("\n"));
  console.log(`wrote ${lines.length - 3} statements to ${file}`);
  if (DRY) return;

  execFileSync("npx", ["wrangler", "d1", "execute", "podium", "--local", "--file", file], {
    stdio: "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(`\n${COUNT} proposals added. \`npm run db:reset\` puts the seed back.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
