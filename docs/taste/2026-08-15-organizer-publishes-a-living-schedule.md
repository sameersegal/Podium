# An organizer publishes a schedule that survives contact with reality

**Journey** `organizer-publishes-a-living-schedule` · walked 15 August 2026 · ★☆☆☆☆

**Sitting 1** — 1440 × 900, one long session: build the grid and put it up.
**Sitting 2** — 390 × 844, same device, after `browser_close`: a speaker cancels.

Evidence in `.walk/`. Journal kept per screen as I went.

---

## Who I was

**Jordan Alvarez**, Programme Director for DevFlow Conf 2027. Three conferences behind me,
all of them run out of a Google Sheet with one tab per room and conditional formatting to catch
double-bookings. First sitting at a desk on a laptop with coffee. Second sitting in a taxi, on
a phone, days out, under stress.

**What I came to do, in my words.** "Get everything into a room and a time, put it up, and keep
it honest when things move."

**What I already knew.** Nothing about this product. I know what a grid is and what a clash is,
and I know that the moment I publish something wrong it is on Twitter.

**Done, from my side.** A grid I can see all at once with nothing left unplaced, no conflict the
product is still complaining about, and the public page showing it — and the ability to *check*
that myself, because I do not trust a machine with the grid until I have seen it.

**What I would have done instead.** Gone back to the spreadsheet. I still have last year's.

---

## The counts

| | |
|---|---|
| Screens opened | **23 loads, ~18 distinct** (13 in sitting 1, 10 in sitting 2) |
| Actions | **~54** (32 laptop, 22 phone) |
| Fields typed | **8** — email ×2, password ×2, two acknowledgement reasons, a publish note, a cancellation reason |
| …of which the product already had | **4** (both sign-ins; it knows exactly one organizer signed in from this browser last week) |
| Navigations backwards | 3 |
| Re-dos | **13** |
| Actions before I could see the schedule at all | **4** |
| Actions before the first change that advanced the job landed | **18** |
| Actions from reading the cancellation email to "Session cancelled." | **6** (9 counting the re-login) |
| Actions after that, spent failing to learn whether anyone was told | **9**, ending in a dead end |

**The numbers the scenario asked for, before and after:**

| | Before sitting 1 | After sitting 1 |
|---|---|---|
| Talks the product reports unplaced | 0 | 0 |
| Clashes the product reports | **2** | **0** |
| Sessions actually blocked from publication | 2 | **2** |
| Sessions visible on the public schedule | 6 of 10 | **6 of 10** |
| Days of the conference publicly empty | **2 of 3** | **2 of 3** |

Both clashes pre-existed and were reported the moment I arrived, which is the right behaviour —
I caused none, so I cannot report on whether a clash announces itself at the moment it is caused.
Neither clash was a clash: both were "a speaker has not finished their onboarding tasks".

---

## What confused me

Quoted from the journal, written at the time.

> "Four things need you today" but I count two rows. It means 2+2. I read the heading twice.

> **Neither "conflict" is a conflict.** Both say a talk "has N blocking onboarding tasks
> outstanding". Nothing is double-booked. But the dashboard called this "Placements conflict",
> the panel calls it "unresolved conflicts", and the badge says UNPUBLISHABLE. Three names for
> one thing, and the one I was given on the dashboard was wrong.

> The only button is **Acknowledge**. Acknowledge what — that the task is outstanding, or that I
> do not care? Does it fix anything? Does it publish something that is not ready?

> The blocking tasks are due **in 210 days** and **in 225 days**. They are not late — "0 overdue"
> says so on the same screen. And yet they are blocking my schedule from going out *today*, 269
> days before the event.

> **What is that 15:00 box?** … On a grid, an unnamed card is a hole.

> **My agenda says 10 placed. This says the live version has 6, and that the two match.** Both of
> those cannot be true, and the one thing I came here to do is a dead button.

> Two days of my conference are publicly blank and the tool has no opinion about that. Not a
> warning, not a badge, not "2 days have nothing published".

> "Placement: Room 2B · **2027-05-13 22:00**". The grid drew this card at **15:00**. If I read
> this page and told the speaker to be there at 22:00 I would have wrecked their talk.

