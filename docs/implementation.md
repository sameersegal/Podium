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
| Concurrency (compare-and-set), INV-11-14 | `Db.updateVersioned` on `row_version`; forms round-trip it via `http/concurrency.ts` |
| Live updates (per-event room, no payload) | `durable/room.ts` + `packages/data/src/live.ts` + `surfaces/live.ts` |
| Placement serialisation | `workers/api/src/durable/schedule.ts` |
| Reaction idempotency | `consumers/dispatch.ts` + `event_reaction_log` |

`row_version` is the optimistic-concurrency counter. It is not called `version` because
several entities already use that name with a domain meaning. **Every** write to a versioned
row bumps it, not only the compare-and-set ones — a counter that advances solely on checked
writes misses the transition that landed in between, and the next check then passes for an
edit that was in fact stale. An edit form renders the version it read (`versionField`) and
returns it on submit; a stale submission is refused with `409` and a warning rather than
overwriting the other writer (INV-11-14).

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
| Live | `/live/subscribe` (WebSocket upgrade), `/live.js` (static asset) |

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
