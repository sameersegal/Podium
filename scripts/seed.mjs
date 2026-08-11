#!/usr/bin/env node
/**
 * Seed a realistic conference into the local D1 database.
 *
 * Why a fully populated event rather than an empty shell: every screen in this
 * product is a list, and a list with nothing in it teaches you nothing about
 * whether the product works. The seed ships one live event mid-flight —
 * proposals in every state, a review round with real scores, accepted sessions
 * with onboarding under way, and a placed agenda — plus one archived prior
 * edition so the cross-event speaker directory has something to say.
 *
 * Passwords are seeded because R23 says so: password login is on in the
 * shipped default seed, since a deployment nobody can sign into is worse than
 * the marginal risk of password auth on a conference tool.
 *
 * Usage:  node scripts/seed.mjs [--out seed.sql] [--print]
 */

import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { argon2id } from "@noble/hashes/argon2.js";

/* -------------------------------------------------------------------------- */
/* deterministic ids                                                           */
/* -------------------------------------------------------------------------- */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;
const idCache = new Map();

function id(prefix, key) {
  const cacheKey = `${prefix}${key}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  counter += 1;
  // 10 chars of a fixed timestamp + 16 chars derived from the counter and key,
  // so ids are stable across runs and still sort by creation order.
  const time = "01JQ0000" + CROCKFORD[Math.floor(counter / 32) % 32] + CROCKFORD[counter % 32];
  let hash = 0;
  for (let i = 0; i < cacheKey.length; i++) hash = (hash * 33 + cacheKey.charCodeAt(i)) >>> 0;
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[(hash + i * 7 + counter * 13) % 32];
    hash = (hash * 31 + 17) >>> 0;
  }
  const value = prefix + time + rand;
  idCache.set(cacheKey, value);
  return value;
}

/* -------------------------------------------------------------------------- */
/* sql helpers                                                                 */
/* -------------------------------------------------------------------------- */

const statements = [];

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insert(table, row) {
  const keys = Object.keys(row);
  statements.push(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((k) => q(row[k])).join(", ")});`);
}

/* -------------------------------------------------------------------------- */
/* time                                                                        */
/* -------------------------------------------------------------------------- */

const NOW = new Date();
const iso = (d) => new Date(d).toISOString();
const daysFromNow = (n, hour = 12) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const now = iso(NOW);

// The event is fixed in 2027 to match the evaluation fixtures; everything
// deadline-shaped is relative to today so the seeded state stays live.
const EVENT_START = "2027-05-12";
const EVENT_END = "2027-05-14";
const TZ = "America/Los_Angeles";

/** 09:00 event-local on an event day, as UTC. PDT is UTC-7 in May. */
const dayAt = (dayIndex, hh, mm = 0) => {
  const date = ["2027-05-12", "2027-05-13", "2027-05-14"][dayIndex];
  const utcHour = hh + 7;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCHours(utcHour, mm, 0, 0);
  return d.toISOString();
};

/* -------------------------------------------------------------------------- */
/* passwords                                                                   */
/* -------------------------------------------------------------------------- */

const ARGON = { t: 3, m: 12288, p: 1, dkLen: 32 };

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function hashPassword(plaintext, saltSeed) {
  const salt = new Uint8Array(16);
  for (let i = 0; i < 16; i++) salt[i] = (saltSeed.charCodeAt(i % saltSeed.length) * (i + 7)) % 256;
  const hash = argon2id(new TextEncoder().encode(plaintext), salt, ARGON);
  return `$argon2id$v=19$m=${ARGON.m},t=${ARGON.t},p=${ARGON.p}$${b64(salt)}$${b64(hash)}`;
}

/* -------------------------------------------------------------------------- */
/* organization                                                                */
/* -------------------------------------------------------------------------- */

const ORG = id("org_", "devflow");

insert("organization", {
  id: ORG,
  name: "DevFlow Events",
  slug: "devflow",
  primary_domain: "devflowconf.example",
  default_timezone: TZ,
  contact_email: "hello@devflowconf.example",
  settings: {
    // R23: on in the shipped default seed.
    auth: { password_login_enabled: true },
    // R24: AI first-pass review ships behind an org setting, default off.
    review: { ai_evaluation_enabled: false, default_visibility: "committee_only" },
    // R25: auto-publish stays off by default.
    publication: { auto_publish: false },
    onboarding: { reminder_default_offsets: [-14, -7, -1, 3] },
    privacy: { retention_days: 730 },
    branding: { accent: "#6366F1" },
  },
  created_at: now,
  updated_at: now,
});

/* -------------------------------------------------------------------------- */
/* people                                                                      */
/* -------------------------------------------------------------------------- */

const people = [
  {
    key: "jordan",
    name: "Jordan Alvarez",
    email: "sbek-organizer@example.com",
    password: "SbekTest!2027-org",
    title: "Programme Director",
    company: "DevFlow Events",
    bio: "Jordan runs the DevFlow Conf programme and has chaired developer-tooling tracks since 2019.",
  },
  {
    key: "priya",
    name: "Priya Raman",
    email: "sbek-speaker@example.com",
    password: "SbekTest!2027-spk",
    title: "Principal Engineer",
    company: "Latticework Systems",
    bio: "Priya Raman is a Principal Engineer at Latticework Systems where she leads the build-tooling platform team. She previously maintained the open-source task runner 'gantry' and has spoken at over a dozen developer conferences on build systems, CI reliability, and developer productivity metrics.",
    links: [
      { kind: "x", url: "https://x.com/priyabuilds" },
      { kind: "linkedin", url: "https://www.linkedin.com/in/priya-raman-example" },
    ],
  },
  {
    key: "marcus",
    name: "Marcus Okafor",
    email: "sbek-speaker2@example.com",
    password: "SbekTest!2027-spk2",
    title: "Staff Developer Advocate",
    company: "Cloudreach Labs",
    bio: "Marcus Okafor is a Staff Developer Advocate at Cloudreach Labs focused on AI agents in production. He writes the newsletter 'Agents Weekly' and co-organizes the SF AI Tinkerers meetup.",
  },
  {
    key: "sam",
    name: "Sam Whitfield",
    email: "sbek-reviewer@example.com",
    password: "SbekTest!2027-rev",
    title: "Principal Engineer",
    company: "Northwind Data",
    bio: "Sam reviews for several developer conferences and works on distributed storage.",
  },
  {
    key: "riley",
    name: "Riley Chen",
    email: "riley.chen@devflowconf.example",
    password: "SbekTest!2027-org",
    title: "Speaker Operations",
    company: "DevFlow Events",
    bio: "Riley looks after speakers from acceptance to the green room.",
  },
  {
    key: "morgan",
    name: "Morgan Diaz",
    email: "morgan.diaz@devflowconf.example",
    password: "SbekTest!2027-org",
    title: "Partnerships",
    company: "DevFlow Events",
    bio: "Morgan looks after sponsor relationships and their sessions.",
  },
  { key: "dana", name: "Dana Kowalski", email: "dana.kowalski@substrate.example", title: "Engineering Manager", company: "Substrate", bio: "Runs the developer-experience org at Substrate; ex-CI lead at a fintech." },
  { key: "ravi", name: "Ravi Menon", email: "ravi.menon@paperclip.example", title: "Staff Engineer", company: "Paperclip", bio: "Works on incremental type-checking and editor tooling." },
  { key: "elena", name: "Elena Fischer", email: "elena.fischer@northbeam.example", title: "Head of Platform", company: "Northbeam", bio: "Builds the internal developer platform at Northbeam for 400 engineers." },
  { key: "tom", name: "Tom Bianchi", email: "tom.bianchi@quanta.example", title: "SRE Lead", company: "Quanta", bio: "Keeps a very large Kubernetes estate boring." },
  { key: "aisha", name: "Aisha Bello", email: "aisha.bello@finchhouse.example", title: "Director of Engineering", company: "Finch House", bio: "Writes and speaks about engineering org design and developer productivity metrics." },
  { key: "kenji", name: "Kenji Watanabe", email: "kenji.watanabe@orbital.example", title: "ML Infrastructure Engineer", company: "Orbital", bio: "Trains and serves large models on a budget." },
  { key: "lena", name: "Lena Novak", email: "lena.novak@brightpath.example", title: "Principal Designer", company: "Brightpath", bio: "Designs developer tools that people actually enjoy using." },
  { key: "chris", name: "Chris Doyle", email: "chris.doyle@harbourside.example", title: "Consultant", company: "Harbourside", bio: "Helps teams get off legacy build systems." },
  { key: "nadia", name: "Nadia Haddad", email: "nadia.haddad@vela.example", title: "VP Engineering", company: "Vela", bio: "Spoke at DevFlow Conf 2026 on platform migrations." },
  { key: "omar", name: "Omar Reyes", email: "omar.reyes@ferrolabs.example", title: "Developer Relations", company: "Ferro Labs", bio: "Sponsor contact and occasional speaker." },
  { key: "hannah", name: "Hannah Weiss", email: "hannah.weiss@keelworks.example", title: "Marketing Lead", company: "Keelworks", bio: "Sponsor contact for Keelworks." },
];

