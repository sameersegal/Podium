---
name: podium-api
description: Connect to a hosted Podium instance and drive its management API. Read this FIRST for any Podium task — it carries the connection setup (instance URL + a .env holding the API token), the `podium` CLI, and the six conventions every other Podium skill assumes: scopes, PII redaction, cursor pagination, idempotency keys, compare-and-set writes, and typed errors that name the invariant they violated. Trigger on any request to inspect or change a conference running on Podium — proposals, reviews, decisions, sessions, the schedule, speaker tasks, sponsors, campaigns, exports — and whenever a Podium call returns 401, 403, 404, 409 or 422 and you need to know why.
---

# Operating Podium over its API

Podium is a conference platform: a call for proposals, review rounds, decisions, a schedule,
speaker onboarding and sponsor entitlements. Everything an organizer does in the admin UI
is reachable over HTTP, which is what makes an agent a first-class operator rather than a
guest.

## Connect

Two inputs, and no others:

1. **The instance URL** — `https://podium.example.com`.
2. **A file holding the API token** — a `.env` with `PODIUM_API_TOKEN=…`.

```bash
podium() { node "${CLAUDE_PLUGIN_ROOT}/scripts/podium.mjs" "$@"; }

podium whoami --url https://podium.example.com --env ~/.podium/.env
```

Or put both in the file and drop the flags:

```
PODIUM_URL=https://podium.example.com
PODIUM_API_TOKEN=pk_live_…
```

Searched in order when `--env` is not given: `$PODIUM_ENV_FILE`, `./.env`, `./.env.podium`,
`~/.podium/.env`, `~/.podium.env`. Environment variables win over the file.

**Start every session with `podium whoami`.** It reports the instance, the key's scopes, the
events it can see, and which surfaces actually answer — which is the cheapest possible way to
find out that a recipe is going to 403 four calls in.

### Getting a token

An organizer mints one at `/admin/api-keys` on the instance. The secret is shown once and
never stored (INV-09-1); if it is lost the key is rotated, not recovered.

Where password sign-in is enabled — the default local seed, and any instance without an email
integration — the plugin can mint one itself:

```bash
podium bootstrap-key --url http://localhost:8787 \
  --email organizer@example.com --password '…' --name "agent" --save
```

`--save` appends `PODIUM_URL` and `PODIUM_API_TOKEN` to the `.env`. Production instances
usually disable password sign-in (R23), and this will answer `403 password_login_disabled`
there; use `/admin/api-keys`.

**Never print the token.** It is an org-wide credential. Pass `--env`, not `--token`: argv is
visible in `ps` and lands in shell history.

## The CLI

```bash
podium whoami                                     # who am I, what can I reach
podium get   /v1/events                           # k=v pairs become query params
podium list  /v1/proposals event_id=evt_…         # follows next_cursor to the end
podium post  /v1/events/evt_…/rooms name="Hall A" capacity:=400
podium patch /v1/placements/plc_… start_time=14:00
podium delete /v1/rooms/rom_…
podium download /files/ast_…/download --out sessions.csv
podium endpoints schedule                         # grep the endpoint catalogue
```

- `k=v` is a string; `k:=<json>` is raw JSON — `capacity:=400`, `event_types:='["proposal.*"]'`.
- `--data '<json>'` or `--data @file.json` sends a whole body.
- `--fields id,title,status` projects list rows down to columns. Use it. A full proposal
  record is ~40 fields and a queue is 300 of them.
- `--dry-run` prints the request without sending it. Use it before any bulk write.
- Exit status: 0 on 2xx, 1 on an HTTP error, 2 on a usage or connection problem.

Every endpoint is in [`reference/endpoints.md`](reference/endpoints.md) — 190 of them, with
the scope each needs, the query parameters and body fields each reads, and the source file.
It is generated from the routes, so it is right. Grep it before guessing a path.

## Six conventions that will otherwise cost you a turn

### 1. Scopes, and the read-only trap

A key carries scopes: `events:*`, `proposals:*`, `reviews:*`, `decisions:*`, `sessions:*`,
`speakers:*`, `sponsors:*`, `entitlements:*`, `tasks:*`, `schedule:read`/`schedule:publish`,
`webhooks:manage`, `pii:read`. A key may also be pinned to specific events, in which case
every other event is a 404, not a 403.

> **A key holding only `:read` scopes is refused every management read.**
> Scopes are mapped onto a role — `admin` if the key holds any `:write` scope, `viewer`
> otherwise — and `viewer` carries no read permission in the authorization matrix. Such a key
> authenticates fine and then 403s on `/v1/events`, `/v1/proposals`, everything. It is not a
> broken token. Give the key at least one `:write` scope, or read `/v1/public/…` instead.
> `podium whoami` detects this and says so.

