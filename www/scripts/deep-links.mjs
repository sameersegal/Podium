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
 * It reads `dist/`, not `src/`, deliberately. Half the sections on this site are
 * emitted by a component — the closing call to action, the six pillars — and a
 * scan of the pages would miss exactly those. The built HTML is what a reader
 * gets, and it is the only thing that knows.
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
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WWW = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WWW, "dist");
const ORIGIN = "https://podiumstack.com";

const check = process.argv.includes("--check");

/** Every .html in dist, deepest last, in the order a reader meets them. */
function pages(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (entry.endsWith(".html")) out.push(path);
  }
  return out;
}

/**
 * `build.format: "file"` in astro.config.mjs, so /features is features.html and
 * / is index.html. 404.html is skipped: it is noindex and nothing links to it.
 */
function urlFor(file) {
  const rel = relative(DIST, file).replaceAll("\\", "/");
  if (rel === "index.html") return "/";
  return "/" + rel.replace(/\.html$/, "");
}

/**
 * Enough HTML parsing for generated markup and no more. Astro emits the
 * attributes in source order, so `id` is found wherever it was written.
 */
const ID_RE = /<(section|div)\b([^>]*)\bid="([^"]+)"([^>]*)>/g;
const SECTION_RE = /<section\b([^>]*)>/g;
const ANCHOR_RE = /<a class="anchor" href="#([^"]+)"/g;
const HEADING_RE = /<(h1|h2|h3)\b[^>]*>(.*?)<\/\1>/s;

const text = (html) =>
  html
    // The hash the heading carries is a control, not part of what it says.
    .replace(/<a class="anchor"[\s\S]*?<\/a>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

let problems = 0;
const fail = (message) => {
  problems += 1;
  console.error(`  ✗ ${message}`);
};

const files = pages(DIST).filter((f) => !f.endsWith("404.html"));
if (files.length === 0) {
  console.error("No built pages in www/dist — run `npm --prefix www run build` first.");
  process.exit(1);
}

let links = 0;

for (const file of files) {
  const html = readFileSync(file, "utf8");
  const url = urlFor(file);
  const rows = [];
  const seen = new Set();

  for (const m of html.matchAll(ID_RE)) {
    const [, , before, id, after] = m;
    if (id === "main") continue;
    if (seen.has(id)) fail(`${url} uses the id "${id}" twice`);
    seen.add(id);

    // The heading the link lands on, for the person choosing between them.
    const rest = html.slice(m.index + m[0].length);
    const heading = HEADING_RE.exec(rest);
    const cls = /class="([^"]*)"/.exec(before + after)?.[1] ?? "";
    rows.push({
      id,
      heading: heading ? text(heading[2]) : cls || "—",
    });
  }

  for (const m of html.matchAll(SECTION_RE)) {
    const attrs = m[1];
    if (attrs.includes(' id="')) continue;
    if (/\bclass="[^"]*\bhero\b/.test(attrs)) continue; // the page's own URL is its address
    // Sections do not nest here, so the next close tag is this one's.
    const body = html.slice(m.index, html.indexOf("</section>", m.index));
    if (body.includes(' id="')) continue; // a container for parts that are linked to one at a time
    fail(`${url} has a <section> with no id:${attrs.trimEnd()}`);
  }

  for (const m of html.matchAll(ANCHOR_RE)) {
    if (!seen.has(m[1])) fail(`${url} links to #${m[1]}, which is not on the page`);
  }

  if (!check) {
    console.log(`\n${url}`);
    const width = Math.max(...rows.map((r) => r.id.length), 0);
    for (const row of rows) {
      console.log(`  ${ORIGIN}${url}#${row.id.padEnd(width)}   ${row.heading}`);
    }
  }
  links += rows.length;
}

if (check) {
  console.log(
    problems === 0
      ? `${links} deep links across ${files.length} pages; every section has an address.`
      : `\n${problems} problem${problems === 1 ? "" : "s"}.`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

console.log(`\n${links} deep links across ${files.length} pages.`);
