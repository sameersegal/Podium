# Implementation notes

Non-normative. `docs/domain/` is the specification; this file records the shape the code
took so that a change lands in the same place every time.

## Layout

```
public/console/             the admin console (R30) — ES modules, no build step
packages/domain/            pure domain logic — no Cloudflare imports, no I/O
  shared/                   ids, time, errors, PII, authorization, ports (11)
  events/                   the catalogue from 10 as types + the envelope
  identity/ event-config/ sponsorship/ submissions/ review/ program/
  onboarding/ scheduling/ crm/                       one per bounded context
packages/data/              repository layer over D1 (R16) + the unit of work
packages/plugins/           capability contract implementations (09)
workers/api/src/
  http/                     router, request context, idempotency, input, responses
  ui/                       html kit, layout components, page shells
  contexts/<context>/       service.ts, routes.ts, reactions.ts, cron.ts, views.ts
  consumers/                queue dispatch, reaction registry, cron registry, delivery
  durable/                  Durable Objects
  surfaces/                 home + public site and embeds
migrations/                 D1 migrations, sequential, never edited once applied
tests/unit/                 pure domain, no I/O; every invariant names itself
tests/integration/          @cloudflare/vitest-pool-workers against real bindings
```

Surfaces (09) are separated as modules and composed into one Worker entry, because a
self-hosted deployment is one origin. No surface imports another's handlers.

## The unit of work

Every mutation runs through an `AppContext` (`packages/data/src/context.ts`):

```ts
const app = ctx.app(eventId);
await doSomething(app, input);   // raises events + audit rows on `app`
await app.flush();               // persists the event log + audit, then publishes
```

`flush()` writes `domain_event_record` and `audit_log`, then hands the events to
`EVENT_QUEUE`. Reactions run in the queue consumer and are idempotent on `DomainEvent.id`
(enforced once, in `consumers/dispatch.ts`).

## Rules that are enforced in one place

| Rule | Where |
|---|---|
| INV-11-1 org scoping, INV-11-2 soft delete | `packages/data/src/db.ts` |
| INV-09-7 idempotency replay | `workers/api/src/http/idempotency.ts` |
| Authorization matrix, INV-11-7 | `packages/domain/src/shared/authorization.ts` |
| INV-09-5 / INV-11-4 PII redaction | `packages/domain/src/shared/pii.ts` |
| Concurrency (compare-and-set), INV-11-14 | `Db.updateVersioned` on `row_version`; forms round-trip it via `http/concurrency.ts` |
| Live updates (per-event room, no payload) | `durable/room.ts` + `packages/data/src/live.ts` + `surfaces/live.ts` |
| Placement serialisation | `workers/api/src/durable/schedule.ts` |
| Reaction idempotency | `consumers/dispatch.ts` + `event_reaction_log` |
| Event replay after a queue-send failure | `consumers/replay.ts`, run by cron `platform.replay_unprocessed_events` and `POST /dev/drain` |
| Dead-letter recording (`podium-dlq`) | `consumers/dead-letter.ts` + `dead_letter` |
| Cron cadence (elapsed time, not epoch modulus) | `consumers/cron.ts` + `cron_job_run` |
| INV-01-12 password hashing (Argon2id) | `packages/domain/src/identity/credentials.ts` |
| INV-01-17 sign-in throttling | `workers/api/src/http/throttle.ts`, called by both password-verifying routes in `contexts/identity/auth-routes.ts` |
| INV-01-18 session transport, redirect targets | `setCookie` / `safeNext` in `workers/api/src/http/context.ts` |
| INV-11-15 uploaded files are never served as documents | `resolveContentType` / `safeServeContentType` in `packages/domain/src/content/assets.ts` |
| Response hardening (CSP, nosniff, framing, HSTS) | `workers/api/src/http/headers.ts`, applied to every response in `index.ts` |
| INV-02-14…17 event provisioning (starter blueprint, clone) | `contexts/event-config/provisioning.ts` over `packages/domain/src/event-config/blueprint.ts` |
| INV-09-17…19 sync field maps, authority and echo suppression | `packages/domain/src/platform/sync.ts` (pure); applied in `contexts/platform/sync.ts` |
| INV-09-20 sync writes go through the owning context's service | `contexts/platform/sync-subjects.ts` — one adapter per subject, each calling that context's own `service.ts` |
| INV-09-22 erasure propagation to external mirrors | `erasePersonEverywhere` in `contexts/platform/sync.ts`, driven by the `platform.sync_erasure` reaction |

