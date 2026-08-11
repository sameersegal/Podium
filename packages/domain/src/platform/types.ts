/**
 * 09 — API & Integrations: enum members and state machines.
 *
 * Enum members live here as `as const` arrays so the drift checker can compare
 * them with the tables in `docs/domain/09-api-and-integrations.md`. Adding a
 * member is additive; removing or renaming one is breaking.
 */

import { illegalTransition } from "../shared/errors.js";

/* -------------------------------------------------------------------------- */
/* Webhook                                                                     */
/* -------------------------------------------------------------------------- */

export const WEBHOOK_STATUSES = ["active", "paused", "disabled_after_failures"] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed", "exhausted", "skipped"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Exponential backoff, then `exhausted` — 09, "Delivery contract".
 *
 * The schedule is the model's, in seconds: 1m, 5m, 30m, 2h, 6h, 24h. It is a
 * Queue `delaySeconds` per attempt, never a loop inside a request.
 */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 86400] as const;

export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_BACKOFF_SECONDS.length + 1;

/** Seconds to wait before attempt `attempt + 1`, or null when exhausted. */
export function backoffSecondsFor(attempt: number): number | null {
  if (attempt < 1) return WEBHOOK_BACKOFF_SECONDS[0];
  return WEBHOOK_BACKOFF_SECONDS[attempt - 1] ?? null;
}

/** 09: twenty consecutive failures pauses the webhook and notifies the owner. */
export const WEBHOOK_FAILURE_LIMIT = 20;

/** Signature freshness window, to blunt replay. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/* -------------------------------------------------------------------------- */
/* Integration                                                                 */
/* -------------------------------------------------------------------------- */

export const CAPABILITIES = [
  "email",
  "sms",
  "chat",
  "calendar",
  "crm",
  "storage",
  "video",
  "analytics",
  "identity",
  "ticketing",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const INTEGRATION_STATUSES = ["active", "misconfigured", "disabled"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_CHANNELS = ["email", "chat"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * `no_provider` and `complained` were added by C6 in 13-open-questions.md: the
 * enum omitted values INV-09-12 and the suppression paragraph already require.
 */
export const SUPPRESSED_REASONS = [
  "unsubscribed",
  "hard_bounced",
  "complained",
  "duplicate",
  "quiet_hours",
  "digest_batched",
  "no_provider",
] as const;
export type SuppressedReason = (typeof SUPPRESSED_REASONS)[number];

/* -------------------------------------------------------------------------- */
/* Campaign                                                                    */
/* -------------------------------------------------------------------------- */

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "partially_failed",
  "cancelled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Exactly the arrows drawn in the state diagram in 09. An undrawn transition does not exist. */
const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["scheduled", "sending"],
  scheduled: ["sending", "cancelled"],
  sending: ["sent", "partially_failed"],
  sent: [],
  partially_failed: [],
  cancelled: [],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canTransitionCampaign(from, to)) throw illegalTransition("Campaign", from, to);
}

/** `Campaign.audience` — criteria, never a frozen list (09, "Design points"). */
export interface AudienceCriteria {
  kind?: "event_participants" | "speakers" | "sponsor_contacts" | "reviewers" | "people" | "segment";
  event_id?: string | null;
  participant_status?: string[];
  track_ids?: string[];
  task_state?: string | null;
  has_outstanding_tasks?: boolean;
  person_ids?: string[];
  segment_id?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Quiet hours are a core concern, not a provider one (09, `email` contract).
 * Defaults in code, per 01's "settings keys (all optional, defaults in code)".
 * Computed in the recipient's timezone where known, falling back to the
 * event's (11, "Time").
 */
export const QUIET_HOURS = { start_hour: 21, end_hour: 8 } as const;

export interface QuietHoursDecision {
  /** True when the message falls inside the window and must wait. */
  defer: boolean;
  /** Seconds to hold it for. */
  delay_seconds: number;
}

export function quietHoursDecision(now: string, timezone: string): QuietHoursDecision {
  const hour = hourInZone(now, timezone);
  if (hour >= QUIET_HOURS.end_hour && hour < QUIET_HOURS.start_hour) return { defer: false, delay_seconds: 0 };
  const hoursUntilMorning = hour >= QUIET_HOURS.start_hour ? 24 - hour + QUIET_HOURS.end_hour : QUIET_HOURS.end_hour - hour;
  return { defer: true, delay_seconds: Math.max(60, Math.round(hoursUntilMorning * 3600)) };
}

function hourInZone(instant: string, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hour12: false }).formatToParts(
      new Date(instant),
    );
    return Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
  } catch {
    return new Date(instant).getUTCHours();
  }
}
