# 15 — Conformance map

**Non-normative.** The model in `00`–`14` is the specification. This file is a traceability
aid: it maps an external functional rubric onto the model, so that a gap in coverage is
visible as a missing row rather than discovered during implementation.

## What is being traced

The [SessionBoard Eval Kit](https://forge.smol.ai/swyx/killmysaas-evals) grades a
speaker-and-content-management platform against 96 functional criteria in seven areas, from
the browser, implementation-agnostically. It is a useful external check for one reason: it
was written from the outside, by someone describing what the software has to *do*, with no
knowledge of how this model is shaped. Anywhere the model has no answer for one of its rows,
that is a capability a conference organizer needs and the model was missing.

The rubric drove a round of additions in this model — the reviewer pool, typed rubric
criteria, the event roster, asset versioning and comments, campaigns, imports and exports,
session revisions and content approval, widget typing, and the whole of
[`14`](14-speaker-crm.md). It also settled seven previously open questions
(R9–R15 in [`13`](13-open-questions.md)).

Two disclaimers worth stating plainly:

- **The rubric is not the requirements.** It has nothing to say about sponsorship, which is
  this platform's reason for existing ([`03`](03-sponsorship.md), and the entitlement
  threading through [`04`](04-submissions.md) and [`06`](06-program.md)). Coverage here is
  a floor, not a definition of done.
- **Where the model deliberately differs, it says so** rather than bending. Those rows are
  marked ⚠ and explained.

Legend: ✅ modelled · ⚠ modelled differently, deliberately · ⛔ out of scope by decision.

## 01 — Call for Papers

| Item | Capability | Model home |
|---|---|---|
| CFP-01 | Custom form builder, ≥3 field types, required flags, validation | `FormField.type` / `is_required` / `validation` — [`02`](02-event-configuration.md) ✅ |
| CFP-02 | Conditional fields | `FormField.visible_when`, INV-02-8 ✅ |
| CFP-03 | Public portal, no login, branding + deadline + options | `PublicCfp`, INV-02-12 ✅ |
| CFP-04 | Close date enforced, closed state | `closes_at`, derived `status`, INV-02-13 ✅ |
| CFP-05 | Submitter account, submit, confirm, dashboard with status | `Person` + `AuthIdentity`, `notify_on_submit`, `SubmitterDashboard` — [`04`](04-submissions.md) ✅ |
| CFP-06 | Submitted data round-trips to the organizer intact | `ProposalAnswer` + promoted columns, INV-02-7 ✅ |
| CFP-07 | Save as draft, resume | `DraftProgress` ✅ |
| CFP-08 | Confirmation email on submit | `notify_on_submit` → `NotificationDelivery`, INV-09-12 ✅ |
| CFP-09 | Edit after submit while open | `allow_edit_after_submit`; edits write a `ProposalRevision` ✅ |
| CFP-10 | Provision a reviewer; reviewer role separate from admin | `Invitation(kind=reviewer)`, `RoleGrant`, INV-01-15, auth matrix — [`11`](11-cross-cutting.md) ✅ |
| CFP-11 | Reviewer records rating + comment; organizer sees it | `Review`, `CriterionScore`, `ReviewAssignment.status` — [`05`](05-review-and-selection.md) ✅ |
| CFP-12 | Accept / reject decisions | `Decision.outcome` ✅ |
| CFP-13 | Decision status propagates to the submitter | `Decision.status = published` → `Proposal.status`, INV-05-9 ✅ |
| CFP-14 | Decision notification emails, templated | Publish batch + `NotificationTemplate`, INV-05-10 ✅ |
| CFP-15 | Accepted proposal becomes a session, metadata intact | `CreateSessionFromProposal` — [`06`](06-program.md) ✅ |
| CFP-16 | Editing locks after close | INV-02-13 ✅ |

## 02 — Abstract Management

| Item | Capability | Model home |
|---|---|---|
| ABS-01 | Multiple rounds, own dates, own scorecard | `ReviewRound` + per-round `Rubric` ✅ |
| ABS-02 | Per-round reviewer pool | **`ReviewRoundReviewer`**, INV-05-15 ✅ *(added)* |
| ABS-03 | Numeric, dropdown and free-text scorecard criteria | **`RubricCriterion.type` + `options`**, INV-05-13 ✅ *(added)* |
| ABS-04 | Weighted criteria reflected in the aggregate | `RubricCriterion.weight`, `effective_score`, INV-05-14 ✅ |
| ABS-05 | Assign specific proposals; queue is exactly that set | `ReviewAssignment`, INV-05-18 ✅ |
| ABS-06 | At-scale assignment: caps, filters, auto-distribution | *Assignment at scale*, R12 ✅ *(specified)* |
| ABS-07 | Per-round anonymisation; organizer still sees identity | `ReviewRound.anonymity`, R10 ✅ |
| ABS-08 | Live per-reviewer progress dashboard | **`ReviewerProgress`** ✅ *(added)* |
| ABS-09 | Bulk reminder to lagging reviewers | **`ReviewRoundReminderRule`** + manual nudge ✅ *(added)* |
| ABS-10 | Aggregate score per proposal, sortable results table | `ProposalScore`, *the results table* ✅ |
| ABS-11 | Co-authors persist with role labels | `ProposalSpeaker.speaker_role`, INV-04-5 ✅ |
| ABS-12 | Reviewer conflict-of-interest / recusal | `ConflictOfInterest`, `decline_reason`, INV-05-4 ✅ |
| ABS-13 | Export scores to CSV/XLSX | **`Export(subject = review_results)`**, INV-11-12 ✅ *(added)* |
| ABS-14 | AI first-pass score with rationale and human override | **`Review.author_kind = ai`**, INV-05-16/17, Q17 ✅ *(added)* |

