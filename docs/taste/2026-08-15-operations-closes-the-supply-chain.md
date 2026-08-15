# Operations closes the supply chain

**Journey.** `operations-closes-the-supply-chain` — speaker operations answers "are we ready?",
chases exactly the people who are behind, and gets the final files to an AV contractor who will
never have an account here.

**Walked** 15 August 2026, one sitting, 1440 × 900, against the shipped seed
(`devflow-conf-2027`). Signed in as Riley Chen.
Journal and screenshots in `.walk/`.

---

## Who I was

**Riley Chen, speaker operations, DevFlow Conf 2027.** Not the organizer, and I cannot move a
deadline on my own authority. My whole week is that everybody's bits arrive.

**What I came to do**, in my words: *"Know who's behind, nudge exactly those people and nobody
else, and get what I've got to AV."*

**What I knew:** my login, and that the conference needs bios, headshots and decks. I had never
seen this product.

**Done, from my side:** a list of who owes what; those people — and only those people —
contacted; the files in hand; and a named set of speakers whose files are missing.

**What I'd do instead:** a spreadsheet and seven individual emails. That is the fallback every
friction point below is measured against. My stop rule was: the moment I count the same thing by
hand twice, I open the spreadsheet.

**I finished one of my three jobs.** The nudge reached nobody, and the files could not be got
out at all.

---

## The counts

| | |
|---|---|
| Screens opened | 16 distinct; 33 page loads |
| Actions | 49 (clicks, keystroke fields, selects, one confirm dialog) |
| Fields | 5 typed, 8 chosen from dropdowns |
| Navigations | 33, of which 4 were returns to a screen I had already left |
| Re-dos | 7 |
| **Actions before the first useful thing happened** | **6** — sign-in (4), then Admin, then Onboarding |
| **Answers the product already had** | **3** — the event, re-asked on every one of my three exports, while its own sidebar said "DevFlow Conf 2027" |
| Counts the product displayed | Onboarding 19 / 4 / 0 / 27; roster 14 participants, 19 outstanding, and per-person "N done, M outstanding"; campaign "6 recipient(s)"; results 0 sent / 0 suppressed / 6 failed / 0 queued |
| **Counts I had to make by hand** | **3** — the task-to-person pivot; the number of files on the Files page (12); the number of sessions missing slides (10) |

**The stop rule fired.** I counted by hand twice — once pivoting nineteen task rows into six
people, once counting file rows because no screen shows a total. A real Riley is in a
spreadsheet before lunch, and that spreadsheet becomes the system of record for the rest of the
year.

---

## Job 1 — the list of who is behind

Answered by the product, on `/admin/events/…/onboarding`, in two halves that never meet.

The **totals** were displayed and did not need counting:

> **19** open **4** blocking **0** overdue **27** done

The **detail** is one row per *task*, not per person. Verbatim as presented
(`.walk/05-onboarding.png`), Task · Session · Assignee · Status · Due:

| Task | Session | Assignee | Status | Due |
|---|---|---|---|---|
| Sign the speaker agreement `blocking` | Your Kubernetes Estate Should Be Boring | Tom Bianchi | Not started | in 3 days |
| Name your speaker `blocking` | How We Cut Cold Starts to 40ms | Omar Reyes | Not started | in 9 days |
| Complete your profile and headshot `blocking` | Your Kubernetes Estate Should Be Boring | Tom Bianchi | Not started | in 210 days |
| Confirm recording consent `blocking` | Your Kubernetes Estate Should Be Boring | Tom Bianchi | Not started | in 225 days |
| Send us your travel details | The Build Cache Is Not Your Problem | Dana Kowalski | Not started | in 225 days |
| Send us your travel details | Type-Checking a Million Lines in Under a Second | Ravi Menon | In progress | in 225 days |
| Send us your travel details | Platform Engineering Without the Platform Team | Elena Fischer | Not started | in 225 days |
| Send us your travel details | Your Kubernetes Estate Should Be Boring | Tom Bianchi | Submitted | in 225 days |
| Tell us your AV requirements | Agents That Ship: Running Code-Writing Models in Production | Marcus Okafor | Not started | in 240 days |
| Tell us your AV requirements | Platform Engineering Without the Platform Team | Elena Fischer | In progress | in 240 days |
| Tell us your AV requirements | Your Kubernetes Estate Should Be Boring | Tom Bianchi | Not started | in 240 days |
| Upload your final slides | Agents That Ship: Running Code-Writing Models in Production | Marcus Okafor | In progress | in 263 days |
| Upload your final slides | Type-Checking a Million Lines in Under a Second | Ravi Menon | Not started | in 263 days |
| Upload your final slides | Platform Engineering Without the Platform Team | Elena Fischer | Submitted | in 263 days |
| Upload your final slides | Your Kubernetes Estate Should Be Boring | Tom Bianchi | Not started | in 263 days |
| Book your tech check | The Build Cache Is Not Your Problem | Dana Kowalski | In progress | in 267 days |
| Book your tech check | Agents That Ship: Running Code-Writing Models in Production | Marcus Okafor | Not started | in 267 days |
| Book your tech check | Type-Checking a Million Lines in Under a Second | Ravi Menon | Submitted | in 267 days |
| Book your tech check | Platform Engineering Without the Platform Team | Elena Fischer | Not started | in 267 days |

