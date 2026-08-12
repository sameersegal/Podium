# Working in this repository

**Podium** — an open-source SessionBoard alternative for AI Engineer–style conferences.
See [`README.md`](README.md) for what it does. The product is **Podium**; the namespace is
**`podiumstack`**, everywhere the bare word is taken — `podiumstack.com`, `@podiumstack` on
social, and the npm scope `@podiumstack/*`, never `@podium`, which an unrelated
micro-frontend framework holds. One qualifier, not one per medium: a new namespace takes
`podiumstack` rather than inventing a second suffix (R29).

## The domain model is the specification

[`docs/domain/`](docs/domain/README.md) is normative. Code implements it. When code and
model disagree, that is a defect in one of them — resolve it explicitly, never silently.

**Before writing or changing any code that touches domain behaviour:**

1. Read the relevant context file in `docs/domain/`. They are short and self-contained.
2. Use the model's names. `Proposal` and `Session` are different things
   ([`06`](docs/domain/06-program.md)); `Entitlement` means a countable sponsor right
   ([`03`](docs/domain/03-sponsorship.md)); *speaker* is a relationship, not a role
   ([`01`](docs/domain/01-identity-and-access.md)). The
   [glossary](docs/domain/12-glossary.md) is the reference.
3. Cite invariants. Code enforcing `INV-03-3` says so in a comment, and its test names it.
4. If the model is missing something you need, **change the model in the same PR**. A
   commit that adds a field to a table without adding it to the model is incomplete.

## What the model does and does not govern

| Governed by `docs/domain/` | Left to the implementation |
|---|---|
| Entity names, fields, types, nullability | Table layout, migrations, indexes |
| Enum members and their meanings | Storage representation of enums |
| State machines and legal transitions | Which layer enforces them |
| Invariants | How they are checked |
| Domain event names and payloads | Transport, queue topology, retry mechanics |
| Authorization matrix and PII classification | Policy engine, middleware structure |

## Conventions

- **Enums are additive.** Removing or renaming a member is breaking: note it in the affected
  file and provide a migration path.
- **Domain events are a published contract.** Add fields freely; removing or retyping one
  needs a new major version of the event type
  ([`10`](docs/domain/10-domain-events.md)).
- **Derived fields are never writable.** They are computed at read time. Stored counters
  drift; see [`11`](docs/domain/11-cross-cutting.md).
- **PII redaction is default-on.** Adding a field means deciding its PII classification.
- **Every reaction to a domain event must be idempotent on the event id.** At-least-once
  delivery is assumed everywhere.

## Writing code

Use the [`implementer`](.claude/agents/implementer.md) agent for any work that builds or
changes application code. It validates the request against `docs/domain/` before starting and
stops if the model does not cover it, and it carries the platform rules (Cloudflare services,
event-driven by default, context-shaped layout, responsive on phone and desktop, profiled
against performance budgets, structured PII-free instrumentation, integration tests, migrations
over destructive changes).

## Changing the marketing site

Use the [`marketing-site`](.claude/agents/marketing-site.md) agent for anything in
[`www/`](www) — a page, its copy, its screenshots, its design, or positioning the product
against an alternative. It carries the buyer, the taste rules and the design system the site
already has, and it verifies its own work by driving a browser at phone and desktop widths
rather than reasoning about the CSS.

The line between the two agents is the line the repository already draws: `www/` imports
nothing from `packages/` and has its own CI job, and the marketing agent may not touch anything
outside it. Its first rule is that no claim ships without being checked against a screenshot of
the running product, a rule in `docs/domain/`, a path in this repository, or a dated third-party
source — which is what stops a marketing page from becoming the one document in here that is
allowed to be aspirational.

## Skills

Three project skills in [`.claude/skills/`](.claude/skills) do the work the rules above
describe, so it happens the same way every time:

- **`domain-expert`** — answers "how does this work / who can do that / what happens at the
  deadline" from the model, in the model's own vocabulary, for a reader who isn't writing the
  code. Also turns a rough feature idea into a requirement precise enough to build.
- **`domain-drift`** — checks model against code after a change and produces the model diff
  that belongs in the same commit. Its
  [`model_inventory.py`](.claude/skills/domain-drift/scripts/model_inventory.py) extracts
  entities, fields, enums, invariants, events and state machines from `docs/domain/`;
  `--check` exits non-zero on a defect and is ready to run in CI.
- **`security-audit`** — the periodic whole-codebase security review: authorization and
  tenancy, sessions, rendering, uploads, CSRF, SSRF, PII exposure. Its
  [`attack_surface.py`](.claude/skills/security-audit/scripts/attack_surface.py) inventories
  every route with the guard in front of it and every deliberate escape from a safe default
  (`raw()` past the escaper, `db.raw()` past the org-scoping), and `--check` fails on
  anything new since the last accepted baseline. Its
  [`rules/podium.yml`](.claude/skills/security-audit/rules/podium.yml) is a Semgrep ruleset
  for the same sinks — stock rulesets score zero here, because nothing in this app looks
  like Express or React, and a zero from them means nothing. Reviewing one diff is the
  built-in `/security-review`'s job, not this one's.

The first two close a loop around the `implementer` agent: it validates against the model
before building, `domain-drift` checks the model against what was actually built afterwards.

## The agent-facing plugin

