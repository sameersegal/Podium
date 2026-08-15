# The scenario queue

Ten scenarios for the [`product-taste`](../../.claude/agents/product-taste.md) agent, each one a
**role and a business objective** — the thing the conference actually needs to happen, walked by
the one person whose job it is. One scenario per run, one report per scenario.
[`README.md`](README.md) is the record of what has been walked.

These sit deliberately high. A conference does not need "a submission form"; it needs a
programme it can defend, filled by speakers who stayed, published in time to sell tickets, with
sponsors getting what they paid for. Each scenario is one of those outcomes, and the walk is
whatever it takes to reach it. Every entry then lists **deeper cuts** — narrower journeys inside
the same objective, for when the high walk shows where the pain is and it is worth going back
with a finer instrument.

Nothing here says which screen to press, what any screen contains, or what the product calls
anything. The agent learns that from the screen; a queue that spoils the flow destroys the
measurement it exists to feed. Every fixed value below is a fact about the *world* or about the
*person* — who they are, what they came to type, which talk they came to deal with — never about
the product's surface. Keep that line when you add one.

The roles come from the functional rubric in `../killmysaas-evals`, which asks whether a
conference platform *can* do each of these. This queue asks the other question: whether the
person doing it would come back. Every entry carries a **Traces to** line back to the eval area,
so a low score there and a low star rating here can be read together — but the two never share a
verdict.

---

## Comparability

A star rating is only worth having if the same walk next month produces a number you can put
beside this one. Six rules make that true, and they bind every scenario in this file.

**1. A fresh world per scenario.** Stop `npm run dev` and run it again before each walk, and
`rm -rf .walk` with the browser closed. Scenarios mutate the seed — S1 opens a call, S4 completes
tasks, S6 moves a live schedule — so a walk that inherits the previous walk's leftovers is
measuring a world nobody else will ever see. Confirm the reset took (`curl -s
localhost:8787/dev/ids`) before the first screen.

**2. One identity, spelled out.** Every scenario names exactly who signs in. Where it needs
somebody the seed has never met, it is always the same invented person, so two runs create the
same account:

> **Alex Mercer** · Staff Engineer, Northwind Freight · `alex.mercer@northwind.example` ·
> password `TasteWalk2027!`

**3. Fixed inputs.** Where the person types something substantial, the exact text is in the
scenario. Type it verbatim, including the punctuation. Several of these strings are the same
ones `../killmysaas-evals` types into its own runs, on purpose — the same data through two
different questions.

**4. Fixed targets.** Where the job is done *to* something — a proposal, a session, a sponsor —
the scenario names it. Where the world offers several and the person would not care which, the
tie-break is always **first alphabetically by title**, and the report records which one it got.

**5. Fixed sittings and widths.** Each scenario lists its sittings in order, each with a
viewport: **390 × 844** is the phone, **1440 × 900** is the laptop. Sittings are separated by
`browser_close`; where a scenario says *new device*, delete `.walk/profile` while the browser is
closed.

**6. The same numbers, every time.** Every report carries the standard counts from C in the agent
file — screens, actions, fields, navigations, re-dos, actions before the first useful thing,
answers the product already had. Each scenario then names two or three more that are specific to
its objective. Those are the columns that make two runs a trend rather than two anecdotes.

And a **stop rule**, per scenario: the point at which this person would genuinely have given up.
Reaching it is a result, not a failed run — write the report from where you stopped and say so.
A walk that grinds past the point a human would have quit produces numbers no future run will
reproduce.

## Running one

Hand the agent a single scenario block, verbatim, and nothing else from this file. It will ask
for whatever the block leaves out, so leaving something out on purpose biases the walk. When it
comes back:

1. The report lands at `docs/taste/<date>-<slug>.md`, using the slug under the heading.
2. Add its row to the table in [`README.md`](README.md).
3. Mark it walked in the status table below, with the star rating.

Walk them **one at a time** — they share one browser and one seeded world. Who exists in that
world is in
[`journeys.md`](../../.claude/agents/product-taste/references/journeys.md).

## Status

