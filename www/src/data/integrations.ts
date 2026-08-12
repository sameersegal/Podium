/**
 * What the product actually integrates with, as data rather than prose.
 *
 * Every entry here is checked against `packages/plugins/src/registry.ts` (the
 * adapters that exist) and the capability enum in
 * `docs/domain/09-api-and-integrations.md` (the contracts that are specified).
 * The two are different lists on purpose: a contract with no adapter is an
 * honest "not yet", and printing it as though it shipped is the exact failure
 * this file exists to prevent.
 *
 * `display` is the name the organizer sees in the install picker, copied from
 * the plugin's own `display_name` so the site and the product agree.
 */

export interface Adapter {
  display: string;
  /** The plugin key, shown because it is what a self-hoster configures. */
  key: string;
  blurb: string;
}

export interface CapabilityGroup {
  capability: string;
  /** One sentence: what the core asks a provider of this capability to do. */
  contract: string;
  adapters: Adapter[];
}

/** Capabilities with a shipped adapter. */
export const SHIPPED: CapabilityGroup[] = [
  {
    capability: "Email",
    contract:
      "Put this rendered message on the wire, and tell us when it bounced. Templating, batching, quiet hours, digesting and suppression stay on our side of the line.",
    adapters: [
      {
        display: "Resend",
        key: "email.resend",
        blurb:
          "Point it at a verified domain and every acceptance, reminder and campaign goes out through it. Bounces and complaints come back on a signed callback and land on the suppression list without anyone watching for them.",
      },
      {
        display: "SendGrid",
        key: "email.sendgrid",
        blurb:
          "The same contract, a different provider. Swapping one for the other is an install and a default flag — no template, schedule or audit trail is rewritten, because none of them ever belonged to the provider.",
      },
      {
        display: "Outbox only (no provider)",
        key: "email.log",
        blurb:
          "The default when nothing is installed. Every message is composed, rendered and recorded — and never sent. It is how you rehearse a decision announcement to four hundred speakers without sending one.",
      },
    ],
  },
  {
    capability: "Two-way sync",
    contract:
      "List tables, describe their columns, upsert by id, enumerate what changed. Six methods, none of which know what a proposal is.",
    adapters: [
      {
        display: "Airtable",
        key: "sync.airtable",
        blurb:
          "A live mirror of proposals, sessions, speakers and sponsors in a base your AV contractor and sponsorship lead can open — with linked records, single-selects and attachments, not a wall of text. Pick which fields come back, and Podium stays the record of truth for the rest.",
      },
    ],
  },
  {
    capability: "Chat",
    contract: "Post this into that channel.",
    adapters: [
      {
        display: "Slack",
        key: "chat.slack",
        blurb:
          "New submissions, decisions and publication into the committee channel, so the people who need to know are not waiting on someone to remember to tell them.",
      },
    ],
  },
  {
    capability: "Assets",
    contract: "Hand back a presigned upload, a presigned download, a delete.",
    adapters: [
      {
        display: "Object storage (R2)",
        key: "storage.r2",
        blurb:
          "Headshots, slides and recordings upload straight from the browser to your bucket. File bytes never pass through the application, which is why a 200 MB deck does not become a request timeout.",
      },
    ],
  },
  {
    capability: "First-pass review",
    contract: "Score this proposal against this rubric, and say why.",
    adapters: [
      {
        display: "First-pass triage (local, no model)",
        key: "analytics.local_evaluator",
        blurb:
          "Off unless you switch it on, and its opinions are counted beside your reviewers' rather than mixed into them — a machine score never contributes to quorum. The shipped evaluator calls no external model; the contract is there so you can point it at one you trust.",
      },
    ],
  },
  {
    capability: "Ticketing",
    contract: "Is this workshop full? Nothing else.",
    adapters: [
      {
        display: "Ticketing (local stub)",
        key: "ticketing.stub",
        blurb:
          "One method on purpose. Registration lives in your ticketing system and attendees are not modelled here — the only thing the schedule needs back is whether a workshop has room left, cached into the published snapshot so a public page never calls your provider.",
      },
    ],
  },
];

/**
 * Contracts specified in the model with no adapter shipped yet. On the page
 * under a heading that says exactly that.
 */
export const CONTRACTED_NOT_BUILT = [
  { capability: "Calendar", note: "Push a speaker's session and tech check into their own calendar." },
  { capability: "CRM", note: "Sponsor fulfilment visible to the sales side without a manual export." },
  { capability: "SSO", note: "OIDC discovery, for organizations that want it for staff and reviewers." },
  { capability: "SMS", note: "For the day-of messages that email is too slow for." },
  { capability: "Video", note: "For the recording pipeline after the event." },
];

/**
 * The integration surface that is always there, whatever you install. Sourced
 * from `docs/domain/09-api-and-integrations.md` and the URL map in
 * `docs/implementation.md`.
 */
export const ALWAYS_ON = [
  {
    title: "A REST API with scopes that mean something",
    body: "Read and write are separate scopes, and personal data is its own scope on top. A key for your marketing site can read the schedule and cannot read a review, a speaker's email or a phone number — not by convention, by refusal. Keys are scoped to named events, expire, and are shown once.",
  },
  {
    title: "Signed webhooks on every change",
    body: "Every fact the platform records is published as an event with a name that says what happened — a proposal accepted, a task completed, a schedule published — and delivered to your endpoint with an HMAC signature, retries and a dead-letter queue you can replay from.",
  },
  {
    title: "An embeddable schedule your site can cache",
    body: "The public schedule is an immutable, versioned snapshot with an entity tag. Your marketing site embeds it, a CDN caches it, and it renders with scripts blocked. Publishing does not put load on your database because nothing public ever reads it.",
  },
  {
    title: "Import and export that go both ways",
    body: "Bring speakers and proposals in from the tool you are leaving as CSV, and take everything back out the same way. There is no export ticket to raise and no format only we can read.",
  },
];
