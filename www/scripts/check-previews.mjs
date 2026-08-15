#!/usr/bin/env node
/**
 * Assert the link previews on the built site, in the built HTML.
 *
 * Runs as the last step of `npm --prefix www run build`, which is what
 * `npm run deploy` runs, so a broken preview fails the deploy the way model
 * drift fails the app's. The meta tags are the whole deliverable here and they
 * are invisible: nothing on the page moves when `og:image` points at a file
 * that is not there, and the first person to find out is whoever posted the
 * link.
 *
 * What it holds each of the site's pages to:
 *
 *   1. A title, a description and a canonical of its own — no page inheriting
 *      the landing page's, which gets it indexed as a duplicate of it.
 *   2. An `og:image` that is this page's own card, absolute, on this origin and
 *      present in `dist/`. Falling back to `/og-image.png` is allowed only when
 *      the card has not been drawn yet.
 *   3. `og:title` and `og:description` matching the page's own title and
 *      description.
 *
 * And each section's share page:
 *
 *   4. `noindex`, and canonical to the real address with the fragment on it.
 *   5. `og:title` is the section's heading, `og:image` is a file in `dist/`.
 *   6. The body works with no script: the heading is in it, and so is a link
 *      to the section.
 *
 * Rule 6 is the one worth having. The hop is a `location.replace` in the head,
 * so every check you do in a browser passes through it in a few milliseconds
 * and never shows you what a reader with scripts blocked gets.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIST,
  ORIGIN,
  clamp,
  pageCard,
  sectionCard,
  sectionUrl,
  sections,
  sharePath,
  sitePages,
  text,
} from "./lib/site-content.mjs";

let problems = 0;
const fail = (where, message) => {
  problems += 1;
  console.error(`  ✗ ${where}: ${message}`);
};

/** Attribute values are escaped in the markup and are not in the source copy. */
const decode = (s) =>
  s === null
    ? null
    : s
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

const meta = (html, attr, name) =>
  decode(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html)?.[1] ?? null);
const tag = (html, re) => decode(re.exec(html)?.[1] ?? null);

/** An og:image is a promise that a file is at that URL. Check the file. */
function assetFor(url, where) {
  if (!url) return fail(where, "no og:image");
  if (!url.startsWith(`${ORIGIN}/`)) return fail(where, `og:image is not absolute: ${url}`);
  const path = url.slice(ORIGIN.length);
  if (!existsSync(join(DIST, path.replace(/^\//, "")))) {
    fail(where, `og:image is not in the build: ${path}`);
  }
  return path;
}

const pages = sitePages();
if (pages.length === 0) {
  console.error("No built pages in www/dist — run `npm --prefix www run build` first.");
  process.exit(1);
}

const titles = new Map();
const descriptions = new Map();
let shareCount = 0;
let fallbacks = 0;

for (const { file, url } of pages) {
  const html = readFileSync(file, "utf8");
  const title = tag(html, /<title>([\s\S]*?)<\/title>/);
  const description = meta(html, "name", "description");
  const canonical = tag(html, /<link rel="canonical" href="([^"]*)"/);

  if (!title) fail(url, "no <title>");
  if (!description) fail(url, "no description");
  if (canonical !== `${ORIGIN}${url}`) fail(url, `canonical is ${canonical}`);

  if (titles.has(title)) fail(url, `shares its title with ${titles.get(title)}`);
  titles.set(title, url);
  if (descriptions.has(description)) fail(url, `shares its description with ${descriptions.get(description)}`);
  descriptions.set(description, url);

  if (meta(html, "property", "og:title") !== text(title)) fail(url, "og:title is not the title");
  if (meta(html, "property", "og:description") !== description) {
    fail(url, "og:description is not the description");
  }

  const image = assetFor(meta(html, "property", "og:image"), url);
  if (image === "/og-image.png") {
    fallbacks += 1;
    // The fallback is legitimate for a page whose card has not been drawn yet.
    // It is a defect when the card is sitting in `public/` and the page used
    // the logo art anyway, which is what a wrong path in the layout looks like
    // from the outside: nothing breaks, every link just previews as the logo.
    if (existsSync(join(DIST, pageCard(url).replace(/^\//, "")))) {
      fail(url, `${pageCard(url)} exists but the page fell back to /og-image.png`);
    }
  } else if (image !== pageCard(url)) {
    fail(url, `og:image is ${image}, not this page's card`);
  }
  if (meta(html, "name", "twitter:image") !== meta(html, "property", "og:image")) {
    fail(url, "twitter:image and og:image disagree");
  }

  for (const section of sections(html)) {
    if (!section.hasHeading) continue; // no words of its own; share-pages.mjs says so
    const share = sharePath(url, section.id);
    const target = sectionUrl(url, section.id);
    const shareFile = join(DIST, share.replace(/^\//, "") + ".html");
    if (!existsSync(shareFile)) {
      fail(share, "no share page — run `npm --prefix www run build`");
      continue;
    }
    shareCount += 1;
    const page = readFileSync(shareFile, "utf8");

    if (meta(page, "name", "robots") !== "noindex") fail(share, "is not noindex");
    if (tag(page, /<link rel="canonical" href="([^"]*)"/) !== target) {
      fail(share, `canonical is not ${target}`);
    }
    if (meta(page, "property", "og:url") !== target) fail(share, `og:url is not ${target}`);
    if (meta(page, "property", "og:title") !== section.heading) {
      fail(share, "og:title is not the section heading");
    }
    if (meta(page, "property", "og:description") !== clamp(section.lede)) {
      fail(share, "og:description is not the section's opening line");
    }

    const image = assetFor(meta(page, "property", "og:image"), share);
    if (image === "/og-image.png") fallbacks += 1;
    else if (image !== sectionCard(url, section.id)) fail(share, `og:image is ${image}`);

    // What a reader with scripts blocked gets, which is the whole reason the
    // body is not empty.
    const body = page.slice(page.indexOf("<body"));
    if (!body.includes(section.heading.replace(/&/g, "&amp;"))) {
      fail(share, "the heading is not in the body");
    }
    // Relative on purpose: the tags a crawler reads are absolute, the link a
    // reader follows keeps them on the hostname they arrived on.
    if (!new RegExp(`<a[^>]+href="${url}#${section.id}"`).test(body)) {
      fail(share, "no link through to the section in the body");
    }
    if (/<script/.test(body)) fail(share, "has a script in the body");
  }
}

if (problems > 0) {
  console.error(`\n${problems} preview problem${problems === 1 ? "" : "s"}.`);
  process.exit(1);
}

console.log(
  `${pages.length} page cards, ${shareCount} share pages` +
    (fallbacks ? `, ${fallbacks} on the fallback card — run \`npm --prefix www run og\`` : "") +
    "; every preview resolves.",
);
