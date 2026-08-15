# Does the public surface hold up?

**Journey** `public-surface-holds-up` (S7) · **Walked** 15 August 2026 · **Rating** ★☆☆☆☆

Two people, one surface. The person who looks after the conference's own website, and somebody
who bought a ticket. Three sittings: 1440×900 signed in as Jordan Alvarez, then 390×844 signed
out on a new device, then 390×844 the next morning on the same phone.

---

## Who I was, and what I came for

**Sitting 1 — Jordan Alvarez, webmaster.** I look after devflowconf.com. I am comfortable in our
CMS, which takes raw HTML blocks. I will paste a snippet somebody gives me. I will not read an
API document. I have a login for the conference tool because someone made me one; I have never
gone looking in it for anything. Laptop, Thursday afternoon, because the marketing lead asked me
this morning whether we can get the schedule on the site.

*What done looks like:* a bit of HTML pasted into a page on my own machine, opened in a browser,
showing the real DevFlow Conf 2027 schedule — and then the same page viewed signed out, to be
sure it isn't showing only because I happen to be logged in.

*What I'd do instead:* ask the programme director to email me a CSV and hand-build a table. An
afternoon now, and an afternoon every time the schedule changes.

*Stop rule:* if getting the schedule onto a page requires writing code, I give up.

**Sittings 2 and 3 — no name.** I bought a ticket. Someone posted the event link. Hotel wifi,
11pm, phone, the night before day one. I want to know what I'm watching tomorrow — three talks —
and I want to still have that when I wake up.

*What done looks like:* I know where to be at 9am, and while walking the next morning I can get
back to my three choices in one action.

*What I'd do instead:* screenshot the schedule, which is what I actually do at conferences.

*Stop rule:* I give up on any screen that asks me to make an account, and I say so.

---

## The counts

| | Sitting 1 (webmaster) | Sitting 2 (attendee, night) | Sitting 3 (attendee, morning) | Total |
|---|---|---|---|---|
| Screens opened | 14 | 5 | 3 | **22** |
| Actions | ~40 | 13 | 3 | **56** |
| Fields typed | 4 | 0 | 0 | **4** |
| Re-dos | 10 | 1 | 0 | **11** |

- **Actions before the first thing that advanced the webmaster's job: 23** — and it only happened
  because I gave up and read the source. From the screens alone, the number is unbounded.
- **Answers the product already had: 2.** I typed an allowed-origin domain into two separate
  embeds. The event record already holds `Website: https://devflowconf.example`, and each embed
  already had that domain in its list.
- **Actions from the public event page to knowing where to be at 9am: 1.** One tap on "Read the
  schedule". (The answer itself is inferred, not stated — see findings.)
- **Actions in sitting 3 to get back to the three choices: 2.**
- **Did anything appear publicly that the organizer had not published?** No. The public site shows
  exactly the six sessions in published v1. The leak risk is clean; the *reverse* is not — see
  finding 8.
- **Does the whole attendee trip work with a thumb, in daylight?** With a thumb, yes — no
  horizontal scroll at any point, star buttons 34×34, day tabs 43×44. In daylight, the one fact I
  need is the one the design whispers: the room number renders at 13px in `rgb(138,136,126)` on
  `rgb(247,247,245)`, about **3.2:1**.

---

## What confused me

Quoted from the journal as written at the time.

> Nothing here tells me I can put this on my own site. If I had arrived here and nowhere else I
> would have concluded the answer is no and gone back to asking for a CSV. *(event page)*

> Two public pages in and the product has offered me a calendar feed twice and a web embed zero
> times. My CMS cannot render an .ics. *(schedule page)*

> Sixteen sidebar items and not one of them is called anything a webmaster would recognise. I am
> guessing. *(admin Today)*

> The green bar says "The public schedule matches the working copy" and the row says 6 sessions —
> but the sidebar says Sessions 10. So which is it, 6 or 10? *(Publish)*

