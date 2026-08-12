---
name: podium-schedule
description: Build and publish a Podium conference agenda — read the whole grid in one call, place sessions into rooms and times, move or remove placements, run and apply an auto-placement pass, review and acknowledge scheduling conflicts, publish a schedule snapshot and roll one back. Trigger on "put this talk in room X at 2pm", "build the schedule", "what clashes", "why can't I publish", "publish the agenda", "roll back the schedule", "is the programme live", "auto-schedule the rest".
---

# The schedule

Read `podium-api` first for connection and conventions.

Three things about this context differ from every other one, and each of them will bite:

1. **Every placement write is serialised through one writer per event.** Two agents dragging
   the same slot queue rather than interleave. You do not need to coordinate; you do need to
   expect a write to wait.
2. **Every placement write answers with the conflicts it caused** (INV-08-14), in the same
   response. Do not write and then re-read to find out what broke — the response already says.
3. **Wall-clock times are resolved server-side, in the event's timezone.** Send `start_time`
   ("14:00"), not a UTC instant, unless you are already holding an instant. Doing the
   arithmetic yourself means reimplementing that zone's DST rules, and a placement an hour out
   is a speaker in the wrong room.

## Read the whole grid in one call

```bash
podium get /v1/events/evt_…/schedule
```

Returns `{ data: { event, days, rooms, time_slots, placements, unplaced, conflicts,
pending_count } }` — the entire grid, the queue of sessions not yet placed, the live conflict
list, and how many changes are waiting to be published. This is the right first call for any
scheduling question; nothing here needs a per-cell fetch.

## Place, move, remove

```bash
podium post /v1/events/evt_…/placements session_id=ses_… \
    event_day_id=day_… room_id=rom_… start_time=14:00 duration_minutes:=45

podium patch /v1/placements/plc_… start_time=14:00          # retime
podium patch /v1/placements/plc_… room_id=rom_…             # move rooms
podium patch /v1/placements/plc_… event_day_id=day_… start_time=09:30
podium delete /v1/placements/plc_…                          # back to the unplaced queue
```

`POST` takes `session_id`, `event_day_id`, `room_id`, and either `start_time` + (`duration_minutes`
or `ends_at`) or an explicit `starts_at`/`ends_at` pair. `time_slot_id` places into a
predefined slot instead. `PATCH` accepts any of `event_day_id`, `room_id`, `start_time`,
`starts_at`, `ends_at`, `duration_minutes`.

Both answer:

```json
{ "data": { "placement_id": "plc_…", "conflicts": [ … ] } }
```

Read the `conflicts` array every time. An empty array means the move was clean.

## Conflicts

```bash
podium get  /v1/events/evt_…/conflicts
podium post /v1/conflicts/scf_…/acknowledge reason="Chair approved the double-booking"
```

A conflict carries `code`, `severity`, `placement_ids`, `session_ids` and a `detail` object
whose `message` is written to be shown to a human. Codes you will meet include speaker
double-booking, room overlap, and `UNPUBLISHABLE` — a session that cannot go live yet, most
often because its speaker still has blocking onboarding tasks outstanding:

```json
{ "code": "UNPUBLISHABLE", "severity": "error",
  "detail": { "blocking_tasks_outstanding": 1,
              "message": "\"How We Cut Cold Starts to 40ms\" has 1 blocking onboarding task outstanding." } }
```

**Acknowledging requires a `reason`, and an acknowledged conflict stays in the list** — it does
not disappear, it gains `acknowledged_by_person_id` and `acknowledged_reason`. That is
deliberate: the record of who accepted the clash is the point.

For an `UNPUBLISHABLE` conflict the real fix is usually in `podium-speakers` — chase or waive
the blocking task — not an acknowledgement.

## Auto-placement

```bash
podium post /v1/events/evt_…/auto-place
podium get  /v1/auto-place-runs/apr_…
podium post /v1/auto-place-runs/apr_…/apply                      # accept the whole run
podium post /v1/auto-place-runs/apr_…/apply session_ids:='["ses_…","ses_…"]'   # or a subset
```

**A run proposes and never writes.** It answers `{ run_id, strategy, status: "proposed",
proposed, unplaceable, conflicts_introduced }`. Show `proposed` and `conflicts_introduced`
before applying anything — this is a suggestion to review, not a job to fire and forget. An
empty `proposed` list usually means everything is already placed.

## Publishing

The public schedule, the embeds and the ICS feed serve the `live` publication and nothing
else. Until you publish, changes are invisible outside the admin surface.

```bash
podium get  /v1/events/evt_…/publications      # history + what is pending
podium post /v1/events/evt_…/publications note="Final agenda"
podium post /v1/publications/pub_…/rollback reason="Wrong room on the keynote"
```

`GET` returns the publication history plus `pending_changes` — `count`, the changes themselves
and a `by_kind` breakdown (`added`, `removed`, `retitled`, `retimed`, `reroomed`,
`reapproved`). `count: 0` means the live snapshot is current, which is the honest answer to
"is the schedule up to date".

`POST` answers with what it published *and what it skipped*:

```json
{ "data": { "publication_id": "pub_…", "version": 2, "session_count": 6, "diff": [],
  "skipped": [ { "session_id": "ses_…", "publishable": false, "overridable": true,
     "reasons": [ { "code": "content_not_approved", "invariant": "INV-06-11",
                    "message": "Content is draft, not approved." } ] } ] } }
```

**A publish that skips sessions still succeeds.** Always report `skipped` — a snapshot missing
three talks is not a successful publish from the organizer's point of view, and the reasons
name the invariant so the next step is unambiguous. `content_not_approved` is fixed in
`podium-speakers` by approving the session content.

Rollback restores an earlier snapshot as live. It takes a `reason` and is recorded.

## Reading the public result

The published programme, with no token at all:

```bash
podium get /v1/public/events/<event-slug>/schedule
podium get /v1/public/events/<event-slug>/sessions
podium get /v1/public/events/<event-slug>/speakers
```

Useful as a final check that what you published is what the world sees.
