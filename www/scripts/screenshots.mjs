#!/usr/bin/env node
/**
 * Regenerate the marketing site's product screenshots from the real app.
 *
 * Every image on podiumstack.com is a photograph of the running product, taken
 * against the shipped seed — never a mockup. That is the whole point: the seed
 * is a conference mid-flight (proposals in every state, a review round with real
 * scores, sponsors part-way through their entitlements, an agenda with genuine
 * conflicts), so the screenshots show the product doing its job rather than an
 * empty shell with lorem ipsum in it.
 *
 *   npm run dev                      # in the repo root — resets, seeds, serves :8787
 *   npm --prefix www run screenshots
 *
 * If a screen is redesigned, rerun this. If a shot starts framing the wrong
 * thing, adjust its `height` here rather than cropping the PNG by hand.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.PODIUM_BASE ?? "http://localhost:8787";
const outDir = fileURLToPath(new URL("../public/screens/", import.meta.url));

// 1280 is the narrowest width at which every admin screen still uses its full
// multi-column layout, so the shots show the product as it is designed rather
// than its tablet fallback. 1.5× gives a crisp image on a retina display at the
// ~1100px the page actually renders them at, without a 3MB PNG.
const WIDTH = 1280;
const SCALE = 1.5;

// The portal is the one surface most often read on a phone, so it is shot at a
// phone width rather than scaled down from the desktop capture — a 1280px
// screen shrunk into a 320px column on the marketing page is a grey rectangle.
const PHONE_WIDTH = 390;

const PERSONAS = {
  organizer: { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" },
  speaker: { email: "sbek-speaker2@example.com", password: "SbekTest!2027-spk2" },
  reviewer: { email: "sbek-reviewer@example.com", password: "SbekTest!2027-rev" },
};

const res = await fetch(`${base}/dev/ids`);
if (!res.ok) {
  console.error(`could not read ${base}/dev/ids — is \`npm run dev\` running and seeded?`);
  process.exit(1);
}
const ids = await res.json();
const E = ids.event_id;

// Playwright downloads a Chromium build pinned to its own version. On a machine
// where one is already provisioned at a different build number — a CI image, a
// sandbox — point at it with PODIUM_CHROMIUM rather than downloading a second
// copy of a browser that is already on disk.
const browser = await chromium.launch(
  process.env.PODIUM_CHROMIUM ? { executablePath: process.env.PODIUM_CHROMIUM } : {},
);

async function signIn(context, creds) {
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name="email"]', creds.email);
  await page.fill('input[name="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  if (new URL(page.url()).pathname === "/login") {
    console.error(`sign-in failed for ${creds.email} — is password login on in this seed (R23)?`);
    process.exit(1);
  }
  await page.close();
}

/** A signed-in browser context per persona, reused across that persona's shots. */
const contexts = {};
for (const [name, creds] of Object.entries(PERSONAS)) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: SCALE,
  });
  await signIn(context, creds);
  contexts[name] = context;
}
contexts.anonymous = await browser.newContext({
  viewport: { width: WIDTH, height: 900 },
  deviceScaleFactor: SCALE,
});

// Phone-width contexts. Playwright fixes a viewport per context, so every phone
// shot needs its own rather than a resize.
//
// Three screens are shot twice, at both widths: the agenda, the onboarding board
// and the public schedule. Each is a wide grid or table whose desktop capture,
// scaled into a 350px column on a phone, is a grey rectangle rather than a
// screenshot — and each has a genuine narrow layout in the product worth
// showing. `Shot` picks between them with a `<picture>`, so a phone downloads
// only the phone file. The screens whose narrow layout scrolls a table
// sideways (proposals, sponsorships) are deliberately not here: the column that
// carries the claim ends up off-frame, which is worse than small.
const phoneContext = async (creds) => {
  const context = await browser.newContext({
    viewport: { width: PHONE_WIDTH, height: 844 },
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
  });
  if (creds) await signIn(context, creds);
  return context;
};
contexts.speakerPhone = await phoneContext(PERSONAS.speaker);
contexts.organizerPhone = await phoneContext(PERSONAS.organizer);
contexts.anonymousPhone = await phoneContext(null);