| | The objective | Whose job it is | Walked | ★ |
|---|---|---|---|---|
| S1 | Fill the programme with talks worth watching | The organizer | [2026-08-15](2026-08-15-organizer-fills-the-programme.md) | ★★☆☆☆ |
| S2 | Get a talk in, and find out whether it got in | A first-time speaker | [2026-08-15](2026-08-15-speaker-submits-and-hears-back.md) | ★☆☆☆☆ |
| S3 | Judge the field fairly enough to defend the result | The chair, then a reviewer | [2026-08-15](2026-08-15-chair-and-reviewer-judge-the-field.md) | ★★☆☆☆ |
| S4 | Turn a yes into a talk that actually happens | An accepted speaker | [2026-08-15](2026-08-15-accepted-speaker-gets-to-the-stage.md) | ★☆☆☆☆ |
| S5 | Have every asset in hand before the doors open | Speaker operations | [2026-08-15](2026-08-15-operations-closes-the-supply-chain.md) | ★☆☆☆☆ |
| S6 | Publish a schedule that survives contact with reality | The organizer | [2026-08-15](2026-08-15-organizer-publishes-a-living-schedule.md) | ★☆☆☆☆ |
| S7 | Let the world find the conference and plan around it | An attendee, and the site's owner | [2026-08-15](2026-08-15-public-surface-holds-up.md) | ★☆☆☆☆ |
| S8 | Deliver what the sponsors paid for | Partnerships, then a sponsor | [2026-08-15](2026-08-15-partnerships-delivers-the-package.md) | ★☆☆☆☆ |
| S9 | Build a speaker bench that outlives one event | The organizer | [2026-08-15](2026-08-15-organizer-builds-the-bench.md) | ★★☆☆☆ |
| S10 | Get off the incumbent and run this conference here | A new organization, from nothing | — | — |

‡ S2 has been walked once at the narrow cut — a first-time speaker submitting, phone then laptop
([report](2026-08-14-first-time-speaker-submits.md), ★☆☆☆☆). The full objective, which runs to
hearing back, has not.

---

## S1 — Fill the programme with talks worth watching

`organizer-fills-the-programme`

**The objective.** The conference has dates, rooms and a ticket page, and nothing to put in
front of anybody. By the end, a call has been out in the world long enough to have brought in
talks the organizer would be pleased to announce.

**Role.** The person running this conference. They have run it twice on something costing five
figures a year and have moved here to stop paying. They know exactly what they want to ask
speakers; they have never seen this product's version of any of it.

**Goal, in their words.** "Get a second call live tonight so it goes in tomorrow's newsletter,
and know it's asking the right questions."

**Fixed for every run.**

- Signed in as **Jordan Alvarez** (`organizer@devflowconf.example` / `PodiumDemo2027!`).
- The call being opened is a **new, second call for the 2027 event**, alongside the one already
  running — a workshops call. Do not edit the existing one; a call with submissions already
  against it is not a thing a person would experiment on, and editing it would poison every
  other scenario in this file.
- Name it exactly **`Workshops 2027`**, closing **30 March 2027**.
- It must ask two questions that are this organizer's and not any product's default, worded
  exactly:
  - **`What will people have built by the end?`** — required, long answer.
  - **`How many people is this workshop good for?`** — a choice of `Up to 20`, `Up to 40`,
    `No limit`.
- Before the sitting ends, look at the result the way an outsider would: signed out.

**Sittings.**

1. **1440 × 900.** Tonight. Build it and get it live.
2. **1440 × 900, same laptop, after `browser_close`.** Three days later, first thing: they open
   it to see how it is going, and nothing more.

**Finish line.** A URL they would paste into a newsletter, which loads for somebody signed out
and shows both of their two questions.

**Stop rule.** They give up on a question the product will not let them ask, and ship the call
without it — record which one, and carry on to the finish line. They abandon the whole scenario
only if the call cannot be made public at all.

**Record these.** How many actions between deciding to open a call and the call being publicly
reachable. Whether the closing date they typed appears anywhere in a timezone that is not theirs.
How many actions it took, on the return sitting, to learn whether anything had come in.

**What failure costs.** A call that asks the wrong things cannot be fixed after speakers start
answering it. This is the one screen in the product with a deadline set by somebody else's
calendar.

**Where it can go wrong.** Whether they can see what a speaker will see without becoming one.
Whether asking their own question is a normal act here or an advanced one. Whether anything they
set up was public before they meant it to be — and whether they could tell either way. On the
return: whether the product tells them how it is going, or hands them rows to count.

**Traces to.** Call for Papers (CFP-S1).

**Deeper cuts.** Asking a question the product did not anticipate. Changing a call mid-flight
that already has submissions against it. The last day before a deadline, when everything arrives
at once.

---

## S2 — Get a talk in, and find out whether it got in