I pivoted that into six people by hand. Then, one nav item away, I found `Speakers`
(`.walk/06-speakers-roster.png`) — subtitle *"Everyone taking part in this event, and what each
of them still owes"* — which had already done the pivot, verbatim:

> Tom Bianchi — 3 done, 6 outstanding · Elena Fischer — 5 done, 4 outstanding ·
> Marcus Okafor — 6 done, 3 outstanding · Ravi Menon — 6 done, 3 outstanding ·
> Dana Kowalski — 7 done, 2 outstanding · Omar Reyes — 0 done, 1 outstanding

Both subtitles promise the same job. Neither screen is the list: `Onboarding` has the *what* but
no *who*, `Speakers` has the *who* but no *what*, and the person page has neither. **Who owes
what** exists only in my head.

Two things about that table make it hard to act on. Three rows read `Submitted` and are still
counted as outstanding — I cannot tell whether Elena owes me slides or whether they are sitting
waiting for *me*. And every date is relative: "in 3 days", "in 210 days". I am about to write to
a human, and I cannot put "in 225 days" in an email.

---

## Job 2 — nudge exactly those people, and nobody else

This is the part that had genuine care in it and then threw the result away.

**Before sending, the product told me exactly who would receive it** — count *and* names *and*
addresses (`.walk/10-campaign-draft.png`):

> **6** recipient(s) resolved right now — the actual send re-resolves the criteria, so this is a
> preview, not the final list.
> Marcus Okafor — cospeaker@devflowconf.example · Dana Kowalski — dana.kowalski@substrate.example ·
> Ravi Menon — ravi.menon@paperclip.example · Elena Fischer — elena.fischer@northbeam.example ·
> Tom Bianchi — tom.bianchi@quanta.example · Omar Reyes — omar.reyes@ferrolabs.example

Exactly the six. Not the organizer, not me, not the sponsor contact who owes nothing. The
audience control that produced it is a single checkbox — **"Has an outstanding task"** — which is
my job expressed as a checkbox and is the best-designed thing I touched all day.

Then I pressed **Send now**. A browser `confirm()` asked *"Send to everyone matching the audience
right now?"* — no number, no names, at the exact moment I wanted both. The page said
**"Sending."** and stopped moving. Nothing told me it would update, so I reloaded on a hunch.

> `<span class="badge ">Partially failed</span>`
> Results: **0** sent · **0** suppressed · **6** failed · **0** queued

My one message to the six people who are behind reached nobody. There is no reason, no retry, no
resend, no edit — after the send the **Send now** button is gone, so the only route is to compose
the whole thing again from scratch. Had I not refreshed on instinct, I would have gone into next
week believing six speakers had been chased.

I then tried the other route — the per-row **Remind** button on Onboarding. It reported
*nothing*: no toast, no changed row, no timestamp, no count. The page was byte-identical after
the click. The Outbox later showed that reminder as `FAILED` too, with subject `—`.

The Outbox (`.walk/27-outbox.png`) is where I finally learned the truth, and its subtitle is the
best sentence in the product: *"Every message the platform has sent or tried to — the answer to
'did we tell them?'."* Seven rows from today, all `FAILED`. The seeded `proposal.accepted` mails
from 11 August all say `SENT` — so this instance *can* send mail. The `REASON` column exists and
is `—` on every one of my seven failures.

