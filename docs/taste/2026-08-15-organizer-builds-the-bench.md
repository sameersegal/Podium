# An organizer builds a speaker bench that outlives one event

**Slug** `organizer-builds-the-bench` · **Walked** 15 August 2026 · **Viewport** 1440 × 900,
one sitting · **Rating** ★★☆☆☆

---

## Who I was, and what I came to do

**Jordan Alvarez**, Programme Director for DevFlow Conf. Ten minutes between a sponsor call
and a venue call, laptop open, coffee going cold.

**In my words:** "Find the one who was great last year — someone senior, spoke at DevFlow Conf
last year about moving a platform without making the teams do the moving, company started with
a V I think — work out whether they're already in this year's pile, and get an approach started
so I don't have to remember to do it again."

**What I already knew:** my own conference, and nothing about looking a *person* up in this
product. I had only ever looked at proposals here. I did not know whether last year existed in
here at all.

**What done looked like:** the person on screen, enough of last year visible to be certain it
was them, their status this year known, and something left behind that chases itself.

**What I would have done instead:** Slack Riley, who was in the room last year and would just
know the name. Every friction point below is measured against how close it pushed me to that.
My patience was about twenty actions.

**Way in:** `/admin`.

**The answer, for the record:** **Nadia Haddad, VP Engineering, Vela.** Her 2026 talk was
*Moving a Platform Without Moving the Teams*, delivered 13 May 2026, and she has
**DFC27-0010 "Prompt Engineering Is Software Engineering" in review for 2027 right now**.

---

## The counts

| | |
|---|---|
| Distinct screens | **9** — login, admin Today, Contacts, person, proposals, 404, pipeline board, pipeline card, contacts dashboard |
| Actions | **31** |
| Navigations | **17**, of which 1 backwards and **2 by hand-editing a URL** |
| Fields entered | **10** — the same note sentence typed **three times** |
| Re-dos | **11** |
| Actions before the first useful thing | **11** (a candidate list I could act on) |
| **Actions from the vague memory to the right person** | **8** — and **6** of them if the product had not sent me to a search that cannot search |
| Facts the product already had and did not give me | **2** — that Nadia has a live 2027 proposal, on her own page; and the card owner's name, where it printed the word `assigned` |

**Did last year exist here, from my point of view?** Yes — but only once I was two screens
deep. Nothing on the dashboard, and nothing on the Contacts list, says that a previous edition
exists. It first appears as an option in a dropdown inside a collapsed disclosure.

**Was searching by half-remembered attributes possible?** Yes, and this is the best thing in
the walk. A topic word plus "last year" returned exactly one row. But the box that does it is
hidden behind a control labelled "Filters", and the box that *advertises* searching people
cannot search people.

**Is "approach this person" an act with a state, or a note I leave myself?** Both, in the wrong
order. It is a real stateful object — a card, a stage, an owner, a score, a rationale, a dated
next action, a stage history with names and timestamps. But the form for recording *today's*
approach on it silently discarded what I wrote, twice, so I ended up leaving myself a note and
then patching the state in through a different form on the same page.

---

## What confused me

Quoted from the journal as written at the time.

> **"So where *do* I search for a person?"** — screen 03. The chrome button says *Search
> proposals, people, sessions*. The dialog it opens says *Search screens and actions*, and when
> I typed my topic into it: *"Nothing here matches. This searches screens and actions, not
> proposals or people."* Six inches apart, two different promises, and the one I read first was
> the wrong one.

> **"What is my status with her, actually?"** — screen 07. Identity says **Status: Invited**.
> The event table three inches below, on the same page, says **Prospect** for 2027 and
> **Confirmed** for 2026. Three words, one screen, and no scope on the first one. I read it
> three times and still cannot tell you whether I have invited her to 2027.

> **"Is she in this year's pile?"** — screen 07. Her page lists *Sessions given* and nothing
> about proposals. I inferred "no proposal" from *Portal: None*. I was wrong.

> **"How was I ever supposed to get here?"** — screen 10, the pipeline board, reached by
> deleting a path segment from a URL that had 404'd.

> **"What is the next action on 2026-08-22?"** — screen 11. The field called *Next action*
> holds a bare date. The thing I am supposed to do lives only in my head, which is the exact
> failure this whole job exists to prevent.

