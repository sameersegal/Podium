# Positioning and capabilities

The companion to [`marketing-site.md`](../../marketing-site.md). That file says how to write. This
one says what is true, and where each thing is proved. It is never published: nothing here reaches
`www/`, and it exists to shape the pages rather than to become one.

**It is evidence, not copy.** Nothing here is a sentence to paste onto a page. Phrases in this
document are the internal frame; the buyer's version is always shorter and more specific. Read it
before drafting, then write for the reader in B.

**It is checked, not remembered.** Every claim below names a path. When one goes stale that is a
defect in this file, not a licence to keep saying it. This file is the one thing outside `www/`
the marketing agent may edit, so it changes in the same commit as the page that found the drift.

---

## The positioning statement

The internal frame, in Moore's form:

> For **conference organizers paying large bills for software like SessionBoard or Sessionize**,
> **Podium** is an **AI-native, self-hosted, open-source** program platform that gives them
> **complete ownership, deep customization, integration and extendability, and low running costs**,
> and that **works for agents as well as humans**.

Never put that paragraph on a page. It is six claims stacked, and stacked claims read as
marketing. Split it, and take one at a time.

| The claim | What backs it | The limit that ships with it |
|---|---|---|
| AI native | `docs/domain/` is normative and predates the code; `.claude/agents/`, `.claude/skills/`; `npm run drift` and `npm run plugin:check` are both steps in the `check` job of `.github/workflows/ci.yml`, so the build fails when the code drifts from the model or the endpoint catalogue drifts from the routes; `claude-plugin/` is eight skills that operate a running instance over `/v1` | No MCP server and no OpenAPI document |
| Self-hosted | `scripts/deploy-config.mjs` generates production config against the operator's own D1, KV and hostname; the app takes `PUBLIC_BASE_URL` at deploy time and never learns its hostname otherwise | No hosted tier. Somebody deploys it |
| Open source | `LICENSE`, MIT | — |
| Complete ownership | Export in `packages/domain/src/content/export.ts`: `csv`, `json`, `zip`. GDPR erasure as a distinct audited operation | `xlsx` and `ics` are enum members with no generator behind them. Do not list them as export formats |
| Deep customization | The fork, plus the machinery that makes a fork survivable: spec before code, an implementer that stops outside the model, a drift check in CI | A change you make is a merge you own, and nobody has run that upgrade path in public |
| Integration and extendability | `packages/plugins/src/registry.ts` and `contracts.ts`: capability contracts with adapters behind them; signed webhooks; the `/v1` surface | Smaller catalogue than the incumbents. Say so before they count |
| Low costs | `LINE_ITEMS` in `www/src/pages/pricing.astro`: MIT software, Cloudflare Workers Paid from $5/month, metered storage, an email provider usually free at this volume | "Low cost" is not a claim, it is an invoice. Publish ours itemised and let the reader subtract |
| Works for agents as well as humans | The property table in section D of the agent file, each row sourced to `docs/domain/09` or `11` | — |

Counts are **not** repeated here. `STATS` in [`www/src/consts.ts`](../../../../www/src/consts.ts) holds every number
the site quotes, with the recipe for re-measuring each. A second copy is a number that will be
wrong later.

---

## The six capabilities

The product's own list, from [`README.md`](../../../../README.md). Each entry below is what it is, the pain
it answers in the buyer's words, and where to check it.

### 1. Multi-step submission forms

Abstracts from speakers, sessions from sponsors, on a form the organizer builds rather than one
the vendor shipped. Steps, conditional fields and per-field validation.

*The pain:* the CFP form is wrong by the second week and changing it means a support ticket.

*Proved by:* `form.steps` and `fieldsBefore` in `packages/domain/src/event-config/rules.ts`;
validation in `packages/domain/src/submissions/validation.ts`;
[`02`](../../../../docs/domain/02-event-configuration.md) and [`04`](../../../../docs/domain/04-submissions.md).
Sponsor-origin submissions are [`03`](../../../../docs/domain/03-sponsorship.md). Live at
`/e/devflow-conf-2027/cfp/main`.

### 2. Submitter portal

