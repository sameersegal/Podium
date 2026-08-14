/**
 * The built site, read back as content: pages, their headings, their sections.
 *
 * Three scripts need the same reading of `dist/` and must never disagree about
 * it — `deep-links.mjs` prints the addresses, `share-pages.mjs` emits a page
 * per section so a fragment can preview, and `og-cards.mjs` draws a card for
 * each. A second parser here would mean a section that has an address, no
 * preview and no card, and nobody would notice until a post went out.
 *
 * It reads `dist/`, not `src/`, for the reason `deep-links.mjs` has always read
 * it: half the sections on this site are emitted by a component — the closing
 * call to action, the six pillars — and a scan of the pages would miss exactly
 * those. The built HTML is what a reader gets, and it is the only thing that
 * knows.
 *
 * Enough HTML parsing for generated markup and no more. Astro emits attributes
 * in source order, so `id` is found wherever it was written.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const WWW = fileURLToPath(new URL("../..", import.meta.url));
export const DIST = join(WWW, "dist");
export const PUBLIC = join(WWW, "public");
export const ORIGIN = "https://podiumstack.com";

/** Where a generated card lands, and the fallback for anything without one. */
export const CARD_DIR = "og";
export const CARD_EXT = ".jpg";
export const FALLBACK_CARD = "/og-image.png";

/** Every .html in dist, deepest last, in the order a reader meets them. */
export function htmlFiles(dir = DIST) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (entry.endsWith(".html")) out.push(path);
  }
  return out;
}

/**
 * `build.format: "file"` in astro.config.mjs, so /features is features.html and
 * / is index.html.
 */
export function urlFor(file) {
  const rel = relative(DIST, file).replaceAll("\\", "/");
  if (rel === "index.html") return "/";
  return "/" + rel.replace(/\.html$/, "");
}

/**
 * The pages of the site, which is what everything here is generated from.
 * 404.html is skipped — it is noindex, nothing links to it, and it keeps the
 * fallback card. The share pages under /s/ are skipped because they are
 * generated *from* this list and are not pages of the site: nothing in the nav,
 * the footer, the sitemap or any page body points at one.
 */
export function sitePages(dir = DIST) {
  return htmlFiles(dir)
    .filter((f) => !f.endsWith("404.html"))
    .filter((f) => !relative(DIST, f).replaceAll("\\", "/").startsWith("s/"))
    .map((file) => ({ file, url: urlFor(file) }));
}

const ID_RE = /<(section|div)\b([^>]*)\bid="([^"]+)"([^>]*)>/g;
const SECTION_RE = /<section\b([^>]*)>/g;
const ANCHOR_RE = /<a class="anchor" href="#([^"]+)"/g;
const HEADING_RE = /<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/;
const EYEBROW_RE = /<span class="eyebrow">([\s\S]*?)<\/span>/g;
const PARA_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/g;

export const text = (html) =>
  html
    // The hash the heading carries is a control, not part of what it says.
    .replace(/<a class="anchor"[\s\S]*?<\/a>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The top of a page in its own words: the hero on the landing page, the page
 * head everywhere else. This is where a page's card copy comes from, so the
 * card can only ever say what the page says.
 */
export function pageHead(html) {
  // Both blocks open on the same three things in the same order and end on the
  // lede, so the slab is everything up to the close of that paragraph. What
  // follows it is buttons on some pages and a screenshot on the landing page,
  // and neither is copy.
  const start = html.search(/<section class="hero">|<div class="pagehead">/);
  if (start < 0) return null;
  const ledeStart = html.indexOf('<p class="lede">', start);
  if (ledeStart < 0) return null;
  const slab = html.slice(start, html.indexOf("</p>", ledeStart) + 4);
  const heading = HEADING_RE.exec(slab);
  if (!heading) return null;
  return {
    eyebrow: text(/<span class="eyebrow">([\s\S]*?)<\/span>/.exec(slab)?.[1] ?? ""),
    heading: text(heading[2]),
    lede: text(/<p class="lede">([\s\S]*?)<\/p>/.exec(slab)?.[1] ?? ""),
  };
}

/**
 * Every addressable section on a page, with the words that belong to it.
 *
 *   heading    the h1/h2/h3 the link lands on
 *   eyebrow    the section's own label where it has one; a section that does
 *              not carry one — the closing call to action, the six feature
 *              rows — borrows the page's, which is still the page's own words
 *   lede       the section's opening paragraph, and the page's lede where the
 *              section opens on a table, a grid or a code block instead
 *
 * The bound matters: each section's prose is searched only as far as the next
 * addressable thing, so a section with no paragraph of its own borrows the page
 * rather than quietly claiming the next section's sentence.
 */
export function sections(html) {
  const head = pageHead(html);
  const marks = [];
  for (const m of html.matchAll(ID_RE)) {
    const [, , before, id, after] = m;
    if (id === "main") continue;
    marks.push({ id, start: m.index, bodyStart: m.index + m[0].length, before, after });
  }

  return marks.map((mark, i) => {
    const end = marks[i + 1]?.start ?? html.length;
    const body = html.slice(mark.bodyStart, end);
    const heading = HEADING_RE.exec(body);
    const cls = /class="([^"]*)"/.exec(mark.before + mark.after)?.[1] ?? "";

    // The eyebrow sits above the heading; anything after it belongs to a card
    // or a row inside the section.
    const aboveHeading = heading ? body.slice(0, heading.index) : "";
    const eyebrow = [...aboveHeading.matchAll(EYEBROW_RE)].at(-1)?.[1];

    // The first paragraph after the heading, and only if no further heading
    // intervenes: on the switching page the section head is followed straight
    // by three named cards, and "Community tech conferences and user groups"
    // is a sentence about Sessionize, not about the section.
    let lede = "";
    if (heading) {
      const rest = body.slice(heading.index + heading[0].length);
      const para = PARA_RE.exec(rest);
      PARA_RE.lastIndex = 0;
      if (para && !/<h[123]\b/.test(rest.slice(0, para.index))) lede = text(para[1]);
    }

    return {
      id: mark.id,
      heading: heading ? text(heading[2]) : cls || "—",
      hasHeading: Boolean(heading),
      eyebrow: eyebrow ? text(eyebrow) : (head?.eyebrow ?? ""),
      lede: lede || head?.lede || "",
      borrowedLede: !lede,
    };
  });
}