**Does the nudge sound like the conference?** The stored body is exactly my paragraph and nothing
else — no greeting, no "DevFlow Conf 2027", no sign-off, no sender named anywhere on the compose
screen or the draft. In the outbox preview it renders as an unwrapped monospace line, cut off at
the edge of the table.

---

## Job 3 — get the files out to somebody without an account

**Not achievable.** `Files` (`.walk/16-files.png`) lists twelve assets, every one a headshot; no
deck exists yet. The page has no count and no download control of any kind — no per-row
download, no select-all, no "download all".

The export machinery lives under **Settings**, beside API keys and Webhooks, not beside Files.
I generated `Files / ZIP / DevFlow Conf 2027`:

> Format: **zip** · Includes personal data: no · **Size: 22 bytes** · Expires: 2026-08-22T20:07:20.240Z

22 bytes is an empty archive — zero entries. I retried as CSV: 110 bytes, one header line, no
rows:

```
asset_id,slot_key,filename,version,size_bytes,content_type,scan_status,uploaded_at,belongs_to,uploaded_by
```

Both formats are empty while the screen behind them shows twelve files. The `Sessions` export
*does* work (1920 bytes, ten rows with room, time and `speaker_names`) and is the only thing I
could hand over — a run sheet, not the assets. Its times are all UTC (`2027-05-13T16:00:00.000Z`)
for an event the sidebar says runs in `America/Los_Angeles`; a contractor reading it is seven
hours out.

**Would a stranger recognise what they were sent?** No. The files arrive named
`files-exp_01M03GJEDGRCZWWB39G6QSHZRX.zip` and
`sessions-exp_01M03GNREJ2EFEE2NA34FMG6C5.csv`. Nothing in either name says DevFlow, or 2027, or
what is inside.

The only route to an actual headshot is one file at a time, through
`/files/ast_…` — a page that renders with **no stylesheet at all** (`.walk/23-file-detail.png`),
in Times New Roman, and which does not show the image it is about. Twelve headshots would be
twenty-four actions through a page that looks broken.

**Speakers missing from the file set.** Ticking *"Show sessions with no slides yet"* gives a
clean absence list — ten sessions, which is every session — including **Lunch** and
**Registration and coffee**. Mapping the real ones to people by hand:

> **Missing a deck:** Marcus Okafor · Elena Fischer · Ravi Menon · Dana Kowalski · Tom Bianchi ·
> Aisha Bello · Kenji Watanabe · and the sponsor session "How We Cut Cold Starts to 40ms", which
> has no speaker named at all.

That is every speaker on the programme. **Headshots** exist for all twelve people on the roster
and can be reached individually but not delivered.

---

## What confused me — quoted from the journal as written

- *"is 'Onboarding' speaker onboarding, or my onboarding to the tool?"* (screen 04)
- *"Three rows say SUBMITTED and are still counted as open. Does Elena owe me slides, or did she
  send them and they're waiting on ME?"* (05)
- *"If I write a reminder, what date do I put in it? I cannot copy 'in 225 days' into a message to
  a human."* (05)
- *"0 overdue, yet the whole reason I'm here is that people are behind."* (05)
- *"'Internal name' is required and 'Subject' is not. On an email. Which one does the recipient
  see?"* (08)
- *"Does this go out FROM DevFlow Conf or from riley.chen@? Nothing on this page names the
  sender, and the whole point is that it should sound like the conference."* (10)
- *"WHY did it fail? Not one word."* / *"Why is 6-out-of-6 called 'Partially failed'?"* (12)
- *"Was a reminder sent? If I click it again tomorrow, will Tom get two?"* (14)
- *"Top-left says Status: INVITED. Two boxes down, 'Across every event' says CONFIRMED. Which is
  it? I am the person who has to know whether Tom is coming."* (15)
- *"22 bytes is on the screen and means nothing to anybody. Why is there no '12 files' or '0
  files'?"* (20)
- *"who decides who is on the public speakers page? I am the person who gets the email asking why
  they are missing."* (25)

---

## What took more than one attempt

