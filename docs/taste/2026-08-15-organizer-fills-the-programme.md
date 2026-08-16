# An organizer opens a second call, across two sittings

**Journey** `organizer-fills-the-programme` · **Walked** 15 August 2026 · **Viewport** 1440 × 900,
both sittings · **Result** finished · **★★☆☆☆**

---

## Who I was

**Jordan Alvarez**, Programme Director for DevFlow Conf. I have run this conference twice on a
hosted product costing about $18k a year; we moved to Podium this summer to stop paying that.
Laptop, kitchen table, evening.

**What I came to do**, in my words: *"Get a second call live tonight — a workshops call — so it
goes in tomorrow's newsletter, and know it's asking the right questions."*

**What I already knew:** nothing about this product's screens. I know what a CFP is. I know the
deadline is 30 March 2027 and I know the two questions I want to ask, word for word.

**What done looks like:** a URL I can paste into tomorrow's newsletter that a stranger can open
and that shows both of my questions — and confidence that nothing went public before I meant it.

**What I would have done instead:** a Google Form and a spreadsheet, taking submissions by
email. Worse, but it takes twenty minutes and I know it works.

I did not touch the existing `main` call. Everything below was arranged through the product's own
screens as Jordan.

---

## The counts

| | Sitting 1 (build it) | Sitting 2 (three days later) | Total |
|---|---|---|---|
| Screens opened | 16 loads / 11 distinct | 5 | 21 / 14 |
| Actions | 32 | 10 | **42** |
| Fields typed | 10 (9 distinct — one typed twice) | 3 (2 sign-in, 1 search) | 13 |
| Navigations | 16, **3 backwards** | 5, 0 backwards | 21 |
| Re-dos | 4 | 3 | **7** |

Three counts the scenario asked for specifically:

- **Actions before the first useful thing happened: 7.** Signing in, being put on the wrong home,
  and three navigations, before I typed the first character of my own call ("Workshops 2027",
  action 8).
- **Actions from deciding to open a call to the call being publicly reachable: 24.**
  Six of those were the two questions; the rest were navigation, one wasted click, one re-typed
  answer, and *two separate publish buttons on two different screens*.
- **Actions on the return to learn whether anything had come in: I never got a direct answer.**
  Two actions after signing in put me on a screen I could *infer* it from (the newest Submitted
  date is Aug 5, so nothing new). Six actions in, no screen in the product had told me.
- **Answers the product already had that it asked me for again: zero.** It knew my timezone and
  used it. Credit where it is due; see *Moments of care*.

---

## Did the closing date I typed appear in a timezone that is not mine?

**Yes — on the screen I would look at every day, and it moved the calendar date.**

I typed `03/30/2027, 11:59 PM` into a field labelled `Closes (America/Los_Angeles) *`, on a
screen whose subtitle read "Times are entered and shown in America/Los_Angeles".

The very next screen — the Calls for proposals list — showed my call as:

> Open Aug 15, 07:00 AM → **Mar 31, 06:59 AM**

No timezone label anywhere on that line. Both the time and the **day** are wrong for me. The
public page (correctly) says "Open — closes 30 Mar 2027, 23:59 (America/Los_Angeles)", and the
call's own Settings page (correctly) shows `03/30/2027, 11:59 PM`. So two of my three screens
agree and the third — the list I will land on every time I click "Calls for papers" — disagrees,
silently, by one day.

Screenshots: `.walk/16-cfps-list-with-workshops.png`, `.walk/17-cfp-settings.png`,
`.walk/20-public-page-signed-out.png`.

It is still wrong three days later (`.walk/23-return-cfps-list.png`), so it is not a one-off, and
the same drift shows up as "in 228 days" on the dashboard where the arithmetic says 227.

---

## What confused me

Quoted from the journal as written on the screen, before I knew the answers.

> **/portal, straight after signing in.** "Why is *this* my home? … I run this conference. The
> product's opening sentence to me is that I haven't submitted a talk, and its loudest button
> invites me to go find somebody else's call."

> **New call for proposals.** "The footnote says a four-step submission form is created *as a
> draft you can edit before publishing*. Is the **call** a draft, or only the form? The sentence
> lets me read it either way, and the difference is whether typing 'Public' up there just put
> something on the internet."

> **Form builder.** "`DRAFT` is next to the *form*. Is my **call** live right now? … I cannot
> tell from this screen whether a speaker can already reach a broken half-built form. This is the
> thing I most did not want to get wrong and the screen will not tell me."

