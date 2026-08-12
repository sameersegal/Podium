/**
 * The six claims the whole site rests on, in one place.
 *
 * These are not new claims. Every one of them is argued at length on the page
 * it links to. What this file changes is emphasis: the same six facts, stated
 * first, at the size they deserve, and in the same words on every page — a
 * buyer who reads three pages should come away able to say what Podium is in
 * one sentence, and they will only manage that if all three pages used the
 * same sentence.
 *
 * **Who these are for.** The reader has already decided to leave the tool they
 * are renewing; they are pricing the move, not weighing the merits. So the
 * order is what de-risks that move: their agent can change it, the deployment
 * is theirs, the licence is free and irrevocable, one record covers the year,
 * the paid half of the programme is counted rather than chased, and every
 * change leaves the building on a signed webhook.
 *
 * The last one is here because this reader wires the thing into tooling they
 * already run, and a webhook is something they act on rather than infer. It is
 * argued at length under "Always on" on /integrations; what is here is the
 * short form and the count.
 *
 * One earlier pillar is gone. *Open source* and *complete control* were one
 * claim wearing two hats — the licence and the deployment — and each is
 * sharper alone.
 *
 * `evidence` is never rendered. It is what makes each entry checkable in one
 * step, per the rule that no claim ships without a screenshot, a rule in
 * docs/domain/, a path in this repository or a dated third-party source behind
 * it. If you weaken or strengthen a `body` here, move its `evidence` with it.
 *
 * Every count comes from `STATS` in `src/consts.ts` and none is written out
 * here. That file keeps the numbers so each appears once and is checked once,
 * against a documented recipe — a second copy is not a shortcut, it is a number
 * that will be wrong later. A literal below is a literal only where there is
 * nothing to count: the six screens, and the licence.
 *
 * The boundary on the first pillar is load-bearing and must not erode. Agents
 * build this repository, and the management API is built for an agent to call.
 * There is no MCP server and no OpenAPI document, and nothing here may imply
 * one. /fork states the boundary outright, which is why the first pillar
 * points there.
 */
import { STATS } from "../consts";

export interface Pillar {
  /** Under nine words, contains a verb, no colon. */
  heading: string;
  body: string;
  /** The number, where there is one worth showing. */
  stat?: { value: string; unit: string };
  /** File in `public/art/`, without the extension. */
  art: string;
  /** Wordless abstract art still needs to say what it is to a screen reader. */
  alt: string;
  href: string;
  hrefLabel: string;
  evidence: string;
}

export const PILLARS: Pillar[] = [
  {
    heading: "Agents built it, and your agent can change it",
    body: "The rules were written down before the code, and they are still the specification the code answers to. An agent that tries to build outside them stops. A check in the build fails when the code and the document disagree. Fork it and your own agent inherits the same guardrails.",
    stat: { value: String(STATS.invariants), unit: "written rules, checked against the code in CI" },
    art: "agent",
    alt: "Abstract artwork: a thread of light passing cleanly through a series of aligned frames.",
    href: "/fork",
    hrefLabel: "What survives your changes",
    evidence:
      "docs/domain/ is normative (CLAUDE.md); .claude/agents/implementer.md stops when the model does not cover a request; `npm run drift` is a step in the `check` job of .github/workflows/ci.yml; STATS.invariants re-counted at HEAD with the recipe in src/consts.ts.",
  },
  {
    heading: "It deploys into an account in your name",
    body: "Your Cloudflare account, your database, your bucket, your speakers' data. Nobody here can read it, because nobody here has it. Everything comes back out as CSV or over API keys you issue, and a key for your marketing site cannot read a review or a speaker's email.",
    stat: { value: String(STATS.scopes), unit: "API scopes, personal data its own" },
    art: "control",
    alt: "Abstract artwork: a single glowing core held inside a complete cage of luminous struts.",
    href: "/security",
    hrefLabel: "Where your speakers' data lives",
    evidence:
      "scripts/deploy-config.mjs generates the production config from your own D1, KV and hostname; STATS.scopes; the export and erasure sections of /security.",
  },
  {
    heading: "Read every line, and pay for none of it",
    body: "MIT-licensed and on GitHub. No seats, no per-speaker charge, no activation code per conference, no edition that costs more. There is no company here to reprice it once you depend on it, and the licence on the version you hold cannot be revoked.",
    stat: { value: "MIT", unit: "no tiers, no quote, no sales call" },
    art: "open",
    alt: "Abstract artwork: a structure of luminous struts opening outward, its facets drifting apart.",
    href: "/pricing",
    hrefLabel: "The bill, itemised",
    evidence: "LICENSE_URL and GITHUB_URL in src/consts.ts; the LINE_ITEMS table and FAQ on /pricing.",
  },
  {
    heading: "One record runs the whole year",
    body: "The call for proposals, review, decisions, speaker onboarding, sponsor entitlements, the agenda and the schedule your website embeds. Not six tools that each own a fifth of the year and disagree about who is speaking. Attendee ticketing and badging are the part it deliberately leaves alone.",
    stat: { value: "6", unit: "screens covering the year end to end" },
    art: "stack",
    alt: "Abstract artwork: six translucent planes stacked into one tower, joined by threads of light.",
    href: "/features",
    hrefLabel: "The full tour, screen by screen",
    evidence:
      "The six screens on /features, each a photograph from www/scripts/screenshots.mjs. The ticketing exclusion is the ticketing decision in docs/domain/09 and ticketing.stub in src/data/integrations.ts.",
  },
  {
    heading: "Sponsor slots are counted, not chased",
    body: "A package is a countable set of rights — two session slots, a logo placement — and a sponsor session spends one. Used against bought, on the same screen as the deal. A submission that would overspend a package is refused, and cutting a package below what the sponsor has already spent is refused too.",
    art: "events",
    alt: "Abstract artwork: rings of light spreading from one bright node and lighting smaller nodes as they arrive.",
    href: "/demo",
    hrefLabel: "Spend a slot and watch the count",
    evidence:
      "The sponsorships screenshot on / and /features (www/public/screens/sponsorships.png — tier, used against bought, in one bar); INV-03-3 (spent never exceeds bought) and INV-03-4 (a package cannot be cut below what is spent) in docs/domain/03; the third step of the demo tour on /demo.",
  },
  {
    heading: "Every change leaves on a signed webhook",
    body: "A proposal accepted, a task completed, a schedule published: each one goes out signed, to whatever you point it at. Retries back off from a minute to a day, and twenty failures in a row pause the hook. When your endpoint is back, replay that event type across the window it missed.",
    stat: { value: String(STATS.events), unit: "named events you can subscribe to" },
    art: "signal",
    alt: "Abstract artwork: a bead of light travelling along a filament through a receding line of open rings.",
    href: "/integrations",
    hrefLabel: "What comes out on the wire",
    evidence:
      "STATS.events re-counted from EVENT_TYPES in packages/domain/src/events/catalogue.ts (136). The delivery contract in docs/domain/09 — HMAC-SHA256 signature, backoff 1m/5m/30m/2h/6h/24h, twenty consecutive failures pauses the webhook, manual replay of an event type over a time range — implemented as WEBHOOK_BACKOFF_SECONDS and WEBHOOK_FAILURE_LIMIT in packages/domain/src/platform/types.ts and replayEventType in workers/api/src/contexts/platform/routes.ts.",
  },
];
