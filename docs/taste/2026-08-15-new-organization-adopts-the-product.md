# A new organization tries to adopt the product

**Journey:** `new-organization-adopts-the-product` (S10)
**Walked:** 15 August 2026, one sitting, 1440 × 900, Chromium.
**Outcome: did not finish.** Northwind Devcon 2027 does not exist. There is no call for talks.
Not one of the four facts I came to type was ever asked for by any screen.

**★☆☆☆☆**

---

## Who I was

**Alex Mercer.** I run Northwind Devcon, a two-day developer conference in Manchester. We have
run it on a hosted CFP tool for three years and the renewal quote landed last week at just over
five figures. I read the Podium marketing site last night. Work laptop, mid-morning, half an
hour before my next call. Nobody gave me an account — I signed up myself, minutes ago.

**What I came to do,** in my words: *see whether I could actually run my conference on this,
before I put any real work into it.* Concretely — get Northwind Devcon 2027 into it, open a
call for talks, and get a link I could paste into a tweet.

**What I already knew:** nothing about this product beyond a marketing page. I know
conferences.

**What done looked like:** a URL I could open in a private window showing my conference and a
"submit a talk" form with the right dates on it. And the feeling that the thing I had just
built was mine.

**What I would do instead:** pay the renewal. It is annoying but it works, and it is one
invoice. That alternative was sitting right there the whole time, which is why every minute of
confusion cost real ground.

**What I would have typed, verbatim, had anything asked:** `Northwind Devcon 2027`,
`12–13 October 2027`, `Manchester`, call closes `31 July 2027`.

---

## The counts

| | |
|---|---|
| Screens opened | 11 (8 distinct) |
| Actions | **15** |
| Fields typed | 3 — name, email, password |
| …of which the product already had the answer | 0 (but no `autocomplete` on any of them, so my password manager offered nothing) |
| Navigations | 15, of which 5 went backwards or into a page I had already seen |
| Re-dos | **10** — 2 rereads, 1 page opened only to find out what was on it, 1 loop back, 5 URL guesses, 1 link that did not go where it said |
| **Actions before the first useful thing happened** | **Never happened.** The first real question about my conference was never asked |
| Where action 30 landed | Not reached. I gave up at 15, about a quarter of the patience I had budgeted |
| Actions to my conference existing | ∞ |
| Actions to the call being publicly reachable | ∞ |

**The screen where I would have closed the tab:** `/portal`, immediately after signing up
(`.walk/04-portal-after-signup.png`). Confirmed four actions later when `/admin` silently
bounced me back to that same page (`.walk/07-admin-redirects-to-portal.png`).

---

## What the very first screen after signing up gave somebody who has nothing

This is the thing the scenario exists to find out, so it gets its own section.

I pressed **Create account** and landed on `/portal`. In large serif type:

> **You have not started a proposal yet**
> When you submit one, this page becomes the talk: where it has got to, and what is still
> waiting on you.
> **[ Find an open call ]**

The nav had three items: *Your talks*, *Profile*, *Sign out*.

The word "event" does not appear. Nor "conference", nor "organizer", nor "create", nor
"call for papers" except as somebody else's to answer. The single primary action offered to a
brand-new account points at **submitting a talk to another conference**. It is a well-made
empty state that has been designed for the wrong person, and it is the first thing a paying
buyer sees.

I sat still and read it twice. That reread is re-do #2 and it is the most expensive one in the
walk, because everything after it was a hunt.

---

## What confused me — quoted from the journal as written at the time

On `/signup` (`.walk/03-signup.png`), reading *"what you can do depends on what you have been
granted or invited to"*:

> I have not been granted or invited to anything — I came here off my own bat. So am I about
> to create an account that can do nothing? … Nothing on this screen says "you'll set up your
> conference next".

On `/portal`, thirty seconds later:

> Where do I create my conference? Is this instance only for DevFlow and I've signed up to
> *their* speaker portal? Did I miss a step where I was supposed to say I'm an organizer?

On `/` while signed in (`.walk/06-root-signed-in.png`), looking at a **Sign in** button in the
middle of a page whose header said *Profile · Sign out*:

