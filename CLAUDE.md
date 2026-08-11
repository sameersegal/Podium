# Working in this repository

**Podium** — an open-source SessionBoard alternative for AI Engineer–style conferences.
See [`README.md`](README.md) for what it does. The npm scope is **not** `@podium`, which an
unrelated micro-frontend framework holds; use `@podiumconf/*` (R29).

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

## Skills

Two project skills in [`.claude/skills/`](.claude/skills) do the work the rules above
describe, so it happens the same way every time:

- **`domain-expert`** — answers "how does this work / who can do that / what happens at the
  deadline" from the model, in the model's own vocabulary, for a reader who isn't writing the
  code. Also turns a rough feature idea into a requirement precise enough to build.
- **`domain-drift`** — checks model against code after a change and produces the model diff
  that belongs in the same commit. Its
  [`model_inventory.py`](.claude/skills/domain-drift/scripts/model_inventory.py) extracts
  entities, fields, enums, invariants, events and state machines from `docs/domain/`;
  `--check` exits non-zero on a defect and is ready to run in CI.

The two close a loop around the `implementer` agent: it validates against the model before
building, `domain-drift` checks the model against what was actually built afterwards.

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

**Nothing is open.** All twenty-nine questions in
[`13-open-questions.md`](docs/domain/13-open-questions.md) are decided and recorded as
R1–R29; read the rationale there before reopening any of it.

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

Corrections the build surfaced are recorded as C1–C7 in
[`13-open-questions.md`](docs/domain/13-open-questions.md). C7 is the shape to copy when
you hit another: an invariant required a state transition the diagram never drew, so the
diagram gained the arrows rather than the invariant losing its teeth.

[`15-conformance-map.md`](docs/domain/15-conformance-map.md) traces an external functional
rubric onto the model; it is non-normative and nothing should cite it as a requirement.
