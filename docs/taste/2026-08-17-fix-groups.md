# The ten walks, grouped into work

The latest walkthrough is [**Ten walks, one day**](2026-08-15-ten-walks-consolidated.md) — S1–S10
walked on 15 August 2026, 13 stars out of 50, Trust at one star in eight of ten. This file takes
the ~110 findings across those ten reports (plus the first walk on
[14 August](2026-08-14-first-time-speaker-submits.md)) and groups them by **the change that fixes
them**, not by the walk that found them.

Non-normative, like everything in this directory. The reports are evidence and the README is
explicit that they are not a backlog; this is somebody making that call, and it can be wrong where
the reports cannot. Where this disagrees with a report, the report is right.

Groups are ordered by walks affected. Each one names its evidence, the shape of the fix, and how
you would know it was done. **A–D are load-bearing**: they are the four items the consolidation
calls load-bearing, and between them they account for every walk that failed.

---

## A — A confirmation must be written by the thing that succeeded

**7 walks · S1, S3, S4, S5, S6, S9 (+08-14)** · the single finding under eight of the ten one-star
Trust scores.

| Where | Said | Did |
|---|---|---|
| S1 · 2 | "Publish this version" succeeded | The *form* published; the call stayed a draft |
| S4 · F4 | "Saved." on a headshot | Public speaker page still served the old one |
| S5 · FATAL 1 | "Sending." | 0 sent / 0 suppressed / **6 failed**, only after an uninvited reload |
| S5 · SERIOUS 4 | "Remind" | Nothing reported at all |
| S5 · SERIOUS 6 | "Partially failed" | Nothing partial happened — 0 of 6 |
| S6 · FATAL | "The public schedule matches the working copy" | 6 of 10 sessions public, two of three days empty |
| S6 · SERIOUS | "It stays visible, and it goes on the record" | Row vanished; neither typed reason is findable |
| S6 · SAND | "Remind" sends an email and says nothing | — |
| S9 · F1 | "Moved." | Nothing written, note discarded — twice |
| S3 · 12 | Submitting a review is not acknowledged | — |

