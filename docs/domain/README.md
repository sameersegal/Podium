# Domain Model

This directory is the **normative specification** of the platform. Code implements this
model; when the two disagree, one of them is a bug and it must be resolved explicitly —
never silently.

## Reading order

| File | Context |
|---|---|
| [`00-overview.md`](00-overview.md) | Jobs to be done, bounded contexts, context map, master ERD |
| [`01-identity-and-access.md`](01-identity-and-access.md) | Org, Person, accounts, roles, invitations |
| [`02-event-configuration.md`](02-event-configuration.md) | Event, Track, SessionFormat, Venue, Room, CFP, submission forms |
| [`03-sponsorship.md`](03-sponsorship.md) | Sponsor, tiers, entitlements, sponsor contacts |
| [`04-submissions.md`](04-submissions.md) | Proposal, answers, speakers, drafts, the multi-step form runtime |
| [`05-review-and-selection.md`](05-review-and-selection.md) | Rounds, rubrics, assignments, reviews, conflicts, decisions |
| [`06-program.md`](06-program.md) | Session — the accepted program item and its speakers |
| [`07-onboarding.md`](07-onboarding.md) | Task definitions, task instances, deliverables, reminders |
| [`08-scheduling-and-publication.md`](08-scheduling-and-publication.md) | Rooms, slots, conflicts, publication snapshots, the embed |
| [`09-api-and-integrations.md`](09-api-and-integrations.md) | Public API, API keys and scopes, webhooks, plugin contracts |
| [`10-domain-events.md`](10-domain-events.md) | The canonical event catalogue (integration contract) |
| [`11-cross-cutting.md`](11-cross-cutting.md) | IDs, timestamps, soft delete, PII, audit, authorization matrix |
| [`12-glossary.md`](12-glossary.md) | Ubiquitous language |
| [`13-open-questions.md`](13-open-questions.md) | Unresolved decisions, deferred scope |

## Conventions used throughout

**Entity tables.** Every entity is specified as a field table:

| Field | Type | Req | Notes |
|---|---|---|---|

`Req` is `Y` (required), `N` (nullable/optional), or `D` (derived — not stored, computed
from other state). Derived fields are read models; they must never be written directly.

**Types.** `ulid`, `string`, `text`, `int`, `decimal`, `bool`, `timestamptz`, `date`,
`time`, `json`, `enum(...)`, `ref(Entity)`, `ref(Entity)[]`. `slug` is a lowercase
`[a-z0-9-]` string unique within its stated scope. All `timestamptz` values are stored in
UTC; see [`11-cross-cutting.md`](11-cross-cutting.md) for time rules.

**Aggregates.** Each context names its aggregate roots. Entities inside an aggregate are
only reachable through the root, and invariants are enforced at the root boundary.
Cross-aggregate consistency is eventual, carried by domain events.

**Invariants** are numbered per file (`INV-04-3`) so code, tests, and review comments can
cite them. Every invariant should have at least one test that names it.

**State machines** are given as Mermaid `stateDiagram-v2`. A transition that is not drawn
does not exist. Transitions name the command that causes them and, where relevant, the
role permitted to issue it.

**Domain events** are named `<noun>.<past-tense-verb>` (`proposal.submitted`). Every event
that crosses a context boundary must appear in [`10-domain-events.md`](10-domain-events.md);
that catalogue is a published contract and is versioned.

## Entity anchors

Each entity's field table is preceded by an HTML comment naming it:

```markdown
<!-- entity: Proposal -->
| Field | Type | Req | Notes |
```

The comment is invisible in rendered Markdown. It exists so a drift checker can map tables
to code exactly rather than guessing from headings — heading text is prose and will not stay
parseable. Every anchor must correspond to exactly one entity in the implementation, and
every entity to exactly one anchor.

## Keeping code and model in sync

The intent is that this is enforced in CI, not merely agreed. These are the drifts a checker
must be able to catch, and the reason each entry in this directory is written the way it is:

| Drift | Made detectable by |
|---|---|
| An entity in one side and not the other | the `<!-- entity: -->` anchors |
| A field renamed, added or removed on either side | one row per field, backticked names |
| A field's Req (`Y`/`N`/`D`) disagreeing with the code | the `Req` column being exact, `D` meaning derived |
| An enum member added or removed on either side | `enum(a, b, c)` written out in full wherever it is knowable |
| An id prefix that differs from the documented one | the `prefix \`xyz_\`` note on each id row |
| An event in the catalogue but unimplemented, or vice versa | [`10-domain-events.md`](10-domain-events.md) being the single catalogue |
| An event promised in a file's "Emitted events" but absent from the catalogue | those sections listing backticked event types |
| An `INV-xx-n` stated but not registered, or cited but never defined | bold at definition, bare in citations |
| A state declared but unreachable | the state diagrams being complete |

The rules those checks encode:

1. **Model first.** A behaviour change starts as a diff to this directory. Implementation
   PRs cite the invariant or entity they realise.
2. **One direction of truth per concern.** Field names, enum members, state transitions,
   invariants, and event names come from here. Indexes, migrations, table layout, and
   query shape are the code's business and are not specified here.
3. **Drift is a defect.** If code needs a field this model lacks, the model changes in the
   same PR. "I'll document it later" is how the model dies.
4. **Enum members are additive.** Removing or renaming an enum member is a breaking change
   and needs an entry in the changelog section of the affected file plus a migration note.
5. **Events are contracts.** Payload fields may be added; removing or retyping a field
   requires a new major version of the event type.

## Status

For review. No code has been merged yet.

The model has been through one round of trial implementation, which is what the entity
anchors and the corrections in
[`13-open-questions.md`](13-open-questions.md#corrections-found-while-implementing) came
from — building it surfaced five places where the model contradicted itself. Open decisions
are collected in the same file rather than being resolved silently in the body of the
model.