> **"There is no stage that means 'I have now asked her and am waiting'"** — screen 11. The
> board runs Researching → Identified → Contacted → Interested → Confirmed (Won) → Declined
> (Lost). She is already at Interested. The only thing ahead of her is *won*.

> **"What is `crm_push`?"** — screen 07, in the Source column of my own event table.

---

## What took more than one attempt

1. **Finding a person at all.** Tried the global search first, because it says it searches
   people. It doesn't. (2 actions wasted, plus the reorientation.)
2. **Answering "is she in this year's pile".** Her person page implied no. Went to Proposals
   to be sure, and found her under review. One extra screen for a fact the person page should
   have carried.
3. **Reaching the approach in flight.** The link on her page 404'd. Guessed the parent URL by
   chopping the path. Two re-dos and a full loss of context — the 404 page has no sidebar.
4. **Recording the approach.** Typed a note, pressed Move, got *"Pipeline stage was not
   found."* and lost the note. Retyped it, selected a stage explicitly, pressed Move, got a
   green **"Moved."** — and lost the note again. Reloaded from the URL bar because I did not
   believe the green bar. Nothing had been written. Same sentence typed three times in total.

---

## What was not intuitive

- **The search that works is inside "Filters".** On the unfiltered Contacts list there is no
  text box at all, and I had already started reading the Company column with my eyes before I
  thought to open the disclosure. The placeholder inside it — *"Name, email, company or bio"* —
  is the single most useful sentence in the product for this job, and it is folded away.
- **"Dashboard" is where pipelines live.** A quiet secondary button on the Contacts list. There
  is no "Pipelines" or "Sourcing" anywhere in the sidebar. Two clicks, if you guess.
- **A note on a card requires a stage change.** The Note box sits beside "Move to stage", so
  putting a note in without moving anything is the obvious thing to try, and it is the thing
  that throws your note away.
- **The card's two forms behave differently.** `Save` works and persists. `Move` does not, and
  says it did.

---

## Leaving and coming back

Not walked. One sitting, by the scenario's design. The one thing I can report against it: the
404 page (screenshot `.walk/09-pipeline-card-404.png`) drops you out of the admin shell
entirely — no sidebar, no breadcrumb, no event — and offers the home page, "your portal" and
the dashboard. None of those is where you were, and it does not offer "back to Nadia Haddad".
If my ten minutes had ended there, coming back would have started from the directory again.

---

## Moments of care

Name these, because they are the instinct to follow.

1. **The note in my own handwriting.** On Nadia's page, dated 2026-06-16: *"Excellent on stage
   in 2026 — the platform migration talk still gets quoted. Was unavailable for 2027 in
   January; said to ask again in the autumn."* It is August. The product held the two things I
   would certainly have lost — the reason she is good, and the promise to ask again — and put
   them in front of me without being asked. This is the entire job of a bench, done well.
   (`.walk/07-person-nadia.png`)
2. **"25 people in the directory — the compounding asset a conference builds is the people it
   knows."** Somebody wrote that sentence knowing why I was there.
3. **`Sessions given`, with the talk title, the event and the year.** One glance and I was
   certain it was her. That row is what turned a half-memory into a fact.
4. **The search really does read bios.** Two half-remembered attributes — a topic word and
   "last year" — returned exactly one row. That is a five-star interaction hiding behind a
   disclosure. (`.walk/06-filtered-migration-2026.png`)
5. **Stage history with names and timestamps.** *"Researching → Interested, Jordan Alvarez,
   2026-08-09"*, and *"6 days in stage"* on the board card. This is an approach with a state,
   and it is exactly right.
6. **"Four things need you today. Ordered by what stops the event if it slips. Everything else
   is quiet."** The best dashboard sentence I have read in a conference product, with deadlines
   counted in days and the timezone named. (`.walk/02-admin-today.png`)
7. **The consent block on a speaker's profile** — *"Per-field visibility and the public listing
   are the speaker's consent, not the organizer's preference… only Nadia Haddad can change
   them, in their own portal"* — and **"Duplicates are surfaced, never merged automatically — a
   wrong merge exposes one person's proposals to another."** Both explain a restriction by
   naming who it protects. That is rare and it is worth copying everywhere.
