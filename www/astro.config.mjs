// @ts-check
import { defineConfig } from "astro/config";

/**
 * Static output, no adapter. The build is a directory of files that the
 * `podium-www` Worker serves through Cloudflare's static assets binding — there
 * is no server-rendered path and no `main` worker script for one to live in.
 *
 * Note what is deliberately absent: a `redirects` block. Astro implements
 * redirects in static mode by emitting an HTML page with a meta refresh, which
 * is not a 3xx and does not carry a query string. The app-path redirects are
 * real 301/308s and live in `public/_redirects` instead.
 */
export default defineConfig({
  site: "https://podiumstack.com",
  output: "static",
  build: {
    // `/about` rather than `/about/index.html`, matched by the Worker's
    // "auto-trailing-slash" html_handling in wrangler.jsonc.
    format: "file",
  },
});
