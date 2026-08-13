/**
 * The switching page's data.
 *
 * This page used to be a comparison. It is now an estimate: the reader has
 * decided to leave the tool they are renewing and wants to know what the move
 * costs them in the week the call opens. So `MOVES` leads — what comes out of
 * the old tool, what goes into this one, and the four things that do not travel
 * at all — and the product-versus-product material sits under it for the
 * colleague who will ask "why not just use Sessionize?" in the next meeting.
 *
 * A note on what is deliberately *not* here: a feature-by-feature matrix.
 * Building one would mean asserting what two proprietary hosted products do and
 * do not do, from the outside, in a table that is quotable and stale the day
 * their next release ships. Every such table on the internet is written by the
 * vendor who wins it. So `STRUCTURAL` is restricted to licensing, hosting and
 * published packaging — facts that are not in dispute and do not move with a
 * release — and everything that would need a judgement about someone else's
 * roadmap is in `WHERE_THEY_WIN`, stated plainly.
 *
 * `CHECKED` is the date the vendors' own pages were last consulted and is
 * printed on the page. Anyone editing this file updates it or removes the claim.
 */

import { STATS } from "../consts";

export const CHECKED = "August 2026";

export const SESSIONIZE_URL = "https://sessionize.com/pricing";
export const SESSIONBOARD_URL = "https://www.sessionboard.com/pricing";

/**
 * What a migration actually consists of.
 *
 * Every row is checked against the code, not the model, and the two disagree
 * here in a way that matters. The model specifies four import subjects; the
 * writing half of `workers/api/src/contexts/content/import.ts` implements two —
 * `RUNNABLE_SUBJECTS` is `["person", "event_participant"]`, and a session or
 * sponsor import previews and then refuses with "writing them is not
 * implemented yet". So the rows below say people and roster, and say no to the
 * rest. `IMPLEMENTED_FORMATS` in `packages/domain/src/content/export.ts` is the
 * matching list on the way out: `csv`, `json`, `zip`, and pointedly not the
 * `xlsx` and `ics` the enum also names.
 *
 * Where a row says "over the API", the endpoint is in the `/v1` surface and was
 * checked by grep before the row shipped: `POST /v1/sponsors`,
 * `POST /v1/sponsorships`, `POST /v1/entitlements`. There is deliberately no
 * `POST /v1/proposals`, which is why last year's programme cannot be brought
 * across by any route at all.
 */
export const MOVES = [
  {
    item: "Speakers, and everyone else you hold an email address for",
    how: "CSV",
    note: "Headers spelled Speaker Name, E-mail or Employer map themselves. Matching is on email, so re-running the same file updates rather than duplicates.",
  },
  {
    item: "Who is staff, who reviews, who speaks",
    how: "CSV",
    note: "A second pass over the same file with two more columns. Somebody who chaired review last year and submits this year stays one person.",
  },
  {
    item: "Sponsors, their contacts and what they bought",
    how: "API",
    note: "The importer previews sponsor rows and then refuses to write them. Sponsors, sponsorships and entitlements each have a create endpoint, so a loop over your spreadsheet does it. Otherwise it is typing.",
  },
  {
    item: "Last year's sessions and abstracts",
    how: "No",
    note: "Nothing imports them and no endpoint authors them: a session exists here because a decision was published. What carries forward is the people, and a directory that remembers them across editions.",
  },
  {
    item: "Proposals part-way through a review round",
    how: "No",
    note: "Finish the round where it started. Running half a round in each tool is how a proposal ends up with three scores in one place and two in another.",
  },
  {
    item: "Last year's scores, comments and decisions",
    how: "No",
    note: "They stay in whatever your current tool exports. Podium's own trail starts the day you do, and answers \"why was this rejected\" from then on.",
  },
  {
    item: "Slides, headshots and other uploaded files",
    how: "No",
    note: "There is no bulk file import. Accepted speakers upload again during onboarding — chased automatically, but a chase you would not otherwise have had.",
  },
  {
    item: "The schedule on your website",
    how: "Rebuilt",
    note: "Place sessions into rooms and times, and conflicts are computed as you drop them. Publish a snapshot and point your site at it.",
  },
];

/** What changes for the people who did not choose any of this. */
export const SPEAKER_CHANGES = [
  {
    title: "A different link, from you",
    body: "The invitation comes from your event rather than a product they have never heard of, on a hostname you chose.",
  },
  {
    title: "No password to set",
    body: "Password sign-in is off in a production deployment. Speakers arrive on an emailed link, and there is no reset form to forget.",
  },
  {
    title: "They keep their own profile",
    body: "Name, pronouns, bio, headshot, links. What they write is what the public schedule renders, so nobody on your side copy-edits sixty biographies.",
  },
  {
    title: "Whatever they had in the old tool is gone",
    body: "Old submissions, old profile, old history. For a returning speaker that is a bio to paste and a headshot to find again, and they will notice.",
  },
];

