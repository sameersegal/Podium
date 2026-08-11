# 12 — Glossary

The ubiquitous language. Code, UI copy, API fields and conversation should all use these
words with these meanings. Where a common synonym exists, it is listed so it can be
deliberately avoided.

**Speaker-facing email is sent as the event, not as the product.** Somebody who submitted to
AI Engineer World's Fair gets mail from AI Engineer World's Fair. *Podium* belongs on the
login screen and the invoice, not in a rejection letter.

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Podium** | The product these documents specify (R29). | podium.com and podium-lib — both unrelated |
| **Organization** | The body that runs the conferences. One per deployment. | Sponsor (a company that pays), Venue |
| **Event** | One conference occurrence — "AI Engineer World's Fair 2026". | *Domain event*; always qualify when both are in play |
| **Event day** | One calendar day of an event, an explicit record. | A date computed from `starts_on` |
| **Track** | A thematic lane (Agents, Evals, RAG). Owns reviewers, quotas and schedule columns. | Room, Format |
| **Starter blueprint** | The shipped configuration a new event is created with unless told otherwise: days, one placeholder track, the universal formats, rooms, a call with a published form, rubrics and the onboarding checklist. | Seed data (a development fixture) |
| **Clone** | Creating an event by copying an existing edition's *configuration* — never its people, proposals, sessions or decisions — with every date rebased onto the new event. | Snapshot, Import |
| **Rebasing** | Shifting a copied instant by the whole number of days between two events' `starts_on`, keeping its wall-clock time in the event timezone. | Timezone conversion |
| **Session format** | The kind of program item: talk, workshop, lightning talk, keynote, sponsor demo. | Track, Duration |
| **CFP / Call for proposals** | An intake window with its own audience, deadline and form. An event may run several. | Submission form |
| **Submission form** | The versioned, multi-step questionnaire a CFP presents. | CFP |
| **Form field `key`** | The stable identifier for a question, unchanged across form versions. Reusing a key means "the same question". | Field label |
| **`maps_to`** | The declaration that a form field's answer also populates a first-class `Proposal` column. | Validation |
| **Proposal** | A *request* for a slot. Owned by its submitter, reviewed, frozen at decision time. | Session |
| **Session** | A *confirmed item in the program*. Created after acceptance and confirmation; onboarded, scheduled, published. | Proposal, Placement |
| **Origin** | Which pipeline something came from: `cfp`, `sponsor`, `invited`, `organizer`. | Format |
| **Submitter** | The person who typed the proposal. Not necessarily a speaker. | Speaker |
| **Speaker** | Someone credited on a proposal or session. A *relationship*, never a granted role. | Submitter, Reviewer |
| **Primary speaker** | The one who confirms on the session's behalf and is the default assignee for session-level tasks. | Co-speaker, Moderator |
| **Placeholder person** | A `Person` created from a name and email by someone else, who has never signed in. | Deactivated person |
| **Person merge** | Deliberately collapsing duplicate people into one, repointing all references. | Deletion |
| **Merge candidate** | A surfaced possible duplicate, scored and awaiting a human decision. Never merged automatically. | Person merge |
| **Speaker profile** | The living, person-owned public profile, editable by staff except for its visibility settings. Snapshotted at publication. | Person (the identity record) |
| **Event participant** | A person's membership of one event's roster, with its own status and portal access. Grants no content access. | Speaker, Role grant |
| **Person note** | An internal, attributed, append-only note about a person. Never visible to its subject. | Review comment |
| **Custom field** | An organizer-defined field on a person, participant, session or sponsor, with a declared type, PII class and audience. | Form field (a CFP question) |
| **Sponsor** | A company. Long-lived, org-scoped, returns each year. | Sponsorship |
| **Sponsorship** | One sponsor's deal for one event. | Sponsor, Tier |
| **Tier** | A named sponsorship package for an event (Diamond, Gold). | Entitlement |
| **Entitlement** | A countable right granted by a sponsorship — two session slots, one booth. Held on draft, spent on session creation. | Tier, Contract |
| **Hold** | An entitlement reserved by a draft proposal, released if it is abandoned. | Spend |
| **Sponsor contact** | A named person acting for a sponsor. A relationship, revocable. | Sponsor manager (a staff role) |
| **Speaker nomination** | The onboarding task where a sponsor names the human who will present. | Speaker invitation |
| **Review round** | One pass over a scoped set of proposals with one rubric. Events run several. | Review |
| **Reviewer pool** | The set of people enrolled in one round. Membership of one round's pool implies nothing about another's. | Reviewer role grant |
| **Rubric / criterion** | The scoring scheme and its weighted dimensions. A criterion is `numeric`, `select`, `text` or `boolean`. | Recommendation |
| **Effective score** | The number a criterion score contributes to the aggregate, or null where it contributes none. Never treated as zero. | Value |
| **AI review** | A `Review` with `author_kind = ai`. Always labelled, always overridable, never counts toward quorum. | Review |
| **Recommendation** | A reviewer's holistic verdict (`strong_accept` … `strong_reject`). | Decision |
| **Quorum** | `target_reviews_per_proposal` submitted reviews. | Consensus |
| **Disagreement** | Normalised standard deviation across reviews. The chair's triage signal. | Conflict |
| **Conflict of interest (COI)** | A declared or detected reason a reviewer must not review something. | Schedule conflict |
| **Stale review** | A submitted review whose proposal changed underneath it. | Superseded review |
| **Decision** | The authoritative selection record. `Proposal.status` is downstream of it. | Outcome (its field) |
| **Provisional / published decision** | Recorded but not yet communicated / communicated to the speaker. Nothing reaches a speaker until publish. | Draft |
| **Confirmation deadline** | When an accepted proposal expires if its speakers do not confirm. | CFP deadline |
| **Task definition** | The template: what must be done, by whom, by when. | Task instance |
| **Task instance** | One person's actual obligation, snapshotted from a definition. | Task definition |
| **Materialisation** | Creating task instances from definitions when a session or speaker is confirmed. Idempotent. | Assignment |
| **Blocking task** | An incomplete task that prevents the session from being published. | Required task |
| **Waived** | An organizer decided a task need not be done. Recorded separately from completed, always with a reason. | Completed, Cancelled |
| **Placement** | A session's room and time. Times live here, not on the session. | Session, Time slot |
| **Time slot** | An optional grid cell an event may align placements to. | Placement |
| **Schedule conflict** | A computed clash — room, speaker, duration, AV. Surfaced loudly; blocks publication, not placement. | Conflict of interest |
| **Content status** | Editorial sign-off on a session's words — `draft`, `in_review`, `approved`, `changes_requested`. Gates publication. | Session status (whether it is happening) |
| **Session revision** | An append-only content snapshot of a session. Restoring one writes a new revision forward. | Proposal revision |
| **Assisted placement** | A proposed set of placements produced in one action, for a human to accept or discard. Never applied automatically. | Placement |
| **Publication** | An immutable, versioned snapshot of the public schedule. The only thing the outside world reads. | Placement, Draft schedule |
| **Live publication** | The one currently served. Exactly one per event. | Superseded |
| **Pending changes** | Working state that differs from the live publication and is therefore not yet public. | Diff |
| **Diff** | The computed change list between consecutive publications; drives notifications and "what changed". | Revision |
| **Content etag** | Hash of a publication's content; the cache key for embeds and public API. | Version |
| **Embed** | A configured public view of a live publication for a specific site. Its `widget_type` is *what* it renders; its `format` is *how* it is delivered. | Publication |
| **Slot key** | What a file is an instance of. Re-uploading into the same slot creates a version; the comment thread belongs to the slot, not the version. | Asset id |
| **Campaign** | An organizer-composed bulk message to a criteria-defined audience. Resolved at send time, logged per recipient. | Notification template |
| **Segment** | A saved contact query — `dynamic` (re-resolves) or `static` (a frozen list). The choice is explicit. | Filter |
| **Prospect card** | A person being pursued for a future programme, on a sourcing pipeline. Not a proposal; there is nothing proposed yet. | Proposal |
| **Domain event** | An immutable fact that happened, in the published catalogue. The integration contract. | Event (the conference) |
| **Subject** | The primary entity a domain event is about; webhook ordering is per subject. | Actor |
| **Actor** | Who or what caused an event: person, API key, system, integration. | Assignee |
| **Correlation / causation id** | Groups events from one request / names the event that caused this one. | Idempotency key |
| **Capability** | A plugin contract the core calls: `email`, `chat`, `calendar`, `crm`, `storage`, `identity`. | Integration (an installed instance) |
| **Scope** | What an API key may touch. `pii:read` is separate and additive. | Role |
| **Role grant** | A scoped, revocable, expiring permission held by a person. | Relationship-derived access |
| **Relationship-derived access** | Permission that comes from *being* a speaker or sponsor contact, and ends with the relationship. | Role grant |
| **Derived field** | Computed at read time, never stored, never writable. | Denormalised field |
| **Snapshot** | An immutable copy taken at a moment that matters — submit, decision, publication. | Revision |
| **Reference** | The short human-facing code (`WF26-0142`). Safe to say aloud. | ULID |
