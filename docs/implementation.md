# Implementation notes

Non-normative. `docs/domain/` is the specification; this file records the shape the code
took so that a change lands in the same place every time.

## Layout

```
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
| Concurrency (compare-and-set) | `Db.updateVersioned` on `row_version` |
| Placement serialisation | `workers/api/src/durable/schedule.ts` |
| Reaction idempotency | `consumers/dispatch.ts` + `event_reaction_log` |
| INV-01-12 password hashing (Argon2id) | `packages/domain/src/identity/credentials.ts` |

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

The 10 ms is not enforced per request. Measured on 2026-08-11, `POST /login` ranges 5–46 ms
and all of it is served; `/admin` routinely measures ~19 ms. Cloudflare tolerates bursts and
kills sustained or extreme overruns, which is why a 345 ms hash was fatal, why it still got
through perhaps once in four, and why the app appears healthy today at twice the nominal
limit. Do not read the current green state as headroom. The free plan does not fit this
application; the password hash is only where it broke first.

`row_version` is the optimistic-concurrency counter. It is not called `version` because
several entities already use that name with a domain meaning.

## Derived fields

Fields marked `D` have no column. They are computed at read time, in the context that owns
them, and are never accepted from a request body (INV-11-6). The two materialised
exceptions are the publication snapshot (immutable once live) and `schedule_conflict`
(recomputed on every placement write so acknowledgements survive).

## URL map

| Surface | Paths |
|---|---|
| Public | `/`, `/e/:slug`, `/e/:slug/cfp/:cfpSlug`, `/e/:slug/schedule`, `/e/:slug/speakers`, `/e/:slug/sessions/:id`, `/e/:slug/schedule.ics`, `/embed/:key` |
| Auth | `/login`, `/signup`, `/logout`, `/invite/:token` |
| Portal | `/portal`, `/portal/proposals`, `/portal/proposals/:id`, `/portal/sessions/:id`, `/portal/tasks/:id`, `/portal/profile` |
| Reviewer | `/review`, `/review/:assignmentId` |
| Admin | `/admin`, `/admin/events/:eventId/…`, `/admin/sponsors`, `/admin/contacts`, `/admin/team`, `/admin/settings` |
| Public API | `/v1/public/…` |
| Management API | `/v1/…` |

## Conventions

- Server-rendered HTML through `ui/html.ts` and `ui/layout.ts`; no client framework. Public
  surfaces must render fully with scripts blocked (08, "Degrade gracefully").
- Code enforcing an invariant names it in a comment; its test names it in the title.
- Typed errors (`DomainError`) carry `invariant`; the HTML layer renders them as a page and
  the JSON layer as the documented body shape.
- Enum members live as `as const` arrays in `packages/domain/src/<context>/types.ts`, so a
  drift checker can compare them with the model.
