# A first-time speaker submits a talk, across two sittings

Walked 14 August 2026 against the shipped seed (`npm run dev`, DevFlow Conf 2027). Journal and
screenshots in the walk's scratchpad output; every screenshot named below is from that run.

## Who I was

**Dana Whitmore**, an engineer who looks after the build and test platform at a mid-size
company. I have given this talk once, internally. I have never used this product and have
never spoken at this conference. I followed a link from a newsletter.

**What I came to do:** get my talk in before the call closes.

**What done looks like to me:** something on a screen that says the talk is in, and enough of
a sense of what happens next that I would not email the organizer to check.

**What I would have done instead:** given up and submitted next year. Speaking is not my job.

**The trip:** Sunday evening on a phone, interrupted part-way through, back on Tuesday at a
laptop to finish.

## Did I finish?

**No — not as Dana.** The talk in the seed got submitted, but only because the walk broke
character in the second sitting and pasted a URL that Dana had no way to know. On the laptop,
with the draft saved and the session still signed in, there was no route from any screen back
to my own draft. That is where a real first-timer stops.

## What it charged me

| | |
|---|---|
| Screens visited | 14 (10 distinct) |
| Actions | 14 |
| Answers typed | 11, of which 6 reached the proposal |
| Answers typed twice | 2 — the title and the abstract, lost between sittings |
| Re-dos | 3 |
| Actions before the first real question | 4, plus 3 fields of account admin |
| Answers it already had and asked for anyway | 1 — which call I was submitting to |
| Devices | 2 · **Sittings** 2 · **Draft survived** yes · **Typing survived** no |

## What confused me

Quoted from the journal as written on the screen, before I knew the answer.

- "Have I submitted or not? The page says both." — the portal, second sitting
  (`09-your-talks-the-portal-home…png`). The line under my talk says *Draft. Nothing is waiting
  on you.* The timeline underneath puts the marker labelled **now** on **Submitted**.
- "What does ACCEPTED mean here? It is the word I most want to see from a conference and it is
  being used for something else." — step 1 (`05-step-1-about-you.png`), where my own name
  carries a green ACCEPTED badge before I have written a word about the talk.
- "Is this still DevFlow Conf? Nothing on this screen says so." — the sign-in screen
  (`02-sign-in-to-podium.png`). I clicked a button on a DevFlow page and landed on a page
  branded PODIUM, a name I had never heard.
- "Is 16:59 my time or theirs?" — the call for proposals. The deadline is *30 Apr 2027, 16:59
  (America/Los\_Angeles)*, which is both a time nobody sets a deadline at and a timezone I do
  not live in. Two screens later the same deadline appears as *16:59* with no timezone at all.
- "Why does it say resubmission? I have submitted once." — the confirmation page
  (`14-after-submitting.png`), whose revision history has exactly one row, labelled
  RESUBMISSION.
- "What am I supposed to do first?" — the portal after submitting
  (`15-your-talks-after-submitting.png`), where a pink card headed **DO THIS FIRST** sits
  directly under the sentence *Nothing is waiting on you*. The card's heading and its body are
  the same six words twice.
- "When do I hear back?" — asked on the first screen, never answered on any of the fourteen.
  The confirmation says *once the committee has decided*, which is not a date.

## What took more than one attempt

- **Starting the submission.** The button on the conference's own page goes to a sign-in
  screen whose primary action is Sign in — which is not a thing a first-timer can do. The
  thing I could do was four grey words under the button.
- **Getting back to my draft.** I tried the only link I had (the CFP page — offers me the
  beginning again, as if I were a stranger), then the nav item called *Your talks* (points at
  the page I was already on), then *Profile*. Nothing opens a draft. This is the re-do that
  ended the journey.
- **Being told my work was safe.** I typed a title and an abstract on the phone and put it
  down mid-sentence. Nothing on the screen said whether that was safe. It was not.

## What was not intuitive

Places where what I did was reasonable and the product expected something else.

