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
| INV-02-14…17 event provisioning (starter blueprint, clone) | `contexts/event-config/provisioning.ts` over `packages/domain/src/event-config/blueprint.ts` |

### Password hashing is currently below the OWASP floor, on purpose

`ARGON2_PARAMS` is `m=256 KiB, t=1`. The model requires Argon2id
([`01`](domain/01-identity-and-access.md), INV-01-12) and does not name parameters, so this
is an implementation choice — but it is a bad one, taken knowingly, and it should not
survive.

The deployment runs on the Cloudflare Workers **free plan**, which allows **10 ms of CPU per
invocation**. The previous `m=12 MiB, t=3` was sized against the paid plan's 30 s budget and
costs **~345 ms** of Worker CPU. Every sign-in was therefore killed with `exceededCpu`
(Cloudflare error 1102): password login was down in production, intermittently succeeding
only when the platform tolerated a burst. `m=256 KiB, t=1` costs ~3 ms, which is what is left
once the rest of the sign-in request is paid for.

This is roughly two orders of magnitude cheaper to attack offline than RFC 9106's second
recommendation (19 MiB, t=2). **The fix is to move to Workers Paid and revert**: raise
`ARGON2_PARAMS` back to `{ t: 3, m: 12288 }` and nothing else changes — `needsRehash` carries
each stored hash up to the new parameters on its owner's next sign-in.

Two things follow from parameters living inside the stored PHC string rather than in code:

- A hash written with the old parameters still costs its own ~345 ms to check, so it cannot
  be verified on this plan at all. `beyondCpuBudget` refuses those deliberately and
  `verifyPasswordLogin` returns `credential_needs_reset` (409), because the alternative is a
  503 that looks like an outage instead of a credential that needs re-setting. There is no
  password reset route, so that 409 points at an invitation (INV-01-15), not a reset form.
- Re-hashing happens on successful sign-in, while the plaintext is in hand. There is no
  batch migration path; nobody holds the plaintexts.
- `scripts/seed.mjs` writes its own hashes and carries its own copy of the parameters, so it
  has to move with `ARGON2_PARAMS`. It did not, and every seeded password became
  unverifiable; `tests/unit/shared/seed-credentials.test.ts` now holds the two in step.

The 10 ms is not enforced per request. Measured on 2026-08-11, `POST /login` ranges 5–46 ms
and all of it is served; `/admin` routinely measures ~19 ms. Cloudflare tolerates bursts and
kills sustained or extreme overruns, which is why a 345 ms hash was fatal, why it still got
through perhaps once in four, and why the app appears healthy today at twice the nominal
limit. Do not read the current green state as headroom. The free plan does not fit this
application; the password hash is only where it broke first.

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
| Provider callbacks | `/integrations/:id/inbound` (signed URL, no session — 09) |

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

**Ported so far:** the event dashboard, the agenda grid, the proposal board, the form
builder, and the events / setup / calls / sessions / review / speakers / onboarding / publish
lists. `public/console/app.js` and `surfaces/console.ts` each hold the list and the two have
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