[`claude-plugin/`](claude-plugin) is a Claude Code plugin — `podium-ops` — that lets an agent
*operate* a hosted instance rather than build one: eight skills over the management API, and a
zero-dependency CLI ([`podium.mjs`](claude-plugin/scripts/podium.mjs)) taking an instance URL
and a `.env` holding an API token. It is the consumption half of "AI Agent first"; the
`implementer` agent is the production half. Root [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)
makes this repository installable with `/plugin marketplace add`.

The plugin ships nothing hand-written about the API surface. Its endpoint catalogue is
generated from the routes by
[`build-endpoints.mjs`](claude-plugin/scripts/build-endpoints.mjs), and `npm run plugin:check`
fails when a route changes without it being regenerated — the same rule as `npm run drift`,
applied to what we tell agents about the product. The prose in each `SKILL.md` is held to the
`marketing-site` standard: no behaviour is described that was not executed against a running
instance first.

Driving the API from outside found three defects reading it had not, recorded as **D1–D3** in
[`13-open-questions.md`](docs/domain/13-open-questions.md) and all now closed. Two were the
same three lines of scope-to-role grading (INV-09-25, INV-09-26). The third was a boundary
nobody had decided: neither a submission nor a review can be authored over the API, which is
right — both are a particular person's own statement — but it was an accident of which routes
exist rather than a rule, so the fix was to state it (INV-09-27) and refuse with an error that
names it. The skills document the surface as it actually behaves, which is the point of
building them against a running instance.

## Current state

**The product is built.** Every bounded context in `docs/domain/` is implemented end to end
— domain rules, repository layer, HTTP surface and UI — and runs on Cloudflare. The layout,
the unit of work, the URL map and where each cross-cutting rule is enforced are in
[`docs/implementation.md`](docs/implementation.md); read that before adding code, so a rule
that already has one home does not get a second one.

```bash
npm run dev        # reset, migrate, seed, serve on :8787, publish the seeded schedule
npm test           # unit + integration against real local D1, KV, R2, Queues and DOs
npm run typecheck
npm run drift      # model↔code consistency; exits non-zero on a defect
node scripts/smoke.mjs   # walk every screen as each persona
```

Keep these green. They are the contract, not a formality:

- `npm run drift` reports **0 errors, 0 warnings**. A new `enum(...)` left unspelled or an
  event promised but uncatalogued will break it, which is the point.
- Every invariant is cited in the code or the migration that enforces it, and the ones with
  behaviour are named in a test title.
- `tests/unit/shared/unit-of-work.test.ts` fails the build if a mutating handler opens an
  `AppContext` and never flushes it — the silent failure it catches is a write that lands
  while every reaction that should have followed it never runs.

**Nothing is open.** All thirty-two questions in
[`13-open-questions.md`](docs/domain/13-open-questions.md) are decided and recorded as
R1–R32; read the rationale there before reopening any of it.

The decisions that most shape the code, and how each one landed:

- **R16 — D1, behind a repository layer**, with Postgres via Hyperdrive as a documented
  escape hatch. No D1-specific SQL above `packages/data/src/db.ts`.
- **R13 — `Proposal` and `Session` stay separate**, and are presented to users as one
  session record.
- **R23 — password login** off in production config, on in the default seed and wherever no
  `email` integration is active. The seed ships four personas with passwords for exactly
  this reason.
- **R24 — AI first-pass review ships behind an org setting, default off.** Built, off.
- **R28 — the sourcing pipeline is not in v1.** Built anyway, ahead of that plan: the model
  specifies it completely, so shipping it early is scope, not drift. Recorded under the R28
  blockquote in [`14`](docs/domain/14-speaker-crm.md). If it should come back out, the
  directory and segments stay and only the board goes.
- **R32 — `app.podiumstack.com` is a demonstration deployment.** Fixture data restored on
  the hour by [`demo-reset.mjs`](scripts/demo-reset.mjs) in CI, never by a Cron Trigger; and
  while it runs, nothing leaves it — no credential resolves, no webhook is delivered, no
  message is sent (INV-09-28), and its fixture people are signed in as without a password
  (INV-01-19). `DEMO_MODE` is the switch, and it is deliberately not `ENVIRONMENT`. See "The
  demonstration deployment" in [`docs/implementation.md`](docs/implementation.md).
- **R30 — server-rendered applicant side, client-rendered admin console.** Under way. The
  blocker is closed: `scheduling` now has a `/v1` surface, specified in
  [`09`](docs/domain/09-api-and-integrations.md) under "Scheduling on the management
  surface". The console is built and lives in `public/console/` — ES modules, no build step
  — and owns fifteen screens, which is the organizer's daily loop end to end. It shares URLs
  with the screens it replaces and declines any request it does not own, so the write-heavy
  detail forms are still server-rendered and still work; `?nojs=1` reaches the
  server-rendered version of a ported screen, and an integration test asserting HTML for one
  must ask for it. See "The admin console" in
  [`docs/implementation.md`](docs/implementation.md) before adding a screen — in particular
  the two properties (`SameSite=Lax` + JSON as the CSRF defence, permissions recomputed per
  request) the console now relies on. Public, embeds, `/portal` and `/review` stay
  server-rendered and must survive blocked scripts.

Corrections the build surfaced are recorded as C1–C8 in
[`13-open-questions.md`](docs/domain/13-open-questions.md). C7 is the shape to copy when
you hit another: an invariant required a state transition the diagram never drew, so the
diagram gained the arrows rather than the invariant losing its teeth.

[`15-conformance-map.md`](docs/domain/15-conformance-map.md) traces an external functional
rubric onto the model; it is non-normative and nothing should cite it as a requirement.
