/**
 * The authorization matrix — 11-cross-cutting.md, "Authorization matrix".
 *
 * Two rules override the table:
 *   1. Relationship access is scoped and revocable (speaker / sponsor contact).
 *   2. Nobody sees reviews of their own proposal, at any role (INV-11-7).
 */

export type Role =
  | "owner"
  | "admin"
  | "program_chair"
  | "track_lead"
  | "reviewer"
  | "organizer"
  | "sponsor_manager"
  | "viewer";

export const ROLES: readonly Role[] = [
  "owner",
  "admin",
  "program_chair",
  "track_lead",
  "reviewer",
  "organizer",
  "sponsor_manager",
  "viewer",
];

export type ScopeType = "org" | "event" | "track";

export interface RoleGrantView {
  role: Role;
  scope_type: ScopeType;
  scope_id: string;
  expires_at?: string | null;
  revoked_at?: string | null;
}

/** Principals the matrix has columns for. */
export type Principal = Role | "sponsor_contact" | "speaker" | "public";

/** `✎` write · `👁` read · `O` own/related only · `—` none · `recommend`. */
export type Access = "write" | "read" | "own" | "recommend" | "none";

export type Capability =
  | "org.configure"
  | "event.configure"
  | "config.manage"
  | "cfp.configure"
  | "proposal.submit"
  | "proposal.read_any"
  | "proposal.edit"
  | "review.read"
  | "review.submit"
  | "decision.manage"
  | "sponsor.manage"
  | "session.manage"
  | "session.approve_content"
  | "session.restore_revision"
  | "roster.manage"
  | "speaker_profile.edit"
  | "speaker_profile.set_visibility"
  | "person_note.manage"
  | "contact_directory.read"
  | "segment.manage"
  | "pipeline.manage"
  | "asset.comment"
  | "campaign.send"
  | "communications.read"
  | "bulk.import"
  | "export.request"
  | "custom_field.manage"
  | "task.define"
  | "task.complete"
  | "task.approve"
  | "schedule.place"
  | "schedule.publish"
  | "schedule.read_published"
  | "pii.read"
  | "sync.resolve_conflict"
  | "audit.read";

const W: Access = "write";
const R: Access = "read";
const O: Access = "own";
const N: Access = "none";

/**
 * One row per capability, transcribed from the matrix in 11-cross-cutting.md.
 * Missing principals default to `none`.
 */