| # | What I tried first, and why | What it cost |
|---|---|---|
| 1 | Signed in and landed on `/portal` — "You have not started a proposal yet" — a page for a job that is not mine. Hunted the nav and found `Admin`, third item, small, grey. | 1 screen, 1 nav |
| 2 | Pivoted 19 task rows into 6 people by hand on `Onboarding`, because its subtitle promised exactly my job. `Speakers`, one item away, had already done it. | hand-count #1 |
| 3 | Waited on "Sending.", then reloaded on a hunch to find out what happened. | 1 reload, and the only reason I know at all |
| 4 | Fell back to per-row `Remind` after the campaign failed; it reported nothing, so I could not tell whether *that* had worked either. | 1 action, zero information |
| 5 | Export `Files / ZIP` → 22 bytes, empty. | 5 actions |
| 6 | Export `Files / CSV` → header only, no rows. The form had forgotten every choice, so I re-entered them. | 4 actions, 1 field the product already knew |
| 7 | Export `Sessions / CSV` as a fallback that was not what I was asked for. | 4 actions, 1 field re-entered again |

---

## What was not intuitive

- **The primary action is not styled as primary.** On the draft campaign, `Send now` is a plain
  grey outline button, the same weight as `Schedule` beside it; the field between them,
  *"Or schedule for"*, carries a red required asterisk on something I did not want to fill. I
  hesitated over whether I was allowed to just send (`.walk/10-campaign-draft.png`).
- **Exports are filed under Settings**, next to API keys and Webhooks, rather than beside the
  Files they export. I found them only because `Today` happened to carry an `Export` button.
- **The audience controls sit below the message body.** I read the whole form before typing,
  because I wanted to know who I was writing to before I wrote it.
- **"Campaign"** for a five-line nudge to six colleagues. The nav says `Messaging`, the page says
  `Campaigns`; I expected a marketing blast and nearly went looking elsewhere.
- **A speaker asking for an extra week has no answer.** On the task page my choices are `Waive`
  (with a required reason — good) or `Send a reminder now`. The due date is not editable
  anywhere I could find. My only sanctioned response to "can I have until Friday" is to cancel
  the obligation entirely (`.walk/26-task-detail.png`).

---

## Moments of care

Name these, because they are the instincts to follow.

1. **The recipient preview.** Count, names *and* addresses, before sending, plus an honest
   caveat that the real send re-resolves. This is how bulk messaging should always work.
2. **"Has an outstanding task"** as a single checkbox. My entire job, expressed once, correctly.
3. **"Show sessions with no slides yet."** Almost no product shows you *absence*. This one tried.
4. **The event chip** — "12–14 May · 269 days out · America/Los_Angeles" — on every admin screen.
   The timezone is stated rather than assumed.
5. **The Outbox subtitle**: *"Every message the platform has sent or tried to — the answer to
   'did we tell them?'."* The clearest sentence in the product, and it names a real question.
6. **The consent block on a person**: *"Per-field visibility and the public listing are the
   speaker's consent, not the organizer's preference… only Tom Bianchi can change them, in their
   own portal."* Somebody thought hard about what it means to look at another person's data.
7. **"Editing someone else's profile records you as the last editor, writes an audit row, and
   tells them who changed it."** Told to me before I edited, not after.
8. **"Generated exactly under your own permissions — never a side door around what you may
   already see. Expire after 7 days."** Answered the exact question I had about handing an
   export to an outsider.
9. **`Waiver reason` is required before `Waive`.** Accountability designed in.
10. **The scan column.** Every file says `Clean`; I know it has been checked before I forward it.
11. **"Search needs JavaScript; the full directory below works without it."** Honest, and rare.
12. **`Reminders sent: 2 · last 2026-08-15`** on the task page. The record I wanted *does* exist —
    it is just not on the screen where I pressed the button.

---

## Findings

### FATAL 1 — The nudge reached nobody, and the product let me believe it had

*Where:* `/admin/campaigns/cmp_…`, 1440 × 900, `.walk/11-campaign-sent.png`,
`.walk/12-campaign-partially-failed.png`.
*Doing:* sending the one message that is job two of three.
*Expected:* "Sent to 6 people." *Got:* the page said **"Sending."** and stopped. Only a manual
reload — which nothing invited — revealed `0 sent / 0 suppressed / 6 failed / 0 queued`.
*Cost:* the entire deliverable, plus 1 re-do, plus a fallback route that also failed silently.
*Bug.* Certain. The Outbox shows seeded mail sending successfully four days earlier, so this is
not "email is off in dev" as far as any screen tells me.