`speaker-submits-and-hears-back`

**The objective.** A working engineer with a good talk ends up on the programme — or ends up
turned down in a way that leaves them willing to try again next year. Speakers are the supply
side; a conference that loses them at the form has no product.

**Role.** Alex Mercer, who has never used this product and never spoken at this conference. They
have given this talk internally once. They do not know what a "track" is called here or how long
a review takes.

**Goal, in their words.** "Get my talk in before it closes, and then find out."

**Fixed for every run.**

- **Alex Mercer**, signing up during the walk. Never a seeded persona — Priya's history is
  exactly the state this scenario is not measuring.
- The talk, typed verbatim wherever the product asks for each part:
  - **Title:** `Taming 40-Minute CI: Incremental Builds at Monorepo Scale`
  - **Abstract:** `Our monorepo CI took 40 minutes on a good day. This talk walks through how we
    cut it to 6 minutes with content-addressed caching, remote execution, and a test-selection
    model — including the two migrations that failed first. You'll leave with a decision
    framework for which incremental-build investments pay off at which repo sizes, and the
    graphs to convince your platform team.`
  - **Bio:** `Alex Mercer is a Staff Engineer at Northwind Freight, where they look after the
    build and release tooling forty teams depend on.`
  - Wherever a length, a track and an audience level are asked for, the answer is a **30-minute
    talk**, on **platform or infrastructure**, for an **intermediate** audience. If the product's
    words for these differ, pick the nearest and record what you picked.
- Sitting 1 stops **deliberately, part-way**, at the first moment a real person interrupted on a
  Sunday evening would stop — after answering at least one substantial question but before
  finishing. Record what was on the screen at that moment.

**Sittings.**

1. **390 × 844.** Sunday evening, from a link. Get as far as the interruption.
2. **1440 × 900, new device** (delete `.walk/profile` while closed). Tuesday. Finish and send.
3. **1440 × 900, same laptop.** Later: come back to find out what happened, having received
   nothing that told you to.

**Way in.** The public call for proposals at `/e/devflow-conf-2027/cfp/main`, signed out, as
from a newsletter link. Never the portal — the trip from one to the other is a third of what is
being rated.

**Finish line.** Something on a screen that says the talk is in, and — by the end of sitting 3 —
an answer to "what is happening to it?" that they got without emailing anybody.

**Stop rule.** Alex abandons and submits somewhere else if they hit the same wall three times,
or if sitting 2 finds the Sunday work gone. Either is the report.

**Record these.** How many of sitting 1's answers survived to sitting 2. Actions in sitting 2
before being back where they stopped. Whether anything at all arrived between the sittings, and
whether it got them back in one action.

**What failure costs.** Every abandoned submission is a talk the conference never got to
consider, and it leaves no trace anywhere in the product for anybody to notice.

**Where it can go wrong.** Whether they can tell what will be asked of them before they start.
Whether the account they must make feels like a cost or a service. What the product does at the
moment they stop. Whether they are *told* their work survived rather than having to discover it.
Whether waiting has any texture at all, or is silence.

**Traces to.** Call for Papers (CFP-S2).

**Deeper cuts.** Editing a submission after sending it. Adding the colleague you are presenting
with, remembered as an afterthought. Reading a rejection.

---

## S3 — Judge the field fairly enough to defend the result

`chair-and-reviewer-judge-the-field`

**The objective.** A pile of proposals becomes a ranked, defensible set of decisions, produced by
volunteers who will do this again next year. The output is not scores; it is a result the chair
can stand behind in public and the reviewers still feel good about.

**Role.** Two people in sequence, and the seam between them is the point. First the programme
chair, who has strong views about fairness and one week of three volunteers' attention. Then Sam
Whitfield, reviewing as a favour — unpaid, not staff, not coming back tomorrow if tonight goes
badly.

**Goal, in their words.** Chair: "Satisfy myself that reviewers see the right things and not the
wrong ones, and get everything that nobody has read yet in front of somebody." Reviewer: "Get
through my pile tonight, honestly."

**Fixed for every run.**

- Sitting 1 as **Jordan Alvarez**; sitting 2 as **Sam Whitfield**
  (`reviewer@devflowconf.example`), both on `PodiumDemo2027!`.
- The chair's specific worry, which is what they are trying to answer: **can a reviewer work out
  whose proposal they are reading?** They will not send another invitation until they know.
- The chair must find out **how far along each of their reviewers is** — by name, not in
  aggregate.