8. **Notes are shared between the person and the card.** The note I left on her profile
   appeared on the pipeline card too. Nobody has to know which surface to write on.
9. **The command palette's empty state tells the truth** — *"This searches screens and actions,
   not proposals or people"* — even though the button that opened it did not.

---

## Findings

### F1 — "Moved." when nothing moved, and the note is gone

**Serious** · **Bug** · certain · `.walk/13-after-move-interested.png`, `.walk/12-after-move-none.png`

Pipeline card, `/admin/pipelines/cards/prc_01JQ0000Q38YPC4TJ80PE4WJA0`. I typed the note
recording today's approach, chose the stage from the dropdown, pressed **Move**, and got a
green **"Moved."** Stage history was unchanged (newest row still 2026-08-09), the Notes list did
not contain my sentence, and the note box was empty. I reloaded from the URL bar and confirmed:
nothing had been written.

**Cost:** the sentence typed twice and discarded twice, one disbelief-reload, and the moment I
stopped trusting the product. Had I closed the tab on that green bar — which is exactly what
someone with ten minutes does — I would have believed the approach was recorded and it would
not have been.

*What would have worked:* say what happened. Either write the note, or refuse with a sentence
naming what is wrong and leave my text in the box.

### F2 — The person page hides the one fact the decision turns on

**Serious** · **Taste** · certain · `.walk/07-person-nadia.png` vs `.walk/08-proposals.png`

Nadia's page shows *Across every event* (2027: Prospect, Portal: None) and *Sessions given*
(2026 only). It never mentions that she has **DFC27-0010 in review for 2027 right now**, one
review short of quorum. I read the page carefully and concluded she had not applied. She had.
I only found out by going to a different screen.

**Cost:** one extra screen, one wrong conclusion held for two minutes. In real life the cost is
emailing a speaker to invite them to submit when their submission is already under review.

*What would have worked:* a "Proposals" section beside "Sessions given".

### F3 — The link from the person to their approach is dead

**Serious** · **Bug** · certain · `.walk/09-pipeline-card-404.png`

Nadia's page, *Sourcing and segments*: **"DevFlow Conf 2028 keynotes — Interested · The platform
migration follow-up"**, as a link to
`/admin/pipelines/pip_…/cards/prc_…`. It 404s. The board's own cards link to
`/admin/pipelines/cards/prc_…` — no pipeline id — and that works. One of the two shapes is
wrong, and the wrong one is on the page where I started.

**Cost:** 2 re-dos, one hand-edited URL, and total loss of context (the 404 renders outside the
admin shell). This is the only visible thread from "the person I remembered" to "the approach
already in motion", and it is broken.

### F4 — The only global search advertises two nouns it cannot search

**Serious** · **Taste** (the copy is a bug in itself) · certain · `.walk/03-palette-migration.png`

The button in the chrome of every admin screen reads **"Search proposals, people, sessions"**.
It opens a palette whose placeholder reads **"Search screens and actions"** and which answers
any content query with *"Nothing here matches. This searches screens and actions, not proposals
or people."*

**Cost:** 2 actions and the first re-do of the walk, at the exact moment I had a vague memory
and no idea where to take it. A first-time organizer who stops there gives up and asks a
colleague, which is the failure this whole journey is about.

*What would have worked:* label the button "Go to…", or make it search the two nouns it names.

### F5 — The pipeline board has no route in the navigation

**Serious** · **Taste** · fairly sure · `.walk/10-pipeline-board.png`, `.walk/15-contacts-dashboard.png`

There is no "Pipelines" or "Sourcing" item in the sidebar. The board is reachable — Contacts →
**Dashboard** → Pipelines — but nothing on the Contacts page suggests that a button called
"Dashboard" is where the sourcing board lives, and I found the board by guessing a URL instead.
The breadcrumb then files a **2028** pipeline under **DevFlow Conf 2027**, and the sidebar
highlights "Contacts" while you are on it.

### F6 — Three different statuses for one person on one screen

**Serious** · **Taste** · certain · `.walk/07-person-nadia.png`

Identity → **Status: Invited**. Across every event → **Prospect** (2027), **Confirmed** (2026).
The first badge carries no scope, so it cannot be reconciled with either row, and "am I already
talking to her about this year" is precisely the question I came with.

