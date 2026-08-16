---
name: db-performance
description: Profile the D1 cost of every action against a running seeded instance, find the N+1s and duplicated reads, fix them, and record the new numbers as the accepted baseline. Use on a periodic cadence — monthly, before a release, or after any batch of feature work — and whenever someone asks why a screen is slow, how many queries a page costs, whether there is an N+1 anywhere, what the query budget is, or asks to profile, benchmark or optimise the database layer. Also use when `npm run perf:db -- --check` fails in CI, when a screen has grown noticeably slower, or before opening the product to a bigger event, since almost every defect this finds is invisible on a small fixture and quadratic on a real conference. Its scripts/perf-db.mjs walks every route as each persona, reports the statements each one repeated, and `--check` exits non-zero against the accepted baseline. Not for client-side or first-render performance — `npm run perf` (scripts/perf-console.mjs) does that.
---

# Database performance

## What this is for

`implementer.md`, G sets the contract: **"D1 queries per request — single digits; an N+1 is
a defect, not a slow path."** This is the loop that holds it — measure everything, fix what
the measurement names, accept the new numbers, repeat.

It exists because the two things that came before it each answered half the question.
`x-podium-d1-queries` tells you a screen is expensive but never what it spent the budget on,
so every investigation started by reading code and guessing.
`tests/integration/foundation/query-budget.test.ts` pins a dozen screens someone once
suspected, which by construction cannot find the ones nobody suspected. This walks all of
them and reports the evidence.

**The defects it finds are usually invisible today and quadratic later.** Three statements
per proposal costs six on a fixture with two proposals and nine hundred on a real conference.
That is why this runs on a schedule rather than when something feels slow: by the time it
feels slow, it is in production at a scale that makes it hard to change.

## Rules of engagement

Localhost only, against `npm run dev`. The profiler needs the dev-only `/dev/profile` and
`/dev/fixtures` routes, which refuse when `ENVIRONMENT` is `production`, so pointing it at a
deployed instance does not work and must not be made to.

Never optimise a number without a measurement in front of you and a measurement after. The
whole point of this loop is that "this looks like it might be slow" is not evidence, and the
profile is.

## Procedure

### 1. Stand up a fresh instance

```bash
npm run dev        # reset, migrate, seed, serve on :8787, publish the seeded schedule
```

Wait for the seeded schedule to publish before profiling — the public pages serve the
publication snapshot (INV-09-6), and an unpublished seed measures the empty version of them:

```bash
until curl -s localhost:8787/dev/status | grep -q '"schedule_publication": [1-9]'; do sleep 3; done
```

A **fresh** instance matters for comparability. The baseline is recorded against the seed as
`npm run dev` leaves it; an instance you have been clicking around in has different row
counts and will not compare.

### 2. Measure

```bash
npm run perf:db                      # the full report
npm run perf:db -- --check           # only what regressed since the baseline
npm run perf:db -- --json out.json   # every statement, for your own analysis
npm run perf:db -- --only /admin/events   # one area, while iterating on a fix
npm run perf:db -- --mutations       # plus a curated set of writes
```

It walks every route in the inventory as each persona, scoring each route as the **weakest
persona that gets a 2xx** — profiling `/portal` as an organizer measures a page nobody opens.
The route list comes from the security skill's `attack_surface.py`, not a list kept beside
it, so a route cannot be added without being profiled. Each route is hit twice and the second
is recorded, because a first hit also measures filling a cold cache.

Takes about ten seconds.

### 3. Read the four signals, in this order

**The request baseline first.** It is the shared prefix every authenticated request pays
before its route runs, so a statement here is one statement × every route in the product. It
was 11 and is 3; if the report says more than 3, that is the finding, whatever else is on the
page. Nothing else in this report has that leverage.

**Then `rpt` — the repeat count.** The same parameterised statement sent k times in one
request is a loop over k rows, whatever the code looks like. This is the most reliable column
here because it does not require knowing what the screen *should* cost. `rpt` of 0 on an
expensive route means the route is honestly wide, which is not a defect; `rpt` of 20 on a
cheap one is a quadratic waiting for a real event.

**Then the `N+1 SUSPECTS` section**, which names the statement text and the route. Go
straight from there to the code — the SQL says which table and which predicate, so the loop
is usually one grep away.

**Then `WHERE THE BUDGET GOES`**, the table totals across the whole walk. This is the one
that finds the costs no single screen is big enough to reveal. `organization (select)` at the
top of that table — 344 statements, two per request — is what exposed the doubled org read
that no individual route looked guilty of.

`stmt` vs `trip` is a distinction worth keeping straight: `d1.batch()` sends any number of
prepared statements in **one** round trip. Statements measure the work, round trips measure
the latency. A fix that moves work into a batch shows up in one column and not the other, and
neither number is wrong.

### 4. Fix, cheapest leverage first

The catalogue below is the set of shapes this has actually found in this codebase. Work down
it; the earlier entries pay off across many routes at once.

