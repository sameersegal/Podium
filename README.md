<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/podium-logo-horizontal-light.png">
  <img src="brand/podium-logo-horizontal.png" alt="Podium" width="325">
</picture>

[![CI](https://github.com/sameersegal/Podium/actions/workflows/ci.yml/badge.svg)](https://github.com/sameersegal/Podium/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

An open-source alternative to SessionBoard, scoped to the jobs an **AI Engineer–style
conference** actually has to get done — not a full clone.

It runs in your own Cloudflare account. The software is MIT, so the only bill is hosting,
and the one fixed line of it is Cloudflare's — from $5 a month, published on their pricing
page rather than promised on ours. There is no hosted tier: somebody deploys this, and that
somebody is you.

The specification is [`docs/domain/`](docs/domain/README.md), it is normative, and it
predates the code. Code implements it, and `npm run drift` fails the build when the two
disagree. That is the part that makes a fork survivable: point an agent at the model, it
builds against the model, and CI catches it the moment the two come apart.

Six capabilities:

1. **Multi-step submission forms** — abstracts from speakers, sessions from sponsors
2. **Submitter portal** — track proposals, complete onboarding tasks, manage a public profile
3. **Proposal evaluation** — rubrics, rounds, conflicts of interest, decisions
4. **Onboarding** — define what accepted speakers must do, chase it to completion
5. **Public schedule** — an embeddable, versioned, cacheable schedule for the marketing site
6. **APIs and webhooks** — integrate with everything else

Built for Cloudflare, with email and other providers attached as plugins behind capability
contracts.

## Status

**Built and running.** Every bounded context in the model is implemented end to end —
domain rules, repository layer, HTTP surface and UI — with 708 tests, a clean model↔code
drift check, and a seeded conference you can sign into in one command.

What that covers, beyond the six capabilities above: sponsor sessions as first-class
citizens with countable entitlements, an event roster, content approval and revision
history, assisted placement, campaigns and an auditable outbox, bulk import and export, and
a cross-event speaker directory.

Read the model first:

→ **[`docs/domain/`](docs/domain/README.md)**

Start with [`00-overview.md`](docs/domain/00-overview.md) for the jobs to be done, the
bounded contexts and the master ERD. Every open question is resolved — the decisions and
their reasoning are in [`13-open-questions.md`](docs/domain/13-open-questions.md), together
with the corrections that building it surfaced. The shape the code took is described in
[`docs/implementation.md`](docs/implementation.md).

## What it does not do

On this page, rather than discovered after you deploy it.

- **No attendee registration, ticketing or badging.** A deliberate boundary, not a gap on a
  roadmap — see [`09`](docs/domain/09-api-and-integrations.md). The `ticketing` plugin is a
  stub, and it exists so the contract has a shape, not so the feature has a start.
- **No hosted tier**, and no plan for one.
- **No track record.** Nobody has publicly run a live conference on this yet. A ten-year-old
  SaaS has something here that a new repository cannot have, and no amount of test count
  substitutes for it.
- **A smaller integration catalogue** than the incumbents: nine adapters behind capability
  contracts, listed at [podiumstack.com/integrations](https://podiumstack.com/integrations).
- **The importer moves people and the roster, not the programme.** One CSV brings your
  speakers and their history across, which is the part that would otherwise be a week of
  typing. Sessions and sponsors preview and then refuse, no route authors a proposal on
  someone's behalf, and last year's scores and decisions stay in whatever the old tool
  exports.

## Running it locally

```bash
npm install
npm run dev          # resets local D1, applies migrations, seeds, starts on :8787,
                     # and publishes the seeded schedule so the public pages have content
```

`npm run dev:lan` binds `0.0.0.0` to test from another machine, setting `PUBLIC_BASE_URL`
to the LAN address so that invitation links and portal URLs in rendered messages point
somewhere the other machine can actually reach. `node scripts/dev.mjs --no-reset` keeps
whatever you have already entered.

The seed ships one live event mid-flight — DevFlow Conf 2027, with proposals in every state,
a review round with real scores, accepted sessions with onboarding under way, and a placed
agenda — and the edition before it, DevFlow Conf 2026, delivered: a closed call, fifteen
talks over three days, their speakers, their recordings and the archived agenda they ran on.
An empty shell teaches you nothing about whether the product works, and neither does a
conference with no history behind it.

Headshots and logos are real files: the seed generates them, `npm run dev` puts them in R2,
and every one you see on a speaker page is served by `/assets/:id` out of the bucket.

Sign in with any of these ([R23](docs/domain/13-open-questions.md): password login is on in
the shipped seed, because a deployment nobody can sign into is worse than the marginal risk):

| Persona | Email | Password |
|---|---|---|
| Organizer / program chair | `organizer@devflowconf.example` | `PodiumDemo2027!` |
| Speaker | `speaker@devflowconf.example` | `PodiumDemo2027!` |
| Second speaker | `cospeaker@devflowconf.example` | `PodiumDemo2027!` |
| Reviewer | `reviewer@devflowconf.example` | `PodiumDemo2027!` |

| Surface | Where |
|---|---|
| Public event and schedule | `/e/devflow-conf-2027` |
| Last year's, delivered | `/e/devflow-conf-2026` |
| Public call for proposals | `/e/devflow-conf-2027/cfp/main` |
| Speaker / submitter portal | `/portal` |
| Reviewer queue | `/review` |
| Organizer admin | `/admin` |
| Embed | `/embed/dfc27-main-sessions` |

One caveat while it is running: `npm run db:seed`, `npm run db:reset` and
`wrangler d1 execute --local` write the same SQLite file the dev server holds open. Stop the
server before running them, or just restart it — `npm run dev` reseeds anyway.

```bash
npm test                  # 708 tests: unit + integration
npm run test:unit         # pure domain, no I/O
npm run test:integration  # real local D1, KV, R2, Queues and Durable Objects
npm run typecheck
npm run drift             # model↔code consistency check; non-zero exit on a defect
node scripts/smoke.mjs    # walk every screen as each persona
```

The integration suite applies every migration from scratch and then exercises the real
bindings: idempotency replay, reaction idempotence on redelivery, PII redaction with and
without `pii:read`, and the Durable Object serialising concurrent placement writes.

## Built on Cloudflare

| Concern | Service |
|---|---|
| API, portal, admin and public site | Workers, one entry, surfaces separated as modules |
| Relational store | D1 behind a repository layer ([R16](docs/domain/13-open-questions.md)) |
| Assets | R2, presigned direct upload — the API never proxies file bytes |
| Published snapshot cache, idempotency replay | KV, keyed on `content_etag` |
| Domain events, webhooks, email | Queues with retry and a dead-letter queue |
| Reminders, sweeps, expiry | Cron Triggers producing queue messages |
| Schedule placement | A Durable Object per event — one writer per schedule |

Everything downstream of a decision is event-driven: `decision.published` creates the
session, which materialises the onboarding tasks, which gate the publication. The wiring is
the reaction map in [`10-domain-events.md`](docs/domain/10-domain-events.md), and every
reaction is idempotent on `DomainEvent.id`, because at-least-once delivery is assumed
everywhere.

## Built for agents, both ends

The claim is not that an AI wrote it. It is that the repository is arranged so an agent can
change it without you re-reading the diff line by line.

**Producing it.** [`docs/domain/`](docs/domain/README.md) is the specification and it came
first. The [`implementer`](.claude/agents/implementer.md) agent validates a request against
the model and stops when the model does not cover it, so the failure mode is a refusal
rather than an invented field. Three skills in [`.claude/skills/`](.claude/skills) do the
recurring work the same way each time — `domain-expert` answers behaviour questions from the
model, `domain-drift` produces the model diff that belongs in the same commit as the code,
and `security-audit` inventories every route with the guard in front of it. `npm run drift`
and `npm run plugin:check` are both steps in the `check` job of
[`ci.yml`](.github/workflows/ci.yml): the build fails when code drifts from the model, or
when the endpoint catalogue drifts from the routes.

**Operating it.** [`claude-plugin/`](claude-plugin) is a Claude Code plugin, `podium-ops` —
eight skills that drive a *running* instance over the `/v1` API with a zero-dependency CLI,
given an instance URL and an API token. Its endpoint catalogue is generated from the routes,
never hand-written. Install it from this repository with `/plugin marketplace add`.

Driving that API from outside found three defects that reading the code had not, recorded
and closed as D1–D3 in
[`13-open-questions.md`](docs/domain/13-open-questions.md).

The limits: there is no MCP server and no OpenAPI document. The management surface is
specified in [`09`](docs/domain/09-api-and-integrations.md) and that is the document.

## The marketing site

[`www/`](www) is the static site at [podiumstack.com](https://podiumstack.com) — an Astro
build deployed as its own Worker, `podium-www`. It shares this repository with the app and
nothing else: no imports from `packages/`, no bindings, and a separate job in
[`ci.yml`](.github/workflows/ci.yml) that cannot reach the production database. The app runs
at [app.podiumstack.com](https://app.podiumstack.com), and `www/public/_redirects` keeps every
link that pointed at the apex before the split working.

The app does not know either hostname. It reads `PUBLIC_BASE_URL`, which
[`scripts/deploy-config.mjs`](scripts/deploy-config.mjs) sets from `PODIUM_HOSTNAME` at deploy
time — which is what lets the same artifact serve your domain when you self-host.

Eleven pages. Eight are one per question a buyer arrives with — the landing page,
`/features`, `/integrations`, `/compare`, `/fork`, `/pricing`, `/demo` and `/security` — and
three are the field guides, `/guides` and the two under it, `/guides/deploy` and
`/guides/agents`, for the reader who has decided and wants the commands.

Two kinds of image are generated from the running site rather than drawn. Every product shot is
a photograph of the running app taken by [`www/scripts/screenshots.mjs`](www/scripts/screenshots.mjs)
against this repository's own seed — never a mockup — so a redesigned screen means re-running it.
Every link preview card is typeset from the page's own words by
[`www/scripts/og-cards.mjs`](www/scripts/og-cards.mjs), which reads the built site, so a page
whose headline changes needs its card regenerated:

```bash
npm run dev                      # repo root: resets, seeds, serves :8787
npm --prefix www run screenshots # signs in as each persona and recaptures every shot
npm --prefix www run build       # the cards are read from dist/, so build first
npm --prefix www run og          # retypesets the card for every page and every section
```

Each section of each page carries its own address and its own preview card, so a post can point
at the argument it is about rather than the top of the page holding it.
`npm --prefix www run links` prints every one of them.

Changes to any of it go through the [`marketing-site`](.claude/agents/marketing-site.md) agent,
which will not ship a claim it has not checked and drives a browser at phone and desktop widths
before reporting.

## Brand

Logos, the web icon set and the usage rules live in [`brand/`](brand/README.md); the contents
of [`brand/web/`](brand/web) are served from both [`public/`](public) and
[`www/public/`](www/public).

## Contributing, and where to ask

[**Discussions**](https://github.com/sameersegal/Podium/discussions) for questions, "does it
do X", and what you would need before running your own event on it.
[**Issues**](https://github.com/sameersegal/Podium/issues) for bugs and concrete proposals.
Support is the issue tracker and the people who wrote it — there is no queue, no
response-time commitment, and nobody contractually on the hook the week of your event.

Before a pull request:

```bash
npm test && npm run typecheck && npm run drift
```

`npm run drift` is the one that surprises people. A field added to a table without being
added to the model is an incomplete change, and the check exists to say so out loud rather
than let the specification quietly become fiction. If you need something the model does not
cover, change the model in the same pull request — that is the convention here, not an
afterthought. [`CLAUDE.md`](CLAUDE.md) is the working agreement in full, for humans and
agents alike.

Security issues: please report them privately through
[GitHub's advisory form](https://github.com/sameersegal/Podium/security/advisories/new)
rather than opening a public issue.

## Licence

[MIT](LICENSE). Fork it, deploy it, change it, run it for a commercial conference, keep your
changes to yourself — the only condition is that the copyright notice travels with the copies
you pass on. Contributions are taken under the same licence; there is no CLA.