/** Rule 1's exceptions, and the sections that break it. See deep-links.mjs. */
export function sectionsWithoutId(html) {
  const out = [];
  for (const m of html.matchAll(SECTION_RE)) {
    const attrs = m[1];
    if (attrs.includes(' id="')) continue;
    if (/\bclass="[^"]*\bhero\b/.test(attrs)) continue; // the page's own URL is its address
    // Sections do not nest here, so the next close tag is this one's.
    const body = html.slice(m.index, html.indexOf("</section>", m.index));
    if (body.includes(' id="')) continue; // a container for parts that are linked to one at a time
    out.push(attrs.trimEnd());
  }
  return out;
}

/** Every in-page anchor link, for the rule that says each one must resolve. */
export function anchorTargets(html) {
  return [...html.matchAll(ANCHOR_RE)].map((m) => m[1]);
}

/**
 * The slug a page contributes to a share path and a card filename. `/` is
 * `home` — a name no page of this site uses, and one that stays readable in a
 * pasted URL.
 */
export function slugFor(url) {
  return url === "/" ? "home" : url.replace(/^\//, "");
}

/** Where a section's share page lives. `/fork#plugin` -> `/s/fork/plugin`. */
export function sharePath(url, id) {
  return `/s/${slugFor(url)}/${id}`;
}

/** The real address a share page stands in for, and canonicalises to. */
export function sectionUrl(url, id) {
  return `${ORIGIN}${url}#${id}`;
}

/** Where a card lives. One per page, one per section, mirroring the paths. */
export function pageCard(url) {
  return `/${CARD_DIR}/${slugFor(url)}${CARD_EXT}`;
}
export function sectionCard(url, id) {
  return `/${CARD_DIR}/${slugFor(url)}/${id}${CARD_EXT}`;
}

/**
 * A meta description, and the same words go on the card. Whole sentences where
 * they fit, because a line cut mid-clause reads as broken in a preview.
 *
 * Three cuts, in order of how well the result reads. A sentence end and no
 * ellipsis. A clause end — the landing page's tour opens on a 194-character
 * list and the least bad place to stop it is after a comma. A word boundary,
 * which nothing on the site currently needs.
 */
export function clamp(prose, limit = 200) {
  const s = prose.trim();
  if (s.length <= limit) return s;

  // Cut points rather than sentences: a full stop ends a sentence only when a
  // space follows it, which is what keeps "app.podiumstack.com" in one piece.
  const last = (re) => {
    let cut = 0;
    for (const m of s.matchAll(re)) {
      if (m.index + 1 > limit) break;
      cut = m.index + 1;
    }
    return cut;
  };

  const sentence = last(/[.!?](?=\s)/g);
  if (sentence) return s.slice(0, sentence);

  const clause = last(/[,;:](?=\s)/g);
  if (clause) return s.slice(0, clause - 1) + "…";

  return s.slice(0, s.lastIndexOf(" ", limit - 1)).trim() + "…";
}
