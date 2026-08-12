/**
 * The sitemap, generated rather than kept by hand.
 *
 * Astro's sitemap integration is deliberately not used: it is one dependency
 * and one build step for eight URLs, and it would still need this file's list
 * of which of them matter. A page added to `PAGES` here, to `NAV` in consts and
 * to the footer is a page that can be arrived at three ways; a page in fewer
 * than all three is the bug this comment exists to prevent.
 *
 * `404` is absent on purpose — it is `noindex`, and listing it would ask a
 * crawler to index the one page that says nothing is here.
 */
import type { APIRoute } from "astro";

const PAGES = [
  { path: "/", priority: "1.0" },
  { path: "/features", priority: "0.9" },
  { path: "/integrations", priority: "0.8" },
  { path: "/compare", priority: "0.8" },
  { path: "/fork", priority: "0.8" },
  { path: "/pricing", priority: "0.8" },
  { path: "/demo", priority: "0.9" },
  { path: "/security", priority: "0.7" },
];

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? "https://podiumstack.com";
  const urls = PAGES.map(
    (p) => `  <url>\n    <loc>${origin}${p.path}</loc>\n    <priority>${p.priority}</priority>\n  </url>`,
  ).join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
};
