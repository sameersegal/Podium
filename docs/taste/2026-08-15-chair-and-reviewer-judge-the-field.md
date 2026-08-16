# A chair and a reviewer judge the field

**Journey:** `chair-and-reviewer-judge-the-field` (S3)
**Walked:** 15 August 2026, against the shipped seed on `localhost:8787`
**Viewport:** 1440 × 900 for both sittings
**Rating: ★★☆☆☆**

---

## Who I was, and what I came to do

**Sitting 1 — Jordan Alvarez, programme chair.** I run DevFlow Conf 2027. I have three volunteer
reviewers and about one week of their attention in total. In the invitation email I sent them I
promised that review here is blind. I came to do three things, in this order:

1. Satisfy myself that a reviewer genuinely cannot work out whose proposal they are reading.
   **I said I would not send another invitation until I knew this**, so it goes first.
2. Find out how far along each of my reviewers is — by name, not "62% complete".
3. Push everything nobody has read yet onto Sam Whitfield, who has offered an evening.

**Done, from my side:** I can say out loud to a reviewer who asks "you will see X, you will not
see Y", having *checked* rather than believed; and every unread proposal has a name against it.

**What I would do instead:** export to a spreadsheet, strip the names by hand, email the three of
them a tab each and collect scores by reply. That is what I did last year and it worked.

**Sitting 2 — Sam Whitfield, volunteer reviewer**, on a machine that has never signed in here
(`.walk/profile` deleted with the browser closed). Not staff, not paid, about an hour of goodwill
on a weekday evening. Came to get through my pile tonight, honestly.

**What I would do instead:** close the tab and reply "sorry, ran out of time this week". Silently.

**I finished both sittings.** Nothing was lost. But I did not finish the first one's stated
objective, and I stopped believing the product part-way through.

---

## The counts

| | Chair | Reviewer | Total |
|---|---|---|---|
| Screens opened | 13 | 8 | 21 |
| Actions (clicks, choices, typed fields) | 22 | 18 | 40 |
| Values typed or chosen | 4 | 9 | 13 |
| Backward / unwanted navigations | 2 forced Backs | 1 unwanted new tab, 1 wrong landing | 4 |
| Re-dos | 3 | 2 | 5 |