/**
 * Arrange the state two screens need and the seed does not ship.
 *
 * The seed installs one email provider and nothing else, which is correct for a
 * conference that has just been created and useless as a photograph of the
 * integrations screen. So this installs the rest — through the product's own
 * forms, over the organizer's real session, exactly as an organizer would.
 * Nothing here fabricates a screen; it puts the app into a state the app can
 * genuinely be in.
 *
 * The credentials are secret *references* rather than secrets (the install form
 * takes the name of a stored secret and never the value), so no real token is
 * involved and the integrations are marked active without any provider being
 * called. The sync screen is shot against the in-memory provider that ships for
 * development, because it is the one whose tables can be listed with no network
 * — the mapping UI is provider-independent, which is the entire point of the
 * capability contract, and the marketing page says which provider it is.
 *
 * The guard is **per plugin key**, and that is load-bearing. It used to be
 * "install nothing if anything is installed", which was true when the seed
 * shipped no integrations and silently stopped working the day it gained one:
 * every run then skipped the whole arrangement, the sync shot fell through to
 * the empty `/admin/sync` conflicts page, and both captions on /integrations
 * described a screen no longer in the file.
 */
async function arrangeIntegrations() {
  const request = contexts.organizer.request;

  /** Installed integrations as `plugin_key` → id. The install picker names
      every plugin key whether or not it is installed, so the listing page
      proves only which ids exist; the key each one holds is on its own page. */
  const installed = async () => {
    const html = await (await request.get(`${base}/admin/integrations`)).text();
    const ids = [...new Set([...html.matchAll(/\/admin\/integrations\/(itg_[A-Z0-9]+)/g)].map((m) => m[1]))];
    const byKey = {};
    for (const id of ids) {
      const page = await (await request.get(`${base}/admin/integrations/${id}`)).text();
      const key = page.match(/\b((?:email|chat|sync|storage|analytics|ticketing)\.[a-z_]+)\b/)?.[1];
      if (key && !byKey[key]) byKey[key] = id;
    }
    return byKey;
  };

  const WANTED = [
    {
      plugin_key: "email.resend",
      display_name: "Resend",
      secret_ref: "RESEND_API_KEY",
      "config.from_email": "hello@devflowconf.example",
      "config.from_name": "DevFlow Conf",
      is_default_for_capability: "on",
    },
    {
      plugin_key: "email.sendgrid",
      display_name: "SendGrid (standby)",
      secret_ref: "SENDGRID_API_KEY",
      "config.from_email": "hello@devflowconf.example",
      "config.from_name": "DevFlow Conf",
    },
    {
      plugin_key: "chat.slack",
      display_name: "Slack — #programme",
      secret_ref: "SLACK_BOT_TOKEN",
      "config.default_channel": "#programme",
    },
    {
      plugin_key: "sync.airtable",
      display_name: "Airtable — programme base",
      secret_ref: "AIRTABLE_PAT",
      "config.base_id": "appDevFlowConf2027",
      is_default_for_capability: "on",
    },
    { plugin_key: "sync.memory", display_name: "Programme base (development provider)" },
  ];

  const before = await installed();
  const missing = WANTED.filter((w) => !before[w.plugin_key]);
  for (const form of missing) {
    await request.post(`${base}/admin/integrations/new`, { form });
  }

  const after = missing.length ? await installed() : before;
  const memoryId = after["sync.memory"];
  if (!memoryId) {
    console.error("could not find the installed in-memory sync integration");
    process.exit(1);
  }

  // Map two record types into the in-memory provider. Its tables can be listed
  // without a network call, so the mapping screen shows real counts instead of
  // a provider error. Posting a mapping that already exists is harmless.
  for (const [subject, table] of [
    ["session", "Sessions"],
    ["proposal", "Proposals"],
  ]) {
    await request.post(`${base}/admin/integrations/${memoryId}/sync`, {
      form: { subject, external_table_id: table, event_id: E },
    });
  }
  console.log(`integrations  ${Object.keys(after).length} installed (${missing.length} added), 2 tables mapped`);
  return memoryId;
}

const memoryId = await arrangeIntegrations();

/**
 * Arrange the API keys the agent field guide photographs.
 *
 * The seed mints none, which is right for a conference nobody has automated yet
 * and useless as a photograph of the screen an organizer goes to before handing
 * an agent anything. So this creates three, through the product's own form, over
 * the organizer's real session — the same shape as `arrangeIntegrations` above.
 *
 * Three rather than one, because the claim the shot carries is that a key
 * reaches exactly what its scopes name: a marketing site that can read the
 * schedule and nothing else, a sponsorship dashboard that reads the deals, and
 * an agent that works the onboarding pile and publishes. No secret is captured —
 * the list shows a prefix, and the full value appears once on the redirect after
 * creation, which is a screen this script never opens.
 *
 * The scopes field is a multi-select, so the body has to repeat the key. A plain
 * object cannot, hence the hand-built urlencoded body.
 */