const P = {};
for (const person of people) {
  P[person.key] = id("per_", person.key);
  insert("person", {
    id: P[person.key],
    org_id: ORG,
    email: person.email,
    email_verified_at: person.password ? now : null,
    full_name: person.name,
    display_name: null,
    pronouns: null,
    timezone: TZ,
    locale: "en",
    status: person.password ? "active" : "invited",
    is_placeholder: 0,
    tags: JSON.stringify(person.company === "DevFlow Events" ? ["staff"] : ["speaker"]),
    custom_field_values: "{}",
    created_at: now,
    updated_at: now,
  });

  if (person.password) {
    insert("auth_identity", {
      id: id("aid_", person.key),
      person_id: P[person.key],
      provider: "password",
      subject: person.email,
      credential_hash: hashPassword(person.password, person.email),
      credential_updated_at: now,
      email_at_provider: person.email,
      created_at: now,
    });
  }

  const profileId = id("spk_", person.key);
  insert("speaker_profile", {
    id: profileId,
    person_id: P[person.key],
    org_id: ORG,
    headline: `${person.title}, ${person.company}`,
    job_title: person.title,
    company: person.company,
    bio: person.bio,
    short_bio: person.bio.split(". ")[0] + ".",
    location: "San Francisco, CA",
    visibility: JSON.stringify({
      bio: "public",
      short_bio: "public",
      company: "public",
      job_title: "public",
      headline: "public",
      location: "private",
      pronouns: "public",
    }),
    is_listed: 1,
    updated_at: now,
  });
  (person.links ?? []).forEach((link, i) => {
    insert("profile_link", {
      id: id("lnk_", `${person.key}-${i}`),
      speaker_profile_id: profileId,
      kind: link.kind,
      url: link.url,
      label: null,
      sort_order: i,
      is_public: 1,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* events                                                                      */
/* -------------------------------------------------------------------------- */

const EVENT = id("evt_", "devflow-2027");
const PRIOR_EVENT = id("evt_", "devflow-2026");

insert("event", {
  id: EVENT,
  org_id: ORG,
  name: "DevFlow Conf 2027",
  slug: "devflow-conf-2027",
  edition: "2027",
  tagline: "The developer workflow conference",
  description:
    "A three-day, three-track conference on developer tooling, AI-assisted engineering, and platform infrastructure.\n\nDevFlow brings together the people who build the tools everyone else builds with.",
  timezone: TZ,
  starts_on: EVENT_START,
  ends_on: EVENT_END,
  mode: "in_person",
  website_url: "https://devflowconf.example",
  status: "active",
  visibility: "public",
  settings: JSON.stringify({
    sponsorship: { draft_abandonment_days: 14 },
    scheduling: { min_transit_minutes: 10 },
    publication: { auto_publish: false },
  }),
  created_at: now,
  updated_at: now,
});

insert("event", {
  id: PRIOR_EVENT,
  org_id: ORG,
  name: "DevFlow Conf 2026",
  slug: "devflow-conf-2026",
  edition: "2026",
  tagline: "The developer workflow conference",
  timezone: TZ,
  starts_on: "2026-05-13",
  ends_on: "2026-05-15",
  mode: "in_person",
  status: "archived",
  visibility: "public",
  settings: "{}",
  created_at: now,
  updated_at: now,
  archived_at: now,
});

const VENUE = id("ven_", "moscone");
insert("venue", {
  id: VENUE,
  event_id: EVENT,
  name: "Moscone West",
  address: "800 Howard St, San Francisco, CA 94103",
  map_url: "https://maps.example/moscone-west",
  timezone: TZ,
});

const ROOMS = {};
[
  { key: "main", name: "Main Stage", capacity: 1200, floor: "Level 1", av: ["projector", "confidence_monitor", "stage_mics", "handheld_mics", "recording", "livestream", "hybrid_av"] },
  { key: "r2a", name: "Room 2A", capacity: 300, floor: "Level 2", av: ["projector", "stage_mics", "recording"] },
  { key: "r2b", name: "Room 2B", capacity: 300, floor: "Level 2", av: ["projector", "stage_mics", "recording"] },
  { key: "lab", name: "Workshop Lab", capacity: 60, floor: "Level 3", av: ["projector", "hands_on_power", "wifi_dedicated"] },
].forEach((room, i) => {
  ROOMS[room.key] = id("rom_", room.key);
  insert("room", {
    id: ROOMS[room.key],
    venue_id: VENUE,
    event_id: EVENT,
    name: room.name,
    slug: room.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    capacity: room.capacity,
    floor: room.floor,
    av_capabilities: JSON.stringify(room.av),
    sort_order: i,
    is_public: 1,
  });
});

const DAYS = {};
["2027-05-12", "2027-05-13", "2027-05-14"].forEach((date, i) => {
  DAYS[i] = id("day_", date);
  insert("event_day", {
    id: DAYS[i],
    event_id: EVENT,
    date,
    label: i === 0 ? "Day 1 — Workshops" : `Day ${i + 1}`,
    sort_order: i,
    is_public: 1,
  });
});

const TRACKS = {};
[
  { key: "ai", name: "AI Engineering", color: "#6366F1", target: 14, description: "Shipping software that uses models, and models that ship software." },
  { key: "infra", name: "Platform & Infra", color: "#0EA5E9", target: 12, description: "Build systems, CI, deployment, and the platforms underneath them." },
  { key: "dx", name: "Developer Experience", color: "#10B981", target: 10, description: "Docs, tooling, onboarding, and the daily loop." },
].forEach((track, i) => {
  TRACKS[track.key] = id("trk_", track.key);
  insert("track", {
    id: TRACKS[track.key],
    event_id: EVENT,
    name: track.name,
    slug: track.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: track.description,
    color: track.color,
    sort_order: i,
    target_session_count: track.target,
    is_public: 1,
  });
});

const FORMATS = {};
[
  { key: "keynote", name: "Keynote (45 min)", minutes: 45, max_speakers: 2, origins: ["invited", "cfp"], review: false, recording: true },
  { key: "talk", name: "Talk (30 min)", minutes: 30, max_speakers: 2, origins: ["cfp", "invited"], review: true, recording: true },
  { key: "lightning", name: "Lightning Talk (10 min)", minutes: 10, max_speakers: 1, origins: ["cfp"], review: true, recording: true },
  { key: "workshop", name: "Workshop (120 min)", minutes: 120, max_speakers: 3, origins: ["cfp", "sponsor"], review: true, recording: false, capacity: "ticketed" },
  { key: "panel", name: "Panel (45 min)", minutes: 45, max_speakers: 5, origins: ["cfp", "invited"], review: true, recording: true },
  { key: "sponsor", name: "Sponsor Session (20 min)", minutes: 20, max_speakers: 2, origins: ["sponsor"], review: false, recording: true },
].forEach((fmt, i) => {
  FORMATS[fmt.key] = id("fmt_", fmt.key);
  insert("session_format", {
    id: FORMATS[fmt.key],
    event_id: EVENT,
    name: fmt.name,
    slug: fmt.key,
    description: null,
    default_duration_minutes: fmt.minutes,
    min_duration_minutes: fmt.key === "workshop" ? 60 : null,
    max_duration_minutes: fmt.key === "workshop" ? 180 : null,
    max_speakers: fmt.max_speakers,
    eligible_origins: JSON.stringify(fmt.origins),
    requires_review: fmt.review ? 1 : 0,
    requires_recording_consent: fmt.recording ? 1 : 0,
    capacity_policy: fmt.capacity ?? "open",
    sort_order: i,
    is_public: 1,
  });
});

/* -------------------------------------------------------------------------- */
/* role grants                                                                 */
/* -------------------------------------------------------------------------- */

const grants = [
  { person: "jordan", role: "owner", scope_type: "org", scope_id: ORG },
  { person: "jordan", role: "program_chair", scope_type: "event", scope_id: EVENT },
  { person: "riley", role: "organizer", scope_type: "event", scope_id: EVENT },
  { person: "morgan", role: "sponsor_manager", scope_type: "org", scope_id: ORG },
  { person: "sam", role: "reviewer", scope_type: "event", scope_id: EVENT },
  { person: "dana", role: "reviewer", scope_type: "event", scope_id: EVENT },
  { person: "elena", role: "reviewer", scope_type: "event", scope_id: EVENT },
  { person: "aisha", role: "track_lead", scope_type: "track", scope_id: TRACKS.ai },
];
grants.forEach((g, i) => {
  insert("role_grant", {
    id: id("grt_", `${g.person}-${g.role}-${i}`),
    org_id: ORG,
    person_id: P[g.person],
    role: g.role,
    scope_type: g.scope_type,
    scope_id: g.scope_id,
    granted_by_person_id: P.jordan,
    granted_at: now,
  });
});

/* -------------------------------------------------------------------------- */
/* CFP and submission form                                                     */
/* -------------------------------------------------------------------------- */

const CFP = id("cfp_", "main");
const FORM = id("frm_", "main-v1");

insert("call_for_proposals", {
  id: CFP,
  event_id: EVENT,
  name: "DevFlow Conf 2027 Call for Papers",
  slug: "main",
  audience: "public",
  intro_markdown:
    "## Speak at DevFlow Conf 2027\n\nWe are looking for talks about the tools developers use every day — build systems, CI, AI-assisted engineering, and the platforms underneath.\n\nFirst-time speakers are welcome and actively encouraged. Every accepted speaker gets a speaker coach and two rehearsal slots.",
  guidelines_url: "https://devflowconf.example/speaking",
  opens_at: daysFromNow(-30),
  closes_at: "2027-04-30T23:59:00.000Z",
  grace_period_minutes: 30,
  late_submission_policy: "allow_with_flag",
  max_proposals_per_person: 3,
  allow_edit_after_submit: 1,
  withdraw_allowed_until: "always",
  active_form_id: FORM,
  notify_on_submit: 1,
  published_at: daysFromNow(-31),
  created_at: daysFromNow(-40),
  updated_at: now,
});

insert("submission_form", {
  id: FORM,
  cfp_id: CFP,
  version: 1,
  status: "published",
  published_at: daysFromNow(-31),
  notes: "Initial form for the 2027 call.",
  created_at: daysFromNow(-40),
});

const STEPS = {};
const stepDefs = [
  { key: "your-details", title: "About you", description: "Who is giving this talk. Co-speakers can be added here too." },
  { key: "the-talk", title: "About your talk", description: "This is what the programme committee reads." },
  { key: "logistics", title: "Logistics", description: "Recording, accessibility, and anything we need to know." },
  { key: "review-and-submit", title: "Review and submit", description: "Check everything before you send it." },
];
stepDefs.forEach((step, i) => {
  STEPS[step.key] = id("stp_", step.key);
  insert("form_step", {
    id: STEPS[step.key],
    form_id: FORM,
    key: step.key,
    title: step.title,
    description: step.description,
    sort_order: i,
    is_optional: 0,
  });
});

const fieldDefs = [
  {
    step: "your-details",
    key: "speakers",
    label: "Speakers",
    help: "Add yourself and any co-speakers. Co-speakers get an invitation to confirm.",
    type: "speaker_list",
    required: true,
    maps_to: "speakers",
    audience: "public",
  },
  {
    step: "your-details",
    key: "speaker_bio",
    label: "Speaker bio",
    help: "A short third-person bio. This appears next to your talk on the schedule.",
    type: "long_text",
    required: true,
    audience: "public",
    validation: { max_length: 1200 },
  },
  {
    step: "the-talk",
    key: "title",
    label: "Session title",
    help: "The title as you want it on the schedule.",
    type: "short_text",
    required: true,
    maps_to: "title",
    audience: "public",
    validation: { max_length: 120 },
  },
  {
    step: "the-talk",
    key: "abstract",
    label: "Abstract",
    help: "What the audience will learn, in a paragraph or two. This is published.",
    type: "long_text",
    required: true,
    maps_to: "abstract",
    audience: "public",
    validation: { min_length: 120, max_length: 2500 },
  },
  {
    step: "the-talk",
    key: "track",
    label: "Track",
    type: "track_picker",
    required: true,
    maps_to: "track",
    audience: "public",
  },
  {
    step: "the-talk",
    key: "format",
    label: "Session format",
    type: "format_picker",
    required: true,
    maps_to: "format",
    audience: "public",
  },
  {
    step: "the-talk",
    key: "notes_for_reviewers",
    label: "Notes for the committee",
    help: "Anything the committee should know that is not for the public page.",
    type: "long_text",
    required: false,
    audience: "committee_only",
  },
  {
    step: "logistics",
    key: "recording_consent",
    label: "May we record and publish this session?",
    type: "consent",
    required: true,
    maps_to: "recording_consent",
    audience: "organizer_only",
  },
  {
    step: "logistics",
    key: "av_needs",
    label: "AV requirements",
    help: "Anything beyond a projector and a microphone.",
    type: "multi_select",
    required: false,
    maps_to: "av_requirements",
    audience: "organizer_only",
    options: [
      { value: "confidence_monitor", label: "Confidence monitor" },
      { value: "handheld_mics", label: "Handheld microphones" },
      { value: "hands_on_power", label: "Power at every seat (workshops)" },
      { value: "wifi_dedicated", label: "Dedicated wifi" },
      { value: "livestream", label: "Livestream" },
    ],
  },
  {
    step: "logistics",
    key: "accessibility_needs",
    label: "Accessibility requirements",
    help: "We will contact you about anything you note here.",
    type: "long_text",
    required: false,
    audience: "organizer_only",
    pii: true,
  },
];

fieldDefs.forEach((f, i) => {
  insert("form_field", {
    id: id("fld_", f.key),
    step_id: STEPS[f.step],
    form_id: FORM,
    key: f.key,
    label: f.label,
    help_text: f.help ?? null,
    placeholder: null,
    type: f.type,
    options: f.options ? JSON.stringify(f.options) : null,
    is_required: f.required ? 1 : 0,
    validation: f.validation ? JSON.stringify(f.validation) : null,
    visible_when: null,
    maps_to: f.maps_to ?? "none",
    audience: f.audience,
    pii: f.pii ? 1 : 0,
    sort_order: i,
  });
});

[TRACKS.ai, TRACKS.infra, TRACKS.dx].forEach((trackId, i) => {
  insert("cfp_track_option", {
    id: id("cto_", `main-${i}`),
    cfp_id: CFP,
    track_id: trackId,
    is_available: 1,
    sort_order: i,
  });
});
["keynote", "talk", "lightning", "workshop", "panel"].forEach((key, i) => {
  insert("cfp_format_option", {
    id: id("cfo_", `main-${key}`),
    cfp_id: CFP,
    session_format_id: FORMATS[key],
    is_available: 1,
    closes_at_override: key === "workshop" ? "2027-04-16T23:59:00.000Z" : null,
    sort_order: i,
  });
});

/* -------------------------------------------------------------------------- */
/* sponsor CFP                                                                 */
/* -------------------------------------------------------------------------- */

const SPONSOR_CFP = id("cfp_", "sponsor");
const SPONSOR_FORM = id("frm_", "sponsor-v1");

insert("call_for_proposals", {
  id: SPONSOR_CFP,
  event_id: EVENT,
  name: "Sponsor sessions 2027",
  slug: "sponsor-sessions",
  audience: "sponsors_only",
  intro_markdown:
    "Submit the session your package includes. Sessions are not selected on merit — they are reviewed for content, and we will ask for changes if a session reads as a product pitch rather than a technical talk.",
  opens_at: daysFromNow(-20),
  closes_at: "2027-04-10T23:59:00.000Z",
  grace_period_minutes: 0,
  late_submission_policy: "reject",
  allow_edit_after_submit: 1,
  withdraw_allowed_until: "always",
  active_form_id: SPONSOR_FORM,
  notify_on_submit: 1,
  published_at: daysFromNow(-20),
  created_at: daysFromNow(-25),
  updated_at: now,
});

insert("submission_form", {
  id: SPONSOR_FORM,
  cfp_id: SPONSOR_CFP,
  version: 1,
  status: "published",
  published_at: daysFromNow(-20),
  created_at: daysFromNow(-25),
});

const SPONSOR_STEP = id("stp_", "sponsor-session");
const SPONSOR_STEP2 = id("stp_", "sponsor-speaker");
insert("form_step", { id: SPONSOR_STEP, form_id: SPONSOR_FORM, key: "the-session", title: "The session", description: "What you will present.", sort_order: 0, is_optional: 0 });
insert("form_step", { id: SPONSOR_STEP2, form_id: SPONSOR_FORM, key: "speakers", title: "Speakers", description: "You can leave this blank and name your speaker later.", sort_order: 1, is_optional: 1 });

[
  { step: SPONSOR_STEP, key: "title", label: "Session title", type: "short_text", required: true, maps_to: "title", audience: "public" },
  { step: SPONSOR_STEP, key: "abstract", label: "Abstract", type: "long_text", required: true, maps_to: "abstract", audience: "public" },
  { step: SPONSOR_STEP, key: "track", label: "Track", type: "track_picker", required: true, maps_to: "track", audience: "public" },
  { step: SPONSOR_STEP, key: "format", label: "Format", type: "format_picker", required: true, maps_to: "format", audience: "public" },
  { step: SPONSOR_STEP2, key: "speakers", label: "Speakers", type: "speaker_list", required: true, maps_to: "speakers", audience: "public" },
].forEach((f, i) => {
  insert("form_field", {
    id: id("fld_", `sponsor-${f.key}`),
    step_id: f.step,
    form_id: SPONSOR_FORM,
    key: f.key,
    label: f.label,
    type: f.type,
    is_required: f.required ? 1 : 0,
    maps_to: f.maps_to,
    audience: f.audience,
    pii: 0,
    sort_order: i,
  });
});

[TRACKS.ai, TRACKS.infra, TRACKS.dx].forEach((trackId, i) => {
  insert("cfp_track_option", { id: id("cto_", `sponsor-${i}`), cfp_id: SPONSOR_CFP, track_id: trackId, is_available: 1, sort_order: i });
});
["sponsor", "workshop"].forEach((key, i) => {
  insert("cfp_format_option", { id: id("cfo_", `sponsor-${key}`), cfp_id: SPONSOR_CFP, session_format_id: FORMATS[key], is_available: 1, sort_order: i });
});

/* -------------------------------------------------------------------------- */
/* sponsorship                                                                 */
/* -------------------------------------------------------------------------- */

const TIERS = {};
[
  { key: "diamond", name: "Diamond", level: 100, slots: 2, workshops: 1 },
  { key: "gold", name: "Gold", level: 60, slots: 1, workshops: 0 },
  { key: "community", name: "Community", level: 20, slots: 0, workshops: 0 },
].forEach((tier, i) => {
  TIERS[tier.key] = id("tir_", tier.key);
  insert("sponsorship_tier", {
    id: TIERS[tier.key],
    event_id: EVENT,
    name: tier.name,
    slug: tier.key,
    level: tier.level,
    description: `${tier.name} package`,
    is_public: 1,
    sort_order: i,
  });
  if (tier.slots > 0) {
    insert("tier_entitlement_template", {
      id: id("tet_", `${tier.key}-session`),
      tier_id: TIERS[tier.key],
      entitlement_type: "session_slot",
      quantity: tier.slots,
      allowed_format_ids: JSON.stringify([FORMATS.sponsor]),
      constraints: JSON.stringify({ max_duration_minutes: 20, requires_review: false }),
      notes: null,
    });
  }
  if (tier.workshops > 0) {
    insert("tier_entitlement_template", {
      id: id("tet_", `${tier.key}-workshop`),
      tier_id: TIERS[tier.key],
      entitlement_type: "workshop_slot",
      quantity: tier.workshops,
      allowed_format_ids: JSON.stringify([FORMATS.workshop]),
      constraints: null,
      notes: null,
    });
  }
  insert("tier_entitlement_template", {
    id: id("tet_", `${tier.key}-logo`),
    tier_id: TIERS[tier.key],
    entitlement_type: "logo_placement",
    quantity: 1,
    notes: null,
  });
});

const SPONSORS = {};
const ENTITLEMENTS = {};
[
  { key: "ferro", name: "Ferro Labs", tier: "diamond", contact: "omar", status: "active" },
  { key: "keelworks", name: "Keelworks", tier: "gold", contact: "hannah", status: "active" },
  { key: "brightpath", name: "Brightpath", tier: "community", contact: null, status: "active" },
].forEach((sponsor, i) => {
  SPONSORS[sponsor.key] = id("spo_", sponsor.key);
  insert("sponsor", {
    id: SPONSORS[sponsor.key],
    org_id: ORG,
    name: sponsor.name,
    display_name: sponsor.name,
    slug: sponsor.key,
    website_url: `https://${sponsor.key}.example`,
    description: `${sponsor.name} builds developer infrastructure.`,
    industry_tags: JSON.stringify(["developer-tools"]),
    status: sponsor.status,
    created_at: now,
    updated_at: now,
  });

  const snp = id("snp_", sponsor.key);
  insert("sponsorship", {
    id: snp,
    sponsor_id: SPONSORS[sponsor.key],
    event_id: EVENT,
    tier_id: TIERS[sponsor.tier],
    status: "confirmed",
    confirmed_at: daysFromNow(-45),
    contract_reference: `CRM-${1000 + i}`,
    public_from: daysFromNow(-40),
    created_at: daysFromNow(-50),
    updated_at: now,
  });

  const slots = sponsor.tier === "diamond" ? 2 : sponsor.tier === "gold" ? 1 : 0;
  if (slots > 0) {
    ENTITLEMENTS[sponsor.key] = id("ent_", `${sponsor.key}-session`);
    insert("entitlement", {
      id: ENTITLEMENTS[sponsor.key],
      sponsorship_id: snp,
      entitlement_type: "session_slot",
      quantity: slots,
      allowed_format_ids: JSON.stringify([FORMATS.sponsor]),
      constraints: JSON.stringify({ max_duration_minutes: 20, requires_review: false }),
      submission_deadline: "2027-04-10T23:59:00.000Z",
      expires_at: "2027-04-30T23:59:00.000Z",
      source: "tier_template",
      created_at: daysFromNow(-45),
      updated_at: now,
    });
  }
  insert("entitlement", {
    id: id("ent_", `${sponsor.key}-logo`),
    sponsorship_id: snp,
    entitlement_type: "logo_placement",
    quantity: 1,
    source: "tier_template",
    created_at: daysFromNow(-45),
    updated_at: now,
  });

  if (sponsor.contact) {
    insert("sponsor_contact", {
      id: id("sct_", sponsor.key),
      sponsor_id: SPONSORS[sponsor.key],
      person_id: P[sponsor.contact],
      contact_role: "primary",
      event_id: null,
      can_submit_sessions: 1,
      can_manage_contacts: 1,
      status: "active",
      invited_at: daysFromNow(-44),
      accepted_at: daysFromNow(-43),
    });
  }
});

/* -------------------------------------------------------------------------- */
/* rubrics and review round                                                    */
/* -------------------------------------------------------------------------- */

const RUBRIC = id("rub_", "main");
insert("rubric", {
  id: RUBRIC,
  event_id: EVENT,
  name: "DevFlow 2027 scorecard",
  description: "Two numbers, one verdict, and a box where the reasoning goes.",
  version: 1,
  overall_scale: "recommendation",
  requires_comment: 1,
  created_at: daysFromNow(-30),
});

[
  { key: "relevance", label: "Relevance to the track", type: "numeric", min: 1, max: 5, weight: 1.0, required: 1, na: 0, description: "1 — barely related. 5 — exactly what this track exists for." },
  { key: "depth", label: "Technical depth", type: "numeric", min: 1, max: 5, weight: 1.5, required: 1, na: 1, description: "1 — a marketing overview. 5 — hard-won specifics you cannot get from a blog post." },
  { key: "speaker", label: "Speaker credibility", type: "numeric", min: 1, max: 5, weight: 1.0, required: 0, na: 1, description: "Have they done the thing they are describing?" },
  {
    key: "verdict",
    label: "Verdict",
    type: "select",
    weight: 2.0,
    required: 1,
    na: 0,
    description: "The word you would use in the room.",
    options: [
      { value: "accept", label: "Accept", description: "I would put this on the programme.", score: 5 },
      { value: "maybe", label: "Maybe", description: "Worth discussing if there is space.", score: 3 },
      { value: "reject", label: "Reject", description: "Not this year.", score: 1 },
    ],
  },
  { key: "notes", label: "Reasoning", type: "text", weight: 1.0, required: 1, na: 0, max_length: 2000, description: "What would you say about this in the committee meeting?" },
].forEach((c, i) => {
  insert("rubric_criterion", {
    id: id("crt_", c.key),
    rubric_id: RUBRIC,
    key: c.key,
    label: c.label,
    description: c.description,
    type: c.type,
    scale_min: c.min ?? null,
    scale_max: c.max ?? null,
    options: c.options ? JSON.stringify(c.options) : null,
    max_length: c.max_length ?? null,
    weight: c.weight,
    is_required: c.required,
    allows_na: c.na,
    sort_order: i,
  });
});

// R17 — the sponsor compliance rubric: exactly one criterion.
const SPONSOR_RUBRIC = id("rub_", "sponsor");
insert("rubric", {
  id: SPONSOR_RUBRIC,
  event_id: EVENT,
  name: "Sponsor session compliance",
  description: "Not selection. One question, asked from a written anchor so the conversation is about the anchor.",
  version: 1,
  overall_scale: "none",
  requires_comment: 1,
  created_at: daysFromNow(-30),
});
insert("rubric_criterion", {
  id: id("crt_", "sponsor-compliance"),
  rubric_id: SPONSOR_RUBRIC,
  key: "technical_or_pitch",
  label: "Technical talk or product pitch?",
  description: "A technical talk teaches something that is true whether or not you buy the product. A pitch does not.",
  type: "select",
  options: JSON.stringify([
    { value: "technical", label: "Technical talk", description: "Ready to schedule.", score: 5 },
    { value: "mixed", label: "Mostly technical, some pitch", description: "Ask for edits to the last third.", score: 3 },
    { value: "pitch", label: "Product pitch", description: "Send it back with the contract wording attached.", score: 1 },
  ]),
  weight: 1.0,
  is_required: 1,
  allows_na: 0,
  sort_order: 0,
});

const ROUND = id("rnd_", "screening");
insert("review_round", {
  id: ROUND,
  event_id: EVENT,
  name: "Screening",
  sequence: 1,
  rubric_id: RUBRIC,
  scope: JSON.stringify({ cfp_ids: [CFP] }),
  // R10: seed round 1 as double_blind.
  anonymity: "double_blind",
  opens_at: daysFromNow(-14),
  closes_at: daysFromNow(21),
  target_reviews_per_proposal: 2,
  max_assignments_per_reviewer: 20,
  allow_self_assignment: 0,
  show_other_reviews_before_submit: 0,
  discussion_enabled: 1,
  status: "open",
  created_at: daysFromNow(-15),
  updated_at: now,
});

["sam", "dana", "elena", "aisha"].forEach((key, i) => {
  insert("review_round_reviewer", {
    id: id("rrv_", key),
    round_id: ROUND,
    person_id: P[key],
    pool_role: i === 3 ? "meta_reviewer" : "reviewer",
    track_ids: null,
    max_assignments: null,
    added_by_person_id: P.jordan,
    status: "active",
    created_at: daysFromNow(-14),
  });
});

/* -------------------------------------------------------------------------- */
/* proposals                                                                   */
/* -------------------------------------------------------------------------- */

const EVENT_CODE = "DFC27";
let refSeq = 0;
const nextRef = () => `${EVENT_CODE}-${String(++refSeq).padStart(4, "0")}`;

const proposalDefs = [
  {
    key: "p1",
    title: "The Build Cache Is Not Your Problem",
    speaker: "dana",
    track: "infra",
    format: "talk",
    level: "intermediate",
    status: "accepted",
    abstract:
      "Everyone reaches for a remote build cache first, and for most teams it is the third-best thing they could do. This talk walks through where CI time actually goes in four real repositories, what we measured, and the two cheaper interventions that beat caching in three of them.",
    scores: { relevance: 5, depth: 5, speaker: 4, verdict: "accept" },
  },
  {
    key: "p2",
    title: "Agents That Ship: Running Code-Writing Models in Production",
    speaker: "marcus",
    track: "ai",
    format: "talk",
    level: "advanced",
    status: "accepted",
    abstract:
      "Eighteen months of running code-generating agents against a production codebase, with the guardrails that survived and the ones we deleted. Includes the evaluation harness, the review policy, and the two incidents that taught us the most.",
    scores: { relevance: 5, depth: 4, speaker: 5, verdict: "accept" },
  },
  {
    key: "p3",
    title: "Type-Checking a Million Lines in Under a Second",
    speaker: "ravi",
    track: "dx",
    format: "talk",
    level: "advanced",
    status: "accepted",
    abstract:
      "Incremental type-checking is a graph problem wearing a compiler costume. We rebuilt ours around a demand-driven query engine and cut editor latency from 3 seconds to 40 milliseconds. This is the architecture, the wrong turns, and the benchmarks.",
    scores: { relevance: 4, depth: 5, speaker: 4, verdict: "accept" },
  },
  {
    key: "p4",
    title: "Platform Engineering Without the Platform Team",
    speaker: "elena",
    track: "infra",
    format: "talk",
    level: "intermediate",
    status: "accepted",
    abstract:
      "Northbeam supports 400 engineers with a platform group of five. This is how we chose what to own, what to buy, and what to deliberately leave to the teams — and the golden-path metrics we use to tell whether it is working.",
    scores: { relevance: 5, depth: 4, speaker: 4, verdict: "accept" },
  },
  {
    key: "p5",
    title: "Your Kubernetes Estate Should Be Boring",
    speaker: "tom",
    track: "infra",
    format: "lightning",
    level: "beginner",
    status: "accepted",
    abstract:
      "Ten minutes on the operational habits that make a large cluster estate uneventful: fewer knobs, ruthless defaults, and a change calendar nobody is allowed to override quietly.",
    scores: { relevance: 4, depth: 3, speaker: 4, verdict: "accept" },
  },
  {
    key: "p6",
    title: "Measuring Developer Productivity Without Making Everyone Miserable",
    speaker: "aisha",
    track: "dx",
    format: "keynote",
    level: "all",
    status: "accepted",
    abstract:
      "Every metric you can collect about engineers can be gamed, and most of them are. This keynote is about the small number that survive contact with a real organisation, why they work, and how to introduce them without triggering an immune response.",
    scores: { relevance: 5, depth: 4, speaker: 5, verdict: "accept" },
  },
  {
    key: "p7",
    title: "Serving Large Models on a Small Budget",
    speaker: "kenji",
    track: "ai",
    format: "workshop",
    level: "advanced",
    status: "accepted",
    abstract:
      "A hands-on workshop: take a 70B model from a checkpoint to a served endpoint with quantisation, batching and a cache, on hardware you can actually rent. Bring a laptop; everything runs against a shared cluster.",
    scores: { relevance: 5, depth: 5, speaker: 4, verdict: "accept" },
  },
  {
    key: "p8",
    title: "Designing Developer Tools People Enjoy",
    speaker: "lena",
    track: "dx",
    format: "talk",
    level: "all",
    status: "waitlisted",
    abstract:
      "Developer tools get a pass on design and it shows. This talk is a working method for interface decisions in technical products, with before-and-afters from three tools you have probably used.",
    scores: { relevance: 4, depth: 3, speaker: 4, verdict: "maybe" },
  },
  {
    key: "p9",
    title: "Migrating Off a Legacy Build System",
    speaker: "chris",
    track: "infra",
    format: "talk",
    level: "intermediate",
    status: "rejected",
    abstract:
      "A war story about moving a fifteen-year-old build to something maintainable, in increments, without a freeze. Covers the strangler pattern for build graphs and the political work that mattered more than the technical work.",
    scores: { relevance: 3, depth: 3, speaker: 3, verdict: "reject" },
  },
  {
    key: "p10",
    title: "Prompt Engineering Is Software Engineering",
    speaker: "nadia",
    track: "ai",
    format: "talk",
    level: "beginner",
    status: "in_review",
    abstract:
      "Treating prompts as source: version control, review, tests, and a deployment story. What changes when the compiler is a language model, and what stubbornly does not.",
    scores: { relevance: 4, depth: 3, speaker: 4, verdict: "maybe" },
    partialReview: true,
  },
  {
    key: "p11",
    title: "Documentation as a Product Surface",
    speaker: "lena",
    track: "dx",
    format: "lightning",
    level: "beginner",
    status: "submitted",
    abstract:
      "Ten minutes on treating docs like a product: an owner, a roadmap, analytics, and a definition of done that is not 'the page exists'.",
  },
  {
    key: "p12",
    title: "Incident Review Without Blame or Theatre",
    speaker: "tom",
    track: "infra",
    format: "panel",
    level: "all",
    status: "draft",
    abstract:
      "A panel on what a useful incident review looks like when nobody is defending a decision and nobody is performing contrition.",
  },
];

const PROPOSALS = {};
const SPEAKER_OF = {};

for (const p of proposalDefs) {
  const pid = id("prp_", p.key);
  PROPOSALS[p.key] = pid;
  SPEAKER_OF[p.key] = p.speaker;
  const submitted = p.status !== "draft";
  const submittedAt = submitted ? daysFromNow(-20 + proposalDefs.indexOf(p)) : null;
  insert("proposal", {
    id: pid,
    org_id: ORG,
    event_id: EVENT,
    cfp_id: CFP,
    form_id: FORM,
    reference: nextRef(),
    origin: "cfp",
    submitter_person_id: P[p.speaker],
    title: p.title,
    abstract: p.abstract,
    session_format_id: FORMATS[p.format],
    requested_duration_minutes: null,
    track_id: TRACKS[p.track],
    audience_level: p.level,
    keywords: JSON.stringify([]),
    language: "en",
    recording_consent: "granted",
    status: p.status,
    is_late: 0,
    submitted_at: submittedAt,
    last_activity_at: submittedAt ?? daysFromNow(-3),
    created_at: daysFromNow(-25 + proposalDefs.indexOf(p)),
    updated_at: now,
  });

  insert("proposal_speaker", {
    id: id("psp_", p.key),
    proposal_id: pid,
    person_id: P[p.speaker],
    speaker_role: "primary",
    sort_order: 0,
    participation_status: "accepted",
    added_by_person_id: P[p.speaker],
    added_at: daysFromNow(-25),
  });

  const answers = [
    ["title", p.title],
    ["abstract", p.abstract],
    ["track", TRACKS[p.track]],
    ["format", FORMATS[p.format]],
    ["speakers", [P[p.speaker]]],
    ["speaker_bio", people.find((x) => x.key === p.speaker)?.bio ?? ""],
    ["recording_consent", "granted"],
  ];
  answers.forEach(([key, value]) => {
    insert("proposal_answer", {
      id: id("pan_", `${p.key}-${key}`),
      proposal_id: pid,
      field_key: key,
      form_field_id: id("fld_", key),
      value: JSON.stringify(value),
      answered_at: submittedAt ?? now,
    });
  });

  if (submitted) {
    insert("proposal_revision", {
      id: id("prv_", `${p.key}-1`),
      proposal_id: pid,
      revision_number: 1,
      changed_by_person_id: P[p.speaker],
      change_kind: "resubmission",
      diff: "{}",
      snapshot: JSON.stringify({ title: p.title, abstract: p.abstract, track_id: TRACKS[p.track], session_format_id: FORMATS[p.format] }),
      created_at: submittedAt,
    });
  } else {
    insert("draft_progress", {
      proposal_id: pid,
      current_step_key: "the-talk",
      completed_step_keys: JSON.stringify(["your-details"]),
      furthest_step_key: "the-talk",
      last_saved_at: daysFromNow(-3),
      client_revision: 4,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* reviews                                                                     */
/* -------------------------------------------------------------------------- */

const reviewerRotation = ["sam", "dana", "elena"];
let reviewIndex = 0;

for (const p of proposalDefs) {
  if (!p.scores) continue;
  const reviewersForProposal = p.partialReview ? [reviewerRotation[reviewIndex % 3]] : [reviewerRotation[reviewIndex % 3], reviewerRotation[(reviewIndex + 1) % 3]];
  reviewIndex++;

  reviewersForProposal.forEach((reviewerKey, n) => {
    const asgId = id("asg_", `${p.key}-${reviewerKey}`);
    insert("review_assignment", {
      id: asgId,
      round_id: ROUND,
      proposal_id: PROPOSALS[p.key],
      reviewer_person_id: P[reviewerKey],
      assigned_by: "chair",
      status: "submitted",
      due_at: daysFromNow(7),
      reminder_count: n,
      assigned_at: daysFromNow(-13),
      submitted_at: daysFromNow(-8 + n),
    });

    const rvwId = id("rvw_", `${p.key}-${reviewerKey}`);
    const jitter = n === 0 ? 0 : -1;
    insert("review", {
      id: rvwId,
      assignment_id: asgId,
      proposal_id: PROPOSALS[p.key],
      round_id: ROUND,
      reviewer_person_id: P[reviewerKey],
      author_kind: "human",
      recommendation:
        p.scores.verdict === "accept" ? (n === 0 ? "accept" : "strong_accept") : p.scores.verdict === "maybe" ? "neutral" : "reject",
      confidence: n === 0 ? "high" : "medium",
      comments_for_committee:
        p.scores.verdict === "accept"
          ? "Clear narrative and real numbers. I would schedule this."
          : p.scores.verdict === "maybe"
            ? "Good speaker, thinner content than the abstract promises. Worth a discussion slot."
            : "Covered well elsewhere and the abstract does not say what is new here.",
      comments_for_speaker:
        p.scores.verdict === "reject"
          ? "A strong story, but we had three proposals on build migrations this year and picked the one with the most measurement in it. Please do submit again."
          : "Thank you — the committee liked the specificity of the examples.",
      flags: JSON.stringify([]),
      status: "submitted",
      reviewed_content_hash: `seedhash-${p.key}`,
      submitted_at: daysFromNow(-8 + n),
      created_at: daysFromNow(-10),
      updated_at: daysFromNow(-8 + n),
    });

    const scores = [
      ["relevance", { value_number: Math.max(1, p.scores.relevance + jitter) }],
      ["depth", { value_number: Math.max(1, p.scores.depth + jitter) }],
      ["speaker", { value_number: p.scores.speaker }],
      ["verdict", { value_option: p.scores.verdict }],
      [
        "notes",
        {
          value_text:
            p.scores.verdict === "accept"
              ? "Specific, measured, and the speaker has clearly done the work."
              : "Interesting angle; I would want more detail before committing a slot.",
        },
      ],
    ];
    scores.forEach(([key, value]) => {
      insert("criterion_score", {
        review_id: rvwId,
        criterion_id: id("crt_", key),
        value_number: value.value_number ?? null,
        value_option: value.value_option ?? null,
        value_text: value.value_text ?? null,
        value_bool: null,
        note: null,
      });
    });
  });
}

// A declared conflict, so the COI screen is not empty.
insert("conflict_of_interest", {
  id: id("coi_", "sam-northwind"),
  event_id: EVENT,
  reviewer_person_id: P.sam,
  subject_type: "company_domain",
  subject_id: null,
  subject_value: "northwind-data.example",
  reason: "same_employer",
  source: "declared_by_reviewer",
  note: "I work at Northwind Data — please keep me away from anything from my colleagues.",
  created_at: daysFromNow(-13),
});

/* -------------------------------------------------------------------------- */
/* decisions and sessions                                                      */
/* -------------------------------------------------------------------------- */

const SESSIONS = {};
const decided = proposalDefs.filter((p) => ["accepted", "rejected", "waitlisted"].includes(p.status));

for (const p of decided) {
  const decId = id("dec_", p.key);
  const outcome = p.status === "accepted" ? "accept" : p.status === "waitlisted" ? "waitlist" : "reject";
  insert("decision", {
    id: decId,
    proposal_id: PROPOSALS[p.key],
    round_id: ROUND,
    outcome,
    assigned_track_id: TRACKS[p.track],
    assigned_format_id: FORMATS[p.format],
    assigned_duration_minutes: null,
    conditions: null,
    feedback_for_speaker:
      outcome === "accept"
        ? "The committee liked how concrete this is. Please keep the measurements in when you cut it to time."
        : outcome === "waitlist"
          ? "We liked this and are holding it in case a slot opens in Developer Experience. We will tell you either way by 20 March."
          : "We had more strong submissions than slots this year. Please do submit again — the committee wanted more detail on what is new.",
    rationale: "Committee consensus.",
    decided_by_person_id: P.jordan,
    decided_at: daysFromNow(-5),
    status: "published",
    published_at: daysFromNow(-4),
    confirmation_deadline: outcome === "accept" ? daysFromNow(20) : null,
  });
  statements.push(
    `UPDATE proposal SET decision_id = ${q(decId)}, confirmation_deadline = ${q(outcome === "accept" ? daysFromNow(20) : null)} WHERE id = ${q(PROPOSALS[p.key])};`,
  );
}

const accepted = proposalDefs.filter((p) => p.status === "accepted");
accepted.forEach((p, i) => {
  const sid = id("ses_", p.key);
  SESSIONS[p.key] = sid;
  // Two are still waiting on their speaker, so the "unconfirmed" signal is real.
  const pending = i >= accepted.length - 2;
  insert("session", {
    id: sid,
    org_id: ORG,
    event_id: EVENT,
    proposal_id: PROPOSALS[p.key],
    reference: `${EVENT_CODE}-${String(proposalDefs.indexOf(p) + 1).padStart(4, "0")}`,
    origin: "cfp",
    title: p.title,
    abstract: p.abstract,
    session_format_id: FORMATS[p.format],
    track_id: TRACKS[p.track],
    duration_minutes: { keynote: 45, talk: 30, lightning: 10, workshop: 120, panel: 45, sponsor: 20 }[p.format],
    audience_level: p.level,
    keywords: JSON.stringify([]),
    language: "en",
    recording_consent: "granted",
    status: pending ? "pending_confirmation" : "confirmed",
    content_status: pending ? "draft" : "approved",
    content_approved_by_person_id: pending ? null : P.riley,
    content_approved_at: pending ? null : daysFromNow(-2),
    visibility: "public",
    created_at: daysFromNow(-4),
    updated_at: now,
  });
  insert("session_speaker", {
    id: id("ssp_", p.key),
    session_id: sid,
    person_id: P[p.speaker],
    speaker_role: "primary",
    sort_order: 0,
    confirmation_status: pending ? "pending" : "confirmed",
    confirmed_at: pending ? null : daysFromNow(-3),
    is_public: 1,
    attendance_mode: "in_person",
    added_at: daysFromNow(-4),
  });
  insert("session_revision", {
    id: id("srv_", `${p.key}-1`),
    session_id: sid,
    revision_number: 1,
    changed_by_person_id: P.jordan,
    change_kind: "decision_import",
    diff: "{}",
    snapshot: JSON.stringify({ title: p.title, abstract: p.abstract }),
    created_at: daysFromNow(-4),
  });
  statements.push(`UPDATE proposal SET session_id = ${q(sid)} WHERE id = ${q(PROPOSALS[p.key])};`);
});

// A sponsor session, spent from Ferro Labs' entitlement, with no speaker yet —
// which is exactly why `speaker_nomination` is a task rather than a mental note.
const SPONSOR_PROPOSAL = id("prp_", "ferro-session");
insert("proposal", {
  id: SPONSOR_PROPOSAL,
  org_id: ORG,
  event_id: EVENT,
  cfp_id: SPONSOR_CFP,
  form_id: SPONSOR_FORM,
  reference: nextRef(),
  origin: "sponsor",
  submitter_person_id: P.omar,
  sponsor_id: SPONSORS.ferro,
  entitlement_id: ENTITLEMENTS.ferro,
  title: "How We Cut Cold Starts to 40ms",
  abstract:
    "Ferro Labs runs a large edge fleet. This session walks through the measurements behind our cold-start work — what we tried, what did not help, and the two changes that did.",
  session_format_id: FORMATS.sponsor,
  track_id: TRACKS.infra,
  audience_level: "intermediate",
  recording_consent: "granted",
  status: "accepted",
  is_late: 0,
  submitted_at: daysFromNow(-12),
  last_activity_at: daysFromNow(-12),
  created_at: daysFromNow(-14),
  updated_at: now,
});

const SPONSOR_SESSION = id("ses_", "ferro-session");
insert("session", {
  id: SPONSOR_SESSION,
  org_id: ORG,
  event_id: EVENT,
  proposal_id: SPONSOR_PROPOSAL,
  reference: `${EVENT_CODE}-0100`,
  origin: "sponsor",
  title: "How We Cut Cold Starts to 40ms",
  abstract:
    "Ferro Labs runs a large edge fleet. This session walks through the measurements behind our cold-start work — what we tried, what did not help, and the two changes that did.",
  session_format_id: FORMATS.sponsor,
  track_id: TRACKS.infra,
  duration_minutes: 20,
  audience_level: "intermediate",
  language: "en",
  sponsor_id: SPONSORS.ferro,
  recording_consent: "granted",
  status: "confirmed",
  content_status: "in_review",
  visibility: "public",
  created_at: daysFromNow(-11),
  updated_at: now,
});
statements.push(`UPDATE proposal SET session_id = ${q(SPONSOR_SESSION)} WHERE id = ${q(SPONSOR_PROPOSAL)};`);

// Organizer-created programme items — breaks and registration are sessions too.
const ORG_ITEMS = [
  { key: "registration", title: "Registration and coffee", day: 1, start: [8, 0], minutes: 60, room: "main" },
  { key: "lunch-d2", title: "Lunch", day: 1, start: [12, 30], minutes: 60, room: "main" },
];
ORG_ITEMS.forEach((item, i) => {
  const sid = id("ses_", item.key);
  SESSIONS[item.key] = sid;
  insert("session", {
    id: sid,
    org_id: ORG,
    event_id: EVENT,
    reference: `${EVENT_CODE}-9${String(i).padStart(3, "0")}`,
    origin: "organizer",
    title: item.title,
    abstract: "",
    session_format_id: FORMATS.talk,
    duration_minutes: item.minutes,
    recording_consent: "denied",
    status: "confirmed",
    content_status: "approved",
    content_approved_by_person_id: P.riley,
    content_approved_at: daysFromNow(-2),
    visibility: "public",
    created_at: daysFromNow(-3),
    updated_at: now,
  });
});

/* -------------------------------------------------------------------------- */
/* placements                                                                  */
/* -------------------------------------------------------------------------- */

const placementPlan = [
  { key: "registration", day: 1, hour: 8, minute: 0, room: "main", minutes: 60 },
  { key: "p6", day: 1, hour: 9, minute: 0, room: "main", minutes: 45 },
  { key: "p1", day: 1, hour: 10, minute: 0, room: "r2a", minutes: 30 },
  { key: "p2", day: 1, hour: 10, minute: 0, room: "r2b", minutes: 30 },
  { key: "p3", day: 1, hour: 11, minute: 0, room: "r2a", minutes: 30 },
  { key: "lunch-d2", day: 1, hour: 12, minute: 30, room: "main", minutes: 60 },
  { key: "p4", day: 1, hour: 14, minute: 0, room: "r2a", minutes: 30 },
  { key: "p5", day: 1, hour: 15, minute: 0, room: "r2b", minutes: 10 },
  { key: "p7", day: 0, hour: 10, minute: 0, room: "lab", minutes: 120 },
  { key: "ferro-session", day: 2, hour: 10, minute: 0, room: "r2b", minutes: 20, session: SPONSOR_SESSION },
];

for (const plan of placementPlan) {
  const sessionId = plan.session ?? SESSIONS[plan.key];
  if (!sessionId) continue;
  const starts = dayAt(plan.day, plan.hour, plan.minute);
  const ends = new Date(new Date(starts).getTime() + plan.minutes * 60000).toISOString();
  insert("placement", {
    id: id("plc_", plan.key),
    event_id: EVENT,
    session_id: sessionId,
    room_id: ROOMS[plan.room],
    event_day_id: DAYS[plan.day],
    starts_at: starts,
    ends_at: ends,
    setup_minutes: 0,
    teardown_minutes: 0,
    status: "tentative",
    is_public: 1,
    placed_by_person_id: P.riley,
    created_at: daysFromNow(-2),
    updated_at: now,
  });
  statements.push(
    `UPDATE session SET status = 'scheduled' WHERE id = ${q(sessionId)} AND status IN ('confirmed');`,
  );
}

/* -------------------------------------------------------------------------- */
/* onboarding                                                                  */
/* -------------------------------------------------------------------------- */

const TASK_DEFS = [
  { key: "speaker-agreement", title: "Sign the speaker agreement", category: "legal", type: "acknowledgement", assignee: "each_speaker", due: { offset_days: 7 }, rule: "relative_to_assignment", blocking: 1, config: { checkbox_label: "I agree to the DevFlow Conf speaker agreement", require_typed_name: true, document_url: "https://devflowconf.example/speaker-agreement" }, instructions: "This is the standard agreement covering recording, code of conduct and travel reimbursement. It takes a minute." },
  { key: "code-of-conduct", title: "Accept the code of conduct", category: "legal", type: "acknowledgement", assignee: "each_speaker", due: { offset_days: 7 }, rule: "relative_to_assignment", blocking: 1, config: { checkbox_label: "I have read and accept the code of conduct", require_typed_name: false, document_url: "https://devflowconf.example/code-of-conduct" } },
  { key: "profile-bio-headshot", title: "Complete your profile and headshot", category: "profile", type: "file_upload", assignee: "each_speaker", due: { offset_days: -60 }, rule: "relative_to_event_start", blocking: 1, config: { accept: ["image/png", "image/jpeg"], max_files: 1, max_file_mb: 8, min_width: 800, min_height: 800, naming_hint: "firstname-lastname.jpg" }, instructions: "A square headshot, at least 800×800. This is what appears next to your talk on the website." },
  { key: "confirm-title-abstract", title: "Confirm your title and abstract", category: "content", type: "text_response", assignee: "primary_speaker_only", due: { offset_days: -60 }, rule: "relative_to_event_start", blocking: 1, config: { prompt: "Paste the final title and abstract you want published.", min_length: 80, max_length: 2500 } },
  { key: "recording-consent", title: "Confirm recording consent", category: "legal", type: "acknowledgement", assignee: "each_speaker", due: { offset_days: -45 }, rule: "relative_to_event_start", blocking: 1, config: { checkbox_label: "You may record my session and publish the recording", require_typed_name: false } },
  { key: "av-requirements", title: "Tell us your AV requirements", category: "technical", type: "text_response", assignee: "primary_speaker_only", due: { offset_days: -30 }, rule: "relative_to_event_start", blocking: 0, config: { prompt: "Anything beyond a projector, a clicker and a microphone?", max_length: 500 } },
  { key: "travel-details", title: "Send us your travel details", category: "travel", type: "text_response", assignee: "each_speaker", due: { offset_days: -45 }, rule: "relative_to_event_start", blocking: 0, config: { prompt: "Arrival and departure, and whether you need us to book anything.", max_length: 800 }, applies_to: { attendance_modes: ["in_person"] } },
  { key: "slides-upload", title: "Upload your final slides", category: "content", type: "file_upload", assignee: "primary_speaker_only", due: { offset_days: -7 }, rule: "relative_to_event_start", blocking: 0, config: { accept: ["application/pdf"], max_files: 2, max_file_mb: 50, naming_hint: "session-title.pdf" }, instructions: "PDF please, 16:9. Re-uploading creates a new version — we keep the old ones." },
  { key: "tech-check", title: "Book your tech check", category: "technical", type: "scheduling", assignee: "primary_speaker_only", due: { offset_days: -3 }, rule: "relative_to_event_start", blocking: 0, config: { booking_url: "https://cal.example/devflow-tech-check", window_start: "2027-05-09", window_end: "2027-05-11" } },
  { key: "nominate-speaker", title: "Name your speaker", category: "content", type: "speaker_nomination", assignee: "sponsor_speaker_wrangler", due: { offset_days: -60 }, rule: "relative_to_event_start", blocking: 1, config: { min_speakers: 1, max_speakers: 2, deadline: "2027-03-12" }, applies_to: { origins: ["sponsor"] }, subject_type: "sponsor" },
  { key: "sponsor-logo", title: "Send us your logo", category: "marketing", type: "file_upload", assignee: "sponsor_primary_contact", due: { offset_days: -60 }, rule: "relative_to_event_start", blocking: 0, config: { accept: ["image/svg+xml", "image/png"], max_files: 2, max_file_mb: 5 }, applies_to: { origins: ["sponsor"] }, subject_type: "sponsor" },
];

TASK_DEFS.forEach((t, i) => {
  insert("task_definition", {
    id: id("tdf_", t.key),
    event_id: EVENT,
    key: t.key,
    title: t.title,
    instructions: t.instructions ?? null,
    category: t.category,
    requirement_type: t.type,
    config: JSON.stringify(t.config ?? {}),
    subject_type: t.subject_type ?? "session",
    assignee_rule: t.assignee,
    applies_to: t.applies_to ? JSON.stringify(t.applies_to) : null,
    trigger: "on_session_confirmed",
    due_rule: t.rule,
    due_value: JSON.stringify(t.due),
    is_blocking: t.blocking,
    is_required: 1,
    requires_review: t.type === "file_upload" ? 1 : 0,
    sort_order: i,
    status: "active",
    version: 1,
    created_at: daysFromNow(-20),
    updated_at: now,
  });
  [-14, -3, 3].forEach((offset, n) => {
    insert("task_reminder_rule", {
      id: id("trr_", `${t.key}-${n}`),
      definition_id: id("tdf_", t.key),
      offset_days: offset,
      channel: "email",
      template_key: "task.reminder",
      escalate_to: offset > 0 ? "organizer" : null,
      only_if_status: null,
    });
  });
});

// Materialised instances for the confirmed sessions, in a spread of states so
// the onboarding board has something to be a board about.
const confirmedSessions = accepted.slice(0, accepted.length - 2);
const instanceStates = ["completed", "in_progress", "not_started", "submitted", "not_started", "completed", "not_started"];

// A conference that has published a schedule has, by definition, cleared the
// blocking tasks on the sessions that are on it (INV-06-5 and INV-06-11 are
// both gates). So blocking tasks are done — except on the last confirmed
// session, which is deliberately left stuck: an onboarding board with nothing
// outstanding, and an `unpublishable` signal that never fires, teach you
// nothing about whether either works.
const stuckSessionKey = confirmedSessions[confirmedSessions.length - 1]?.key;
confirmedSessions.forEach((p, si) => {
  TASK_DEFS.filter((t) => t.subject_type !== "sponsor").forEach((t, ti) => {
    const status = t.blocking
      ? p.key === stuckSessionKey && ti % 2 === 0
        ? "not_started"
        : "completed"
      : instanceStates[(si + ti) % instanceStates.length];
    const dueAt =
      t.rule === "relative_to_event_start"
        ? new Date(new Date(`${EVENT_START}T17:00:00Z`).getTime() + t.due.offset_days * 86400000).toISOString()
        : daysFromNow(-4 + t.due.offset_days);
    insert("task_instance", {
      id: id("tsk_", `${p.key}-${t.key}`),
      org_id: ORG,
      event_id: EVENT,
      definition_id: id("tdf_", t.key),
      definition_version: 1,
      definition_key: t.key,
      title: t.title,
      requirement_type: t.type,
      config: JSON.stringify(t.config ?? {}),
      instructions: t.instructions ?? null,
      subject_type: "session",
      subject_id: SESSIONS[p.key],
      session_id: SESSIONS[p.key],
      assignee_person_id: P[p.speaker],
      status,
      is_blocking: t.blocking,
      is_required: 1,
      requires_review: t.type === "file_upload" ? 1 : 0,
      due_at: dueAt,
      started_at: status === "not_started" ? null : daysFromNow(-3),
      submitted_at: status === "submitted" ? daysFromNow(-1) : null,
      completed_at: status === "completed" ? daysFromNow(-2) : null,
      completed_by_person_id: status === "completed" ? P[p.speaker] : null,
      reminder_count: status === "not_started" ? 1 : 0,
      last_reminded_at: status === "not_started" ? daysFromNow(-2) : null,
      created_at: daysFromNow(-4),
      updated_at: now,
    });
  });
});

// The sponsor's outstanding speaker nomination — the task the sponsor pipeline
// exists to chase.
insert("task_instance", {
  id: id("tsk_", "ferro-nominate"),
  org_id: ORG,
  event_id: EVENT,
  definition_id: id("tdf_", "nominate-speaker"),
  definition_version: 1,
  definition_key: "nominate-speaker",
  title: "Name your speaker",
  requirement_type: "speaker_nomination",
  config: JSON.stringify({ min_speakers: 1, max_speakers: 2, deadline: "2027-03-12" }),
  subject_type: "sponsor",
  subject_id: SPONSORS.ferro,
  session_id: SPONSOR_SESSION,
  assignee_person_id: P.omar,
  sponsor_id: SPONSORS.ferro,
  status: "not_started",
  is_blocking: 1,
  is_required: 1,
  requires_review: 0,
  due_at: daysFromNow(9),
  reminder_count: 2,
  last_reminded_at: daysFromNow(-2),
  created_at: daysFromNow(-11),
  updated_at: now,
});

/* -------------------------------------------------------------------------- */
/* roster                                                                      */
/* -------------------------------------------------------------------------- */

const rosterRows = [
  ...accepted.map((p) => ({ person: p.speaker, kind: "speaker", status: "confirmed", source: "decision", portal: "active" })),
  { person: "omar", kind: "sponsor_contact", status: "confirmed", source: "manual", portal: "active" },
  { person: "hannah", kind: "sponsor_contact", status: "invited", source: "manual", portal: "invited" },
  { person: "sam", kind: "reviewer", status: "confirmed", source: "invitation", portal: "active" },
  { person: "dana", kind: "reviewer", status: "confirmed", source: "invitation", portal: "active" },
  { person: "riley", kind: "staff", status: "confirmed", source: "manual", portal: "active" },
  { person: "jordan", kind: "staff", status: "confirmed", source: "manual", portal: "active" },
  { person: "lena", kind: "speaker", status: "invited", source: "proposal", portal: "invited" },
  { person: "nadia", kind: "prospect", status: "prospect", source: "crm_push", portal: "none" },
];
const seenRoster = new Set();
rosterRows.forEach((r, i) => {
  if (seenRoster.has(r.person)) return;
  seenRoster.add(r.person);
  insert("event_participant", {
    id: id("epa_", `${r.person}-2027`),
    org_id: ORG,
    event_id: EVENT,
    person_id: P[r.person],
    kind: r.kind,
    status: r.status,
    source: r.source,
    portal_access: r.portal,
    portal_invited_at: r.portal === "none" ? null : daysFromNow(-4),
    custom_field_values: "{}",
    added_by_person_id: P.jordan,
    created_at: daysFromNow(-4),
    updated_at: now,
  });
});

// Prior edition, so the directory has cross-event history to show.
["nadia", "dana", "aisha"].forEach((key) => {
  insert("event_participant", {
    id: id("epa_", `${key}-2026`),
    org_id: ORG,
    event_id: PRIOR_EVENT,
    person_id: P[key],
    kind: "speaker",
    status: "confirmed",
    source: "decision",
    portal_access: "active",
    custom_field_values: "{}",
    added_by_person_id: P.jordan,
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
  });
});

insert("person_note", {
  id: id("pnt_", "nadia-1"),
  org_id: ORG,
  person_id: P.nadia,
  event_id: null,
  body: "Excellent on stage in 2026 — the platform migration talk still gets quoted. Was unavailable for 2027 in January; said to ask again in the autumn.",
  author_person_id: P.jordan,
  created_at: daysFromNow(-60),
});
insert("person_note", {
  id: id("pnt_", "lena-1"),
  org_id: ORG,
  person_id: P.lena,
  event_id: EVENT,
  body: "Strong design perspective, which the DX track is short of. Shortlist for a keynote next year if the waitlisted talk goes well.",
  author_person_id: P.jordan,
  created_at: daysFromNow(-3),
});

/* -------------------------------------------------------------------------- */
/* CRM: segments and a pipeline                                                */
/* -------------------------------------------------------------------------- */

insert("contact_segment", {
  id: id("seg_", "returning"),
  org_id: ORG,
  name: "Spoke at a previous edition",
  description: "Everyone who has given a session at any DevFlow Conf.",
  kind: "dynamic",
  criteria: JSON.stringify({ spoken: "yes" }),
  created_by_person_id: P.jordan,
  visibility: "shared",
  created_at: daysFromNow(-30),
  updated_at: now,
});
insert("contact_segment", {
  id: id("seg_", "keynote-shortlist"),
  org_id: ORG,
  name: "2028 keynote shortlist",
  description: "A decision somebody made, not a query — it must not gain a name because a tag changed.",
  kind: "static",
  member_person_ids: JSON.stringify([P.aisha, P.nadia, P.elena]),
  created_by_person_id: P.jordan,
  visibility: "shared",
  created_at: daysFromNow(-10),
  updated_at: now,
});

const PIPELINE = id("pip_", "2028-keynotes");
insert("sourcing_pipeline", {
  id: PIPELINE,
  org_id: ORG,
  event_id: null,
  name: "DevFlow Conf 2028 keynotes",
  status: "active",
  created_by_person_id: P.jordan,
  created_at: daysFromNow(-9),
});
const STAGES = {};
[
  { key: "researching", name: "Researching", kind: "open" },
  { key: "identified", name: "Identified", kind: "open" },
  { key: "contacted", name: "Contacted", kind: "open" },
  { key: "interested", name: "Interested", kind: "open" },
  { key: "confirmed", name: "Confirmed", kind: "won" },
  { key: "declined", name: "Declined", kind: "lost" },
].forEach((s, i) => {
  STAGES[s.key] = id("pst_", s.key);
  insert("pipeline_stage", {
    id: STAGES[s.key],
    pipeline_id: PIPELINE,
    name: s.name,
    kind: s.kind,
    sort_order: i,
    wip_limit: s.kind === "open" ? 10 : null,
  });
});
[
  { person: "nadia", stage: "interested", topic: "The platform migration follow-up", score: 85, owner: "jordan" },
  { person: "aisha", stage: "contacted", topic: "Productivity metrics, part two", score: 78, owner: "jordan" },
  { person: "kenji", stage: "identified", topic: "Serving models cheaply", score: 62, owner: "riley" },
].forEach((c, i) => {
  const cardId = id("prc_", c.person);
  insert("prospect_card", {
    id: cardId,
    pipeline_id: PIPELINE,
    stage_id: STAGES[c.stage],
    person_id: P[c.person],
    event_id: null,
    topic: c.topic,
    score: c.score,
    rationale: "Consistently strong feedback and a topic the programme is short of.",
    owner_person_id: P[c.owner],
    next_action_at: daysFromNow(7 + i * 5),
    sort_order: i,
    entered_stage_at: daysFromNow(-6 + i),
    created_by_person_id: P.jordan,
    created_at: daysFromNow(-9),
    updated_at: now,
  });
  insert("prospect_stage_transition", {
    id: id("ptr_", `${c.person}-1`),
    card_id: cardId,
    from_stage_id: null,
    to_stage_id: STAGES.researching,
    moved_by_person_id: P.jordan,
    note: "Enrolled from the directory.",
    created_at: daysFromNow(-9),
  });
  insert("prospect_stage_transition", {
    id: id("ptr_", `${c.person}-2`),
    card_id: cardId,
    from_stage_id: STAGES.researching,
    to_stage_id: STAGES[c.stage],
    moved_by_person_id: P.jordan,
    note: null,
    created_at: daysFromNow(-6 + i),
  });
});

/* -------------------------------------------------------------------------- */
/* notification templates and an outbox with history                           */
/* -------------------------------------------------------------------------- */

const templates = [
  { key: "proposal.submitted", subject: "We have your proposal — {{proposal.reference}}", body: "Hi {{speaker.first_name}},\n\nThank you for submitting **{{proposal.title}}** to {{event.name}}. Your reference is {{proposal.reference}}.\n\nThe committee reviews everything after the call closes, and you will hear from us either way.\n\n[Track your submission]({{portal_url}})" },
  { key: "proposal.accepted", subject: "Your talk has been accepted to {{event.name}}", body: "Hi {{speaker.first_name}},\n\nCongratulations — **{{session.title}}** has been accepted for {{event.name}}.\n\nPlease confirm your participation and complete your speaker profile by {{confirmation_deadline}}.\n\n[Confirm and start onboarding]({{portal_url}})" },
  { key: "proposal.rejected", subject: "About your submission to {{event.name}}", body: "Hi {{speaker.first_name}},\n\nThank you for submitting **{{proposal.title}}**. We had more strong proposals than slots this year and cannot include it.\n\n{{feedback_for_speaker}}\n\nWe would genuinely like to see you submit again." },
  { key: "proposal.waitlisted", subject: "You are on the waitlist for {{event.name}}", body: "Hi {{speaker.first_name}},\n\n**{{proposal.title}}** is on our waitlist. {{feedback_for_speaker}}" },
  { key: "task.reminder", subject: "{{task.title}} is due {{task.due_at}}", body: "Hi {{speaker.first_name}},\n\nThis is a reminder about **{{task.title}}** for {{session.title}}, due {{task.due_at}}.\n\n[Open your checklist]({{portal_url}})" },
  { key: "schedule.changed", subject: "Your session time has changed", body: "Hi {{speaker.first_name}},\n\n**{{session.title}}** has moved. It is now {{session.starts_at}} in {{session.room}}.\n\n[See the schedule]({{portal_url}})" },
  { key: "invitation.sent", subject: "You have been invited to {{event.name}}", body: "Hi,\n\nYou have been invited to {{event.name}}.\n\n[Accept your invitation]({{accept_url}})" },
  { key: "review.assignment", subject: "{{count}} proposals are waiting for your review", body: "Hi {{speaker.first_name}},\n\nYou have proposals assigned for {{event.name}}.\n\n[Open your review queue]({{portal_url}})" },
];
templates.forEach((t, i) => {
  insert("notification_template", {
    id: id("ntp_", t.key),
    org_id: ORG,
    event_id: null,
    key: t.key,
    channel: "email",
    subject: t.subject,
    body_markdown: t.body,
    locale: "en",
    is_active: 1,
    version: 1,
    created_at: daysFromNow(-40),
    updated_at: now,
  });
});

accepted.forEach((p, i) => {
  insert("notification_delivery", {
    id: id("ntd_", `accept-${p.key}`),
    org_id: ORG,
    event_id: EVENT,
    template_key: "proposal.accepted",
    template_version: 1,
    recipient_person_id: P[p.speaker],
    recipient_email: people.find((x) => x.key === p.speaker)?.email ?? "unknown@example.com",
    channel: "email",
    subject_type: "proposal",
    subject_id: PROPOSALS[p.key],
    subject: `Your talk has been accepted to DevFlow Conf 2027`,
    rendered_body: `Congratulations — ${p.title} has been accepted for DevFlow Conf 2027. Please confirm your participation and complete your speaker profile.`,
    status: "sent",
    sent_at: daysFromNow(-4),
    created_at: daysFromNow(-4),
  });
});

/* -------------------------------------------------------------------------- */
/* embed                                                                       */
/* -------------------------------------------------------------------------- */

[
  { key: "main-sessions", name: "Main site — sessions list", widget: "sessions_list", format: "js_widget" },
  { key: "main-agenda", name: "Main site — agenda grid", widget: "agenda_grid", format: "js_widget" },
  { key: "main-speakers", name: "Main site — speaker gallery", widget: "speaker_gallery", format: "js_widget" },
].forEach((e, i) => {
  insert("embed_config", {
    id: id("emb_", e.key),
    event_id: EVENT,
    key: `dfc27-${e.key}`,
    name: e.name,
    widget_type: e.widget,
    allowed_origins: JSON.stringify(["https://devflowconf.example", "http://localhost:8787", "*"]),
    format: e.format,
    show_unpublished: 0,
    cache_ttl_seconds: 300,
    status: "active",
    created_by_person_id: P.jordan,
    created_at: daysFromNow(-5),
  });
});

/* -------------------------------------------------------------------------- */
/* reference counter                                                           */
/* -------------------------------------------------------------------------- */

insert("event_reference_counter", { event_id: EVENT, event_code: EVENT_CODE, next_value: refSeq + 1 });
insert("event_reference_counter", { event_id: PRIOR_EVENT, event_code: "DFC26", next_value: 1 });

/* -------------------------------------------------------------------------- */
/* write it out                                                                */
/* -------------------------------------------------------------------------- */

const sql = ["PRAGMA defer_foreign_keys = true;", ...statements].join("\n");
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : ".wrangler/seed.sql";

if (process.argv.includes("--print")) {
  console.log(sql);
} else {
  await writeFile(outFile, sql, "utf8");
  console.log(`wrote ${statements.length} statements to ${outFile}`);
  execFileSync("npx", ["wrangler", "d1", "execute", "podium", "--local", `--file=${outFile}`, "-y"], {
    stdio: "inherit",
  });
  console.log(`
Seeded DevFlow Conf 2027.

  Organizer / chair   sbek-organizer@example.com   SbekTest!2027-org
  Speaker             sbek-speaker@example.com     SbekTest!2027-spk
  Second speaker      sbek-speaker2@example.com    SbekTest!2027-spk2
  Reviewer            sbek-reviewer@example.com    SbekTest!2027-rev

  Admin      http://localhost:8787/admin
  Portal     http://localhost:8787/portal
  Reviewer   http://localhost:8787/review
  Public     http://localhost:8787/e/devflow-conf-2027
`);
}
