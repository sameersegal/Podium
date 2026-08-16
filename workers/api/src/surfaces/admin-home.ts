/**
 * `/admin` — Today.
 *
 * It answers one question, and it is not "how is the event going": it is *what
 * needs me today*. The difference is the whole screen. A wall of counts reports
 * the state of the world and leaves the reader to work out which of them is a
 * problem; this one lists the things only a person can move, orders them by what
 * stops the event if they slip, and puts the verb that moves each one on the
 * same row.
 *
 * Three rules it keeps:
 *
 * - **A row is a thing somebody does.** Anything nobody can act on is not a row.
 *   Rows whose count is zero drop out entirely rather than rendering a proud 0.
 * - **The second line says why it matters**, not what the first line already
 *   said. "Nobody is told until you publish" is the reason the number is
 *   dangerous; "12 provisional decisions" is the number again.
 * - **Every number is derived at read time** from the rows that produce it
 *   (11, "Derived fields"). Nothing here is stored and nothing is cached.
 *
 * The numbers come from `surfaces/dashboard.ts` — the same cross-context read
 * model the console's client-rendered dashboard uses, so the two cannot
 * disagree about how many decisions are unpublished.
 */

import { num, str, type Row } from "@podiumstack/data/db.js";
import { relativeDays } from "@podiumstack/domain/shared/time.js";
import type { RequestContext } from "../http/context.js";
import { htmlResponse, redirect } from "../http/responses.js";
import type { Router } from "../http/router.js";
import { html, raw, type SafeHtml } from "../ui/html.js";
import { avatar, card, empty, pageHead, progressBar } from "../ui/layout.js";
import { adminPage, toEventRef, type EventRef } from "../ui/shell.js";
import { plural, Spell } from "../ui/words.js";
import { eventDashboard, type EventDashboard } from "./dashboard.js";

