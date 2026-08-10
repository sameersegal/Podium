# 08 — Scheduling & Publication

**Aggregate roots:** `Placement` (scoped by event), `SchedulePublication`.

Covers J9 (place sessions without clashes) and J10 (publish something the marketing site can
embed, and change it safely afterwards).

The central idea: **the working schedule and the published schedule are different objects.**
Organizers move things around for weeks; the public sees an immutable, versioned snapshot
that only changes when someone deliberately publishes. That separation is what makes the
embed cacheable, the ICS feed stable, and "what changed since yesterday" answerable.

```mermaid
erDiagram
  EVENT ||--o{ EVENT_DAY : spans
  EVENT_DAY ||--o{ TIME_SLOT : "gridded into"
  VENUE ||--o{ ROOM : contains
  SESSION ||--o| PLACEMENT : "placed at"
  PLACEMENT }o--|| ROOM : in
  PLACEMENT }o--o| TIME_SLOT : "aligned to"
  EVENT ||--o{ SCHEDULE_PUBLICATION : publishes
  SCHEDULE_PUBLICATION ||--o{ PUBLISHED_SESSION : contains
  SCHEDULE_PUBLICATION ||--o{ PUBLISHED_SPEAKER : contains
  SCHEDULE_PUBLICATION ||--o{ SCHEDULE_DIFF_ENTRY : "changed from previous"
  EVENT ||--o{ EMBED_CONFIG : exposes
```

## TimeSlot

An optional grid. Some conferences run a strict grid (every talk 20 minutes, on the
half-hour, all rooms aligned); others place sessions freely. Both must work, so the grid is
a convenience for placement and validation, not a requirement.

<!-- entity: TimeSlot -->
| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `slt_` |
| `event_day_id` | `ref(EventDay)` | Y | |
| `starts_at` / `ends_at` | `timestamptz` | Y | stored UTC, authored in event timezone |
| `label` | `string` | N | "Morning block 2" |
| `kind` | `enum(session, keynote, break, lunch, social, registration)` | Y | |
| `room_ids` | `ref(Room)[]` | N | empty = applies to all rooms (a venue-wide lunch) |
| `is_public` | `bool` | Y | |
| `sort_order` | `int` | Y | |

## Placement

<!-- entity: Placement -->
| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `plc_` |
| `event_id` | `ref(Event)` | Y | |
| `session_id` | `ref(Session)` | Y | unique among non-cancelled (INV-08-1) |
| `room_id` | `ref(Room)` | Y | |
| `event_day_id` | `ref(EventDay)` | Y | |
| `time_slot_id` | `ref(TimeSlot)` | N | when the event uses a grid |
| `starts_at` / `ends_at` | `timestamptz` | Y | authoritative; `ends_at > starts_at` (INV-08-2) |
| `setup_minutes` / `teardown_minutes` | `int` | Y | default 0; workshops need room turnaround |
| `status` | `enum(tentative, locked)` | Y | `locked` warns loudly before it can be moved |
| `is_public` | `bool` | Y | |
| `placed_by_person_id` | `ref(Person)` | Y | |
| `notes` | `text` | N | organizer-only run-sheet notes |
| `created_at` / `updated_at` | `timestamptz` | Y | |

Times live on the placement, not the session. A session has a *duration*; a placement gives
it a *when* and a *where*. That is why moving a talk does not touch the session record and
does not invalidate its onboarding, and why a cancelled placement leaves the session
`confirmed` rather than deleting program content.

## Conflict detection

Conflicts are **computed, surfaced, and (mostly) not enforced.** The scheduler's job is to
tell the truth loudly; organizers knowingly break these rules under deadline, and a system
that refuses gets worked around in a spreadsheet — which is worse, because then it stops
knowing anything.

