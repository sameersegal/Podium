# 13 — Open Questions

Decisions the model deliberately leaves open, and scope consciously deferred. Each has a
recommendation, because "it depends" is not a useful handoff to an implementation agent.
Resolve these before code generation; record the resolution here and in the affected file.

## Q2 — Product name

The docs say "the platform" throughout. A name affects slugs, package names, email
sender identity and the embed script URL, so it is worth settling before the first line of
code. No recommendation — this is yours.

## Q3 — D1 or Postgres?

D1 is the native fit and almost certainly handles conference scale (thousands of proposals,
tens of thousands of task instances). The pressure points are the review aggregate
recomputation and the organizer onboarding board, both of which want real analytical
queries.

**Recommendation: start on D1** behind a repository layer, with Postgres-via-Hyperdrive as a
documented escape hatch. Avoid D1-specific SQL in the domain layer so switching stays a
week, not a rewrite.

## Q5 — Do sponsor sessions get scored at all?

Currently: `requires_review = false` on the format, with a compliance pass via
`changes_requested`.

**Recommendation: a lightweight one-criterion rubric** ("is this a technical talk or a
product pitch?") run by one organizer. It gives the "please rework this" conversation an
evidence base, which is much easier than having it from opinion.

## Q6 — Waitlist mechanics

Modelled as a `Decision.outcome` with promotion via a superseding decision. Not modelled:
ranked waitlist position, automatic promotion on a withdrawal, expiry of waitlist status.

**Recommendation: defer.** Add `waitlist_rank` to `Decision` when the first event actually
runs a waitlist; automatic promotion is a bad idea regardless — the chair should choose the
replacement.

## Q8 — Ticketing integration depth

Workshop capacity is modelled (`capacity_policy`, `registration_url`) but registration lives
elsewhere. The gap: knowing a workshop is full, on the schedule, in real time.

**Recommendation: a `ticketing` capability contract** with one method
(`get_capacity(session) -> {sold, remaining}`) and a cached count in the publication
snapshot. Do not model attendees.

## Q9 — Multi-language

`Person.locale`, `Session.language` and `NotificationTemplate.locale` exist. Not modelled:
translated session content, localised form fields, RTL in the embed.

**Recommendation: defer**, but keep `locale` on templates so the seam exists.

## Q13 — Code of conduct incidents

`Review.flags` includes `code_of_conduct_concern` and stops there. A real incident workflow
(reports, investigation, speaker removal, retention rules) is a sensitive domain of its own.

**Recommendation: out of scope, deliberately, and say so.** Half-modelling this is worse
than not modelling it: an incomplete incident record in a general-purpose tool with broad
staff read access is a liability. Keep the flag as a routing signal to an off-platform
process.

## Q15 — Draft abandonment timeout for entitlement holds

[`03`](03-sponsorship.md) says a hold is released when a draft is "abandoned past a
timeout", without naming it.

**Recommendation: 14 days of no activity, with a warning email at 7.** Configurable per
event. This one needs a number before the code is written, because the alternative is
someone inventing one in an if-statement.

## Q16 — Is password login on or off by default?

[`01`](01-identity-and-access.md) adds `provider = password` behind
`settings.auth.password_login_enabled`, defaulted off in favour of email OTP and OAuth.
That default is right for a hosted conference org and wrong for every other consumer of the
product — a self-hoster with no mail provider, a CI suite, an evaluation harness, a demo.

**Recommendation: off by default in production configuration, on in the shipped default
seed and in any deployment without an active `email` integration.** A deployment that can
neither send mail nor accept a password is a deployment nobody can sign into, and that
failure mode is worse than the marginal risk of password auth on a conference tool.
Whatever is chosen, INV-01-15 stands: an invitation link must always be retrievable
on-screen.

## Q17 — Ship AI evaluation in v1?

[`05`](05-review-and-selection.md) now models `Review.author_kind = ai` with mandatory
rationale, no quorum contribution and a human override. The model is cheap; the feature is
not, and a bad first-pass score anchors a committee even when everyone knows it is a
machine's.

**Recommendation: model it now, ship it behind an org setting, default off.** The
guardrails (never counts toward quorum, always labelled, always overridable) are worth
having in the model before anyone is tempted to add it in a hurry. Whether a committee
turns it on is their call, and the ones who do will mostly use it to triage a first cut of
900 submissions rather than to decide anything.

## Q18 — Auto-publish: default, opt-in, or never?

[`08`](08-scheduling-and-publication.md) adds `PendingPublicationChanges` plus an
`auto_publish` setting, default off. The tension is real in both directions: manual publish
means the public page can silently lag reality; auto-publish means a half-finished
rearrangement can go live unattended.

**Recommendation: keep the default off, and make the staleness indicator loud enough that
it does not matter.** Revisit after one event with real data on how far behind the
published schedule actually drifts — if the answer is "days", the default is wrong.

## Q19 — Assisted placement: solver or model?

[`08`](08-scheduling-and-publication.md) specifies `AutoPlaceRun` as a proposal with a
per-placement `rationale`, and deliberately does not say how the proposal is computed.

**Recommendation: a constraint solver first.** Room, time, speaker availability and series
ordering are hard constraints with a well-understood shape, and a solver's output is
explainable and reproducible in a way that matters when an organizer is deciding whether to
accept 120 moves. A language model is the better fit for the soft, unstated preferences
("keep the beginner talks out of the 9am slot"), which is a second pass over a feasible
schedule rather than the thing that produces one.

## Q20 — Who governs custom field proliferation?

[`11`](11-cross-cutting.md) adds `CustomFieldDefinition`, restricted to chairs and admins.
Every product that ships custom fields eventually has a customer with two hundred of them,
half unused, several containing data that should never have been typed into a free-text box.

**Recommendation: no hard cap, but surface usage.** A field-management screen showing
fill rate and last-used date per definition, and an archive action that keeps values while
retiring the field. Consider a soft warning past ~25 definitions per subject type. The
`pii` and `audience` flags being mandatory at creation is the guardrail that actually
matters.

## Q21 — Does the sourcing pipeline belong in v1?

[`14`](14-speaker-crm.md) models the cross-event directory, segments and a kanban sourcing
pipeline. The directory is unarguable — it is `Person` with a view over it. The pipeline is
a second product surface with its own board, cards, stages and history.

**Recommendation: directory and segments in v1; pipeline after the first event.** The
directory's value is immediate and its cost is a query; the pipeline's value only appears
during the run-up to a *second* event, by which point real usage will say whether it is a
kanban board or just a `ContactSegment` plus `next_action_at` on the roster.

---

## Resolved

Recorded here so the reasoning is not relitigated. Move entries up from above as they are
decided.

| # | Decision | Rationale |
|---|---|---|
| R1 | Single org, many events | Chosen by the product owner; `org_id` retained per Q1 |
| R2 | Markdown + Mermaid as the model's format | Human review comes first; machine-readable extraction can be added later without changing the content |
| R3 | Sponsor sessions are first class, not admin-created talks | The entitlement is the constraint no generic CFP tool can express |
| R4 | Speaker and sponsor contact are relationships, not roles | Access ends when the relationship ends, in the same transaction |
| R5 | Decisions are provisional until explicitly published | Prevents the "saved a dropdown, emailed 400 rejections" failure |
| R6 | The public schedule is an immutable versioned snapshot | Makes the embed cacheable, diffs computable, rollback trivial |
| R7 | Entity tables carry an `<!-- entity: Name -->` anchor | Invisible when rendered; makes the doc↔code diff exact instead of heuristic |
| R8 | Derived fields get no database column, except on materialised read models | A stored counter is a counter that will disagree with the rows it summarises |
| R9 *(was Q1)* | `org_id` stays on every entity | Settled by the addition of [`14`](14-speaker-crm.md): a cross-event speaker directory, org-level segments and an org-scoped sourcing pipeline are org-scoped by definition. The column is no longer speculative — it is load-bearing today. |
| R10 *(was Q4)* | Anonymity is a per-round setting; seed round 1 as `double_blind`, round 2 as `open` | Blind review must be a visible, per-round toggle whose effect is checkable: under it, no speaker name, co-speaker name or employer appears anywhere in the reviewer's view, while the organizer's view of the same proposal shows all of them. `single_blind` was the earlier recommendation and is too weak — it hides reviewers from submitters, which is not the direction that biases a first cut. |
| R11 *(was Q7)* | Personal schedules exist; attendee accounts do not | Starring sessions and exporting them to a calendar is the most-used interaction on any conference schedule, and it needs no server state: selection lives in the visitor's browser and export is the existing ICS serialiser over the chosen ids. No `Attendee` entity, no login, nothing to erase. Session feedback remains deferred. See [`08`](08-scheduling-and-publication.md). |
| R12 *(was Q10)* | Caps, filtered bulk assignment and auto-distribution; bidding deferred | A round of hundreds of proposals is not assigned by clicking, so at-scale tooling is required rather than optional: a per-reviewer cap, assignment over a track/format-filtered set, and a COI- and cap-aware auto-distribute that produces a proposal for the chair to confirm. Bidding is a better *quality* mechanism and remains the intended next step, but it is not what makes a round assignable. See [`05`](05-review-and-selection.md). |
| R13 *(was Q11)* | `Proposal` and `Session` stay separate — and are presented as one record | The split survives contact with the full workflow: the organizer edits a session's title and abstract after acceptance, restores a prior version, and gates it behind content approval, all while the review record stays frozen against what was actually reviewed. What the split must *not* do is leak into the UI as two rows a user has to reconcile; the programme surface shows one "session record" whose provenance is a proposal. Modelled separately, presented as one. |
| R14 *(was Q12)* | `content_diverged` is a derived flag and a board filter, never a notification | Confirmed and now specified in [`06`](06-program.md) alongside `content_status`. Divergence between a session and its decision snapshot is the normal case after any copy-edit; alerting on the normal case trains people to dismiss alerts. |
| R15 *(was Q14)* | The public speaker directory is derived from `PublishedSpeaker`, in two presentations | No new entity, as originally recommended — but it is *two* widgets over that data, not one: a `speakers_list` directory ordered by surname with job title, company and per-speaker session lists, and a `speaker_gallery` photo grid. Both drill into a detail view. `is_listed = false` removes a speaker from both while leaving them credited on their own session, which the model had assumed and now states. See [`08`](08-scheduling-and-publication.md). |

## Corrections found while implementing

The model was trial-implemented once, as a domain layer with a doc↔code drift checker, to
find out where it did not hold up. That code is not merged; it lives on
`claude/sessionboard-domain-implementation` and is the reference for what the checks in
[`README.md`](README.md#keeping-code-and-model-in-sync) would look like in practice.

The exercise surfaced five places where the model contradicted itself. All are fixed here;
recorded because each was a real gap, not a typo.

| # | Gap | Fix |
|---|---|---|
| C1 | `Review.status` prose required a `superseded` state that the enum did not list | Added `superseded` to the enum |
| C2 | INV-05-11 allowed accepting without quorum "with a recorded reason", but `Decision` had nowhere to record it | Added `Decision.quorum_waived_reason` |
| C3 | INV-06-5 allowed a chair to publish past a blocking task, with no field for the override; INV-06-9 said divergence is "surfaced" without saying where | Added `Session.publication_override_reason` and `Session.content_diverged` |
| C4 | `TaskInstance` snapshotted `instructions` as required, but `TaskDefinition.instructions` is optional | Split the row; `instructions` is nullable on the instance |
| C5 | `08-scheduling-and-publication.md` promised `embed_config.created`, which was missing from the event catalogue | Added it to the catalogue |

One structural change came with them: `CfpFormatOption` and `CfpTrackOption` shared a single
table with a `session_format_id | track_id` cell. They are now two tables, because one row
cannot describe two entities.
