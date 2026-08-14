#!/usr/bin/env node
/**
 * A share page per section, emitted into `dist/` after the site is built.
 *
 * Runs as the second half of `npm --prefix www run build`, so a section added
 * to a page has its share page in the same build and there is nothing to
 * regenerate by hand. `astro dev` does not run it: to see one locally, build
 * and then `npm --prefix www run preview`.
 *
 * Why these exist. A fragment never reaches the server: crawlers strip it
 * before fetching, so `/fork#plugin` and `/fork` are the same request to
 * Twitterbot and preview as the same card. The address a section can be posted
 * under has to be a real path, which is what `/s/fork/plugin` is — noindex,
 * canonical to `https://podiumstack.com/fork#plugin`, carrying that section's
 * heading, its opening line and its own card.
 *
 * They are plumbing, not pages of the site. Nothing in the nav, the footer, the
 * sitemap or any page body links to one; the only way to reach it is to follow
 * something somebody pasted. `deep-links.mjs` prints the address beside every
 * anchor, and that is the one to paste.
 *
 * The body is a signpost and nothing else: the wordmark, the section's heading,
 * and a link through. A human with scripts on never sees it — the inline script
 * in the head calls `location.replace` before the body paints, and `replace`
 * rather than `assign` so Back returns to the post rather than to this. A human
 * with scripts blocked gets a page that says where they are and one link that
 * finishes the trip, because the site's rule is that the page is complete
 * before any script runs and complete if none does. A blank page with a
 * redirect in it fails that rule.
 *
 * The layout rules are inline rather than in `src/styles/global.css`, which is
 * the one place this file parts from the taste rules on purpose: nobody reading
 * podiumstack.com ever loads this page, and five rules for it in the shared
 * stylesheet would be shipped to every real page instead. Everything else — the
 * ground, the faces, the type scale, the button — is the site's own stylesheet,
 * linked by the hash the build gave it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DIST,
  ORIGIN,
  PUBLIC,
  FALLBACK_CARD,
  clamp,
  sectionCard,
  sectionUrl,
  sections,
  sharePath,
  sitePages,
} from "./lib/site-content.mjs";

const escape = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pages = sitePages();
if (pages.length === 0) {
  console.error("No built pages in www/dist — nothing to make share pages from.");
  process.exit(1);
}

/**
 * Three things taken out of a page that was just built rather than repeated
 * here: the stylesheet, whose filename Astro hashes and therefore changes
 * whenever the stylesheet does, and the site name and handle, which live in
 * `src/consts.ts` and would be a second copy to forget.
 */
const first = readFileSync(pages[0].file, "utf8");
const from = (re, what) => {
  const value = re.exec(first)?.[1];
  if (!value) {
    console.error(`No ${what} in the built pages — has the layout changed?`);
    process.exit(1);
  }
  return value;
};
const stylesheet = from(/<link rel="stylesheet" href="([^"]+)"/, "stylesheet link");
const SITE_TITLE = from(/<meta property="og:site_name" content="([^"]+)"/, "og:site_name");
const SOCIAL_HANDLE = from(/<meta name="twitter:site" content="([^"]+)"/, "twitter:site");

/**
 * `target` is the absolute address, for the tags a crawler reads. `here` is the
 * same place as a path, for the link and the hop: a reader who arrived on
 * www.podiumstack.com stays on the hostname they arrived on, and a preview
 * build on localhost hops to itself rather than off the machine.
 */
function render({ heading, description, target, here, card }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(heading)} · ${SITE_TITLE}</title>
    <meta name="description" content="${escape(description)}" />

    <!-- Never a search result. The section on the real page is the thing; this
         is the address it can be posted under. -->
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="${escape(target)}" />

    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE_TITLE}" />
    <meta property="og:title" content="${escape(heading)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:url" content="${escape(target)}" />
    <meta property="og:image" content="${ORIGIN}${card}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${ORIGIN}${card}" />
    <meta name="twitter:site" content="${SOCIAL_HANDLE}" />
    <meta name="twitter:creator" content="${SOCIAL_HANDLE}" />

    <link rel="icon" href="/favicon.ico" sizes="any" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#FAF9F6" />
    <meta name="theme-color" content="#0B0C0F" />
    <link rel="stylesheet" href="${stylesheet}" />
    <style>
      body { display: grid; place-items: center; min-height: 100vh; padding: 40px 20px; }
      .signpost { max-width: 34rem; text-align: center; }
      .signpost img { width: 163px; height: 48px; margin-bottom: 32px; }
      .signpost h1 { font-size: clamp(28px, 6vw, 40px); line-height: 1.1; margin-bottom: 28px; }
      .signpost .btn { max-width: 100%; height: auto; min-height: 48px; padding: 12px 20px; white-space: normal; overflow-wrap: anywhere; }
    </style>

    <!-- The hop. In the head and inline, so it runs before the body paints and
         the reader lands at the section without this registering as a stop.
         location.replace rather than assign keeps it out of history: Back goes
         to the post, not to this. -->
    <script>location.replace(${JSON.stringify(here)});</script>
  </head>
  <body>
    <div class="signpost">
      <a href="/"><picture>
        <source srcset="/podium-logo-horizontal.png" media="(prefers-color-scheme: light)" />
        <img src="/podium-logo-horizontal-light.png" alt="Podium" width="325" height="96" />
      </picture></a>
      <h1>${escape(heading)}</h1>
      <a class="btn primary" href="${escape(here)}">Continue to ${escape(target.replace("https://", ""))}</a>
    </div>
  </body>
</html>
`;
}

let written = 0;
let missingCards = 0;

for (const { file, url } of pages) {
  const html = readFileSync(file, "utf8");
  for (const section of sections(html)) {
    // A share page's title is the section's heading. Something addressable with
    // no heading has no words of its own to carry, so it gets no share page and
    // says so rather than inventing one from a class name.
    if (!section.hasHeading) {
      console.error(`  ✗ ${url}#${section.id} has no heading — no share page for it`);
      continue;
    }
    const card = sectionCard(url, section.id);
    const onDisk = existsSync(join(PUBLIC, card.replace(/^\//, "")));
    if (!onDisk) missingCards += 1;

    const out = join(DIST, sharePath(url, section.id).replace(/^\//, "") + ".html");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      out,
      render({
        heading: section.heading,
        description: clamp(section.lede),
        target: sectionUrl(url, section.id),
        here: `${url}#${section.id}`,
        card: onDisk ? card : FALLBACK_CARD,
      }),
    );
    written += 1;
  }
}

console.log(
  `${written} share pages in dist/s/` +
    (missingCards ? ` — ${missingCards} on the fallback card; run \`npm run og\`` : ""),
);