> **Form builder, palette.** "It says 'Adding to **Review and submit**'. I want my questions on
> **The talk**. Nothing on the screen says how to change that."

> **After publishing the form version.** "Live *where*? There is no URL on this screen."

> **Public call page, while still a draft.** "Is this page live to strangers *right now*, before
> I published? Nothing on it and nothing in the admin tells me. There is no 'view as a signed-out
> visitor' anywhere."

> **Proposals, on the return.** "I have three calls and one undifferentiated list."

---

## What took more than one attempt

1. **Finding my own product.** Signing in put me on `/portal` — "You have not started a proposal
   yet", with "Find an open call" as the loudest thing on the page. The Admin link is third of
   five in the nav, small, grey, and flagged "opens in a new tab". One extra screen, one extra
   navigation. (`.walk/03-portal-after-signin.png`)
2. **Choosing which step to add a question to.** I clicked the words "The talk" — the step
   heading. Nothing happened. The way to retarget the palette is to *select an existing field
   inside the step you want*, which I found by guessing. Had I not checked, my question would have
   landed on the "Review and submit" page. (`.walk/09-field-selected.png`)
3. **Typing my three answer options.** I typed the field's label, then its options; the options
   box snapped back to "Option 1 / Option 2". I typed them again and they held.
   (`.walk/12-q2-added.png` vs `.walk/13-q2-options-retyped.png`)
4. **Signing out.** The left rail on the call's Settings page has no "Sign out". Every other
   admin screen does. I had to navigate to Today to find it.
5–7. **Asking "how is my new call going?"** Three screens and four actions on the return, and the
   product never answered it.

---

## What was not intuitive

- **"Publish this version" is not publishing the call.** After building my form I pressed the one
  blue button on the screen, got `PUBLISHED`, an amber banner, and a version pill. Reasonable
  people stop there. The call itself was still a draft, and I only discovered that because I went
  hunting for a URL to paste in the newsletter and happened to land on the call's Settings page,
  which said "Derived status: draft. Not published yet." Nothing on the form builder — not the
  banner, not the pills, not the header — mentions that a second publish exists.
- **"Public" on the call card means audience, not visibility.** The calls list showed my
  unpublished call as "Public · workshops-2027" with no draft marking of any kind. The only
  difference between a draft card and a live card on that screen is whether a grey
  "· closes in N days" suffix is present.
- **A "closes in N days" that isn't there.** Because of the above, my brand-new call was the only
  one of three without that suffix, which read as a rendering fault rather than a status.
- **The Proposals table has 22 available columns and none of them is the call.** The page's own
  subtitle says "Everything submitted to this event's **calls**". Searching the column picker for
  "call" returns "No column matches "call"." I guessed "Origin"; it renders `Cfp` and `Sponsor`,
  which is a different question and not a word.

---

## What I lost by leaving and coming back

Nothing was lost. Measured against every point:

1. **Is my work here?** Yes — call, deadline, timezone, form version, both questions.
2. **Was I told, or did I hunt?** Half. `/admin` carried a new line, "in 228 days · Workshops 2027
   closes", which told me the call exists. Nothing told me it was *open*, and nothing told me
   whether anybody had submitted.
3. **Actions to get back to where I stopped?** Three (sign-in), and the place it put me is not
   where I stopped — though `/admin` redirected to `/login?next=/admin` and then honoured it,
   which is better than the first sign-in managed.
4. **Does it tell me what is left?** It tells me what is blocking the *event*. It says nothing
   about the thing I did three days ago.
5. **Does it still know what it knew?** Yes, including the wrong date on the list, unchanged.
6. **Did anything change under me?** Nothing said so.
7. **What arrived in between?** No inbox, no activity feed, nothing.

At the moment I left mid-way — closing the laptop after publishing — the product said nothing.
Nothing was in flight, so nothing was at risk; but on the form builder, which has no save button
at all, "nothing was in flight" is a thing I had to take on faith.

---

## Moments of care

These are the reason this walk is not a one-star, and they are worth protecting.

- **The timezone, three times over.** "Times are entered and shown in America/Los_Angeles" under
  the H1, then `(America/Los_Angeles)` inside *both* date labels, and the zone on the event card
  in the rail. On the one screen where a mistake costs a weekend of email.
  (`.walk/06-new-call.png`)