## 03 — Speaker Management

| Item | Capability | Model home |
|---|---|---|
| SPK-01 | Speaker roster with search and filtering | **`EventParticipant`** + `EventRoster` ✅ *(added)* |
| SPK-02 | Organizer adds a speaker; organizer edits persist | `EventParticipant` + organizer profile edit, INV-01-13 ✅ *(added)* |
| SPK-03 | CSV bulk import | **`BulkImport`**, INV-11-13 ✅ *(added)* |
| SPK-04 | Speaker workflow status, persistent and filterable | `EventParticipant.status` ✅ *(added)* |
| SPK-05 | General tasks with due dates, multiple assignees | `assignee_rule = named_people`, INV-07-12 ✅ *(added)* |
| SPK-06 | Portal invitation | `Invitation(kind = speaker_portal)`, INV-01-15 ✅ *(added)* |
| SPK-07 | Personalised portal scoped to own content | `/v1/me/...`, relationship-derived scope, INV-01-11 ✅ |
| SPK-08 | Speaker edits bio, links, headshot; organizer sees it | `SpeakerProfile`, `ProfileLink`, `Asset` ✅ |
| SPK-09 | Portal tasks with due dates, mark complete, persists | `TaskInstance` ✅ |
| SPK-10 | Organizer sees and downloads uploads with metadata | `FilesLibrary`, `Asset` ✅ |
| SPK-11 | Session assignment visible both sides | `SessionSpeaker` ✅ |
| SPK-12 | List-level per-speaker task progress | `OrganizerOnboardingBoard`, `EventParticipant.task_completion` ✅ |
| SPK-13 | Bulk email to a filtered speaker group, logged | **`Campaign`** + `CommunicationsHistory` ✅ *(added)* |
| SPK-14 | Templates with merge fields and resolved preview | `NotificationTemplate`, *variables and preview*, INV-09-13 ✅ |
| SPK-15 | Travel / custom logistics fields | **`CustomFieldDefinition`**, `SessionSpeaker.travel_status` ✅ *(added)* |
| SPK-16 | Automated reminders for incomplete tasks | `TaskReminderRule` ✅ |

## 04 — Content Management

| Item | Capability | Model home |
|---|---|---|
| CNT-01 | File-request task with instructions and due date | `TaskDefinition(requirement_type = file_upload)` ✅ |
| CNT-02 | Portal upload recorded against the task | `TaskSubmission` + `Asset` ✅ |
| CNT-03 | Speaker scoping; admin routes blocked | Auth matrix, INV-07-10, INV-01-11 ✅ |
| CNT-04 | Re-upload creates a version; latest marked; prior accessible | **`Asset.slot_key` / `version` / `is_latest`**, INV-11-9 ✅ *(added)* |
| CNT-05 | Comments on a file, attributed, cross-role | **`AssetComment`**, INV-11-10 ✅ *(added)* |
| CNT-06 | Upload constraints communicated | `config.{accept, max_file_mb, …}` — [`07`](07-onboarding.md) ✅ |
| CNT-07 | Deliverables dashboard, filterable, reflects uploads | `OrganizerOnboardingBoard` ✅ |
| CNT-08 | Bulk reminder to speakers with outstanding tasks | Manual nudge, INV-07-13 ✅ *(added)* |
| CNT-09 | Central editing of session title and abstract | `Session` content fields, INV-06-9 ✅ |
| CNT-10 | Organizer edits speaker bio and photo | INV-01-13 ✅ *(added)* |
| CNT-11 | Change history with attribution, and restore | **`SessionRevision`**, INV-06-13 ✅ *(added)* |
| CNT-12 | Content approval gates public output | **`Session.content_status`**, INV-06-11/12 ✅ *(added)* |
| CNT-13 | Central files library with metadata | **`FilesLibrary`** ✅ *(added)* |
| CNT-14 | Bulk ZIP export of latest versions, with grouping | **`Export(format = zip)`** ✅ *(added)* |

## 05 — Agenda Builder