- **I typed into the preview form on the public page**, because it is right there and it is
  the thing I came to do. The caption says nothing is saved until you start; it is honest, and
  it is under the heading rather than beside the box I was typing in. The fields let me type
  and then dropped it.
- **I read the four steps on the public page to size up the job**, and it told me steps 3 and
  4 had *No questions on this step*. Step 3 has three, one required. I budgeted for a form
  that stopped at step 2.
- **I expected the first question to be about my talk.** It is a third-person biography, which
  is the hardest writing on the whole form and the least connected to why I came.
- **I read a required asterisk on "May we record and publish this session?" as "you must
  agree".** It is not — leaving it unticked is recorded as "No" and submits fine. I nearly
  ticked something I did not mean.
- **I pressed "Start a submission" a second time expecting either my draft or a duplicate.**
  It correctly resolved to my existing draft, and then showed me a page that mentions neither.

## What I lost by leaving and coming back

Measured against every question worth asking at the moment of return.

| | |
|---|---|
| Is my work here? | The draft, yes. The title and abstract I had typed and not saved, no — about sixty words |
| Do I know it is here? | No. Nothing told me, on the way out or on the way back |
| Actions to get back to where I stopped | **Unbounded.** No screen reaches the draft. Same device, browser history would have saved me; I had changed device |
| Does it tell me what is left? | No. The one page that does — the proposal page, with *Finish and submit — closes in 260 days* — is the page I could not reach |
| Does it still know what it knew? | Yes. The bio, the call, my name, my place in the form |
| Did anything change under me? | No |
| What arrived in between? | Nothing. The product emails on submission (`proposal.submitted` is in the outbox) and sends nothing when a draft is created or saved |

**At the moment of leaving, the product says nothing at all.** No save state, no "we've kept
this", no warning. That silence is what makes people start again from scratch — or, here,
believe they already finished.

## Moments of care

Every one of these is somebody having thought about Dana, and they are the reason this product
is one change away from being much better than it scored.

- **The whole form is inspectable before you sign up.** Every step, every question, every
  dropdown, on the public page. I have not seen another CFP do this and it is the reason I
  started at all.
- **"As you write it. It is never split into first and last."** Under the name field on
  sign-up. The first sentence all evening written by someone thinking about me.
- **"Draft created."**, and my name already in the speaker table as PRIMARY, one action after
  I made an account.
- **"Save draft" beside "Save and continue" on every step.** Leaving is a designed action —
  which is what makes the silence around the *unsaved* work so surprising.
- **The review screen** (`13-step-4-review-your-answers.png`): every answer grouped by step,
  each group with its own Edit, and the ones I skipped honestly marked *Not answered*. This is
  the product at its best, and the first time I felt confident since sign-in.
- **The timeline** — Submitted, Reviewed, A decision, Confirm your slot, Onboarding, On stage,
  each with a sentence saying what it will mean. It answers the question the whole journey
  kept raising, and it is the best thing in the product.
- **"Finish and submit — closes in 260 days."** The one place the deadline is expressed in
  something a human can act on.
- **"Your talks."** The nav is in my language, not the schema's.

## Findings

### Fatal

**F1 · A saved draft cannot be reached from any screen.** *(bug — certain)*
Second sitting, `/portal`, desktop, `09-…png` and `10-…png`. Signed in, one draft, and the
portal's summary of it is not a link; there is no *Continue*; `/portal/proposals` redirects to
`/portal`; the nav's *Your talks* points at the page you are on. The proposal page that has
*Continue editing* on it exists at `/portal/proposals/:id` and nothing links to it. Confirmed
against the seeded speaker too, so it is not a new-account artefact: her portal shows one talk
— last year's, archived — and links to none of her live work. **Cost:** the journey ends.
*What would have worked:* the portal's next-action card, which appears once the proposal is
submitted, appearing for a draft as well and saying *Finish your proposal*.

