#!/usr/bin/env node
/**
 * Regenerate the landing page's product screenshots from the real app.
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

const browser = await chromium.launch();

/** A signed-in browser context per persona, reused across that persona's shots. */
const contexts = {};
for (const [name, creds] of Object.entries(PERSONAS)) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: SCALE,
  });
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
  contexts[name] = context;
  await page.close();
}
contexts.anonymous = await browser.newContext({
  viewport: { width: WIDTH, height: 900 },
  deviceScaleFactor: SCALE,
});

/**
 * Which conference day to shoot.
 *
 * The seed places most of its sessions on one day and leaves the others nearly
 * empty, and the day ids are generated, so neither "the first tab" nor a
 * hard-coded id finds the interesting one. Ask the schedule which day has the
 * most sessions on it and shoot that — this keeps working when the seed changes.
 */
async function busiestDay() {
  const page = await contexts.organizer.newPage();
  await page.goto(`${base}/admin/events/${E}/schedule`, { waitUntil: "networkidle" });
  const days = await page.$$eval('a[href*="schedule?day="]', (as) =>
    as.map((a) => new URL(a.href).searchParams.get("day")),
  );
  let best = null;
  let bestCount = -1;
  for (const day of [...new Set(days)]) {
    await page.goto(`${base}/admin/events/${E}/schedule?day=${day}`, { waitUntil: "networkidle" });
    const count = await page.$$eval("tbody tr", (rows) => rows.length);
    if (count > bestCount) {
      best = day;
      bestCount = count;
    }
  }
  await page.close();
  return best;
}

const day = await busiestDay();

// `height` is the crop, in CSS pixels from the top of the page. Each is chosen
// to end on a section boundary, so no shot is cut off mid-row.
const SHOTS = [
  {
    name: "agenda",
    persona: "organizer",
    path: `/admin/events/${E}/schedule?day=${day}`,
    height: 780,
  },
  {
    name: "onboarding",
    persona: "organizer",
    path: `/admin/events/${E}/onboarding`,
    height: 760,
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
    name: "schedule",
    persona: "anonymous",
    path: `/e/${ids.event_slug}/schedule?day=${day}`,
    height: 780,
  },
  {
    name: "dashboard",
    persona: "organizer",
    path: `/admin/events/${E}`,
    height: 440,
  },
];

await mkdir(outDir, { recursive: true });

for (const shot of SHOTS) {
  const page = await contexts[shot.persona].newPage();
  await page.goto(base + shot.path, { waitUntil: "networkidle" });
  await page.screenshot({
    path: `${outDir}${shot.name}.png`,
    clip: { x: 0, y: 0, width: WIDTH, height: shot.height },
  });
  console.log(`${shot.name.padEnd(14)} ${shot.persona.padEnd(10)} ${shot.path}`);
  await page.close();
}

await browser.close();
