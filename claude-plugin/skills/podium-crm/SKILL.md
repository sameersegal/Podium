---
name: podium-crm
description: Speaker sourcing and outreach on Podium — prospect pipelines and cards, saved segments of people, and email campaigns with a previewable audience. Trigger on "email the speakers", "email the waitlist", "send an announcement", "who should we invite to keynote", "add them to the shortlist", "build a segment", "preview who this goes to", "schedule the newsletter", "invite this person to submit".
---

# Sourcing and outreach

Read `podium-api` first for connection and conventions.

Two halves that share a vocabulary: **sourcing** (pipelines of prospective speakers you are
courting) and **outreach** (campaigns to people you already have).

## Prospect pipelines

```bash
podium get  /v1/pipelines
podium post /v1/pipelines name="2028 keynotes" event_id=evt_…
podium get  /v1/pipelines/pip_…
podium get  /v1/prospects pipeline_id=pip_…
podium post /v1/prospects pipeline_id=pip_… person_id=per_… \
    topic="Incremental type-checking" score:=4 rationale="Ran the CI track at …" \
    owner_person_id=per_… next_action_at=2027-01-20T10:00:00Z
podium post /v1/prospects/prc_…/convert
```

A card moves along the pipeline's stages. `convert` turns a prospect into an invitation to
submit — the seam between sourcing and the CFP.

## Segments

```bash
podium get  /v1/segments --fields id,name,kind,member_count
podium get  /v1/segments/seg_…
podium post /v1/segments kind=static name="2028 keynote shortlist" \
    member_person_ids:='["per_…","per_…"]'
podium post /v1/segments kind=dynamic name="Unconfirmed speakers" criteria:='{ … }'
```

Two kinds, and the difference matters:

- **`static`** — an explicit list of people. A decision somebody made. Membership does not
  change because a tag changed.
- **`dynamic`** — a saved query. Membership is recomputed.

Use `static` for anything a human curated; use `dynamic` for "everyone who currently ….".

## Campaigns

```bash
podium get  /v1/campaigns event_id=evt_…
podium post /v1/campaigns event_id=evt_… name="Speaker briefing" channel=email \
    subject="Your session details" body_markdown="…" \
    audience:='{"kind":"speakers","event_id":"evt_…"}'
podium get  /v1/campaigns/cmp_…/preview-audience
podium post /v1/campaigns/cmp_… subject="A better subject"      # edit before sending
podium post /v1/campaigns/cmp_…/schedule scheduled_for=2027-01-20T09:00:00Z
podium post /v1/campaigns/cmp_…/send
podium post /v1/campaigns/cmp_…/cancel
```

> **The audience needs its own `event_id`.** The campaign's top-level `event_id` does not scope
> the audience. `audience: {"kind":"speakers"}` on an event campaign resolves to **zero
> recipients** and sends to nobody, with no error. Put the event id inside the criteria:
> `{"kind":"speakers","event_id":"evt_…"}`.

`audience.kind` is one of `event_participants`, `speakers`, `sponsor_contacts`, `reviewers`,
`people`, `segment`. Alongside it: `event_id`, `participant_status[]`, `track_ids[]`,
`task_state`, `has_outstanding_tasks`, `person_ids[]`, `segment_id`.

### Always preview before sending

```bash
podium get /v1/campaigns/cmp_…/preview-audience
# { "total": 7, "sample": [ { "person_id": "per_…", "email": "…", "name": "…" }, … ] }
```

**Never call `/send` without showing the operator `total` and the sample first.** Sending is
irreversible and goes to real people. A `total` of 0 or of 4,000 both mean the criteria are
wrong. Treat `/send` as an action needing explicit confirmation, every time.

`/schedule` queues it for a time instead. `/cancel` stops a scheduled campaign; it cannot
unsend one.

Delivery is subject to core rules the campaign does not override: quiet hours, unsubscribes
and the suppression list. So the number delivered can be lower than the audience total, and
that is correct behaviour, not a failure.

## Did it arrive?

```bash
podium get /v1/notifications campaign_id=cmp_…
podium get /v1/notifications event_id=evt_… person_id=per_… status=bounced
```

Filters: `event_id`, `person_id`, `session_id`, `campaign_id`, `status`. This is the log of
what was actually sent, and it is redacted without `pii:read`. Bounces and complaints arrive
here from the email provider's callback.
