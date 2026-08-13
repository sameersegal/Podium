/**
 * `/review` and `/review/:assignmentId` — the reviewer's two screens.
 *
 * These are the same two screens `contexts/review/reviewer-views.ts` renders as
 * HTML, over the same read model (`reviewer-model.ts`), because the two share
 * URLs: a reviewer who lands here with scripts blocked and one who lands here
 * without must not find a different product. Where the two disagree, the
 * server-rendered one is right.
 *
 * ## Why this screen was worth porting
 *
 * A reviewer does one thing seventeen times. Server-rendered, every one of
 * those seventeen cost a full document — read the abstract, answer the rubric,
 * submit, wait, land on the next one, wait again — and the scorecard's own
 * draft was only ever as safe as the last time they pressed *Save draft*.
 * Client-rendered, the next proposal is one fetch, the draft is kept while they
 * move around, and the queue's counts renumber themselves as work is submitted
 * rather than at the next reload.
 *
 * ## What it does not do
 *
 * Writing the review still goes through `POST /v1/reviews`, which is the same
 * endpoint an API key is refused from (INV-09-27) and the same validation the
 * HTML form posts into. There is no client-side rubric validation beyond
 * disabling a button: INV-05-5 is the server's rule and a second, weaker copy
 * of it here would be a rule that disagrees with itself.
 */

import { h, cx, redraw } from "../kit.js";
import { api, unwrap } from "../api.js";
import { boot, resource, invalidate, toast, reportError } from "../store.js";
import { setChrome } from "../chrome.js";
import { location, navigate } from "../router.js";
import { badge, button, card, empty, field, humanise, notice, pageHead, plural, progressBar, relativeDays, spell } from "../ui.js";

const ACTIONABLE = ["assigned", "accepted", "in_progress"];

const SHOW_TITLES = { queue: "My queue", submitted: "Submitted", declined: "Declined" };

const EMPTY_FOR = {
  queue: "Everything assigned to you is done.",
  submitted: "You have not submitted a review in this round yet.",
  declined: "You have not declined anything.",
};

function showFilter(value) {
  return value === "submitted" || value === "declined" ? value : "queue";
}

function nowOf(d) {
  return Date.parse((d && d.now) || boot.now || new Date().toISOString());
}

function isOutstanding(r) {
  return ACTIONABLE.includes(r.status);
}

function isOverdue(r, now) {
  return Boolean(r.due_at) && Date.parse(r.due_at) < now && isOutstanding(r);
}

/** The three ways the rail navigates one queue — the mirror of `partitionQueue`. */
function partition(rows) {
  return {
    queue: rows.filter(isOutstanding),
    submitted: rows.filter((r) => r.status === "submitted"),
    declined: rows.filter((r) => !isOutstanding(r) && r.status !== "submitted"),
  };
}

/**
 * The queue resource, with the rail's counts taken off it.
 *
 * The boot document ships the counts so the rail is right on the first frame;
 * after that this is the newer answer, and a rail still saying "9 left" while
 * the screen behind it says four is the staleness a console that never reloads
 * is prone to. Same object, in place, for the reason `applyBoot` is: every view
 * reads through `boot`.
 */
function queueResource() {
  return resource("reviewer:queue", () =>
    api
      .get("/v1/me/assignments")
      .then(unwrap)
      .then((data) => {
        const parts = partition(data.rows);
        boot.reviewer = {
          counts: { queue: parts.queue.length, submitted: parts.submitted.length, declined: parts.declined.length },
          rounds: data.rounds,
        };
        return data;
      }),
  );
}

/* -------------------------------------------------------------------------- */
/* /review — the queue                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The screen a committee member opens twenty times during a round, built around
 * the one question they are asking: *what do I still owe, and which one is
 * next.*
 *
 * One list, not a grid of cards — the only thing that varies between two
 * assignments is how late each is, so that is the first column, in mono, and it
 * is the only thing carrying colour.
 */
