/**
 * Typed ULIDs — 11-cross-cutting.md, "Identifiers".
 *
 * Every id is a ULID with a documented prefix. Passing a session id where a
 * proposal id belongs is a validation error, not a mystery.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The full prefix registry. The prefix column of every `id` row in docs/domain. */
export const ID_PREFIXES = {
  Organization: "org_",
  Person: "per_",
  AuthIdentity: "aid_",
  SpeakerProfile: "spk_",
  ProfileLink: "lnk_",
  EventParticipant: "epa_",
  PersonNote: "pnt_",
  RoleGrant: "grt_",
  Invitation: "inv_",
  Event: "evt_",
  EventDay: "day_",
  Track: "trk_",
  SessionFormat: "fmt_",
  Venue: "ven_",
  Room: "rom_",
  CallForProposals: "cfp_",
  CfpFormatOption: "cfo_",
  CfpTrackOption: "cto_",
  SubmissionForm: "frm_",
  FormStep: "stp_",
  FormField: "fld_",
  Sponsor: "spo_",
  SponsorshipTier: "tir_",
  TierEntitlementTemplate: "tet_",
  Sponsorship: "snp_",
  Entitlement: "ent_",
  SponsorContact: "sct_",
  Proposal: "prp_",
  ProposalAnswer: "pan_",
  ProposalSpeaker: "psp_",
  ProposalRevision: "prv_",
  ReviewRound: "rnd_",
  ReviewRoundReviewer: "rrv_",
  ReviewRoundReminderRule: "rrr_",
  Rubric: "rub_",
  RubricCriterion: "crt_",
  ReviewAssignment: "asg_",
  Review: "rvw_",
  CriterionScore: "csc_",
  ConflictOfInterest: "coi_",
  ReviewComment: "rcm_",
  Decision: "dec_",
  Session: "ses_",
  SessionSpeaker: "ssp_",
  SessionRelation: "srl_",
  SessionAsset: "sas_",
  SessionRevision: "srv_",
  TaskDefinition: "tdf_",
  TaskInstance: "tsk_",
  TaskSubmission: "tsb_",
  TaskReminderRule: "trr_",
  TaskReminderLog: "trl_",
  TimeSlot: "slt_",
  Placement: "plc_",
  AutoPlaceRun: "apr_",
  ScheduleConflict: "scf_",
  SchedulePublication: "pub_",
  PublishedSession: "psn_",
  PublishedSpeaker: "pss_",
  ScheduleDiffEntry: "sde_",
  EmbedConfig: "emb_",
  ApiKey: "key_",
  Webhook: "whk_",
  WebhookDelivery: "whd_",
  Integration: "itg_",
  NotificationTemplate: "ntp_",
  SyncMapping: "smp_",
  ExternalRecordLink: "xrl_",
  SyncRun: "syr_",
  NotificationDelivery: "ntd_",
  Campaign: "cmp_",
  CampaignRecipient: "cmr_",
  DomainEventRecord: "evn_",
  Asset: "ast_",
  AssetComment: "acm_",
  CustomFieldDefinition: "cfd_",
  AuditLog: "aud_",
  BulkImport: "imp_",
  Export: "exp_",
  ContactSegment: "seg_",
  SourcingPipeline: "pip_",
  PipelineStage: "pst_",
  ProspectCard: "prc_",
  ProspectStageTransition: "ptr_",
  Session_Cookie: "sid_",
} as const;

export type EntityName = keyof typeof ID_PREFIXES;
export type Prefix = (typeof ID_PREFIXES)[EntityName];

/** Branded id type, so `Id<"Proposal">` and `Id<"Session">` are not interchangeable. */
export type Id<E extends EntityName> = string & { readonly __entity?: E };

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    out = CROCKFORD[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/** A raw 26-character ULID, monotonic-ish and lexicographically sortable by time. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

/** Mint a prefixed id for an entity: `newId("Proposal")` → `prp_01J…`. */
export function newId<E extends EntityName>(entity: E, now?: number): Id<E> {
  return (ID_PREFIXES[entity] + ulid(now)) as Id<E>;
}

export function prefixOf<E extends EntityName>(entity: E): string {
  return ID_PREFIXES[entity];
}

/** True when `id` carries the prefix documented for `entity`. */
export function isId<E extends EntityName>(entity: E, id: unknown): id is Id<E> {
  return typeof id === "string" && id.startsWith(ID_PREFIXES[entity]) && id.length === ID_PREFIXES[entity].length + 26;
}

/** The entity an id belongs to, or null if the prefix is unknown. */
export function entityOfId(id: string): EntityName | null {
  for (const [entity, prefix] of Object.entries(ID_PREFIXES)) {
    if (id.startsWith(prefix)) return entity as EntityName;
  }
  return null;
}

/**
 * `[a-z0-9-]+`, per the `slug` type in docs/domain/README.md.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function isSlug(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

/**
 * Human-facing reference — `WF26-0142`. Unique per event, never reused
 * (INV-04-2). The sequence is supplied by the caller from a per-event counter.
 */
export function formatReference(eventCode: string, sequence: number): string {
  return `${eventCode.toUpperCase()}-${String(sequence).padStart(4, "0")}`;
}

/** A short, stable event code derived from an event slug: "devflow-conf-2027" → "DFC27". */
export function eventCodeFromSlug(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  const year = parts.find((p) => /^\d{4}$/.test(p));
  const letters = parts
    .filter((p) => !/^\d{4}$/.test(p))
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 4);
  return (letters || "EV") + (year ? year.slice(2) : "");
}
