/**
 * Every outbound link, the nav, and the numbers the pages quote — in one place.
 *
 * The app's own code deliberately does not know what hostname it is served on
 * — it takes `PUBLIC_BASE_URL` at deploy time. This site is the one place that
 * does know, because pointing at the app is its job. Keeping the value here
 * rather than inline in the markup means the marketing site has exactly one
 * fact to change if the app ever moves again, and `public/_redirects` is the
 * other. There is no third.
 */
export const APP_URL = "https://app.podiumstack.com";
export const SIGN_IN_URL = `${APP_URL}/login`;

export const GITHUB_URL = "https://github.com/sameersegal/Podium";
export const DOMAIN_MODEL_URL = `${GITHUB_URL}/blob/main/docs/domain/README.md`;
export const IMPLEMENTATION_URL = `${GITHUB_URL}/blob/main/docs/implementation.md`;
export const API_DOC_URL = `${GITHUB_URL}/blob/main/docs/domain/09-api-and-integrations.md`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;

/**
 * `podiumstack` is the one qualifier the product uses wherever the bare word is
 * taken — this domain, the npm scope, and this handle. There is no second one,
 * so if the handle ever moves, these two lines move with it and nothing else.
 */
export const SOCIAL_HANDLE = "@podiumstack";
export const SOCIAL_URL = "https://x.com/podiumstack";

export const SITE_TITLE = "Podium";
export const SITE_DESCRIPTION =
  "Run your conference program without the spreadsheets. Podium handles the call for proposals, review, sponsor sessions, speaker onboarding and the schedule on your website. Open source, and it runs on infrastructure you own.";

/**
 * The nav. Five items is comfortable and seven is the ceiling; the primary
 * action is deliberately not one of them — it sits beside them, styled as an
 * action, so there is never a question of which link the page wants pressed.
 *
 * Every page here is also in the footer and in `public/sitemap.xml`. A page
 * added to one and not the others is a page nobody arrives at.
 */
export const NAV = [
  { href: "/features", label: "Features" },
  { href: "/integrations", label: "Integrations" },
  { href: "/compare", label: "Compare" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
] as const;

/**
 * Counts quoted on the pages, kept here so a number appears once and is checked
 * once. Each is measured from this repository at the commit that last touched
 * this file — regenerate rather than estimate:
 *
 *   tests        npm test (the summary line)
 *   events       length of EVENT_TYPES in packages/domain/src/events/catalogue.ts
 *   invariants   grep -ho 'INV-[0-9][0-9]-[0-9]*' docs/domain/*.md | sort -u | wc -l
 *   scopes       length of API_SCOPES in packages/domain/src/shared/authorization.ts
 *   capabilities members of the capability enum in docs/domain/09
 *   adapters     entries in PLUGINS in packages/plugins/src/registry.ts
 *   endpoints    grep -rhoE '\b(get|post|put|patch|del|delete)\(\s*"/v1[^"]*"' \
 *                  workers/api/src | sort -u | wc -l   (method + path pairs)
 *   routes       the route-inventory total from `npm run security`
 */
export const STATS = {
  tests: 750,
  events: 136,
  invariants: 161,
  scopes: 22,
  capabilities: 11,
  adapters: 9,
  endpoints: 190,
  routes: 510,
} as const;

/**
 * The demo sign-ins, copied from `README.md`. These are seed personas on a
 * database that is reset, not people — publishing them is the point, since a
 * "see it running" link that lands on a login form nobody can pass is a dead
 * end dressed up as a call to action.
 */
export const DEMO_PERSONAS = [
  {
    role: "Organizer / program chair",
    email: "sbek-organizer@example.com",
    password: "SbekTest!2027-org",
    lands: "/admin",
    sees: "Every event, the proposal board, the agenda, sponsors and the publish queue.",
  },
  {
    role: "Reviewer",
    email: "sbek-reviewer@example.com",
    password: "SbekTest!2027-rev",
    lands: "/review",
    sees: "A queue of assigned proposals, a rubric, and the ones a conflict blocks.",
  },
  {
    role: "Speaker",
    email: "sbek-speaker@example.com",
    password: "SbekTest!2027-spk",
    lands: "/portal",
    sees: "One accepted talk, its room and time, and what is still outstanding.",
  },
] as const;
