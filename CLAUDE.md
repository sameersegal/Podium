# Working in this repository

An open-source SessionBoard alternative for AI Engineer–style conferences. See
[`README.md`](README.md) for what it does.

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

## Current state

Domain model in review; no application code exists yet. Do not scaffold an implementation
unless asked — the open questions in
[`13-open-questions.md`](docs/domain/13-open-questions.md) (notably Q3 on the datastore and
Q11 on the `Proposal`/`Session` split) should be resolved first, since they change the shape
of what gets generated.
