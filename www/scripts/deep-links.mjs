/**
 * Every deep link on podiumstack.com, read out of the built site.
 *
 *   npm --prefix www run links            # the catalogue, to paste into a post
 *   npm --prefix www run links -- --check # fail if a section has no address
 *
 * Why this exists: the pages here are long and their arguments are separable,
 * so a post about sponsor entitlements should land on the sponsor section and
 * not at the top of a page the reader then has to scan. Every section carries
 * an id for that. This prints them, with the heading each one lands on, so the
 * URL you paste is one you have seen resolve rather than one you remembered.
 *
 * **Paste the share URL, not the anchor.** Both are printed and both land the
 * reader in the same place. The difference is what a preview bot sees: a
 * fragment is never sent to the server, so `/fork#plugin` and `/fork` are the
 * same request to Twitterbot and preview as the same card. The `/s/…` address
 * is a real page carrying that section's heading, its opening line and its own
 * card, and it bounces a human to the section on arrival. `share-pages.mjs`
 * emits one per row below.
 *
 * It reads `dist/`, not `src/` — `lib/site-content.mjs` holds that reasoning
 * and the parsing, because three scripts depend on reading the built site the
 * same way.
 *
 * `--check` holds three rules and exits non-zero on any of them:
 *
 *   1. Every <section> has an id. A section without one cannot be linked to,
 *      and nobody notices until they try.
 *   2. No id appears twice on a page. A duplicate makes the first one
 *      unreachable and the browser will not tell you.
 *   3. Every anchor link resolves on its own page.
 *
 * Two sections legitimately have no id, and rule 1 lets them through. The hero
 * at the top of the landing page, because the top of a page is addressed by the
 * page's own URL. And a section that is only a container for parts that each
 * have their own id — the six screens on /features are linked to one at a time,
 * and an id on the box around them would land a reader on the first one while
 * claiming to be about all six.
 *
 * The share pages and the cards are checked separately, by `check-previews.mjs`
 * against the same build, and that one runs as part of `npm run build`.
 */
import { readFileSync } from "node:fs";
import {
  ORIGIN,
  anchorTargets,
  sections,
  sectionsWithoutId,
  sharePath,
  sitePages,
} from "./lib/site-content.mjs";

const check = process.argv.includes("--check");

let problems = 0;
const fail = (message) => {
  problems += 1;
  console.error(`  ✗ ${message}`);
};

const pages = sitePages();
if (pages.length === 0) {
  console.error("No built pages in www/dist — run `npm --prefix www run build` first.");
  process.exit(1);
}

let links = 0;

for (const { file, url } of pages) {
  const html = readFileSync(file, "utf8");
  const rows = sections(html);
  const seen = new Set();

  for (const row of rows) {
    if (seen.has(row.id)) fail(`${url} uses the id "${row.id}" twice`);
    seen.add(row.id);
  }

  for (const attrs of sectionsWithoutId(html)) fail(`${url} has a <section> with no id:${attrs}`);

  for (const target of anchorTargets(html)) {
    if (!seen.has(target)) fail(`${url} links to #${target}, which is not on the page`);
  }

  if (!check) {
    console.log(`\n${url}`);
    const width = Math.max(...rows.map((r) => r.id.length), 0);
    const shareWidth = Math.max(...rows.map((r) => sharePath(url, r.id).length), 0);
    for (const row of rows) {
      const anchor = `${ORIGIN}${url}#${row.id.padEnd(width)}`;
      const share = `${ORIGIN}${sharePath(url, row.id)}`.padEnd(ORIGIN.length + shareWidth);
      console.log(`  ${share}   ${anchor}   ${row.heading}`);
    }
  }
  links += rows.length;
}

if (check) {
  console.log(
    problems === 0
      ? `${links} deep links across ${pages.length} pages; every section has an address.`
      : `\n${problems} problem${problems === 1 ? "" : "s"}.`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

console.log(`\n${links} deep links across ${pages.length} pages.`);
console.log("Left column is the one to paste: it previews as the section, not as the page.");
