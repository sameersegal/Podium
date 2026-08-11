# 11 — Cross-Cutting Concerns

Rules that apply to every entity in the model. Stated once here rather than repeated in
each file.

## Identifiers

- **ULIDs**, string-encoded, with a typed prefix: `org_`, `evt_`, `per_`, `prp_`, `ses_`,
  `tsk_`, `plc_`, `pub_`. Prefixes make logs and support conversations legible, and make
  "you passed a session id where a proposal id was expected" a validation error rather than
  a mystery.
- ULIDs sort by creation time, which gives natural pagination ordering without a secondary
  index.
- Sequential integers are never exposed. Guessable ids on a public schedule endpoint leak
  the size of the program and the order of submissions.
- **Human-facing references** (`Proposal.reference`, `Session.reference`) are separate:
  short, per-event, and safe to say out loud (`WF26-0142`). They are unique per event and
  never reused.
- `slug` fields are `[a-z0-9-]+`, unique within their stated scope, and immutable once
  public. Changing a public slug breaks links; renaming issues a redirect record instead.

## Time

- All instants are stored as UTC (`timestamptz`).
- **`Event.timezone` is the display authority** for anything about that event. A schedule
  shown in the viewer's local time by default is a support ticket generator; event time is
  the default, viewer-local is an explicit toggle.
- Deadlines (`closes_at`, `due_at`, `confirmation_deadline`) are instants, not dates. "The
  CFP closes on 3 April" means an instant in the event's timezone, and the UI must show
  which one.
- Dates without times (`Event.starts_on`, `EventDay.date`) are calendar dates in the event
  timezone and are never converted.
- Durations are always integer **minutes**.
- Recurring rules (reminder offsets) are computed in the recipient's timezone where known,
  falling back to the event's.

## Language

Multi-language is **deferred, with the seams left in place** (R20 in
[`13-open-questions.md`](13-open-questions.md)). `Person.locale`
([`01`](01-identity-and-access.md)), `Session.language` ([`06`](06-program.md)) and
`NotificationTemplate.locale` ([`09`](09-api-and-integrations.md)) all exist and are
honoured where they already are: a session's language is displayed, and a template is
selected by locale.

What is *not* modelled is translated session content, localised form fields, and RTL in the
embed. Those are a real project rather than a field, and the reason the `locale` columns
stay is that they cost nothing now and are expensive to retrofit — a template table without
a locale key is a table every row of which has to be rewritten later.

## Lifecycle fields

Every persisted entity carries `created_at` and `updated_at`. Entities that can be removed
carry `deleted_at` (soft delete).

**Soft delete rules:**

- Soft-deleted rows are excluded from every read by default, including aggregates and
  counts.
- References to a soft-deleted entity remain valid; the reference resolves and renders as
  "(deleted)". Cascading hard deletes through a program model destroys history that someone
  will need.
- Configuration entities referenced by content (`Track`, `SessionFormat`, `Room`) are
  archived rather than deleted (INV-02-10).
- Hard delete exists only for GDPR erasure and is a distinct, audited operation.

## PII

Fields treated as personal data, redacted from any response lacking `pii:read` /
`include_pii`, and never present in publication snapshots:

| Category | Fields |
|---|---|
| Contact | `Person.email`, `AuthIdentity.email_at_provider`, `SpeakerProfile.phone`, `Invitation.email`, `NotificationDelivery.recipient_email` |
| Sensitive personal | `SpeakerProfile.dietary_notes`, `SpeakerProfile.accessibility_notes`, `SessionSpeaker.travel_status` and any travel/visa task payload |
| Free-text answers | any `ProposalAnswer` whose `FormField.pii` is true |
| Custom fields | any `custom_field_values` entry whose `CustomFieldDefinition.pii` is true |
| Task payloads | any `TaskSubmission.payload` for a definition in category `travel` or `legal` |
| Communications | `CampaignRecipient.resolved_email`, rendered message bodies in the outbox |
| Technical | IP addresses and user agents in `AuditLog` and acknowledgement records |

