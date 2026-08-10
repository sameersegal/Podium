---
name: domain-drift
description: Check that the normative domain model in docs/domain/ and the implementation still agree, and update the model where they do not. Use after writing or changing any code that touches domain behaviour — entities, fields, enums, state transitions, invariants, domain events, authorization or PII — and before committing or opening a PR, since the repo rule is that the model changes in the same PR as the code. Also trigger whenever someone asks whether the domain model is up to date, whether a change was documented, to review a branch or diff for model drift, or to audit the model on its own for internal inconsistency (invariants cited but never defined, events promised but not catalogued, entity anchors without tables, states nothing can reach). Drift is a defect, not a documentation chore: a commit that adds a field to a table without adding it to the model is incomplete.
---

# Domain drift

## What this is for

`docs/domain/` is the specification; code implements it. When they disagree, one of them is
a bug, and the repo's rule is that it gets resolved explicitly rather than silently. The
failure this prevents is slow and terminal: a field here, an enum member there, and within a
few months the model describes a product that no longer exists and everyone learns to ignore
it. Catching it takes minutes at commit time and is close to impossible six months later.

So the output of this skill is not a complaint. It is a **fix**, usually a diff to
`docs/domain/`, ready to go in the same commit as the code that caused it.

## Which side is wrong

The model and the code are each authoritative over different things. Getting this backwards
produces confident, wrong fixes.

| The model decides | The code decides |
|---|---|
| Entity names, field names, types, `Req` (Y/N/D) | Table layout, migrations, indexes, query shape |
| Enum members and what they mean | How enums are stored |
| State machines and which transitions exist | Which layer enforces them |
| Invariants | How they are checked |
| Domain event names and payload fields | Transport, queue topology, retries |
| Authorization matrix, PII classification | Policy engine and middleware structure |

So: code that adds a field the model lacks means **the model gains the field** — unless the
code invented a name that contradicts the glossary, in which case rename the code. Code that
indexes that field differently than you'd expect is not drift at all; do not report it.

**"Not built yet" is not drift.** Most of this model is deliberately ahead of the code.
Report unimplemented parts as *coverage*, clearly separated from defects, and only as a
defect when code claims to implement something and doesn't. A checker that screams about
every unbuilt entity gets ignored within a week, which is exactly how the model dies.

## Procedure

### 1. Scope it

Default to what changed, since that is what the person is about to commit:

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- . ':!docs/domain'   # the code side of the change
git diff main...HEAD -- docs/domain          # the model side, if any
```

If asked for an audit rather than a check, scope to the whole repo instead. Either way, note
whether `docs/domain/` was touched in the same change — a code diff with domain-shaped
changes and no model diff is the signature case this skill exists for.

### 2. Read the model side mechanically

Do not try to hold 3,000 lines of Markdown in your head. The model is written in a parseable
shape on purpose — entity anchors, one row per field, enums spelled out — so extract it:

```bash
python3 .claude/skills/domain-drift/scripts/model_inventory.py --check       # internal consistency
python3 .claude/skills/domain-drift/scripts/model_inventory.py --json        # full inventory to diff against code
python3 .claude/skills/domain-drift/scripts/model_inventory.py --entity Proposal
python3 .claude/skills/domain-drift/scripts/model_inventory.py --events
python3 .claude/skills/domain-drift/scripts/model_inventory.py --invariants
```

`--check` exits non-zero on ERROR, so it is CI-ready. Run it first: if the model
contradicts *itself*, comparing it to code is comparing against a moving target.

Treat the levels as: **ERROR** is a defect, fix it. **WARN** needs a judgement call — say
what you decided and why. **INFO** is context, not a task.

### 3. Read the code side

Find where each concern actually lives, then map code entities to model anchors — the
mapping must be exactly one-to-one in both directions:

- **Entities and fields** — schema definitions, type declarations, migrations. Field names
  and nullability, not column types or indexes.
- **Enums** — every string union, enum, or check constraint that mirrors a model enum.
- **States** — the transitions the code actually permits, including the ones it permits by
  omission. A transition the code allows that the diagram does not draw is drift.
- **Invariants** — grep for `INV-` in code and tests. The convention is that enforcing code
  cites its invariant in a comment and its test names it, which makes this greppable:
  ```bash
  grep -rn "INV-[0-9][0-9]-[0-9]" --include='*.ts' --include='*.py' --include='*.sql' . | grep -v docs/domain
  ```
- **Events** — every emit/publish call site, and the payload fields it actually sends.
- **Derived fields** — anything the model marks `D` must be computed at read time. A stored
  column for a `D` field is drift, and the reason is in `11-cross-cutting.md`: a stored
  counter is a counter that will eventually disagree with the rows it counts.

### 4. Compare

| Drift | How to spot it | Fixed on |
|---|---|---|
| Entity on one side only | code entity with no `<!-- entity: -->` anchor, or vice versa | model gains the anchor + table; or code is unbuilt (coverage) |
| Field added, renamed or removed | one row per field, backticked names, per entity | model, unless the code's name fights the glossary |
| `Req` disagrees | `Y`/`N`/`D` vs the code's nullability and writability | whichever is wrong — decide and say which |
| Enum member added or dropped | model spells members out in full | model gains members freely; a *removal* is breaking |
| Id prefix differs | each id row notes its `prefix` | code, almost always — prefixes are how ids get read aloud |
| Event catalogued but never emitted, or emitted but uncatalogued | `--events` vs emit call sites | uncatalogued event → catalogue it; uncatalogued *emission* is a contract leak |
| Event promised in a file's "Emitted events" but missing from the catalogue | `--check` reports it | model |
| Invariant cited in code but not defined, or defined and enforced nowhere | `--invariants` vs the grep above | cited-undefined → define it; defined-unenforced → coverage, unless code claims it |
| State unreachable, or a transition code allows that the diagram omits | `--check` plus reading the transition guards | model, if the code's behaviour is the intended one |
| Field marked `D` but stored | model inventory vs schema | code, unless it's a materialised read model |
| New field with no PII decision | `11-cross-cutting.md` classification | model |
| Reaction to an event that isn't idempotent on the event id | handler code | code — at-least-once delivery is assumed everywhere |

### 5. Report

Lead with the verdict, then the defects, then coverage. Keep it short enough to act on:

```markdown
## Domain drift: <scope>

