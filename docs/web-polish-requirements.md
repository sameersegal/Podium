# Web experience polish — requirements

Non-normative. Gathered on 2026-08-11 by walking the seeded local instance
(`npm run dev`, `scripts/seed.mjs` data) page by page as each persona, at 1280 px and
390 px. Every item below was observed on a real screen, not inferred from code.

The screens walked: `/`, `/e/:slug`, the CFP page, public schedule and speakers, `/login`,
`/signup`, `/admin` and every event section, `/admin/contacts`, `/admin/team`,
`/admin/settings`, `/admin/audit`, the four portal screens and `/review`.

## The one root cause behind most of it

**Thirty class names are used in markup and defined nowhere in `public/app.css`.**
The markup already describes the layout it wants; the stylesheet never answered.

| Class | Uses | What it was meant to do | What actually renders |
|---|---|---|---|
| `inline-grid` | 56 | Compact multi-column form for filters and inline edits | `display: inline` — fields fall back to `.field`'s full-width column |
| `button` | 47 | A link styled as a button | Nothing. The class is `btn`; `button` is a typo repeated 47 times |
| `right` | 32 | Right-aligned table cell for row actions | Left-aligned |
| `row-edit` | 10 | Inline edit disclosure in a table row | Bare `<details>` with a raw `▶` marker |
| `filter-bar`, `bulk-actions`, `row-form`, `row-actions`, `progress-row`, `form-step`, `review-step`, `review-summary`, `submission`, `comment`, `comment-replies`, `replies`, `diff-list`, `criterion`, `candidates`, `conditional`, `cond-row`, `conditional-note`, `add-field`, `copy-url`, `swatch`, `notes`, `links`, `link-row`, `nowrap`, `break`, `active` | 1–3 each | Named components | Nothing |

Because `.inline-grid` is inert, **every filter bar in the product is a stack of
full-width controls**. On `/admin/contacts` that is ten fields and 700 px of chrome above
the first row of data; on `/admin/events/:id/proposals` it is six, of which five are
multi-selects rendered as 7-row list boxes 1180 px wide. The data starts below the fold on
a laptop.

Fixing the stylesheet fixes those hundred-odd call sites without touching their markup.

## A. Foundations

- **A1** Define every class the markup already uses (table above). No new class names in
  views for what already has one.
- **A2** There is no scale. One radius, no shadows, no elevation, `font-size: 15px` and
  ad-hoc `.small`/`.82rem`/`.84rem`/`.86rem`/`.88rem`/`.92rem` scattered across the sheet.
  Needs type, space, radius and shadow tokens, and every component reading from them.
- **A3** Links carry the browser's default underline everywhere — inside tables, stat
  tiles, nav rows, page-head actions. Bold underlined blue in a table cell is the single
  strongest "unstyled document" signal in the app. Underline belongs in prose.
- **A4** `:focus` draws a 2 px outline on mouse clicks as well as keyboard tabs. Needs
  `:focus-visible`, and a ring that reads on both the white card and the navy bar.
- **A5** Buttons have one weight and no hierarchy beyond `secondary`/`danger`. A primary
  action and a destructive one look equally loud, and neither has a hover/active
  transition.
- **A6** No `color-scheme`, so form controls and scrollbars ignore the OS setting.

## B. Density and forms

- **B1** Inputs stretch to the container: a 1180 px-wide "Edition" box holding `2027`
  (`/admin/events/:id`), a 1180 px "Tagline". Controls need a natural maximum, sized to
  the answer they take.
- **B2** Filter blocks are a wall (see root cause). They need to be one compact toolbar,
  collapsible, that states how many filters are active when collapsed.
- **B3** `multi_select` renders as a tall native list box. Six of them stacked is the
  proposals screen today. Needs a bounded, scrollable control, and to sit in the grid.
- **B4** Bulk-action bars are a bare stack: `/admin/contacts` ends with three unlabelled
  selects and four buttons in a column; `/admin/events/:id/onboarding` puts a naked
  full-width "Reason for waiving" text box between its two buttons.