### FATAL 2 — The failure names nothing and offers no way back

*Where:* same screen, and `/admin/outbox`, `.walk/27-outbox.png`.
*Expected:* a reason and a `Retry`. *Got:* no reason on the campaign, and a `REASON` column in
the Outbox that reads `—` on all seven of today's failures. After sending, `Send now` disappears;
there is no retry, resend, edit or duplicate. The only route forward is to compose the message a
second time.
*Cost:* unrecoverable without redoing the work; no way to tell a colleague what went wrong.
*Bug + taste.* Certain.

### FATAL 3 — The Files export is empty in every format

*Where:* `/admin/exports/…`, `.walk/20-export-detail.png`, `.walk/21-export-csv.png`.
*Doing:* job three — getting the assets to a contractor with no account.
*Expected:* twelve headshots. *Got:* ZIP = **22 bytes**, zero entries. CSV = **110 bytes**,
header row only. The Files screen shows twelve files at the same moment.
*Cost:* the whole deliverable; 2 re-dos; a fallback (`Sessions` CSV) that is not what was asked
for. The only working route to an asset is 12 pages × 2 actions.
*Bug.* Certain.

### SERIOUS 4 — "Remind" reports nothing at all

*Where:* `/admin/events/…/onboarding`, `.walk/14-onboarding-after-remind.png`.
*Expected:* "Reminder sent to Tom Bianchi", or the row remembering it. *Got:* nothing — no toast,
no state change, no timestamp, no count. The record *does* exist (`Reminders sent: 2 · last
2026-08-15`) but only on a screen two clicks away.
*Cost:* I could not tell success from failure, and did not dare press again in case it sent two.
*Taste.* Certain.

### SERIOUS 5 — A status badge renders as raw HTML on three screens

*Where:* every export detail page and every campaign detail page.
`.walk/10-campaign-draft.png`, `.walk/12-campaign-partially-failed.png`,
`.walk/20-export-detail.png`.
*Got:* `<span class="badge ">Draft</span>`, `…>Sending</span>`, `…>Partially failed</span>`,
`…>Ready</span>` printed as literal text where the status should be. The same value renders
correctly as a pill on the campaigns *list*, so one screen contradicts another.
*Cost:* the state of the thing I am about to send to six people is shown to me as markup.
*Bug.* Certain.

### SERIOUS 6 — "Partially failed" when nothing partial happened

*Where:* campaign detail and campaigns list, `.walk/13-campaigns-list-after.png`.
6 of 6 failed. The word is "Partially". On the list the pill is the same neutral grey as the
`EMAIL` channel pill beside it — a total delivery failure is styled as metadata. Read fresh, I
would have taken it for "fine, it went".
*Cost:* the difference between chasing six speakers and not.
*Bug + taste.* Certain.

### SERIOUS 7 — One person is `INVITED` and `CONFIRMED` on the same page

*Where:* `/admin/people/per_…`, `.walk/15-person-tom-bianchi.png`.
Identity says `Status: Invited`. Two panels below, "Across every event" says DevFlow Conf 2027
`CONFIRMED`; the roster says `CONFIRMED` too. I am the person who has to know whether Tom is
coming.
*Taste/bug boundary; I could not tell which status is about what.* Fairly sure this is a defect,
less sure which half is wrong.

### SERIOUS 8 — The file detail page ships with no stylesheet

*Where:* `/files/ast_…`, `.walk/23-file-detail.png`. Times New Roman, bare table, blue underlined
links. Six console errors, all the page's own CSP refusing the site's own `admin.css` and fonts.
It is also a page *about* a headshot that never shows the headshot, and its subtitle reads
`slot person:per_01JQ00000AK91QF5XKB1SF7XNB:headshot`.
*Cost:* the one screen a stranger's asset lives on looks broken, and I cannot check an image
before forwarding it.
*Bug.* Certain about the styling; the CSP reading is evidence, not the finding.

### SERIOUS 9 — No one screen answers "who owes what"

*Where:* `Onboarding` and `Speakers`, `.walk/05-onboarding.png`, `.walk/06-speakers-roster.png`.
Both subtitles claim it. One has the *what*, the other the *who*, the person page has neither,
and the Onboarding table has no sort, no filter, no grouping and no search.
*Cost:* hand-count #1, and the thing that pushed me toward the spreadsheet.
*Taste.* Certain.