Separately from PII, two categories are **never visible to their subject** at any permission
level: `PersonNote` bodies (INV-01-14) and review data for a proposal the reader submitted
or is credited on (INV-11-7). These are not redaction rules that a scope can unlock — they
are absent from the surface entirely.

Additional handling:

- **Never logged.** Application logs carry ids, not values.
- **Export** (`GET /v1/me/export`) returns everything held about the requesting person as
  JSON plus their uploaded assets.
- **Erasure** anonymises `Person` (name → "Removed speaker", email → a tombstone hash,
  profile fields cleared, assets deleted), retains proposal and session *content* they
  authored where the org has a legitimate record-keeping interest, and preserves audit rows
  with the id only. What cannot be honoured is stated to the requester rather than silently
  skipped.
- **Retention**: draft proposals abandoned for `privacy.retention_days` (default 730) after
  an event closes are purged; audit and domain event logs are retained for 7 years, PII
  redacted after 2.

## Assets

One entity for every uploaded file — headshots, slides, logos, signed documents, task
attachments.

<!-- entity: Asset -->
| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `ast_` |
| `org_id` | `ref(Organization)` | Y | |
| `storage_key` | `string` | Y | opaque key in the storage backend |
| `filename` | `string` | Y | as uploaded, sanitised |
| `content_type` / `size_bytes` | | Y | validated server-side, never trusted from the client |
| `checksum` | `string` | Y | SHA-256, for dedupe and integrity |
| `width` / `height` | `int` | N | for images; drives headshot minimum-size validation |
| `scan_status` | `enum(pending, clean, infected, failed)` | Y | (INV-11-3) |
| `visibility` | `enum(private, public)` | Y | |
| `uploaded_by_person_id` | `ref(Person)` | Y | |
| `purpose` | `enum(headshot, slides, logo, document, task_attachment, cover_image, other)` | Y | |
| `expires_at` | `timestamptz` | N | for time-limited documents |
| **Versioning** | | | |
| `slot_key` | `string` | Y | what this file *is* an instance of: `task:tsk_01H…`, `session:ses_01H…:slides`, `person:per_01H…:headshot` |
| `version` | `int` | Y | monotonic within `slot_key`, starting at 1 |
| `supersedes_asset_id` | `ref(Asset)` | N | the previous version in the same slot |
| `is_latest` | `bool` | D | no other non-deleted asset in this `slot_key` has a higher `version` (INV-11-9) |
| `created_at` | `timestamptz` | Y | the version's timestamp, shown in the version list |

Uploads are direct-to-storage via presigned URLs; the API never proxies file bytes. Public
assets are served from a CDN path derived from `storage_key`; private assets only via
short-lived signed URLs.

**Re-uploading never overwrites.** A speaker uploading their deck a second time creates
version 2 in the same `slot_key`; version 1 remains stored, listed and individually
downloadable. Three reasons, all of which are somebody's bad afternoon: the new file is
corrupt and the old one is the only copy; the AV team already built the running order
against v1 and needs to see what changed; and "final_v3_ACTUAL.pdf" is what happens when a
tool forces version control into the filename.

Consumers read `is_latest` unless they ask otherwise — the published schedule, the bulk
export and the session page all mean "the current one". The version list is a first-class
surface wherever a file appears: every version with its number, uploader, timestamp and
size, the current one marked, each individually retrievable.

### AssetComment

Deliverables are a conversation, not a drop box. "This is the draft, final on Friday" and
"can you re-export at 16:9" are the two most common things anyone says about an uploaded
file, and without somewhere to say them they are said in email, where the organizer
collecting eighty decks cannot see them next to the file.

<!-- entity: AssetComment -->
| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `acm_` |
| `asset_id` | `ref(Asset)` | Y | the specific version commented on |
| `slot_key` | `string` | Y | denormalised, so the thread survives new versions (INV-11-10) |
| `author_person_id` | `ref(Person)` | Y | |
| `body` | `text` | Y | markdown |
| `parent_id` | `ref(AssetComment)` | N | one level of threading |
| `created_at` / `edited_at` / `deleted_at` | `timestamptz` | Y/N/N | |