- The chair's actual output is a handoff: **everything nobody has read yet goes to Sam
  Whitfield.** The world starts with reviews already done on some proposals and none on others;
  finding out which is which is part of the job, and the report records what the chair concluded
  and what they assigned.
- Sam then scores **every proposal in front of them**, in the order the product offers, giving
  the same judgement each run so two runs' scores are comparable: **the middle of the scale**,
  with the comment `Strong practical content and a clear narrative arc; the abstract could name
  the specific tooling used.` on the first one and `Solid, and I would be happy to see it
  programmed.` on every other. If more than one number is wanted, put every number in the middle.
- Sam records the size of the pile **before** starting and again at the end.
- **If Sam's pile is empty**, that is the finding, not a dead run: the chair's handoff did not
  land, or did not land where the reviewer looks. Record what each of them saw and stop there.

**Sittings.**

1. **1440 × 900**, as the chair. One sitting.
2. **1440 × 900, new device** (delete `.walk/profile` while closed), as Sam. One sitting, one
   evening's goodwill — about an hour of a real person's patience.

**Finish line.** The chair can state out loud what a reviewer can and cannot see, having checked
rather than assumed; everything unread is assigned; and Sam's pile is empty.

**Stop rule.** Sam stops after **three consecutive proposals** where getting from one to the
next cost more than one action, and says the queue was not worth the evening.

**Record these.** Whether what the chair assigned is what Sam found waiting — the number on each
side, and whether they match. Actions per proposal, averaged over the pile, and the actions
spent in the seam between finishing one and starting the next. Whether anything on screen told
Sam something about an author they were not supposed to know. Whether the chair could verify
their anonymity promise from the product or only take it on faith.

**What failure costs.** Volunteer reviewers are recruited on goodwill and lost silently. A chair
who cannot verify the anonymity they promised has to either break the promise or do the review
by hand.

**Where it can go wrong.** Whether who reviews what is inspectable. Whether an obviously
conflicted reviewer is something the product knows or something the chair must remember. On
Sam's side: whether they can see how much is left without counting; whether they can tell what a
score means here before giving one; whether they can change their mind about the third after
seeing the eighth.

**Traces to.** Abstract Management (ABS-S2, ABS-S3), Call for Papers (CFP-S3).

**Deeper cuts.** A second review round with a different shape. The chair reading aggregates and
deciding, then telling everybody — the moment where deciding and sending must stay two acts.
Chasing a reviewer who has not started.

---

## S4 — Turn a yes into a talk that actually happens

`accepted-speaker-gets-to-the-stage`

**The objective.** Between "we'd love to have you" and somebody standing on a stage sit a dozen
small obligations — confirming, a bio, a photo, slides, a form to sign. Every one is a chance to
lose a speaker who has already said yes, and losing one at this stage costs a hole in the
programme.

**Role.** A speaker who has just been told yes and is delighted. They have never used this
product beyond submitting. They are not an administrator and did not sign up to be one.

**Goal, in their words.** "Do whatever they need from me, and stop worrying that I've missed
something."

**Fixed for every run.**

- Signed in as **Priya Raman** (`speaker@devflowconf.example` / `PodiumDemo2027!`) — here her
  history is the point, not a contaminant: she is on the programme.
- The job is **everything currently being asked of her**, not a list from this file. Record what
  that turned out to be, in the product's words, as the first line of the report — two runs
  disagreeing about that list is itself a finding.
- Where a photo is wanted: `../killmysaas-evals/fixtures/headshot.png`. Where a document or
  slides are wanted: `../killmysaas-evals/fixtures/slides.pdf`. If those are not on the machine,
  any PNG and any PDF, named in the report.
- Where free text about her talk is wanted, the answer is the title and abstract exactly as they
  already stand — she is confirming, not rewriting.
- Sitting 1 is **five minutes** of elation and covers as much as five minutes covers. Stop there
  even if one more click would finish it.

**Sittings.**

1. **390 × 844.** The five minutes right after the good news.
2. **390 × 844, same phone.** Three days later, triggered by whatever the product sent — or, if
   it sent nothing, by her own guilt, which is itself the finding. Finish everything.

**Finish line.** Nothing is left with her name on it, **and she can see that nothing is left**.
Certainty, not absence of evidence.

**Stop rule.** She stops and emails the organizer if she cannot tell what is outstanding after
five actions of looking. Record it as the finish.