export const AUTHZ_MATRIX: Record<Capability, Partial<Record<Principal, Access>>> = {
  // Configuring a `SyncMapping` is `org.configure` — it names an integration
  // and its credentials. Resolving a conflict is not: it is a decision about
  // which of two values for a session title is right, which is the programme's
  // question and not the administrator's.
  "sync.resolve_conflict": { owner: W, admin: W, program_chair: W, organizer: W },
  "org.configure": { owner: W, admin: W },
  "event.configure": { owner: W, admin: W, program_chair: W },
  // `viewer` reads, and only reads. 01 defines the role as "read-only across
  // the event, no scores", and until this row and the eight below it, the role
  // appeared in no capability at all — so a person granted `viewer`, and every
  // API key holding only `:read` scopes, authenticated successfully and was
  // then refused everything. The exclusions are the definition: no `review.*`
  // (that is the "no scores" clause), no `pii.read`, no `audit.read`, no org
  // configuration, and nothing org-scoped like the speaker directory, because
  // the grant itself is event-scoped.
  "config.manage": { owner: W, admin: W, program_chair: W, organizer: R, viewer: R },
  "cfp.configure": { owner: W, admin: W, program_chair: W, organizer: R, viewer: R },
  "proposal.submit": {
    owner: W,
    admin: W,
    program_chair: W,
    track_lead: W,
    reviewer: W,
    organizer: W,
    sponsor_manager: W,
    sponsor_contact: W,
    speaker: W,
  },
  "proposal.read_any": {
    owner: R,
    admin: R,
    program_chair: R,
    track_lead: R,
    reviewer: R,
    organizer: R,
    sponsor_manager: R,
    sponsor_contact: O,
    speaker: O,
    viewer: R,
  },
  "proposal.edit": {
    owner: W,
    admin: W,
    program_chair: W,
    sponsor_manager: W,
    sponsor_contact: O,
    speaker: O,
  },
  "review.read": { owner: R, admin: R, program_chair: R, track_lead: R, reviewer: O },
  "review.submit": { program_chair: W, track_lead: W, reviewer: W },
  "decision.manage": { owner: W, admin: W, program_chair: W, track_lead: "recommend" },
  "sponsor.manage": { owner: W, admin: W, program_chair: R, organizer: R, sponsor_manager: W, sponsor_contact: O, viewer: R },
  "session.manage": {
    owner: W,
    admin: W,
    program_chair: W,
    organizer: W,
    sponsor_manager: W,
    speaker: R,
    viewer: R,
  },
  "session.approve_content": { owner: W, admin: W, program_chair: W, track_lead: R, organizer: W },
  "session.restore_revision": { owner: W, admin: W, program_chair: W, organizer: W },
  "roster.manage": { owner: W, admin: W, program_chair: W, organizer: W, sponsor_manager: W },
  "speaker_profile.edit": { owner: W, admin: W, program_chair: W, organizer: W, speaker: O },
  // INV-01-13: only the profile's own person may change visibility / is_listed.
  "speaker_profile.set_visibility": { speaker: O },
  "person_note.manage": { owner: W, admin: W, program_chair: W, track_lead: R, organizer: W, sponsor_manager: W },
  // 14 — the Speaker CRM is org-scoped, so the event- and track-scoped roles
  // are absent by construction (INV-14-7), not by oversight.
  "contact_directory.read": { owner: R, admin: R, program_chair: R, organizer: R, sponsor_manager: R },
  "segment.manage": { owner: W, admin: W, program_chair: W, organizer: W },
  "pipeline.manage": { owner: W, admin: W, program_chair: W, organizer: W },
  "asset.comment": {
    owner: W,
    admin: W,
    program_chair: W,
    organizer: W,
    sponsor_manager: W,
    sponsor_contact: O,
    speaker: O,
  },
  "campaign.send": { owner: W, admin: W, program_chair: W, organizer: W, sponsor_manager: W },
  "communications.read": { owner: R, admin: R, program_chair: R, organizer: R, sponsor_manager: R, speaker: O },
  "bulk.import": { owner: W, admin: W, program_chair: W, organizer: W, sponsor_manager: W },
  "export.request": {
    owner: W,
    admin: W,
    program_chair: W,
    track_lead: W,
    reviewer: O,
    organizer: W,
    sponsor_manager: W,
  },
  "custom_field.manage": { owner: W, admin: W, program_chair: W },
  "task.define": { owner: W, admin: W, program_chair: W, organizer: W, viewer: R },
  "task.complete": {
    owner: W,
    admin: W,
    program_chair: W,
    organizer: W,
    sponsor_manager: W,
    sponsor_contact: O,
    speaker: O,
    viewer: R,
  },
  "task.approve": { owner: W, admin: W, program_chair: W, organizer: W, sponsor_manager: W },
  "schedule.place": { owner: W, admin: W, program_chair: W, organizer: W, viewer: R },
  "schedule.publish": { owner: W, admin: W, program_chair: W },
  "schedule.read_published": {
    owner: R,
    admin: R,
    program_chair: R,
    track_lead: R,
    reviewer: R,
    organizer: R,
    sponsor_manager: R,
    sponsor_contact: R,
    speaker: R,
    public: R,
    viewer: R,
  },
  "pii.read": { owner: R, admin: R, program_chair: R, organizer: R, sponsor_manager: R, speaker: O },
  "audit.read": { owner: R, admin: R, program_chair: R },
};

