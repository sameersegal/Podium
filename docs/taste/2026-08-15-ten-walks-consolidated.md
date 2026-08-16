# Ten walks, one day

Consolidation of the ten scenarios in [`scenarios.md`](scenarios.md), walked on 15 August 2026,
one person per walk, one fresh seeded world per walk, in the order S1 → S10. Each walk has its
own report; this file is what they say together and nothing else. Where it disagrees with a
report, the report is right — it was written on the screen, and this was written afterwards.

Non-normative, like everything in this directory. A finding here is what ten people hit on ten
trips; whether it is worth fixing, and how, is somebody else's call.

## The scores

| | The objective | Whose job | ★ | The sentence that decided it |
|---|---|---|---|---|
| [S1](2026-08-15-organizer-fills-the-programme.md) | Fill the programme | The organizer | ★★☆☆☆ | Pressed the only publish button on the screen and shipped a draft to a newsletter. |
| [S2](2026-08-15-speaker-submits-and-hears-back.md) | Get a talk in, and hear back | A first-time speaker | ★☆☆☆☆ | The portal names my draft, and none of its five links open it. |
| [S3](2026-08-15-chair-and-reviewer-judge-the-field.md) | Judge the field defensibly | The chair, then a reviewer | ★★☆☆☆ | The chair cannot see what a reviewer sees, anywhere, at all. |
| [S4](2026-08-15-accepted-speaker-gets-to-the-stage.md) | Turn a yes into a talk | An accepted speaker | ★☆☆☆☆ | "Nothing is waiting on you", eight lines above "Onboarding — now". |
| [S5](2026-08-15-operations-closes-the-supply-chain.md) | Every asset in hand | Speaker operations | ★☆☆☆☆ | "Sending." — and a reload nobody invited showed 0 sent, 6 failed, no reason. |
| [S6](2026-08-15-organizer-publishes-a-living-schedule.md) | A schedule that survives reality | The organizer | ★☆☆☆☆ | A green "the public schedule matches the working copy", over two publicly empty days. |
| [S7](2026-08-15-public-surface-holds-up.md) | Reach the world | An attendee, and the site's owner | ★☆☆☆☆ | The Embeds screen cannot be reached from any screen, nav or search. |
| [S8](2026-08-15-partnerships-delivers-the-package.md) | Deliver what sponsors paid for | Partnerships, then a sponsor | ★☆☆☆☆ | The page that says "Accepted — confirm your session" has no controls in it. |
| [S9](2026-08-15-organizer-builds-the-bench.md) | A bench that outlives one event | The organizer | ★★☆☆☆ | A green "Moved." over a stage history that had not changed. |
| [S10](2026-08-15-new-organization-adopts-the-product.md) | Run this conference here | A new organization | ★☆☆☆☆ | `/admin` silently redirects a signed-up organizer into the speaker portal. |

**13 stars out of 50.** One walk reached its finish line as the scenario wrote it (S1). Three
reached it only by working around the product — S2 guessed a URL from Sunday's address bar, S6
used a `?nojs=1` flag it learned from a toast, S9 hand-edited a URL. Six did not reach it at all:
S3's chair never established what a reviewer can see, S4, S5, S7's webmaster half, S8's sponsor
half, and S10, which stopped at fifteen of its sixty allowed actions.

### The six dimensions, averaged over ten walks

| | Mean | Range | Read |
|---|---|---|---|
| Effort | **3.0** | 2–4 | The best thing in the product. It rarely asks for what it already knows. |
| Craft | **2.7** | 2–3 | Handsome, consistent, and never quite finished at the edges. |
| Orientation | **2.4** | 1–4 | Excellent where somebody wrote a sentence; absent where nobody did. |
| Forgiveness | **2.0** | 1–3 | Leaving and coming back mostly works. Getting something wrong mostly does not. |
| The obvious next step | **1.9** | 1–3 | Seven walks hunted for the screen they needed; five found it by URL. |
| **Trust** | **1.2** | 1–2 | **One star in eight of ten walks.** This is the report. |

## The one finding

**The product tells you it did something it did not do.** It is not a bug that appears in one
place; it appeared in five of the ten walks, six times over, in six different contexts written by
different code, and it is why Trust scored one star nearly everywhere.