> I do not know what a capability contract is and I do not want to. This is a screen for the
> person who built it. *(Integrations)*

> The dates say 12–14 May but everything listed says Thu, and 12 May 2027 is a Wednesday. What
> happens on the first day? *(attendee, event page)*

> Is day 1 really empty, or is it just not published? "yet" implies the latter and I have no way
> to tell. If I fly in on the 12th, have I wasted a day? *(attendee, Day 1)*

> If I star two things at once, which one does the calendar think I'm going to? *(attendee)*

> Nothing tells me what happens to my stars if I clear my browser. *(attendee)*

---

## What took more than one attempt

| # | What I tried first, and why | What happened |
|---|---|---|
| 1 | Read the whole event page for the word "embed" / "add to your site" | Not there. Read it twice. |
| 2 | Read the whole schedule page for the same | Not there. Only "Add to calendar". |
| 3 | Admin → **Publish**, because it had a "v1" badge and the schedule footer said "version 1" | Immutable snapshots. Wrong door. |
| 4 | Admin → **Setup**, the only other event-level word that sounded like configuration | Days, tracks, rooms. Wrong door. |
| 5 | Settings → **Integrations**, the only sub-item that sounds like "connect to something else" | "Capability contracts — the core never imports a vendor SDK." Wrong door. |
| 6 | Header search for `embed`, then `website`, then `public` | "Nothing here matches" three times. |
| 7 | Event **Overview**, then the **Event settings** drawer | Good screens. Neither mentions embedding. |
| 8 | Public **Gallery**, an unfamiliar word | Speaker photos. |
| 9 | Pasted the snippet into my own page | Blank. Nothing rendered, nothing said. |
| 10 | Pasted the second widget after fixing the first allowlist | Had to repeat the same three actions on the second embed; the allowlist is per embed. |
| 11 | *(attendee)* Opened Day 1, because the conference starts on the 12th | "Nothing is scheduled on this day yet." |

---

## What was not intuitive

- **The Embeds screen is not linked from anything.** Not the console sidebar, not the command
  palette's full screen list (which I read end to end), not Publish, not Overview, not Setup, not
  Settings, not the public schedule. When you reach it by URL, the sidebar highlights **Publish** —
  so the product already believes Embeds belongs under Publish. Publish has no link to it.
- **`*` in an allowed-origins list means "any origin"** to every webmaster alive. Here it is an
  exact-match string that matches nothing, and the screen shows it as if it were doing something.
- **A blank embed is not a failure state anyone can act on.** The `<div>` marks itself
  `data-podium-mounted="1"` and stays empty. The only evidence is in devtools.
- **The "agenda grid" widget lands on Day 1.** The product's own schedule page opens on Day 2
  because it knows Day 1 is empty. The embed does not, and has no day switcher.
- **The attendee's own day has no address.** Ticking "Starred only" does not change the URL, so
  there is nothing to bookmark or put on a home screen — which is exactly what turns 2 actions
  into 1 on the walk to the venue.

---

## What I lost by leaving and coming back

Measured in E's order. **Nothing was lost.** This is the strongest part of the trip.

1. **Is my work here?** Yes. All three starred talks, exactly as left, after a full browser close.
2. **Do I know it is here without hunting?** Half. The page I re-entered on — the event page —
   looks identical to a first visit and says nothing. One tap later the schedule's button reads
   **"Add my 3 sessions to calendar"**, and that is the moment I relaxed. Right signal, one screen
   too late.
3. **Actions to get back:** 2. Would be 1 with a bookmarkable "my day".
4. **Does it tell me what is left / what is next?** No. Walking at 9am I want "next: 10:00, Room
   2B". I get a list starting at 08:00 with registration in it. Nothing is marked as now or next.
5. **Does it still know what it knew?** Yes — day 2 default, timezone, rooms, and the calendar
   link still filtered to my three.
6. **Did anything change under me?** No, and the footer says so: "Published version 1 · today."
7. **What arrived in between?** Nothing, and nothing could. No account, by choice, and the product
   never once asked for one.

