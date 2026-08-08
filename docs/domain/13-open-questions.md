# 13 — Open Questions

Decisions the model deliberately leaves open, and scope consciously deferred. Each has a
recommendation, because "it depends" is not a useful handoff to an implementation agent.
Resolve these before code generation; record the resolution here and in the affected file.

## Q1 — Keep `org_id` on every entity when there is only one org?

The model is single-org but carries `org_id` throughout.

**Recommendation: keep it.** It costs one column and buys a hosted mode later without a
migration, and it makes "every query is org-scoped" a rule that can be enforced once in the
data layer rather than argued about per endpoint. If it is ever dropped, it should be
dropped everywhere at once.

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

## Q4 — Should reviewers see submitter identity by default?

The model supports `open`, `single_blind` and `double_blind` per round and takes no
position.

**Recommendation: `single_blind` for the screening round, `open` for the deep round.** At AI
Engineer events speaker credibility is a legitimate selection criterion — who has actually
shipped the thing they are talking about matters — but it should not dominate the first cut.
Whatever is chosen, publish it in the CFP; submitters ask.

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

## Q7 — Attendee-facing features

No attendee accounts, no personal agenda builder, no session favouriting, no feedback
collection. The published snapshot and ICS feeds mean a marketing site could build a
client-side agenda with no backend.

**Recommendation: stay out of it for v1.** Session feedback is the one with real pull —
speakers want it and it feeds next year's selection. Revisit after one event.

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

## Q10 — Review assignment algorithm

The model records `assigned_by = algorithm` but does not specify one. Inputs available:
reviewer expertise (not yet modelled), track affinity, load, COI, and bidding via
`allow_self_assignment`.

**Recommendation: bidding first, then greedy load-balanced assignment for whatever nobody
bid on.** Bidding produces better reviews and needs no expertise model. If expertise is
added later it is a `ReviewerProfile` with track affinities and keywords — a small addition
to [`05`](05-review-and-selection.md).

## Q11 — Should `Session` and `Proposal` really be separate tables?

The strongest argument against the split: for the ~80% of sessions that come from an
accepted proposal and are never edited, it is two rows that say the same thing, and every
query needs to know which one to read.

**Recommendation: keep them separate.** The 20% — retitled talks, merged lightning talks,
speaker-less sponsor sessions, keynotes with no proposal, and above all frozen review
content — is exactly the 20% that breaks a merged model, and it breaks it late, after
there is data. This is the model's most consequential decision and the one most worth
challenging now rather than in month four.

## Q12 — Where does the "session content edited after review" divergence surface?

[INV-06-9](06-program.md) says proposal and session content diverge and are not auto-merged,
with divergence "surfaced to organizers". The surface is unspecified.

**Recommendation:** a `content_diverged` flag on `Session` plus a filter on the program
board. Not a notification — this is normal and expected, and notifying on it trains people
to ignore notifications.

## Q13 — Code of conduct incidents

`Review.flags` includes `code_of_conduct_concern` and stops there. A real incident workflow
(reports, investigation, speaker removal, retention rules) is a sensitive domain of its own.

**Recommendation: out of scope, deliberately, and say so.** Half-modelling this is worse
than not modelling it: an incomplete incident record in a general-purpose tool with broad
staff read access is a liability. Keep the flag as a routing signal to an off-platform
process.

## Q14 — Public speaker directory

`SpeakerProfile.is_listed` implies a directory but no entity describes it, and it is not in
the publication snapshot beyond `PublishedSpeaker`.

**Recommendation:** derive it from `PublishedSpeaker` in the live publication, filtered by
`is_listed`. No new entity. Worth confirming that a speaker who opts out of the directory
still appears on their own session — the model assumes yes.

## Q15 — Draft abandonment timeout for entitlement holds

[`03`](03-sponsorship.md) says a hold is released when a draft is "abandoned past a
timeout", without naming it.

**Recommendation: 14 days of no activity, with a warning email at 7.** Configurable per
event. This one needs a number before the code is written, because the alternative is
someone inventing one in an if-statement.

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