| Code | Severity | Condition |
|---|---|---|
| `ROOM_DOUBLE_BOOKED` | error | Two placements overlap in one room, counting setup/teardown |
| `SPEAKER_DOUBLE_BOOKED` | error | A person is a public speaker on two overlapping placements |
| `SPEAKER_NO_TRANSIT` | warning | Same speaker, back-to-back in different rooms, gap below the event's `min_transit_minutes` |
| `DURATION_MISMATCH` | error | `ends_at - starts_at != Session.duration_minutes` |
| `AV_UNSUPPORTED` | warning | `Session.av_requirements` not covered by `Room.av_capabilities` |
| `OVER_CAPACITY` | warning | Registrations or expected demand exceed `Room.capacity` |
| `TRACK_COLLISION` | warning | Two same-track sessions run concurrently |
| `SPONSOR_COLLISION` | warning | Two sessions from the same sponsor overlap |
| `SERIES_OUT_OF_ORDER` | error | A `continues_in` relation is placed before its predecessor, or in a different room |
| `OUTSIDE_EVENT_HOURS` | warning | Placement falls outside its event day's slots |
| `UNPUBLISHABLE` | error | Session has outstanding blocking onboarding tasks (INV-06-5) |

`error`-severity conflicts block **publication**, not placement. You may build a broken
draft schedule; you may not publish one without an explicit, recorded override.

<!-- entity: ScheduleConflict -->
| ScheduleConflict field | Type | Notes |
|---|---|---|
| `id` | `ulid` | derived read model, recomputed on placement change |
| `event_id` | `ref(Event)` | |
| `code` | `enum(...)` | |
| `severity` | `enum(error, warning)` | |
| `placement_ids` | `ref(Placement)[]` | the parties |
| `detail` | `json` | human-readable specifics |
| `acknowledged_by_person_id` / `acknowledged_reason` | | an accepted, deliberate conflict |

Conflicts are recomputed **on every placement write and surfaced without a page reload**
(INV-08-14). A clash that only appears after a refresh is a clash the organizer created,
navigated away from, and will now discover the week of the event. The whole value of
computing them is the immediacy; a nightly conflict report is a list of things it is too
late to fix cheaply.

## Assisted placement

Placing 120 sessions into four rooms across three days by hand is an afternoon, and the
last third of it is done badly because the constraints stop fitting in one head.

`AutoPlaceRun` proposes placements for unplaced sessions in one action. It is deliberately
a **proposal**, not an edit: it computes a candidate set, scores it, and presents it for the
organizer to accept wholesale, accept partially, or discard.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `apr_` |
| `event_id` | `ref(Event)` | Y | |
| `scope` | `json` | N | `{session_ids, track_ids, event_day_ids, room_ids}` — empty = every unplaced confirmed session |
| `strategy` | `enum(greedy_fill, balance_tracks, respect_preferences)` | Y | |
| `proposed` | `json` | Y | `[{session_id, room_id, event_day_id, starts_at, ends_at, rationale}]` |
| `conflicts_introduced` | `json` | D | conflicts the proposal would create, by code and severity |
| `unplaceable` | `json` | D | `[{session_id, reason}]` — said out loud, never silently dropped |
| `status` | `enum(proposed, applied, partially_applied, discarded)` | Y | |
| `requested_by_person_id` | `ref(Person)` | Y | |
| `applied_session_ids` | `ref(Session)[]` | N | |
| `created_at` / `applied_at` | `timestamptz` | Y/N | |

What it must honour: room capacity and AV against `Session.av_requirements`, speaker
availability across overlapping slots, `SessionRelation.continues_in` ordering and room
stickiness, track spread, and every existing `locked` placement. What it must not do is
move anything a human already placed unless explicitly asked — the fastest way to lose
trust in an assistant is to have it undo deliberate work.

Whether the proposal comes from a solver or a language model is an implementation choice
behind one interface; `rationale` per placement is required either way, because an
organizer accepting 120 moves needs to be able to spot the four that are wrong.