async function arrangeApiKeys() {
  const request = contexts.organizer.request;

  const existing = async () => {
    const html = await (await request.get(`${base}/admin/api-keys`)).text();
    return [...new Set([...html.matchAll(/\/admin\/api-keys\/(key_[A-Z0-9]+)\//g)].map((m) => m[1]))];
  };

  const already = await existing();
  if (already.length > 0) {
    console.log(`api keys      ${already.length} already minted — skipping arrangement`);
    return;
  }

  const mint = (name, scopes) => {
    const body = new URLSearchParams();
    body.set("name", name);
    for (const s of scopes) body.append("scopes", s);
    return request.post(`${base}/admin/api-keys/new`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: body.toString(),
    });
  };

  await mint("Marketing site", ["schedule:read"]);
  await mint("Sponsorship dashboard", ["sponsors:read", "entitlements:read"]);
  await mint("Programme agent", [
    "events:read",
    "proposals:read",
    "sessions:read",
    "tasks:read",
    "tasks:write",
    "schedule:read",
    "schedule:publish",
  ]);
  console.log("api keys      minted 3");
}

await arrangeApiKeys();

/**
 * Which conference day to shoot.
 *
 * The seed places most of its sessions on one day and leaves the others nearly
 * empty, and the day ids are generated, so neither "the first tab" nor a
 * hard-coded id finds the interesting one. One read of the whole grid answers
 * it, and keeps working when the seed changes.
 *
 * The label matters as much as the id: the public schedule takes `?day=`, but
 * the console holds the selected day in its own state and opens on the first
 * one, so the agenda shot has to click the tab rather than link to it.
 */
async function busiestDay() {
  const res = await contexts.organizer.request.get(`${base}/v1/events/${E}/schedule`);
  const { data } = await res.json();
  const counts = new Map();
  for (const p of data.placements) counts.set(p.event_day_id, (counts.get(p.event_day_id) ?? 0) + 1);
  const best = data.days
    .map((d) => ({ id: d.id, label: d.label || d.date, count: counts.get(d.id) ?? 0 }))
    .sort((a, b) => b.count - a.count)[0];
  console.log(`day           ${best.label} — ${best.count} sessions placed`);
  return best;
}

const day = await busiestDay();

// `height` is the crop, in CSS pixels from the top of the page. Each is chosen
// to end on a section boundary, so no shot is cut off mid-row. `console: true`
// marks a path the client-rendered admin console owns — those have to wait for
// the boot placeholder to go, or the capture is the word "Loading".
const SHOTS = [
  {
    name: "agenda",
    persona: "organizer",
    path: `/admin/events/${E}/schedule`,
    height: 780,
    console: true,
    // The console opens on the first day; the interesting one is a click away.
    async before(page) {
      const tab = page.getByRole("tab", { name: day.label, exact: true });
      if (await tab.count()) await tab.first().click();
    },
  },
  {
    // The narrow agenda leads with the conflict panel, which is the claim the
    // shot is on the landing page to make.
    name: "agenda-phone",
    persona: "organizerPhone",
    path: `/admin/events/${E}/schedule`,
    height: 844,
    console: true,
  },
  {
    name: "proposals",
    persona: "organizer",
    path: `/admin/events/${E}/proposals`,
    height: 760,
    console: true,
  },
  {
    name: "onboarding",
    persona: "organizer",
    path: `/admin/events/${E}/onboarding`,
    height: 760,
    console: true,
  },
  {
    // Narrow, the board leads with the four counters — open, blocking, overdue,
    // done — which is the same sentence the desktop table makes in a row.
    // 650 ends on the counter block rather than part-way into the task table,
    // whose last column is behind a sideways scroll at this width.
    name: "onboarding-phone",
    persona: "organizerPhone",
    path: `/admin/events/${E}/onboarding`,
    height: 650,
    console: true,
  },
  {
    name: "sponsorships",
    persona: "organizer",
    path: `/admin/events/${E}/sponsorships`,
    height: 560,
  },
  {
    name: "decisions",
    persona: "organizer",
    path: `/admin/events/${E}/decisions`,
    height: 700,
  },
  {
    name: "review",
    persona: "reviewer",
    path: "/review",
    height: 560,
    // The seed's reviewer has finished the round, so the queue collapses to one
    // line and the seven proposals they scored sit behind a closed disclosure —
    // which made this shot two thirds empty page and left its caption claiming
    // cards that were not in the frame. Opening it is a click an organizer
    // makes, and it puts the reviewer's actual work back in the photograph.
    async before(page) {
      const summary = page.locator("summary", { hasText: "already submitted" }).first();
      if (await summary.count()) await summary.click();
    },
  },
  {
    // The speaker portal is shown at phone width and only at phone width: it is
    // the surface most often read on one, and the desktop capture of it was on
    // no page. A shot nothing references is a file regenerated forever for
    // nobody — put the desktop crop back here if a page ever wants it.
    name: "portal-phone",
    persona: "speakerPhone",
    path: "/portal",
    height: 844,
  },
  {
    name: "schedule",
    persona: "anonymous",
    path: `/e/${ids.event_slug}/schedule?day=${day.id}`,
    height: 780,
  },
  {
    // The public schedule is a room-by-time grid on a laptop and an itinerary on
    // a phone. The features page claims exactly that, so it should show both.
    // Taller than a phone screen on purpose: the filter card fills the first
    // 844, and the itinerary this shot exists to show starts under it.
    name: "schedule-phone",
    persona: "anonymousPhone",
    path: `/e/${ids.event_slug}/schedule?day=${day.id}`,
    height: 1200,
  },
  {
    name: "dashboard",
    persona: "organizer",
    path: `/admin/events/${E}`,
    height: 440,
    console: true,
  },
  {
    name: "integrations",
    persona: "organizer",
    path: "/admin/integrations",
    height: 600,
  },
  {
    name: "sync",
    persona: "organizer",
    path: memoryId ? `/admin/integrations/${memoryId}/sync` : "/admin/sync",
    height: 560,
  },
  {
    // For the deploy guide. The two switches it argues about — password sign-in
    // and the AI first pass — are both on this one form, so the crop runs to the
    // save button rather than stopping after the second of them.
    name: "settings",
    persona: "organizer",
    path: "/admin/settings",
    height: 932,
  },
  {
    // Both of these get a phone capture, unlike the wide tables above, because
    // both have a genuine narrow layout that keeps the payload in frame: this
    // one is a single-column form, and the key list below stacks the scopes
    // under each key's name. What scrolls off the key list at this width is the
    // status chip and the two buttons, not the scopes — which are the whole
    // reason the shot exists.
    name: "settings-phone",
    persona: "organizerPhone",
    path: "/admin/settings",
    height: 1016,
  },
  {
    // For the agent guide: where the token comes from, and what scoping one
    // actually looks like. Needs `arrangeApiKeys` above to have run.
    name: "api-keys",
    persona: "organizer",
    path: "/admin/api-keys",
    height: 460,
  },
  {
    name: "api-keys-phone",
    persona: "organizerPhone",
    path: "/admin/api-keys",
    height: 844,
  },
];

await mkdir(outDir, { recursive: true });

for (const shot of SHOTS) {
  const page = await contexts[shot.persona].newPage();
  await page.goto(base + shot.path, { waitUntil: "networkidle" });
  if (shot.console) {
    await page.waitForSelector(".console-booting", { state: "detached", timeout: 15_000 });
    // The redraw after the first data fetch lands a frame later; without this
    // the grid is captured with its cells still empty.
    await page.waitForLoadState("networkidle");
  }
  if (shot.before) {
    await shot.before(page);
    await page.waitForLoadState("networkidle");
  }
  const { width, height: viewportHeight } = page.viewportSize();
  // A `clip` on its own is taken against the viewport, so a crop taller than
  // the window is silently truncated to it — which is how the phone schedule
  // shot came back as its own filter panel. `fullPage` clips against the whole
  // document instead.
  await page.screenshot({
    path: `${outDir}${shot.name}.png`,
    fullPage: shot.height > viewportHeight,
    clip: { x: 0, y: 0, width, height: shot.height },
  });
  console.log(`${shot.name.padEnd(14)} ${shot.persona.padEnd(13)} ${shot.path}`);
  await page.close();
}

await browser.close();