The thread belongs to the **slot**, not the version: uploading v2 does not orphan the
comments on v1, and the conversation reads in order with the version changes interleaved.
Comments are visible to everyone who can see the file — the uploading speaker and event
staff — and to nobody else. There is no notification on a comment; the file's own reminder
cadence is the chase mechanism, and a second one competing with it just trains people to
mute both.

### The files library

`FilesLibrary` is the derived aggregate view over assets for an event: one row per
`slot_key` with its latest version, filename, size, type, version count, uploader, upload
date, comment count, and what it belongs to (session, speaker, sponsor, task). Filterable
by kind, by session, by speaker and by missing-ness, because the question is almost always
"whose slides are still not here".

It is the same data a per-session Files tab shows, at a different altitude. Both exist;
neither is the other's substitute.

## Custom fields

Every organization tracks something this model does not have a column for: shirt size,
which agency represents them, whether they need a visa letter, which conference we met them
at. The alternatives to modelling it are a `notes` field that nothing can filter on, or a
schema change per customer.

<!-- entity: CustomFieldDefinition -->
| CustomFieldDefinition field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `cfd_` |
| `org_id` | `ref(Organization)` | Y | |
| `event_id` | `ref(Event)` | N | null = applies across every event |
| `subject_type` | `enum(person, event_participant, session, sponsor)` | Y | what it hangs off |
| `key` | `slug` | Y | unique per `(org, subject_type)`; immutable once values exist |
| `label` | `string` | Y | |
| `help_text` | `text` | N | |
| `type` | `enum(short_text, long_text, number, date, single_select, multi_select, checkbox, url)` | Y | |
| `options` | `json` | N | `[{value, label}]` for select types |
| `is_required` | `bool` | Y | required at the surface that edits it, never retroactively |
| `pii` | `bool` | Y | classified at creation; drives redaction (INV-11-11) |
| `audience` | `enum(public, committee_only, organizer_only)` | Y | `public` may reach a publication snapshot |
| `show_in_list` | `bool` | Y | whether it earns a column in the directory |
| `is_filterable` | `bool` | Y | |
| `sort_order` | `int` | Y | |
| `status` | `enum(active, archived)` | Y | archived fields keep their values and stop being offered |

Values live in `custom_field_values` on the subject, keyed by `key`. The definition owns the
type, the validation, the PII classification and the visibility — which is the whole point:
a free-text blob has none of those, so it can be neither filtered nor safely exported, and
someone eventually puts a passport number in it.

**Adding a field is deciding its PII class.** `pii` and `audience` are required at creation,
not defaulted, in keeping with the project's rule that redaction is default-on. A custom
field with `pii = true` is redacted everywhere the built-in PII fields are.

**Proliferation is surfaced, not capped** (R27 in
[`13-open-questions.md`](13-open-questions.md)). Every product that ships custom fields
eventually has a customer with two hundred of them, half unused. There is no hard limit;
instead a field-management screen shows **fill rate and last-used date per definition**,
`status = archived` retires a field while keeping its values, and passing roughly 25
definitions per `subject_type` earns a soft warning. Creation is already restricted to
chairs and admins. The guardrail that actually matters is INV-11-11 — the damage is not two
hundred fields, it is one free-text box with a passport number in it.

## Bulk import and export

Two operations the model previously left implicit, and both are load-bearing: a programme
team arrives with last year's speakers in a spreadsheet, and leaves with this year's scores
in one. Neither is a nice-to-have — the first is how the roster gets populated at all, and
the second is how a committee meeting actually runs.

Both are **jobs**, not request/response: a CSV of nine hundred contacts and a ZIP of two
hundred slide decks each take longer than a request should live.

