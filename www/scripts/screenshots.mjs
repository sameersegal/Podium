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

// A second speaker context at phone width. Playwright fixes a viewport per
// context, so the phone shots need their own rather than a resize.
contexts.speakerPhone = await browser.newContext({
  viewport: { width: PHONE_WIDTH, height: 844 },
  deviceScaleFactor: SCALE,
  isMobile: true,
  hasTouch: true,
});
await signIn(contexts.speakerPhone, PERSONAS.speaker);

/**
 * Arrange the state two screens need and the seed does not ship.
 *
 * The seed installs no integrations, which is correct for a conference that has
 * just been created and useless as a photograph of the integrations screen. So
 * this installs them — through the product's own forms, over the organizer's
 * real session, exactly as an organizer would. Nothing here fabricates a
 * screen; it puts the app into a state the app can genuinely be in.
 *
 * The credentials are secret *references* rather than secrets (the install form
 * takes the name of a stored secret and never the value), so no real token is
 * involved and the integrations are marked active without any provider being
 * called. The sync screen is shot against the in-memory provider that ships for
 * development, because it is the one whose tables can be listed with no network
 * — the mapping UI is provider-independent, which is the entire point of the
 * capability contract, and the marketing page says which provider it is.
 */
async function arrangeIntegrations() {
  const request = contexts.organizer.request;

  /** Installed integrations, by id. The install picker names every plugin key
      whether or not it is installed, so presence of a key proves nothing — an
      `itg_` link does. */
  const installed = async () => {
    const html = await (await request.get(`${base}/admin/integrations`)).text();
    return [...new Set([...html.matchAll(/\/admin\/integrations\/(itg_[A-Z0-9]+)/g)].map((m) => m[1]))];
  };

  /** The in-memory sync integration, if it is there. Its id is what the sync
      shot needs, and the only way to tell which id it is, is to open it. */
  const findMemory = async (ids) => {
    for (const id of ids) {
      const page = await (await request.get(`${base}/admin/integrations/${id}`)).text();
      if (page.includes("sync.memory")) return id;
    }
    return null;
  };

  const already = await installed();
  if (already.length > 0) {
    console.log(`integrations  ${already.length} already installed — skipping arrangement`);
    return await findMemory(already);
  }

  const install = (form) => request.post(`${base}/admin/integrations/new`, { form });

  await install({
    plugin_key: "email.resend",
    display_name: "Resend",
    secret_ref: "RESEND_API_KEY",
    "config.from_email": "hello@devflowconf.example",
    "config.from_name": "DevFlow Conf",
    is_default_for_capability: "on",
  });
  await install({
    plugin_key: "email.sendgrid",
    display_name: "SendGrid (standby)",
    secret_ref: "SENDGRID_API_KEY",
    "config.from_email": "hello@devflowconf.example",
    "config.from_name": "DevFlow Conf",
  });
  await install({
    plugin_key: "chat.slack",
    display_name: "Slack — #programme",
    secret_ref: "SLACK_BOT_TOKEN",
    "config.default_channel": "#programme",
  });
  await install({
    plugin_key: "sync.airtable",
    display_name: "Airtable — programme base",
    secret_ref: "AIRTABLE_PAT",
    "config.base_id": "appDevFlowConf2027",
    is_default_for_capability: "on",
  });
  await install({
    plugin_key: "sync.memory",
    display_name: "Programme base (development provider)",
  });

  // Find the in-memory integration and map two record types into it. Its tables
  // can be listed without a network call, so the mapping screen shows real
  // counts instead of a provider error.
  const memoryId = await findMemory(await installed());
  if (!memoryId) {
    console.error("could not find the installed in-memory sync integration");
    process.exit(1);
  }
  for (const [subject, table] of [
    ["session", "Sessions"],
    ["proposal", "Proposals"],
  ]) {
    await request.post(`${base}/admin/integrations/${memoryId}/sync`, {
      form: { subject, external_table_id: table, event_id: E },
    });
  }
  console.log(`integrations  installed 5, mapped 2 tables on ${memoryId}`);
  return memoryId;
}

const memoryId = await arrangeIntegrations();

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
    height: 700,
  },
  {
    name: "portal",
    persona: "speaker",
    path: "/portal",
    height: 760,
  },
  {
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
  const width = page.viewportSize().width;
  await page.screenshot({
    path: `${outDir}${shot.name}.png`,
    clip: { x: 0, y: 0, width, height: shot.height },
  });
  console.log(`${shot.name.padEnd(14)} ${shot.persona.padEnd(13)} ${shot.path}`);
  await page.close();
}

await browser.close();