### Password hashing, and the plan that pays for it

`ARGON2_PARAMS` is `m=12 MiB, t=3, p=1` — a configuration on OWASP's Argon2id list. The model
requires Argon2id ([`01`](domain/01-identity-and-access.md), INV-01-12) and names no
parameters, so the choice is an implementation one.

**It was not always this.** Between the move to the Cloudflare Workers **free plan** and
2026-08-12 it was `m=256 KiB, t=1`, roughly two orders of magnitude cheaper to attack offline
than it should have been. That was not an oversight and it was documented as a stopgap while
it lasted: the free plan allows **10 ms of CPU per invocation**, a correctly-sized hash costs
far more than that, and every sign-in was being killed with `exceededCpu` (Cloudflare error
1102). Password login was down in production, intermittently succeeding only when the platform
tolerated a burst. A weak hash that works beat a strong one that does not, until the plan
changed. The deployment is now on **Workers Paid**, whose budget is measured in seconds, and
the stopgap is reverted.

**Why `m=12288, t=3` rather than the `m=19456, t=2` OWASP lists first.** Measured directly,
they cost the same — 108 ms against 116 ms per hash — so the choice is not about time. It is
about memory. A Workers isolate has 128 MB, each concurrent sign-in holds its own Argon2
buffer for the duration of the hash, and 12 MiB leaves room for roughly ten at once where
19 MiB leaves six. Both are OWASP configurations; this one has more headroom on the runtime
that has to run it. Worth revisiting if sign-in concurrency is ever measured rather than
guessed at.

**Nothing migrates.** Parameters live inside each stored PHC string, so:

- A hash written at `m=256` still verifies at its own cost, and `needsRehash` carries it up to
  the current parameters on its owner's next successful sign-in, while the plaintext is in
  hand. There is no batch path and none is needed — nobody holds the plaintexts.
- `beyondCpuBudget` refuses a stored hash whose `m` exceeds `MAX_VERIFIABLE_M`, because
  attempting one does not fail the sign-in, it kills the isolate. **That ceiling must always
  sit above `ARGON2_PARAMS.m`.** It was left at 1024 when `m` dropped to 256, which was
  correct then and became a trap: raising `m` back to 12288 alone would have made every
  newly-set password unverifiable the moment it was written, with no error until somebody
  tried to sign in. It is now 65536, and `credentials.ts` throws at module load if the two
  ever invert.
- `scripts/seed.mjs` writes its own hashes and carries its own copy of the parameters, so it
  moves with `ARGON2_PARAMS`. It did not, once, and every seeded password became unverifiable;
  `tests/unit/shared/seed-credentials.test.ts` holds the two in step in both directions.

Online guessing is separately bounded by INV-01-17 (`workers/api/src/http/throttle.ts`), which
matters less now than it did when the hash was cheap, but is the control that stops the
guessing rather than merely making each guess expensive.

`row_version` is the optimistic-concurrency counter. It is not called `version` because
several entities already use that name with a domain meaning. **Every** write to a versioned
row bumps it, not only the compare-and-set ones — a counter that advances solely on checked
writes misses the transition that landed in between, and the next check then passes for an
edit that was in fact stale. An edit form renders the version it read (`versionField`) and
returns it on submit; a stale submission is refused with `409` and a warning rather than
overwriting the other writer (INV-11-14).

### Provisioning a new event

`contexts/event-config/provisioning.ts` is the one module that reaches across contexts on
purpose. Creating an event applies the starter blueprint or clones an earlier edition (02,
"Starting an event"), and both need rows that belong to review, onboarding, sponsorship and
platform — so each of those exposes its own copier (`copyRubricToEvent`,
`copyTaskDefinitionsToEvent`, `copyTiersToEvent`, `copyTemplatesToEvent`) and provisioning
only sequences them. Nothing here writes another context's table directly, and every row
goes through the same service a hand-built event would use, so a provisioned event has no
second class of row in it.

