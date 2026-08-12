---
name: podium-speakers
description: Manage the confirmed programme on Podium — sessions and their content approval, the speakers on each session, and the onboarding tasks (agreements, bios, headshots, slides, travel) that must be done before a session can go live. Trigger on "who is speaking", "add a co-speaker", "chase the speakers", "which speakers haven't signed", "send a reminder", "approve this session's content", "waive the travel form", "why is this session unpublishable", "has everyone confirmed".
---

# Sessions, speakers and onboarding

Read `podium-api` first for connection and conventions.

A **`Session`** (`ses_…`) is what appears in the programme; the `Proposal` it came from
(`prp_…`) is a separate record with a separate lifecycle. **Speaker** is a relationship to a
session, not a role someone holds — there is nothing to "make someone a speaker" except
attaching them to a session.

## Sessions

```bash
podium list /v1/sessions event_id=evt_… \
  --fields id,reference,title,status,content_status,track_name,format_name,speaker_names
podium get  /v1/sessions/ses_…
podium list /v1/sessions event_id=evt_… status=confirmed
```

Two independent status fields, and confusing them is the usual mistake:

- **`status`** — where the session is in the programme: `pending_confirmation`, `confirmed`,
  `scheduled`, `published`, `cancelled`, `delivered`.
- **`content_status`** — whether the title/abstract are signed off: `draft`, `in_review`,
  `approved`, `changes_requested`.

**A session whose content is not `approved` is skipped by a schedule publish** with
`content_not_approved` (INV-06-11). This is the most common reason a talk is missing from a
published agenda.

Content review runs on the admin surface (303 means success):

```bash
podium post /admin/sessions/ses_…/submit-for-review
podium post /admin/sessions/ses_…/approve-content
podium post /admin/sessions/ses_…/request-content-changes note="Trim the abstract to 80 words"
podium post /admin/sessions/ses_…/cancel reason="Speaker withdrew"
```

`draft` → `in_review` → `approved`. Approving straight from `draft` answers
`422 illegal_transition`; submit it for review first. Verify with
`podium get /v1/sessions/ses_… ` and read `content_status` back.

## Speakers on a session

```bash
podium get  /v1/sessions/ses_…/speakers
podium post /v1/sessions/ses_…/speakers person_id=per_… speaker_role=co_speaker
podium post /v1/sessions/ses_…/speakers email=new@example.com full_name="Alex Fry" \
    speaker_role=co_speaker
```

Either `person_id` or `email` is required; giving neither is a `422` naming the field. Roles:
`primary`, `co_speaker`, `moderator`, `panelist`, `host`. Each speaker carries a
`confirmation_status` of `pending`, `confirmed`, `declined`, `withdrawn` or `replaced`.

Adding a person by email creates or matches a `Person` and invites them. The response is
redacted without `pii:read` — email addresses will come back masked.

Removing, replacing and confirming a speaker are admin-surface posts:

```bash
podium post /admin/sessions/ses_…/speakers/per_…/remove reason="…"
podium post /admin/sessions/ses_…/speakers/per_…/replace reason="…"
podium post /admin/sessions/ses_…/speakers/per_…/confirm
```

Speakers normally confirm themselves from `/portal`. Confirming on their behalf is an override
and should be reported as one.

## Onboarding tasks

Tasks are materialised from **task definitions**. A new event is provisioned with about a
dozen: the speaker agreement, bio and headshot, slides, travel details.

```bash
podium get /v1/task-definitions event_id=evt_…
podium get /v1/task-definitions/tdf_…
```

A definition carries `requirement_type` (`acknowledgement`, `text_response`, `file_upload`, …),
`config`, `assignee_rule`, `applies_to`, `trigger`, `due_rule`/`due_value`, `is_blocking`,
`is_required`, `requires_review`.

```bash
podium post /v1/task-definitions event_id=evt_… title="Send us your slides" \
    requirement_type=file_upload subject_type=session due_rule=… is_blocking:=true
podium post /v1/task-definitions/tdf_…/activate
podium post /v1/task-definitions/tdf_…/rematerialise   # apply to sessions that already exist
podium post /v1/task-definitions/tdf_…/retire
```

**`rematerialise` is the step people forget.** Activating a new definition does not
retroactively create instances for sessions that already exist; that call does.

### Working the task list

```bash
podium list /v1/tasks event_id=evt_… \
  --fields id,title,status,is_blocking,due_at,is_overdue,assignee_name,session_title
podium list /v1/tasks event_id=evt_… status=not_started
podium list /v1/tasks event_id=evt_… assignee_person_id=per_…
```

Filters are `event_id`, `assignee_person_id` and `status` — one status at a time.
Statuses are `blocked`, `not_started`, `in_progress`, `submitted`, `changes_requested`,
`completed`, `waived`, `cancelled`. **There is no `pending`**; asking for it returns an empty
list, not an error, which reads exactly like "everyone is done".

`is_overdue` is computed for you. There is no server-side overdue filter — list and filter
locally.

Task list responses are filtered by what the caller may see, so a page can be shorter than
`limit` without being the last. Follow `next_cursor` (`podium list` does).

### Acting on a task

```bash
podium post /v1/tasks/tsk_…/remind                                  # → { "sent": 1, "suppressed": 0 }
podium post /v1/tasks/tsk_…/approve note="Looks good"
podium post /v1/tasks/tsk_…/request-changes note="The headshot is 200px wide"
podium post /v1/tasks/tsk_…/waive reason="Speaker is local, no travel needed"
podium post /v1/tasks/tsk_…/cancel reason="Session cancelled"
podium get  /v1/tasks/tsk_…/submissions                             # what they sent
```

`remind` answers `{ sent, suppressed }`. **`suppressed` is not an error** — it counts
recipients held back by quiet hours, unsubscribes or the suppression list. A reminder with
`sent: 0, suppressed: 1` was delivered to nobody; say so rather than reporting success.

Before reminding everyone: list the outstanding tasks, group them by assignee, and check
whether one person is about to receive nine emails. Batch politely or use a campaign
(`podium-crm`).

## Unblocking a schedule publish

The loop that closes the most common failure:

1. `podium get /v1/events/evt_…/conflicts` — find the `UNPUBLISHABLE` entries;
   `detail.blocking_tasks_outstanding` says how many tasks stand in the way.
2. `podium list /v1/tasks event_id=evt_… --fields id,title,status,is_blocking,assignee_name`,
   filter to `is_blocking: true` and an unfinished status.
3. Remind, approve or waive as appropriate.
4. Confirm the session's `content_status` is `approved`.
5. Re-publish (`podium-schedule`) and check `skipped` is empty.
