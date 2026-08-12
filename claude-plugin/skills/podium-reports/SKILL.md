---
name: podium-reports
description: Get data out of Podium and keep integrations healthy — the event dashboard and readiness check, CSV/JSON exports of proposals, sessions, speakers and sponsors, bulk imports, webhooks and their delivery log, and installed integrations. Trigger on "export the schedule", "give me a CSV of accepted talks", "how is the CFP tracking", "import this spreadsheet", "set up a webhook", "did the webhook fire", "why didn't the email send", "is the Slack integration working".
---

# Reporting, exports and integrations

Read `podium-api` first for connection and conventions.

## Where the numbers live

```bash
podium get /v1/events/evt_…/dashboard    # the funnel, counted
podium get /v1/events/evt_…/readiness    # { ready, blockers, day_count, … }
```

The dashboard returns the proposal funnel (`draft`, `submitted`, `in_review`, `accepted`, …)
with counts. This is the right answer to "how is the CFP going" — one call, no pagination.

For counts of a filtered slice, `GET /v1/proposals` carries `total` alongside `data`, so
`podium get /v1/proposals event_id=… status=accepted limit=1` gives a count without walking
pages.

## Exports

Asynchronous: request, poll, download.

```bash
# 1. request
podium post /v1/exports subject=sessions format=csv event_id=evt_…
# { "id": "exp_…", "status": "queued", "result_asset_id": null }

# 2. poll until ready (it is usually fast, but it is a queue)
podium get /v1/exports/exp_…
# { "status": "ready", "result_asset_id": "ast_…", "byte_size": 1920 }

# 3. download
podium download /files/ast_…/download --out sessions.csv
```

`subject` selects what is exported (sessions, proposals, speakers, sponsors, …), `format` is
`csv` or `json`, and `filters`/`options` narrow it. `GET /v1/exports` lists past exports; they
carry an `expires_at` about a week out.

**`include_pii` defaults to false**, and a sessions export without it has no email addresses.
Setting `include_pii:=true` requires the key to hold `pii:read` and produces a file with
personal data in it — say so to the operator, and do not leave it lying in a working
directory.

The sessions export columns, for reference: `id, reference, title, status, content_status,
track, format, duration_minutes, room, starts_at, speaker_names`.

## Imports

```bash
podium get  /v1/imports
podium post /v1/imports …                      # upload and create
podium post /v1/imports/imp_…/map column_mapping:='{ … }' dedupe_key=email
podium post /v1/imports/imp_…/run
podium get  /v1/imports/imp_…
```

Three steps on purpose: create, map the columns, then run. Read the mapping back before
running — an import that ran with the wrong `dedupe_key` makes duplicate people, and there is
no undo.

## Webhooks

```bash
podium get  /v1/webhooks
podium post /v1/webhooks name="Ops" url=https://ops.example.com/podium \
    event_types:='["proposal.*","decision.published"]' include_pii:=false
podium get  /v1/webhooks/whk_…/deliveries
podium post /v1/webhooks/whk_…/deliveries/whd_…/redeliver
podium post /v1/webhooks/whk_…/replay event_type=proposal.submitted \
    from=2027-01-01T00:00:00Z to=2027-01-31T00:00:00Z
podium post /v1/webhooks/whk_…/rotate-secret
```

`event_types` accepts `*` and prefix wildcards like `proposal.*`. The secret is returned once
on creation and once on rotation.

What a consumer needs to know, and what to tell whoever is building one:

- **At-least-once, ordered per subject.** The consumer must be idempotent on the event id,
  which arrives in the `X-Event-Id` header.
- **Signature**: `X-Signature: t=<unix>,v1=<hmac(t + "." + body)>`. Both the current and the
  previous secret verify during a rotation window.
- **Retries** back off (1m, 5m, 30m, 2h, 6h, 24h) and then mark the delivery `exhausted`.
  Twenty consecutive failures pauses the webhook and notifies the org owner
  (`status: disabled_after_failures`).
- `include_pii` follows the same rule as `pii:read`: without it, payloads are redacted.

Debugging "the webhook didn't fire": check `status` on the webhook (a paused one is the usual
answer), then `deliveries` for the `response_status` and `error`, then `replay` the window
once the endpoint is fixed. `redeliver` is for one delivery; `replay` is for a range.

## Integrations

```bash
podium get  /v1/integrations
podium post /v1/integrations plugin_key=email.resend display_name="Resend" \
    secret_ref=… is_default_for_capability:=true
podium post /v1/integrations/itg_… config:='{ … }' status=active
podium post /v1/integrations/itg_…/health-check
```

An integration is an installed adapter for a capability (`email`, `chat`, `calendar`, `crm`,
`sync`, …). **`secret_ref` is a pointer into the secret store, never the secret itself**
(INV-09-3) — a call that puts an API key in that field is a leak, not a configuration.

`health-check` is the first thing to run when "emails aren't sending". It updates
`last_health_check_at` and `last_error`. A `misconfigured` status with a `last_error` is
usually the whole diagnosis.

One default per capability per scope: setting `is_default_for_capability` on a second email
integration moves the default rather than creating two.

## Sync mappings

For two-way sync with an external system (Airtable and the like):

```bash
podium get  /v1/sync/subjects            # what can be synced
podium get  /v1/sync/mappings
podium post /v1/sync/mappings/map_…/scaffold
podium post /v1/sync/mappings/map_…/pull
podium post /v1/sync/mappings/map_…/push
podium get  /v1/sync/conflicts
podium post /v1/sync/links/lnk_…/resolve
```

Conflicts are surfaced rather than resolved silently. `GET /v1/sync/mappings/:id/runs` is the
run history when a sync "didn't happen".