> **Was anybody told?** Nothing on this screen, before or after, mentions the speaker, the
> co-speaker, the room, or the attendees. I pressed the button and the product said one word.

---

## What took more than one attempt

1. **The "Suggest placements" toast, twice.** Pressed the button; a green toast appeared in the
   bottom-right corner (diagonally opposite the button, top-right) saying "Placements suggested.
   Review the rationale before accepting them." with a **Review** link. Reached for the link —
   gone. Pressed again, reached again — gone. Third press, went straight for it and caught it.
   The only door to the rationale is a link that dismisses itself on a timer. *(2 re-dos)*
2. **Clicking the conflict message.** It names a talk and a problem; it is dead text. *(1 re-do)*
3. **Hovering the nameless 15:00 card** expecting a tooltip. Nothing. *(1 re-do)*
4. **Reconciling "10 placed" with "6 sessions" on the Publish page** — read the banner and the
   version row three times, could not, and had to open four more screens to find out. *(re-dos on
   S1-13, S1-14/15, S1-18)*
5. **Finding a working Publish button** — the one I was sent to is disabled; the one that works is
   on `?nojs=1`. *(1 re-do)*
6. **Re-reading "Four things need you today"** to work out where "four" came from. *(1 re-do)*

---

## What was not intuitive

- **I expected a conflict to be a collision.** The product uses "conflict" for "this speaker owes
  me a headshot". Reasonable engineering; wrong word for the person reading it. I spent two
  re-reads deciding nothing was double-booked.
- **I expected "Acknowledge" to unblock publication**, because the dashboard told me "A blocking
  conflict refuses publication, so the schedule cannot go out while one is open." It removes the
  warning and changes nothing else. The session detail page still says "3 blocking tasks"
  (`.walk/22`). I resolved two conflicts and resolved nothing.
- **I expected "0 sessions unplaced" and "Agenda 10/10" to mean I was done.** They mean every
  *confirmed* session has a room and a time. Four of my ten are invisible to the public, and no
  counter anywhere subtracts them.
- **I expected the primary button on the Publish screen to be pressable**, or, if not, to tell
  me why. It is disabled and silent; the green banner beside it reads as good news.
- **I expected clicking "Review" in a toast to show me the suggestions.** It changed the shape of
  the page, put `?nojs=1` in my address bar, reset me to Day 1, and showed no suggestions.
- **I expected the cancellation confirmation to describe consequences.** It described its own
  bookkeeping: "Cancellation is audited with a reason."

---

## What I lost by leaving and coming back

Measured against the seven checks, in order, before anything else.

1. **Is my work here?** Yes. v2 published, conflicts acknowledged, nothing lost. Good.
2. **Do I know it is here without hunting?** Only by inference — "Two things need you today" is
   two fewer than last time and I have to remember that. Nothing says "you published v2". The
   version number lives in the left rail, which on a phone is behind a hamburger.
3. **Actions back to where I stopped?** Three (menu → Sessions → the row). Target is one.
4. **Does it tell me what is left?** It tells me two speakers have not confirmed. It does not tell
   me four of my ten sessions are invisible to the public, which is what is actually left.
5. **Does it still know what it knew?** Yes — event, timezone, days-out, all five deadlines.
6. **Did anything change under me?** Not that I could see, and it does not claim either way.
7. **What arrived in between?** Nothing. There is no inbox, no activity feed, no "since you were
   last here". The cancellation reached me by **email**, and the product has no idea it happened.

And the interruption itself: **my session did not survive closing the browser.** Same device,
same profile. I re-typed `organizer@devflowconf.example` and a password with a `!` in it on a
phone keyboard in a moving car — two fields the product already had.

---

## Moments of care

These are real and worth naming, because several of them are the best work in the product.

- **The Today dashboard** (`.walk/02`). "Four things need you today · Ordered by what stops the
  event if it slips. Everything else is quiet." It told me what was wrong before I asked, and the
  sentence "A blocking conflict refuses publication, so the schedule cannot go out while one is
  open" answered the exact question I would have asked next. This is the best-designed screen I
  saw.