| Item | Capability | Model home |
|---|---|---|
| AIA-01 | Multi-day builder with time and rooms/tracks | `EventDay`, `TimeSlot`, `Room`, `Placement` — [`08`](08-scheduling-and-publication.md) ✅ |
| AIA-02 | Rooms and tracks configurable, immediately usable | `Room`, `Track` — [`02`](02-event-configuration.md) ✅ |
| AIA-03 | Place a session into day/time/room; persists | `Placement`, INV-08-3 ✅ |
| AIA-04 | Speaker double-booking warning | `SPEAKER_DOUBLE_BOOKED`, INV-08-14 ✅ |
| AIA-05 | Room double-booking blocked or flagged | `ROOM_DOUBLE_BOOKED` ✅ |
| AIA-06 | Move a session; conflicts clear | `placement.moved` + recompute ✅ |
| AIA-07 | Publish the agenda; data reaches the public surface | `SchedulePublication` ✅ |
| AIA-08 | One-action assisted placement | **`AutoPlaceRun`**, INV-08-15, Q19 ✅ *(added)* |

## 06 — Public Widgets

| Item | Capability | Model home |
|---|---|---|
| EMB-01 | Sessions list cards with full field set | `PublishedSession`, `widget_type = sessions_list` ✅ |
| EMB-02 | Search across titles *and* speaker names | *Search and filter are client-side over the snapshot* ✅ |
| EMB-03 | Faceted filters, at minimum by track | same ✅ |
| EMB-04 | Speakers directory, alphabetical, with headshots | `PublishedSpeaker`, `widget_type = speakers_list`, R15 ✅ |
| EMB-05 | Speaker detail with bio and their sessions | `PublishedSpeaker.session_refs` ✅ |
| EMB-06 | Agenda grid by day, time and room | `widget_type = agenda_grid` ✅ |
| EMB-07 | Day navigation re-renders the day | `EventDay` ✅ |
| EMB-08 | Session detail with full time range and metadata | `widget_type = session_detail` ✅ |
| EMB-09 | Chronological itinerary with day tabs | `widget_type = schedule_itinerary` ✅ *(added)* |
| EMB-10 | Personal schedule: star sessions, view the selection | *Personal schedules, without attendee accounts*, R11 ✅ *(added)* |
| EMB-11 | Selection persists; calendar export | `localStorage` + `format = ics` ✅ |
| EMB-12 | Speaker gallery photo grid with name search | `widget_type = speaker_gallery` ✅ *(added)* |
| EMB-13 | Gallery card detail with sessions | same ✅ |
| EMB-14 | All surfaces public with no login | INV-08-13 ✅ |
| EMB-15 | Embed generation per widget type, with formats and options | `EmbedConfig.widget_type` / `format` / `fields`, INV-08-12 ✅ *(added)* |
| EMB-16 | Consistency across surfaces and with the source | ⚠ **Deliberately different.** The public surface is an immutable snapshot (R6), so an organizer's edit reaches it on publish, not instantly. `PendingPublicationChanges` makes the gap visible and publishing is one click; `auto_publish` is available for organizations that prefer immediacy. Point-in-time consistency across widgets is guaranteed by all of them reading one snapshot with one `content_etag`. |

## 07 — Speaker CRM

| Item | Capability | Model home |
|---|---|---|
| CRM-01 | Org-level directory outside any event, searchable | *The directory* — [`14`](14-speaker-crm.md) ✅ *(added)* |
| CRM-02 | Multi-criteria attribute filters, clearable | same ✅ *(added)* |
| CRM-03 | Profiles with internal notes and cross-event history | `PersonNote` + `EventParticipant` history ✅ *(added)* |
| CRM-04 | Custom fields or tags on contacts | `Person.tags`, `CustomFieldDefinition` ✅ *(added)* |
| CRM-05 | CSV import of contacts | `BulkImport` ✅ *(added)* |
| CRM-06 | Duplicate detection and merge | `PersonMergeCandidate` + person merge, INV-01-9 ✅ |
| CRM-07 | Kanban sourcing pipeline with staged columns | `SourcingPipeline`, `PipelineStage`, `ProspectCard` ✅ *(added, see Q21)* |
| CRM-08 | Card notes and timestamped stage history | `ProspectStageTransition`, INV-14-4 ✅ *(added)* |
| CRM-09 | Saved segments | `ContactSegment`, INV-14-1 ✅ *(added)* |
| CRM-10 | Push a contact into an event without re-entry | *Conversion*, INV-14-5 ✅ *(added)* |
| CRM-11 | Bulk outreach from the directory, logged | `Campaign` with a segment audience ✅ *(added)* |
| CRM-12 | CRM dashboard with org-wide metrics | *CRM dashboard* ✅ *(added)* |

## Cross-cutting: harness access

The rubric is executed by a browser agent with no inbox. That is not a quirk of one grader —
it is the same constraint faced by an integration test, a self-hosted deployment with no
mail provider, and a support engineer reproducing a problem. It produced two model changes
that stand on their own merits:

- `AuthIdentity.provider = password` with `credential_hash` (INV-01-12), so a role can be
  signed into without mail delivery. See Q16.
- `Invitation.accept_url` returned once on creation (INV-01-15), and the outbox
  (INV-09-12), so provisioning never dead-ends at "check your email".

## Keeping this file honest

This map is a snapshot of an external rubric at the time of writing and will drift. It is
not a substitute for the model and nothing should cite it as a requirement. When the model
changes, this file may need a row; when it disagrees with `00`–`14`, `00`–`14` win.