`pii:read` is separate and additive. Without it every response redacts email addresses, phone
numbers, dietary and accessibility notes, travel details and any form answer marked as PII —
including inside `proposals:read`. Most tasks do not need it. Ask for it only when the task is
literally about contacting people.

### 2. Lists are cursor-paginated

`{ "data": [...], "next_cursor": "prp_…" }`. Follow `next_cursor` until it is null; never
page by offset (a growing proposal table gives you duplicates and gaps mid-round). `podium
list` does this for you. A few endpoints — `/v1/api-keys`, `/v1/webhooks`, `/v1/campaigns` —
answer a bare array instead; `podium list` handles both.

A page may come back shorter than `limit` without being the last page: some lists filter rows
the caller may not see *after* paginating. Trust `next_cursor`, not the row count.

### 3. Every write should carry an idempotency key

`podium` puts a fresh `Idempotency-Key` on every mutating request. A repeat within 24h replays
the stored response and writes nothing (INV-09-7) — which is what makes retrying a timed-out
`POST` safe instead of a way to double-book a room. When a replay happens the CLI says so.

Pin the key with `--idempotency-key <k>` when you want a retry across separate invocations to
be the same request.

### 4. Concurrent writes: `row_version`

Records carry `row_version`. Send it on a write to make it compare-and-set; omit it and you
get last-write-wins. A stale value is refused with `409 version_conflict` carrying
`expected_version`, `current_version` and `current_state`. Re-read, merge, retry — do not
strip the version to force the write through.

### 5. Errors are typed and name the rule

```json
{ "error": "entitlement_exhausted", "message": "…", "invariant": "INV-03-7",
  "field_errors": [{ "field_key": "…", "message": "…" }] }
```

- **401** — token missing, revoked or expired.
- **403** — authenticated, not permitted. Check scopes, and re-read the read-only trap above.
- **404** — wrong id, or an id in an event this key is not pinned to.
- **409 `version_conflict`** — someone else wrote first.
- **422** — the request reached the domain and a rule refused it. `invariant` names the rule.
  This is information, not a bug: "an acceptance needs a confirmation deadline before it can
  be published" is the system telling you the next step.

Read the message. These are written to be actionable.

### 6. Some organizer actions live only on the admin surface

The management API is wide but not total. A handful of actions — publishing a batch of
decisions is the one you will hit — exist only as `/admin/...` form posts. An API key drives
them fine (the CSRF defence is `SameSite` cookies, and a bearer token carries none):

```bash
podium post /admin/events/evt_…/decisions/publish decision_id:='["dec_…"]'
```

They answer **303 with an HTML body, not JSON**. `podium` prints `null` and reports `HTTP 303`.
**A 303 is success.** Verify by re-reading the record — do not treat the empty body as failure.

## What the API cannot do

Say so rather than working around it:

- **Fill in a proposal's answers.** `POST /v1/proposals` creates a draft and
  `PATCH /v1/proposals/:id` performs an *organizer edit* of the proposal's own columns, but the
  answers a submission is validated against are written only by the speaker-facing wizard at
  `POST /portal/proposals/:id/step/:stepKey`, which needs that speaker's session. So
  `POST /v1/proposals/:id/submit` on an API-created draft answers `422 validation_failed`
  listing every required field. An agent can triage, edit, review, decide and schedule
  proposals; it cannot author one end to end.
- **Write review answers as another reviewer.** `POST /v1/reviews` posts a review; who it is
  attributed to follows the assignment.
- **Read reviewer identity** unless the round's anonymity is `open`. `reviewer_person_id`
  comes back `null` and that is the rule working, not a redaction you can unlock.

## The other skills

| Task | Skill |
|---|---|
| Create an event, configure days/rooms/tracks/formats, open or close a CFP | `podium-events` |
| Triage proposals, run review rounds, record and publish decisions | `podium-proposals` |
| Build the agenda, resolve conflicts, publish and roll back the schedule | `podium-schedule` |
| Sessions, speakers, onboarding tasks and reminders | `podium-speakers` |
| Sponsors, sponsorships, entitlements | `podium-sponsors` |
| Prospects, segments and email campaigns | `podium-crm` |
| Dashboards, readiness, exports, imports, webhooks, integrations | `podium-reports` |

Two vocabulary traps, because getting these wrong produces confident wrong answers:

- A **`Proposal`** is what someone submitted; a **`Session`** is what appears in the programme.
  Accepting a proposal creates a session. They have separate ids (`prp_…`, `ses_…`) and
  separate lifecycles.
- **Speaker** is a relationship to a session, not a role someone holds. There is no "speaker
  role" to grant.

If a question is about *how Podium behaves* rather than which call to make, the answer is in
the domain model — `docs/domain/` in the product repository — not in this plugin.