**At the moment of leaving**, the product said nothing. The sentence at the top of the schedule —
"it stays in this browser" — is doing all the work, and it is doing it before I have anything to
lose rather than after.

---

## Moments of care

These are the instincts to follow.

1. **"Star a session to build your own day — it stays in this browser."** Above the fold, before I
   tap anything, telling me both what the control does and where the result lives.
2. **The calendar button counts.** "Add to calendar" → "Add my 2 sessions to calendar" → "Add my 3
   sessions to calendar". The product repeating my choice back to me in my own units, and the one
   thing that told me, the next morning, that it had remembered.
3. **The .ics is the best artefact in the product.** It contains exactly my three sessions and
   `LOCATION:Room 2B (Level 2)` — including the **floor**, which no web page showed me. It needs
   no account and it lands in the app I already use.
4. **"Nothing is scheduled on this day yet."** A designed empty state in plain language, with the
   word "yet" carrying real information.
5. **The starred set is shared across screens.** My three showed as already ticked on
   `/e/…/sessions` without my doing anything.
6. **Honest degradation copy.** "Search needs JavaScript; the full directory below works without
   it." "The full schedule below works without them." Rare, and worth keeping.
7. **The schedule is a schedule, not a filter wall.** Filters exist and are small; the talks start
   about one thumb-scroll down at 390px.
8. **The embed reflows properly at phone width** inside somebody else's container, with no
   horizontal overflow. Somebody thought about that.
9. **The embed renders identically to a signed-out stranger** — the thing I most wanted to check.
10. **"Everything on this screen is a link to the place the thing can be done."** The best sentence
    in the console.
11. **Star buttons carry real labels** — `Star Agents That Ship: …` — not "toggle".
12. **"Embed updated."** Immediate, plain, and the row updated in place.

---

## Findings

### FATAL

**1. The Embeds screen cannot be reached from any screen.** *(bug · certain)*
`/admin/events/:eventId/embeds` · 1440×900 · `.walk/09-search-embed.png`, `.walk/15-admin-embeds.png`

I opened ten screens as the webmaster and read a sixteen-item sidebar, an eleven-item settings
sub-nav and the command palette's complete list of destinations. The word "embed" appears nowhere
in any of them. I searched the palette for `embed`, `website` and `public` and got "Nothing here
matches" three times. I only found the screen by breaking character and reading the source, which
caps this step at one star and means every note after it was written by somebody who knows too
much. The screen itself is *good* — three embeds already made, my own domain already in the
allowlist — which makes it worse: somebody built me exactly what I needed and then hid it.
**Cost:** 10 screens, ~23 actions, 7 re-dos, and the task is unreachable by its intended user. A
CMS person hits their stop rule long before this.
*What would have worked:* one line on the Publish screen. The sidebar already highlights Publish
when you are on Embeds.

**2. Every session title in the embed is a dead link on the host site.** *(bug · certain)*
`http://localhost:8080/site.html` · `.walk/21-webmaster-page-both-widgets.png`, `.walk/22-embed-link-404-on-host.png`

The widget writes `href="/e/devflow-conf-2027/sessions/ses_…"` — root-relative. On my page that
resolves against *my* domain. I clicked "The Build Cache Is Not Your Problem" and got my own
server's 404. Every session, on every host site, every time. This is the surface that "fails
silently and at scale": the webmaster who ships it will never click their own embed, and the
visitor who does gets a 404 on the conference's website.
**Cost:** the artefact is unshippable. I would not have put this page live.

**3. A failed embed renders nothing and says nothing.** *(bug · certain)*
`.walk/17-webmaster-page-desktop.png`

First paste: my heading, my sentence promising the schedule, then a void, then my footer. The div
sets `data-podium-mounted="1"` and has zero children. No message, no fallback link, no "couldn't
load". The cause was CORS, visible only in devtools. Compounding it: the Embeds screen listed my
allowed origins as `https://devflowconf.example, http://localhost:8787, **\***`, and the `*` does
nothing — it is matched as a literal string. I read it as "any site", as anyone would.
**Cost:** one full paste-and-publish cycle wasted, with no way to diagnose it from the product.