- **"Workshops 2027 — what the public sees."** A preview that names what it is hiding and why:
  "committee-only, organizer-only and personal-data fields are absent. Conditional fields appear
  and disappear as you change the answers." I could see a speaker's view without becoming one,
  and it was *better* than the real thing because it explained itself. (`.walk/14-form-preview.png`)
- **A whole sensible form, made for me.** Four steps, nine fields, real help text, without my
  being asked a single question. I did not have to invent "Abstract".
- **"This version is live. You can rearrange it and reword it in place — anything structural needs
  a new draft version."** The best explanation of form versioning I have read, arriving at the
  moment it mattered. (`.walk/15-form-published.png`)
- **Per-field disclosure, on the row.** `ORGANIZER ONLY` / `COMMITTEE ONLY` chips, "Only the
  organizing team sees these answers", and — the sentence that told me somebody has run a review
  round — "This answer names its speaker … Hidden from reviewers in a double-blind round. Set this
  on a bio or an employer question."
- **The Public link panel.** Full URL in a box, a Copy button, "Open the public page", and "works
  for anyone, with no account, in every status including closed."
- **"Ordered by what stops the event if it slips. Everything else is quiet."** I trusted the order
  of the dashboard because it told me the rule.
- **Small ones that add up:** "Derived from the name if blank" on the slug; "Must be after it
  opens" written *before* I could get it wrong; "Blank means unlimited"; "Lets in-flight
  submissions land after the bell"; every format and track pre-ticked; "One per line. The stored
  value is derived from the label."
- **The public page's deadline sentence:** "Open — closes 30 Mar 2027, 23:59
  (America/Los_Angeles)." State, date, time and zone in nine words.

---

## Findings

### 1 · The calls list shows my deadline on the wrong day, unlabelled
**Serious · Bug · certain**
Calls for proposals, `/admin/events/{id}/cfps`, 1440 × 900, `.walk/16-cfps-list-with-workshops.png`.
I had just typed a closing time into a field labelled `America/Los_Angeles`. The card rendered
"Open Aug 15, 07:00 AM → **Mar 31**, 06:59 AM" with no zone on it. Cost: I stopped, re-read three
screens, and had to decide which of my product's own screens to believe. Failure mode: a wrong
deadline in a newsletter that cannot be taken back.
*What would have worked:* the same string the public page already produces.

### 2 · Publishing the form is not publishing the call, and nothing says so
**Serious · Taste · certain**
Form builder, `/admin/cfps/{id}/form`, `.walk/15-form-published.png`.
One blue button, a `PUBLISHED` pill and a confident banner. The call was still a draft. I found
out only because I went looking for a URL. Cost: 3 extra screens, and in the version of this
evening where I don't go looking, a newsletter pointing at an unpublished call.
*What would have worked:* one line under the banner — "The call itself is still a draft. Publish
it →".

### 3 · Nothing on the calls list distinguishes a draft call from a live one
**Serious · Taste · certain**
`.walk/16-cfps-list-with-workshops.png` (draft) vs `.walk/23-return-cfps-list.png` (open). Both
cards say "Public · workshops-2027". The only difference is a grey "· closes in 228 days" suffix.
"Public" there means audience. Cost: I could not answer "did anything go public before I meant
it?" from the screen that lists everything that could.

### 4 · The field settings panel discarded an answer I had typed, on a screen with no Save
**Serious · Bug · fairly sure**
Form builder, `.walk/12-q2-added.png`.
I typed a field's label, then its three options; the options reverted to the defaults. Retyping
them alone worked. Cost: one answer typed twice, and — worse — the end of my trust in a screen
that has no save button, no saved indicator and no undo. *Caveat:* I typed the two fields
back-to-back faster than a person would; a slow typist may never hit it. I am reporting it because
a builder that silently drops a field while you are filling it in is precisely how a call ships
asking the wrong question, and the screen offers nothing to check against.

### 5 · The public call page — the thing the whole job produces — is a 416px column on a 1440px screen
**Serious · Taste · certain**
`/e/devflow-conf-2027/cfp/workshops-2027`, `.walk/20-public-page-signed-out.png`. Measured: `main`
is 416px wide inside a 1440px viewport; the page is 2946px tall; the only button on it, "Start a
submission", sits at 2801px. My intro wraps after six words; the Title placeholder is clipped
mid-sentence. The seeded `main` call is identical (`.walk/28-main-cfp-1440.png`), so this is the
template, not my call. Cost: the artifact I am about to put in front of several thousand people
looks unfinished next to an admin console that is beautiful.

