---
name: podium-events
description: Set up and configure a conference on Podium — create an event, add days, rooms, tracks, session formats and venues, build and publish a call for proposals and its submission form, close or reopen the CFP, clone last year's event, and check whether the event is ready. Trigger on "create an event", "add a room/track/format/day", "open the CFP", "close submissions", "extend the deadline", "add a question to the submission form", "set up next year's conference", "clone last year".
---

# Setting up an event and its CFP

Read `podium-api` first for connection and conventions.

## Creating an event provisions a working event

`POST /v1/events` does not create an empty shell. It provisions a starter kit and tells you
what it made:

```bash
podium post /v1/events \
  name="DevFlow Conf 2028" slug="devflow-conf-2028" edition="2028" \
  timezone="America/Los_Angeles" starts_on=2028-05-10 ends_on=2028-05-12
```

```json
{ "id": "evt_…", "status": "draft", "visibility": "private",
  "provisioning": { "source": "starter",
    "counts": { "day": 2, "track": 1, "session_format": 5, "venue": 1,
                "room": 3, "rubric": 2, "task_definition": 12, "cfp": 1 } } }
```

So a new event already has days, rooms, formats, review rubrics, speaker onboarding tasks and
a draft CFP with a form. **Read what exists before adding anything** — the common mistake is
building a second set of tracks alongside the provisioned ones.

- `source=empty` provisions nothing, for an event whose structure comes from elsewhere.
- `POST /v1/events/:eventId/clone` copies a previous event's structure. `day_shift` moves the
  dates. This is the right move for "set up next year".

A new event is `draft` / `private`. `POST /v1/events/:eventId/activate` makes it live;
`POST /v1/events/:eventId/archive` retires it. `PATCH /v1/events/:eventId` edits the rest.

**Timezone is load-bearing.** Every wall-clock time in the schedule is resolved against it.
Set it correctly at creation; changing it later moves the programme.

## Structure

| What | List | Create | Edit / remove |
|---|---|---|---|
| Days | `GET /v1/events/:id/days` | `POST /v1/events/:id/days` | `PATCH`/`DELETE /v1/days/:dayId` |
| Rooms | `GET /v1/events/:id/rooms` | `POST /v1/events/:id/rooms` | `PATCH`/`DELETE /v1/rooms/:roomId` |
| Tracks | `GET /v1/events/:id/tracks` | `POST /v1/events/:id/tracks` | `PATCH`/`DELETE /v1/tracks/:trackId` |
| Formats | `GET /v1/events/:id/formats` | `POST /v1/events/:id/formats` | `PATCH`/`DELETE /v1/formats/:formatId` |
| Venues | `GET /v1/events/:id/venues` | `POST /v1/events/:id/venues` | — |

```bash
podium post /v1/events/evt_…/rooms name="Hall A" capacity:=400
podium post /v1/events/evt_…/tracks name="AI Engineering"
```

Rooms belong to a venue; formats carry the default duration a session of that kind runs for.
Check `reference/endpoints.md` in `podium-api` for the exact field list of any of these.

## Readiness

```bash
podium get /v1/events/evt_…/readiness
# { "ready": true, "blockers": [], "day_count": 2, "session_format_count": 5, "room_count": 3 }
```

Cheap, and the right thing to call before telling anyone the event is set up. `blockers` is a
list of what is still missing.

## The call for proposals

A CFP has a lifecycle — `draft` → `open` → `closed` — and a form that must itself be
published before the CFP can be.

```bash
podium get  /v1/events/evt_…/cfps                        # the provisioned one is here
podium get  /v1/cfps/cfp_…/builder                       # cfp + form + steps + fields, one read
podium patch /v1/cfps/cfp_… closes_at=2028-01-31T23:59:00Z row_version:=3
podium post /v1/cfps/cfp_…/publish                       # draft → open
podium post /v1/cfps/cfp_…/close reason="Deadline reached"
podium post /v1/cfps/cfp_…/reopen reason="Extended a week" closes_at=2028-02-07T23:59:00Z
```

Fields worth knowing when configuring one: `opens_at`, `closes_at`, `grace_period_minutes`,
`late_submission_policy`, `max_proposals_per_person`, `allow_edit_after_submit`,
`withdraw_allowed_until`, `notify_on_submit`, `audience`.

`PATCH /v1/cfps/:cfpId/options` sets which `tracks` and `formats` submitters may pick — a
subset of the event's, not a new list.

### The form

```bash
podium get  /v1/cfps/cfp_…/forms                          # every version and its status
podium post /v1/cfps/cfp_…/forms notes="Added a DEI question"   # new draft version
podium get  /v1/forms/frm_…                               # one version, with steps and fields
podium post /v1/forms/frm_…/steps key=about title="About your talk"
podium post /v1/forms/frm_…/fields step_id=stp_… key=takeaway label="Key takeaway" \
    type=long_text is_required:=true
podium post /v1/forms/frm_…/reorder steps:='["stp_a","stp_b"]'
podium post /v1/forms/frm_…/publish
```

Three things that catch people out:

- **Editing a published form forks it.** Adding a field to a published form does not fail and
  does not change the live form: it creates a new *draft* version and applies the edit there.
  The response comes back with a different `form_id` than the one you posted to — that is the
  new version. Check it, then `POST /v1/forms/<new id>/publish` to make it live. Read
  `versions` in the builder response to see where you are.
- **Every field needs a PII decision.** `pii: true` on a field means every API response
  redacts its answer unless the caller holds `pii:read`. Dietary requirements, phone numbers
  and access needs are PII. Say so when you add them.
- **Field `type` is from a fixed list**, and the builder response carries it along with which
  types take `options`: `short_text`, `long_text`, `markdown`, `email`, `url`, `number`,
  `single_select`, `multi_select`, `checkbox`, `date`, `file`, `speaker_list`, `track_picker`,
  `format_picker`, `duration_picker`, `consent`.

`maps_to` promotes an answer onto the proposal itself — one of `title`, `abstract`,
`description`, `track`, `format`, `duration`, `level`, `keywords`, `av_requirements`,
`recording_consent`, `coi_disclosure`, `speakers` — which is what makes it a column on the
proposal rather than one more answer. `audience` (`public`, `committee_only`,
`organizer_only`) controls who ever sees the answer. `visible_when` makes a field conditional.

## Custom fields

`GET`/`POST /v1/custom-fields` and `POST /v1/custom-fields/:id` extend entities beyond the CFP
form — a field on a sponsor or a session rather than on a submission.

## After the CFP closes

Proposals arrive; go to `podium-proposals`.