**In sync** / **N drifts, M of them blocking**

### Drift
| # | What | Model says | Code says | Fix |
|---|---|---|---|---|
| 1 | `Session.recording_url` | not present | added in schema.ts:88 | add the field to `06-program.md` |

### Model-internal (from --check)
...

### Coverage (not drift)
Modelled but not yet built: <entities/events>. Expected at this stage.
```

Then apply the fixes, or say precisely which you want confirmed first — renaming anything,
removing an enum member, and retyping an event payload all change contracts and are worth a
sentence of confirmation.

## Fixing the model correctly

The model is written to be parseable. A fix that breaks its shape breaks every future check.

- **A new field**: add the row to the right table, in the right `**Section**` block, with
  the name backticked, the exact `Req`, and the id prefix noted if it is an id. Decide two
  things you cannot skip — its PII classification (`11-cross-cutting.md`) and whether it is
  stored or derived. `D` fields never get a column and are never writable.
- **A new enum member**: additive, so just add it inline in the `enum(a, b, c)` type. Never
  leave it as `enum(...)`; an elided enum cannot be diffed against code, which is why
  `--check` warns about the ones already like that. **Removing or renaming** a member is
  breaking: note it in the affected file and give a migration path.
- **A new event**: it must land in *two* places — the catalogue in `10-domain-events.md`
  (type, subject, `data` payload, PII flag) and the emitting context file's "Emitted events"
  line. If anything reacts to it, add the reaction-map row too, and make the handler
  idempotent on the event id. Names are `<noun>.<past-tense-verb>`, and state-change events
  name the state reached (`proposal.accepted`), never the transition.
- **A new invariant**: bold at its definition (`**INV-06-11**`) in that file's `## Invariants`
  section, taking the next free number *in that file*. Cite it bare (`INV-06-11`) anywhere
  else. Never renumber existing ones — code comments and tests point at them. It needs a
  test that names it, or it is a wish rather than an invariant.
- **A new state or transition**: add both the enum member and the edge in the
  `stateDiagram-v2`, with the command that causes it. A transition that is not drawn does
  not exist, so adding one to code without drawing it is the drift, not the other way round.
- **A new entity**: `<!-- entity: Name -->` anchor, field table, a line in its context file's
  ERD, and a line in the master ERD in `00-overview.md` if it is referenced across contexts.
- **Something the model genuinely never decided**: do not invent it. Add it to
  `13-open-questions.md` as a numbered question and say what the code currently assumes.

Re-run `--check` after editing. Then re-read your diff once as prose: these files are read by
people making decisions, and a row that parses but reads as gibberish has only half worked.

## When there is no code yet

That is the current state of this repo, and the skill is still useful — run `--check` and
report the model's internal consistency, which is the half of the job that does not need
code. Say plainly that the code side was empty rather than reporting "in sync", which would
be true and useless.
