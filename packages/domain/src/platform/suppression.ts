/**
 * Suppression — 09, "Notifications".
 *
 * "Suppression is global per email address for hard bounces and complaints,
 * and per-category for unsubscribes — with the deliberate exception that
 * transactional messages a speaker must receive are never suppressed by an
 * unsubscribe: acceptance, rejection, confirmation deadlines, and schedule
 * changes for their own talk. Marketing preferences must not cost someone their
 * slot." (INV-09-10)
 */

import type { SuppressedReason } from "./types.js";

/** A row of `notification_suppression`. `category = all` is the global list. */
export interface SuppressionEntry {
  email: string;
  /** `all` for hard bounces and complaints; a category key for unsubscribes. */
  category: string;
  reason: string;
}

export interface SuppressionQuery {
  email: string;
  /** The message's category — the template key's noun, or `campaign`. */
  category: string;
  /**
   * INV-09-10: true when the message is tied to this person's own proposal,
   * session or task. A campaign is never transactional (09, "Design points").
   */
  transactional: boolean;
}

export interface SuppressionDecision {
  suppressed: boolean;
  reason?: SuppressedReason;
  /** The entry that caused it, for the outbox. */
  matched?: SuppressionEntry;
}

const NOT_SUPPRESSED: SuppressionDecision = { suppressed: false };

/**
 * Hard bounces and complaints are absolute: mail to that address does not
 * arrive, so sending it anyway achieves nothing but a worse sender reputation.
 * A marketing unsubscribe is a *preference*, and preferences do not override a
 * deadline notice about somebody's own talk.
 */
export function decideSuppression(entries: SuppressionEntry[], q: SuppressionQuery): SuppressionDecision {
  const email = q.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { suppressed: true, reason: "hard_bounced" };
  }
  for (const e of entries) {
    if (e.email.trim().toLowerCase() !== email) continue;
    const global = e.category === "all";
    const bounceOrComplaint = e.reason === "hard_bounce" || e.reason === "complaint";

    if (global && bounceOrComplaint) {
      // Undeliverable, whatever the message is.
      return { suppressed: true, reason: e.reason === "complaint" ? "complained" : "hard_bounced", matched: e };
    }
    // An unsubscribe, global or per-category.
    if (global || e.category === q.category) {
      // INV-09-10: the transactional exemption. Deliberately not extended to
      // campaigns, which pass `transactional: false`.
      if (q.transactional) continue;
      return { suppressed: true, reason: "unsubscribed", matched: e };
    }
  }
  return NOT_SUPPRESSED;
}

/**
 * The category a template key belongs to, for per-category unsubscribes:
 * `proposal.accepted` → `proposal`.
 */
export function categoryOf(templateKey: string | null): string {
  if (!templateKey) return "campaign";
  const dot = templateKey.indexOf(".");
  return dot > 0 ? templateKey.slice(0, dot) : templateKey;
}