One place for a submitter to track proposals, complete onboarding tasks and keep a public profile
that the schedule renders directly.

*The pain:* sixty biographies pasted into a spreadsheet by hand, then copy-edited again for the
website.

*Proved by:* `/portal`; `workers/api/src/contexts/identity/routes.ts`;
[`04`](../../../../docs/domain/04-submissions.md) and [`07`](../../../../docs/domain/07-onboarding.md). Speakers
arrive on an emailed link and set no password in a production deployment.

### 3. Proposal evaluation

Rubrics, rounds, reviewer assignment, conflicts of interest, and decisions as records with their
own lifecycle.

*The pain:* the reviewer who turns out to be the submitter's manager, found after the scores are in.

*Proved by:* `packages/domain/src/review/` — `rubric.ts`, `coi.ts`, `assignment.ts`, `scoring.ts`,
`anonymity.ts`; `ReviewRound` in `review/types.ts`;
[`05`](../../../../docs/domain/05-review-and-selection.md). A conflicted reviewer's score is **refused**,
not flagged for someone to catch later.

The AI first-pass review (`review/ai-evaluator.ts`) is a separate claim with its own sentence: it
exists, it is off unless switched on, its opinions are counted beside your reviewers' rather than
inside them, and the evaluator that ships calls no external model.

### 4. Onboarding

Define what accepted speakers must do, then chase it to completion. Task definitions, due rules,
assignees, review-before-publish on uploads.

*The pain:* the week before the event, chasing eleven headshots and four slide decks by hand.

*Proved by:* `packages/domain/src/onboarding/defaults.ts` and `types.ts`;
[`07`](../../../../docs/domain/07-onboarding.md). The default task set ships in the seed, because a blank
onboarding config is where organizers reopen the spreadsheet.

### 5. Public schedule

An embeddable, versioned, cacheable snapshot the marketing site points at.

*The pain:* publishing an hour before doors open, with no way back if it is wrong.

*Proved by:* `packages/domain/src/scheduling/publication.ts`, INV-08-11 (`content_etag` changes if
and only if the content does); `/embed/:key`;
[`08`](../../../../docs/domain/08-scheduling-and-publication.md). Public reads never touch live program
tables (INV-09-6), so rolling back is pointing at the previous snapshot.

### 6. APIs and webhooks

A versioned management surface and named domain events delivered on signed webhooks.

*The pain:* the schedule on the website is a different truth from the schedule in the tool.

*Proved by:* the `/v1` routes across `workers/api/src/contexts/*/routes.ts`; `signPayload` with
mid-rotation secret validity in `packages/domain/src/platform/webhooks.ts`;
[`09`](../../../../docs/domain/09-api-and-integrations.md) and
[`10`](../../../../docs/domain/10-domain-events.md).

---

## What Podium does not do

On the page, not discovered after installing.

- **No attendee registration, ticketing or badging.** Deliberate, per the ticketing decision in
  [`09`](../../../../docs/domain/09-api-and-integrations.md). The `ticketing` plugin is a stub.
- **No hosted tier.**
- **No track record** in the way a ten-year-old SaaS has one. Nobody has publicly moved a live
  conference onto this.
- **A smaller integration catalogue** than the incumbents.

### What the importer actually does

This bounds what you may claim about migration. It is not the shape of a page, and it is not a
checklist of rows to publish. The importer writes people and the roster; sessions and sponsors
preview and then refuse, no route authors a proposal, there is no bulk file import, and last
year's scores and decisions stay in whatever the old tool exports.

So: never promise that last year's programme comes across, and do not list sessions or proposals
as importable. Beyond that, judgement. What moves a switch is that the people and the roster come
over in one CSV, which is the part that would otherwise be a week of typing. Lead there. The
concession-proportion rule in the agent's C applies with force here, because these four facts will
happily fill a page on their own and a page of refusals argues against switching.

---

## Keeping this true

Check a claim here against its path during the task, not from memory. If the path has moved or the
behaviour has changed, fix this file in the same commit as the page. A capability that grew a limit
gains a row; a limit that was lifted loses one.

If the change is in the product rather than the page, that is a report to the user, not an edit
here. See Phase 0 of the agent.
