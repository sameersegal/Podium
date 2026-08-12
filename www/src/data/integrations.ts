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
      "Put this rendered message on the wire, and tell us when it bounced. Templating, batching, quiet hours and suppression stay on our side.",
    adapters: [
      {
        display: "Resend",
        key: "email.resend",
        blurb:
          "Point it at a verified domain and every acceptance, reminder and campaign goes out through it. Bounces and complaints come back on a signed callback and land on the suppression list unwatched.",
      },
      {
        display: "SendGrid",
        key: "email.sendgrid",
        blurb:
          "The same contract, a different provider. Swapping one for the other is an install and a default flag. No template, schedule or audit trail is rewritten.",
      },
      {
        display: "Outbox only (no provider)",
        key: "email.log",
        blurb:
          "The default when nothing is installed. Every message is composed, rendered, recorded and never sent. It is how you rehearse an announcement to four hundred speakers.",
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
          "A live mirror of proposals, sessions, speakers and sponsors, in a base your AV contractor and sponsorship lead can open. Linked records, single-selects and attachments, not a wall of text.",
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
          "New submissions, decisions and publication into the committee channel. Nobody waits on someone remembering to tell them.",
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
          "Headshots, slides and recordings upload straight from the browser to your bucket. File bytes never pass through the application, so a 200 MB deck is not a request timeout.",
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
          "Off unless you switch it on. Its opinions sit beside your reviewers', never inside them, and a machine score never contributes to quorum. The shipped evaluator calls no external model; the contract lets you point it at one you trust.",
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
          "One method on purpose. Registration lives in your ticketing system and attendees are not modelled here. The one answer the schedule needs — has this workshop room left — is cached into the published snapshot, so a public page never calls your provider.",
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
 * What makes the management API safe for an autonomous caller.
 *
 * Every row is a property of the shipped product, not an intention. In order:
 *
 *   idempotency   INV-09-7; `workers/api/src/http/idempotency.ts`, applied to
 *                 every mutating request in `workers/api/src/index.ts`
 *   typed errors  09, "Design rules"; `packages/domain/src/shared/errors.ts`
 *   row_version   INV-11-14; `versionConflict` in the same file, and
 *                 `workers/api/src/http/concurrency.ts`
 *   scopes        `ApiKey.scopes` in 09, `pii:read` additive (INV-09-5);
 *                 enforced in `workers/api/src/http/context.ts`
 *   key lifetime  `ApiKey.event_ids` / `expires_at` (INV-09-9), checked in the
 *                 same file
 *   webhooks      09, "Delivery contract"; `packages/domain/src/platform/webhooks.ts`
 *   the surface   the `/v1` routes registered across `workers/api/src/contexts/`,
 *                 scheduling included (09, "Scheduling on the management surface")
 *
 * The failure column is the point: an agent breaks software in ways a person
 * does not, and each of these is one of those ways.
 */
export const AGENT_PROPERTIES = [
  {
    property: "Every write takes an idempotency key, stored and replayed for 24 hours",
    failure: "A retried call that books the room twice",
  },
  {
    property: "Errors are typed and name the rule that was broken",
    failure: "A caller that reads a bare 400 and guesses",
  },
  {
    property: "A write can carry the version it read; a stale one is refused with the current state",
    failure: "An agent overwriting the edit a human made while it was thinking",
  },
  {
    property: "Read and write are separate scopes, and personal data is a scope on top",
    failure: "A schedule integration reading a speaker's phone number",
  },
  {
    property: "Keys are scoped to named events and expire",
    failure: "One leaked key that reaches every event you have ever run",
  },
  {
    property: "Named events arrive on a signed webhook, at least once",
    failure: "Polling, and the staleness that comes with it",
  },
  {
    property: "The specification is a document a model can read",
    failure: "Guessing what an entitlement is",
  },
];

/**
 * The integration surface that is always there, whatever you install. Sourced
 * from `docs/domain/09-api-and-integrations.md` and the URL map in
 * `docs/implementation.md`.
 */
export const ALWAYS_ON = [
  {
    title: "A REST API with scopes that mean something",
    body: "Read and write are separate scopes, and personal data is a scope on top. A key for your marketing site reads the schedule and cannot read a review or a speaker's email. Keys are scoped to named events, expire, and are shown once.",
  },
  {
    title: "Signed webhooks on every change",
    body: "Every fact the platform records is published as a named event: a proposal accepted, a task completed, a schedule published. Each arrives signed, with retries and a dead-letter queue you can replay from.",
  },
  {
    title: "An embeddable schedule your site can cache",
    body: "The public schedule is an immutable, versioned snapshot. Your site embeds it, a CDN caches it, and it renders with scripts blocked. Nothing public reads your database.",
  },
  {
    title: "Import and export that go both ways",
    body: "Bring speakers and proposals in from the tool you are leaving as CSV, and take everything back out the same way. No export ticket, no format only we can read.",
  },
];
