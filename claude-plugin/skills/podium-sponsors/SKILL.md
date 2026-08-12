---
name: podium-sponsors
description: Manage sponsors on Podium — sponsor companies, their sponsorship of an event, the tier it sits at, and the entitlements (speaking slots, passes, booth, logo placement) a sponsorship grants and consumes. Trigger on "add a sponsor", "confirm the sponsorship", "how many speaking slots does X have left", "has the sponsor used their slot", "which sponsors are unconfirmed", "cancel a sponsorship", "sponsor logo on the site".
---

# Sponsors, sponsorships and entitlements

Read `podium-api` first for connection and conventions.

Three records, and keeping them straight is most of the work:

- **`Sponsor`** (`spo_…`) — the company. Exists once, across every event.
- **`Sponsorship`** (`snp_…`) — that company's participation in *one* event, at a tier.
- **`Entitlement`** (`ent_…`) — a **countable right** the sponsorship grants: two speaking
  slots, six passes, one booth. It has `quantity`, `consumed_count` and `remaining`.

"Entitlement" here means the countable thing, not a general permission. A sponsor talk is a
proposal submitted against an entitlement, which is what decrements it.

## Sponsors

```bash
podium list /v1/sponsors --fields id,name,slug
podium get  /v1/sponsors/spo_…
podium post /v1/sponsors name="Ferro Labs"
podium patch /v1/sponsors/spo_… name="Ferro Labs Inc."
```

## Sponsorships

```bash
podium list /v1/sponsorships event_id=evt_… \
  --fields id,status,sponsor.name,tier.name,entitlement_summary.remaining
podium get  /v1/sponsorships/snp_…
podium post /v1/sponsorships sponsor_id=spo_… event_id=evt_… tier_id=tir_…
podium patch /v1/sponsorships/snp_… contract_reference="CRM-1042"
podium post /v1/sponsorships/snp_…/confirm
podium post /v1/sponsorships/snp_…/cancel reason="Withdrew before contract"
```

A sponsorship is created `pending` and moves to `confirmed`. The list response embeds
`sponsor`, `tier` and an `entitlement_summary` of `{ quantity, consumed_count, remaining }` —
so "how many slots does Ferro Labs have left" is one call, not four.

Other fields: `contract_reference`, `public_from` (when the logo may appear), and
`sort_order_override` for placement among same-tier sponsors.

**A tier is optional at creation and confirmation will not stop you without one** — a
sponsorship confirmed with `tier_id: null` is legal and gets no tier-template entitlements.
If a sponsor should have received a package, check the tier is set.

## Entitlements

```bash
podium list /v1/entitlements event_id=evt_… \
  --fields id,entitlement_type,quantity,consumed_count,remaining,state,expires_at
podium get  /v1/entitlements/ent_…
podium post /v1/entitlements sponsorship_id=snp_… entitlement_type=session_slot \
    quantity:=2 allowed_format_ids:='["fmt_…"]' \
    submission_deadline=2027-04-10T23:59:00Z expires_at=2027-04-30T23:59:00Z
podium patch /v1/entitlements/ent_… quantity:=3
```

Fields: `entitlement_type`, `quantity`, `consumed_count`, `remaining` (derived — never write
it), `state`, `allowed_format_ids`, `constraints` (e.g. `max_duration_minutes`,
`requires_review`), `submission_deadline`, `expires_at`, `source` (`tier_template` when it came
from the tier, `manual` when someone added it), `notes`.

Entitlements from a tier template arrive automatically when the sponsorship gets its tier.
Adding one by hand is for the thing that was negotiated outside the package.

**`consumed_count` and `remaining` are derived at read time and are not writable.** Sending
either to `PATCH /v1/entitlements/:id` is refused with `422 derived_field_not_writable`
(INV-11-6) — not ignored. To change what a sponsor has used, change the thing that consumed it
— the sponsor proposal — not the counter.

`submission_deadline` and `expires_at` are different: the first is when a sponsor may no longer
submit against the slot, the second is when the right lapses entirely. An exhausted or expired
entitlement refuses a new sponsor proposal with a typed error naming the invariant; that error
is the correct thing to relay to the sponsor.

## Sponsor proposals

A talk submitted against an entitlement is a normal `Proposal` carrying `origin: "sponsor"`,
`sponsor_id` and `entitlement_id`. Find them:

```bash
podium list /v1/proposals event_id=evt_… origin=sponsor \
  --fields id,title,status,sponsor_name,entitlement_id
```

They go through review and decision like any other proposal (`podium-proposals`), subject to
whatever the entitlement's `constraints` say — a `requires_review: false` constraint is how a
package promises a slot rather than a chance at one.

## The public side

Confirmed sponsorships past their `public_from` appear on the published event page. If a logo
is missing there, check in this order: sponsorship `status` is `confirmed`, `public_from` is in
the past, and the schedule has been published since (`podium-schedule`).
