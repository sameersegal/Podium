---
name: podium-proposals
description: Work the submission pile on Podium — list and filter proposals, read scores, open review rounds, assign reviewers, post reviews, and record, publish and communicate accept/reject/waitlist decisions. Trigger on "how many proposals", "which talks are unreviewed", "assign reviewers", "what did the committee score", "accept this talk", "send the rejections", "who is on the waitlist", "close the review round", or any question about the state of the CFP pile.
---

# Proposals, reviews and decisions

Read `podium-api` first for connection and conventions.

Vocabulary, because getting it wrong produces confident wrong answers: a **`Proposal`**
(`prp_…`) is what someone submitted. A **`Session`** (`ses_…`) is what appears in the
programme. Accepting a proposal is what creates the session. A **`Decision`** (`dec_…`) is a
record with its own lifecycle, not a field on the proposal.

## Reading the pile

`event_id` is required — without it you get `422 validation_failed` naming the field.

```bash
podium list /v1/proposals event_id=evt_… \
  --fields id,reference,title,status,submitted_at,review_count,target_reviews,track_name

podium list /v1/proposals event_id=evt_… status=submitted,in_review       # comma-separated
podium list /v1/proposals event_id=evt_… track_id=trk_… origin=sponsor
podium get  /v1/proposals event_id=evt_… q=kubernetes                     # free-text search
```

Filters: `status`, `track_id`, `format_id`, `origin`, `cfp_id` (each takes a comma-separated
list), `q` for search, `sort` (default `newest`). The response carries `total` alongside
`data` and `next_cursor`, so a count does not require walking the pages.

Useful response fields beyond the obvious: `reference` (the human-facing "DFC27-0013"),
`review_count` / `target_reviews` (how far through review it is), `origin` (`sponsor` marks a
proposal against a sponsor entitlement), `submitter_name` / `submitter_email` (redacted
without `pii:read`), `speaker_names`, `track_name`, `format_name`, `session_id` once accepted.

**The status field is `status`, not `state`** — `draft`, `submitted`, `in_review`,
`changes_requested`, `accepted`, `waitlisted`, `rejected`, `withdrawn`, `expired`. Asking for
`state` silently returns nothing useful; asking for an unknown status returns an empty list
rather than an error.

`GET /v1/events/:eventId/dashboard` gives the funnel counts in one call and is the right
answer to "how is the CFP going".

## Editing a proposal

```bash
podium patch /v1/proposals/prp_… title="A clearer title" reason="Fixed a typo for the programme"
```

This is an *organizer edit*: it writes a revision, emits `proposal.updated` and is visible in
the proposal's history. `reason` is recorded — write a real one. Editable fields are `title`,
`abstract`, `description`, `session_format_id`, `requested_duration_minutes`, `track_id`,
`assigned_track_id`, `audience_level`, `language`, `keywords`, `recording_consent`,
`recording_conditions`, `coi_disclosure`.

`POST /v1/proposals/:id/withdraw` takes a `reason`.

**Submitting is the submitter's own act (INV-09-27).** `POST /v1/proposals/:id/submit` answers
`403 authorship_requires_person` to every key, whatever its scopes. What you *can* do is start
the draft for them:

```bash
podium post /v1/proposals cfp_id=cfp_… submitter_person_id=per_…
```

It appears in that person's portal at `/portal/proposals/:id`, where they fill in the answers
and submit. That is the whole supported shape of "create a proposal for somebody" — an
invitation, not a statement made in their name. Report it that way rather than hunting for
another route.

## Review rounds

```bash
podium get  /v1/rounds event_id=evt_…
podium post /v1/rounds event_id=evt_… name="Screening" rubric_id=rub_… \
    target_reviews_per_proposal:=2 anonymity=double_blind
podium get  /v1/rounds/rnd_…
```

A round carries `rubric_id`, `scope` (which CFPs it covers), `anonymity`, `opens_at`,
`closes_at`, `target_reviews_per_proposal`, `max_assignments_per_reviewer`,
`allow_self_assignment`, `show_other_reviews_before_submit`, `discussion_enabled`, `status`.

**`anonymity` decides what you can see.** In a `double_blind` or `single_blind` round,
`reviewer_person_id` comes back `null` on every review. That is the rule working; it is not a
redaction `pii:read` unlocks. Only an `open` round exposes reviewer identity.

### Assignments and reviews

```bash
podium list /v1/assignments round_id=rnd_… --fields id,proposal_id,reviewer_person_id,status
podium post /v1/assignments round_id=rnd_… proposal_id=prp_… reviewer_person_id=per_…

podium get  /v1/reviews round_id=rnd_…        # round_id or proposal_id is required
podium post /v1/reviews/rvw_…/override reason="…"
```

**Writing a review is the reviewer's own act (INV-09-27).** `POST /v1/reviews` answers
`403 authorship_requires_person` to every key, whatever its scopes — a review is attributed to
the reviewer whose assignment it answers, under an anonymity setting that only means something
if that attribution is true. Reviewers write them signed in at `/review`. An agent reads
reviews, aggregates them, chases the missing ones and decides on the result; it does not author
them. `POST /v1/reviews/:reviewId/override` is different and is available: that is a chair's
own act on an AI first-pass review. **Declining** goes the same way as writing:
`POST /v1/me/assignments/:id/decline` is the reviewer's own statement and refuses a key too.
Taking an assignment back is the chair's act and stays open —
`POST /admin/rounds/:roundId/assignments/:assignmentId/revoke`.

Finding what still needs reviewers: list proposals with `--fields id,title,review_count,target_reviews`
and filter locally for `review_count < target_reviews`. There is no server-side "unreviewed"
filter.

### Scores

```bash
podium get /v1/proposals/prp_…/score round_id=rnd_…
```

Returns `review_count`, `submitted_count`, `stale_count`, `human_review_count`,
`ai_review_count`, `mean`, `median`, `stddev`, `weighted_mean`, `per_criterion_mean`,
`per_criterion_histogram` and `recommendation_histogram`. `stale_count` is reviews written
against content that has since changed — worth surfacing before a committee leans on a mean.

## Decisions

Two steps, deliberately. Recording a decision is not telling anyone.

```bash
# 1. record it — lands as `provisional`
podium post /v1/decisions proposal_id=prp_… outcome=accept \
    assigned_track_id=trk_… assigned_format_id=fmt_… \
    confirmation_deadline=2027-01-15T12:00:00Z \
    feedback_for_speaker="…" rationale="Committee consensus."

# 2. publish a batch — this is what notifies the speakers
podium post /admin/events/evt_…/decisions/publish decision_id:='["dec_…","dec_…"]'
```

`outcome` is `accept`, `reject`, `waitlist`. A decision moves `provisional` → `published`, and
a later decision on the same proposal supersedes the earlier one (`supersedes_decision_id`).

Publishing is the only step on the admin surface rather than `/v1` — it answers **303, which
is success**. Verify with `GET /v1/decisions event_id=…` and check `status` and `published_at`.

Rules that will refuse a publish, each with a readable reason in the `skipped` list:

- **An acceptance needs a `confirmation_deadline`, and it must be in the future.** This is the
  single most common failure. A decision recorded without one is silently skipped.
- Already published — publishing again sends nothing (INV-05-10).
- Superseded by a later decision.
- The proposal is `draft`, `withdrawn` or `expired`.

`GET /v1/decisions event_id=…` lists them. There is no un-publish; correct a published
decision by recording a new one and publishing that.

## After acceptance

An accepted proposal becomes a session with its own content lifecycle, speakers and onboarding
tasks — `podium-speakers`. Getting it onto the agenda — `podium-schedule`.
