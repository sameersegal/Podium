# Taste reports

Non-normative. One report per walk of the running product by the
[`product-taste`](../../.claude/agents/product-taste.md) agent: one person, one job, recorded
screen by screen and rated out of five stars.

These are not bug reports and not design documents. They are an account of what using this
product was like for somebody who had never seen it, written while they were using it. The
star rating is the gap between that and a product people enjoy, and the last section of every
report is the shortest list of changes that would close one star of it.

Read them as evidence, not as a backlog. A finding here is what one person hit on one trip;
whether it is worth fixing, and how, is somebody else's call.

- **The seed is the world.** Every walk runs against `npm run dev`, so two reports of the same
  journey are comparable.
- **Screenshots live in the scratchpad**, not here. A report names the file it rests on; rerun
  the journey to regenerate them.
- **Nothing here is a specification.** Where a report disagrees with `docs/domain/`, the model
  is right about what the product should do and the report is right about what it felt like.

| Walked | Journey | Role | ★ |
|---|---|---|---|
| [2026-08-14](2026-08-14-first-time-speaker-submits.md) | Submitting a talk across two sittings, phone then laptop | A first-time speaker | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-organizer-fills-the-programme.md) | Opening a second call and getting it live for tomorrow's newsletter (S1) | The organizer | ★★☆☆☆ |
| [2026-08-15](2026-08-15-speaker-submits-and-hears-back.md) | Getting a talk in across three sittings, and finding out what happened to it (S2) | A first-time speaker | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-chair-and-reviewer-judge-the-field.md) | Checking what reviewers see, handing off the unread pile, then reviewing it (S3) | The chair, then a reviewer | ★★☆☆☆ |
| [2026-08-15](2026-08-15-accepted-speaker-gets-to-the-stage.md) | Doing everything the conference is asking of her after a yes, on a phone (S4) | An accepted speaker | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-operations-closes-the-supply-chain.md) | Finding who is behind, nudging exactly them, and getting the files to AV (S5) | Speaker operations | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-organizer-publishes-a-living-schedule.md) | Publishing the grid, then cancelling a talk from a taxi on a phone (S6) | The organizer | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-public-surface-holds-up.md) | Embedding the schedule on the conference's own site, then planning a day on a phone (S7) | An attendee, and the site's owner | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-partnerships-delivers-the-package.md) | Stating each sponsor's position, then a sponsor naming their speaker (S8) | Partnerships, then a sponsor | ★☆☆☆☆ |
| [2026-08-15](2026-08-15-organizer-builds-the-bench.md) | Finding a half-remembered speaker from last year and starting an approach (S9) | The organizer | ★★☆☆☆ |
| [2026-08-15](2026-08-15-new-organization-adopts-the-product.md) | Arriving with nothing and trying to run your own conference here (S10) | A new organization | ★☆☆☆☆ |

S1–S10 were walked in one day, a fresh world each, and what the ten say together is in
[**Ten walks, one day**](2026-08-15-ten-walks-consolidated.md): 13 stars out of 50, Trust at one
star in eight of them, and one finding under nearly all of it — the product confirms things it
did not do. Read it after a report, never instead of one; the reports are the evidence and it is
only the arithmetic.

Those ~110 findings grouped by *the change that fixes them* rather than by the walk that found
them are in [**The ten walks, grouped into work**](2026-08-17-fix-groups.md) — twelve groups, four
of them load-bearing. That file is a triage of the evidence and can be wrong where a report
cannot; it exists because the rule above ("read them as evidence, not as a backlog") means somebody
has to make that call somewhere, and this is where.

What is waiting to be walked, and in what order, is [`scenarios.md`](scenarios.md) — ten roles
paired with the business objective each one is responsible for, derived from the functional
rubric in `../killmysaas-evals` and asking the question that rubric does not: not whether the
product can do it, but whether the person doing it would come back.
