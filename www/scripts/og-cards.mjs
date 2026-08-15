#!/usr/bin/env node
/**
 * Draw the link-preview card for every page and every section of the built site.
 *
 *   npm --prefix www run build
 *   npm --prefix www run og
 *
 * The cards are committed, exactly as `public/screens/*.png` are. The
 * difference is what makes them safe to commit: a screenshot needs the app
 * running and seeded, and a card needs nothing but this repository. Everything
 * on one is the site's own copy — the eyebrow, the heading and the opening line
 * that `lib/site-content.mjs` reads out of `dist/` — set in the site's own
 * faces on the site's own ground. No claim is composed here. If a card says
 * something wrong, the page it was read from says it too.
 *
 * Why JPEG at quality 60, both measured rather than assumed. These are the one
 * image set here no visitor ever downloads — a card is fetched by a preview bot
 * once — so the only cost that matters is what the repository carries. The same
 * 82 cards as PNG are 4.8 MB; at quality 72 they are 3.0 MB and at 60 they are
 * 2.6 MB, and 60 is indistinguishable from 72 both at full size and at the
 * ~504px X renders a large card at in a timeline. Look at the two before moving
 * this number.
 *
 * WebP would be smaller again and is deliberately not used. X's card
 * documentation accepts it, but LinkedIn's crawler is documented as skipping an
 * og:image whose URL ends in .webp, and a card that fails to appear costs more
 * than 20 KB saves. JPEG is the format every consumer takes.
 *
 * The fonts and the wordmark are inlined as data URIs rather than fetched, so
 * this runs against a clean checkout with no server and no network. Chromium
 * comes from the `playwright` devDependency the screenshot script already
 * needs.
 */
import { chromium } from "playwright";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DIST,
  PUBLIC,
  CARD_DIR,
  clamp,
  pageCard,
  pageHead,
  sectionCard,
  sections,
  sitePages,
  slugFor,
} from "./lib/site-content.mjs";

if (!existsSync(DIST)) {
  console.error("No built site in www/dist — run `npm --prefix www run build` first.");
  process.exit(1);
}

const outDir = join(PUBLIC, CARD_DIR);

/** 1200×630 is what every consumer crops from; below 600×315 X will not use a large card. */
const WIDTH = 1200;
const HEIGHT = 630;
const QUALITY = 60;

const dataUri = async (path, mime) =>
  `data:${mime};base64,${(await readFile(join(PUBLIC, path))).toString("base64")}`;

const fonts = {
  display: await dataUri("fonts/newsreader.woff2", "font/woff2"),
  sans: await dataUri("fonts/public-sans.woff2", "font/woff2"),
  mono: await dataUri("fonts/jetbrains-mono.woff2", "font/woff2"),
};
const wordmark = await dataUri("podium-logo-horizontal-light.png", "image/png");

/*
 * Tokens copied by value from src/styles/global.css, on the same terms the
 * stylesheet itself sets out: continuity with the site is worth having, a build
 * dependency on it is not. Dark ground, one accent (the eyebrow), a hairline
 * rule above the address. No gradient, no glow — the site's own hero dropped
 * both, and a flat ground is what keeps a 1200×630 JPEG near 30 KB.
 */
const TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  @font-face { font-family: "Newsreader"; src: url(${fonts.display}) format("woff2"); font-weight: 300 400; }
  @font-face { font-family: "Public Sans"; src: url(${fonts.sans}) format("woff2"); font-weight: 300 700; }
  @font-face { font-family: "JetBrains Mono"; src: url(${fonts.mono}) format("woff2"); font-weight: 400 500; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    background: #0b0c0f; color: #f4f3ef;
    display: grid; grid-template-rows: auto 1fr auto;
    padding: 72px 80px 64px;
    font-family: "Public Sans", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #mark { height: 42px; width: auto; display: block; }
  #body { display: flex; flex-direction: column; justify-content: center; gap: 26px; overflow: hidden; }
  #eyebrow {
    font: 500 22px/1 "JetBrains Mono", monospace;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: oklch(0.8 0.12 285);
  }
  #heading {
    font: 300 68px/1.06 "Newsreader", Georgia, serif;
    letter-spacing: -0.025em; color: #f4f3ef; max-width: 21ch;
  }
  #lede { font: 300 27px/1.45 "Public Sans", sans-serif; color: #a8acb8; max-width: 46ch; }
  #foot { border-top: 1px solid #22252d; padding-top: 26px; }
  #url { font: 400 22px/1 "JetBrains Mono", monospace; color: #7d8290; }
</style></head>
<body>
  <img id="mark" src="${wordmark}" alt="" />
  <div id="body">
    <div id="eyebrow"></div>
    <h1 id="heading"></h1>
    <p id="lede"></p>
  </div>
  <div id="foot"><span id="url"></span></div>
</body></html>`;

const browser = await chromium.launch(
  process.env.PODIUM_CHROMIUM ? { executablePath: process.env.PODIUM_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.setContent(TEMPLATE);
await page.evaluate(() => document.fonts.ready);

/**
 * Fill the card, then shrink the type until it fits. Nothing is ever clipped or
 * ellipsised: a heading is the page's sentence and half of one is a different
 * claim. The floor is 44px, which no heading on this site reaches — the longest
 * is "Five things the incumbents do better, today." at 44 characters.
 */
async function draw({ eyebrow, heading, lede, url, file }) {
  await page.evaluate(
    ({ eyebrow, heading, lede, url }) => {
      document.getElementById("eyebrow").textContent = eyebrow;
      document.getElementById("heading").textContent = heading;
      document.getElementById("lede").textContent = lede;
      document.getElementById("url").textContent = url;

      const box = document.getElementById("body");
      const h = document.getElementById("heading");
      const p = document.getElementById("lede");
      for (let size = 68; size >= 44; size -= 2) {
        h.style.fontSize = `${size}px`;
        p.style.fontSize = `${Math.max(22, Math.round(size * 0.4))}px`;
        if (box.scrollHeight <= box.clientHeight) break;
      }
    },
    { eyebrow, heading, lede, url },
  );

  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, type: "jpeg", quality: QUALITY });
}

await rm(outDir, { recursive: true, force: true });

let count = 0;
let bytes = 0;
const record = (path) => {
  count += 1;
  bytes += readFileSync(path).length;
};

for (const { file, url } of sitePages()) {
  const html = readFileSync(file, "utf8");
  const head = pageHead(html);
  if (!head) {
    console.error(`  ✗ ${url} has no hero or page head to draw a card from`);
    process.exitCode = 1;
    continue;
  }

  const pageFile = join(PUBLIC, pageCard(url).replace(/^\//, ""));
  await draw({
    eyebrow: head.eyebrow,
    heading: head.heading,
    lede: clamp(head.lede),
    url: `podiumstack.com${url === "/" ? "" : url}`,
    file: pageFile,
  });
  record(pageFile);

  for (const section of sections(html)) {
    const sectionFile = join(PUBLIC, sectionCard(url, section.id).replace(/^\//, ""));
    await draw({
      eyebrow: section.eyebrow,
      heading: section.heading,
      lede: clamp(section.lede),
      url: `podiumstack.com${url === "/" ? "" : url}#${section.id}`,
      file: sectionFile,
    });
    record(sectionFile);
  }
  console.log(`  ${slugFor(url)}`);
}

await browser.close();

console.log(`\n${count} cards in public/${CARD_DIR}/ — ${(bytes / 1024).toFixed(0)} KB total.`);