| Shape | How it reads in the report | The fix |
|---|---|---|
| **Work in the request baseline** | the baseline block lists it | Every request pays it. Collapse it or defer it — nothing else here has this reach. |
| **Two reads of one row** | the same `SELECT … WHERE id = ?` twice, often across layers | Return the whole row from the first read, or let the identity map answer (below). |
| **`byId` in a loop** | `N×  SELECT * FROM x WHERE id = ?` | One `select(table, { id: [...] })` and a `Map`. |
| **`COUNT(*)` per row** | `N×  SELECT COUNT(*) … WHERE k = ?` | One `GROUP BY k`, read into a `Map`. |
| **A whole read model for one field** | an expensive helper called where one column was wanted | Read the column off a row the caller already holds. |
| **The same fact set loaded twice** | a block of identical statements repeated at the bottom | Add an optional `preloaded` parameter and pass what the caller has. `pendingChanges` and `buildSnapshot` are the worked examples. |
| **Row-by-row writes** | `N×  INSERT INTO …` | `insertMany`, or `buildUpdate` into one `db.batch()` — one round trip, and all-or-nothing as a bonus. |
| **A write on every read** | an `UPDATE` in the baseline | If the column is display-only, refresh it on an interval instead. See `ACTIVITY_STAMP_INTERVAL_MS`. |

Two facilities already exist; reach for them before inventing a third.

- **The per-request identity map** (`packages/data/src/db.ts`) already de-duplicates `byId`
  reads within one GET. If a repeat survives it, the reads are *not* both `byId` — one is a
  `select` or a `first`, and the fix is to make it a `byId` or to pass the row.
- **`preloaded` parameters.** Several loaders take one already. It is the house pattern for
  "the caller has these rows"; prefer it over widening a cache.

Two D1 limits worth knowing before you write the clever query:

- **`SQLITE_MAX_COMPOUND_SELECT` is 5.** Six `UNION ALL` arms fails outright with "too many
  terms in compound SELECT". Uncorrelated scalar subqueries with `json_group_array` have no
  such limit and were the fix for the six authorization lookups.
- **`d1.batch()` is one round trip and one transaction.** It is the right tool for N writes
  and is *not* available for reads through `Db` — `batch` returns void by design.

### 5. Verify, then accept

Every one of these touches a read path something depends on. Non-negotiable:

```bash
npm test                     # 90 files; authorization and tenancy live here
npm run typecheck
node scripts/smoke.mjs       # every screen still answers, as each persona
npm run perf:db -- --check   # the numbers moved the way you think they did
```

Then re-run the check to see the wins, and accept them:

```bash
npm run perf:db -- --update-baseline
```

**Accepting is a deliberate act, and improvements need it as much as regressions do.** A
baseline nobody re-records reports the same stale wins every run until people stop reading
it.

Commit `.claude/skills/db-performance/baseline.json` with the change that moved it, the way
`security-audit/baseline.json` is committed with the change that moved the attack surface.

### 6. Record what is now impossible

A fix that only changes a number comes back. Where the fix has behaviour worth naming, pin it:

- A screen worth failing a build over goes in
  `tests/integration/foundation/query-budget.test.ts` with a ceiling.
- A change to the repository layer's semantics goes in
  `tests/integration/foundation/row-cache.test.ts`, which tests the *rules* rather than the
  saving.
- The narrative — what it was, what it is, and why — goes in "What the redesign cost,
  measured" in `docs/implementation.md`.

## Reporting

Lead with the movement, then the fixes, then what you deliberately left. Keep it short:

```markdown
## D1 profile: <date / scope>

**162 routes · 1229 statements · median 6 · request baseline 3** — down from N / M / B.

### Fixed
| Route | before | after | what it was |
|---|---|---|---|
| `/admin/events/:id/files` | 68 | 11 | a `COUNT(*)` and a label lookup per slot |

### Left alone, deliberately
`GET /v1/events/:id/dashboard` at 37 with **zero** repeats — genuinely wide, not looping.

### Verification
`npm test` 90/90 · `smoke.mjs` 62/62 · `--check` clean, baseline re-recorded.
```

**"Expensive" and "defective" are different verdicts and the report must not blur them.** A
route with no repeated statements that reads twelve tables because it renders twelve things
is working. Say so and move on — a report that lists every large number trains the reader to
skim past the one route that is actually looping.

## What is out of scope

Client-side and first-render performance, which is `npm run perf`
(`scripts/perf-console.mjs`) and is measured in milliseconds through a real browser, not in
statements. Row counts and index behaviour at scale, which is `npm run perf:scale`. And
anything a single diff introduced — that is small enough to profile with `--only` and does
not need this loop.

## Why the script lives in `scripts/`

Unlike `attack_surface.py` and `model_inventory.py`, which are static analysers only their
skill runs, `perf-db.mjs` drives a running server and is a peer of `smoke.mjs` and
`perf-console.mjs` — people run it directly and it is aliased as `npm run perf:db`. The
*baseline* lives here, because deciding which numbers are acceptable is the judgement this
skill carries and the script does not.