- **The Onboarding page** (`.walk/07`). "What every speaker still owes, and which of it stops a
  session being published." Four counters, four blocking rows itemised in speaker language
  ("Sign the speaker agreement", "Confirm recording consent"), the person who owes each one, and
  a **Remind** button on the row. It answered in one screen a question five other screens had
  been vague about.
- **"Suggest placements" did not silently rearrange my grid.** It proposed and asked me to review
  the rationale first. That is exactly the right instinct for a machine touching the artefact my
  attendees bought. The execution loses it (see findings), but the instinct is right and should
  be kept.
- **Both destructive-ish actions ask *why*.** "Why is this conflict acceptable? It stays visible,
  and it goes on the record." and "Cancellation is audited with a reason." Being asked to justify
  makes me the accountable one rather than the button. The first of those two sentences is the
  best-written thing in the product.
- **Version history with rollback** (`.walk/20`). v2 LIVE with the note I wrote, v1 SUPERSEDED
  with a "Roll back to this" button. Clear, and it did what it said.
- **The publish Note placeholder**: *"Added two lightning talks, moved the keynote"*. Somebody
  imagined a real organizer typing a real thing.
- **The public schedule** (`.walk/16`, `.walk/33`). "All times America/Los_Angeles. Star a session
  to build your own day — it stays in this browser." Abstracts, tracks, rooms, per-day filters,
  "6 of 6 sessions", an ICS feed, and a dated footer — and it is *better* on the phone than on the
  laptop. If the data behind it were right this would be the best screen in the product.
- **The phone dashboard and the cancel affordance** (`.walk/25`, `.walk/28`). Cards stack, the
  funnel becomes a 3×2 grid, nothing overflows, and the red **Cancel** sits in the first
  screenful of the session page with no scrolling. On the day something goes wrong, that is
  exactly where it should be.
- **The Sessions screen counters** (`.walk/21`). Four numbers that finally explained everything.
  The problem is not this screen; it is that nothing sends you here.

---

## Findings

### FATAL — The public schedule was missing four of my ten sessions, and the product told me they matched

**Where** Publish, `/admin/events/<evt>/publications`, 1440 × 900 — `.walk/14-publish.png`,
`.walk/20-after-publish.png`; public schedule `.walk/16`, `.walk/17-public-schedule-day1-empty.png`;
Sessions `.walk/21-sessions.png`.

**What I was doing** Putting the programme up so marketing can sell on it.

**What I expected** My ten placed things on the public page, minus at most the two I had just
acknowledged.

**What happened** The public page shows **6 of 6 sessions**, all on Day 2. Day 1 says "Nothing is
scheduled on this day yet" — while my grid shows a two-hour workshop there. Day 3 is publicly
empty too. Four sessions are missing: *Serving Large Models on a Small Budget*, *Measuring
Developer Productivity Without Making Everyone Miserable*, *Your Kubernetes Estate Should Be
Boring*, *How We Cut Cold Starts to 40ms*. The admin Publish page says, in a green banner,
"**The public schedule matches the working copy.**" and "Publish now" is `disabled`.

The reason exists and is defensible — two sessions are `Pending confirmation` and two are
`Scheduled` rather than `Published` — but it is stated on exactly one screen (`Sessions`) that
nothing in the publishing flow links to, and in a vocabulary (`Scheduled` vs `Published`) that no
other screen uses. The Agenda badge says **10/10**. The dashboard says **10 On the schedule** and
**8 Confirmed sessions** (the Sessions screen says **0 Confirmed**).

**What it cost** Four extra screens opened purely to find out, 3 re-dos, and — the part that
matters — an organizer who closes the laptop believing the programme is up. Two-thirds of the
conference is publicly blank and every counter in the product is green.

**Bug or taste** Both. The disabled/enabled split is a bug (below). The green "matches" banner over
a 40 % discrepancy is a taste failure of the most expensive kind: the product asserts a thing that
is false in the only sense the user means it.

**How sure** Certain about the facts, high confidence about the cause. I verified the six public
sessions by hand against the ten on the grid and against the Sessions status chips.

**What would have worked** The Publish screen naming what is in the snapshot and what is not, and
why: "6 of 10 sessions will be public. 2 are waiting on speaker confirmation, 2 have blocking
onboarding tasks." Plus the Agenda counter counting publishable, not placed.