| BulkImport field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `imp_` |
| `org_id` / `event_id` | `ref(...)` | Y/N | |
| `subject` | `enum(person, event_participant, session, sponsor)` | Y | what is being imported |
| `source_asset_id` | `ref(Asset)` | Y | the uploaded file, retained for dispute |
| `column_mapping` | `json` | Y | `{csv_header: field_key}`, confirmed by the operator before the run |
| `dedupe_key` | `enum(email, reference, none)` | Y | default `email` for people |
| `on_duplicate` | `enum(skip, update, create_anyway)` | Y | default `update` |
| `status` | `enum(uploaded, mapping, validating, previewing, running, completed, completed_with_errors, failed, cancelled)` | Y | |
| `row_count` / `created_count` / `updated_count` / `skipped_count` / `error_count` | `int` | D | |
| `errors` | `json` | D | `[{row_number, column, message}]` — per row, never one summary failure |
| `requested_by_person_id` | `ref(Person)` | Y | |
| `created_at` / `completed_at` | `timestamptz` | Y/N | |

The rules that make an import trustworthy rather than terrifying:

- **Map, validate, preview, then run.** The operator sees what will be created, what will be
  updated and what will be rejected, *before* anything is written. An import that begins on
  upload is an import nobody dares run against real data.
- **Errors are per row.** Row 412 has a malformed email; rows 1–411 and 413–900 still
  import. A whole-file rejection over one bad cell means the operator edits the CSV and
  re-uploads nine times.
- **Deduplication is the default, not a checkbox.** People re-import the same file. Matching
  on email and updating is right almost always, and the two exceptions are explicit.
- **The source file is kept**, so "where did this record come from" is answerable a year
  later.

| Export field | Type | Req | Notes |
|---|---|---|---|
| `id` | `ulid` | Y | prefix `exp_` |
| `org_id` / `event_id` | `ref(...)` | Y/N | |
| `subject` | `enum(review_results, proposals, sessions, speakers, participants, tasks, files, contacts, communications)` | Y | |
| `format` | `enum(csv, xlsx, json, zip, ics)` | Y | `zip` for file bundles |
| `filters` | `json` | N | the same criteria as the screen it was launched from |
| `options` | `json` | N | e.g. `{grouping: session\|speaker, latest_versions_only: true}` for `zip` |
| `include_pii` | `bool` | Y | requires the requester to hold `pii:read` (INV-11-12) |
| `status` | `enum(queued, running, ready, failed, expired)` | Y | |
| `result_asset_id` | `ref(Asset)` | N | the generated file |
| `row_count` / `byte_size` | `int` | D | |
| `expires_at` | `timestamptz` | Y | default 7 days; generated exports are not kept forever |
| `requested_by_person_id` | `ref(Person)` | Y | |

**An export is a read.** It carries exactly the permissions of the person who asked for it,
evaluated at generation time: a reviewer exporting results gets their assigned proposals, a
chair gets the round, and neither gets a column they could not see on screen. Round
`anonymity` and PII redaction apply identically. The one thing an export must never be is a
side door around the authorization matrix, which is precisely what it becomes when it is
bolted on afterwards as "just a CSV endpoint".

`zip` exports of `files` default to latest versions only, grouped one folder per session,
which is what an AV team asks for.

## Audit log

<!-- entity: AuditLog -->
| Field | Type | Notes |
|---|---|---|
| `id` | `ulid` | prefix `aud_` |
| `org_id` / `event_id` | `ref(...)` | |
| `actor_type` | `enum(person, api_key, system, integration)` | |
| `actor_id` / `actor_display` | | display captured at the time |
| `action` | `string` | `proposal.update`, `decision.publish`, `person.merge` |
| `entity_type` / `entity_id` | | |
| `before` / `after` | `json` | changed fields only, PII redacted |
| `reason` | `text` | required for overrides, waivers, merges, force-publishes |
| `ip` / `user_agent` | | |
| `correlation_id` | | ties to the domain events from the same request |
| `created_at` | `timestamptz` | |

Audit rows are append-only and never deleted, even by erasure (the actor id is retained,
the payload is redacted).

Actions that **must** be audited: any decision change, decision publish, review edit after
submit, COI override, entitlement quantity change, task waiver, publication with overrides,
schedule rollback, person merge, role grant and revoke, API key creation and revocation,
PII export and erasure, and any organizer edit of submitter-owned content.

## Authorization matrix

`O` = own / related records only. `—` = no access. Read implies list where sensible.

