# The world you walk in, and the journeys worth walking

Companion to [`product-taste.md`](../../product-taste.md). Everything the agent is allowed to
know **before** a walk lives here: how to get the product running, who exists in it, and where
to go in. Nothing here describes what any screen does, and nothing may be added that does —
the first rule of the agent is that it learns the product from the screen, and a reference
file that spoils the flow quietly destroys the measurement it was written to support.

## Getting a product to walk

```bash
npm run dev          # repo root: resets, migrates, seeds, serves on :8787, publishes the schedule
```

Leave it running. It is a real Worker on real local D1, KV, R2 and Queues, not a mock. If the
walk needs to start from a clean world again, stop it and run it again — that is the only
supported reset, and you never touch the database by hand.

Check it came up seeded before walking: `curl -s localhost:8787/dev/ids` returns the event and
its slug. If it does not, the walk is against an empty product and every finding is worthless.

`walk.mjs` needs Playwright, which is a dev dependency of the repository root, and a Chromium.
It uses the one Playwright provides; where a machine already has one at a different build,
point at it with `PODIUM_CHROMIUM`.

## The fixture world

One organization, two events. **DevFlow Conf 2027** (`devflow-conf-2027`) is the live one — a
developer-tooling conference mid-flight, with proposals in every state, a review round with
real scores on it, sponsors part-way through what they bought, and a published schedule that
has genuine conflicts in it. **DevFlow Conf 2026** (`devflow-conf-2026`) is last year's,
archived, and exists so the product is never walked as if it had no history.

The main call for proposals (`main`) is open, and closes on 30 April 2027.

### People you can be

All four share the password `PodiumDemo2027!`. Password sign-in is on in the seed and off in
production config, which is why these work at all.

| | Who they are in the fiction | Signs in as |
|---|---|---|
| **Organizer** | Jordan Alvarez, Programme Director, runs the whole event | `organizer@devflowconf.example` |
| **Speaker** | Priya Raman, Principal Engineer, has spoken before and is already in this year's pile | `speaker@devflowconf.example` |
| **Second speaker** | Marcus Okafor, Staff Developer Advocate, on the programme as a co-speaker | `cospeaker@devflowconf.example` |
| **Reviewer** | Sam Whitfield, reviews for several conferences | `reviewer@devflowconf.example` |

Two more exist and are worth knowing about when a journey needs somebody who is not the boss:
Riley Chen (speaker operations) and Morgan Diaz (partnerships), same domain, same password.

**A seeded person carries their history.** If the journey is a first-timer's, being Priya is
the wrong choice — she has submitted here before and the product knows it, which is exactly
the state you are not trying to measure. Sign up as somebody new instead, and treat the sign-up
as the first screen of the walk, because for a real first-time speaker it is.

### Ways in

| | |
|---|---|
| The event, as the public sees it | `/e/devflow-conf-2027` |
| The open call for proposals | `/e/devflow-conf-2027/cfp/main` |
| Where speakers live | `/portal` |
| Where reviewers live | `/review` |
| Where organizers live | `/admin` |
| Sign in, sign up | `/login`, `/signup` |

**Enter where the role would enter.** A speaker arrives from a link in a tweet or a call-for-
papers newsletter, which means the public CFP page and not `/portal` — and the trip from there
to a signed-in portal is part of what you are rating. Starting a speaker at `/portal` skips
the third of the journey most likely to lose them.

## What makes a journey worth walking

One person, one job, one sitting or two. Written as something a person would say out loud, and
never as a feature name.

- **It has a real outcome.** "Get my talk in before the deadline", not "explore the portal".
- **It names the constraint.** The phone, the interruption, the deadline tonight, the fact
  that they have never seen this before. Constraints are where taste is spent.
- **It can fail.** If there is no way for the trip to go badly, it will not measure anything.
- **It does not name a screen.** The moment a journey says which button to press, the agent is
  following instructions instead of finding its way, and finding its way is the measurement.

Two sittings are worth it whenever the job is long enough that a real person would be
interrupted — which is most of them. See E in the agent file for what to measure on the way
back in.

## The catalogue

Walked journeys land in `docs/taste/`. Add one here once it has been walked, so the next run
is comparable.

### A first-time speaker submits a talk, across two sittings

Walked 14 August 2026 —
[report](../../../../docs/taste/2026-08-14-first-time-speaker-submits.md), ★☆☆☆☆.

**Role.** Someone who has never used this product and has never spoken at this conference. A
working engineer with a talk they have given internally once. Not a conference regular; they
do not know what a "track" is called here, or how long a review takes.

**Task.** Get the talk submitted before the call closes.

**Constraint.** They start on a phone on a Sunday evening, having followed a link. They get
interrupted part-way through and come back a couple of days later, on a laptop, to finish.

**Way in.** `/e/devflow-conf-2027/cfp/main`, not the portal.

**Done, from their side.** Something on a screen that says the talk is in, and enough of a
sense of what happens next that they would not email the organizer to check.

**Where it can go wrong, and therefore what to watch.** Whether they can tell what will be
asked of them before they start. Whether the account they have to make feels like a cost or a
service. What the product does at the moment they stop. Whether anything survives to Tuesday,
whether they are told it survived, and how many actions it takes to be back where they were.

### Yet to walk

Candidates, in the order they would be worth the time — an organizer choosing between two
proposals for the last keynote slot on a phone; a reviewer clearing a queue of eight; an
accepted speaker doing everything the product asks of them between acceptance and the event;
a sponsor's contact naming their speaker before a deadline.