The pure half — the shipped blueprint data, day generation and the day-shift rebasing of
INV-02-16 — is `packages/domain/src/event-config/blueprint.ts`, with no I/O in it.

## Derived fields

Fields marked `D` have no column. They are computed at read time, in the context that owns
them, and are never accepted from a request body (INV-11-6). The two materialised
exceptions are the publication snapshot (immutable once live) and `schedule_conflict`
(recomputed on every placement write so acknowledgements survive).

Until the two-way sync, that rule held by omission: every service builds its patch from a
named field set, so a derived column simply had no route that could write it. Two surfaces
now take a field bag from outside — bulk import and sync — and they carry the rule
explicitly instead, as per-subject writable sets (`SUBJECT_SPECS` in
`packages/domain/src/platform/sync.ts`) validated at save time. `derivedFieldWrite` in
`shared/errors.ts` had no call site before this and now has one.

## Two-way sync

`sync_mapping` → `external_record_link` → `sync_run`, with the domain rules pure in
`packages/domain/src/platform/sync.ts` and the orchestration in `contexts/platform/`:

| Piece | File |
|---|---|
| Field sets, value space, hashing, echo check, link state machine | `packages/domain/src/platform/sync.ts` |
| Per-subject load / list / derive / apply | `contexts/platform/sync-subjects.ts` |
| Mappings, push, pull, conflicts, erasure | `contexts/platform/sync.ts` |
| Debounced enqueue and the delivery handlers | `contexts/platform/sync-delivery.ts` |
| Admin screens and `/v1/sync/…` | `contexts/platform/sync-routes.ts` |
| Providers | `packages/plugins/src/sync/{airtable,memory}.ts` |

The field model is deliberately not lowest-common-denominator. A subject declares semantic
kinds — `select`, `multi_select`, `link`, `attachment` — and only the adapter knows those are
`singleSelect`, `multipleSelects`, `multipleRecordLinks` and `multipleAttachments`. Speakers
are pushed as real links to the Speakers table, tracks as a dropdown matched by name, headshots
as files the provider fetches. A base whose Track column is text cannot group by track, and a
grid that cannot group is the spreadsheet the organizer was trying to leave.

Three rules fall out of that: a relationship is declared on **one side only** (providers create
the reverse column themselves); `link` and `attachment` are **never hashed**, because their
values are provider record ids and fetched file copies this system cannot reproduce; and
neither is ever **accepted back** (INV-09-24). `ensure_table` creates the columns with the
right types, so setup is not twenty hand-typed names.

Two more things to know before changing any of it. **The push half never calls a provider from a
reaction** — it flips links to `pending_push` and enqueues one debounced sweep per mapping,
because a `decision.published` batch over four hundred proposals is four hundred events.
**Accepting an inbound change leaves the link `pending_push`, not `in_sync`**, so Podium
re-pushes what it actually stored rather than what the spreadsheet proposed; that cannot
loop, because the re-push's own hash lands in `last_pushed_hash` and the provider's echo of
it fails the check in INV-09-19.

`sync.memory` is a working provider against an in-memory store, in the same spirit as
`email.log`. Install it in `npm run dev` to watch the loop close without an Airtable
account; `resetExternalTables`, `editExternally` and `insertExternally` are what the
integration tests drive it with.

## URL map