export function reviewerQueue() {
  const show = showFilter(location.query.get("show"));
  // The same two hints `reviewerPage` puts in the bar. The rows below carry
  // `data-keylist` / `data-keyrow`, which is what `keys.js` actually reads.
  setChrome({
    section: show,
    title: SHOW_TITLES[show],
    hints: [
      { keys: ["J", "K"], label: "move" },
      { keys: ["↵"], label: "open" },
    ],
  });

  const res = queueResource();
  if (res.error) return card(notice(res.error.message, "err"), "Could not load your queue");
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));

  const d = res.data;
  const now = nowOf(d);
  const parts = partition(d.rows);
  const shown = parts[show];
  const overdue = parts.queue.filter((r) => isOverdue(r, now));
  const next = parts.queue[0] || null;

  if (d.rows.length === 0) {
    return h(
      "div",
      { class: "stack" },
      pageHead("Nothing is assigned to you", "When a chair adds you to a round and assigns you proposals, they arrive here."),
      card(
        h(
          "p",
          { class: "muted" },
          "There is nothing to do in the meantime. You will be emailed when a round opens, and the queue will be waiting for you when you follow the link.",
        ),
      ),
    );
  }

  const totals = Object.keys(d.progress).reduce(
    (acc, key) => ({ assigned: acc.assigned + d.progress[key].assigned, submitted: acc.submitted + d.progress[key].submitted }),
    { assigned: 0, submitted: 0 },
  );
  const pct = totals.assigned ? Math.round((totals.submitted / totals.assigned) * 100) : 0;

  return h(
    "div",
    { class: "grid queue-aside" },
    h(
      "div",
      { class: "stack" },
      pageHead(
        queueTitle(show, shown.length, overdue.length),
        queueLede(d.rounds),
        show === "queue" && next ? h("a", { class: "btn", href: "/review/" + next.id }, "Review the next one") : null,
      ),
      shown.length === 0
        ? empty(EMPTY_FOR[show])
        : h("section", { class: "card rows", "data-keylist": "" }, shown.map((r) => queueRow(r, now))),
      show === "queue" ? h("p", { class: "small muted" }, queueFooter(parts)) : null,
    ),
    h(
      "div",
      { class: "stack sticky-aside" },
      card([
        h("p", { class: "eyebrow" }, "Your progress"),
        h("p", { class: "big-figure" }, String(totals.submitted), h("span", { class: "of" }, "/" + totals.assigned)),
        progressBar(pct),
        h("p", { class: "small muted", style: "margin:10px 0 0" }, paceSentence(d, parts.queue.length, now)),
      ]),
      card([h("p", { class: "eyebrow" }, "Conflicts"), h("p", { class: "small muted", style: "margin:0" }, conflictSentence(d.conflicts))]),
    ),
  );
}

/**
 * "Nine left, three of them late" — the state of the queue, as a sentence, in
 * the heading. A heading that says "My reviews" has spent the largest type on
 * the page saying which page you are on, which you knew.
 */
function queueTitle(show, count, late) {
  if (show === "submitted") return spell(count) + " submitted";
  if (show === "declined") return spell(count) + " declined";
  if (count === 0) return "You are done";
  if (late === 0) return spell(count) + " left";
  return spell(count) + " left, " + spell(late).toLowerCase() + " of them late";
}

/**
 * What the reviewer will and will not be shown, said before they ask. Anonymity
 * is a property of the round (R10), so a reviewer sitting in two rounds with
 * different settings is told the strictest one applies somewhere.
 */
function queueLede(rounds) {
  const kinds = new Set(rounds.map((r) => r.anonymity));
  if (kinds.has("double_blind")) {
    return kinds.size > 1
      ? "One of your rounds is double-blind: there you will not see names, affiliations or links."
      : "Blind review. You will not see names, affiliations or links.";
  }
  if (kinds.has("single_blind")) return "Single-blind review. You see the speaker; they do not see you.";
  return "Open review. Names and affiliations are shown, and yours is shown to the committee.";
}

function queueFooter(parts) {
  return parts.submitted.length === 0
    ? "Nothing submitted yet."
    : "Plus " + spell(parts.submitted.length).toLowerCase() + " you have already submitted.";
}

/**
 * "At two a day you finish four days before the round closes."
 *
 * Two a day is an assumption and is stated as one. The rest is arithmetic
 * against the round's own close date, which is the number a reviewer is
 * budgeting against — a percentage complete never told anyone whether they were
 * going to make it.
 */