### F7 — The owner tile prints a state word where a name belongs

**Sand** · **Bug** · certain · `.walk/11-pipeline-card.png`

The card's three headline tiles read **85 / score**, **assigned / owner**, **2026-08-22 / next
action**. The board two clicks away says "Score 85 · Jordan Alvarez". I stared at "assigned"
trying to work out whether it was somebody's name.

### F8 — "Next action" is a date with no action

**Sand** · **Taste** · certain · `.walk/11-pipeline-card.png`

The only forward-looking field on an approach is a bare date. What I am meant to *do* on
2026-08-29 is not recordable anywhere except in prose in a note. For a product whose promise
here is "you will not have to remember", that is the wrong shape.

### F9 — No stage means "asked, waiting"

**Sand** · **Taste** · fairly sure · `.walk/10-pipeline-board.png`

Researching → Identified → Contacted → Interested → Confirmed (**Won**) → Declined (**Lost**).
Once somebody is at Interested there is no honest way to record a fresh approach: the only move
forward asserts you have won. I recorded today's ask by editing the Rationale text instead.

### F10 — "Pipeline stage was not found" for an untouched default

**Sand** · **Taste** · certain · `.walk/12-after-move-none.png`

The stage selector's own default is "— none —". Submitting it produces an error that describes
that default as a missing thing, names no field, and offers no next step — and eats the note on
the way past.

### F11 — The page that preaches clickable numbers has one you cannot click

**Sand** · **Taste** · certain · `.walk/15-contacts-dashboard.png`

Contacts dashboard, subtitle: *"Every number here is a link into a filtered directory — a number
you cannot click is a number you cannot act on."* Of the four headline stats, **"5 returning
speakers"** is the only one that is not a link. Returning speakers is the bench. It is the one
cohort this entire journey is about.

### F12 — Schema vocabulary on screen

**Sand** · **Taste** · certain · `.walk/07-person-nadia.png`, `.walk/15-contacts-dashboard.png`

`crm_push` in the Source column of the person page; `decision` in the row below it; **"Crm
push"** as a row label in Acquisition mix; *"Custom field key"* and *"Custom field value"* in an
organizer's filter bar; `per_… or their email` as a placeholder. The probe on the person page
returned `crm_push` and `decision` as visible model vocabulary, and three unlabelled selects
(`pipeline_id`, `event_id`, `segment_id`) in *Sourcing and segments*.

### F13 — Two numbers for one pile

**Sand** · **Bug** · fairly sure · `.walk/08-proposals.png`

The sidebar badge says **Proposals 12**. The proposals page says **13 proposals** and lists 13
rows. Small, but it is the first number I see on every screen.

### F14 — "1 person in the directory"

**Sand** · **Taste** · certain · `.walk/06-filtered-migration-2026.png`

After filtering, the subtitle reads *"1 person in the directory — the compounding asset a
conference builds is the people it knows."* There are 25 in the directory; one matched. And the
matched row shows no snippet of *why* it matched, so a bio search asks to be trusted blind.

---

## The six dimensions

| | Score | The moment that decided it |
|---|---|---|
| **Orientation** | **3** | "Four things need you today", the timezone and the day-counted deadlines are as good as this gets — but nothing anywhere tells me a previous edition exists, and I found the sourcing board by editing a URL. |
| **The obvious next step** | **2** | At the one moment I had a vague memory and nowhere to put it, the product offered a search box that cannot search people, and hid the one that can inside a disclosure called "Filters". |
| **Effort** | **4** | Two half-remembered attributes, four actions, exactly one row. That is genuinely cheap, and the bio search is the reason. |
| **Forgiveness** | **1** | The same sentence typed three times, discarded twice, once under a green success message, with an error that named a field I never touched. |
| **Trust** | **1** | "Moved." when nothing moved. Everything after that I checked by reloading. |
| **Craft** | **3** | A consistent shell and some of the best copy I have read in this category, undermined by `assigned` where a name goes, `crm_push` in a column I own, 12 versus 13, and an unclickable number on the page that preaches clickable numbers. |

---

## ★★☆☆☆

**I finished, but by working around the product.** I found the right person quickly and with
real pleasure — and then the mechanism built for recording an approach refused two writes, told
me in green that one of them had succeeded, and I completed the job by leaving myself a note and
patching the state in through a different form on the same page. The sentence that decided it is
**"Moved."** over a stage history that had not changed.