> Am I signed in? Why does the nav change between pages?

On `/admin` bouncing silently to `/portal`:

> Does an organizer area exist at all? If it does, how does anybody get into it — is it seeded
> by hand, or invitation only? Is self-serve simply not a thing here and the marketing site is
> writing cheques the product will not cash?

On the 403 at `/admin/events` (`.walk/10-admin-events-403.png`), reading *"You do not have
permission to manage this event's configuration"*:

> *Which* event? I asked for the list. There is no "this event".

None of these questions was answered by any screen I reached.

---

## Was it ever unclear which things belonged to my organization and which to an event?

I never got far enough for that distinction to arise, which is itself the answer: **the product
never once used the word "organization" on any screen I saw.** The sign-up page did not ask
what my conference or company was called. The homepage calls itself "this Podium instance" and
lists two events belonging to a conference I have never heard of, under the heading "Every
public event running on this Podium instance" — which reads as though I have wandered into
somebody else's tenancy, and I could not tell from any screen whether that was true.

---

## What took more than one attempt

Every single thing after sign-up. In order:

1. **Finding sign-up at all.** The homepage has two *Sign in* links and no *Create account*.
   I had to go through the sign-in door to find the sign-up door, where "No account yet?
   Create one." sits *below* the primary button in the lightest text on the card.
2. **Profile** — opened purely to find out whether "organization" lived there. It is a 25-field
   speaker profile telling me I am **0% complete** at a job I did not apply for.
3. **Back to `/`** — two clicks to re-check the homepage in case being signed in changed it.
   It did not.
4. **Guessed `/admin`** — silently redirected to `/portal`. No message, no banner, no trace.
5. **Guessed `/events/new`** — 404.
6. **Clicked the product's own "admin dashboard" link** on that 404 — landed in `/portal`.
7. **Guessed `/admin/events`** — 403 about an event that does not exist.
8. **Guessed `/admin/events/new`** — 403 again.

Steps 4–8 are URL archaeology. No real evaluator does that; I did it so the report could say
with certainty that there was no way through. A real Alex stopped at step 2 and paid the
renewal.

---

## Findings

### F1 — A self-signed-up organizer has no path to their own event, and is never told why
**Fatal · Bug and taste · Certain**

- **Where:** `/portal` after sign-up, `.walk/04-portal-after-signup.png`; `/admin`,
  `.walk/07-admin-redirects-to-portal.png`.
- **Doing:** trying to create Northwind Devcon 2027 from a fresh account.
- **Expected:** "You don't run an event here yet — create one", or at minimum "this instance
  belongs to someone else; to run your own, do X".
- **Happened:** the speaker portal, an invitation to answer somebody else's call, and a silent
  redirect when I asked for the organizer area by name.
- **Cost:** the entire task. 15 actions, 10 re-dos, nothing created.
- **What would have worked:** one sentence on the post-sign-up screen naming what this account
  can and cannot do here and where an organizer goes instead. It does not need a feature; it
  needs a sentence.

### F2 — `/admin` redirects a person with no grants to `/portal` in silence
**Fatal (it is the mechanism of F1) · Bug · Certain**

- **Where:** `.walk/07-admin-redirects-to-portal.png`.
- A refusal would have told me the organizer side exists and what I need to get in. A silent
  bounce told me nothing and left me believing the product had no such thing. This is the
  single press that decided the evaluation.

### F3 — The 404 page advertises an "admin dashboard" whose link lands in the speaker portal
**Serious · Bug · Certain**

- **Where:** `/events/new`, `.walk/08-404-events-new.png`; then the click.
- The error page is the **only** screen in the whole product that admits an organizer area
  exists. Following its own link does not take you there and says nothing about why. A product
  that offers a link and does not honour it spends trust it cannot get back in an evaluation.