### SERIOUS

**4. The flagship widget renders an empty sentence.** *(bug · certain)*
`.walk/20-webmaster-page-working.png`

Once CORS was fixed, the agenda-grid embed rendered, in its entirety: *"Nothing placed in a public
room on Day 1 — Workshops."* It defaults to Day 1, which is empty, and has no day switcher. The
product's own schedule page opens on Day 2 precisely because it knows Day 1 is empty. Two pieces
of the same feature disagree about which day to show. The sentence is also written for the
organizer, not for my visitors — they do not know what "placed" or "a public room" means.

**5. Two talks at the same time look like two talks.** *(taste · certain)*
`/e/devflow-conf-2027/schedule` · 390×844 · `.walk/29-two-clashing-starred.png`

I deliberately starred both 10:00 talks. The product said nothing — no warning, no marker, no
"these overlap". On a phone the two entries are a full screen apart because their abstracts push
them there; the only clue is the string "10:00" appearing twice. Then the .ics exported both,
silently. Telling me my day has a collision in it is the single most useful thing a night-before
schedule can do, and it is the one thing this one will not do.

**6. An hour-long break is labelled a thirty-minute talk.** *(bug · certain)*
`/e/devflow-conf-2027/sessions` and the embed · `.walk/36-public-sessions-list.png`, `.walk/21-webmaster-page-both-widgets.png`

*"Registration and coffee — 13 May 2027, 08:00 – 09:00 · Main Stage · **Talk (30 min)**"*.
*"Lunch — 12:30 – 13:30 · **Talk (30 min)**"*. The label is the format's name, which has the
format's default length baked into it, printed next to the actual times that contradict it. This
is on the conference's own public page and on the embed the webmaster ships.

**7. The header search says it searches one thing and searches another.** *(bug · certain)*
`/admin/*` · `.walk/09-search-embed.png`

The button reads **"Search proposals, people, sessions"**. The empty state inside reads **"This
searches screens and actions, not proposals or people."** They contradict each other in one tap.
Also: Escape with text in the box clears the text but does not close the dialog, though the footer
says "esc close" — it took two presses, and the second attempt to click the sidebar timed out
because the dialog was still intercepting pointer events.

**8. "0 unpublished", while the public site shows six of ten.** *(bug · medium confidence)*
`/admin/events/…` · `.walk/05-admin-publish.png`, `.walk/10-admin-event-overview.png`

Publish shows a green bar, "The public schedule matches the working copy", above a row reading
`v1 / LIVE / 6 sessions`. Overview shows "10 of 10 confirmed sessions have a room and a time" and
a card reading **0 unpublished**. The sidebar says Sessions 10. The public site shows 6. I could
not work out from any screen which four are missing or why. I am marking this medium confidence
because "unpublished" may mean something narrower than it reads.

### SAND

**9. The session page has no star.** *(taste · certain)* `.walk/31-session-detail-phone.png`
Most people meet a talk through a link someone sent them. From the talk's own page I cannot add it
to my day; I have to go back to the schedule and find it again. The page is otherwise excellent —
it gives me the room, which was the thing I most needed.

**10. The talk's page is titled "Session · Podium".** *(taste · certain)*
Shared to a group chat, the preview says "Session".

**11. My own day has no URL.** *(taste · certain)* `.walk/35-return-my-three.png`
"Starred only" leaves the URL at `/e/devflow-conf-2027/schedule`. There is nothing to bookmark,
which is the difference between 2 actions and 1 while walking.

**12. The room number is the least legible text on the page.** *(taste · certain)*
13px, `rgb(138,136,126)` on `rgb(247,247,245)`, about 3.2:1. It is the one fact a walking attendee
needs.