| Walk | What it said | What had happened |
|---|---|---|
| S1 | "Publish this version" succeeded | The *form* was published; the call stayed a draft, and no screen said so |
| S4 | "Saved." on a new headshot | The public speaker page still served the old one |
| S5 | "Sending." | 0 sent, 0 suppressed, **6 failed**, no reason on any screen |
| S6 | "The public schedule matches the working copy" | The public page held 6 of 10 sessions, two of three days empty |
| S6 | "It stays visible, and it goes on the record" | The row vanished; neither typed reason is findable anywhere |
| S9 | "Moved." | Nothing written, the note discarded — twice |

Every one of these was caught only by an action the product did not ask for: a reload, a check of
the public page, a second look. A user who believes the confirmation — which is the whole point of
a confirmation — walks away with a broken conference and no reason to suspect it. In S5 and S6
that is a conference whose speakers were never told and whose schedule was never public.

The counterpart is the same failure at rest: **absence is never rendered.** The Files export ships
22 bytes and a header row while the screen behind it lists twelve assets (S5); Publish counts what
is *placed* rather than what is *publishable* (S6); the agenda widget opens on the one day with
nothing in it (S7); a wholly unused sponsor package appears on no dashboard, in no deadline list
(S8); and the speaker portal can show what is done but not what is outstanding (S4). A product
that cannot say "nothing here" cannot be trusted when it says "all done".

## The four patterns underneath it

**1. Two screens, one truth, and they disagree.** *"Nothing is waiting on you"* is printed in
three separate walks over work that was waiting — above an onboarding step (S4), above a red **DO
THIS FIRST** panel (S8), and beside a timeline whose marker sits on Submitted while the heading
says Draft (S2). Elsewhere: a proposal is refused for a conflict its own page denies (S3); a
person is `INVITED` and `CONFIRMED` on one page (S5) and Invited / Prospect / Confirmed on another
(S9); the proposal count is 12 in the rail and 13 on the page in three separate walks (S1, S4,
S9); round times differ by seven hours between two screens (S3); a publish timestamp differs
between two renderings of one URL (S6). Nobody hit *one* of these. They hit them constantly, and
each one costs the reread that Orientation and Trust are made of.

**2. The screen exists, and nothing links to it.** Every walk that failed, failed at a missing
link rather than a missing feature — which was the finding of the first walk on 14 August and is
now the finding of six more. The draft the portal names (S2), the Embeds screen (S7), the sourcing
board (S9), the "There is no event yet — Create an event" screen (S10) and the onboarding surface
with *N of M done* (S4) are all built, and all unreachable from where the person stood. Five walks
got past it by typing a URL; the two roles who cannot type URLs — the sponsor and the new
organizer — stopped and reached for email, exactly as their stop rules predicted.

**3. Every road leads to the speaker portal.** The organizer (S1), the reviewer (S3), speaker
operations (S5), the sponsor (S8) and the self-signed-up evaluator (S10) all arrived, at some
point, on a page headed *Your talks* offering **Find an open call**. For S10 that single silent
redirect was the whole evaluation: a refusal would have told them an organizer side existed,
and silence told them it did not. Four walks were also shown a **Sign in** control while signed
in.

**4. Dates are told in whatever zone the code had to hand.** A closing date typed into a field
labelled `(America/Los_Angeles)` appears a day late and unlabelled on the list beside it (S1);
`submit by 2027-04-10T23:59:00.000Z` sits three inches from a sidebar reading
`America/Los_Angeles` (S8); one speaker saw six deadlines in five formats, one of them
actionable (S4). This is the one class of defect a conference cannot absorb, because every
deadline here belongs to somebody else's calendar.

Below all of it, the maker's mind on screen: `INV-01-15`, `INV-02-7`, `INV-05-17`, `double_blind`,
`company_domain`, `event_participants`, "Needs coi check", raw `per_…` and `ses_…` identifiers in
error messages — and, in S3, a conflict of interest that can only be declared by copying a ULID
out of another page's URL.

## What is already good, and should be copied rather than admired

The care in this product is real, and it is concentrated in one place: **the applicant side, in
sentences somebody clearly wrote by hand.** "As you write it. It is never split into first and
last." "Free text. Never inferred." "…never appear on any public page, whatever you set here."
"This proposal is already with the committee — saving a change here updates it and resubmits it
for you." "Money lives in that system, not this one." Those are five-star sentences and there are
dozens of them.