/** Who each product is built for. Not a knock on either — a routing decision. */
export const AUDIENCES = [
  {
    name: "Sessionize",
    built_for: "Community tech conferences and user groups.",
    body: "A hosted call for speakers with a long track record in this space, free for non-commercial events and 499 USD plus tax per event occurrence for commercial ones. If your conference fits its shape, it is a good answer and a cheap one.",
    href: SESSIONIZE_URL,
  },
  {
    name: "Sessionboard",
    built_for: "Large commercial events with a content team and a budget line.",
    body: "Speaker CRM, submissions, agenda building, and a catalogue their pricing page puts at 15+ integrations including Zapier, Cvent and Bizzabo. Three plans, the top one a sales conversation. If you are running a trade show with a team to match, this is its category.",
    href: SESSIONBOARD_URL,
  },
  {
    name: "Podium",
    built_for: "AI-Engineer-shaped conferences that want to own the whole thing.",
    body: "Free, MIT-licensed, and it deploys to your own Cloudflare account. Built for the program chair who is also the review chair, sells sponsor sessions, and would rather read the rules than file a ticket to find out what they are.",
    href: null,
  },
];

/**
 * Structural facts only. Each is either public licensing, public packaging, or
 * a property of the architecture — nothing here depends on a feature list.
 */
export const STRUCTURAL = [
  {
    row: "Licence",
    podium: "MIT",
    sessionize: "Proprietary",
    sessionboard: "Proprietary",
  },
  {
    row: "Where it runs",
    podium: "Your Cloudflare account",
    sessionize: "Their servers",
    sessionboard: "Their servers",
  },
  {
    row: "Who holds the speaker data",
    podium: "You do",
    sessionize: "They do",
    sessionboard: "They do",
  },
  {
    row: "What it costs",
    podium: "Nothing to licence; you pay your own hosting",
    sessionize: "Free for non-commercial events; 499 USD + tax per event occurrence otherwise",
    sessionboard: "Three plans with a published monthly price; the top tier is a sales conversation",
  },
  {
    row: "Can you read the source",
    podium: "All of it",
    sessionize: "No",
    sessionboard: "No",
  },
  {
    row: "Can you change it",
    podium: "Fork it",
    sessionize: "Feature request",
    sessionboard: "Feature request",
  },
  {
    row: "Getting your data out",
    podium: "CSV, JSON and ZIP exports, and a REST API, all yours",
    sessionize: "Export and API per their terms",
    sessionboard: "Export and API per their terms",
  },
];

/** The honest half. Nothing here is hedged, and none of it is fixable by copy. */
export const WHERE_THEY_WIN = [
  {
    title: "Nothing to run",
    body: "Both are hosted. You sign up and start. Podium needs somebody to deploy it and keep an eye on it — an afternoon for anyone who has met Cloudflare, and a blocker if there is no such person and no agent doing it for them.",
  },
  {
    title: "Years of conferences behind them",
    body: `Sessionize has run thousands of events, and a decade of edge cases somebody else already hit is worth something you cannot write down. Podium answers with ${STATS.tests} tests and a specification that predates the code. That is the trade, and it is the one to weigh hardest.`,
  },
  {
    title: "Somebody to call",
    body: "They sell support. Podium has an issue tracker answered by the people who wrote it, with no promise about when.",
  },
  {
    title: "Bigger integration catalogues",
    body: "Sessionboard's pricing page counts 15+ integrations, Zapier and the large event platforms among them. Podium ships adapters for email, chat, storage, two-way sync, first-pass review and workshop capacity, and a contract for the rest.",
  },
  {
    title: "The attendee side of the event",
    body: "Podium does no ticketing, no registration, no badge scanning and no attendee app, and is not going to. It asks your ticketing system one question — is this workshop full — and stays out.",
  },
];

/** When to close the tab. Being right about this is worth more than the lead. */
export const NOT_FOR_YOU = [
  "You need registration, badging and the program in one system, from one vendor, on one invoice.",
  "Nobody on the team can deploy and own a web application, and nobody can be hired to.",
  "You need a signed support agreement, a vendor to answer a security questionnaire, or somebody contractually on the hook in March.",
  "You are mid-round, the decisions go out in three weeks, and there is no gap between now and then.",
  "Your event is a hundred people and one track. A spreadsheet is fine, and we would rather you kept it.",
];