**A constraint solver produces the schedule; a language model refines one** (R26 in
[`13-open-questions.md`](13-open-questions.md)). Room, time, speaker availability and
series ordering are hard constraints with a well-understood shape, and a solver's output is
explainable and reproducible — which is exactly what an organizer needs when deciding
whether to accept 120 moves at once. The soft, unstated preferences ("keep the beginner
talks out of the 9am slot") are the language model's job, as a second pass over an already
feasible schedule rather than the thing that produces one.

## Publication

A publication is an **immutable snapshot**. Publishing copies everything the public sees
into the snapshot — session content, speaker public profile fields, sponsor branding, room
and time — so that later edits to live records cannot silently rewrite what is on the
website, and so the embed can be served from cache with a version stamp.

<!-- entity: SchedulePublication -->
| SchedulePublication field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `pub_` |
| `event_id` | `ref(Event)` | Y | |
| `version` | `int` | Y | monotonic per event |
| `status` | `enum(building, live, superseded, rolled_back)` | Y | |
| `scope` | `json` | N | `{event_day_ids, track_ids}` — partial publication, e.g. day 1 only |
| `published_by_person_id` | `ref(Person)` | Y | |
| `published_at` | `timestamptz` | Y | |
| `note` | `text` | N | "Added two lightning talks, moved the keynote" |
| `override_reasons` | `json` | N | error-severity conflicts knowingly published |
| `content_etag` | `string` | D | hash of the snapshot; the embed and API cache key |
| `session_count` | `int` | D | |

<!-- entity: PublishedSession -->
| PublishedSession field | Type | Notes |
|---|---|---|
| `publication_id` / `session_id` | `ref(...)` | |
| `reference` / `title` / `subtitle` / `abstract` / `description` | copies | |
| `track` / `format` | `{id, name, slug, color}` | denormalised so the embed needs no joins |
| `room` | `{id, name, slug, floor}` | null for online sessions |
| `starts_at` / `ends_at` | `timestamptz` | |
| `duration_minutes` | `int` | |
| `audience_level` / `keywords` / `language` | copies | |
| `speaker_refs` | `ulid[]` | into `PublishedSpeaker` |
| `sponsor` | `{id, name, slug, logo_url, tier_name}` | null when not sponsored |
| `is_sponsored_content` | `bool` | **always rendered as a disclosure label** (INV-08-7) |
| `assets` | `json` | public slides/recording links, respecting `public_from` |
| `registration_url` / `capacity` | | |

<!-- entity: PublishedSpeaker -->
| PublishedSpeaker field | Notes |
|---|---|
| `publication_id` / `person_id` | |
| `display_name` / `pronouns` / `headline` / `job_title` / `company` | public fields only |
| `short_bio` / `bio` | per `SpeakerProfile.visibility` |
| `headshot_url` | resolved public asset URL |
| `links` | `is_public` profile links only |
| `session_refs` | `ulid[]` |

### Staleness must be visible, and publishing must be one click

The snapshot model has one failure mode, and it is worth naming because it looks exactly
like a bug: an organizer edits a title, looks at the public page, and sees the old one. The
model is behaving correctly and the organizer is right to be alarmed — from where they are
standing, the product lost their edit.

Two obligations follow, and they are part of the model rather than the UI's problem:

- **`PendingPublicationChanges`** (derived, per event) diffs the live working state against
  the `live` publication and reports what is unpublished: added, removed, retitled,
  re-timed, re-roomed and re-approved sessions, with a count. Every admin surface that
  shows publishable content shows this count, and every edit to a published session says,
  at the point of editing, that the change is not live yet.
- **Publishing is a single, always-available action** with a preview of exactly that diff.
  If publishing is buried, ceremonial, or feels risky, organizers stop doing it and the
  public schedule drifts a week behind reality — which costs far more than the stale-cache
  problem the snapshot was protecting against.

Auto-publish (`Event.settings.publication.auto_publish`, default off) republishes on every
qualifying change for events that would rather trade the audit trail for immediacy. It is a
setting rather than the default because the failure it enables — a half-finished
rearrangement going live at 2am — is worse and less reversible than a stale page. Rollback
(below) is what makes either choice survivable.

The default is off and the staleness indicator has to be loud enough that it does not
matter (R25 in [`13-open-questions.md`](13-open-questions.md)) — which is the real weight
on `PendingPublicationChanges` above. Revisit after one real event: if the published
schedule routinely drifts by days, the default was wrong and the data will say so.

### Diffs

<!-- entity: ScheduleDiffEntry -->
| ScheduleDiffEntry field | Type | Notes |
|---|---|---|
| `publication_id` | `ref(SchedulePublication)` | the newer publication |
| `change_type` | `enum(session_added, session_removed, session_cancelled, time_changed, room_changed, speaker_changed, content_changed)` | |
| `session_id` | `ref(Session)` | |
| `before` / `after` | `json` | the changed fields only |

Diffs are computed at publish time against the previous `live` publication. They drive
three real things: a public "what changed" list on the schedule page, targeted notifications
to affected speakers ("your talk moved to Room 3"), and `schedule.changed` webhook payloads
that let downstream systems react without polling.

```mermaid
stateDiagram-v2
  [*] --> building: publish requested
  building --> live: snapshot complete, diffs computed
  building --> [*]: aborted (validation failed)
  live --> superseded: a newer publication goes live
  live --> rolled_back: rollback to previous version
  superseded --> live: rollback restores this version
```

**Rollback matters.** Publishing a wrong schedule an hour before doors open is a real
event, and the fix must be one button, not a re-edit under pressure. Because publications
are immutable snapshots, rollback is just pointing `live` at an earlier version.

## The embed (J10)

<!-- entity: EmbedConfig -->
| EmbedConfig field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `emb_` |
| `event_id` | `ref(Event)` | Y | |
| `key` | `string` | Y | public, unguessable; appears in the embed URL |
| `name` | `string` | Y | "Main site — full schedule" |
| `widget_type` | `enum(sessions_list, speakers_list, agenda_grid, schedule_itinerary, speaker_gallery, session_detail)` | Y | *what* is rendered (INV-08-12) |
| `allowed_origins` | `string[]` | Y | CORS + frame-ancestors allowlist (INV-08-6) |
| `filters` | `json` | N | `{event_day_ids, track_ids, format_ids, sponsor_only}` — a track-specific widget |
| `format` | `enum(js_widget, iframe, html, json, xml, ics, rss)` | Y | *how* it is delivered |
| `fields` | `json` | N | per-`widget_type` field allowlist: `{show: [...], hide: [...]}` |
| `theme` | `json` | N | `{mode, accent, font_stack, density, show_speakers, show_rooms, show_sponsor_labels}` |
| `show_unpublished` | `bool` | Y | default false; a preview embed for staging sites |
| `cache_ttl_seconds` | `int` | Y | default 300 |
| `pinned_publication_id` | `ref(SchedulePublication)` | N | freeze the embed to a version |
| `status` | `enum(active, disabled)` | Y | |
| `created_by_person_id` | `ref(Person)` | Y | |

### `widget_type` and `format` are different axes

An embed answers two independent questions: *what content* and *in what wrapper*. A
speakers gallery as a script tag and the same gallery as JSON are one configuration with
two deliveries; a sessions list and an agenda grid over the same data are two different
products. Collapsing them into one enum — the shape this model previously had — makes
"give me the speaker list as JSON" inexpressible.

The six widget types, each a distinct read over the live publication:

| `widget_type` | Renders | Reads |
|---|---|---|
| `sessions_list` | A searchable, filterable card per session — title, snippet, day/time, room, speakers with title and company, track and format tags | `PublishedSession` |
| `speakers_list` | A directory of speakers, ordered by surname, each with headshot, name, job title, company, and their sessions | `PublishedSpeaker` |
| `agenda_grid` | A per-day grid, rooms across, time down, session blocks in position | `PublishedSession` + `Room` |
| `schedule_itinerary` | The same day, as a chronological list under time headings — the mobile-shaped view of `agenda_grid` | `PublishedSession` |
| `speaker_gallery` | A photo grid of speakers, name-searchable, opening to a detail panel | `PublishedSpeaker` |
| `session_detail` | One session in full: abstract, full time range, room, speakers, assets | `PublishedSession` |

Requirements that apply to every type, because they are the ones that are noticed when
missing:

- **Anonymous and complete.** Every type renders fully to a logged-out visitor. No account
  wall, no partial content, no "sign in to see the schedule" (INV-08-13).
- **Search and filter are client-side over the snapshot.** The payload already contains the
  whole filtered set, so keyword search across titles *and speaker names*, and faceting by
  track, format and room, are rendering concerns that need no round trip and no API key.
- **Drill-down is part of the widget.** A speaker card that opens to their sessions and a
  session block that opens to its abstract are the two interactions people actually
  perform; a widget that only lists is a screenshot.
- **Degrade gracefully.** A speaker with no headshot renders a fallback, not a broken grid.

### Personal schedules, without attendee accounts

[R11](13-open-questions.md) rules out attendee accounts, and that stays true — but "star the
talks I want to see" is the single most-used interaction on a conference schedule, and
refusing it is not a modelling position, it is a missing feature.

It needs no server state. `schedule_itinerary` and `sessions_list` offer a select control
per session; the selection lives in the visitor's browser (`localStorage`, keyed by the
event slug), survives reloads, and is rendered as a "my schedule" filter over the same
snapshot the widget already holds. Export is `format = ics` over the selected ids, which
the ICS serialiser supports per-session already.

