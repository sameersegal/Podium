# Handoff: Podium transactional email system (AI Engineer NYC 2026)

## Overview
Three transactional HTML emails for **Podium**, an AI SaaS product that runs CFP review
and conference program workflows. The emails are **conference-first branded**: the
conference (here, the sample "AI Engineer NYC 2026") owns the header, voice, and signature;
Podium appears only as a one-line footer credit ("Program run on Podium"). Podium's AI is
deliberately *not* surfaced in the copy.

Each email covers one moment in the CFP lifecycle and one audience:

| File | Audience | Moment |
| --- | --- | --- |
| `Reviewer Decisions Email.html` | Track chairs & reviewers | Decisions released — thank you + results summary |
| `Organizer Review Status Email.html` | Chairs / organizing team | Mid-round review coverage health check |
| `Speaker Acceptance Email.html` | Prospective speakers | Proposal accepted — confirm your slot |

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing the
intended look and content, not production code to paste in as-is.

The nuance for email: unlike UI mocks, these files *are* written in send-ready email HTML
(tables + inline styles). So there are two valid paths, depending on the target codebase:

1. **Template port (recommended).** Recreate these layouts in the app's existing email
   templating system (MJML, react-email, Handlebars/Liquid, Django templates, etc.),
   replacing the hardcoded content with variables (see **Template variables** below).
   The HTML here is the visual and structural spec.
2. **Direct adaptation.** If there is no email template layer yet, these files can seed one —
   but they must still be parameterized and wired to the sending service (SendGrid, Resend,
   Postmark, SES) before use.

Do **not** ship them with the placeholder names, counts, and `podium.app` URLs intact.

## Fidelity
**High-fidelity.** Final colors, type scale, spacing, and copy. Recreate faithfully.
Copy is written for these specific moments and should be preserved unless product/legal
requires changes; only the bracketed data points are meant to be dynamic.

## Email-client constraints (non-negotiable in a port)
These rules are why the markup looks the way it does. Any reimplementation must keep them:

- Layout is nested `<table role="presentation" cellpadding="0" cellspacing="0" border="0">`.
  No flexbox, no grid, no floats, no `position`. Single-column, stacked rows.
- **Every** style is inlined on the element. The `<style>` block in `<head>` carries only
  the media queries — several clients drop it entirely, so the email must read correctly
  from inline styles alone.
- No JavaScript. No external stylesheets. No web fonts — Helvetica/Arial stack only.
- No images anywhere. The design is built from colored table cells, borders, rules, and type,
  so nothing depends on image hosting or image-blocking defaults.
- Outlook: every table and cell has an explicit width; every text cell sets
  `mso-line-height-rule:exactly` alongside `line-height`.