It is one honest bug away from three stars and, with the search fixed, genuinely close to four.
The bench is *here* — the history, the note from June, the stage history, the scoring, the
stalled-card watch. It is one broken link and one lying success message away from being
something I would rely on.

---

## The shortest path to the next star

Three changes, in the order I hit them.

1. **Make the Move form tell the truth.** Either record the note without requiring a stage
   change, or refuse with an error that names the field and leaves my text in the box. Never
   say "Moved." when nothing moved. *(F1, F10)*
2. **Fix the pipeline link on the person page** so it uses the URL shape the board uses. The
   only thread from a person to their approach must not 404. *(F3)*
3. **Make the global search button's promise true**, or rename it to what it does. It is the
   first thing an organizer with a vague memory reaches for. *(F4)*

Item 1 alone gets the third star. Items 2 and 3 are what make this journey feel designed rather
than survived.

For the fourth star after that: put the person's current-year proposals on their person page
(F2) and give the returning-speakers number a link (F11).

---

## What I could not check

- **Two sittings.** The scenario specified one, so nothing in section E of the walk method was
  measured except what the 404 page does to your place.
- **Phone width.** Not walked; this is a between-meetings laptop job by definition. The
  Contacts table is nine columns wide and I would expect it to be the first thing to break.
- **Whether the approach actually reaches Nadia.** "Push to event" and "Start a campaign with
  these contacts" both exist and I did not press either; I do not know whether an approach
  recorded on a card ever becomes an email.
- **Whether the "Stalled cards" panel would surface my card** if 2026-08-29 passes untouched.
  It said "Nothing stalled" and I could not make time pass.
- **The deeper cuts** named in the scenario — importing a list from outside, two records for
  the same human, one message read as one voice. I saw the doors (*Merge into…*, *Start a
  campaign with these contacts*) and opened none of them.
- **Whether a second walk gives the same numbers.** One walk only. The one thing I changed in
  the world, through the product's own screens as Jordan: a note on Nadia Haddad dated
  2026-08-15, and her card's rationale and next action (now 2026-08-29).

---

## Written after the ratings, having looked at the code

*Nothing below changed any rating above, and every rating rests on what the screen did. This is
here to save whoever fixes it a bisect.*

- **F3 is one wrong URL in one template.** `workers/api/src/contexts/identity/views.ts:479`
  emits `/admin/pipelines/${pipeline_id}/cards/${id}`. The registered route, and the link the
  board itself emits (`workers/api/src/contexts/crm/views.ts:295`), is
  `/admin/pipelines/cards/:cardId` with no pipeline segment
  (`workers/api/src/contexts/crm/routes.ts:319`). The four-segment path matches nothing, so it
  404s. Only the person-page template is wrong.

- **F1 is a silent early return under an unconditional success flash.**
  `workers/api/src/contexts/crm/service.ts:638` — `if (str(card.stage_id) === toStageId) return;`
  — returns before the `prospect_stage_transition` insert that is the *only* place the note is
  persisted, and the route at `workers/api/src/contexts/crm/routes.ts:353` redirects with
  `OK("Moved.")` regardless. So a same-stage move discards the note and reports success. That is
  also why `Save` on the same page works: it posts to a different handler
  (`routes.ts:373`) that writes unconditionally. The note is only ever storable as a side
  effect of an actual transition, which is why F8 and F9 bite — there is no way to record
  "asked again, still waiting" without inventing a stage change.

- **F7 is literal.** `workers/api/src/contexts/crm/views.ts:361`:
  `stat("owner", strOrNull(c.owner_person_id) ? "assigned" : "unowned")`. The card knows the
  owner's id and prints the word "assigned"; the board template resolves the name, which is why
  the same card reads "Jordan Alvarez" one click away.

- **F13 is two deliberate definitions colliding.**
  `workers/api/src/ui/rail-counts.ts:63-64` counts proposals with `status != 'draft'` (12); the
  proposals list counts all of them (13, including the one draft). Each is defensible alone.
  Both on screen at once is not, and the file's own header comment already says a disagreement
  between it and the page it mirrors is a defect in this file.