**Record these.** How many separate places she had to visit to satisfy one list. How many
deadlines she saw, and how many were in a form she could act on without converting anything.
Actions in sitting 2 before she knew what was left.

**What failure costs.** Speaker deliverables are the conference's critical path — no slides, no
talk; no bio, no marketing. The chase is the largest recurring cost in the organizer's week, and
every ambiguity here becomes an email somebody has to send.

**Where it can go wrong.** Whether what is being asked exists as one list. Whether replacing
something she already sent is normal or frightening. Whether marking something done is her claim
or the product's judgement, and whether the two ever disagree. Whether sitting 2 starts where
sitting 1 ended.

**Traces to.** Speaker Management (SPK-S2), Content Management (CNT-S2).

**Deeper cuts.** Uploading a replacement two days before the event. Being asked for something you
have already given. Checking your own public page looks right before sending the link to your
employer's marketing team.

---

## S5 — Have every asset in hand before the doors open

`operations-closes-the-supply-chain`

**The objective.** Someone has to answer "are we ready?" with a number rather than a feeling,
chase exactly the people who are behind, and get the final files to an AV contractor who will
never have an account here.

**Role.** Riley Chen, speaker operations. Their whole week is that everybody's bits arrive. They
are not the boss and cannot change a deadline on their own authority.

**Goal, in their words.** "Know who's behind, nudge exactly those people and nobody else, and
get what I've got to AV."

**Fixed for every run.**

- Signed in as **Riley Chen** (`riley.chen@devflowconf.example` / `PodiumDemo2027!`) — speaker
  operations, deliberately not the organizer. What this role cannot see is part of the trip.
- Three things, in this order, and each is finished before the next is started:
  1. **Write down the list**: every speaker who owes something, and what. Copy it into the
     report verbatim as the product presented it.
  2. **Nudge exactly those people** — one message, in the conference's voice, to the people on
     that list and no one else. Before sending, write down who the product says will receive it.
  3. **Get every final file out** in whatever form somebody without an account could use, and
     write down which speakers are missing from it.
- The nudge says, wherever the product lets them write: `A quick reminder that we still need a
  couple of things from you before DevFlow Conf. Anything you can do this week helps us a lot.`
- Where a count is displayed, record it. Where none is, record that they had to count by hand.

**Sittings.** One, **1440 × 900**.

**Finish line.** A list of who is behind, those people contacted, files in hand, and a named set
of speakers whose files are missing.

**Stop rule.** Riley stops and opens a spreadsheet the moment they have counted the same thing
by hand twice. Say so; that is the finding this scenario exists to catch.

**Record these.** Whether "who is behind" was answered by the product or assembled by hand — and
if assembled, the actions it took. Whether they could see the recipient list before sending.
Whether the export named files in a way a stranger could use.

**What failure costs.** This work happens under time pressure with no slack left. A dashboard
that cannot show *absence* turns into a spreadsheet, and the spreadsheet becomes the system of
record for the rest of the year.

**Where it can go wrong.** Whether the message going out sounds like it came from the conference.
Whether anything records that they sent it. Whether one person asking for an extra week is a
normal grant or a schema change. Whether "the final version" is unambiguous when a speaker
uploaded three. Whether reaching somebody without an account is supported or a workaround.

**Traces to.** Speaker Management (SPK-S3), Content Management (CNT-S1, CNT-S3).

**Deeper cuts.** The bulk message, and everything that can go wrong in what it says. The single
extension. The export, and what the folder looks like on the other end.

---

## S6 — Publish a schedule that survives contact with reality

`organizer-publishes-a-living-schedule`

**The objective.** Accepted talks become a grid that goes public early enough to sell tickets,
and stays true through the changes that follow — including the speaker who cancels days out.

**Role.** The organizer. They have done this in a spreadsheet before and expect to see the whole
thing at once. By the second sitting they are not at a desk.

**Goal, in their words.** "Get everything into a room and a time, put it up, and keep it honest
when things move."

**Fixed for every run.**

- Signed in as **Jordan Alvarez** both sittings.
- Sitting 1: place **every talk that is not yet placed**, and resolve **every clash the product
  reports**. Record the number of each before starting and after finishing. Where the product
  offers to place things for them, they may accept — but only after satisfying themselves they
  can check the result, and the report says which they did.
- Sitting 2 is a cancellation, and always the same one: the talk **`Your Kubernetes Estate
  Should Be Boring`** is off. The speaker has emailed to say they cannot make it. Take it out of
  the public schedule and make sure nobody turns up to an empty room.