export function registerAdminHomeRoutes(router: Router<RequestContext>): void {
  router.get("/admin", async (_req, ctx) => {
    if (!ctx.person && !ctx.apiKeyId) return redirect("/login?next=/admin");
    const app = ctx.app();

    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    const live = events.filter((e) => str(e.status) === "active");
    const focus = live[0] ?? events[0] ?? null;
    const ev = focus ? toEventRef(focus) : null;

    if (!ctx.isStaff({ event_id: ev?.id })) {
      // Not staff anywhere — the portal is where their work lives.
      return redirect("/portal");
    }

    if (!ev) {
      return htmlResponse(
        adminPage(
          ctx,
          { title: "Today", active: "today" },
          html`${pageHead("There is no event yet", "Everything else in here hangs off one, so this is the only thing to do.", html`<a class="btn" href="/admin/events/new">Create an event</a>`)}`,
        ),
      );
    }

    ctx.eventId = ev.id;
    // The Today subset: this screen draws no submission chart, no per-call
    // table, no sponsorship totals and no activation checklist, so it does
    // not pay for their queries.
    const d = await eventDashboard(app, ev.id, ctx.now, "today");

    // The one number the dashboard does not carry, and the only extra query on
    // this screen: how long the oldest unpublished decision has been sitting.
    // A count of twelve says how much work there is; "the oldest has been
    // waiting nine days" says whether it is a problem.
    // The strip's summary line also needs a proposal total, which the funnel
    // does not carry — its six stages deliberately exclude the terminal ones,
    // because nobody works a rejection queue.
    const extra = await app.db.raw<{ at: string | null; proposals: number }>(
      `SELECT (SELECT MIN(d.decided_at) FROM decision d JOIN proposal p ON p.id = d.proposal_id
                WHERE p.event_id = ? AND d.status = 'provisional')                       AS at,
              (SELECT COUNT(*) FROM proposal WHERE event_id = ? AND deleted_at IS NULL)  AS proposals`,
      [ev.id, ev.id],
    );
    const oldestProvisional = str(extra[0]?.at ?? "") || null;
    const proposals = num(extra[0]?.proposals);

    const rows = needsYou(d, ev, oldestProvisional, ctx.now);
    const total = rows.reduce((n, r) => n + r.count, 0);

    return htmlResponse(
      adminPage(
        ctx,
        {
          title: "Today",
          event: ev,
          active: "today",
          status: publishState(d),
        },
        html`
          ${pageHead(
            total === 0 ? "Nothing needs you today" : `${Spell(total)} things need you today`,
            total === 0
              ? "Everything that can be waiting on somebody is waiting on somebody else."
              : "Ordered by what stops the event if it slips. Everything else is quiet.",
            html`<a class="btn secondary" href="/admin/exports">Export</a>
              <a class="btn" href="/admin/events/${ev.id}/publications">Publish schedule</a>`,
          )}
          ${pipeline(d, proposals)}
          <div class="grid main-aside">
            <section class="card rows">
              <div class="card-head">
                <h2 class="eyebrow">Needs you</h2>
                <span class="spacer"></span>
                <p class="note">Blocking first</p>
              </div>
              ${rows.length === 0
                ? empty("Nothing is waiting on you. That is either very good news, or the event has not started yet.")
                : html`${rows.map(needsRow)}`}
            </section>
            <div class="stack">
              ${roundCard(d)}
              ${deadlinesCard(d, ctx.now)}
            </div>
          </div>
        `,
      ),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* the pipeline strip                                                          */
/* -------------------------------------------------------------------------- */

/** Which of the six funnel stages carries which wash. */
const FUNNEL_TONE: Record<string, string> = {
  draft: "",
  submitted: "accent",
  in_review: "accent",
  accepted: "ok",
  confirmed: "ok",
  placed: "",
};

/**
 * The round, end to end, as one bar rather than six tiles.
 *
 * The point of the strip is that a proposal *moves through* these stages, which
 * six boxes with gaps between them do not say. The bar underneath restates the
 * same six numbers as proportions, because 184 and 24 cannot be compared by
 * reading them.
 */
function pipeline(d: EventDashboard, proposals: number): SafeHtml {
  const total = d.funnel.reduce((n, f) => n + f.count, 0);
  if (total === 0) return raw("");
  // The segments are proportions of the six stages *shown*, so they fill the
  // bar. A bar that stops two-thirds of the way across reads as "a third is
  // missing" rather than "these are the six numbers above, to scale".
  const seg = ["seg-draft", "seg-waiting", "seg-review", "seg-accepted", "seg-accepted", "seg-placed"];
  return html`<section class="card">
    <div class="card-head">
      <h2 class="eyebrow">The round, end to end</h2>
      <span class="spacer"></span>
      <p class="note">
        ${plural(proposals, "proposal")} · ${plural(d.schedule.sessions, "session")} · ${d.schedule.placed} placed
      </p>
    </div>
    <div class="pipeline">
      ${d.funnel.map(
        (f) => html`<a class="${FUNNEL_TONE[f.key] ?? ""}" href="${f.href}">
          <span class="n">${f.count}</span><span class="l">${f.label}</span>
        </a>`,
      )}
    </div>
    <div class="pipeline-bar">
      ${d.funnel.map((f, i) => html`<span class="${seg[i]}" style="width:${((f.count / total) * 100).toFixed(1)}%"></span>`)}
    </div>
  </section>`;
}

/* -------------------------------------------------------------------------- */
/* needs you                                                                   */
/* -------------------------------------------------------------------------- */

interface NeedsRow {
  count: number;
  /** How loud. Decides the rule colour, the wash, and whether the number is red. */
  tone: "danger" | "warn" | "info" | "quiet";
  what: string;
  why: string;
  verb: string;
  href: string;
  /** Only the top row's verb is primary — two primaries is no primary. */
  primary?: boolean;
}

/**
 * The five queues an organizer actually works, in the order that decides which
 * one to open first: what has already gone wrong, then what is about to, then
 * what merely has not happened yet.
 */
function needsYou(d: EventDashboard, ev: EventRef, oldestProvisional: string | null, now: string): NeedsRow[] {
  const e = `/admin/events/${ev.id}`;
  const rows = ([
    {
      count: d.decisions.provisional,
      tone: "danger",
      what: "Provisional decisions nobody has been told about",
      why: oldestProvisional
        ? `The oldest was taken ${relativeDays(oldestProvisional, now)}. Nobody hears anything until you publish.`
        : "Nobody hears anything until you publish, and the confirmation clock does not start either.",
      verb: "Publish decisions",
      href: `${e}/decisions`,
    },
    {
      count: d.decisions.awaiting_confirmation,
      tone: "warn",
      what: "Accepted speakers have not confirmed",
      why:
        d.decisions.confirmation_overdue > 0
          ? `${d.decisions.confirmation_overdue} are past their deadline and can expire.`
          : "None are past their deadline yet. A reminder goes out from the session list.",
      verb: `Chase ${d.decisions.awaiting_confirmation}`,
      href: `${e}/sessions?status=pending_confirmation`,
    },
    {
      count: d.onboarding.overdue,
      tone: "warn",
      what: "Onboarding tasks are past due",
      why:
        d.onboarding.blocking_open > 0
          ? `${d.onboarding.blocking_open} open tasks are blocking, and a session with one stays off the public schedule.`
          : "None of them block publication, so this is a chase rather than a hold.",
      verb: "Open board",
      href: `${e}/onboarding`,
    },
    {
      count: d.schedule.unplaced,
      tone: "info",
      what: "Confirmed sessions have no room and no time",
      why: "Nothing reaches the public schedule until each one has both.",
      verb: "Place them",
      href: `${e}/schedule`,
    },
    {
      count: d.schedule.conflict_errors,
      tone: "danger",
      what: "Placements conflict and nobody has acknowledged it",
      why: "A blocking conflict refuses publication, so the schedule cannot go out while one is open.",
      verb: "Resolve",
      href: `${e}/schedule`,
    },
    {
      count: d.schedule.pending_publication_changes,
      tone: "quiet",
      what: "Schedule changes are not on the public site yet",
      why: "The public page and the calendar feed still show the last published version.",
      verb: "Review diff",
      href: `${e}/publications`,
    },
  ] as NeedsRow[]).filter((r) => r.count > 0);

  // Blocking first, and only the first one gets the filled button.
  const order: NeedsRow["tone"][] = ["danger", "warn", "info", "quiet"];
  rows.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone));
  if (rows[0]) rows[0].primary = true;
  return rows;
}

function needsRow(r: NeedsRow): SafeHtml {
  return html`<div class="needs-row ${r.tone}">
    <span class="rule" aria-hidden="true"></span>
    <span class="n">${r.count}</span>
    <div class="body">
      <p class="what">${r.what}</p>
      <p class="why">${r.why}</p>
    </div>
    <div class="actions"><a class="btn small ${r.primary ? "" : "secondary"}" href="${r.href}">${r.verb}</a></div>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* the right column                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The open round, and who is holding it up.
 *
 * Named rather than counted: "eleven reviews outstanding" is not something
 * anybody can act on, and "Priya has eleven, four of them late" is a message
 * somebody can send — which is what the button under it does.
 */
function roundCard(d: EventDashboard): SafeHtml {
  const round = d.review.rounds.find((r) => r.status === "open") ?? d.review.rounds[0];
  if (!round || round.assignments === 0) return raw("");
  const pct = round.assignments === 0 ? 0 : Math.round((round.submitted / round.assignments) * 100);
  const behind = d.review.reviewers_behind.slice(0, 3);
  return html`<section class="card">
    <div class="card-head">
      <h2 class="eyebrow">${round.name}</h2>
      <span class="spacer"></span>
      <p class="note mono">${round.submitted}/${round.assignments} reviews</p>
    </div>
    ${progressBar(pct)}
    <p class="small muted" style="margin:6px 0 14px">
      ${round.below_quorum > 0
        ? `${plural(round.below_quorum, "proposal")} ${round.below_quorum === 1 ? "is" : "are"} short of quorum and cannot be decided.`
        : "Every proposal in this round has enough reviews to be decided."}
    </p>
    ${behind.length === 0
      ? raw("")
      : html`<p class="eyebrow small" style="margin-bottom:8px">Holding it up</p>
          <div class="stack" style="gap:8px">
            ${behind.map(
              (p) => html`<div class="person-row">
                ${avatar(p.name, null, 24)}
                <span class="name">${p.name}</span>
                <span class="load ${p.overdue > 0 ? "late" : ""}">${p.outstanding}${p.overdue > 0 ? ` · ${p.overdue} late` : ""}</span>
              </div>`,
            )}
          </div>
          <form method="post" action="/admin/rounds/${round.id}/progress/remind" style="margin-top:14px">
            ${behind.map((p) => html`<input type="hidden" name="reviewer_person_id" value="${p.person_id}">`)}
            <button type="submit" class="secondary block">
              ${behind.length === 1 ? "Nudge them" : `Nudge all ${behind.length === 2 ? "two" : "three"}`}
            </button>
          </form>`}
  </section>`;
}

/**
 * What is coming, as distance rather than as dates. An organizer reads this
 * column to find out how much room they have, and "in 4 days" answers that
 * where "12 May" needs subtracting from today first.
 */
function deadlinesCard(d: EventDashboard, now: string): SafeHtml {
  const rows = d.deadlines.slice(0, 5);
  if (rows.length === 0) return raw("");
  return html`<section class="card">
    <h2 class="eyebrow" style="margin-bottom:12px">Next deadlines</h2>
    <div class="deadlines">
      ${rows.map((dl, i) => {
        const days = Math.round((Date.parse(dl.at) - Date.parse(now)) / 86_400_000);
        const tone = days < 7 ? "near" : days < 14 ? "soon" : "";
        const last = i === rows.length - 1 && rows.length > 1;
        return html`<div class="deadline ${last ? "last" : ""}">
          <span class="when ${tone}">${relativeDays(dl.at, now)}</span>
          <span class="what">${dl.href ? html`<a href="${dl.href}">${dl.label}</a>` : dl.label}</span>
        </div>`;
      })}
    </div>
  </section>`;
}

/** `Schedule v7 · 3 changes unpublished`, in the top bar, or nothing to say. */
function publishState(d: EventDashboard): { label: string; kind: "ok" | "warn" } | null {
  const pending = d.schedule.pending_publication_changes;
  if (d.schedule.placed === 0 && pending === 0) return null;
  if (pending === 0) return { label: "Schedule published · nothing pending", kind: "ok" };
  return { label: `${plural(pending, "change")} unpublished`, kind: "warn" };
}