**13. The event advertises 12–14 May and nothing happens on the 12th.** *(taste · certain)*
`.walk/25-attendee-event-phone.png`, `.walk/27-attendee-day1-empty.png`
The hero says "12–14 MAY 2027". Every session listed says "Thu". Day 1 says "Nothing is scheduled
on this day yet" — and "yet" leaves me unable to tell whether the day is empty or merely
unpublished. If I book a flight for the 11th, I have guessed.

**14. The primary call to action points at the sponsor call.** *(bug · medium confidence)*
`.walk/01-public-event-desktop.png`
The hero button and the nav both read "Submit a talk" and both link to
`/e/devflow-conf-2027/cfp/sponsor-sessions`, with the hero quoting "closes 10 Apr". The general
call for papers, which closes 30 April, is findable only as the first item in a sidebar list.

**15. The embed ships unprefixed class names into other people's pages.** *(taste · certain)*
`class="grid two"`, `class="session-card"`. `grid` and `two` are exactly what a CMS theme already
defines. It also ships no styles at all, so links render browser-blue against whatever brand the
host has, and nothing on the Embeds screen tells the webmaster what to style.

**16. The Embeds edit form is clipped off the right edge of the window.** *(bug · certain)*
`.walk/18-embed-edit-open.png` · 1440×900. The popover's inputs end at x≈1534 in a 1440 window,
and while it is open the first table column collapses to one word per line.

**17. The Event settings drawer hides its last field behind its own footer.** *(bug · certain)*
`.walk/11-event-settings.png`, `.walk/13-event-settings-bottom.png`. The drawer body scrolls
separately from the page with no visible edge; "Website" sits under the sticky Save bar.

**18. "localStorage" is on a page for ticket holders.** *(taste · certain)*
`.walk/36-public-sessions-list.png`. The sentence around it is genuinely kind — "Starring works
without an account — it lives in this browser only" — and would be perfect without the parenthesis.

**19. Maker's vocabulary on public and near-public screens.** *(taste · certain)*
"Last updated: **v1** · today" and "Published **version 1**" on the public pages; "immutable
snapshot", "working copy" on Publish; "Capability contracts — the core never imports a vendor SDK",
"Install a plugin", "Outbox only (no provider) (email)", `email.resend` on Integrations; "Format —
an impossible pair (e.g. speaker_gallery as ics) is rejected on save", "CORS and frame-ancestors
allowlist", "Cache TTL (seconds)" on Embeds; "Origins: Invited, **Cfp**" on Setup.

**20. Signing in as the person who runs the event lands on "You have not started a proposal yet."**
*(taste · certain)* `.walk/03-after-signin-portal.png`. A full screen and a big black button
offering to help me write a talk, with my actual job behind the small grey word "Admin" — which
opens in a new tab without saying it will.

---

## The six dimensions

| | | |
|---|---|---|
| **Orientation** | ★★☆☆☆ | The attendee always knows where they are; the webmaster never learns the embed exists, and when the screen is finally found it describes three widgets in one line each and previews none of them. |
| **The obvious next step** | ★★☆☆☆ | "Read the schedule" is the perfect button. For the webmaster there is no next step on any screen — sixteen sidebar items, eleven settings items, and a search that answers "Nothing here matches". |
| **Effort** | ★★☆☆☆ | One tap from the event page to the schedule, two to get back the next morning — against 23 actions before the webmaster's job moved at all, and an allowed-origins list re-typed per embed when the event record already holds the domain. |
| **Forgiveness** | ★☆☆☆☆ | The embed fails to an unexplained blank; `*` in the allowlist is shown and ignored; Escape does not close the palette on the first press; the drawer hides its own last field. |
| **Trust** | ★★☆☆☆ | It kept three starred talks perfectly across a browser close, then told me an hour-long registration block is a "Talk (30 min)", labelled a search box for a thing it does not search, and reported "0 unpublished" while the public site shows six of ten. |
| **Craft** | ★★★☆☆ | The public pages are genuinely beautiful — type, empty states, honest degradation copy — and the console is visibly a different product, with a clipped popover, a clipped drawer, and a widget that puts `class="grid two"` into somebody else's stylesheet. |