### 6 · The product cannot tell me how a call is doing
**Serious · Taste · certain**
Today, Calls, Proposals — `.walk/22-return-admin-today.png`, `.walk/23-return-cfps-list.png`,
`.walk/24-return-proposals.png`, `.walk/26-columns-search-call.png`.
No submission count on any call card. No call column, filter or grouping on Proposals — the column
picker answers "No column matches "call"." Cost: on the return sitting, the first question in my
head had no answer anywhere; I worked it out by reading dates off thirteen rows.

### 7 · There is no way to choose which step a new field goes into
**Sand · Taste · certain**
`.walk/09-field-selected.png`. The palette says "Adding to *X*"; the only way to change *X* is to
click an existing field inside the step you want. Clicking the step heading does nothing. A step
with no fields in it cannot be targeted at all. Cost: one wasted click and a cold moment.

### 8 · The maker's vocabulary on the organizer's screen
**Sand · Taste · certain**
- `(INV-02-7)` printed in the "Becomes" help text, next to "first-class column on the proposal"
  (`.walk/09-field-selected.png`) — an invariant number from the specification, on a conference
  organizer's screen.
- "**Derived status:** draft. Not published yet." as the lead sentence under a page title
  (`.walk/17-cfp-settings.png`).
- "`allow_with_flag` marks the proposal late for the committee", under a dropdown whose options
  are "Reject" and "Allow with flag".
- Every field row prints its machine key — `speakers`, `abstract`, `av_requirements`,
  `recording_consent`, `coi_disclosure` — then `→ AV REQUIREMENTS` in caps. Three vocabularies on
  one row, and the arrow is never explained.
- "A four-step submission form is created with the call — `your-details` → `the-talk` →
  `logistics` → `review-and-submit`" (`.walk/06-new-call.png`): four URL slugs in monospace, in the
  only sentence that tells me a form exists.
- `Cfp` as a cell value in the Origin column.

### 9 · Signing in as the organizer lands on the speaker portal
**Sand · Taste · certain**
`.walk/03-portal-after-signin.png`. "You have not started a proposal yet" and a big black "Find an
open call" for the person who runs the conference. Cost: one screen, one navigation, and three
seconds of thinking I had signed in as the wrong person. Notably, sitting 2's
`/login?next=/admin` got this exactly right — the machinery is already there.

### 10 · "Sign out" is missing from the rail on the call Settings page
**Sand · Bug · certain**
`.walk/17-cfp-settings.png` (rail ends at "Jordan Alvarez ↗") vs
`.walk/16-cfps-list-with-workshops.png` (rail ends "Jordan Alvarez ↗ / Sign out"). Cost: one extra
navigation, and a small loss of faith in the furniture.

### 11 · Two different counts for the same thing, six inches apart
**Sand · Bug · certain**
`.walk/24-return-proposals.png`. The rail badge says "Proposals **12**"; the page header says
"**13** proposals" and lists thirteen rows.

### 12 · Good news in an alarm colour
**Sand · Taste · fairly sure**
`.walk/20-public-page-signed-out.png`. "Open — closes 30 Mar 2027…" sits in a pink/rose panel. The
only other pink I met all evening was the blocking schedule conflict on Today.

### 13 · No confirmation before publishing to the public; no "forgot password"
**Sand · Taste · certain**
Both publishes are one click with no dialog. "Call published." is a good acknowledgement *after*
the fact, but the button that replaces it — "Close now" — sits in the same place my eye now goes
and does not say what closing does or whether it can be undone. Separately, `/login`
(`.walk/02-login.png`) has no password-recovery link at all; if I had forgotten mine tonight, the
newsletter goes out without a call.

---

## The six dimensions

| | | |
|---|---|---|
| **Orientation** | ★★★☆☆ | The console tells me the event, its timezone, how many days out and the rule it sorts by — and then never tells me that publishing a form is not publishing a call. |
| **The obvious next step** | ★★★☆☆ | "New call" and "Create call" are unmissable and correct; "Publish this version" is unmissable and *not the one I needed*. |
| **Effort** | ★★★★☆ | A complete four-step form, every format and track pre-ticked, a derived slug, one click per question. It asked me for nothing it already had. |
| **Forgiveness** | ★★☆☆☆ | A form builder with no Save, no saved state and no undo, that reverted an answer I had typed. |
| **Trust** | ★★☆☆☆ | Two screens give two different closing days for the same call; one screen says "Public" while another says "not published yet"; the rail says 12 and the page says 13. |
| **Craft** | ★★★☆☆ | The admin console is handsome and its copy is often excellent; the public page it produces is a phone-width strip on a laptop, and `INV-02-7`, "Derived status" and `Cfp` are on screen. |

