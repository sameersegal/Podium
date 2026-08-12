/**
 * The five claims the whole site rests on, in one place.
 *
 * These are not new claims. Every one of them was already argued somewhere on
 * this site, in a paragraph a reader had to reach the middle of a page to find.
 * What this file changes is emphasis: the same five facts, stated first, at the
 * size they deserve, and repeated in the same words on every page — because a
 * buyer who reads three pages should come away able to say what Podium is in
 * one sentence, and they will only manage that if all three pages used the
 * same sentence.
 *
 * `evidence` is never rendered. It is what makes each entry checkable in one
 * step, per the rule that no claim ships without a screenshot, a rule in
 * docs/domain/, a path in this repository or a dated third-party source behind
 * it. If you weaken or strengthen a `body` here, move its `evidence` with it.
 *
 * Every count comes from `STATS` in `src/consts.ts` and none is written out
 * here. That file keeps the numbers so each appears once and is checked once,
 * against a documented recipe — and a second copy is not a shortcut, it is a
 * number that will be wrong later. Two of the eight in `STATS` had already
 * drifted that way by the time this file was written, in the only direction
 * they can drift, because commits add tests and invariants and nothing re-runs
 * the count. A literal below is a literal only where there is nothing to count:
 * the six screens, and the licence.
 *
 * The boundary on the first pillar is load-bearing and must not erode. Agents
 * build this repository; the API is built for an agent to call. There is no
 * bundled assistant, no MCP server, no OpenAPI document and no organizer-facing
 * skill, and nothing here may imply one. `/integrations` states this outright,
 * which is why the first pillar points there.
 */
import { STATS } from "../consts";

export interface Pillar {
  /** Two words for the rail under the hero. */
  label: string;
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
    label: "AI agent first",
    heading: "Agents built it, and an agent can drive it",
    body: "Podium is written by coding agents held to a specification that comes before the code. One refuses a request the model does not cover; another checks the code back against the model and fails the build in CI. The management API is shaped for the same caller — every write takes an idempotency key, and a refusal names the rule it broke rather than returning a bare 400.",
    stat: { value: String(STATS.endpoints), unit: "endpoints on one versioned API" },
    art: "agent",
    alt: "Abstract artwork: a thread of light passing cleanly through a series of aligned frames.",
    href: "/integrations",
    hrefLabel: "What an agent needs to drive it",
    evidence:
      "CLAUDE.md, .claude/agents/implementer.md, .claude/skills/domain-drift/, `npm run drift`; STATS.endpoints; AGENT_PROPERTIES in src/data/integrations.ts, each row cited to docs/domain/09 or 11 in that file's comment.",
  },
  {
    label: "The whole program",
    heading: "Run the whole program off one record",
    body: "The call for proposals, review, decisions, speaker onboarding, sponsor entitlements, the agenda and the schedule your website embeds. Not six tools that each own a fifth of the year and disagree about who is speaking. It does no attendee ticketing or badging, which is the one part it deliberately leaves to the tool you already have.",
    stat: { value: "6", unit: "screens covering the year end to end" },
    art: "stack",
    alt: "Abstract artwork: six translucent planes stacked into one tower, joined by threads of light.",
    href: "/features",
    hrefLabel: "The full tour, screen by screen",
    evidence:
      "The six screens on /features, each a photograph from www/scripts/screenshots.mjs. The ticketing exclusion is the ticketing decision in docs/domain/09 and ticketing.stub in src/data/integrations.ts.",
  },
  {
    label: "Open source",
    heading: "Read every line, and pay for none of it",
    body: "MIT-licensed and on GitHub, with no seats, no per-speaker charge, no activation code per conference and no edition that costs more. There is no company here to change the price after you depend on it, and the licence for the version you have cannot be revoked.",
    stat: { value: "MIT", unit: "no tiers, no quote, no sales call" },
    art: "open",
    alt: "Abstract artwork: a structure of luminous struts opening outward, its facets drifting apart.",
    href: "/pricing",
    hrefLabel: "What it actually costs to run",
    evidence: "LICENSE_URL and GITHUB_URL in src/consts.ts; the LINE_ITEMS table and FAQ on /pricing.",
  },
  {
    label: "Complete control",
    heading: "It deploys into an account in your name",
    body: "Your Cloudflare account, your database, your bucket, your speakers' data. Nobody at this project can read it, because nobody at this project has it. Everything comes back out as CSV or over API keys you issue, and a key for your marketing site cannot read a review or a speaker's email.",
    stat: { value: String(STATS.scopes), unit: "API scopes, personal data its own" },
    art: "control",
    alt: "Abstract artwork: a single glowing core held inside a complete cage of luminous struts.",
    href: "/security",
    hrefLabel: "Where your speakers' data lives",
    evidence:
      "STATS.scopes; the ALWAYS_ON entry on API scopes in src/data/integrations.ts; the export and erasure sections of /security.",
  },
  {
    label: "Event-driven",
    heading: "Every change announces itself",
    body: "Every fact the platform records is published as a named event — a proposal accepted, a task completed, a schedule published. Each arrives on a signed webhook, at least once, with retries and a dead-letter queue you can replay from. You subscribe to the ones you care about instead of polling for them.",
    stat: { value: String(STATS.events), unit: "named events you can subscribe to" },
    art: "events",
    alt: "Abstract artwork: rings of light spreading from one bright node and lighting smaller nodes as they arrive.",
    href: "/integrations",
    hrefLabel: "The events, and the delivery contract",
    evidence:
      "STATS.events, counted from EVENT_TYPES in packages/domain/src/events/catalogue.ts; the signed-webhooks entry in ALWAYS_ON, sourced from docs/domain/09 'Delivery contract'.",
  },
];
