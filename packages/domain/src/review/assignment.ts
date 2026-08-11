/**
 * Assignment at scale — 05, "Assignment at scale" and R12.
 *
 * Three mechanisms, because a round of 900 proposals is not assigned by
 * clicking: caps, filtered bulk assignment, and auto-distribution. All three
 * refuse silently-bad outcomes loudly — a proposal that cannot reach quorum
 * without a COI violation is reported as unassignable rather than being quietly
 * under-reviewed.
 */

import type { AssignedBy } from "./types.js";

export interface PoolCandidate {
  person_id: string;
  /** `ReviewRoundReviewer.track_ids` — null or empty means "any track". */
  track_ids: string[] | null;
  /** `ReviewRoundReviewer.max_assignments`, already narrowed from the round's cap. */
  max_assignments: number | null;
  /** Live assignments they already hold in this round. */
  current_load: number;
}

export interface AssignableProposal {
  proposal_id: string;
  track_id: string | null;
  /** Reviewers who already hold an assignment on it (INV-05-2). */
  existing_reviewer_ids: string[];
  /** Reviewers a `ConflictOfInterest` matches (INV-05-4). */
  conflicted_reviewer_ids: string[];
}

export interface ProposedAssignment {
  proposal_id: string;
  reviewer_person_id: string;
  assigned_by: AssignedBy;
}

export interface UnassignableProposal {
  proposal_id: string;
  needed: number;
  achievable: number;
  reason: "all_eligible_conflicted" | "pool_at_capacity" | "no_eligible_reviewer";
  detail: string;
}

export interface DistributionResult {
  proposed: ProposedAssignment[];
  unassignable: UnassignableProposal[];
  /** Load after the proposal, so the chair sees what they are about to sign up for. */
  projected_load: Record<string, number>;
}

/**
 * INV-05-15 — a reviewer may only be assigned within a round whose pool they
 * belong to, with `pool_role = reviewer`, and whose `track_ids`, if set, include
 * the proposal's track. Pool filtering happens before this function; what is
 * checked here is the track narrowing, the cap and the conflicts.
 */
export function isEligible(candidate: PoolCandidate, proposal: AssignableProposal): boolean {
  if (proposal.existing_reviewer_ids.includes(candidate.person_id)) return false;
  if (proposal.conflicted_reviewer_ids.includes(candidate.person_id)) return false;
  if (candidate.track_ids && candidate.track_ids.length > 0) {
    if (!proposal.track_id || !candidate.track_ids.includes(proposal.track_id)) return false;
  }
  return true;
}

function hasCapacity(candidate: PoolCandidate, load: number): boolean {
  return candidate.max_assignments === null || load < candidate.max_assignments;
}

/**
 * Auto-distribution over the round's pool, honouring caps, track affinity and
 * every `ConflictOfInterest`, aiming at `target_reviews_per_proposal`.
 *
 * It produces a **proposed** set the chair reviews and confirms (R12); nothing
 * here writes. Proposals are filled hardest-first — fewest eligible reviewers
 * first — because filling the easy ones first is how the constrained ones end
 * up unassignable. Ties break on id so the same input always proposes the same
 * output, which is what makes "run it again and compare" a usable workflow.
 */
export function autoDistribute(input: {
  pool: PoolCandidate[];
  proposals: AssignableProposal[];
  target_reviews_per_proposal: number;
}): DistributionResult {
  const load: Record<string, number> = {};
  for (const c of input.pool) load[c.person_id] = c.current_load;

  const byId = new Map(input.pool.map((c) => [c.person_id, c]));
  const proposed: ProposedAssignment[] = [];
  const unassignable: UnassignableProposal[] = [];

  const ordered = [...input.proposals].sort((a, b) => {
    const ea = input.pool.filter((c) => isEligible(c, a)).length;
    const eb = input.pool.filter((c) => isEligible(c, b)).length;
    if (ea !== eb) return ea - eb;
    return a.proposal_id.localeCompare(b.proposal_id);
  });

  for (const proposal of ordered) {
    const eligible = input.pool.filter((c) => isEligible(c, proposal));
    const needed = Math.max(0, input.target_reviews_per_proposal - proposal.existing_reviewer_ids.length);
    if (needed === 0) continue;

    const taken: string[] = [];
    for (let i = 0; i < needed; i++) {
      const next = eligible
        .filter((c) => !taken.includes(c.person_id) && hasCapacity(c, load[c.person_id] ?? 0))
        .sort((a, b) => {
          const la = load[a.person_id] ?? 0;
          const lb = load[b.person_id] ?? 0;
          if (la !== lb) return la - lb;
          return a.person_id.localeCompare(b.person_id);
        })[0];
      if (!next) break;
      taken.push(next.person_id);
      load[next.person_id] = (load[next.person_id] ?? 0) + 1;
      proposed.push({
        proposal_id: proposal.proposal_id,
        reviewer_person_id: next.person_id,
        assigned_by: "algorithm",
      });
    }

    if (taken.length < needed) {
      const conflictedOut = input.pool.length > 0 && eligible.length === 0 && proposal.conflicted_reviewer_ids.length > 0;
      unassignable.push({
        proposal_id: proposal.proposal_id,
        needed: input.target_reviews_per_proposal,
        achievable: proposal.existing_reviewer_ids.length + taken.length,
        reason: conflictedOut
          ? "all_eligible_conflicted"
          : eligible.length === 0
            ? "no_eligible_reviewer"
            : "pool_at_capacity",
        detail: conflictedOut
          ? "Every reviewer in the pool has a conflict of interest with this proposal."
          : eligible.length === 0
            ? "No reviewer in the pool matches this proposal's track."
            : `Every eligible reviewer is at their assignment cap; ${taken.length} of ${needed} could be placed.`,
      });
    }
  }

  // Keep the proposal in a stable, readable order for the confirmation screen.
  proposed.sort((a, b) =>
    a.proposal_id === b.proposal_id
      ? a.reviewer_person_id.localeCompare(b.reviewer_person_id)
      : a.proposal_id.localeCompare(b.proposal_id),
  );

  return { proposed, unassignable, projected_load: load };
}