| Capability | owner | admin | program_chair | track_lead | reviewer | organizer | sponsor_manager | sponsor_contact | speaker | public |
|---|---|---|---|---|---|---|---|---|---|---|
| Configure org, integrations, API keys | ✎ | ✎ | — | — | — | — | — | — | — | — |
| Create/configure event | ✎ | ✎ | ✎ | — | — | — | — | — | — | — |
| Manage tracks, formats, rooms | ✎ | ✎ | ✎ | — | — | 👁 | — | — | — | — |
| Configure CFP and forms | ✎ | ✎ | ✎ | — | — | 👁 | — | — | — | — |
| Submit a proposal | ✎ | ✎ | ✎ | ✎ | ✎ | ✎ | ✎ | ✎ (sponsor) | ✎ | — |
| Read any proposal | 👁 | 👁 | 👁 | 👁 (track) | 👁 (assigned) | 👁 | 👁 (sponsor) | O | O | — |
| Edit a proposal | ✎ | ✎ | ✎ | — | — | — | ✎ (sponsor) | O | O (draft) | — |
| Read reviews and scores | 👁 | 👁 | 👁 | 👁 (track) | O + post-submit | — | — | — | — | — |
| Submit a review | — | — | ✎ | ✎ | ✎ | — | — | — | — | — |
| Record and publish decisions | ✎ | ✎ | ✎ | recommend | — | — | — | — | — | — |
| Manage sponsors, tiers, entitlements | ✎ | ✎ | 👁 | — | — | 👁 | ✎ | 👁 (own) | — | — |
| Create and edit sessions | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | — | 👁 | — |
| Approve session content | ✎ | ✎ | ✎ | 👁 | — | ✎ | — | — | — | — |
| Restore a session revision | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Manage the event roster (`EventParticipant`) | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | — | — | — |
| Edit a speaker profile | ✎ | ✎ | ✎ | — | — | ✎ | — | — | O | — |
| Set profile `visibility` / `is_listed` | — | — | — | — | — | — | — | — | O | — |
| Read and write `PersonNote` | ✎ | ✎ | ✎ | 👁 | — | ✎ | ✎ (sponsor) | — | — | — |
| Read the speaker directory ([`14`](14-speaker-crm.md)) | 👁 | 👁 | 👁 | — | — | 👁 | 👁 | — | — | — |
| Manage `ContactSegment`s | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Run a `SourcingPipeline` | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Comment on an uploaded file | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | O | O | — |
| Compose and send a campaign | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | — | — | — |
| Read the communications history | 👁 | 👁 | 👁 | — | — | 👁 | 👁 (sponsor) | — | O | — |
| Import records in bulk | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | — | — | — |
| Request an export | ✎ | ✎ | ✎ | ✎ (track) | O | ✎ | ✎ (sponsor) | — | — | — |
| Manage custom field definitions | ✎ | ✎ | ✎ | — | — | — | — | — | — | — |
| Define onboarding tasks | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Complete a task | ✎ | ✎ | ✎ | — | — | ✎ | ✎ | O | O | — |
| Approve a task submission | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | — | — | — |
| Place sessions on the schedule | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Publish the schedule | ✎ | ✎ | ✎ | — | — | — | — | — | — | — |
| Read the published schedule | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| Read PII | 👁 | 👁 | 👁 | — | — | 👁 | 👁 (sponsor) | — | O | — |
| Read the audit log | 👁 | 👁 | 👁 (event) | — | — | — | — | — | — | — |

The three Speaker CRM rows arrived with [`14`](14-speaker-crm.md), which is org-scoped
rather than event-scoped: the directory is `Person` at org scope, and INV-14-7 says this
context grants no access to any event's proposals, reviews or decisions. `track_lead` and
`reviewer` are absent from all three because their grants are event- or track-scoped and
this data is neither. Pushing a contact into an event is *not* a fourth row — it creates an
`EventParticipant`, so it is the existing "Manage the event roster" row (INV-14-5).

Two rules override the table:

1. **Relationship access is scoped and revocable.** Speakers and sponsor contacts get `O`
   access through `SessionSpeaker` / `SponsorContact`; when the relationship ends, so does
   the access, in the same transaction.
