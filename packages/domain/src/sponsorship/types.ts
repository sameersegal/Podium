/**
 * 03 — Sponsorship. Enums, the entitlement state machine, and the pure rules
 * behind INV-03-2 … INV-03-8.
 *
 * Nothing here touches I/O. `consumed_count` and `remaining` are computed from
 * the proposals pointing at an entitlement and never stored (INV-11-6) — the
 * functions below take those counts as input rather than reading them.
 */

export const SPONSOR_STATUS = ["prospect", "active", "lapsed", "blocked"] as const;
export type SponsorStatus = (typeof SPONSOR_STATUS)[number];

export const SPONSORSHIP_STATUS = ["pending", "confirmed", "cancelled"] as const;
export type SponsorshipStatus = (typeof SPONSORSHIP_STATUS)[number];

export const ENTITLEMENT_TYPE = [
  "session_slot",
  "workshop_slot",
  "lightning_slot",
  "keynote_slot",
  "booth",
  "logo_placement",
  "attendee_passes",
  "newsletter_mention",
  "other",
] as const;
export type EntitlementType = (typeof ENTITLEMENT_TYPE)[number];

export const ENTITLEMENT_SOURCE = ["tier_template", "manual", "negotiated"] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCE)[number];

export const CONTACT_ROLE = ["primary", "marketing", "logistics", "speaker_wrangler", "billing"] as const;
export type ContactRole = (typeof CONTACT_ROLE)[number];

export const CONTACT_STATUS = ["active", "revoked"] as const;
export type ContactStatus = (typeof CONTACT_STATUS)[number];

/**
 * The states drawn in 03's entitlement diagram. Derived, never stored: an
 * entitlement row has a quantity, and its state is a reading of the proposals
 * pointing at it.
 */
export const ENTITLEMENT_STATE = ["available", "held", "spent", "forfeited"] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATE)[number];

/** Entitlement types a session proposal may be submitted against. */
export const SLOT_ENTITLEMENT_TYPES: readonly EntitlementType[] = [
  "session_slot",
  "workshop_slot",
  "lightning_slot",
  "keynote_slot",
];

export function isSlotEntitlement(type: string): boolean {
  return (SLOT_ENTITLEMENT_TYPES as readonly string[]).includes(type);
}

/* -------------------------------------------------------------------------- */
/* Consumption                                                                 */
/* -------------------------------------------------------------------------- */

export interface EntitlementCounts {
  /** Proposals holding a slot: alive, not yet on a session. */
  held_count: number;
  /** Proposals whose session exists — the slot is spent. */
  spent_count: number;
}

export interface EntitlementUsage extends EntitlementCounts {
  entitlement_id: string;
  quantity: number;
  /** `D` — count of proposals holding or having spent this entitlement. */
  consumed_count: number;
  /** `D` — `quantity - consumed_count`. */
  remaining: number;
  state: EntitlementState;
}

/**
 * 03, "Consumption is a hold, not a decrement": `consumed_count` is the number
 * of proposals holding or having spent the entitlement.
 */
export function consumedCount(counts: EntitlementCounts): number {
  return counts.held_count + counts.spent_count;
}

/**
 * The state diagram in 03, read off the counts:
 *
 *   [*] --> available            entitlement granted
 *   available --> held           sponsor starts a draft proposal
 *   held --> available           draft withdrawn / abandoned / rejected
 *   held --> spent               proposal approved and session created
 *   spent --> available          session cancelled (chair action)
 *   available --> forfeited      expires_at passes unspent
 */
export function entitlementState(
  entitlement: { quantity: number; expires_at?: string | null },
  counts: EntitlementCounts,
  now: string,
): EntitlementState {
  const consumed = consumedCount(counts);
  if (counts.spent_count >= entitlement.quantity && entitlement.quantity > 0) return "spent";
  if (consumed === 0 && entitlement.expires_at && entitlement.expires_at <= now) return "forfeited";
  if (counts.held_count > 0) return "held";
  return "available";
}