/**
 * Filtered bulk assignment — "assign the whole filtered set to one reviewer or
 * spread it across a chosen group in one command". Spreading is round-robin
 * over the chosen group in the order the chair picked them, skipping anyone
 * ineligible or at their cap for that particular proposal, so one conflicted
 * reviewer does not silently shift the whole rotation.
 */
export function spreadAcross(input: {
  pool: PoolCandidate[];
  proposals: AssignableProposal[];
  reviewer_person_ids: string[];
  /** `one_each` gives every chosen reviewer every proposal; `spread` rotates. */
  mode: "spread" | "one_each";
}): DistributionResult {
  const chosen = input.reviewer_person_ids
    .map((id) => input.pool.find((c) => c.person_id === id))
    .filter((c): c is PoolCandidate => !!c);

  const load: Record<string, number> = {};
  for (const c of input.pool) load[c.person_id] = c.current_load;

  const proposed: ProposedAssignment[] = [];
  const unassignable: UnassignableProposal[] = [];
  let cursor = 0;

  for (const proposal of input.proposals) {
    if (input.mode === "one_each") {
      let placed = 0;
      for (const candidate of chosen) {
        if (!isEligible(candidate, proposal) || !hasCapacity(candidate, load[candidate.person_id] ?? 0)) continue;
        load[candidate.person_id] = (load[candidate.person_id] ?? 0) + 1;
        proposed.push({ proposal_id: proposal.proposal_id, reviewer_person_id: candidate.person_id, assigned_by: "chair" });
        placed++;
      }
      if (placed === 0) {
        unassignable.push(describeFailure(proposal, chosen, load, 1, 0));
      }
      continue;
    }

    let placed = false;
    for (let attempt = 0; attempt < chosen.length && !placed; attempt++) {
      const candidate = chosen[(cursor + attempt) % chosen.length];
      if (!isEligible(candidate, proposal) || !hasCapacity(candidate, load[candidate.person_id] ?? 0)) continue;
      load[candidate.person_id] = (load[candidate.person_id] ?? 0) + 1;
      proposed.push({ proposal_id: proposal.proposal_id, reviewer_person_id: candidate.person_id, assigned_by: "chair" });
      cursor = (cursor + attempt + 1) % chosen.length;
      placed = true;
    }
    if (!placed) unassignable.push(describeFailure(proposal, chosen, load, 1, 0));
  }

  return { proposed, unassignable, projected_load: load };
}

function describeFailure(
  proposal: AssignableProposal,
  chosen: PoolCandidate[],
  load: Record<string, number>,
  needed: number,
  achievable: number,
): UnassignableProposal {
  const eligible = chosen.filter((c) => isEligible(c, proposal));
  if (eligible.length === 0 && proposal.conflicted_reviewer_ids.length > 0) {
    return {
      proposal_id: proposal.proposal_id,
      needed,
      achievable,
      reason: "all_eligible_conflicted",
      detail: "Every reviewer you chose has a conflict of interest with this proposal.",
    };
  }
  if (eligible.length === 0) {
    return {
      proposal_id: proposal.proposal_id,
      needed,
      achievable,
      reason: "no_eligible_reviewer",
      detail: "None of the reviewers you chose covers this proposal's track, or they already hold it.",
    };
  }
  return {
    proposal_id: proposal.proposal_id,
    needed,
    achievable,
    reason: "pool_at_capacity",
    detail: `Every eligible reviewer you chose is at their cap (${eligible
      .map((c) => `${c.person_id}: ${load[c.person_id] ?? 0}/${c.max_assignments}`)
      .join(", ")}).`,
  };
}

/** The cap in force for one pool member: their own, else the round's, else none. */
export function effectiveCap(
  roundCap: number | null | undefined,
  personCap: number | null | undefined,
): number | null {
  if (personCap !== null && personCap !== undefined) return personCap;
  if (roundCap !== null && roundCap !== undefined) return roundCap;
  return null;
}