- Sitting 2 is done **entirely at 390 × 844**. If something cannot be done at that width, that is
  the finding — do not resize to get past it, and record where you stopped being able to.

**Sittings.**

1. **1440 × 900.** One long session: build it and publish it.
2. **390 × 844, same device, after `browser_close`.** In a taxi, days out, under stress.

**Finish line.** A grid with nothing unplaced and no clash the organizer knows about, publicly
visible — and after sitting 2, a public schedule with no trace of the cancelled talk, plus a
clear answer to "were the people affected told?"

**Stop rule.** Sitting 2 ends the moment the phone cannot do the next thing. Record what that
thing was; "get to a laptop" is a complete finding on its own.

**Record these.** Unplaced talks and reported clashes, before and after. Whether a clash
announced itself at the moment it was caused or later. In sitting 2: how many actions from
reading the email to the public schedule being true, and whether the destructive step said what
it would do before it did it.

**What failure costs.** The schedule is the product the attendee actually bought. A wrong one is
worse than a late one, and the moment it goes wrong is exactly the moment nobody is at a desk.

**Where it can go wrong.** Whether they can hold the whole thing in view or must scroll to know.
Whether being told about a clash comes with any idea what to do. What happens to a talk not yet
placed — visible, or merely absent. Whether moving one thing quietly moves another. Whether an
unfinished schedule is publicly visible, and whether the screen says so.

**Traces to.** AI Agenda Builder (AIA-S1, AIA-S2, and journey 3).

**Deeper cuts.** Letting the product place things and deciding whether to trust it. The
difference between what is edited and what is published. A room that disappears.

---

## S7 — Let the world find the conference and plan around it

`public-surface-holds-up`

**The objective.** Everything the conference has built has to reach people who will never sign in
— on the conference's own website, on a phone, the night before. This is the only surface the
product has that is seen by thousands rather than dozens.

**Role.** Two people, and the join between them matters. First, the person who looks after the
conference's own website: comfortable in a CMS, will paste a snippet, will not read an API
document. Then somebody who bought a ticket and knows nothing else, unwilling to sign in to read
a schedule.

**Goal, in their words.** Webmaster: "Get the schedule onto our site, looking like ours, and know
it stays current without me." Attendee: "Work out what I'm watching tomorrow, and still have that
when I wake up."

**Fixed for every run.**

- Sitting 1 as **Jordan Alvarez**, whose only job is to come away with whatever the website
  needs. They then sign out and look at the result as a stranger; record whether the result
  survives being viewed by somebody with no account.
- Sittings 2 and 3 are **signed out entirely** — delete `.walk/profile` first. No account is
  made at any point, whatever the product suggests.
- The attendee is choosing their **first day**, and they want **three talks**. Write down which
  three, by title, as soon as they have chosen — before finding out whether the product can keep
  them.
- If the product offers any way to keep a choice, use it. If it does not, record that and carry
  the three titles into sitting 3 in the person's head, which is exactly what a real attendee
  would have to do.

**Sittings.**

1. **1440 × 900**, the webmaster.
2. **390 × 844, new device**, the attendee, hotel wifi, the night before.
3. **390 × 844, same phone.** The next morning, walking: get back to the three choices in as few
   actions as possible.

**Way in.** The public event page at `/e/devflow-conf-2027` for the attendee. Never an admin
screen and never a sign-in.

**Finish line.** A page outside the product showing the real schedule; and an attendee who knows
where to be at 9am, reachable in one action while walking.

**Stop rule.** The attendee gives up on any screen that asks them to make an account, and says
so. The webmaster gives up if getting the schedule onto a page requires writing code.

**Record these.** Actions from the public event page to knowing where to be at 9am. Actions in
sitting 3 to get back to the three choices. Whether anything appeared publicly that the organizer
had not published. Whether the whole attendee trip works with a thumb, in daylight.

**What failure costs.** This is the surface that sells tickets and the one nobody is signed in to
complain from. It fails silently and at scale.

**Where it can go wrong.** Whether the webmaster can tell what they are about to embed before
embedding it. Whether the result carries the conference's look or the product's. What it does at
phone width on somebody else's page. For the attendee: whether the first screen is a schedule or
a filter wall; whether two talks at the same time look like it; whether a talk's page gives them
the room.

**Traces to.** Public Widgets (EMB-S1, EMB-S2, EMB-S3).