No `Attendee` entity, no personal data reaching the platform, nothing to authenticate,
nothing to erase under a GDPR request — and the feature works on a static marketing page.
That is the version worth building; a server-side favourites list is a login screen, an
accounts table and a privacy obligation in exchange for the same behaviour.

Delivery requirements the model has to support:

- **Serve from the snapshot, never from live tables.** The embed is public and will get
  hammered on day one; it must be a cache read keyed on `content_etag`.
- **One `js_widget` asset mounts every `widget_type`**, exposing one global — named for the
  product, not for a widget. A marketing team that has pasted a script tag into a CMS will
  not repaste it when a second widget ships.
- **Degrade gracefully.** `iframe` and `js_widget` both fall back to server-rendered HTML
  so the schedule survives a blocked script.
- **ICS is a first-class output**, per event, per track, and per attendee-selected sessions.
  "Add to calendar" is the most-used feature of any conference schedule and it is one
  serialiser away.
- **Timezone.** The published payload carries UTC instants plus `Event.timezone`; the widget
  renders in event time by default with a viewer-local toggle. Never publish local times
  without the zone.

## Invariants

- **INV-08-1** A non-cancelled session has at most one placement.
- **INV-08-2** `ends_at > starts_at`, and a placement lies within its `event_day`'s date in
  the event timezone.