So are: the form a speaker can read *before* signing up (S2); the reviewer's own anonymity
promise, which is the exact sentence the chair needed and never saw (S3); "Ordered by what stops
the event if it slips", the recipient preview with names *and* addresses, and "Show sessions with
no slides yet" (S5); the Today dashboard, and a phone cancellation that took six actions and read
beautifully (S6); an .ics carrying `Room 2B (Level 2)` — the floor, which no web page showed (S7);
"Who has bought what, and how much of it they have used · 0 held · 1 spent · 1 left" (S8); and the
June note in the organizer's own handwriting, "said to ask again in the autumn", which is what a
speaker bench is *for* (S9).

Walked on its own, the attendee half of S7 is a four: nothing lost across a full browser close,
two actions back to her three talks the next morning, and never once asked to make an account.
The product knows how to do this. It has not done it for the organizer's first minute, for the
sponsor, or for anyone at the moment something goes wrong.

## The shortest list that moves the most walks

Ordered by walks affected, not by effort.

1. **Never confirm what did not happen.** Six walks. A confirmation must be written by the thing
   that succeeded — the send that sent, the move that moved, the publish that published — and
   must name what it did to what. Where a step half-succeeded (S5's 6 failures, S6's 4 unpublished
   sessions), the count belongs in the confirmation, not two screens away behind a reload.
2. **Render absence.** Five walks. An export with no files, a day with no sessions, an
   entitlement nobody used, a task nobody did: each needs a screen that says so where somebody is
   looking, in the same place the positive number appears.
3. **Link the screens that already exist.** Five walks, and near-zero cost: Embeds from Publish,
   the portal's lead draft with the `href` it already renders under *Your other talks*, the
   sourcing board into the nav, and the person page to its own approach.
4. **Give every role a landing screen of its own** — and make `/admin` refuse rather than
   redirect, naming what this account can do. Five walks, and it is the whole of S10.
5. **Make the two "nothing is waiting on you" summaries derive from the list below them.** Three
   walks, all on the speaker side, and it is the sentence a speaker trusts most.
6. **One deadline, one zone, one format, everywhere.** Four walks. The correct string already
   exists on other screens in at least two of them.
7. **Make the review and sponsor sides answer their own promise** — a chair who can see what a
   reviewer sees, a sponsor page with a control on it.
8. **Sweep the maker's vocabulary off user-facing screens.** Every walk found some.

Items 1–4 are load-bearing. If only one ships, ship 1: it is the difference between a product
that is unfinished and a product that lies, and eight one-star Trust scores say the users cannot
tell those apart.

## What the walks said about the world they were walked in

Three findings are about the seed rather than the screens, and they bound what these ten walks
could measure:

- **The persona `journeys.md` calls *the speaker* has no 2027 talk.** S4's whole objective —
  everything being asked of an accepted speaker — was walked against a portal showing last year's
  archived keynote. The onboarding surface the scenario exists to rate never rendered. Per rule D
  this is a serious finding in itself: the product ships a demo the job cannot be done in.
- **The unread pile in S3 was one proposal.** The chair's handoff and the reviewer's evening both
  worked, and neither was tested at the size that makes them hard. Sam's stop rule could not fire.
- **The deployment is single-tenant** — one organization, created once at `/setup` — so S10's
  premise, signing up on a running instance and building your own conference, is not a thing the
  product does. That is a coherent design; no screen anywhere says it, which is the missing
  sentence every S10 finding is downstream of.

Add to that: no mail is delivered in this environment, so "what arrived between the sittings" was
answered from what the product showed on screen (S2, S4, S5, S8), and the fixture headshot and
slides were substituted locally because `../killmysaas-evals` is not on this machine (S4).

## How these ten runs were made comparable

Each walk got a fresh world: `npm run dev` stopped and restarted, `.walk` deleted, the browser
closed, and `/dev/ids` checked before the first screen. The identities, typed text, targets,
viewports, sitting order and stop rules are the ones fixed in [`scenarios.md`](scenarios.md), and
each agent was handed its scenario block verbatim and nothing else from that file. Nobody read
another walk's report before writing their ratings, and nobody read the code until after.

Two departures are worth recording. **S1 was walked twice**: the first run was aborted mid-sitting
because the repository was fast-forwarded and the dev server hot-reloaded underneath it, and the
report is from the clean re-walk. And **S7's webmaster served the embed from a local file and a
throwaway static server**, which is the one place a walk touched something outside the product;
the report says so.

The numbers to compare a future run against are in each report under *What it charged me*. The
ones worth watching first: 92 re-dos across ten walks, five screens found only by typing a URL,
and Trust at 1.2.
