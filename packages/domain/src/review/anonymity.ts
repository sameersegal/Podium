/**
 * What a reviewer is allowed to see, and the `content_hash` that covers exactly
 * that — 05, "Fairness rules made explicit" and INV-05-8 / INV-04-12.
 *
 * "Under `double_blind`, reviewers do not see speaker names, bios,
 * affiliations, links, or any answer whose field is flagged `pii`, and the
 * proposal's `content_hash` covers only the fields they can see."
 */

import type { FieldType } from "../event-config/types.js";
import { contentHash } from "../identity/credentials.js";
import { answerDisplay, type ReferenceLabels } from "../submissions/answer-display.js";
import type { RoundAnonymity } from "./types.js";

export interface ProposalAnswerView {
  field_key: string;
  label: string;
  /** Drives how `value` reads — see `answerDisplay`. */
  type: FieldType;
  options?: { value: string; label: string; description?: string | null }[] | null;
  value: unknown;
  /** `FormField.pii` — redacted under `double_blind` regardless of scope. */
  pii: boolean;
}

export interface ProposalSpeakerView {
  person_id: string;
  full_name: string;
  company: string | null;
  headline: string | null;
  bio: string | null;
  links: string[];
  email: string;
}

export interface ReviewableProposal {
  id: string;
  reference: string;
  title: string;
  abstract: string;
  description: string | null;
  session_format_id: string | null;
  track_id: string | null;
  requested_duration_minutes: number | null;
  audience_level: string | null;
  keywords: string[];
  language: string | null;
  coi_disclosure: string | null;
  sponsor_id: string | null;
  sponsor_name: string | null;
  answers: ProposalAnswerView[];
  /** `id -> name` for the references those answers hold (`ProposalAnswer.display`). */
  reference_labels: ReferenceLabels;
  speakers: ProposalSpeakerView[];
}

export interface ReviewableProjection {
  proposal_id: string;
  reference: string;
  title: string;
  abstract: string;
  description: string | null;
  session_format_id: string | null;
  track_id: string | null;
  requested_duration_minutes: number | null;
  audience_level: string | null;
  keywords: string[];
  language: string | null;
  coi_disclosure: string | null;
  sponsor_name: string | null;
  /**
   * `display` is what a reviewer reads; `value` is what the content hash covers.
   * A view that renders `value` shows raw ids for the reference-valued types.
   */
  answers: { field_key: string; label: string; value: unknown; display: string | null }[];
  /** Empty under `double_blind`. */
  speakers: { full_name: string; company: string | null; headline: string | null; bio: string | null; links: string[] }[];
  anonymity: RoundAnonymity;
  blinded: boolean;
}

/**
 * The proposal as the round's anonymity allows. Under `double_blind` the
 * speakers are absent rather than masked, and `pii`-flagged answers are dropped
 * entirely — a redacted placeholder still leaks that the answer exists, and
 * "Removed" next to a company name is often enough to identify the lab.
 *
 * The same reasoning governs the two reference-valued answers that name people
 * indirectly (05, "Fairness rules made explicit"). A `speaker_list` answer *is*
 * the roster, so under `double_blind` it goes with the speakers rather than
 * being rendered as their names; `file` answers keep their count but lose their
 * filenames, because `jane-doe-cv.pdf` identifies as surely as a name does.
 */
export function reviewableProjection(
  proposal: ReviewableProposal,
  anonymity: RoundAnonymity,
): ReviewableProjection {
  const blinded = anonymity === "double_blind";
  return {
    proposal_id: proposal.id,
    reference: proposal.reference,
    title: proposal.title,
    abstract: proposal.abstract,
    description: proposal.description,
    session_format_id: proposal.session_format_id,
    track_id: proposal.track_id,
    requested_duration_minutes: proposal.requested_duration_minutes,
    audience_level: proposal.audience_level,
    keywords: proposal.keywords,
    language: proposal.language,
    coi_disclosure: blinded ? null : proposal.coi_disclosure,
    // A sponsor session is identifiable by definition — the sponsor is the
    // point — which is why blind rounds exclude them by scope rather than
    // pretending (05, "Fairness rules made explicit").
    sponsor_name: blinded ? null : proposal.sponsor_name,
    answers: proposal.answers
      .filter((a) => !(blinded && (a.pii || a.type === "speaker_list")))
      .map((a) => ({
        field_key: a.field_key,
        label: a.label,
        value: a.value,
        display: answerDisplay(a, a.value, blinded && a.type === "file" ? {} : proposal.reference_labels),
      })),
    speakers: blinded
      ? []
      : proposal.speakers.map((s) => ({
          full_name: s.full_name,
          company: s.company,
          headline: s.headline,
          bio: s.bio,
          links: s.links,
        })),
    anonymity,
    blinded,
  };
}

/**
 * INV-04-12 / INV-05-8 — `content_hash` covers exactly the fields reviewers
 * score against. Because a blind round shows less, its hash covers less: a
 * speaker updating their bio does not invalidate a double-blind review that
 * never saw the bio, and — for the same reason — a co-speaker joining the
 * roster does not, because the `speaker_list` answer the projection dropped is
 * not in this list either.
 *
 * It hashes `value`, not `display`: the answer is the fact, and a track being
 * renamed is not a change to the proposal.
 */
export function reviewableContentHash(projection: ReviewableProjection): string {
  return contentHash([
    projection.anonymity,
    projection.title,
    projection.abstract,
    projection.description ?? "",
    projection.session_format_id ?? "",
    projection.track_id ?? "",
    projection.requested_duration_minutes ?? "",
    projection.audience_level ?? "",
    [...projection.keywords].sort(),
    projection.language ?? "",
    projection.coi_disclosure ?? "",
    projection.sponsor_name ?? "",
    [...projection.answers]
      .sort((a, b) => a.field_key.localeCompare(b.field_key))
      .map((a) => [a.field_key, a.value]),
    projection.speakers.map((s) => [s.full_name, s.company ?? "", s.headline ?? "", s.bio ?? "", [...s.links].sort()]),
  ]);
}

/**
 * `single_blind` hides reviewers from submitters; `double_blind` also hides
 * speakers from reviewers. Reviewer identities are never exposed to submitters
 * in any state, so the only question anonymity answers on a read model is
 * whether a *committee* reader sees who wrote a review.
 */
export function reviewerIdentityVisible(anonymity: RoundAnonymity): boolean {
  return anonymity === "open";
}