/** API key scopes — 09-api-and-integrations.md. */
export const API_SCOPES = [
  "events:read",
  "events:write",
  "proposals:read",
  "proposals:write",
  "reviews:read",
  "reviews:write",
  "decisions:read",
  "decisions:write",
  "sessions:read",
  "sessions:write",
  "speakers:read",
  "speakers:write",
  "sponsors:read",
  "sponsors:write",
  "entitlements:read",
  "entitlements:write",
  "tasks:read",
  "tasks:write",
  "schedule:read",
  "schedule:publish",
  "webhooks:manage",
  "pii:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Relationship-derived membership, evaluated per request. */
export interface Relationships {
  /** Sessions the person is a non-removed `SessionSpeaker` on. */
  session_ids: string[];
  /** Proposals the person submitted or is credited on. */
  proposal_ids: string[];
  /** Sponsors the person is an active `SponsorContact` for. */
  sponsor_ids: string[];
  /** Events the person has an `EventParticipant` row on (portal sign-in only, INV-01-11). */
  participant_event_ids: string[];
}

export const NO_RELATIONSHIPS: Relationships = {
  session_ids: [],
  proposal_ids: [],
  sponsor_ids: [],
  participant_event_ids: [],
};

export interface Principals {
  org_id: string;
  person_id?: string | null;
  grants: RoleGrantView[];
  relationships: Relationships;
  /** Present when the caller is an API key rather than a person. */
  api_scopes?: ApiScope[] | null;
  api_event_ids?: string[] | null;
}

export interface Target {
  event_id?: string | null;
  track_id?: string | null;
  session_id?: string | null;
  proposal_id?: string | null;
  sponsor_id?: string | null;
  /** Set when the target is a person's own record. */
  person_id?: string | null;
}

function grantActive(g: RoleGrantView, now: string): boolean {
  if (g.revoked_at) return false;
  if (g.expires_at && g.expires_at <= now) return false;
  return true;
}

/** Does a grant's scope contain the target? */
function scopeCovers(g: RoleGrantView, orgId: string, target: Target): boolean {
  if (g.scope_type === "org") return g.scope_id === orgId;
  if (g.scope_type === "event") return !!target.event_id && g.scope_id === target.event_id;
  if (g.scope_type === "track") return !!target.track_id && g.scope_id === target.track_id;
  return false;
}

/**
 * Every principal the caller presents for this target: role grants whose scope
 * contains it, plus relationship-derived ones.
 */
export function principalsFor(p: Principals, target: Target, now: string): Set<Principal> {
  const out = new Set<Principal>(["public"]);
  for (const g of p.grants) {
    if (!grantActive(g, now)) continue;
    // An org-scoped grant covers every event; a track grant only its track. An
    // event-scoped grant with no event in the target still identifies the role
    // for org-wide screens.
    if (scopeCovers(g, p.org_id, target) || (!target.event_id && !target.track_id)) out.add(g.role);
    // track_lead at track scope also reads within its event
    if (g.scope_type === "track" && target.track_id && g.scope_id === target.track_id) out.add(g.role);
  }
  const rel = p.relationships;
  if (target.session_id && rel.session_ids.includes(target.session_id)) out.add("speaker");
  if (target.proposal_id && rel.proposal_ids.includes(target.proposal_id)) out.add("speaker");
  if (target.sponsor_id && rel.sponsor_ids.includes(target.sponsor_id)) out.add("sponsor_contact");
  if (!target.session_id && !target.proposal_id && rel.session_ids.length > 0) out.add("speaker");
  if (!target.sponsor_id && rel.sponsor_ids.length > 0) out.add("sponsor_contact");
  return out;
}

const RANK: Record<Access, number> = { none: 0, own: 1, recommend: 2, read: 3, write: 4 };

/** The strongest access the caller has for a capability against a target. */
export function accessFor(p: Principals, capability: Capability, target: Target = {}, now: string = new Date().toISOString()): Access {
  const row = AUTHZ_MATRIX[capability];
  let best: Access = "none";
  for (const principal of principalsFor(p, target, now)) {
    const a = row[principal];
    if (a && RANK[a] > RANK[best]) best = a;
  }
  // INV-09-9: an API key scoped to specific events cannot touch another.
  if (p.api_event_ids && p.api_event_ids.length > 0 && target.event_id && !p.api_event_ids.includes(target.event_id)) {
    return "none";
  }
  return best;
}

export function canRead(p: Principals, capability: Capability, target: Target = {}, now?: string): boolean {
  return RANK[accessFor(p, capability, target, now)] >= RANK.read;
}

export function canWrite(p: Principals, capability: Capability, target: Target = {}, now?: string): boolean {
  return accessFor(p, capability, target, now) === "write";
}

/** `own` counts: the caller may act, but only on their own related record. */
export function canAct(p: Principals, capability: Capability, target: Target = {}, now?: string): boolean {
  return RANK[accessFor(p, capability, target, now)] >= RANK.own;
}

export function hasRole(p: Principals, role: Role, target: Target = {}, now: string = new Date().toISOString()): boolean {
  return principalsFor(p, target, now).has(role);
}

export function isStaff(p: Principals, target: Target = {}, now?: string): boolean {
  const n = now ?? new Date().toISOString();
  const set = principalsFor(p, target, n);
  return (
    set.has("owner") ||
    set.has("admin") ||
    set.has("program_chair") ||
    set.has("organizer") ||
    set.has("track_lead") ||
    set.has("sponsor_manager") ||
    set.has("viewer")
  );
}

/**
 * INV-11-7 / INV-04-11 — a person may never read review data for a proposal
 * they submitted or are credited on, regardless of role. This is not a
 * redaction a scope can unlock; the surface is absent.
 */
export function isOwnProposal(p: Principals, proposalId: string): boolean {
  return p.relationships.proposal_ids.includes(proposalId);
}

export function assertMayReadReviewData(p: Principals, proposalId: string): void {
  if (isOwnProposal(p, proposalId)) {
    const err = new Error("Review data for your own proposal is not available at any permission level.");
    (err as Error & { invariant?: string }).invariant = "INV-11-7";
    throw err;
  }
}