**F2 · The portal says Draft and Submitted about the same proposal, on the same screen.**
*(bug — certain)* `09-…png`. The heading reads *Draft. Nothing is waiting on you.*; the
timeline directly under it puts **now** on **Submitted — To DevFlow Conf 2027 Call for
Papers**. **Cost:** I could not tell whether I had submitted, which is the only fact I came
for. Read the timeline and you close the tab believing you are done, with no title and no
abstract in the proposal. This is the worst outcome the product can produce.

### Serious

**S1 · Typed-but-unsaved answers are dropped with no warning.** *(taste — certain)*
Step 2, phone, `07-mid-sentence…png`. Sixty words gone. The product knows how to save — there
is a *Save draft* button and a green *Saved.* bar — so the gap is that nothing autosaves and
nothing warns on the way out. **Cost:** two answers re-typed. *What would have worked:* keep
the field values, or one line saying they are not kept.

**S2 · The conference disappears at sign-in and sign-up.** *(taste — certain)*
`02-…png`, `03-…png`. Header, heading and body all say Podium; the event I came from is named
nowhere on either screen, and the sign-up blurb explains reviewing and running events to
somebody who wants to submit a talk. **Cost:** a real *did I click the wrong thing* moment on
the screen where a first-timer is most likely to leave.

**S3 · The sign-in screen's primary action is the one a first-timer cannot take.** *(taste —
certain)* `02-…png`. Big black *Sign in*; *Create one.* is small grey text under it. Every
person arriving from a public CFP link is, by definition, likely to be new.

**S4 · The public preview under-reports the form.** *(bug — high confidence)*
`01-…png` says *No questions on this step* under steps 3 and 4; step 3 has three questions,
one required (`12-step-3-logistics.png`). The page's whole promise is that you can size up the
job before you sign up. **Cost:** the last step of the form is a surprise. (Conditional fields
are the likely cause — a step whose questions depend on answers you have not given yet should
say that rather than claim to be empty.)

**S5 · "ACCEPTED" is used for something that is not acceptance.** *(taste — certain)*
`05-…png`, `14-…png`. A green ACCEPTED badge sits beside my own name in the speaker table from
the moment the draft exists. On a conference site that word means one thing to a speaker.
*What would have worked:* the badge saying what it means for me — *you*, or nothing at all,
with the status reserved for co-speakers who have yet to confirm.

**S6 · "DO THIS FIRST" fires when nothing needs doing.** *(taste — certain)*
`15-…png`. The card is the loudest thing on the page, sits under *Nothing is waiting on you*,
repeats its own heading as its body, and its button opens the proposal I had just come from.

### Sand

- **D1** The deadline is *16:59 (America/Los\_Angeles)* on the public page, *16:59* with no
  timezone on the next screen, and *closes in 260 days* on the page I could not reach. Only
  the third is any use.
- **D2** A one-option chooser (`04-…png`) asks which call I am submitting to, four screens
  after I chose it by clicking a button on that call's own page.
- **D3** The first submission's revision history is labelled RESUBMISSION (`14-…png`).
- **D4** The proposal is called *Untitled proposal* on every screen until step 3, including the
  screen where I am writing its title.
- **D5** The open-call banner on the public page is pink (`01-…png`). Good news in the visual
  language of a warning; it is the first thing the eye lands on.
- **D6** The wizard's step chips are 17 px tall on a phone (instrument reading, all wizard
  screens) — the navigation between steps is the smallest touch target in the flow. Several
  header links are also under 44 px.
- **D7** The public CFP page at 1440 px is the phone layout centred: a ~340 px column in a
  1440 px window (`08-back-at-the-only-link-i-have.png`). Every other screen uses the width.
- **D8** The confirmation does not show Logistics back to me, so the recording answer I
  deliberately gave is not visible anywhere after submitting.
- **D9** Nothing anywhere says when a decision is due.
- **D10** Step 1 opens with a required third-person biography — the hardest writing on the
  form, before any question about the talk.
- **D11** My profile reads *0% complete* on both portal visits and nothing ever suggests I do
  something about it, while the timeline says onboarding will want exactly that.

### Clean

