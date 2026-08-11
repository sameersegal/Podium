/**
 * Conflict of interest matching — 05, `ConflictOfInterest` and INV-05-4.
 *
 * "Auto-detection is intentionally shallow and advisory: matching email domains
 * between a reviewer and a speaker, a reviewer being a contact for the
 * sponsoring company, and a reviewer credited on the proposal. Anything
 * cleverer produces false confidence."
 */

import type { CoiReason, CoiSource, CoiSubjectType } from "./types.js";

export interface ConflictRecord {
  id: string;
  reviewer_person_id: string;
  subject_type: CoiSubjectType;
  subject_id: string | null;
  subject_value: string | null;
  reason: CoiReason;
  source: CoiSource;
}

/** Everything about a proposal a conflict can attach to. */
export interface ProposalConflictSubject {
  proposal_id: string;
  submitter_person_id: string;
  /** `ProposalSpeaker.person_id` for every non-removed credit, plus the submitter. */
  credited_person_ids: string[];
  sponsor_id: string | null;
  /** Lowercased email domains of the submitter and every credited speaker. */
  speaker_email_domains: string[];
}

export interface ConflictMatch {
  /** The declared record, or null for the structural self-conflict. */
  coi: ConflictRecord | null;
  kind: "self" | "proposal" | "person" | "sponsor" | "company_domain";
  detail: string;
}

/** `acme.com` from `@Acme.com` or `someone@acme.com`. */
export function normaliseDomain(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = String(value).trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  return (at >= 0 ? trimmed.slice(at + 1) : trimmed).replace(/^\.+/, "");
}

export function emailDomain(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "";
  return normaliseDomain(email);
}

/**
 * INV-05-4 — an assignment may not be created, and a review may not be
 * submitted, where a `ConflictOfInterest` matches the reviewer and the proposal
 * directly, via a credited person, via the sponsor, or via `company_domain`
 * against a speaker's email domain.
 *
 * The first clause is the fairness rule stated in 05: "A reviewer never reviews
 * a proposal they are credited on, submitted, or have a `COI` against." Being
 * the submitter needs no declared record to be a conflict.
 */
export function matchConflicts(
  conflicts: ConflictRecord[],
  reviewerPersonId: string,
  subject: ProposalConflictSubject,
): ConflictMatch[] {
  const matches: ConflictMatch[] = [];

  if (
    reviewerPersonId === subject.submitter_person_id ||
    subject.credited_person_ids.includes(reviewerPersonId)
  ) {
    matches.push({
      coi: null,
      kind: "self",
      detail: "the reviewer submitted this proposal or is credited on it",
    });
  }

  const domains = new Set(subject.speaker_email_domains.map(normaliseDomain).filter(Boolean));
  const people = new Set([subject.submitter_person_id, ...subject.credited_person_ids]);

  for (const coi of conflicts) {
    if (coi.reviewer_person_id !== reviewerPersonId) continue;
    switch (coi.subject_type) {
      case "proposal":
        if (coi.subject_id === subject.proposal_id) {
          matches.push({ coi, kind: "proposal", detail: "declared against this proposal" });
        }
        break;
      case "person":
        if (coi.subject_id && people.has(coi.subject_id)) {
          matches.push({ coi, kind: "person", detail: "declared against a credited person" });
        }
        break;
      case "sponsor":
        if (coi.subject_id && subject.sponsor_id && coi.subject_id === subject.sponsor_id) {
          matches.push({ coi, kind: "sponsor", detail: "declared against the sponsoring company" });
        }
        break;
      case "company_domain": {
        const declared = normaliseDomain(coi.subject_value);
        if (declared && domains.has(declared)) {
          matches.push({ coi, kind: "company_domain", detail: `speaker email domain ${declared}` });
        }
        break;
      }
    }
  }
  return matches;
}

export function hasConflict(
  conflicts: ConflictRecord[],
  reviewerPersonId: string,
  subject: ProposalConflictSubject,
): boolean {
  return matchConflicts(conflicts, reviewerPersonId, subject).length > 0;
}

/* -------------------------------------------------------------------------- */
/* Advisory auto-detection                                                     */
/* -------------------------------------------------------------------------- */

export interface AutoDetectInput {
  reviewer_person_id: string;
  reviewer_email: string;
  /** Sponsors the reviewer is an active `SponsorContact` for. */
  reviewer_sponsor_ids: string[];
  subject: ProposalConflictSubject;
}

export interface DetectedConflict {
  subject_type: CoiSubjectType;
  subject_id: string | null;
  subject_value: string | null;
  reason: CoiReason;
  note: string;
}

/**
 * The three shallow signals the model names, and nothing more. Everything
 * produced here carries `source = auto_detected` so a chair can tell it apart
 * from a declaration.
 */
export function autoDetectConflicts(input: AutoDetectInput): DetectedConflict[] {
  const out: DetectedConflict[] = [];
  const { subject } = input;

  if (
    input.reviewer_person_id === subject.submitter_person_id ||
    subject.credited_person_ids.includes(input.reviewer_person_id)
  ) {
    out.push({
      subject_type: "proposal",
      subject_id: subject.proposal_id,
      subject_value: null,
      reason: "co_author",
      note: "Reviewer is credited on this proposal.",
    });
  }

  const reviewerDomain = emailDomain(input.reviewer_email);
  if (reviewerDomain && !isFreeMailDomain(reviewerDomain)) {
    const speakerDomains = new Set(subject.speaker_email_domains.map(normaliseDomain));
    if (speakerDomains.has(reviewerDomain)) {
      out.push({
        subject_type: "company_domain",
        subject_id: null,
        subject_value: reviewerDomain,
        reason: "same_employer",
        note: `Reviewer and a speaker share the email domain ${reviewerDomain}.`,
      });
    }
  }

  if (subject.sponsor_id && input.reviewer_sponsor_ids.includes(subject.sponsor_id)) {
    out.push({
      subject_type: "sponsor",
      subject_id: subject.sponsor_id,
      subject_value: null,
      reason: "financial",
      note: "Reviewer is a contact for the sponsoring company.",
    });
  }

  return out;
}

/**
 * Domain matching on a consumer mailbox is noise, not a signal: half a
 * committee is on gmail.com.
 */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "qq.com",
  "163.com",
]);

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(normaliseDomain(domain));
}