- **Actions before the first useful thing happened.** Chair: **5** (to reach the words "Double
  blind"), **6** to see reviewer progress by name. Reviewer: **6** to see the pile at all, **7**
  before typing the first score.
- **Answers the product already had: 2.** Sam was made to give the same opinion twice — a
  three-way *Verdict* and then a seven-way *Overall recommendation*, with nothing pre-selected
  from the first. And the chair's conflict-of-interest form demands a raw `per_…` identifier for
  a person whose name is in a dropdown two panels above it.
- **Pile size, recorded as asked.** Before Sam started: **1**. After: **0**.
- **Did the handoff match?** **Yes.** The chair created 1 assignment; Sam found 1 waiting.
  1 = 1.
- **Actions per proposal, averaged over the pile:** 10 (open, seven answers, one hunt for the
  submit button, submit) over a pile of 1.
- **Actions in the seam between finishing one and starting the next:** **0** — submitting
  returned me to the queue by itself. This is the product at its best, and I could only measure
  it once because the pile was one deep.
- **Stop rule:** never triggered. With one proposal in the queue, three consecutive expensive
  hand-offs could not occur.

---

## What the chair concluded, and what they assigned

Read off the screens, in the order I found them:

| Reference | Title | Reviews in | What I decided |
|---|---|---|---|
| DFC27-0001 … 0009 | (nine talks) | 2 / 2 | Done. |
| DFC27-0010 | Prompt Engineering Is Software Engineering | **1 / 2** | Short. Tried to give it to Sam; refused. |
| DFC27-0011 | Documentation as a Product Surface | **0 / 2** | **Assigned to Sam Whitfield.** |
| DFC27-0012 | Incident Review Without Blame or Theatre | 0 / 2 | Draft, never submitted. Not mine. |
| DFC27-0013 | How We Cut Cold Starts to 40ms | **0 / 2** | **Already ACCEPTED with no reviews.** No screen says why. |

**Output: 1 assignment created.** Sam found exactly that 1 waiting, scored it, and his queue is
now empty.

**Could the chair verify the anonymity promise from the product?** **No — only on faith.** The
sentence I needed exists and is excellent: *"Blind review. You will not see names, affiliations or
links."* It is printed on the reviewer's queue, on the reviewer's scorecard, and nowhere the chair
can reach. On my side I got a settings help-text that begins with the word `double_blind` and no
way to look at my own product through a reviewer's eyes.

---

## What confused me, quoted from the journal at the time

> "19/19 reviews" of what? Every proposal, or every *assignment that exists*? Those are wildly
> different numbers for my job and this screen picks the flattering one. — *S1-02, /admin*

It was assignments. 7 + 6 + 6 = 19 assignments, all submitted, drawn as a full blue bar over the
sentence "1 proposal is short of quorum and cannot be decided". The headline number on the
organizer's home page reads 100% while a proposal sits with nobody on it.

> Which of the four buttons is the one I want? They are visually identical. I want "how far has
> each reviewer got", and I have to guess between Assignments, Progress and Results. — *S1-03*

> What does "Accepted" count? Nothing on the page says. … Who sent the 3 reminders, and when?
> — *S1-04, Progress*

Sam's row reads Assigned 7, **Accepted 0, Declined 0**, Submitted 7. I cannot construct a story
in which someone submits seven reviews having accepted none of them.

> Where is DFC27-0012? 12 in the sidebar, 11 in the dropdown, and no screen has said why.
> — *S1-05, Assignments*

> What is a "META REVIEWER" and what can she see that Sam cannot? The badge is not explained
> anywhere on the page, and it bears directly on my anonymity promise. — *S1-07, Pool*

> What is "STALE"? Every row says "—" and nothing says what would put a word there. — *S1-10*

> Where do I get a `per_...` from? … so: leave this page, go to Pool, click a name, copy the id
> out of the URL, come back. Nobody will do this. — *S1-11*

> What conflict, and against whom? "One conflict is on file for you" and no way to see it. I am
> the person it constrains; I would like to know if it is right. — *S2-03, Sam's queue*

---

## What took more than one attempt

1. **Getting from one round tab to another** (chair, twice). The `/review` card links to Round
   settings, Assignments, Progress and Results. None of *those* pages carries the sibling links —
   only the Round settings page has a tab strip, and it offers a fifth tab (**Pool**) that the
   card never mentions. Both times I wanted to move sideways I had to press browser Back.
2. **Finding out which proposals nobody had read** (chair). I tried Review → Progress →
   Assignments → Round settings → Pool. The answer is a column called REVIEWS IN on
   **Intake → Proposals**, five screens away in a different section of the nav, and nothing in
   the Review section links to it. I got there on a hunch.
3. **Getting to my queue after signing in** (reviewer). Detailed below; the worst re-do of the
   walk.
4. **Finding the Submit button** (reviewer). Four keyboard moves inside a scroll region I did not
   know was there.
5. **Working out which proposal a refusal was about** (chair). The error names a ULID; I matched
   it by eye against a nineteen-row table.

---

## What was not intuitive

**Signing in as a volunteer takes you to a page about submitting a talk.** `/admin` redirects to
`/login?next=/admin`. `/review` does not: it returns **HTTP 401** on a page whose browser tab
reads *"Something went wrong · Podium"*, with three same-weight links — "Go back · Home · Sign in"
— and the Sign in link carries **no `next`**. So I signed in and landed on `/portal`, reading:

> **You have not started a proposal yet.** When you submit one, this page becomes the talk: where
> it has got to, and what is still waiting on you. **[Find an open call]**

I clicked a review link. The only solid black button on the screen now invites me to go find a
call for papers. The word "review" appears once, as a small grey "Reviewing ↗" in the top right
with an external-link arrow on it, as though it belonged to somebody else's website — and it
opens in a new tab. This is the moment a volunteer wonders whether they are in the right place,
and volunteers are lost silently.

**The organizer's door is polished and the volunteer's door throws a 401.** Those are the same
product and the same three lines of routing.

---

## Moments of care

There are a lot of these, and several are better than they needed to be. This product has real
taste in it; it is concentrated on one side of the seam.

- **"The chair's working surface. Ranking is never automatic — the numbers and the disagreement
  signal are, the decision is yours."** (Results, `.walk/10-round-results.png`.) The best sentence
  in the product. It says the thing a fairness-minded chair most needs to be able to repeat.
- **"Reported, not quietly under-reviewed."** (Bulk assignment refusal,
  `.walk/12-bulk-assign-result.png`.) A five-word statement of philosophy, and the right one.
- **"Let a reviewer see other reviews before their own is submitted — Default off — anchoring is
  real."** (Round settings.) It explains *why*, not just *what*.
- **"Other reviews, the aggregate and the discussion open once your own review is submitted or you
  decline. Anchoring is real — this is deliberate, not a bug."** (Scorecard.) It pre-empts the
  exact complaint I was forming — and then **it kept the promise**: the moment I submitted, Other
  reviews and Discussion opened. `.walk/25-sam-review-after-submit.png`.
- **Every scoring criterion carries its own scale in plain words** — *"1 — barely related. 5 —
  exactly what this track exists for."* The scenario asks whether a reviewer can tell what a score
  means before giving one. Yes, on every field, without asking. `.walk/18-sam-scorecard.png`.
- **Verdict written as sentences**: "Accept — I would put this on the programme." Not three bare
  words.
- **"Not applicable — can't judge this"** on the criteria a blind reviewer genuinely cannot judge.
- **Two comment boxes, each labelled with who sees it**: "Never visible to the submitter." /
  "Released only if a decision using this feedback is published."
- **"At two a day you finish 20 days before the round closes."** The product did arithmetic on my
  behalf and told me I was comfortably ahead. `.walk/17-sam-queue-1440.png`.
- **"Nothing outstanding. Thank you."** The right last thing to say to somebody who did this for
  free.
- **The conflicts note explains an absence**: "Proposals it touches are withheld from your queue
  rather than shown and refused." Explaining why something *isn't* there is the hardest thing in
  any interface and it is done in one sentence.
- **"Membership of one round's pool implies nothing about any other round."** Kills a whole class
  of wrong assumption in eleven words.
- **"DFC27-0001 · committee discussion. Never speaker-visible."** Under the title, where it
  belongs.
- **Progress by name**, with Outstanding and Overdue columns and a Remind action — the chair's
  second question answered on one screen, in two clicks. `.walk/04-round-progress.png`.
- **The new assignment arrived with a due date already set to the round close, and a Revoke
  button next to it.** Nobody asked me for either.
- **`J` `K` move, `↵` open** on the reviewer's queue — somebody expected this to be done in bulk.

---

## Findings

### 1. The product tells the chair and the reviewer two different, contradictory things about the same conflict of interest — Serious, bug
**Where:** `/admin/rounds/{rnd}/assignments/bulk` (`.walk/12-bulk-assign-result.png`),
`/admin/proposals/{prp}/review` (`.walk/13-proposal-review-0010-conflicts.png`),
`/review` and `/review?show=submitted` (`.walk/17-sam-queue-1440.png`, `.walk/24-sam-submitted-list.png`).

Assigning everything short of quorum to Sam, the product refused one and said:

> *"1 proposal cannot reach quorum with this pool. Reported, not quietly under-reviewed."*
> *"prp_01JQ00007TM82PG4YJC0TE8WPA — 0 of 1 achievable: **Every reviewer you chose has a conflict
> of interest with this proposal**."*

That proposal is DFC27-0010. Its own page, sixty seconds later, says:

> *"**No conflicts declared against this proposal**."*

Sam's queue says: *"One conflict is on file for you. Proposals it touches are **withheld from your
queue** rather than shown and refused."* And Sam's submitted list contains **DFC27-0010, sent 8
days ago**. It was not withheld; he reviewed it.

**Cost:** the chair cannot answer the one question they must be able to answer in public — was
this proposal judged by someone who should not have judged it? There are two readings and the
product supports neither over the other: the conflict is person-scoped and the proposal page only
shows proposal-scoped ones (in which case the chair's screen is actively misleading), or the
conflict was recorded after the review landed (in which case nobody told the chair that a
submitted review is now tainted). **Certainty: high that the screens contradict each other;
moderate on which of the two is happening.**

**What would have worked:** the proposal's conflicts panel lists every conflict that *applies* to
it, whatever it was declared against, and says which reviews were submitted before it existed.

### 2. The chair cannot see what a reviewer sees, so cannot verify the anonymity they promised — Serious, taste
**Where:** the whole of `/admin` (`.walk/06-round-settings.png`, `.walk/09-proposal-0011.png`,
`.walk/11-proposal-review-0001.png`).

This was the first thing I came to do and the thing I said I would not proceed without. There is
no "preview as reviewer", no "reviewers will see: title, abstract, track, level", nothing. What
there is, is one help-text under a select:

> *"**double_blind** also hides speaker identity from reviewers; sponsor sessions are excluded
> from blind rounds by scope."*

The sentence I actually needed — *"Blind review. You will not see names, affiliations or links"* —
already exists in this product, written well, on the reviewer's own screen. The chair cannot get
to it.

**Cost:** 13 chair screens and the objective is unmet. I have to either break the promise
(sign in as one of my own reviewers) or make it on faith.

### 3. A volunteer who follows a review link is signed in and then dumped on "You have not started a proposal yet" — Serious, bug
**Where:** `/review` → `/login` → `/portal`. `.walk/14-review-401.png`, `.walk/15-sam-lands-in-portal.png`.

`/review` answers **401** with a page titled *"Something went wrong"*; its Sign in link has no
`next`; the sign-in lands on the speaker portal, whose empty state offers **Find an open call** as
the only primary button. One re-do, three screens of doubt, at the exact moment an unpaid
volunteer decides whether this is worth their evening. The organizer path does this correctly
(`/login?next=/admin`), which is what makes it a defect rather than a design.

### 4. The organizer's home page shows review 100% complete while a proposal has no reviews — Serious, taste
**Where:** `/admin`, "SCREENING 19/19 reviews" with a full bar. `.walk/02-admin-today.png`.

19 of 19 *assignments*, not 19 of 19 proposals. Directly beneath it, in small grey type: "1
proposal is short of quorum and cannot be decided." A chair who glances at this screen concludes
the round is finished. Two of the thirteen proposals had nobody or half a somebody on them.

### 5. Declaring a conflict of interest requires typing a database identifier — Serious, taste
**Where:** `/admin/proposals/{prp}/review`, Conflicts of interest panel. `.walk/11-proposal-review-0001.png`.

> **Reviewer's person id \*** — *`per_...` — from the pool or the person record.*

The single most important fairness control in the product is a primary-key entry box. The three
reviewers whose names I know are in a `<select>` two panels up the same page. Next to it:
"Domain (**company_domain** only)".

### 6. The chair cannot tell which reviewer wrote which review — Serious, taste
**Where:** `/admin/proposals/{prp}/review`. `.walk/11-proposal-review-0001.png`.

Both reviews are headed "Reviewer (blind round)". The Assignments table tells me Sam and Dana both
reviewed DFC27-0001; this page shows two scores and will not join them. If a volunteer is
rubber-stamping, or is the author's colleague, I cannot find that out from the product. Whether
the chair *should* be blinded is a real design question — but it is not stated anywhere, so I was
left assuming it was an oversight.

### 7. The reviewer's Submit button is inside a nested scroll region — Serious, taste
**Where:** `/review/{asg}`. `.walk/18-sam-scorecard.png`, `.walk/21-scorecard-scrolled.png`.

The document is 1201 px against a 900 px viewport, so the page barely scrolls. The SCORECARD
column is its own scroller: 878 px visible, **1792 px of content**. "Submit review" measures at
`top: 2027` — a full-page screenshot of this page does not contain the button that submits the
review, and neither did my first two looks at the screen. The sticky proposal panel beside it is a
good idea; the hidden scrollbar under the primary action is not.

### 8. Two screens disagree about when the round opens and closes, by seven hours — Serious, bug
**Where:** `/admin/events/{evt}/review` vs `/admin/rounds/{rnd}`. `.walk/03-admin-review.png`,
`.walk/06-round-settings.png`.

The round card: "Open **Aug 1, 12:00 PM** → **Sep 5, 12:00 PM**", with no timezone and no year.
The settings form: "Opens (America/Los_Angeles) 08/01/2026, **05:00 AM**", "Closes
(America/Los_Angeles) 09/05/2026, **05:00 AM**". I am the person who tells three volunteers when
the round shuts.

### 9. The proposal count contradicts itself between the nav and the page — Sand, bug
Sidebar badge: **Proposals 12**. The page it opens: **13 proposals**. `.walk/08-proposals-list.png`.

### 10. A proposal is ACCEPTED with 0 / 2 reviews and no screen says why — Serious, taste
DFC27-0013, "How We Cut Cold Starts to 40ms", Sponsor Session, no speaker listed. I can guess that
sponsor sessions bypass review — the round settings mention it in passing — but "I think it's the
sponsor rule" is not an answer to give a rejected speaker. `.walk/08-proposals-list.png`.

### 11. The Progress table silently omits the pool member who has done nothing — Serious, taste
Progress lists Sam, Dana and Elena, all at 100%. The Pool lists **four** people: the fourth,
Aisha Bello (META REVIEWER, load 0), does not appear. The screen whose whole job is "how far each
one has got" hides the only person who has not got anywhere.
`.walk/04-round-progress.png`, `.walk/07-round-pool.png`.

### 12. Submitting a review is not acknowledged — Sand, taste
The queue changes to "You are done" and the sidebar count moves 7 → 8. Nothing says "Your review
of DFC27-0011 has been recorded." For the one act I came here to perform. `.walk/23-queue-after-submit.png`.

### 13. A submitted review still offers "Save draft" and "Submit review" — Sand, taste
Revisiting a submitted review, the scorecard is live and editable — which correctly answers "can I
change my mind about the third after seeing the eighth". But the buttons are unchanged, and the
SUBMITTED pill is a thousand pixels away in a different scroll region. I pressed "Submit review"
on a review I had already submitted and hoped. `.walk/25-sam-review-after-submit.png`.

### 14. Verdict and Overall recommendation are the same opinion, asked twice — Sand, taste
Three options then seven, with nothing carried across. After I said "Maybe", "Neutral" was the
only consistent answer and the product made me find it. `.walk/21-scorecard-scrolled.png`.

### 15. The maker's vocabulary, on both sides of the seam — Sand, taste
Every one of these was on screen, caught by the probe or by eye:

| Term | Where |
|---|---|
| `INV-05-17` | Round settings, AI first-pass panel |
| `double_blind` | Round settings, the anonymity help-text |
| `double-blind` | The reviewer's sidebar — the same enum, a second spelling |
| `company_domain` | Conflicts of interest form |
| `per_...` | Conflicts of interest form |
| `prp_01JQ00007TM82PG4YJC0TE8WPA` | The bulk-assignment refusal |
| `(05)` | The reviewer's decline panel — a bare chapter number, to a volunteer |
| "Needs coi check" | A flag a reviewer is expected to pick |
| "ABOUT YOU" / "ABOUT YOUR TALK" | The *organizer's* proposal page: the applicant's own form labels, unrevoiced |
| `2026-08-08` / `Aug 1, 12:00 PM` / `12–14 May` / `sent 8 days ago` | Four date formats |

### 16. Three assignment tools stacked with no guidance — Sand, taste
"Assign a single proposal", "Auto-distribute" and "Filtered bulk assignment" sit down one page,
the last two near-identical twins side by side. I wanted "everything unread → Sam" and had to read
both descriptions to work out that Auto-distribute picks the reviewer for me and is therefore
wrong. `.walk/05-round-assignments.png`.

### 17. The Review section's four sibling links have no primary and do not persist — Sand, taste
The round card offers four identical outline buttons. Their destinations then carry no way back to
each other, and only one of them reveals a fifth tab (Pool). Two forced Back presses.

---

## The six dimensions

| | Score | The moment that decided it |
|---|---|---|
| **Orientation** | ★★★☆☆ | "One left … 7/8 … at two a day you finish 20 days before the round closes" is as good as this gets; two clicks away, the chair's own dashboard says review is 19/19 complete when two proposals are unread. |
| **The obvious next step** | ★★☆☆☆ | A volunteer who clicks a review link is signed in and shown a black button reading "Find an open call". |
| **Effort** | ★★☆☆☆ | Eight screens and twelve actions to learn which proposals nobody has read — an answer one column on one page already holds — and a conflict-of-interest form that wants a `per_…` copied from a URL. |
| **Forgiveness** | ★★★☆☆ | Save draft, Revoke, an editable submitted review and a refusal that explains itself — undone by a 401 that throws away where you were going and an error that names a ULID. |
| **Trust** | ★☆☆☆☆ | "Every reviewer you chose has a conflict of interest with this proposal" and "No conflicts declared against this proposal", about the same proposal, one minute apart. |
| **Craft** | ★★★☆☆ | "Anchoring is real — this is deliberate, not a bug" and `double_blind` are on screens two clicks apart. |

---

## ★★☆☆☆

**I finished by working around the product.** Sam's pile emptied and the handoff numbers matched
exactly — 1 assigned, 1 found. But the chair's first and stated objective was to verify the
anonymity promise rather than assume it, and after thirteen screens I had to take it on faith
while the sentence I needed sat on a page I am not allowed to open; and the product told me two
opposite things about a conflict of interest on a proposal one of my volunteers had already
reviewed. A chair who cannot verify the fairness they promised has to do the review by hand, which
is the spreadsheet I came here to stop using.

It is two rather than one because nothing was lost, every unread proposal was assigned, the
reviewer's evening was genuinely pleasant once he found his way in, and the reviewer-facing
screens are the best-written thing in this repository.

---

## The shortest path to three stars

Ordered, and nothing decorative in it.

1. **Make the two conflict statements agree.** The proposal's conflicts panel must list every
   conflict that applies to it, whatever scope it was declared against, and the refusal must name
   the reviewer and the reason. Until a chair can see the same fact on both screens, nothing else
   on this list matters.
2. **Put the reviewer's own sentence on the chair's screen.** *"Reviewers see the title, abstract,
   track, format and level. They do not see names, bios, affiliations or links."* — verbatim, on
   the round card and on the round settings page, replacing the `double_blind` help-text. It is
   already written; it is on the wrong side of the wall.
3. **Give `/review` the same sign-in treatment as `/admin`**: redirect to `/login?next=/review`
   rather than answering 401 on a page titled "Something went wrong", so a volunteer who follows
   the link lands in the queue and not on "You have not started a proposal yet".
4. **Make the dashboard's screening number count proposals, not assignments** — "9 of 11 proposals
   have the reviews they need" — so a full bar means the round is actually done.
5. **Put the REVIEWS IN column, or a link to it, inside the Review section.** The chair's central
   question currently lives five screens away in Intake.

Items 1–3 are load-bearing. If only one thing ships, ship 1.

---

## What I could not check

- **Whether the "conflict" on file for Sam is against a person, a proposal or a company domain**,
  and when it was recorded. Nothing on either surface shows it; both merely assert it exists.
- **What a META REVIEWER can see.** Aisha Bello holds that badge in the pool and no screen
  explains it, so I do not know whether my anonymity statement is true for her too.
- **Whether re-walking gives the same numbers.** I walked once. The seed's dates are relative
  ("closes in 21 days", "sent 8 days ago"), which is right, but I cannot confirm stability.
- **Reminding a reviewer.** "Remind selected" is on the Progress page with three checkboxes; I did
  not press it, because everyone was at 100% and a chair does not send a reminder to someone who
  has finished. The "Reminders: 3" column against each name is unexplained and unattributed.
- **The second, deeper round**, and the decide-then-notify seam. Out of scope for this walk.
- **Phone width.** Both roles here are at a desk; the reviewer's queue did render at 390 px when
  the new tab opened (`.walk/16-sam-queue.png`) and looked well-behaved, but I rated 1440 × 900
  and did not walk the phone properly.

---

## Written after the ratings, having broken character

Nothing below changed a rating.

The two contradictions I could not resolve on screen have plausible mechanical explanations that
the screens simply do not surface:

- The **conflict scope** is almost certainly the difference. The "Declare conflict" form on the
  proposal review page offers an *Against* dropdown with Proposal / Person / Sponsor / Company
  domain, and the panel above it is headed "conflicts declared **against this proposal**". A
  person-scoped or domain-scoped conflict would be enforced by the assignment engine while never
  appearing in that panel. That makes finding 1 a presentation defect rather than an enforcement
  one — which is *worse* for this journey, not better, because the chair's screen is confidently
  wrong rather than merely silent. It does not explain how Sam's already-submitted review of
  DFC27-0010 coexists with "proposals it touches are withheld from your queue".
- The **seven-hour date disagreement** is the shape of a UTC-versus-local rendering split: Aug 1
  12:00 UTC is Aug 1 05:00 in America/Los_Angeles. The settings form labels its timezone; the
  round card does not label anything, which is what makes the pair unreadable.

I did not open any application source during either sitting, and the two explanations above were
reasoned from the screens after the report was written rather than from the code.
