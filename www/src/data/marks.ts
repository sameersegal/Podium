/**
 * Brand marks for the logo strips, as path data rather than image files.
 *
 * Two rules govern this file, and both exist because a logo is the easiest
 * thing on a marketing site to get quietly wrong.
 *
 * **Nothing here is drawn by us.** Every `path` below is the brand's own mark,
 * copied verbatim from simple-icons (CC0, https://simpleicons.org) at v16.28.0.
 * An approximated logo is an invented logo, and the site's own rule against
 * those exists for the same reason as the rule against mockups: a reader who
 * catches one stops believing the screenshots too.
 *
 * **A name with no mark stays a name.** Slack and SendGrid were withdrawn from
 * simple-icons at their owners' request, so there is no mark here we are free
 * to use, and there is no version of "close enough" that is honest. They appear
 * in the strip as a wordmark set in the site's own type — naming a product in
 * text is not a claim about its logo. This is why `path` is optional and why
 * the strip is laid out as name-with-optional-glyph rather than glyph-only: a
 * row that can lose a glyph without losing an entry is a row that never tempts
 * anyone to fabricate the missing one.
 *
 * `viewBox` is 24×24 for every entry, which is what lets one CSS rule size the
 * whole strip. The `path` is a single compound path per mark, filled with
 * `currentColor` — the strip is monochrome, so a brand's own colours are never
 * reproduced and never wrong.
 */
export interface Mark {
  /** The brand's own name, spelled and capitalised as the brand spells it. */
  name: string;
  /** Compound path in a 24×24 box, or omitted where we have no usable mark. */
  path?: string;
  /**
   * What in this repository makes it true that we use this. Never rendered —
   * it is here so the next person to touch the strip can check an entry in one
   * step rather than trusting it.
   */
  evidence: string;
}

export const MARKS: Record<string, Mark> = {
  cloudflare: {
    name: "Cloudflare Workers",
    evidence: "wrangler.jsonc — the app deploys to Workers, with D1, KV, R2, Queues and Durable Object bindings",
    path: "m8.213.063 8.879 12.136-8.67 11.739h2.476l8.665-11.735-8.89-12.14Zm4.728 0 9.02 11.992-9.018 11.883h2.496L24 12.656v-1.199L15.434.063ZM7.178 2.02.01 11.398l-.01 1.2 7.203 9.644 1.238-1.676-6.396-8.556 6.361-8.313Z",
  },
  typescript: {
    name: "TypeScript",
    evidence: "package.json devDependencies — typescript ^5.9.2; `npm run typecheck` is one of the four green commands",
    path: "M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75c.612 0 1.154.037 1.627.111a6.38 6.38 0 0 1 1.306.34v2.458a3.95 3.95 0 0 0-.643-.361 5.093 5.093 0 0 0-.717-.26 5.453 5.453 0 0 0-1.426-.2c-.3 0-.573.028-.819.086a2.1 2.1 0 0 0-.623.242c-.17.104-.3.229-.393.374a.888.888 0 0 0-.14.49c0 .196.053.373.156.529.104.156.252.304.443.444s.423.276.696.41c.273.135.582.274.926.416.47.197.892.407 1.266.628.374.222.695.473.963.753.268.279.472.598.614.957.142.359.214.776.214 1.253 0 .657-.125 1.21-.373 1.656a3.033 3.033 0 0 1-1.012 1.085 4.38 4.38 0 0 1-1.487.596c-.566.12-1.163.18-1.79.18a9.916 9.916 0 0 1-1.84-.164 5.544 5.544 0 0 1-1.512-.493v-2.63a5.033 5.033 0 0 0 3.237 1.2c.333 0 .624-.03.872-.09.249-.06.456-.144.623-.25.166-.108.29-.234.373-.38a1.023 1.023 0 0 0-.074-1.089 2.12 2.12 0 0 0-.537-.5 5.597 5.597 0 0 0-.807-.444 27.72 27.72 0 0 0-1.007-.436c-.918-.383-1.602-.852-2.053-1.405-.45-.553-.676-1.222-.676-2.005 0-.614.123-1.141.369-1.582.246-.441.58-.804 1.004-1.089a4.494 4.494 0 0 1 1.47-.629 7.536 7.536 0 0 1 1.77-.201zm-15.113.188h9.563v2.166H9.506v9.646H6.789v-9.646H3.375z",
  },
  vitest: {
    name: "Vitest",
    evidence: "package.json devDependencies — vitest ^4.1.10 with @cloudflare/vitest-pool-workers; STATS.tests in src/consts.ts",
    path: "M11.545 23.3a.613.613 0 0 1-.895.197L.252 15.936A.61.61 0 0 1 0 15.439V6.325c0-.502.569-.792.975-.497l6.358 4.624c.594.433 1.432.25 1.793-.39L14.393.7a.62.62 0 0 1 .535-.314h8.455a.613.613 0 0 1 .537.916z",
  },
  github: {
    name: "GitHub",
    evidence: "GITHUB_URL in src/consts.ts — the source and the MIT licence",
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  claudecode: {
    name: "Claude Code",
    evidence: "CLAUDE.md, .claude/agents/ and .claude/skills/ — the agents and skills that build this repository",
    path: "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z",
  },
  airtable: {
    name: "Airtable",
    evidence: "sync.airtable in src/data/integrations.ts, checked against packages/plugins/src/registry.ts",
    path: "M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z",
  },
  resend: {
    name: "Resend",
    evidence: "email.resend in src/data/integrations.ts, checked against packages/plugins/src/registry.ts",
    path: "M14.679 0c4.648 0 7.413 2.765 7.413 6.434s-2.765 6.434-7.413 6.434H12.33L24 24h-8.245l-8.88-8.44c-.636-.588-.93-1.273-.93-1.86 0-.831.587-1.565 1.713-1.883l4.574-1.224c1.737-.465 2.936-1.81 2.936-3.572 0-2.153-1.761-3.4-3.939-3.4H0V0z",
  },
  slack: {
    name: "Slack",
    evidence: "chat.slack in src/data/integrations.ts. No mark: withdrawn from simple-icons at the owner's request.",
  },
  sendgrid: {
    name: "SendGrid",
    evidence: "email.sendgrid in src/data/integrations.ts. No mark: withdrawn from simple-icons at the owner's request.",
  },
};

/** Where the product runs and what built it. The provenance strip. */
export const BUILT_WITH = ["cloudflare", "typescript", "vitest", "claudecode", "github"] as const;

/** Providers with an adapter you can install today. The catalogue strip. */
export const CONNECTS_TO = ["resend", "sendgrid", "slack", "airtable", "cloudflare"] as const;