**Deeper cuts.** Finding one specific speaker among a hundred. What the embed does when the
schedule changes underneath it. The talk that is a break, or a panel with eight people on it.

---

## S8 — Deliver what the sponsors paid for

`partnerships-delivers-the-package`

**The objective.** Sponsorship is where the money is, and it is a set of promises — a slot on the
programme, so many passes, a logo somewhere — that somebody has to actually deliver, on time,
against a contract. Both sides get walked: the person who sold it and the customer using it.

**Role.** Morgan Diaz in partnerships, who has sold packages and must now make good on them. Then
the marketing contact at a sponsor company, who is not a conference person, did not choose this
tool, and is here because an email told them to.

**Goal, in their words.** Morgan: "Know what each sponsor is still owed and what they still owe
me, well enough to say it on a call." The sponsor: "Put my speaker's name in before the date in
that email, and never hear about it again."

**Fixed for every run.**

- Sitting 1 as **Morgan Diaz** (`morgan.diaz@devflowconf.example` / `PodiumDemo2027!`). Their
  output is a written answer, copied into the report, to one question per sponsor: **what have
  they got, what have they used, and what is still owed?** Three sponsors are in the world —
  **Ferro Labs**, **Keelworks** and **Brightpath**.
- Morgan's second job, at the end of sitting 1, is the handoff: **give the Ferro Labs contact,
  Omar Reyes (`omar.reyes@ferrolabs.example`), a way in.** He has never signed in and has no
  password; whatever the product's answer to that is, Morgan arranges it through the product's
  own screens and the report says what it turned out to be.
- Sitting 2 is **Omar**, arriving through whatever sitting 1 produced and nothing else. His one
  job: his company's session **`How We Cut Cold Starts to 40ms`** has no speaker named, and he is
  naming one — **`Dele Okonjo, Principal Engineer, Ferro Labs`**, at
  `dele.okonjo@ferrolabs.example`.
- Omar reads nothing before starting. If the product does not make plain what he owes and by
  when, that is the measurement.

**Sittings.**

1. **1440 × 900**, Morgan, one sitting.
2. **1440 × 900, new device**, Omar, at work, one sitting, no patience.

**Finish line.** Morgan can state each sponsor's position without hedging; and Ferro Labs' session
has a named speaker that Omar can see is in.

**Stop rule.** Omar replies to the email and asks a human to do it — his alternative is one click
away, and reaching for it is the strongest finding this scenario can produce. Record exactly what
sent him there. If Morgan cannot get him a way in at all, the scenario ends at the end of sitting
1 and that is the report: the paying customer cannot reach what they bought.

**Record these.** Actions for Morgan to answer the three-part question for one sponsor, and
whether the answer was in one place or assembled. For Omar: actions from arriving to the name
being in; whether he could see anything that was not his; whether the deadline he saw matched
the one he was told.

**What failure costs.** Sponsors are the paying customer, and an unused entitlement discovered
after the event is a refund conversation. This is also the product's least willing user — the
only one who will simply stop and email a human.

**Where it can go wrong.** Whether what was bought is legible to the person who bought it, in
their words rather than the product's. Whether they are told the thing landed, or left to assume.
On Morgan's side: whether "what is outstanding across all sponsors" is one view or a
reconciliation.

**Traces to.** Nothing in `../killmysaas-evals` — the eval kit has no sponsor persona. This is
Podium's own sponsorship context ([`docs/domain/03-sponsorship.md`](../domain/03-sponsorship.md)),
and it is in the queue because it is where the revenue is.

**Deeper cuts.** A sponsor swapping their named speaker late. An entitlement that goes unused as
its deadline passes. The handover from a sponsor's slot onto the same programme as everything
else.

---

## S9 — Build a speaker bench that outlives one event

`organizer-builds-the-bench`

**The objective.** The conference runs every year, and the asset that compounds is not the talks —
it is knowing who is good. By the end, the organizer can find a person they half-remember from
last year, judge whether to approach them, and start doing so in a way that will not need
remembering again.

**Role.** The organizer, between meetings, working from a genuinely vague memory.

**Goal, in their words.** "Find the one who was great last year, work out whether they're already
in this year's pile, and get an approach started."

**Fixed for every run.**

- Signed in as **Jordan Alvarez**.
- The memory is always the same, and is all they have: **someone senior who spoke at last year's
  DevFlow Conf about moving a platform without making the teams do the moving, at a company whose
  name they think began with V.** They do not have the name. Do not look it up outside the
  product — searching the seed for the answer destroys the entire measurement.