---

## ★☆☆☆☆

**The sentence that decided it:** the one screen the webmaster needed cannot be reached from any
screen in the product, and when I cheated my way to it, the page I built with it had every talk
title 404ing on my own domain and a blank where the schedule should be.

This is one rating over two very different trips, and the report is worth nothing if it hides
that. **Walked alone, the attendee's journey is a four**: nothing was lost, the return cost two
actions, the calendar file knew the floor number, and at no point was I asked to make an account.
Its blemishes are nameable — no clash warning, no address for my own day, a room number at 3.2:1.
**The webmaster's journey is a one**, and one fatal step caps the journey, however good the rest
of it was.

---

## The shortest path to the next star

Two changes. Both are load-bearing for "the intended user can finish".

1. **Link Embeds from the Publish screen** (and give it a sidebar row). The console already
   highlights Publish when you are on Embeds; it is one line of navigation, and it removes seven
   of my eleven re-dos and twenty-three of my actions.
2. **Make the widget's session links absolute.** `href="/e/…"` becomes the embed's own origin.
   Without this, the reward for finding the screen is a page whose every link is broken.

Everything else — the empty-day default, the silent CORS blank, the `*` that does nothing — is
what stands between two stars and three.

---

## What I could not check

- **What the embed does when the schedule changes underneath it.** It needs a v2 publication, which
  would change the world mid-walk for every other scenario sharing this seed.
- **Finding one speaker among a hundred.** The fixture has four.
- **A panel with eight people on it.** The fixture has none; every session has exactly one speaker.
- **The iframe and ICS embed formats.** All three seeded embeds are `js_widget`.
- **The real host origin.** `https://devflowconf.example` does not resolve here, so I served my page
  from a second local web server — a genuinely different origin, which is the honest version of the
  test, but not the production one. A `file://` URL is blocked in this browser.
- **Anything that arrives by email**, because the attendee never made an account, by design.
- **Whether re-walking gives the same numbers.** Walked once. Sitting 1 wrote to the fixture (see
  below), so a re-walk is not identical.

---

## Arranged through the product

Rule D: I changed nothing in the seed, the database or the code. I did, as the webmaster and
through the product's own screens, add `http://localhost:8080` to the Allowed origins of two
embeds ("Main site — agenda grid" and "Main site — sessions list"), because the first paste
silently failed and that is what a webmaster would eventually do. Those two rows now differ from
the shipped seed. Nothing else was touched.

---

## After breaking character

Written after the ratings above; it changes none of them.

I broke character once, in sitting 1, after the stuck-person moves ran out. Everything from
"S1.8" in the journal onward was written by somebody who knew the screen existed.

- `/admin/events/:eventId/embeds` is registered in
  `workers/api/src/contexts/scheduling/routes.ts:709`. The route is real, complete and server
  rendered. Nothing links to it.
- `workers/api/src/contexts/scheduling/widgets.ts:35` is explicit about the wildcard:
  *"`allowed_origins` is an exact-match allowlist; there is no wildcard in the model, so none is
  honoured here."* That is a deliberate and correct security decision — which makes it worse that
  the seed puts `*` in the list and the admin screen prints it as an allowed origin. An organizer
  reading that screen would believe their embed is open to any site, and might remove the entry to
  "tighten" something that was never loose.
- The relative session link is `widgets.ts:311` (and `:360`, `:386`, and the RSS `<link>` at
  `:528`). The same rendering code serves the product's own public schedule page, where a relative
  URL is exactly right. That is why nobody noticed.
- The break label comes from `s.format.name` (`widgets.ts:250`), and the format is literally named
  "Talk (30 min)". `scripts/seed.mjs:1699` gives registration `minutes: 60`. So the printed length
  is the format's, and the times beside it are the session's.
