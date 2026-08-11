/**
 * 01 — Identity & Access. Enums and entity shapes.
 *
 * Enum members are written out here because the model writes them out; adding
 * one is additive, removing or renaming one is breaking (docs/domain/README.md).
 */

export const PERSON_STATUS = ["invited", "active", "deactivated"] as const;
export type PersonStatus = (typeof PERSON_STATUS)[number];

export const AUTH_PROVIDER = ["email_otp", "google", "github", "oidc", "password"] as const;
export type AuthProvider = (typeof AUTH_PROVIDER)[number];

export const PROFILE_LINK_KIND = [
  "website",
  "x",
  "bluesky",
  "linkedin",
  "github",
  "mastodon",
  "youtube",
  "scholar",
  "other",
] as const;
export type ProfileLinkKind = (typeof PROFILE_LINK_KIND)[number];

export const PARTICIPANT_KIND = ["speaker", "sponsor_contact", "staff", "reviewer", "prospect", "other"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KIND)[number];

export const PARTICIPANT_STATUS = ["prospect", "invited", "confirmed", "declined", "withdrawn"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUS)[number];

export const PARTICIPANT_SOURCE = ["proposal", "decision", "manual", "import", "crm_push", "invitation"] as const;
export type ParticipantSource = (typeof PARTICIPANT_SOURCE)[number];

export const PORTAL_ACCESS = ["none", "invited", "active", "revoked"] as const;
export type PortalAccess = (typeof PORTAL_ACCESS)[number];

export const INVITATION_KIND = ["staff", "reviewer", "co_speaker", "sponsor_contact", "speaker_portal"] as const;
export type InvitationKind = (typeof INVITATION_KIND)[number];

export const INVITATION_STATUS = ["pending", "accepted", "declined", "expired", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUS)[number];

export const INVITATION_CONTEXT_TYPE = ["proposal", "session", "sponsor", "event"] as const;
export type InvitationContextType = (typeof INVITATION_CONTEXT_TYPE)[number];

export const MERGE_SIGNAL = ["same_normalised_name", "same_provider_email", "same_name_and_company", "manual"] as const;
export type MergeSignal = (typeof MERGE_SIGNAL)[number];

/**
 * `EventParticipant` roster workflow — the state diagram in 01. A transition
 * that is not drawn does not exist.
 */
export const PARTICIPANT_TRANSITIONS: Record<ParticipantStatus, ParticipantStatus[]> = {
  prospect: ["invited"],
  invited: ["confirmed", "declined"],
  confirmed: ["withdrawn"],
  declined: [],
  withdrawn: [],
};

export function canTransitionParticipant(from: ParticipantStatus, to: ParticipantStatus): boolean {
  return PARTICIPANT_TRANSITIONS[from]?.includes(to) ?? false;
}

export const INVITATION_TRANSITIONS: Record<InvitationStatus, InvitationStatus[]> = {
  pending: ["accepted", "declined", "expired", "revoked"],
  accepted: [],
  declined: [],
  expired: [],
  revoked: [],
};

export interface SpeakerProfileVisibility {
  bio?: "public" | "private";
  short_bio?: "public" | "private";
  company?: "public" | "private";
  job_title?: "public" | "private";
  headline?: "public" | "private";
  location?: "public" | "private";
  pronouns?: "public" | "private";
}

export const DEFAULT_PROFILE_VISIBILITY: SpeakerProfileVisibility = {
  bio: "public",
  short_bio: "public",
  company: "public",
  job_title: "public",
  headline: "public",
  location: "private",
  pronouns: "public",
};

/**
 * `SpeakerProfile.completeness` (derived, 0–100): what the portal's "finish
 * your profile" nudge counts.
 */
export function profileCompleteness(p: {
  headline?: unknown;
  job_title?: unknown;
  company?: unknown;
  bio?: unknown;
  short_bio?: unknown;
  headshot_asset_id?: unknown;
  location?: unknown;
  link_count?: number;
}): number {
  const checks = [
    !!p.headline,
    !!p.job_title,
    !!p.company,
    !!p.bio,
    !!p.short_bio,
    !!p.headshot_asset_id,
    !!p.location,
    (p.link_count ?? 0) > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/** INV-01-5: `ProfileLink.url` must parse as an absolute https URL. */
export function isAbsoluteHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normaliseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ");
}