---

### SERIOUS — There are two different Agenda screens and two different Publish screens, and the one with the working button is the one you reach by accident

**Where** `/admin/events/<evt>/schedule` vs `?nojs=1` — `.walk/03`, `.walk/10-suggestions-review-nojs.png`;
`/admin/events/<evt>/publications` vs `?nojs=1` — `.walk/14`, `.walk/18-publish-nojs.png`.

**What I was doing** Following the "Review" link in the product's own toast.

**What happened** The page changed shape: different subhead, different layout, extra columns, an
"Assisted placement" panel, a *Strategy* dropdown, and `?nojs=1` in my address bar. It also reset
me to Day 1. Later, on the Publish screen, the "Publish now" button is `disabled` on the default
page and **live** on the `?nojs=1` one. I only published at all because the product had leaked me
that URL flag earlier.

The two versions also disagree in copy and in data:

| | default | `?nojs=1` |
|---|---|---|
| conflicts called | "2 unresolved conflicts" | "**Blocked from publication**", severity Error |
| Acknowledge is | a native browser `prompt()` box | an inline "Why is this acceptable" popover |
| v1 published at | "Aug 15, **08:19 PM**" | "15 Aug 2026, **13:19**" |
| version table has | Version, Status, Published, Sessions, Note | …plus **ETAG** `"28e5aaf1476250b339f8dda8a79fc99d"` |