- **INV-08-3** Only sessions with `status in (confirmed, scheduled, published)` may be
  placed. Placing sets `scheduled`; removing the placement returns it to `confirmed`.
- **INV-08-4** A publication may only include sessions that are placed, public, and free of
  `error`-severity conflicts — unless an override with a reason is recorded in
  `override_reasons`.
- **INV-08-5** Publications are immutable once `live`. Corrections create a new version.
- **INV-08-6** Public embed and API responses honour `allowed_origins`; an unlisted origin
  gets no CORS headers and no frame permission.
- **INV-08-7** A published session with `is_sponsored_content = true` must expose that flag
  in every output format. Sponsored content is disclosed, always — this is not a themeable
  option.
- **INV-08-8** No publication payload may contain a field whose `audience != public`, a
  private profile field, an unlisted speaker, an internal session, a private room, or any
  field named in [INV-01-4](01-identity-and-access.md).
- **INV-08-9** Exactly one `live` publication per event at a time.
- **INV-08-10** Cancelling a published session does not remove it from an existing snapshot;
  it appears as `session_cancelled` in the next publication's diff, so links do not 404.
- **INV-08-11** `content_etag` changes if and only if the snapshot content changes, so
  caches never serve stale content and never miss unnecessarily.
- **INV-08-12** An `EmbedConfig` renders exactly one `widget_type` in exactly one `format`.
  A `format` a type cannot express (`ics` for `speaker_gallery`) is rejected at
  configuration time, not at request time.
- **INV-08-13** Every embed surface of a `public` event with a `live` publication is
  readable by an unauthenticated request from an allowed origin, with no login prompt,
  redirect or content gate. Personal-schedule state is client-side and never a
  precondition for reading.
- **INV-08-14** Placement writes recompute `ScheduleConflict` for the affected event
  synchronously and return the resulting conflicts in the write's response, so the editing
  surface reflects them without a reload.
- **INV-08-15** `AutoPlaceRun` never mutates an existing placement. Applying a run creates
  placements only for sessions that were unplaced when it was applied; anything placed in
  the interim is reported as skipped.

## Emitted events

`placement.created`, `placement.moved`, `placement.removed`, `schedule.conflict_detected`,
`schedule.auto_place_proposed`, `schedule.auto_place_applied`,
`schedule.published`, `schedule.rolled_back`, `schedule.changed` (carries the diff),
`session.time_changed`, `session.room_changed`, `embed_config.created`.