- Gmail clips past ~100KB; each file is ~11KB.
- `<meta name="color-scheme" content="light dark">` is set and colors are mid-tone
  (no pure #000/#fff backgrounds) so dark-mode inversion stays legible.
- Buttons are "bulletproof": a padded `<td bgcolor>` with `border-radius`, containing an
  `<a style="display:block">`. Never an `<img>`, never a styled `<button>`.
- First element in `<body>` is a hidden preheader span (~85 chars) that previews next to
  the subject line.

## Shared structure (all three emails)
Every email is the same skeleton; only the body rows differ.

1. **Page canvas** — `#efedea`, `32px 12px 48px` padding around the card.
2. **Card** — 600px wide (`max-width:600px`), `#fbfaf8`, `1px solid #e3e1de`, `border-radius:4px`.
3. **Header row** — 28px/40px/26px/40px padding, bottom border `#e3e1de`. Two cells:
   - left: conference name, 16px bold `#1c1b1a`, `letter-spacing:-0.2px`
   - right: audience label, 11px uppercase `#8a8681`, `letter-spacing:0.6px`
     ("Program Committee" / "Program Team" / "Speakers")
4. **Eyebrow** — 11px bold uppercase `#2a6f97`, `letter-spacing:1px`, 14px bottom padding.
5. **H1** — 32px/38px bold `#1c1b1a`, `letter-spacing:-0.6px`, margin 0.
6. **Lede paragraph** — 16px/26px `#46433f`, 20px top padding.
7. **Optional stat strip** — white cell, 1px `#e3e1de` border, radius 4, three equal columns
   split by 1px vertical borders. Number 26px/30px bold; label 11px uppercase `#8a8681`.
8. **Optional data list** — full-width table, each row `padding:12px 0` with
   `border-top:1px solid #e3e1de` (last row also `border-bottom`). Left label 15px `#46433f`,
   right value 15px bold `#1c1b1a`; parenthetical/secondary values drop to `#8a8681` regular.
9. **CTA button** — `#2a6f97` cell, radius 4, link `padding:15px 30px`, 15px bold `#ffffff`.
   A 13px `#8a8681` note sits 12px beneath it.
10. **Closing panel** — `#f2f4f6`, radius 4, `padding:24px 26px`, 36px above / 40px below.
    Holds next steps and the chair's signature (name 15px bold `#1c1b1a`, role `#8a8681`).
11. **Footer** — outside the card, centered, 12px/20px `#8a8681`: permission reason,
    Email preferences · Unsubscribe (both `#2a6f97`, underlined), postal address `#a5a19c`,
    "Program run on Podium" `#a5a19c`.

### Responsive (only breakpoint: max-width 620px)
```css
.container { width: 100% !important; }
.px        { padding-left: 24px !important; padding-right: 24px !important; }
.stat      { display: block !important; width: 100% !important;
             border-right: 0 !important; border-bottom: 1px solid #e3e1de !important; }
.h1        { font-size: 28px !important; line-height: 34px !important; }
```
Class hooks are `.container` (both outer tables), `.px` (every horizontally-padded cell),
`.stat` (stat-strip cells), `.h1`.

## Per-email content

### 1. Reviewer Decisions Email
- Eyebrow "Decisions released"; H1 "Thank you, Priya. The program is set."
- Lede thanks the reviewer, notes 14 proposals in their queue and that their notes were
  quoted back to authors.
- Stat strip: **14** Your reviews · **6** Accepted from your queue · **92** Talks in the program.
- "How the round finished" list: Proposals submitted 1,148 · Accepted 92 (8%) ·
  Waitlisted 31 · Reviewers on the committee 204.
- CTA "See the decisions on your queue" → `/reviews`; note about anonymity.
- Closing panel: waitlist movement through Sept 4, speaker prep, mentor ask (reply-to);
  signed Dan Reyes, Program Chair.
- Footer reason: served on the program committee.

### 2. Organizer Review Status Email
- Eyebrow "Review round · day 12 of 15";
  H1 "Review closes Friday. 84 proposals still need a second read."
- Stat strip: **1,148** Proposals · **78%** Reviews complete · **84** Short a review —
  the third number uses the alert color `#b3541e`.
- "Coverage by track" list: Agents & orchestration 61% (38 short) ·
  Evals & observability 69% (27 short) · Inference & infrastructure 88% ·
  Applied & case studies 94% · Reviewers with an unstarted queue 11.
  The "— N short" suffixes are `#b3541e`, regular weight.
- CTA "Rebalance assignments" → `/coverage`.
- Closing panel "On the calendar": reviews close Aug 21 11:59pm ET, deliberation Monday,
  decisions Aug 28, waitlist through Sept 4.
- Footer reason: chair or organizer.

### 3. Speaker Acceptance Email
- Eyebrow "Your proposal was accepted"; H1 "You're speaking at AI Engineer NYC 2026."
- Lede names the talk in bold and gives the competitive context (1,148 in, 92 accepted).
- Detail card (white, bordered, `padding:22px 26px`, list rows inside):
  Session 35 min + Q&A · Track Inference & infrastructure · Day Thursday, October 15 ·
  Room Assigned in September.
- "Three things to do by August 28" — numbered rows, the numeral bold `#1c1b1a`,
  body 15px/24px `#46433f`, 12px between rows.
- CTA "Confirm your slot" → `/speakers/confirm`.
- Closing panel: reply if the date/format doesn't work; signed Dan Reyes.
- Footer reason: submitted a proposal.

## Template variables
Everything below is placeholder data and must be bound:

- **Conference**: name, postal address, brand accent (see theming), preferences/unsubscribe URLs.
- **Recipient**: first name, role.
- **Reviewer email**: reviews completed, accepted-from-queue, program talk count, round totals
  (submitted, accepted, accepted %, waitlisted, committee size), waitlist end date.
- **Organizer email**: day N of M, proposals, % complete, count short, per-track rows
  (name, %, shortfall), unstarted-queue count, all four calendar dates.
- **Speaker email**: talk title, track, session length, day, room status, confirm-by date,
  submitted/accepted totals.
- **Signature**: chair name, chair role string.
- **Links**: all `https://podium.app/<conference-slug>/...` URLs are placeholders.

Copy that references a number in prose ("14 proposals passed through your queue",
"84 proposals still need a second read", the H1s) must be interpolated from the same
values as the stat strip — plan for pluralization and for the zero/one cases.

## Theming for conference-first branding
The accent `#2a6f97` is the only brand-owned color and appears in exactly three places:
eyebrow text, CTA button background, footer links. Making it a per-conference token is
enough to rebrand the set. Keep the neutrals fixed — they carry the Podium house style
and are tuned for dark-mode survival. If a conference accent is light, check white
button text for contrast (target ≥ 4.5:1) and darken the button fill rather than
changing the text color.

## Design tokens
**Color**
| Token | Hex | Use |
| --- | --- | --- |
| Canvas | `#efedea` | Page background outside the card |
| Card | `#fbfaf8` | Email body |
| Surface | `#ffffff` | Stat strip, detail card |
| Panel | `#f2f4f6` | Closing panel |
| Border | `#e3e1de` | All 1px rules and borders |
| Ink | `#1c1b1a` | Headings, values, emphasis |
| Body | `#46433f` | Paragraphs, list labels |
| Muted | `#8a8681` | Labels, captions, footer |
| Muted light | `#a5a19c` | Address, Podium credit |
| Accent | `#2a6f97` | Eyebrow, CTA fill, links |
| Alert | `#b3541e` | Shortfall numbers (organizer only) |

**Type** — `Helvetica, Arial, sans-serif` throughout.
| Role | Size / line-height | Weight | Tracking |
| --- | --- | --- | --- |
| H1 | 32 / 38 (28 / 34 mobile) | bold | -0.6px |
| Lede | 16 / 26 | regular | — |
| Body, list rows | 15 / 22–24 | regular | — |
| Stat number | 26 / 30 | bold | — |
| Conference name | 16 / 20 | bold | -0.2px |
| Eyebrow | 11 / 16, uppercase | bold | 1px |
| Label / stat caption | 11 / 16, uppercase | regular | 0.6px |
| Button | 15 / 20 | bold | — |
| Caption, footer | 12–13 / 20 | regular | — |

**Spacing** — 6 · 10 · 12 · 14 · 16 · 20 · 22 · 24 · 26 · 28 · 30 · 32 · 36 · 40 · 48 px.
Card gutter 40px desktop / 24px mobile. Section gap 32–36px. Card bottom padding 40px.

**Radius** — 4px (card, panels, button). **Shadows** — none; separation is borders only.

## Assets
None. No images, no icons, no web fonts, no external requests of any kind — by design.
If a conference logo is ever added, it needs a hosted https URL, explicit width/height,
real alt text, and a text fallback for image-blocked clients.

## Accessibility & deliverability
- `lang="en"` on `<html>`; real `href`s everywhere (no `#` anchors).
- All tables are `role="presentation"` so screen readers read the content linearly.
- Footer carries permission reason, preferences link, unsubscribe link, and postal address.
  Even though these are transactional, keep the preferences link; swap the unsubscribe
  wording per legal guidance if the send is classed as transactional-only.
- Content order is meaningful top-to-bottom, so the mobile stack needs no reordering.

## Files
- `Reviewer Decisions Email.html`
- `Organizer Review Status Email.html`
- `Speaker Acceptance Email.html`

Open any of them in a browser at 600px to see the intended rendering. Test a port in
Gmail (web + iOS), Outlook desktop (Windows/Word engine), and Apple Mail before shipping.