**What it cost** 1 re-do, total disorientation ("if two screens with the same title show different
controls, which one is the schedule?"), and — for a real organizer who cannot type `?nojs=1` —
no publish at all when the button is dead.

**Bug or taste** Bug (the button state disagreeing between two renderings of the same route; a
user-facing link pointing at an internal query flag). The copy divergence is taste.

**How sure** Certain. I measured `button.disabled === true` on one and pressed the other.

**Honesty note.** I typed `?nojs=1` myself, having seen the product put it in my address bar. A
real organizer would not have. Everything I found after that point was found by somebody who knew
a trick, and the publish step is marked as one its intended user could not complete.

---

### SERIOUS — "Acknowledge" removes the warning and does not remove the block

**Where** Agenda conflicts panel and session detail — `.walk/13-after-acknowledge-2.png`,
`.walk/22-session-detail-k8s.png`.

**What I expected** The dashboard says "A blocking conflict refuses publication, so the schedule
cannot go out while one is open." So acknowledging should open the door.

**What happened** The conflicts panel emptied — vanished entirely, no "0 conflicts", no
"acknowledged by you today". The session detail still reads "**3 blocking tasks**", the session is
still `Scheduled` not `Published`, and the public page is unchanged after republishing. I removed
my own ability to see a problem that still exists.

Worse, the prompt promised: "It **stays visible**, and it goes on the record." It did neither —
the row disappeared, and the reasons I typed are not on the Agenda, the Publish page, the Sessions
page, or the session's Revision history.

**What it cost** The two acknowledgements were the only work I did in sitting 1 that felt like
progress, and they bought nothing. Plus a permanent loss of trust in the conflicts panel.

**Bug or taste** Taste, with a bug inside it (the "stays visible" claim is false).

**How sure** Certain about the facts. Less sure whether "acknowledge" was ever meant to unblock —
but the dashboard's own sentence is what set that expectation, so the screens are inconsistent
with each other either way.

---

### SERIOUS — On a phone, I could not tell anybody the talk was cancelled. This is where sitting 2 stopped.

**Where** Messaging → Campaigns → Compose, 390 × 844 — `.walk/35-phone-messaging.png`,
`.walk/37-phone-compose.png`.

**What I was doing** Making sure nobody turns up to an empty room.

**What happened** The cancellation itself was fast and clean (6 actions, clear confirmation). Then
nothing. No screen mentions notifying the speaker, the co-speaker, or anyone who starred the talk.
The session's **Revision history still shows one row, "#1 Decision import, 2026-08-11"** — my
cancellation, with its audited reason, is not in it. Messaging leads to a page titled "Campaigns"
(the nav calls it Messaging) reading "No campaigns yet"; its subhead mentions "the outbox" and
nothing links to an outbox.

Compose, on a phone, is: Internal name, Channel, Template, Subject, **Body (markdown)**, and an
audience of "Event roster" filtered by "**Roster status (event_participants only)**". The only
button is **Save as draft**. There is no send, and there is no audience meaning "the people
affected by this cancellation".

**Stop rule hit here.** Get to a laptop — and even then, hand-write a markdown email to the whole
roster and hope.

**What it cost** 9 actions after the cancellation, ending in a dead end, and no answer at all to
"were the people affected told?"

**Bug or taste** Taste. Everything works as built.

**How sure** High. I may have missed an outbox screen; the copy implies one exists and nothing
links to it, which is itself the finding.

---

### SERIOUS — A talk on the grid with no name on it, and the delete button under its warning icon

**Where** Agenda Day 2, Room 2B 15:00 — `.walk/04-agenda-day2.png`, `.walk/05-agenda-day2-nameless-card.png`.

**What happened** *Your Kubernetes Estate Should Be Boring* is a 10-minute lightning talk. Its card
is a pink sliver showing "15:00" and a red warning triangle and **nothing else** — no title, no
speaker. The screen-reader label has the title; the pixels do not. Hovering gives no tooltip. And
the card's "remove from the schedule" **×** sits on the same pixels as the warning triangle, so
the one card I most wanted to inspect had a delete control hiding under its only affordance.

**What it cost** 1 re-do and a refusal to click. On a grid, an unnamed card is a hole.

**Bug or taste** Taste, tipping into bug at the overlapping controls.

**How sure** Certain — I looked at the image.

---

### SAND — I cannot see my conference

Three day tabs, one day each. To learn that my programme is 1 talk / 6 talks / 1 talk I loaded
three views and held two of them in my head. Nothing says "Day 3 has 1 session"; I counted boxes.
`.walk/03`, `.walk/04`, `.walk/06`. My spreadsheet showed all three at once, which is the reason I
have a spreadsheet.

On a phone this gets worse: the grid shows **two of four rooms** (696 px of columns in a 356 px
card), so **Day 1 looks completely empty** because its only session is in Workshop Lab, off-screen,
with nothing to indicate more rooms exist. `.walk/31-phone-agenda.png`.

### SAND — Session titles are clipped mid-word, everywhere

"The Build Cache Is Not Your Proble[m]", "Type-Checking a Million Lines in Under a Secon[d]",
"Platform Engineering Without the Platform Tea[m]", "How We Cut Cold Starts to 40ms" sliced through
the letters. At 1440 wide, in columns with vertical room to spare. No ellipsis, just a cut.
`.walk/04`, `.walk/06`, `.walk/32`.

### SAND — Two clocks for the same moment

The grid draws the Kubernetes talk at **15:00**. Its own session page says "Placement: Room 2B ·
**2027-05-13 22:00**". v1 was published at "Aug 15, 08:19 PM" on one screen and "15 Aug 2026,
13:19" on another. One is UTC, one is the event timezone, and nothing labels which.
`.walk/04`, `.walk/22`, `.walk/14`, `.walk/18`.

### SAND — "Remind" sends an email and says nothing

Pressed Remind on the 3-days-due blocking task. No toast, no state change, no "last reminded".
The network shows `POST /v1/tasks/<id>/remind → 200` and a list refetch; the screen shows nothing.
I nearly pressed it again, which is how a speaker gets two identical nags. The product has toasts
— it used one for "Placements suggested" three minutes later. `.walk/08`.

### SAND — The maker's vocabulary, collected

- **ETAG** `"28e5aaf1476250b339f8dda8a79fc99d"` as a column in the version table (`.walk/18`).
- The "6 changes" panel is a database dump: "Session added — `ses_01JQ0000ADPM42JG0YECWTA8RP` / now:
  title: …, **starts_at**: 2027-05-13T18:00:00.000Z" — internal ids, a column name, UTC ISO
  timestamps, and it runs off the right edge so the sentences are cut (`.walk/19`).
- "Roster status (**event_participants** only)" on the Compose screen (`.walk/37`).
- Strategy: "**Greedy fill**" — a computer-science term, next to two conference words ("Balance
  tracks", "Respect preferences"). I would not press a button called Greedy on my programme.
- "Asset id * — Uploaded through the Files tool first": a text box asking a human to type an id.
- Campaign templates offered as "invitation.sent", "propo…".
- `DFC27-0005 · **Cfp**`.
- "immutable snapshot" / "working copy" / "Conflicts are computed on every write" — version-control
  and engine vocabulary. I understood it, but only because I have used git.

### SAND — Layout falls over when the Acknowledge popover opens

Opening the reason popover on the `?nojs=1` conflicts table collapses the whole table into one word
per line ("Blocked / from / publication", "Your / Kubernetes / Estate / Should Be / Boring"), and the
popover itself overflows: the reason field spans x=1149→1475 in a 1440-wide window with no
horizontal scroll to reach the missing 35 px. `.walk/11-acknowledge-form.png`.

### SAND — Duplicate `f_reason` ids, twice

Both conflict rows' reason inputs share `id="f_reason"`; on the session page the *cancel session*
reason and the *speaker attendance override* reason share it too. On a page where one box means
"Kubernetes" and the other means "Cold Starts", that is a wrong-row away from an untrue record, and
it makes the visible "Reason *" label ambiguous.

### SAND — The rationale you are told to review expires on a timer

The only route to the placement suggestions is a **Review** link inside an auto-dismissing toast,
positioned in the bottom-right corner while the button that summoned it is top-right. I lost it
twice. And when I finally caught it, it led to a page with no suggestions and no rationale on it.
`.walk/09`, `.walk/10`.

### SAND — A native `prompt()` in the middle of a designed console

"Acknowledge" on the default Agenda opens the grey OS dialog. The sentence inside it is the best in
the product; the box is a raw browser primitive three seconds after a carefully made popover did the
same job on the other screen.

### SAND — The confirmation screen was stale

Immediately after cancelling, the chips read "33% onboarding / 3 blocking tasks" (`.walk/30`). On a
fresh load they read "100% / 0" (`.walk/36`). The screen I was shown at the moment of the action was
out of date about the action I had just taken.

### SAND — A cancelled session is still fully editable

Tom Bianchi is still listed **Confirmed**; "Add speaker", "Attach", "Link" and "Save content" are all
live; Placement reads "Not placed on the schedule **yet**", which invites me to place a talk that is
not happening. `.walk/36`.

### SAND — "Four things need you today", two rows

The heading sums the badges (2 + 2). I read it twice. `.walk/02`.

### SAND — Nine session-list rows on a phone are a column of confetti

The Sessions table is 661 px wide inside a 356 px card. The title column is squeezed to a few words
per line and CONTENT is sliced through "APPROVED". And **the search box that sits in the header of
every desktop screen is not rendered at 390 px** — on the device where typing a name would beat
scrolling a table, search is the thing that got dropped. `.walk/27`.

---

## The six dimensions

| | | |
|---|---|---|
| **Orientation** | ★★☆☆☆ | The Today dashboard is the best orientation I have seen in this kind of tool — and then "Agenda 10/10", "0 unplaced" and a green "everything matches" all told me I was finished while two-thirds of my conference was publicly blank. |
| **The obvious next step** | ★★☆☆☆ | One clear primary action on the dashboard ("Publish schedule"), which leads to a screen where the primary action is greyed out with no reason given and the working one is on a URL I found by accident. |
| **Effort** | ★★★☆☆ | The Onboarding page is efficient and the phone cancel is six actions; against that, three day-tabs to see one conference, two of four rooms on the phone, and four of eight typed fields it already knew. |
| **Forgiveness** | ★★★☆☆ | Both destructive steps ask *why*, back works, rollback exists, nothing was lost — but the reasons I gave are nowhere to be found, the toast expires before you can act on it, and the cancel dialog describes its bookkeeping rather than its consequences. |
| **Trust** | ★☆☆☆☆ | "The public schedule matches the working copy" while the public was missing four of ten sessions; "It stays visible, and it goes on the record" when it did neither; "8 Confirmed sessions" on one screen and "0 Confirmed" on another; 15:00 on the grid and 22:00 on the same talk's page. |
| **Craft** | ★★☆☆☆ | The public pages and the dashboard are genuinely lovely; the grid has a nameless card, titles cut mid-word, a popover that runs off the screen, duplicate ids, a native `prompt()`, and an ETAG column. |

## ★☆☆☆☆

**The sentence that decided it:** I published my programme, was shown a green banner saying the
public schedule matched my working copy, and the public schedule was missing four of my ten
sessions with two of three days completely empty — and there is no screen in this product that
would ever have told me.

That is fatal by the definition that matters here: the outcome this journey exists to produce — a
public grid that is true — cannot be reached by its intended user, and the product asserts the
opposite. The scenario is right that a wrong schedule is worse than a late one; this is a wrong one
shipped with a green tick.

It is worth saying plainly that the second sitting was good. Cancelling a talk from a phone in a
taxi took six actions, the red **Cancel** was in the first screenful with no scrolling, the
confirmation was immediate and unambiguous, the grid and the counters updated correctly, and the
public page was clean and readable. If the first sitting told the truth, this would be a very
different report.

---

## The shortest path to the next star

Three changes, in the order I hit them. The first is load-bearing on its own; the other two are
what stop the same class of surprise recurring.

1. **Make the Publish screen state what is and is not in the snapshot, and never say "matches"
   when it means "nothing has changed".** "6 of 10 sessions will be public. 2 are waiting on
   speaker confirmation, 2 have blocking onboarding tasks — [named]." A disabled "Publish now"
   must say why in the place where the button is, not in a green banner next to it.
2. **Count publishable, not placed.** "Agenda 10/10" and "0 sessions unplaced" and "10 On the
   schedule" are the numbers an organizer reads to decide they are done. While four of those ten
   cannot reach the public, every one of them is a lie of omission.
3. **Make "Acknowledge" either unblock the session or say that it does not.** Right now it deletes
   the only warning about a block that remains in force, and promises a record it does not show.

Everything else in this report is sand and can wait — except that if `?nojs=1` is not meant to be a
user-facing destination, the "Review" link in the suggestions toast should not point at it.

---

## What I could not check

- **Whether a clash announces itself at the moment it is caused.** The fixture's two conflicts
  pre-existed and I created no collision, because the drag-and-drop grid is not something I could
  operate honestly through a snapshot-and-click interface without inventing a gesture. Placing and
  moving by drag is therefore unrated; so is whether moving one thing quietly moves another.
- **What "Suggest placements" actually suggests.** With 0 unplaced it claimed to have suggested
  something, and I never found any proposal, rationale, or accept/reject control on either version
  of the Agenda. I cannot say whether it proposes nothing, or proposes moving things I had already
  placed.
- **Whether an outbox exists.** The Campaigns copy refers to one. Nothing links to it and I stopped
  hunting at the phone's stop rule.
- **Whether Tom Bianchi received anything.** I only ever saw the organizer's side.
- **A room disappearing**, and **rolling back a publication** — both offered, neither walked.
- **Re-walkability.** I walked this once. The one thing I would watch on a second run is the
  "Published" timestamps, which are rendered in two timezones on two screens and would drift
  differently depending on when the seed was generated.

---

## After the walk — what the code says

*Written after the ratings above were fixed. Nothing here changes any of them.*

I did not open the source during either sitting. The findings above rest entirely on what the
screens said and what the screenshots show. I am deliberately leaving this section thin rather
than turning a taste report into a code review: the disagreement between "The public schedule
matches the working copy" and a public page missing four of ten sessions is the finding, and
whichever layer produces it, the person reading that banner is misled.

Two things a reader of this report will want to establish in the code, and should:

1. Whether `Scheduled` → `Published` is a transition an organizer is ever meant to drive, or one
   that only happens as a consequence of a speaker completing their onboarding. If it is the
   latter, the rule is defensible and the entire fix is copy — which makes it cheap and makes the
   current silence harder to excuse.
2. Why "Publish now" is disabled on the client-rendered `publications` screen and enabled on the
   server-rendered one at the same URL. Whatever the reason, the user-facing consequence is that
   the product's own toast taught me a query flag and the query flag was the only way I published
   anything.