| Surface | Paths |
|---|---|
| Public | `/`, `/e/:slug`, `/e/:slug/cfp/:cfpSlug`, `/e/:slug/schedule`, `/e/:slug/sessions`, `/e/:slug/sessions/:id`, `/e/:slug/speakers`, `/e/:slug/speakers/:personId`, `/e/:slug/gallery`, `/e/:slug/schedule.ics`, `/embed/:key` |
| Auth | `/login`, `/signup`, `/logout`, `/invite/:token` |
| Portal | `/portal`, `/portal/proposals`, `/portal/proposals/:id`, `/portal/sessions/:id`, `/portal/tasks/:id`, `/portal/profile` |
| Reviewer | `/review`, `/review/:assignmentId` |
| Admin | `/admin`, `/admin/events/:eventId/…`, `/admin/sponsors`, `/admin/contacts`, `/admin/team`, `/admin/settings` |
| Live | `/live/subscribe` (WebSocket upgrade), `/live.js` (static asset) |
| Public API | `/v1/public/…` |
| Management API | `/v1/…` |
| Provider callbacks | `/integrations/:id/inbound` (signed URL, no session — 09; dispatched on the integration's capability) |
| Sync | `/admin/sync` (conflict queue), `/admin/sync/:mappingId`, `/admin/integrations/:id/sync`, `/v1/sync/…` |

## Conventions

- Server-rendered HTML through `ui/html.ts` and `ui/layout.ts` on the applicant side —
  public, embeds, `/portal` and `/review` — with no client framework. Public surfaces must
  render fully with scripts blocked (08, "Degrade gracefully"). The admin console is the
  exception and is client-rendered over `/v1`; see R30 in
  [`13`](domain/13-open-questions.md) for where the line falls and why `/review` sits on the
  server-rendered side of it.
- Code enforcing an invariant names it in a comment; its test names it in the title.

### The admin console

R30's client-rendered console, built. It lives in `public/console/` and is served by
`workers/api/src/surfaces/console.ts`.

**No build step.** These are ES modules the browser loads directly, served from the edge like
`/app.css` and `/live.js`. That is what keeps R30's accepted cost — two UI stacks — from also
meaning two toolchains: `npm run dev`, `npm test` and `npm run deploy` are unchanged, and
there is no bundler, transpiler or second lockfile.

```
public/console/kit.js       ~200 lines of keyed virtual DOM + the redraw loop
public/console/api.js       the /v1 client; every write is JSON (see below)
public/console/router.js    the client route table and link interception
public/console/store.js     boot payload, toasts, drawer, async resources
public/console/dnd.js       pointer-event dragging, with keyboard equivalents beside it
public/console/live.js      the same socket as /live.js, invalidating instead of nudging
public/console/ui.js        the components layout.ts renders on the server, as vnodes
public/console/views/       one file per screen
public/console.css          only what the console added; app.css is still the shared artifact
```

**It shares URLs with the screens it is replacing.** `consoleDocument` runs before the router
in `index.ts` and takes a request only when the path is in `CONSOLE_PATHS`, the caller is a
signed-in person with the capability, and `?nojs=1` is absent. Anything else falls through to
the server-rendered page, which is still registered and still works. So the port is
incremental rather than a flag day, `<noscript>` has somewhere to point, and
`tests/integration/foundation/concurrency.test.ts` still drives the real HTML forms.

**Ported so far — fifteen screens**, which is the organizer's daily loop end to end:
`/admin`, the event dashboard, the proposal board and a proposal, the agenda grid, the form
builder, and the events / setup / calls / sessions / review / speakers / onboarding / publish
lists. Navigating between any of them is same-document.

**Still server-rendered, deliberately:** the write-heavy detail forms — a session, a call's
settings, a decision, a round's assignments, and the organization-wide settings screens.
Each already round-trips `row_version` and refuses a stale write (INV-11-14), and a form
reimplemented badly is worse than a form that reloads. The console links to them rather than
hiding them.

`public/console/app.js` and `surfaces/console.ts` each hold the route list and the two have
to agree — a path the server boots and the client cannot match renders an empty shell.

**Testing a ported path.** An integration test asserting server-rendered HTML for a URL the
console owns must ask for `?nojs=1`, or it will assert against the boot document. That is not
a workaround: the server-rendered page is still the fallback and still has to work, so the
test is exercising something real. Where the console reaches the same guarantee by a
different route — conflicts in a placement's response, compare-and-set on a `PATCH`, PII
withheld from a list endpoint — assert **both**, because each surface has its own way of
losing it.

**Ids are not a presentation.** Several `/v1` list endpoints grew display names beside their
ids (`track_name`, `speaker_names`, `assignee_name`). The entity shape is right for an
integration syncing into another system and unreadable as a table — nobody can scan a column
of `trk_01J…`. The names are resolved in one pass in the route, never per row, and never past
a visibility rule: `/v1/tasks` adds them only to rows this reader may see in full, because
INV-07-10 keeps a restricted row to its title and status and a name is neither.

Two properties R30 named as making this cheap are now relied upon rather than assumed, and
should not be changed without reading it first:

- **`SameSite=Lax` with no CSRF token is the console's defence.** It holds because Lax
  withholds the cookie from a cross-site POST *and* `application/json` is not a form-encodable
  content type, so a cross-origin write needs a preflight that will not be granted. Every
  write in `api.js` therefore sends JSON and never `FormData`.
- **Permissions are recomputed per request**, so the console caches no authority. The boot
  payload's `can` / `can_write` maps decide whether a control is *drawn*; the server decides
  again on the write.

Reads the console alone needs are `GET /v1/console/bootstrap`, `GET /v1/events/:eventId/dashboard`
(`surfaces/dashboard.ts` — a cross-context read model, beside `admin-home.ts` for the same
reason) and `GET /v1/cfps/:cfpId/builder`. Everything else it does goes through the ordinary
management surface.

**Measuring it.** `node scripts/perf-console.mjs` walks all fourteen console routes in a real
browser and reports three numbers per screen — a cold load with an empty cache, a warm reload,
and a client-side navigation into the screen — plus the server time for every document and
every `/v1` endpoint the console was *seen* to call, harvested from the run rather than listed
by hand. It needs Playwright, which is deliberately not a dependency of this repository
(`npm i -D playwright`); nothing else here drives a browser.

"Ready" is not `load`: it is the first frame on which the screen's skeleton is gone and no
`/v1` request is in flight, which works uniformly because every view in `views/` renders
`.console-skeleton` while its resource loads. The three numbers exist because they answer
different questions — the cold one is what a morning URL costs, the in-app one is what R30
actually bought, and the gap between them is the module waterfall and the boot document. A
screen marked `*` fetched nothing when navigated into although its cold load fetched: it is
either reusing the previous screen's resource or rendering a different branch, and the two
columns are not comparable until you know which.

`node scripts/perf-seed-scale.mjs --proposals 800` inflates the local database to the size an
open call actually reaches, because the seed is sized to make every screen true rather than to
make a benchmark strain. It writes copied rows straight into D1, below the domain layer —
allowed precisely because nothing about behaviour is being asserted — and `npm run db:reset`
puts the seed back.

### Live updates

One Durable Object per event (`ROOM_DO`, `durable/room.ts`), holding hibernatable WebSockets.
Four properties, in the order they matter:

- **A frame carries no domain data** — only `{type, subject, occurred_at}`. The client
  refetches through the ordinary authorized route, so blinding and PII redaction are
  inherited rather than reimplemented on a broadcast path where a divergence would fail
  silently. This is also what makes a long-lived socket tractable: authorization happens once
  at the handshake, and the side channel's worst case is bounded by a 30-minute lifetime cap
  plus an immediate kick on `role_grant.revoked` and sign-out.
- **No payload is not no information**, so every frame carries an audience and every socket is
  tagged `role:staff` / `role:member`. Review-internal types are staff-only: a reviewer is
  deliberately not staff here, because 05 blinds them from their peers and *when* a review
  landed correlates.
- **Two transports, one frame.** `AppContext.flush()` pokes the room directly (~100ms, allowed
  to fail); `platform.room_broadcast` pokes it again off the queue (seconds, durable). The
  room dedupes on `DomainEvent.id`. Topics are an allowlist in
  `packages/domain/src/events/catalogue.ts`, beside `PII_EVENT_TYPES` — not `*`, which would
  cost an `event_reaction_log` insert per event to decide it had nothing to say.
- **The client is one vanilla file**, `public/live.js`, loaded only on screens that opt in via
  `PageOptions.live`. No framework and no build step; it either shows a "N changes · Reload"
  bar or, on read-only dashboards, refetches the current URL and swaps `<main>` — never while
  a control in it is dirty. Public surfaces do not opt in and still render fully with scripts
  blocked. It is the first `.js` file on disk; the rule it has to keep is "no framework, no
  build step, public surfaces work without scripts", and it keeps all three.
- Typed errors (`DomainError`) carry `invariant`; the HTML layer renders them as a page and
  the JSON layer as the documented body shape.
- Enum members live as `as const` arrays in `packages/domain/src/<context>/types.ts`, so a
  drift checker can compare them with the model.