2. **Nobody sees reviews of their own proposal**, at any role. A program chair who submits a
   talk is a submitter for that talk and is excluded from its review data and its decision.
   This is enforced in the authorization layer, not left to good manners.

## Validation and errors

Domain errors are typed and carry the invariant they enforce:

```json
{
  "error": "entitlement_exhausted",
  "message": "Acme Corp has used all 2 session slots for AI Engineer World's Fair 2026.",
  "invariant": "INV-03-3",
  "details": { "entitlement_id": "ent_01H...", "quantity": 2, "consumed_count": 2 }
}
```

Field-level validation errors are returned as a list keyed by `field_key`, so a multi-step
form can route each error back to the step that owns it rather than showing a wall of red at
the top.

## Concurrency

- Aggregate roots carry a `version` integer; writes are compare-and-set. A conflicting write
  returns `409` with the current state, never a silent overwrite (INV-11-14).
- **Every** write to a versioned root moves the counter, not only the compare-and-set ones.
  A version that advances solely on checked writes misses the status transition that landed
  in between, and the next check then passes for an edit that was in fact stale.
- The check is only as good as what the client sends back. An edit form renders the version
  it read and returns it on submit; a form that omits it is last-write-wins, which is the
  defect this rule exists to prevent rather than a lighter version of it.
- Autosave uses `DraftProgress.client_revision` (INV-04-6).
- Schedule placement is serialised per event — one writer at a time — because concurrent
  drags produce conflicts that no amount of retry logic untangles.
- Counters (`Entitlement.consumed_count`, `ProposalScore.*`) are **derived**, computed from
  their source rows. Stored counters drift, and drifted counters here mean a sponsor loses a
  slot they paid for.

## Invariants

- **INV-11-1** Every entity is reachable from exactly one `org_id`; every query is scoped by
  it. No cross-org read is possible through any surface.
- **INV-11-2** Soft-deleted records are excluded from all reads, counts and aggregates
  unless explicitly requested by an admin.
- **INV-11-3** An asset may not be attached to a completed task, a published session, or any
  public surface unless `scan_status = clean`.
- **INV-11-4** PII fields are absent from publication snapshots, public API responses,
  webhook payloads without `include_pii`, and application logs.
- **INV-11-5** Every state transition listed in this model writes an audit row; overrides
  and waivers additionally require a `reason`.
- **INV-11-6** Derived fields are never writable through any API.
- **INV-11-7** A person may never read review data, scores, reviewer identities or committee
  discussion for a proposal they submitted or are credited on, regardless of role.
- **INV-11-8** All public slugs are immutable once published; renames create redirects.
- **INV-11-9** Uploading into an occupied `slot_key` creates a new `Asset` with
  `version = max + 1` and `supersedes_asset_id` set. Prior versions are never overwritten,
  and exactly one non-deleted asset per `slot_key` has `is_latest = true`.
- **INV-11-10** `AssetComment` threads belong to a `slot_key` and survive new versions.
  A comment is visible to exactly the people who may read the asset, and to no one else.
- **INV-11-11** A `CustomFieldDefinition` must declare `pii` and `audience` at creation.
  Values of `pii` fields are redacted wherever the fields in the PII table are; values of
  fields whose `audience != public` never reach a publication snapshot or a public response.
- **INV-11-12** An export is generated under the requesting person's permissions as
  evaluated at generation time, honours `include_pii` only when they hold `pii:read`, and
  can never contain a record or column that person could not read through the API.
- **INV-11-13** A `BulkImport` writes nothing before the operator confirms its preview, and
  reports failures per row; a malformed row never aborts the rows around it.
- **INV-11-14** A field edit submitted against a stale version of an aggregate root is
  refused with `409` and the current state. It is never silently applied, and the refusal
  costs the writer their edit rather than costing the other writer theirs.

## Emitted events

`asset.uploaded`, `asset.version_superseded`, `asset.scan_completed`,
`asset_comment.added`, `custom_field.defined`, `bulk_import.completed`, `export.ready`.
Payloads in [`10-domain-events.md`](10-domain-events.md).
