/**
 * The comparison page's data.
 *
 * A note on what is deliberately *not* here: a feature-by-feature matrix.
 *
 * Building one would mean asserting what two proprietary hosted products do
 * and do not do, from the outside, in a table that is quotable and dated the
 * day their next release ships. Every such table on the internet is written by
 * the vendor who wins it. So the table below is restricted to structural facts
 * about each product that are not in dispute and do not change with a release —
 * how it is licensed, where the data sits, how it is priced — and everything
 * that would require a judgement about someone else's roadmap is instead in
 * `WHERE_THEY_WIN`, stated plainly.
 *
 * `CHECKED` is the date the vendors' own pages were last consulted and is
 * printed on the page. Anyone editing this file updates it or removes the claim.
 */

export const CHECKED = "August 2026";

export const SESSIONIZE_URL = "https://sessionize.com/pricing";
export const SESSIONBOARD_URL = "https://www.sessionboard.com/pricing";

/** Who each product is built for. Not a knock on either — a routing decision. */
export const AUDIENCES = [
  {
    name: "Sessionize",
    built_for: "Community tech conferences and user groups.",
    body: "A hosted call for speakers with a long track record in this space. Free for community events, priced per event for commercial ones. If your conference fits its shape, it is a good answer.",
    href: SESSIONIZE_URL,
  },
  {
    name: "Sessionboard",
    built_for: "Large commercial events with a content team and a budget line.",
    body: "Speaker CRM, submissions, agenda building, and a catalogue of integrations with the big event platforms. Sold through a demo request. If you are running a 10,000-person trade show with a team to match, this is its category.",
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
    sessionize: "Free for community events, per-event pricing published for commercial ones",
    sessionboard: "Plans published, prices on request",
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
    podium: "CSV export and a REST API, both yours",
    sessionize: "Export and API per their terms",
    sessionboard: "Export and API per their terms",
  },
];

/** The honest half. Nothing here is hedged, and none of it is fixable by copy. */
export const WHERE_THEY_WIN = [
  {
    title: "Nothing to run",
    body: "Both are hosted. You sign up and start. Podium needs somebody to deploy it once and keep an eye on it — an afternoon for an engineer, a blocker if there is no such person.",
  },
  {
    title: "Years of conferences behind them",
    body: "Sessionize has run thousands of events. Podium is new. You get a full test suite and a written specification instead of a decade of edge cases somebody else already found. If that trade sounds bad, it should.",
  },
  {
    title: "Somebody to call",
    body: "They sell support. Podium has an issue tracker answered by the people who wrote it, with no promise about when.",
  },
  {
    title: "Bigger integration catalogues",
    body: "Sessionboard in particular connects to the large event platforms: registration, badging, the expo floor. Podium ships adapters for email, chat, storage, two-way sync and workshop capacity, and a contract for the rest.",
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
  "Your event is a hundred people and one track. A spreadsheet is fine, and we would rather you kept it.",
];