function paceSentence(d, remaining, now) {
  if (remaining === 0) return "Nothing outstanding. Thank you.";
  const closes = d.rounds
    .map((r) => r.closes_at)
    .filter(Boolean)
    .sort()[0];
  if (!closes) return plural(remaining, "proposal") + " still to score. This round has no closing date.";
  const daysLeft = Math.round((Date.parse(closes) - now) / 86400000);
  const daysNeeded = Math.ceil(remaining / 2);
  const slack = daysLeft - daysNeeded;
  if (daysLeft < 0) return "The round closed " + plural(Math.abs(daysLeft), "day") + " ago and " + plural(remaining, "proposal") + " are still open.";
  if (slack > 0) return "At two a day you finish " + plural(slack, "day") + " before the round closes.";
  if (slack === 0) return "At two a day you finish on the day the round closes.";
  return "At two a day you would miss the close by " + plural(Math.abs(slack), "day") + ".";
}

/**
 * Counted, never listed. A conflict's subject is a person, and naming which
 * proposals were withheld would leak exactly what withholding them was for
 * (INV-05-18).
 */
function conflictSentence(n) {
  if (n === 0) return "You have no declared conflicts, so nothing has been withheld from your queue.";
  if (n === 1) return "One conflict is on file for you. Proposals it touches are withheld from your queue rather than shown and refused.";
  return spell(n) + " conflicts are on file for you. Proposals they touch are withheld from your queue rather than shown and refused.";
}