### SAND — the rest, in the order I hit them

- Signing in as operations staff lands on **"You have not started a proposal yet"**; the only
  loud button on that page (`Find an open call`) is the one thing I least want, and the way to my
  work is a small grey `Admin` link that opens a new tab (`.walk/03-portal-after-login.png`).
- **Four date formats in one afternoon**: "in 3 days" (Onboarding), "2026-08-18" (task page),
  "15 Aug 2026, 13:04" (Outbox), "2026-08-15T20:03:10.241Z" (campaigns list, export expiry). The
  absolute due date exists on exactly one screen, two clicks from where I need it.
- **The export form forgets everything.** Subject resets to "Review results"; `Event` resets to
  "— none —" although every screen has said DevFlow Conf 2027 all day. I typed the event three
  times.
- **`Size: 22 bytes`** is the only feedback on whether an export contains anything. A count of
  rows or files would have told me instantly.
- **Download names a stranger cannot use**: `files-exp_01M03GJEDGRCZWWB39G6QSHZRX.zip`.
- **Maker's vocabulary on screen**: `Roster status (event_participants only)` on the compose form;
  `Review round id (review_results only)` and `Requires pii:read` on the export form; template
  names `invitation.sent` / `task.reminder`; the Files upload form demanding a hand-typed
  `Subject id — the session, person or sponsor id`; `Source: decision` on a person; CSV headers
  `asset_id, slot_key, belongs_to, scan_status, content_status`.
- **"Missing slides" includes Lunch and Registration and coffee**, and lists sessions where my
  deliverable is speakers. Ticking the box also replaces the file table entirely, so I cannot see
  what I have and what I am missing at once.
- **The Outbox loses its own point when you use it**: opening a `Message` pushes `STATUS` and
  `REASON` off the right edge and truncates the body mid-word (`.walk/28-outbox-message-open.png`).
- **`Sessions` CSV exports every time in UTC** for an event whose timezone the sidebar knows, and
  gives "Registration and coffee" the format `Talk (30 min)` with a duration of 60.
- **The public speakers page shows four of the twelve people**, as coloured initials rather than
  the headshots that exist, and omits Tom Bianchi whose own profile says "Listed publicly: Yes".
  Nothing in the console explains who appears there.
- **The empty `Campaigns` state** is one grey sentence in a dotted box — "No campaigns yet." — on
  the screen where I most needed to know what a campaign is and who I could reach.
- **The `confirm()` before sending** says "Send to everyone matching the audience right now?" and
  not "Send to these 6 people now?", when the page directly behind it knows the number.

---

## The six dimensions

| | | |
|---|---|---|
| **Orientation** | ★★★★☆ | The event chip states dates, days-out and timezone on every screen, and "Ordered by what stops the event if it slips" told me what the page was for — but sign-in put me in the speaker portal, and two screens claim the same job in the same words. |
| **The obvious next step** | ★★★☆☆ | Onboarding and the compose flow lead you properly; then `Send now` is styled as a secondary button, exports hide under Settings, and after a failure there is no next step on the page at all. |
| **Effort** | ★★★☆☆ | "Has an outstanding task" saved me an hour; three hand-pivots, a Files screen with no total and an export form that forgot my event three times gave it back. |
| **Forgiveness** | ★☆☆☆☆ | Six failed deliveries with no reason, no retry and no route back; a `Remind` that reports nothing; and a speaker asking for one more week can only be waived, never extended. |
| **Trust** | ★☆☆☆☆ | I nearly left believing a message had gone that had not — and a status badge printed as raw HTML, "Partially failed" for 6-of-6, `INVITED` beside `CONFIRMED`, and `Ready` on a 22-byte archive all sit on top of that. |
| **Craft** | ★★☆☆☆ | Some of the best interface writing I have read this year, in a product where one route ships with no stylesheet, four date formats, and a database table name in a form label. |

---

## ★☆☆☆☆

**One star**, for the journey Riley Chen took at 1440 × 900 on 15 August 2026.

The sentence that decided it: *my one message to the six people who are behind reached nobody,
the screen said "Sending." and stopped, and I only found out because I reloaded the page on a
hunch.* Two of my three jobs could not be completed — the nudge went nowhere and the files could
not be got out in any form — and the one that failed silently is worse than the one that failed
loudly, because next week I would have been wondering why nobody replied.

