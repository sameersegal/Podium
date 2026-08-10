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
| Task payloads | any `TaskSubmission.payload` for a definition in category `travel` or `legal` |
| Technical | IP addresses and user agents in `AuditLog` and acknowledgement records |

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

Uploads are direct-to-storage via presigned URLs; the API never proxies file bytes. Public
assets are served from a CDN path derived from `storage_key`; private assets only via
short-lived signed URLs.

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
| Define onboarding tasks | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Complete a task | ✎ | ✎ | ✎ | — | — | ✎ | ✎ | O | O | — |
| Approve a task submission | ✎ | ✎ | ✎ | — | — | ✎ | ✎ (sponsor) | — | — | — |
| Place sessions on the schedule | ✎ | ✎ | ✎ | — | — | ✎ | — | — | — | — |
| Publish the schedule | ✎ | ✎ | ✎ | — | — | — | — | — | — | — |
| Read the published schedule | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 | 👁 |
| Read PII | 👁 | 👁 | 👁 | — | — | 👁 | 👁 (sponsor) | — | O | — |
| Read the audit log | 👁 | 👁 | 👁 (event) | — | — | — | — | — | — | — |

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
  returns `409` with the current state, never a silent overwrite.
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