/** One assignment: how late it is, what it is, and the one verb that moves it. */
function queueRow(r, now) {
  const href = "/review/" + r.id;
  const late = isOverdue(r, now);
  const days = r.due_at ? Math.round((Date.parse(r.due_at) - now) / 86400000) : null;
  const when =
    r.status === "submitted"
      ? r.submitted_at
        ? "sent " + relativeDays(r.submitted_at, now)
        : "submitted"
      : r.due_at
        ? late
          ? plural(Math.abs(days || 0), "day") + " late"
          : "due " + relativeDays(r.due_at, now)
        : "no deadline";
  const whenClass = r.status === "submitted" ? "none" : late ? "late" : days !== null && days <= 3 ? "soon" : r.due_at ? "" : "none";
  const hasDraft = r.status === "in_progress";

  return h(
    "div",
    { key: r.id, class: cx("queue-row", late && "late"), "data-keyrow": "", "data-href": href },
    h("span", { class: cx("due", whenClass) }, when),
    h(
      "div",
      { class: "body" },
      h("p", { class: "title" }, h("a", { href }, r.proposal ? r.proposal.title : "(proposal unavailable)")),
      h("p", { class: "meta" }, [r.proposal ? r.proposal.reference : r.proposal_id].concat(r.meta).join(" · ")),
    ),
    hasDraft ? h("span", { class: "chip" }, "draft saved") : null,
    h(
      "a",
      // Primary only where there is a draft to finish: eleven identical
      // primary buttons down a queue point at nothing in particular.
      { class: cx("btn small", isOutstanding(r) && hasDraft ? "" : "secondary"), href },
      r.status === "submitted" ? "View" : hasDraft ? "Finish" : isOutstanding(r) ? "Score" : "Open",
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* The draft being written                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One in-progress scorecard per assignment, held for as long as the console is
 * open.
 *
 * This is the thing the server-rendered screen could not do. A reviewer who
 * opened the next proposal to compare it against this one used to come back to
 * an empty form unless they had pressed *Save draft* first; here the answers
 * are still in it. Nothing in here is authoritative — the review on the server
 * is — so it is seeded from the loaded review once and thrown away when the
 * write lands.
 */
const drafts = new Map();

function draftFor(d) {
  const id = d.assignment.id;
  let draft = drafts.get(id);
  if (!draft) {
    const review = d.review;
    draft = {
      scores: {},
      na: {},
      recommendation: review ? review.recommendation || "" : "",
      confidence: review ? review.confidence || "" : "",
      flags: review ? review.flags.slice() : [],
      comments_for_committee: review ? review.comments_for_committee || "" : "",
      comments_for_speaker: review ? review.comments_for_speaker || "" : "",
    };
    for (const s of d.scores) {
      draft.scores[s.criterion_id] =
        s.value_number !== null && s.value_number !== undefined
          ? String(s.value_number)
          : s.value_option || s.value_text || (s.value_bool === null || s.value_bool === undefined ? "" : String(s.value_bool));
    }
    for (const criterionId of d.na_criterion_ids) draft.na[criterionId] = true;
    drafts.set(id, draft);
  }
  return draft;
}

/**
 * The draft as `POST /v1/reviews` reads it — the same field names the HTML form
 * posts, because it is the same endpoint and `readReviewDraft` is the same
 * parser.
 *
 * An `na_` key is *absent* rather than false when the criterion is not marked
 * not-applicable: the parser asks whether the key is present, so a `false` here
 * would mark every criterion N/A.
 */
function draftBody(d, draft, intent) {
  const body = {
    assignment_id: d.assignment.id,
    intent,
    recommendation: draft.recommendation || null,
    confidence: draft.confidence || null,
    flags: draft.flags,
    comments_for_committee: draft.comments_for_committee || null,
    comments_for_speaker: draft.comments_for_speaker || null,
  };
  for (const c of d.criteria) {
    if (draft.na[c.id]) {
      body["na_" + c.id] = "1";
      continue;
    }
    const value = draft.scores[c.id];
    if (value === undefined || value === "") continue;
    if (c.type === "numeric") body["score_number_" + c.id] = value;
    else if (c.type === "select") body["score_option_" + c.id] = value;
    else if (c.type === "text") body["score_text_" + c.id] = value;
    else if (c.type === "boolean") body["score_bool_" + c.id] = value;
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* /review/:assignmentId — the scorecard                                       */
/* -------------------------------------------------------------------------- */

let busy = null;

export function reviewerScorecard(params) {
  const key = "reviewer:assignment:" + params.assignmentId;
  const res = resource(key, () => api.get("/v1/me/assignments/" + params.assignmentId).then(unwrap));

  if (res.error) {
    setChrome({ section: "queue", title: "Review" });
    return card(
      [notice(res.error.message, "err"), h("p", null, h("a", { href: "/review" }, "← All my reviews"))],
      "This one is not yours to review",
    );
  }
  if (!res.data) {
    setChrome({ section: "queue", title: "Review" });
    return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));
  }

  const d = res.data;
  setChrome({ section: "queue", title: d.proposal.title });
  const draft = draftFor(d);
  const now = nowOf(d);
  const declinable = ACTIONABLE.includes(d.assignment.status);
  const submittable = ["declined", "revoked", "expired"].indexOf(d.assignment.status) < 0;
  const overdue = Boolean(d.assignment.due_at) && Date.parse(d.assignment.due_at) < now && declinable;

  return h(
    "div",
    { class: "stack" },
    queueBar(d.position),
    pageHead(
      d.proposal.title,
      d.proposal.reference + " · " + d.round.name + " · " + humanise(d.round.anonymity),
      [
        badge(d.assignment.status),
        d.assignment.due_at
          ? h(
              "span",
              { class: overdue ? "urgency-err" : "muted small" },
              (overdue ? "overdue — was due " : "due ") + relativeDays(d.assignment.due_at, now),
            )
          : null,
      ],
    ),
    d.proposal.blinded
      ? notice(
          "This round is double-blind: speaker names, bios, affiliations, links and any answer flagged personal are hidden from you.",
          "info",
        )
      : null,
    // Two columns on a wide screen: the proposal on the left, the scorecard on
    // the right and sticky. Scoring means reading an abstract and answering a
    // rubric at the same time, and stacked they are a screen apart.
    h(
      "div",
      { class: "review-split" },
      h(
        "div",
        { class: "review-reading" },
        card(proposalBody(d.proposal), "The proposal"),
        d.can_see_others ? otherReviewsCard(d) : lockedCard(),
        d.round.discussion_enabled && d.can_see_others ? discussionCard(d) : null,
        declinable ? declineCard(d) : null,
      ),
      h("div", { class: "review-scoring" }, submittable ? card(scorecard(d, draft), "Scorecard") : null),
    ),
  );
}

/**
 * "4 of 17", with the way back and the way on. A reviewer working a round is
 * doing one thing seventeen times, and the screen should say where they are in
 * it rather than looking identical on the first and the last.
 */
function queueBar(position) {
  if (!position) return h("p", { class: "review-queuebar" }, h("a", { href: "/review" }, "← All my reviews"));
  return h(
    "p",
    { class: "review-queuebar" },
    h("a", { href: "/review" }, "← All my reviews"),
    h("span", { class: "muted" }, position.index + 1 + " of " + position.total + " outstanding"),
    h("span", { class: "spacer" }),
    position.previous ? h("a", { class: "btn secondary small", href: "/review/" + position.previous }, "Previous") : null,
    position.next ? h("a", { class: "btn secondary small", href: "/review/" + position.next }, "Skip to next") : null,
  );
}

function kv(pairs) {
  const items = [];
  for (const [term, value] of pairs) {
    if (value === null || value === undefined || value === "") continue;
    items.push(h("dt", { key: "t" + term }, term));
    items.push(h("dd", { key: "d" + term }, value));
  }
  return items.length ? h("dl", { class: "kv" }, items) : null;
}

function proposalBody(p) {
  return [
    h("p", null, p.abstract),
    p.description ? h("div", { class: "small" }, p.description) : null,
    kv([
      ["Audience level", p.audience_level ? humanise(p.audience_level) : null],
      ["Requested duration", p.requested_duration_minutes ? p.requested_duration_minutes + " minutes" : null],
      ["Keywords", p.keywords.length ? p.keywords.join(", ") : null],
      ["Sponsor", p.sponsor_name],
      ["Disclosed conflicts", p.coi_disclosure],
    ]),
    p.answers.length
      ? h(
          "dl",
          { class: "kv" },
          p.answers.map((a) => [
            h("dt", { key: "t" + a.field_key }, a.label),
            h("dd", { key: "d" + a.field_key }, a.display === null || a.display === undefined ? h("span", { class: "muted" }, "Not answered") : a.display),
          ]),
        )
      : null,
    // Absent under `double_blind` rather than masked — the payload does not
    // carry them, so there is nothing here to leak.
    p.speakers.length ? h("h3", null, "Speakers") : null,
    p.speakers.map((s, i) =>
      h(
        "div",
        { key: "sp" + i, class: "speaker-card" },
        h("strong", null, s.full_name),
        s.headline ? " — " + s.headline : null,
        s.company ? " · " + s.company : null,
        s.bio ? h("p", { class: "small" }, s.bio) : null,
        s.links.length
          ? h("p", { class: "small" }, s.links.map((l, j) => h("a", { key: j, href: l, rel: "noopener" }, l + " ")))
          : null,
      ),
    ),
  ];
}

function lockedCard() {
  return card(
    notice(
      "Other reviews, the aggregate and the discussion open once your own review is submitted or you decline. Anchoring is real — this is deliberate, not a bug.",
      "info",
    ),
  );
}

function otherReviewsCard(d) {
  const human = d.other_reviews.filter((r) => r.author_kind === "human");
  const ai = d.other_reviews.filter((r) => r.author_kind === "ai");
  const agg = d.aggregate;
  return card(
    [
      agg
        ? h(
            "dl",
            { class: "kv" },
            h("dt", null, "Mean"),
            h("dd", null, agg.mean === null ? "—" : String(agg.mean)),
            h("dt", null, "Median"),
            h("dd", null, agg.median === null ? "—" : String(agg.median)),
            h("dt", null, "Reviews"),
            h("dd", null, agg.human_review_count + " human" + (agg.ai_review_count ? ", " + agg.ai_review_count + " AI" : "")),
            h("dt", null, "Quorum"),
            h("dd", null, agg.has_quorum ? badge("met", "ok") : badge("short", "warn")),
          )
        : null,
      human.length === 0 ? empty("No other human reviews yet.") : human.map((r) => reviewSummary(r)),
      ai.map((r) => reviewSummary(r)),
    ],
    "Other reviews",
  );
}

function reviewSummary(r) {
  return h(
    "div",
    { key: r.id, class: "review-summary" },
    h(
      "p",
      { class: "small" },
      r.author_kind === "ai" ? badge("AI", "ai") : null,
      r.recommendation ? badge(r.recommendation) : null,
      r.confidence ? h("span", { class: "muted small" }, "confidence: " + r.confidence) : null,
    ),
    r.author_kind === "ai" && r.ai_rationale ? h("p", { class: "small" }, r.ai_rationale) : null,
    r.comments_for_committee ? h("p", { class: "small" }, r.comments_for_committee) : null,
  );
}

function discussionCard(d) {
  return card(
    d.comments.length === 0
      ? empty("No discussion yet.")
      : h(
          "ul",
          { class: "notes" },
          d.comments.map((c) =>
            h("li", { key: c.id }, h("div", { class: "small muted" }, badge(c.visibility)), h("div", null, c.body)),
          ),
        ),
    "Discussion",
  );
}

/* -------------------------------------------------------------------------- */
/* The scorecard form                                                          */
/* -------------------------------------------------------------------------- */

function criterionField(c, draft, redrawOnly) {
  const value = draft.scores[c.id] === undefined ? "" : draft.scores[c.id];
  const na = Boolean(draft.na[c.id]);
  const set = (v) => {
    draft.scores[c.id] = v;
    redrawOnly();
  };

  let control;
  if (c.type === "numeric") {
    control = field({
      name: "score_number_" + c.id,
      id: "crit_" + c.id,
      label: c.label,
      type: "number",
      required: c.is_required && !c.allows_na,
      min: c.scale_min === null ? undefined : c.scale_min,
      max: c.scale_max === null ? undefined : c.scale_max,
      value,
      help: c.description,
      disabled: na,
      oninput: (ev) => set(ev.target.value),
    });
  } else if (c.type === "select") {
    control = field({
      name: "score_option_" + c.id,
      id: "crit_" + c.id,
      label: c.label,
      type: "radio",
      value,
      help: c.description,
      disabled: na,
      options: c.options.map((o) => ({ value: o.value, label: o.label, description: o.description })),
      onchange: (ev) => set(ev.target.value),
    });
  } else if (c.type === "boolean") {
    control = field({
      name: "score_bool_" + c.id,
      id: "crit_" + c.id,
      label: c.label,
      type: "radio",
      value,
      help: c.description,
      disabled: na,
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
      onchange: (ev) => set(ev.target.value),
    });
  } else {
    control = field({
      name: "score_text_" + c.id,
      id: "crit_" + c.id,
      label: c.label,
      type: "textarea",
      rows: 3,
      required: c.is_required && !c.allows_na,
      value,
      help: c.description,
      disabled: na,
      oninput: (ev) => set(ev.target.value),
    });
  }

  return h(
    "div",
    { key: c.id, class: "criterion" },
    control,
    c.allows_na
      ? field({
          name: "na_" + c.id,
          id: "na_" + c.id,
          label: "Not applicable — can't judge this",
          type: "checkbox",
          value: na,
          onchange: (ev) => {
            if (ev.target.checked) draft.na[c.id] = true;
            else delete draft.na[c.id];
            redrawOnly();
          },
        })
      : null,
  );
}

function scorecard(d, draft) {
  // The draft is plain state the next render reads; nothing else has to happen
  // when it changes, and a fetch here would refetch the scorecard on every
  // keystroke.
  const redrawOnly = redraw;
  const savedAt = d.review && d.review.status === "draft" ? d.review.updated_at : null;
  const hasNext = Boolean(d.position && d.position.next);
  const working = busy === d.assignment.id;

  return [
    savedAt
      ? h(
          "p",
          { class: "small muted" },
          "Draft saved " + relativeDays(savedAt, nowOf(d)) + ". Nothing here is visible to anyone else until you submit.",
        )
      : null,
    h(
      "div",
      { class: "stack" },
      d.criteria.map((c) => criterionField(c, draft, redrawOnly)),
      d.rubric.overall_scale === "recommendation"
        ? field({
            name: "recommendation",
            label: "Overall recommendation",
            type: "select",
            required: true,
            value: draft.recommendation,
            options: [{ value: "", label: "—" }].concat(d.enums.recommendation),
            onchange: (ev) => {
              draft.recommendation = ev.target.value;
              redrawOnly();
            },
          })
        : null,
      field({
        name: "confidence",
        label: "Confidence",
        type: "select",
        value: draft.confidence,
        options: [{ value: "", label: "—" }].concat(d.enums.confidence),
        onchange: (ev) => {
          draft.confidence = ev.target.value;
          redrawOnly();
        },
      }),
      field({
        name: "flags",
        label: "Flags",
        type: "multi_select",
        value: draft.flags,
        options: d.enums.flags,
        onchange: (values) => {
          draft.flags = values;
          redrawOnly();
        },
      }),
      field({
        name: "comments_for_committee",
        label: "Comments for the committee",
        type: "textarea",
        rows: 4,
        value: draft.comments_for_committee,
        help: "Never visible to the submitter.",
        oninput: (ev) => {
          draft.comments_for_committee = ev.target.value;
        },
      }),
      field({
        name: "comments_for_speaker",
        label: "Comments for the speaker",
        type: "textarea",
        rows: 4,
        value: draft.comments_for_speaker,
        help: "Released only if a decision using this feedback is published.",
        oninput: (ev) => {
          draft.comments_for_speaker = ev.target.value;
        },
      }),
      d.rubric.requires_comment ? h("p", { class: "small muted" }, "This rubric requires at least one written comment.") : null,
      h(
        "div",
        { class: "actions" },
        button("Save draft", () => write(d, draft, "save"), { variant: "secondary", disabled: working, busy: working }),
        button(hasNext ? "Submit and open the next" : "Submit review", () => write(d, draft, "submit"), {
          disabled: working,
          busy: working,
        }),
      ),
    ),
  ];
}

/**
 * Save or submit, through the same endpoint the HTML form posts to.
 *
 * The next assignment is decided from the position the payload already carries,
 * which the server computed *before* the write — submitting removes this one
 * from the outstanding queue and the reviewer's place in it goes with it, which
 * is the same reason the server-rendered POST picks the next one first.
 */
function write(d, draft, intent) {
  const id = d.assignment.id;
  busy = id;
  const next = d.position ? d.position.next : null;
  const remaining = d.position ? Math.max(0, d.position.total - 1) : 0;
  redraw();

  api
    .post("/v1/reviews", draftBody(d, draft, intent))
    .then(() => {
      busy = null;
      // Both the queue's counts and this scorecard moved. Dropped rather than
      // patched, so the next render re-reads them: the server is the authority
      // on a review's status, which is where INV-05-5 and INV-05-8 live. The
      // local draft goes with them — the review that comes back *is* the draft
      // now, and keeping a second copy is how the two start disagreeing.
      invalidate("reviewer:");
      drafts.delete(id);
      if (intent === "save") {
        toast("ok", "Draft saved.");
        return;
      }
      if (next) {
        toast("ok", "Review submitted. " + remaining + " left in your queue.");
        navigate("/review/" + next);
      } else {
        toast("ok", "Review submitted — that was the last one in your queue. Thank you.");
        navigate("/review");
      }
    })
    .catch((err) => {
      busy = null;
      reportError(err);
      redraw();
    });
}

/* -------------------------------------------------------------------------- */
/* Declining                                                                   */
/* -------------------------------------------------------------------------- */

const declineState = { reason: "", note: "" };

function declineCard(d) {
  const redrawOnly = redraw;
  return card(
    [
      h(
        "div",
        { class: "inline-grid" },
        field({
          name: "reason",
          label: "Reason",
          type: "select",
          required: true,
          value: declineState.reason,
          options: [{ value: "", label: "—" }].concat(d.enums.decline_reason),
          onchange: (ev) => {
            declineState.reason = ev.target.value;
            redrawOnly();
          },
        }),
        field({
          name: "note",
          label: "Note",
          value: declineState.note,
          oninput: (ev) => {
            declineState.note = ev.target.value;
          },
        }),
        button(
          "Decline this assignment",
          () => {
            api
              .post("/v1/me/assignments/" + d.assignment.id + "/decline", {
                reason: declineState.reason,
                note: declineState.note || null,
              })
              .then(() => {
                declineState.reason = "";
                declineState.note = "";
                invalidate("reviewer:");
                toast("ok", "Assignment declined.");
                navigate("/review");
              })
              .catch(reportError);
          },
          { variant: "secondary", disabled: !declineState.reason },
        ),
      ),
      h("p", { class: "small muted" }, "Declining for a conflict of interest records it, so you are never asked again (05)."),
    ],
    "Can't review this one?",
  );
}