This is not a bad product. The recipient preview, the outstanding-task checkbox, the absence
filter, the consent copy and the Outbox's own subtitle are the work of people who thought
carefully about the person on the other side. That is precisely why the ending is so bad: it
built me a correct list of six names and then dropped it.

---

## The shortest path to the next star

Ordered, minimal, load-bearing only.

1. **Make the send work, or say why it didn't.** If a delivery fails, put the reason in the
   `REASON` column that already exists, show it on the campaign, and put a `Retry failed (6)`
   button next to it. Nothing else on this list matters while the message does not arrive.
2. **Make `Files` export contain the files.** ZIP with twelve headshots in it, named for people,
   in a file called something like `devflow-conf-2027-headshots-2026-08-15.zip`.
3. **Acknowledge the `Remind` click** — "Reminder sent to Tom Bianchi · 2 sent, last today" — in
   the row where it was pressed.

Those three would take this from "I could not finish" to "I finished". Everything else in this
report is what stands between two stars and four.

---

## What I could not check

- **Whether the email failure is specific to this local instance.** I stayed in character and
  never looked; from the screen, the seeded mail of 11 August says `SENT` and mine says `FAILED`,
  and that is all a real Riley would ever know. If it is environmental, the finding survives
  unchanged: the failure must name itself.
- **The second sitting.** This journey was specified as one sitting, so nothing here measures
  leaving and coming back. Worth walking: my campaign draft was saved before sending, and whether
  a half-composed nudge survives a closed laptop is untested.
- **Phone width.** Not walked; speaker operations was specified at 1440 × 900. One accidental
  render of `/admin` at 390 px (`.walk/04-admin-today.png`) reflowed cleanly, which is
  encouraging but not a walk.
- **Whether the six recipients would have received a message that sounded like DevFlow Conf.**
  Nothing sent, so I only ever saw the stored body — which contains no greeting, no sender and no
  conference name.
- **Granting one speaker an extension.** I found no control for it and stopped rather than
  guessing; it may exist somewhere I did not reach.
- **`Chat` as a channel**, `Based on template`, and `Schedule for` — all left alone, because a
  first send under time pressure is not where anyone experiments.

---

## After breaking character — what the code says

Written **after** every rating above was fixed. Nothing here changes a rating; it is only here so
whoever picks these up does not have to re-find them.

**The badge rendered as raw HTML** (Finding 5). `pageHead(title, lede?)` in
`workers/api/src/ui/layout.ts:481` takes `lede` as a **string**, which the template then escapes.
Three call sites interpolate a `SafeHtml` badge into a template literal first, which stringifies
it into escaped text:

- `workers/api/src/contexts/platform/routes.ts:1137` — the campaign detail page
- `workers/api/src/contexts/content/routes.ts:691` — every export detail page
- `workers/api/src/contexts/content/routes.ts:572` — every import detail page (not walked)

The same value renders correctly wherever `badge()` is passed straight into `html\`\``, which is
why the campaigns *list* is fine and the detail page is not.

**The empty Files export** (Finding 3) is by design, and the design does not cover this seed.
`subjectRows()` in `workers/api/src/contexts/content/export.ts:302` returns `[]` for the `files`
subject, so CSV and JSON are header-only for every instance, always. `buildFilesZip()` at line 311
selects only from `session_asset` — assets attached to a **session**. Every asset in the shipped
seed is a person-scoped headshot (`slot person:per_…:headshot`), and there are no session decks
yet, so the archive is empty for exactly the world the product ships. There is no path at all
from a person's headshot to an export.

**The empty `Reason` column** (Finding 2). The reason *is* recorded: on failure
`workers/api/src/contexts/platform/notifications.ts:552` writes
`{ status: "failed", error: sendResult.error ?? "Send failed." }`. The Outbox table renders
`suppressed_reason` in that column and never `error`
(`workers/api/src/contexts/platform/routes.ts:1249` and its row builder), so a suppression shows
its reason and a failure never can. The answer I needed was one column away the whole time.

**Whether the delivery failure is environmental.** Not established. The seeded
`proposal.accepted` mail is marked `SENT` in the same table, which is what a real Riley sees, so
the finding stands on its own terms either way: a failure that names nothing is unrecoverable
regardless of its cause.