The instruments found no horizontal scroll at either width, no unlabelled fields, no console
errors, no failed requests, and no model vocabulary on any screen — no invariant citations, no
column names, no context numbers, across all fourteen. The product's rule about speaking the
user's language is holding everywhere except the word ACCEPTED and the word RESUBMISSION,
which are English words being used in the maker's sense rather than mine.

## The six dimensions

| | | |
|---|---|---|
| **Orientation** | ★★☆☆☆ | The step chips, the timeline and *closes in 260 days* are real orientation; the conference vanishes at sign-in, the deadline is in a timezone I do not live in, and on my return the same screen said Draft and Submitted |
| **The obvious next step** | ★★☆☆☆ | On the sign-in screen it is the action I cannot take; on my return there is no next step at all; after submitting, the loudest card demands something that does not exist |
| **Effort** | ★★★☆☆ | Six real answers is a fair price, and it reused my name — but it charged me three fields of account admin first, re-asked which call I was on, and made me type the abstract twice |
| **Forgiveness** | ★☆☆☆☆ | Sixty words dropped without a word, and no way back to my own draft. This is the dimension the journey died on |
| **Trust** | ★★☆☆☆ | The review screen and the submission email are straight with me; against that, one screen told me two contradictory things about the only fact I cared about |
| **Craft** | ★★★☆☆ | The wizard and the portal are handsome and consistent, and the timeline is genuinely good work; the public page collapses to a phone column on a laptop, the step chips are 17 px, and one card says the same six words twice |

## ★☆☆☆☆

**I could not finish, and I lost work on the way.** Both halves of the bottom rung, in one
journey. The sentence that decided it: *Draft. Nothing is waiting on you.* sitting above a
timeline whose current marker reads **Submitted** — on a screen with no way to open the draft
it is describing. A speaker who believes that goes away and waits to hear back about a talk
that has no title in it.

This rating is for this journey — a first-timer, two sittings, two devices — and not for the
product. Almost everything after the point where Dana got stuck is three or four star work,
which is exactly why the score is worth reporting rather than softening.

## The shortest path to the next star

Three changes. Nothing else is on this list.

1. **Link the draft from the portal.** The next-action card already exists and already appears
   once a proposal is submitted; make a draft produce one, reading *Finish your proposal*, with
   the button going to `/portal/proposals/:id`. Removes F1, which is the whole of the second
   sitting.
2. **Stop the portal claiming a draft is submitted.** The timeline's *now* marker belongs on
   the stage the proposal has actually reached. Removes F2.
3. **Do not silently drop what somebody typed.** Either keep the values across a lost session,
   or put one line by the buttons saying they are not kept until you press Save. Removes S1.

Those three take this journey from *cannot finish* to *finishes, having been told the truth* —
one star to three.

The fourth star is a different, longer list, and the first four items on it are: name the
conference on the sign-in and sign-up screens (S2); lead that screen with *Create an account*
for anyone arriving from a public call (S3); make the public preview honest about steps whose
questions depend on later answers (S4); and stop using ACCEPTED for something that is not
acceptance (S5).

## What I could not check

- **The same-device return.** This walk changed device between sittings, which is what the
  journey specifies. Coming back on the same phone, browser history would probably have
  reached the draft — the finding in F1 is that no *screen* does, not that no route exists.
- **Email as a way back in.** Nothing is sent when a draft is created, so there was nothing to
  test. If a draft email is ever added it changes F1's severity, not its cause.
- **Adding a co-speaker**, which the form offers and this journey never used.
- **The phone at 320 px**, and keyboard-only operation. This walk ran at 390 px and 1440 px.
- **Editing after submission**, beyond noticing that the button exists.

## Read after the walk, changing nothing above

Broken character to locate two things, for whoever picks this up:

- The proposal page with *Continue editing* on it is real, complete and good
  (`/portal/proposals/:id`). F1 is a missing link, not a missing screen — which is why it is
  the cheapest fatal defect I have seen.
- The submission email exists and works (`proposal.submitted`, visible in the organizer's
  outbox), so the machinery for telling a speaker something between sittings is already there
  and simply is not used at the moment a draft is saved.