**The fix.** A confirmation is emitted by the operation that completed, names what it did to what,
and carries the count when a step half-succeeded — `Sent to 0 of 6. 6 failed.` belongs *in* the
banner, not two screens away behind a manual reload. Anything asynchronous says it is in flight and
resolves itself without the user reloading. A promise made in a prompt ("it stays visible, it goes
on the record") is a claim about behaviour and is either true or not made.

**Done when.** Every mutating handler's success path renders a message derived from its own result,
and re-walking S5 and S6 produces a truthful count on the screen the action was taken from.

---

## B — Render absence

**7 walks · S3, S4, S5, S6, S7, S8, S9.** The same failure at rest: the product can count what
exists and cannot say "nothing here", so it cannot be believed when it says "all done".

- **S5 · FATAL 3** — Files export ships a 22-byte ZIP and a header-row CSV while the screen behind
  it lists twelve assets.
- **S6 · FATAL** — Publish counts what is *placed* rather than what is *publishable*; the Agenda
  badge reads 10/10 over six publishable sessions.
- **S7 · 4** — The agenda widget defaults to Day 1, the one day with nothing in it, and has no day
  switcher. The product's own schedule page opens on Day 2 because it knows.
- **S7 · 13** — "Nothing is scheduled on this day yet" cannot distinguish an empty day from an
  unpublished one, on a hero advertising 12–14 May.
- **S8 · F5** — A wholly unused entitlement appears on no dashboard and in no deadline list.
- **S4 · F3, F5** — The portal shows what is done and never enumerates what is outstanding;
  "100% complete / Nothing missing" cannot move and is not the conference's judgement.
- **S3 · 11** — The Progress table silently omits the pool member who has reviewed nothing, which
  is the only row a chair is looking for.
- **S9 · F9, F14** — No stage means "asked, waiting"; "1 person in the directory" over a bench.

**The fix.** Wherever a positive count is printed, the zero and the shortfall are printed in the
same place by the same code path. An export with nothing in it fails loudly rather than succeeding
emptily.

**Done when.** Each of the seven screens above renders its own empty and partial case, and the
`--check` walk of a seeded-then-emptied world does not produce a green counter anywhere.

---

## C — Link the screens that already exist

**6 walks · S2, S4, S7, S9, S10 (+08-14).** Every walk that failed, failed at a missing link rather
than a missing feature — the finding of the first walk on 14 August and now of six more. Near-zero
cost, the highest ratio in the list.

| Built, and unreachable | From where somebody stood |
|---|---|
| The speaker's own lead draft (S2 · F1, 08-14 · F1) | `/portal` — the page already renders the `href` under *Your other talks*; only the lead talk loses it |
| The Embeds screen (S7 · 1) | Publish — the sidebar already highlights Publish while you are on Embeds |
| The sourcing board (S9 · F5) | The nav |
| A person's own approach (S9 · F3) | Their person page — the link exists and is dead |
| The onboarding surface with *N of M done* (S4 · F1, F3) | The speaker portal |
| "There is no event yet — Create an event" (S10 · F1) | Anywhere a new organizer stands |

Five walks got past this by typing a URL. The two roles who cannot — the sponsor and the new
organizer — stopped and reached for email, exactly as their stop rules predicted.

Adjacent, same shape: no star on a session's own page (S7 · 9), a starred day with no URL to
bookmark (S7 · 11), Review's four sibling links with no primary and no persistence (S3 · 17).

**Done when.** `node scripts/smoke.mjs` reaches every screen in the URL map by following links from
a role's landing page, and fails on any screen that only a typed URL can reach.

---

## D — Every role lands somewhere that is theirs, and `/admin` refuses rather than redirects

**6 walks · S1, S3, S5, S8, S10 (+S2).** The organizer, the reviewer, speaker operations, the
sponsor and the self-signed-up evaluator all arrived, at some point, on a page headed *Your talks*
offering **Find an open call**.

- **S10 · F2** — `/admin` silently redirects an account with no grants into the speaker portal. For
  S10 that one redirect *was* the whole evaluation: a refusal would have told them an organizer
  side existed; silence told them it did not. **This is the whole of S10.**
- **S1 · 9, S3 · 3, S8 · F14** — Signing in as the organizer / following a review link / signing in
  as partnerships all land in the speaker portal.
- **S10 · F3** — The 404 page advertises an "admin dashboard" whose link lands in the portal.
- **S10 · F4** — "You do not have permission to manage **this event's** configuration", on a route
  with no event.
- **S10 · F5, S2 · S9, S4 · F7, S1 · 10** — Signed-in pages offer **Sign in**; the rail loses
  **Sign out** on some screens. Four walks were shown a sign-in control while signed in.
- **S10 · F7, S4 · F13** — The nav changes composition from screen to screen.
- **S10 · F6** — No way to sign up from the front door.
- **S10 · third seed finding** — The deployment is single-tenant, created once at `/setup`. That is
  a coherent design and **no screen anywhere says it**; it is the missing sentence every other S10
  finding is downstream of. Decide it, then write it on the screen where somebody would otherwise
  guess.

**The fix.** A refusal that names what this account *can* do beats a redirect in every case.
Landing is a function of grants, not a default.

**Done when.** Each persona in the seed signs in and lands on a screen addressed to them, and
`/admin` as a zero-grant account returns a page that names the reason.

---

## E — Two screens, one truth, and they disagree

**8 walks · S1, S2, S3, S4, S5, S6, S7, S8, S9.** Nobody hit *one* of these; each costs the reread
that Orientation and Trust are made of.

- **The same record, two states.** Draft above a timeline whose *now* sits on Submitted
  (S2 · F2, 08-14 · F2) — the worst outcome the product can produce, and it produces it silently.
  `INVITED` and `CONFIRMED` on one page (S5 · SERIOUS 7); Invited / Prospect / Confirmed on another
  (S9 · F6); a screen that contradicts itself about whether the talk has a title (S8 · F7).
- **"Nothing is waiting on you"**, printed over work that was waiting, in three walks — above an
  onboarding step (S4 · F2), above a red **DO THIS FIRST** panel (S8 · F2, S2 · D1, 08-14 · S6).
  Item 5 of the consolidation: make the summary derive from the list below it.
- **Counts.** 12 in the rail and 13 on the page, three walks (S1 · 11, S3 · 9, S9 · F13); "0
  unpublished" over a public site showing six of ten (S7 · 8); "review 100% complete" over a
  proposal with no reviews (S3 · 4); a proposal refused for a conflict its own page denies
  (S3 · 1); ACCEPTED at 0 / 2 reviews with no screen saying why (S3 · 10).
- **Labels against themselves.** A search button reading "Search proposals, people, sessions" over
  an empty state reading "This searches screens and actions, not proposals or people" (S7 · 7); a
  global search advertising two nouns it cannot search (S9 · F4); Messaging in the nav, Campaigns
  on the page (S8 · F15); ACTIVE as a contract state wearing an access state's clothes (S8 · F9);
  two Agenda screens and two Publish screens, the working one reached by accident (S6 · SERIOUS);
  two names for one place (S4 · F13); a stale confirmation screen (S6 · SAND).

**The fix.** One reader per fact. Where two screens show a number, both call the same function.

---

## F — One deadline, one zone, one format, everywhere

**5 walks · S1, S3, S4, S6, S8 (+S2).** The one class of defect a conference cannot absorb: every
deadline here belongs to somebody else's calendar. The correct string already exists on other
screens in at least two of these.

- **S1 · 1** — A date typed into a field labelled `(America/Los_Angeles)` appears a day late and
  unlabelled on the list beside it.
- **S8 · F6** — `submit by 2027-04-10T23:59:00.000Z`, three inches from a sidebar reading
  `America/Los_Angeles`. It is the one date Morgan has to say out loud on a call.
- **S4 · F12** — Six deadlines in five formats, one of them actionable.
- **S3 · 8** — Two screens disagree about when the round opens and closes, by seven hours.
- **S6 · SAND** — Two clocks for the same moment.
- **S2 · D9, 08-14 · D1** — No timezone on any timestamp inside the portal, while the deadline
  outside it is quoted in Los Angeles time; and *16:59* is not a time anybody sets a deadline at.
- **S9 · F8** — "Next action" is a date with no action attached.

---

## G — The review and sponsor sides answer their own promise

**2 walks, both of which stopped on it · S3, S8.** Consolidation item 7. These are the two roles
that reached a screen built for them and found it inert.

**The chair (S3).** The chair cannot see what a reviewer sees, anywhere, at all (S3 · 2) — the
reviewer's own anonymity promise is the exact sentence the chair needed and never saw. They cannot
tell which reviewer wrote which review (S3 · 6). A conflict of interest can only be declared by
copying a ULID out of another page's URL (S3 · 5). The reviewer's Submit sits inside a nested
scroll region (S3 · 7); a submitted review still offers *Save draft* and *Submit review*
(S3 · 13); Verdict and Overall recommendation ask one opinion twice (S3 · 14); three assignment
tools are stacked with no guidance (S3 · 16).

**The sponsor (S8).** The page that says "Accepted — confirm your session" has no controls in it
(S8 · F1) — the sponsor's contact cannot do the one thing they were invited to do. He is instead
handed a speaker's identity: "Your talks", *confirm your session*, a bio he did not write, and
**"List me in the public speaker directory" already ticked** (S8 · F3) — the only visible primary
action is one he must not take. Handing a paying customer their access depends on Morgan's
clipboard rather than an email (S8 · F4). Sponsorship is spread over three screens each holding
part of the account (S8 · F10, F11, F12); three destructive verbs name no object (S8 · F8).

**S8 · F3 is worth a second look outside taste.** A sponsor contact arriving pre-ticked into the
public speaker directory with somebody else's bio is a consent and PII question, not only a
confusing screen. Check it against
[`01-identity-and-access.md`](../domain/01-identity-and-access.md) and the PII classification in
[`11-cross-cutting.md`](../domain/11-cross-cutting.md) before deciding it is cosmetic.

---

## H — Nothing typed is discarded in silence

**4 walks · S1, S2, S9 (+08-14).** Distinct from group A: A is a false confirmation, this is no
confirmation and no data.

- **S2 · F3** — Five answers including a sixty-word abstract, typed into live fields on the public
  form, gone the moment the page's only button was pressed. Nothing acknowledged they existed.
- **S2 · S2, 08-14 · S1** — No autosave, no warning on leaving, and the last message on screen is a
  green **"Saved."** referring to a save two fields earlier.
- **S1 · 4** — The field settings panel discarded a typed answer, on a screen with no Save.
- **S9 · F1** — The note discarded, twice, under a green "Moved."
- **S2 · S1** — "Start a submission" while signed in creates a *second* draft alongside the
  existing one, with no mention that one exists and no way to delete or merge the orphan.

---

## I — The public surface and the embed are the artefact

**1 walk, and it is the one a conference cannot ship without · S7.** These break on somebody
else's website, where nobody in this product will ever see them.

- **S7 · 2** — Every session title in the embed is `href="/e/…"`, root-relative, so it resolves
  against the *host's* domain. Every session, every host site, every time. The webmaster who ships
  it never clicks their own embed; the visitor who does gets a 404 on the conference's website.
- **S7 · 3** — A failed embed renders nothing and says nothing: `data-podium-mounted="1"`, zero
  children, no fallback link. Compounding it, the allowlist displays `*` and matches it as a
  literal string, so it reads as "any site" and is not.
- **S7 · 6** — An hour-long break labelled **Talk (30 min)** on the public sessions page and in the
  embed, printed next to the times that contradict it.
- **S7 · 5** — Two starred talks at 10:00 produce no warning, no marker, and an .ics containing
  both. Telling somebody their day has a collision is the most useful thing a night-before
  schedule can do.
- **S7 · 10** — A talk's page is titled "Session · Podium"; shared to a group chat the preview
  reads "Session".
- **S2 · S8, S7 · 14** — The conference front page points "Submit a talk" at the sponsor-only call
  ("closes 10 Apr") rather than the open public one ("closes 30 April").

Walked on its own, the attendee half of S7 is a four — nothing lost across a full browser close,
two actions back to her three talks, never once asked to make an account. The .ics carries
`Room 2B (Level 2)`, the floor, which no web page showed. This group is the gap between that and
what the site's owner could actually ship.

---

## J — Sweep the maker's vocabulary off user-facing screens

**Every walk found some.** `INV-01-15`, `INV-02-7`, `INV-05-17`, `double_blind`, `company_domain`,
`event_participants`, "Needs coi check", raw `per_…` and `ses_…` in error messages
(S1 · 8, S3 · 15, S5 · SAND, S6 · SAND, S8 · F13, S9 · F12), plus the ordinary English words used
in the maker's sense rather than the user's: *proposal* / *submission* / *talk* for one object
across three consecutive screens (S2 · D5), **ACCEPTED** beside your own name from the moment a
draft exists (S2 · S7, 08-14 · S5), **RESUBMISSION** on a first submission (S2 · D3),
*Untitled proposal* on the screen where you are typing the title (S2 · D6).

Mechanical, cheap, and the one group where a lint rule beats a review: no `INV-`, no snake_case
identifier, no `[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}` in rendered copy.

---

## K — Craft at the edges

**Every walk.** Handsome, consistent, and never quite finished. Grouped because they are one
sweep, not because they are one cause.

**Broken rendering.** A status badge renders as raw HTML on three screens (S5 · SERIOUS 5); the
file detail page ships with no stylesheet at all (S5 · SERIOUS 8); layout falls over when the
Acknowledge popover opens and `f_reason` ids duplicate twice (S6 · SAND); a native `prompt()` in
the middle of a designed console (S6 · SAND).

**Widths.** The public CFP page — the thing the whole job produces — is a 416 px column in a
1440 px window (S1 · 5, S2 · D10, 08-14 · D7); a 416 px card centred in 1440 px on signup
(S10 · F9). Every other page on the site uses the width.

**Phones.** 34 fields and 13 px checkboxes (S4 · F14); 17 px wizard step pills, the smallest touch
target in the flow (S2 · D11, 08-14 · D6); nine session rows as a column of confetti (S6 · SAND);
titles clipped mid-word everywhere (S6 · SAND); a visibly broken public speaker page (S4 · F8);
a room number at 13 px and 3.2:1 contrast, the one fact a walking attendee needs (S7 · 12).

**Tone.** Good news in an alarm colour — the pink open-call banner is the first thing the eye lands
on (S1 · 12, S2 · D8, 08-14 · D5); a 0% completeness nag ninety seconds into an account
(S10 · F8, S2 · D12); "Four things need you today" over two rows (S6 · SAND); duplicate and doubled
copy (S8 · F16).

---

## L — The seed is the world, and this world cannot be walked

**Bounds what any of the above can be verified against**, so it comes before the re-walk rather
than after it.

- **The persona `journeys.md` calls *the speaker* has no 2027 talk.** S4's entire objective was
  walked against a portal showing last year's archived keynote; the onboarding surface the
  scenario exists to rate never rendered. The product ships a demo the job cannot be done in.
- **The unread pile in S3 was one proposal.** The chair's handoff and the reviewer's evening were
  never tested at the size that makes them hard.
- **The single-tenant premise is unstated** — see D.
- No mail is delivered in this environment, so "what arrived between the sittings" was answered
  from the screen in four walks (S2, S4, S5, S8) — and S5's FATAL 1 is *not* explained by that:
  the Outbox shows seeded mail sending successfully four days earlier.
- The fixture headshot and slides were substituted locally because `../killmysaas-evals` is not on
  this machine (S4).

---

## The order

The consolidation's own list, mapped onto the groups above:

| Consolidation | Group | Walks |
|---|---|---|
| 1. Never confirm what did not happen | **A** | 7 |
| 2. Render absence | **B** | 7 |
| 3. Link the screens that already exist | **C** | 6 |
| 4. Give every role a landing screen; `/admin` refuses | **D** | 6 |
| 5. Make "nothing is waiting on you" derive from the list | **E** (subset) | 3 |
| 6. One deadline, one zone, one format | **F** | 5 |
| 7. Review and sponsor sides answer their promise | **G** | 2 |
| 8. Sweep the maker's vocabulary | **J** | 10 |
| — | **E** (the rest), **H**, **I**, **K** | — |
| — | **L**, before re-walking anything | — |

**A–D are load-bearing.** If only one ships, ship **A**: it is the difference between a product
that is unfinished and a product that lies, and eight one-star Trust scores say the users cannot
tell those apart.

**L first in practice**, because it is cheap and because S4 and S3 cannot be re-measured until the
seed can carry them.

Re-walking is how any of this is scored, not how it is verified — the scenarios are fixed in
[`scenarios.md`](scenarios.md) and a group is only *done* when a test in `tests/integration/`
fails without the fix. The numbers to beat are in each report under *What it charged me*; the ones
worth watching first are 92 re-dos across ten walks, five screens found only by typing a URL, and
Trust at 1.2.