- **B5** `/admin/events/:id/setup` shows four permanently-expanded "add" forms — day,
  track, format, room — inline under their tables, so the page reads as one endless form
  with tables interleaved. They should be disclosures, closed by default.
- **B6** Submit buttons stretch full width inside cards (`Save settings`, `Save organizer
  edit`, `Request changes`), which reads as a banner, not a button.

## C. Tables

- **C1** No column sizing. On `/admin/events/:id/sessions` the title column is crushed to
  ~80 px and wraps one word per line for six lines, while `ORIGIN` and `CONTENT` sit half
  empty; `DFC27-0001` wraps mid-reference. Titles need room; references, dates and status
  must not wrap.
- **C2** Raw instants are printed: `2026-07-30T12:00:00.000Z` in the proposals list,
  `2027-03-13` in onboarding, `str(e.occurred_at)` in the event log. `formatInZone`,
  `formatDateInZone` and `relativeDays` already exist in
  `packages/domain/src/shared/time.ts` and are simply not called.
- **C3** `<details>` in a cell renders its native `▶` marker, so action columns read
  `▶ Move`, `▶ Edit`, `▶ Acknowledge`.
- **C4** `/admin/events/:id/onboarding` is 60 rows with no sticky header — the columns are
  gone by row 12.
- **C5** Row hover is `#fcfcff`, effectively invisible; there is no zebra.
- **C6** Wide tables scroll horizontally inside `.table-wrap` with no indication that
  there is anything to the right. On a 390 px phone the email column is simply cut.

## D. Chrome and navigation

- **D1 (defect)** The day switcher renders `Day 1 — WorkshopsDay 2Day 3` — no separation
  at all — on both `/e/:slug/schedule` and `/admin/events/:id/schedule`. Both build a
  `<nav class="subnav">` with anchors as direct children, but `app.css` only spaces
  `.subnav > nav a`, and at ≥64rem sets `.subnav a { display: inline }`. It needs to be
  its own component, not a borrowed one.
- **D2** On a phone the top bar spends a whole row on "Sign in" alone.
- **D3** The event bar prints `2027-05-12 → 2027-05-14` — the one place in the app an
  organizer reads the dates most often, unformatted, while the public page formats the
  same pair correctly.
- **D4** `/e/:slug` nests a second `<main>` inside the shell's `<main>` (invalid), which
  is why the hero renders as a floating box with a margin instead of a full-bleed band.

## E. Empty and zero states

- **E1** An `.empty` box inside a `.card` draws a dashed box inside a solid box. The
  portal dashboard is four of these stacked.
- **E2** The CFP form preview renders steps that have no fields as "Nothing to fill in on
  this step" — two of the four steps on the seeded call.
- **E3** Zero states state the absence and stop. "You have not started a proposal yet" on
  the portal dashboard has no link to the open calls.

## F. Content defects found while walking

- **F1** `/e/:slug/cfp/:cfpSlug` prints every format's duration twice:
  `Keynote (45 min) (45 min)`. The format name already carries it.
- **F2** The 47 `class="button"` links (A1) are the "Clear", "Dashboard", "Back to
  contacts", "New segment", "New pipeline" actions — all rendering as bare underlined
  text where a button was intended.

## G. Public surface

- **G1** The hero is a boxed gradient rather than a band (D4).
- **G2** `/` is titled "Events" and is a bare two-card list on a mostly empty viewport,
  with "Sign in" duplicated in the bar and the page head.
- **G3** Session and speaker cards are flat white rectangles with no hierarchy between the
  title, the speaker and the metadata.

## H. Auth

- **H1** `/login` and `/signup` sit in a narrow card pinned to the top of an otherwise
  empty grey page, with no product framing.

## Out of scope

Anything governed by `docs/domain/` — entities, fields, enums, state machines,
invariants, domain events, the authorization matrix and PII classification — is untouched
by this work. It is presentation only: `public/app.css`, `workers/api/src/ui/*` and the
call sites that render the defects in C2, D1, D4, E2 and F1.