### F4 — "You do not have permission to manage **this event's** configuration" on a route with no event
**Serious · Taste (maker's-mind slip) · Certain**

- **Where:** `/admin/events`, `.walk/10-admin-events-403.png`; same shape at `/admin/events/new`
  (`.walk/11-admin-events-new-403.png`), where it becomes "change this event's settings".
- I asked for a *list*. The message is written from inside the permission check, and it made me
  reread the screen three times looking for the event it meant.

### F5 — Signed-in pages tell me I am signed out
**Serious · Bug · Certain**

- **Where:** `/` while signed in (`.walk/06-root-signed-in.png`) shows a **Sign in** button in
  the page body while the header shows *Profile · Sign out*. Both 403 pages
  (`.walk/10`, `.walk/11`) put **Sign in** in the header while my session was live.
- Cost: a doubt about my own session state at the exact moment I was already doubting the
  product.

### F6 — There is no way to sign up from the front door
**Sand · Taste · Certain**

- **Where:** `/`, `.walk/01-root-events-index.png`.
- Two identical *Sign in* links (one in the header, one floating beside the intro paragraph
  with no visible reason to be there) and no *Create account*. The homepage of the product I
  had come to buy is a directory of somebody else's conference.

### F7 — The nav changes composition on every screen
**Sand · Bug · Certain**

- `/portal`: *Your talks · Profile · Sign out*. `/` signed in: *Profile · Sign out* — "Your
  talks" vanishes. 404: *Sign out* alone. 403: *Sign in*. Four navs in five screens; I never
  built a model of where things live because the furniture moved.

### F8 — A 0% completeness nag ninety seconds into the account
**Sand · Taste · Fairly sure**

- **Where:** `/portal/profile`, `.walk/05-portal-profile.png`.
- "Still missing: a one-line headline, your job title, your company, a bio, a short bio for the
  schedule card, a headshot, where you are based, at least one link." For a speaker mid-flow
  this is probably kind. For an evaluating organizer it is the second screen in a row insisting
  I am somebody else.

### F9 — A 416 px card centred in 1440 px
**Sand · Taste · Fairly sure**

- **Where:** `.walk/03-signup.png`. "Create your account" wraps to two lines and the intro runs
  to six lines in a forty-character column, on a screen with 1000 px of empty space either
  side. Nothing is broken; it just looks like a phone layout somebody forgot to grow up.

---

## Moments of care

There are real ones, and they are all in the same place, which is worth saying because it tells
you whose instinct to follow.

- **"As you write it. It is never split into first and last."** under the name field on sign-up.
  It answered a question before I had finished having it.
- **"Free text. Never inferred."** under Pronouns.
- **"Phone, dietary and accessibility notes are for logistics and never appear on any public
  page, whatever you set here."** — an absolute promise, in my language, at the point of doubt.
- **"You can opt out of the directory and still speak. Only you can change this."**
- **"Uploading again never overwrites — the previous version stays stored and listed."**
- The portal empty state — *"When you submit one, this page becomes the talk: where it has got
  to, and what is still waiting on you"* — is a genuinely lovely piece of writing about what a
  screen will become. Somebody cared about the speaker's first minute. Nobody has yet written
  the equivalent sentence for the organizer's.
- The 404 card is calm, offers three specific destinations, and does not blame me.

The craft in this product is real and it is concentrated entirely on the applicant side. That is
the finding behind the finding: the first-run path for the person who pays has not had one pass
of the attention the profile form has had five of.

---

## What I lost by leaving and coming back

Nothing, because there was nothing to lose. One sitting, as specified, and the walk ended
before any work existed to preserve. I cannot report on E for this journey and did not test it.

---

## The six dimensions

| | | |
|---|---|---|
| **Orientation** | **1** | After sign-up, no screen told me that running an event is something this product does for me, or where I was in doing it. |
| **The obvious next step** | **1** | The one primary action a new organizer is offered is "Find an open call" — submit a talk to somebody else's conference. |
| **Effort** | **2** | It asked for very little (three fields, all fair), then spent 15 actions and 10 re-dos of mine on nothing at all. |
| **Forgiveness** | **2** | Errors are polite and "Go back" works, but `/admin` bounces in silence and the 403 names an event that does not exist. |
| **Trust** | **1** | The only screen that admits an admin dashboard exists links to it and does not take you there; signed-in pages show "Sign in". |
| **Craft** | **3** | Beautiful type and genuinely careful privacy copy, undercut by four navs in five screens, a stray Sign in button, and a phone-width card on a desktop. |

## ★☆☆☆☆

**The sentence that decided it:** I asked for the admin dashboard by name, the product put me
back on a page about proposals I had not written, and said nothing — so I concluded, wrongly or
rightly, that I could not run my conference here, and there was no screen anywhere that could
have told me otherwise.

The task could not be completed by its intended user. That is a one-star journey however good
the profile form is.

---

## The shortest path to the next star

To reach two stars, an evaluating organizer has to be able to *finish*, even by working around
the product. Three changes, in the order I hit them:

1. **`/admin` must never redirect a signed-in person to `/portal` in silence.** Show a page —
   even a refusal — that names what this account can do here and what it would take to run an
   event. This one press is the whole rating.
2. **Give the post-sign-up screen a second sentence for the organizer.** One line on `/portal`
   telling a grant-less account what this instance is and where the organizer's road starts.
   Today the screen speaks to exactly one of the three people the sign-up page said the account
   is for.
3. **Make the 404's "admin dashboard" link honour itself**, and stop rendering "Sign in" to
   people who are signed in. Both are cheap and both are trust.

If only one of these ships, ship the first. Everything else I hit was sand on top of it.

---

## What I could not check

- Whether an email arrived after sign-up, and whether it contained the missing signpost. There
  is no way to read mail from inside the product as a user.
- Whether the marketing site promises self-serve event creation. I did not open it; the claim I
  was walking against was the scenario's, not a page I could cite.
- Anything past the first event: rooms, tracks, review, sponsors, schedule. All of it hangs off
  an event I could not create.
- The phone viewport. This journey was specified at 1440 × 900 and I did not confirm the other
  width.
- Whether a *fresh, unseeded* deployment behaves differently. I walked the world I was given.

---

## Written after the ratings were fixed, from the code — changes nothing above

I broke character only after every score above was written down.

**The screen I needed exists, and is unreachable on this deployment.**
`workers/api/src/surfaces/admin-home.ts` has, at line 57, exactly the empty state I spent
fifteen actions hunting for:

> **There is no event yet** — Everything else in here hangs off one, so this is the only thing
> to do. **[ Create an event ]**

I never saw it because the guard eight lines above it picks the newest event in the *whole
database* as the focus, tests my staff status against **DevFlow's** event, and redirects:

```ts
const focus = live[0] ?? events[0] ?? null;
const ev = focus ? toEventRef(focus) : null;
if (!ctx.isStaff({ event_id: ev?.id })) {
  // Not staff anywhere — the portal is where their work lives.
  return redirect("/portal");
}
```

So the "no event yet" state can only render for somebody who is already staff — which is
nobody who has just signed up. The good screen is behind the door it was written to open.

**And the tenancy model means my premise was never going to hold.**
`workers/api/src/contexts/identity/setup-routes.ts` shows the deployment is single-tenant: one
`Organization`, created once at `/setup` by the first person, who becomes its `owner`, and both
routes refuse on every method the instant that row exists (INV-01-16). Everyone who signs up at
`/signup` afterwards is by design a speaker or reviewer of *that* org's events. Adopting the
product means deploying your own instance and reaching `/setup` first — not signing up on a
running one.

That is a coherent design and I am not arguing with it. It sharpens the report rather than
softening it, in three ways:

1. **No screen ever says it.** Not `/`, not `/signup`, not `/portal`. The one sentence that
   would have ended my confusion in ten seconds — *this instance belongs to someone else; to
   run your own conference, deploy your own and set it up there* — is written nowhere. Every
   finding above is downstream of that missing sentence, and it is a copy change, not a
   feature.
2. **The findings that are plain defects stand regardless of tenancy:** the 404's lying admin
   link (F3), "this event's configuration" on an event-less route (F4), the signed-in "Sign in"
   buttons (F5), the shifting nav (F7).
3. **The scenario's question is still answered, and the answer is no.** Somebody who arrives
   with nothing, on a running instance, under their own steam, cannot get to a live call — and
   more importantly cannot find out that they were in the wrong place to try.

*Journal: `scratchpad/journal-new-organization-adopts-the-product.md`. Screenshots: `.walk/01`
through `.walk/11`.*
