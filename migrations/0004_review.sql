-- 0004 — Review & Selection: query indexes.
--
-- Purely additive: three indexes, no columns added, changed or dropped, no
-- data written or destroyed. Reversible with the matching DROP INDEX
-- statements at the foot of this file.
--
-- Every table and column the Review context needs already exists in
-- 0001_init.sql with exactly the model's fields. `Review.overall_score`,
-- `CriterionScore.effective_score`, `ProposalScore.*` and `ReviewerProgress.*`
-- are derived and deliberately have no columns (INV-11-6).

-- The results table and `review_round.closed` both sweep every review in a
-- round; `review_proposal_idx` is keyed on the proposal and cannot serve it.
CREATE INDEX IF NOT EXISTS review_round_status_idx ON review(round_id, status);

-- The publish batch and its preview list a round's provisional decisions;
-- `decision_proposal_idx` is keyed on the proposal.
CREATE INDEX IF NOT EXISTS decision_round_idx ON decision(round_id, status);

-- The rubric picker on the round form lists every rubric for one event.
CREATE INDEX IF NOT EXISTS rubric_event_idx ON rubric(event_id);

-- Down (not run automatically; recorded so the change is reversible):
--   DROP INDEX review_round_status_idx;
--   DROP INDEX decision_round_idx;
--   DROP INDEX rubric_event_idx;