---

## ★★☆☆☆

**I finished by working around the product.** I pressed the only publish button on the screen,
believed I was live, and was saved from a newsletter pointing at an unpublished call only because
I went hunting for a URL — and the screen I will open every morning still tells me my call closes
on the wrong day.

Rated for `organizer-fills-the-programme` at 1440 × 900, two sittings. I have deliberately not
inflated this: the two-question job itself was a genuine pleasure, and the preview screen is the
best thing I saw all evening. But this is the one screen in the product with a deadline set by
somebody else's calendar, and it printed the deadline wrong.

---

## The shortest path to the next star

Two changes are load-bearing. The third is what I would do next.

1. **Print the deadline in the event's timezone on the calls list, or label the zone it is
   using.** This is the one that can put a wrong date in a newsletter, and the correct string
   already exists on two other screens.
2. **Say, on the form builder, that the call itself is still a draft — and put "Publish call"
   there.** A single line under the "This version is live" banner would do it. While you are
   there, mark draft calls as draft on the calls list, so "did anything go public before I meant
   it" is answerable from the screen that lists everything that could.
3. **Give the field settings panel a save state**, and stop it discarding an edit that is still
   in flight.

Doing 1 and 2 takes this to three stars honestly. Doing 3 as well, plus a submission count on each
call card, would make it four — most of the four-star product is already built.

---

## What I could not check

- **Whether a stranger could reach my call's public page while it was still a draft.** By the time
  I could sign out I had already published, and the product offers no "view as a signed-out
  visitor", so there was no way to check it *before* publishing either. This is the single
  question I most wanted answered and could not answer from any screen.
- **Whether anything actually arrived at the new call.** Nothing did in three days against this
  seed, so I measured the *reporting* of zero rather than the reporting of arrivals.
- **Phone width.** This journey is a laptop journey and the scenario fixed both sittings at
  1440 × 900. I did not walk the admin console at 390px. I did confirm the public call page at
  1440 and it is the same 416px column as the seeded `main` call, so the finding is about the
  template rather than about my call.
- **Email.** "Send the submitter a confirmation" was ticked by default; I never saw what it sends.
- **Editing a call that already has submissions against it**, which the scenario reserves as a
  deeper cut and which I was told not to attempt on the live `main` call.

---

## After breaking character — what the code says

Written after the ratings above were fixed. Nothing here changed a rating.

**Finding 1 (wrong day on the calls list).** `public/console/views/tables.js:183` calls
`formatDateTime(c.opens_at)` and `formatDateTime(c.closes_at)` **without the event timezone**.
`public/console/ui.js:62` declares `formatDateTime(iso, timezone)` and falls back to
`timeZone: undefined`, which is the *browser's* zone. So the finding is sharper than "it shows
UTC": the calls list renders every call's window in whatever zone the organizer's laptop happens
to be in, unlabelled, while the public page and the call's Settings form both render the event's
zone. It is correct on a machine set to `America/Los_Angeles` and wrong for a travelling
organizer, a co-organizer abroad, or any browser running in UTC — which is why it ships. The same
call appears at `tables.js:330` for review rounds. `relativeDays()` at `ui.js:76` is
timezone-free, which is what produces "in 228 days" where the calendar says 227.

**Finding 10 (missing Sign out).** The client console adds its own sign-out button
(`public/console/app.js:446`). The server-rendered console shell's rail footer
(`workers/api/src/ui/layout.ts:283`) renders a list of `railLink`s only — links, no logout form —
so the control is present on every screen the client console owns and absent on the
server-rendered ones like the CFP detail page. The `editorialShell` used by the portal and public
pages does have one (`layout.ts:431`). Three shells, two of which sign you out.

**Finding 6 (no call column).** `public/console/views/proposals.js` defines 22 columns; none of
them is the call. The gap is real rather than something I failed to find.

**Not run:** I did not commit or push. The environment for this walk asked me not to run `git`.