- Once found: establish whether that person has anything in this year's pile, and start an
  approach to them — whatever the product's version of that is. Record what starting one turned
  out to mean.
- The report names the person the walk landed on, so two runs can be checked against each other.

**Sittings.** One, **1440 × 900**, ten minutes of patience between meetings.

**Finish line.** The right person identified with enough of their history visible to be sure it
is them, their status this year known, and something started that the organizer will not have to
remember to do again.

**Stop rule.** They give up after **ten minutes' worth** of hunting — about twenty actions — and
go ask a colleague who will know. Record how far they got.

**Record these.** Actions from the vague memory to the right person. Whether last year exists here
at all from the organizer's point of view. Whether searching by half-remembered attributes was
possible, or whether it demanded a name. Whether "approach this person" is an act with a state or
a note they leave themselves.

**What failure costs.** Without this, every year starts from zero and the institutional memory
lives in one person's head — exactly the asset a conference loses when that person moves on.

**Traces to.** Speaker CRM (CRM-S1, CRM-S2).

**Deeper cuts.** Bringing a list of people in from outside. Two records for the same human.
Sending one message to a group and having it read as one voice.

---

## S10 — Get off the incumbent and run this conference here

`new-organization-adopts-the-product`

**The objective.** The pitch is that an organizer walks away from a five-figure renewal and runs
their conference on this instead. That claim is only true if somebody who arrives with nothing —
no seeded event, no demo data, no tour — can get to a live call under their own steam. This is
the only scenario walked against an empty product, and empty states are the least designed
screens anywhere.

**Role.** Somebody who has just decided to try this, having read the marketing site. They run a
real conference elsewhere. Nobody gave them an account: they signed up themselves, minutes ago,
and they are evaluating rather than committed.

**Goal, in their words.** "See whether I could actually run my conference on this, in half an
hour, before I put any real work into it."

**Fixed for every run.**

- **Alex Mercer**, signing up through the front door at `/signup` with zero grants. Never a
  seeded persona, and never an invitation.
- Their conference, typed verbatim wherever asked: **`Northwind Devcon 2027`**, **`12–13 October
  2027`**, in **`Manchester`**, and a call for talks that closes **`31 July 2027`**.
- Everything is arranged through the product's own screens as this person. The report says what
  had to be arranged and in what order the product made them do it.
- Half an hour of patience is roughly **sixty actions**. Count them, and note where the thirtieth
  landed — half their patience is a more useful marker than the end of it.

**Sittings.** One, **1440 × 900**.

**Finish line.** Their own conference exists with a call for talks a stranger could reach, or a
clear and early conclusion that it cannot be done — in which case the finish line is naming the
exact screen where they would have closed the tab.

**Stop rule.** Sixty actions, or the first wall that would only be got past by somebody who had
seen the seeded world. That second one is the finding this scenario exists for: it would mean
the demo works and the product does not.

**Record these.** Actions from signing up to their own conference existing, and to the call being
publicly reachable. What the very first screen after signing up gave somebody who has nothing.
Whether it was ever unclear which things belonged to their organization and which to an event.

**What failure costs.** Everything upstream of it. Every other scenario in this queue assumes a
world that already exists; this is the one that has to build it, and it is the first half-hour
that decides whether any of the rest is ever reached.

**Traces to.** Call for Papers (CFP-S1), plus the first-run path no eval scenario covers, because
the eval kit always starts from a populated deployment.

**Deeper cuts.** Bringing last year's data in. Inviting the second person on the team and seeing
what they land in. The second event, once the first exists.

---

## Adding to this queue

Four tests, from `journeys.md`: it has a real outcome, it names the constraint, it can fail, and
it does not name a screen. Three more for this file, because these are objectives rather than
tasks, and because a rating nobody can reproduce is worth nothing:

- **It is somebody's job.** If no single person would be held responsible for the outcome, it is
  a feature area rather than a scenario, and it belongs under a deeper cut.
- **Name the alternative.** Everyone here has something else they could do: email the organizer,
  submit elsewhere, keep the spreadsheet, renew with the incumbent. A journey where giving up is
  not an option cannot measure how close the product pushed somebody to it — which is what the
  stop rule is for.
- **Fix everything a second run would otherwise guess.** The identity, the text typed, the thing
  it is done to, the widths, the order of the sittings, and the point at which the person quits.
  Anything left open is a difference between two runs that will be read as a change in the
  product.