export function usageOf(
  entitlement: { id: string; quantity: number; expires_at?: string | null },
  counts: EntitlementCounts,
  now: string,
): EntitlementUsage {
  const consumed = consumedCount(counts);
  return {
    entitlement_id: entitlement.id,
    quantity: entitlement.quantity,
    held_count: counts.held_count,
    spent_count: counts.spent_count,
    consumed_count: consumed,
    remaining: Math.max(0, entitlement.quantity - consumed),
    state: entitlementState(entitlement, counts, now),
  };
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                   */
/* -------------------------------------------------------------------------- */

export interface EntitlementCheckSubject {
  id: string;
  entitlement_type: string;
  quantity: number;
  allowed_format_ids: string[];
  submission_deadline?: string | null;
  expires_at?: string | null;
  /** For the error message: "Acme Corp has used all 2 session slots for …". */
  label?: string;
}

export type RuleFailure = { invariant: string; code: string; message: string; details?: Record<string, unknown> };

/**
 * INV-03-2 — an entitlement may only be held or spent while its Sponsorship is
 * `confirmed` and the entitlement is unexpired.
 */
export function checkSponsorshipUsable(
  sponsorship: { status: string },
  entitlement: { expires_at?: string | null },
  now: string,
): RuleFailure | null {
  if (sponsorship.status !== "confirmed") {
    return {
      invariant: "INV-03-2",
      code: "sponsorship_not_confirmed",
      message: `This sponsorship is ${sponsorship.status}. Only a confirmed sponsorship may use its entitlements.`,
      details: { sponsorship_status: sponsorship.status },
    };
  }
  if (entitlement.expires_at && entitlement.expires_at <= now) {
    return {
      invariant: "INV-03-2",
      code: "entitlement_expired",
      message: `This entitlement expired on ${entitlement.expires_at}.`,
      details: { expires_at: entitlement.expires_at },
    };
  }
  return null;
}

/**
 * INV-03-3 — `consumed_count <= quantity` at all times. "A submission that
 * would exceed the quantity is rejected with a domain error naming the
 * entitlement, not a generic 400."
 */
export function checkQuantityAvailable(
  entitlement: EntitlementCheckSubject,
  counts: EntitlementCounts,
  sponsorName: string,
  eventName: string,
): RuleFailure | null {
  const consumed = consumedCount(counts);
  if (consumed < entitlement.quantity) return null;
  const what = entitlement.label ?? entitlement.entitlement_type.replace(/_/g, " ") + "s";
  return {
    invariant: "INV-03-3",
    code: "entitlement_exhausted",
    message: `${sponsorName} has used all ${entitlement.quantity} ${what} for ${eventName}.`,
    details: {
      entitlement_id: entitlement.id,
      entitlement_type: entitlement.entitlement_type,
      quantity: entitlement.quantity,
      consumed_count: consumed,
    },
  };
}

/**
 * INV-03-4 — lowering `quantity` below `consumed_count` is refused; the
 * sponsor manager must first release specific proposals.
 */
export function checkQuantityReduction(
  entitlementId: string,
  newQuantity: number,
  counts: EntitlementCounts,
): RuleFailure | null {
  const consumed = consumedCount(counts);
  if (newQuantity >= consumed) return null;
  return {
    invariant: "INV-03-4",
    code: "quantity_below_consumed",
    message: `This entitlement already has ${consumed} proposal${consumed === 1 ? "" : "s"} against it. Release ${
      consumed - newQuantity
    } before lowering the quantity to ${newQuantity}.`,
    details: { entitlement_id: entitlementId, quantity: newQuantity, consumed_count: consumed },
  };
}

/**
 * INV-03-5 — a sponsor session proposal must reference an entitlement whose
 * `allowed_format_ids` is empty or contains the proposal's format, and whose
 * `submission_deadline` (if set) has not passed.
 */
export function checkFormatAndDeadline(
  entitlement: EntitlementCheckSubject,
  formatId: string | null,
  now: string,
): RuleFailure | null {
  if (entitlement.allowed_format_ids.length > 0 && (!formatId || !entitlement.allowed_format_ids.includes(formatId))) {
    return {
      invariant: "INV-03-5",
      code: "format_not_allowed_for_entitlement",
      message: "This entitlement cannot be spent on the session format you chose.",
      details: { entitlement_id: entitlement.id, format_id: formatId, allowed_format_ids: entitlement.allowed_format_ids },
    };
  }
  if (entitlement.submission_deadline && entitlement.submission_deadline <= now) {
    return {
      invariant: "INV-03-5",
      code: "sponsor_submission_deadline_passed",
      message: `The submission deadline for this entitlement passed on ${entitlement.submission_deadline}.`,
      details: { entitlement_id: entitlement.id, submission_deadline: entitlement.submission_deadline },
    };
  }
  return null;
}

/**
 * INV-03-6 — only an active `SponsorContact` with `can_submit_sessions`, or
 * staff with `sponsor_manager`, may create or edit a proposal against that
 * sponsor's entitlements.
 */
export function checkMaySubmitForSponsor(
  contact: { status: string; can_submit_sessions: boolean; event_id?: string | null } | null,
  isSponsorManager: boolean,
  eventId: string,
): RuleFailure | null {
  if (isSponsorManager) return null;
  if (!contact || contact.status !== "active" || !contact.can_submit_sessions) {
    return {
      invariant: "INV-03-6",
      code: "not_a_submitting_sponsor_contact",
      message: "Only an active sponsor contact who may submit sessions can use this sponsor's entitlements.",
    };
  }
  // `event_id = null` means a contact for all of this sponsor's events.
  if (contact.event_id && contact.event_id !== eventId) {
    return {
      invariant: "INV-03-6",
      code: "not_a_submitting_sponsor_contact",
      message: "You are a contact for a different event of this sponsor.",
      details: { contact_event_id: contact.event_id, event_id: eventId },
    };
  }
  return null;
}

/** INV-03-7 — a sponsor with `status=blocked` may not hold new entitlements or submit. */
export function checkSponsorNotBlocked(sponsor: { name: string; status: string }): RuleFailure | null {
  if (sponsor.status !== "blocked") return null;
  return {
    invariant: "INV-03-7",
    code: "sponsor_blocked",
    message: `${sponsor.name} is blocked and may not hold entitlements or submit sessions.`,
  };
}

/**
 * INV-03-8 — a sponsor's logo and name appear publicly only when
 * `Sponsorship.status = confirmed` and `public_from` has passed (or is null).
 */
export function isPubliclyVisible(
  sponsorship: { status: string; public_from?: string | null },
  now: string,
): boolean {
  if (sponsorship.status !== "confirmed") return false;
  if (sponsorship.public_from && sponsorship.public_from > now) return false;
  return true;
}

/**
 * INV-03-9 — deleting a sponsor is a soft delete and is refused while any spent
 * entitlement is attached to a non-cancelled session.
 */
export function checkSponsorDeletable(
  sponsorName: string,
  liveSessionIds: string[],
): RuleFailure | null {
  if (liveSessionIds.length === 0) return null;
  return {
    invariant: "INV-03-9",
    code: "sponsor_has_live_sessions",
    message: `${sponsorName} has ${liveSessionIds.length} session${
      liveSessionIds.length === 1 ? "" : "s"
    } in the program. Cancel them before removing the sponsor.`,
    details: { session_ids: liveSessionIds },
  };
}

/**
 * `entitlement.expiring_soon` — the nudge hook. True when an entitlement still
 * has unspent quantity and either deadline falls inside the window.
 */
export function expiringSoon(
  entitlement: { expires_at?: string | null; submission_deadline?: string | null },
  remaining: number,
  now: string,
  windowDays = 7,
): { due: boolean; at: string | null; days_remaining: number } {
  if (remaining <= 0) return { due: false, at: null, days_remaining: 0 };
  const candidates = [entitlement.expires_at, entitlement.submission_deadline].filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  if (candidates.length === 0) return { due: false, at: null, days_remaining: 0 };
  const at = candidates.sort()[0];
  const days = Math.ceil((new Date(at).getTime() - new Date(now).getTime()) / 86_400_000);
  return { due: days >= 0 && days <= windowDays, at, days_remaining: days };
}
