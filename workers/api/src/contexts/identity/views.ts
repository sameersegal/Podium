/**
 * Identity & Access — the rendered surfaces.
 *
 * `/admin/team`, `/admin/events/:eventId/roster` (the `EventRoster` read model),
 * `/admin/people/:personId`, the merge confirmation, and the speaker's own
 * `/portal/profile`.
 */

import { bool, num, parseJson, str, type Row } from "@podiumconf/data/db.js";
import {
  INVITATION_KIND,
  PARTICIPANT_KIND,
  PARTICIPANT_STATUS,
  PARTICIPANT_TRANSITIONS,
  PROFILE_LINK_KIND,
  type ParticipantStatus,
} from "@podiumconf/domain/identity/types.js";
import { ROLES } from "@podiumconf/domain/shared/authorization.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, progressBar, stat, submitButton, table } from "../../ui/layout.js";
import type { EventRef } from "../../ui/shell.js";
import type { MergeCandidateView, PersonRecord, RosterFilters, RosterRow, TeamRow } from "./service.js";

export function headshotUrl(assetId: string | null | undefined): string | null {
  return assetId ? `/assets/${assetId}` : null;
}

/**
 * INV-01-15 — the `accept_url` is returned exactly once, in the response to
 * the command that created it, and is never re-readable.
 *
 * It is rendered rather than redirected to, because that *is* the guarantee:
 * "provisioning a reviewer must never dead-end at 'check your email'."
 */
export function acceptUrlPanel(acceptUrl: string, email: string, back: string): SafeHtml {
  return card(
    html`<p class="lede">The invitation for <strong>${email}</strong> is ready.</p>
      <p class="notice warn">
        This link is shown <strong>once</strong> and cannot be read again. Copy it now and send it however you like —
        provisioning an account never depends on mail delivery.
      </p>
      <p class="mono" style="word-break:break-all;user-select:all;padding:.75rem;background:var(--surface-2,#f4f4f5);border-radius:6px">
        ${acceptUrl}
      </p>
      <p><a href="${back}">Done — back to the list</a></p>`,
    "Copy this invitation link",
  );
}

/* -------------------------------------------------------------------------- */
/* /admin/team                                                                 */
/* -------------------------------------------------------------------------- */

export interface ScopeOption {
  value: string;
  label: string;
}

export interface TeamPageData {
  rows: TeamRow[];
  scopeNames: Record<string, string>;
  invitations: Row[];
  scopeOptions: ScopeOption[];
  now: string;
  canWrite: boolean;
}

export function teamView(data: TeamPageData): SafeHtml {
  const roleOptions = ROLES.map((r) => ({ value: r, label: humanise(r) }));

  const grantRows = data.rows.map((r) => {
    const g = r.grant;
    const active = !g.revoked_at && (!g.expires_at || str(g.expires_at) > data.now);
    return html`<tr>
      <td>
        ${r.person ? html`<a href="/admin/people/${str(r.person.id)}">${str(r.person.full_name)}</a>` : html`<span class="muted">(unknown)</span>`}
        <div class="small muted">${r.person ? str(r.person.email) : ""}</div>
      </td>
      <td>${badge(str(g.role), active ? "ok" : "")}</td>
      <td>${str(g.scope_type)} · ${data.scopeNames[str(g.scope_id)] ?? str(g.scope_id)}</td>
      <td class="small">${r.granted_by ? str(r.granted_by.full_name) : "system"}<div class="muted">${str(g.granted_at).slice(0, 10)}</div></td>
      <td class="small">${g.expires_at ? str(g.expires_at).slice(0, 10) : html`<span class="muted">never</span>`}</td>
      <td>${g.revoked_at ? badge("revoked") : active ? badge("active") : badge("expired")}</td>
      <td>
        ${data.canWrite && active
          ? actionForm(`/admin/team/grants/${str(g.id)}/revoke`, "Revoke", { confirm: "Revoke this role grant?" })
          : raw("")}
      </td>
    </tr>`;
  });

  const invitationRows = data.invitations.map(
    (i) => html`<tr>
      <td>${str(i.email)}</td>
      <td>${badge(str(i.kind))}</td>
      <td class="small">${i.intended_role ? humanise(str(i.intended_role)) : html`<span class="muted">—</span>`}</td>
      <td>${badge(str(i.status))}</td>
      <td class="small">${str(i.expires_at).slice(0, 10)}</td>
      <td>
        ${data.canWrite && str(i.status) === "pending"
          ? actionForm(`/admin/team/invitations/${str(i.id)}/revoke`, "Revoke", { confirm: "Revoke this invitation?" })
          : raw("")}
      </td>
    </tr>`,
  );

  return html`
    ${pageHead("Team", "Staff and reviewers, and who granted them what. A role is a grant, and grants are scoped.")}
    ${data.canWrite
      ? html`<div class="grid two">
          ${card(
            html`<p class="small muted">
                The link is shown on screen as soon as you create it, so a reviewer can be provisioned without waiting for mail.
              </p>
              <form method="post" action="/admin/team/invitations" class="stack">
                ${field({ name: "email", label: "Email", type: "email", required: true })}
                ${field({ name: "full_name", label: "Name", help: "Optional — they can write their own on the way in." })}
                ${field({
                  name: "kind",
                  label: "Invitation kind",
                  type: "select",
                  required: true,
                  value: "reviewer",
                  options: INVITATION_KIND.filter((k) => k === "staff" || k === "reviewer").map((k) => ({ value: k, label: humanise(k) })),
                })}
                ${field({ name: "role", label: "Role to grant on acceptance", type: "select", required: true, value: "reviewer", options: roleOptions })}
                ${field({ name: "scope", label: "Scope", type: "select", required: true, options: data.scopeOptions })}
                ${field({ name: "expires_in_days", label: "Invitation expires in (days)", type: "number", value: 14, min: 1, max: 90 })}
                ${submitButton("Create invitation")}
              </form>`,
            "Invite by email",
          )}
          ${card(
            html`<form method="post" action="/admin/team/grants" class="stack">
              ${field({ name: "email", label: "Their email", type: "email", required: true, help: "Someone who already has a record here." })}
              ${field({ name: "role", label: "Role", type: "select", required: true, options: roleOptions })}
              ${field({ name: "scope", label: "Scope", type: "select", required: true, options: data.scopeOptions })}
              ${field({ name: "expires_at", label: "Expires", type: "date", help: "Reviewer grants often expire with the round." })}
              ${submitButton("Grant role")}
            </form>`,
            "Grant a role to someone already here",
          )}
        </div>`
      : raw("")}
    ${card(
      table(["Person", "Role", "Scope", "Granted by", "Expires", "State", ""], grantRows, "No role grants yet."),
      "Role grants",
    )}
    ${card(
      table(["Email", "Kind", "Role on acceptance", "Status", "Expires", ""], invitationRows, "No invitations have been sent."),
      "Invitations",
    )}
  `;
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/roster                                               */
/* -------------------------------------------------------------------------- */

export interface RosterPageData {
  event: EventRef;
  rows: RosterRow[];
  filters: RosterFilters;
  tracks: Row[];
  canWrite: boolean;
}

export function rosterView(d: RosterPageData): SafeHtml {
  const base = `/admin/events/${d.event.id}/roster`;
  const totals = d.rows.reduce(
    (acc, r) => {
      acc.outstanding += r.task_completion.outstanding;
      acc.overdue += r.task_completion.overdue;
      if (r.task_completion.outstanding > 0) acc.stuck++;
      return acc;
    },
    { outstanding: 0, overdue: 0, stuck: 0 },
  );

  const rows = d.rows.map((r) => {
    const c = r.task_completion;
    const total = c.completed + c.waived + c.outstanding;
    const pct = total === 0 ? 100 : Math.round(((c.completed + c.waived) / total) * 100);
    const status = str(r.participant.status) as ParticipantStatus;
    const nextStatuses = PARTICIPANT_TRANSITIONS[status] ?? [];
    return html`<tr>
      <td>
        <a href="/admin/people/${r.person_id}">${r.full_name}</a>
        <div class="small muted">${r.email}${r.company ? html` · ${r.company}` : raw("")}</div>
      </td>
      <td>${badge(str(r.participant.kind))}</td>
      <td>${badge(status)}</td>
      <td class="small">${str(r.participant.source)}</td>
      <td class="small">
        ${r.sessions.length === 0
          ? html`<span class="muted">no session yet</span>`
          : r.sessions.map((s) => html`<div><a href="/admin/events/${d.event.id}/sessions/${s.id}">${s.title}</a></div>`)}
      </td>
      <td style="min-width:9rem">
        ${total === 0
          ? html`<span class="muted small">no tasks</span>`
          : html`${progressBar(pct)}
              <div class="small muted">
                ${c.completed} done${c.waived ? html` · ${c.waived} waived` : raw("")}
                ${c.outstanding ? html` · <strong>${c.outstanding} outstanding</strong>` : raw("")}
                ${c.overdue ? html` · <span class="badge err">${c.overdue} overdue</span>` : raw("")}
              </div>`}
      </td>
      <td>${badge(str(r.participant.portal_access))}</td>
      <td class="small">
        ${d.canWrite
          ? html`<div class="row-actions">
              ${nextStatuses.length
                ? html`<form method="post" action="${base}/${str(r.participant.id)}/status" class="inline-form">
                    <select name="status">${nextStatuses.map((s) => html`<option value="${s}">${humanise(s)}</option>`)}</select>
                    <button class="small secondary" type="submit">Set</button>
                  </form>`
                : raw("")}
              ${str(r.participant.portal_access) === "none"
                ? actionForm(`${base}/${str(r.participant.id)}/portal-invite`, "Invite to portal")
                : raw("")}
              <a class="small" href="/admin/people/${r.person_id}">Open</a>
              <a class="small" href="/admin/people/${r.person_id}#notes">Note</a>
            </div>`
          : raw("")}
      </td>
    </tr>`;
  });

  return html`
    ${pageHead(
      "Speakers and roster",
      "Who is on this event's roster, and where they are up to. Roster membership is administrative; speaking is still a relationship.",
    )}
    <div class="stats">
      ${stat("on the roster", d.rows.length)}
      ${stat("with outstanding tasks", totals.stuck, `${base}?outstanding=any`)}
      ${stat("overdue tasks", totals.overdue, `${base}?outstanding=any`)}
    </div>
    ${card(
      html`<form method="get" action="${base}" class="filter-bar">
        ${field({ name: "q", label: "Search", value: d.filters.q ?? "", placeholder: "name, email or company" })}
        ${field({
          name: "status",
          label: "Status",
          type: "select",
          value: d.filters.status ?? "",
          options: PARTICIPANT_STATUS.map((s) => ({ value: s, label: humanise(s) })),
        })}
        ${field({
          name: "kind",
          label: "Kind",
          type: "select",
          value: d.filters.kind ?? "",
          options: PARTICIPANT_KIND.map((k) => ({ value: k, label: humanise(k) })),
        })}
        ${field({
          name: "track_id",
          label: "Track",
          type: "select",
          value: d.filters.track_id ?? "",
          options: d.tracks.map((t) => ({ value: str(t.id), label: str(t.name) })),
        })}
        ${field({
          name: "outstanding",
          label: "Tasks",
          type: "select",
          value: d.filters.outstanding ?? "",
          options: [
            { value: "any", label: "Something outstanding" },
            { value: "none", label: "Nothing outstanding" },
          ],
        })}
        ${submitButton("Filter", "secondary")}
      </form>`,
      "Filter",
    )}
    ${card(
      table(["Person", "Kind", "Status", "Source", "Sessions", "Onboarding", "Portal", ""], rows, "Nobody is on this roster yet."),
    )}
    ${d.canWrite
      ? card(
          html`<form method="post" action="${base}" class="stack">
              ${field({ name: "full_name", label: "Name", required: true })}
              ${field({ name: "email", label: "Email", type: "email", required: true, help: "If we already know them, this finds them rather than making a second record." })}
              ${field({
                name: "kind",
                label: "Why they are on this roster",
                type: "select",
                required: true,
                value: "speaker",
                options: PARTICIPANT_KIND.map((k) => ({ value: k, label: humanise(k) })),
              })}
              ${field({
                name: "status",
                label: "Status",
                type: "select",
                required: true,
                value: "invited",
                options: [
                  { value: "prospect", label: "Prospect" },
                  { value: "invited", label: "Invited" },
                  { value: "confirmed", label: "Confirmed" },
                ],
              })}
              ${submitButton("Add to roster")}
            </form>
            <p class="small muted">
              Have a spreadsheet? <a href="/admin/imports?subject=event_participant&event_id=${d.event.id}">Import a CSV</a> instead —
              it maps, validates and previews before writing anything.
            </p>`,
          "Add someone to this roster",
        )
      : raw("")}
  `;
}

/* -------------------------------------------------------------------------- */
/* /admin/people/:personId                                                     */
/* -------------------------------------------------------------------------- */

export interface PersonPageData {
  record: PersonRecord;
  canEditProfile: boolean;
  canWriteNotes: boolean;
  canMerge: boolean;
  events: Row[];
  segments: Row[];
  pipelines: Row[];
  cards: Row[];
}

export function personView(d: PersonPageData): SafeHtml {
  const { person, profile } = d.record;
  const visibility = parseJson<Record<string, string>>(profile.visibility, {});

  return html`
    ${pageHead(
      str(person.full_name),
      `${str(person.email)}${profile.company ? ` · ${str(profile.company)}` : ""}`,
      html`<a class="btn secondary" href="/admin/contacts">Back to contacts</a>`,
    )}
    ${bool(person.is_placeholder) ? html`<p class="notice warn">Created from a name and an email on a proposal — they have never signed in.</p>` : raw("")}
    ${person.merged_into_person_id
      ? html`<p class="notice warn">This record was merged into <a href="/admin/people/${str(person.merged_into_person_id)}">another person</a>.</p>`
      : raw("")}

    <div class="grid two">
      ${card(
        html`<dl class="kv">
          <dt>Status</dt><dd>${badge(str(person.status))}</dd>
          <dt>Display name</dt><dd>${person.display_name ? str(person.display_name) : html`<span class="muted">— falls back to the full name</span>`}</dd>
          <dt>Pronouns</dt><dd>${person.pronouns ? str(person.pronouns) : html`<span class="muted">not given</span>`}</dd>
          <dt>Timezone</dt><dd>${person.timezone ? str(person.timezone) : html`<span class="muted">unknown</span>`}</dd>
          <dt>Tags</dt><dd>${d.record.tags.length ? d.record.tags.map((t) => badge(t, "info")) : html`<span class="muted">none</span>`}</dd>
        </dl>
        ${d.canEditProfile
          ? html`<form method="post" action="/admin/people/${str(person.id)}/tags" class="stack">
              ${field({ name: "tags", label: "Org-level tags", value: d.record.tags.join(", "), help: "Comma separated. These persist across every event." })}
              ${submitButton("Save tags", "secondary")}
            </form>`
          : raw("")}`,
        "Identity",
      )}
      ${card(
        html`<div class="progress-row">${progressBar(profile.completeness)}<span class="small muted">${profile.completeness}% complete</span></div>
          ${d.canEditProfile
            ? html`<form method="post" action="/admin/people/${str(person.id)}/profile" class="stack">
                ${field({ name: "headline", label: "Headline", value: profile.headline ?? "" })}
                ${field({ name: "job_title", label: "Job title", value: profile.job_title ?? "" })}
                ${field({ name: "company", label: "Company", value: profile.company ?? "" })}
                ${field({ name: "location", label: "Location", value: profile.location ?? "" })}
                ${field({ name: "short_bio", label: "Short bio", type: "textarea", rows: 3, value: profile.short_bio ?? "" })}
                ${field({ name: "bio", label: "Bio", type: "textarea", rows: 8, value: profile.bio ?? "" })}
                <p class="notice">
                  Editing someone else's profile records you as the last editor, writes an audit row, and tells them who changed it.
                </p>
                ${submitButton("Save profile")}
              </form>`
            : raw("")}
          <h3>Consent</h3>
          <p class="small muted">
            Per-field visibility and the public listing are the speaker's consent, not the organizer's preference.
            They are read-only here; only ${str(person.full_name)} can change them, in their own portal.
          </p>
          <dl class="kv">
            <dt>Listed publicly</dt><dd>${bool(profile.is_listed) ? badge("yes", "ok") : badge("no", "warn")}</dd>
            ${Object.entries(visibility).map(([k, v]) => html`<dt>${humanise(k)}</dt><dd>${badge(v, v === "public" ? "ok" : "")}</dd>`)}
          </dl>`,
        "Speaker profile",
      )}
    </div>

    ${card(
      profile.links.length === 0
        ? empty("No links.")
        : html`<ul class="links">
            ${profile.links.map(
              (l: Row) => html`<li>
                ${badge(str(l.kind))} <a href="${str(l.url)}" rel="noopener">${l.label ? str(l.label) : str(l.url)}</a>
                ${bool(l.is_public) ? raw("") : html`<span class="small muted">(not public)</span>`}
              </li>`,
            )}
          </ul>`,
      "Links",
    )}

    ${card(
      table(
        ["Event", "Kind", "Status", "Source", "Portal", "Added"],
        d.record.participation.map(
          (p) => html`<tr>
            <td><a href="/admin/events/${p.event_id}/roster">${p.event_name}</a><div class="small muted">${p.starts_on}</div></td>
            <td>${badge(str(p.participant.kind))}</td>
            <td>${badge(str(p.participant.status))}</td>
            <td class="small">${str(p.participant.source)}</td>
            <td>${badge(str(p.participant.portal_access))}</td>
            <td class="small">${str(p.participant.created_at).slice(0, 10)}</td>
          </tr>`,
        ),
        "They are not on any event's roster.",
      ),
      "Across every event",
    )}

    ${card(
      table(
        ["Session", "Event", "Date", "Status"],
        d.record.sessions.map(
          (s) => html`<tr>
            <td><a href="/admin/events/${s.event_id}/sessions/${s.session_id}">${s.title}</a></td>
            <td>${s.event_name}</td>
            <td class="small">${s.starts_on}</td>
            <td>${badge(s.status)}</td>
          </tr>`,
        ),
        "They have not given a session yet.",
      ),
      "Sessions given",
    )}

    ${d.canWriteNotes
      ? card(
          html`<p class="small muted" id="notes">
              Internal and attributed. Notes are never visible to their subject, in any role, through any surface.
            </p>
            <form method="post" action="/admin/people/${str(person.id)}/notes" class="stack">
              ${field({ name: "body", label: "Add a note", type: "textarea", rows: 3, required: true })}
              ${field({
                name: "event_id",
                label: "About one event?",
                type: "select",
                options: d.events.map((e) => ({ value: str(e.id), label: str(e.name) })),
              })}
              ${submitButton("Add note")}
            </form>
            ${d.record.notes.length === 0
              ? empty("No notes yet.")
              : html`<ul class="notes">
                  ${d.record.notes.map(
                    (n) => html`<li>
                      <div class="small muted">
                        ${d.record.note_authors[str(n.author_person_id)] ?? "someone"} · ${str(n.created_at).slice(0, 16).replace("T", " ")}
                      </div>
                      <div>${str(n.body)}</div>
                    </li>`,
                  )}
                </ul>`}`,
          "Notes",
        )
      : raw("")}

    ${card(
      html`${d.cards.length === 0
        ? empty("Not on any sourcing board.")
        : html`<ul>
            ${d.cards.map(
              (c) => html`<li>
                <a href="/admin/pipelines/${str(c.pipeline_id)}/cards/${str(c.id)}">${str(c.pipeline_name)}</a> — ${str(c.stage_name)}
                ${c.topic ? html` · ${str(c.topic)}` : raw("")}
              </li>`,
            )}
          </ul>`}
      ${d.pipelines.length
        ? html`<form method="post" action="/admin/people/${str(person.id)}/enrol" class="inline-form">
            <select name="pipeline_id">${d.pipelines.map((p) => html`<option value="${str(p.id)}">${str(p.name)}</option>`)}</select>
            <button class="small" type="submit">Enrol on a pipeline</button>
          </form>`
        : raw("")}
      ${d.events.length
        ? html`<form method="post" action="/admin/people/${str(person.id)}/push" class="inline-form">
            <select name="event_id">${d.events.map((e) => html`<option value="${str(e.id)}">${str(e.name)}</option>`)}</select>
            <button class="small" type="submit">Add to an event</button>
          </form>`
        : raw("")}
      ${d.segments.length
        ? html`<form method="post" action="/admin/people/${str(person.id)}/segment" class="inline-form">
            <select name="segment_id">${d.segments.map((s) => html`<option value="${str(s.id)}">${str(s.name)}</option>`)}</select>
            <button class="small" type="submit">Add to a segment</button>
          </form>`
        : raw("")}`,
      "Sourcing and segments",
    )}

    ${d.canMerge ? mergeCandidatesCard(str(person.id), d.record.merge_candidates) : raw("")}
  `;
}

function mergeCandidatesCard(personId: string, candidates: MergeCandidateView[]): SafeHtml {
  return card(
    html`<p class="small muted">
        Duplicates are surfaced, never merged automatically — a wrong merge exposes one person's proposals to another.
      </p>
      ${candidates.length === 0
        ? empty("No likely duplicates.")
        : html`<ul class="candidates">
            ${candidates.map((c) => {
              const other = c.other;
              const otherId = c.person_id === personId ? c.candidate_person_id : c.person_id;
              return html`<li>
                <a href="/admin/people/${otherId}">${other ? str(other.full_name) : otherId}</a>
                <span class="small muted">${other ? str(other.email) : ""} · ${c.signals.join(", ")} · ${Math.round(c.confidence * 100)}%</span>
                <a class="small" href="/admin/people/${personId}/merge?into=${otherId}">Merge…</a>
                ${actionForm(`/admin/people/${personId}/merge-candidates/${otherId}/dismiss`, "Not a duplicate")}
              </li>`;
            })}
          </ul>`}
      <form method="post" action="/admin/people/${personId}/merge-lookup" class="inline-form">
        <input type="text" name="other" placeholder="per_… or their email">
        <button class="small secondary" type="submit">Merge into…</button>
      </form>`,
    "Possible duplicates",
  );
}

/* -------------------------------------------------------------------------- */
/* /admin/people/:personId/merge                                               */
/* -------------------------------------------------------------------------- */

export function mergeConfirmView(losing: Row, surviving: Row, impact: Record<string, number>): SafeHtml {
  const entries = Object.entries(impact);
  return html`
    ${pageHead("Confirm a merge", "Exactly what will be repointed. This is not reversible from the UI.")}
    ${card(
      html`<p class="lede">
          <strong>${str(losing.full_name)}</strong> (${str(losing.email)}) will be merged into
          <strong>${str(surviving.full_name)}</strong> (${str(surviving.email)}).
        </p>
        <p>
          The merged record keeps its row and gains a pointer; every read follows it. Nothing is deleted.
        </p>
        ${entries.length === 0
          ? empty("Nothing references the merged record yet.")
          : html`<ul>${entries.map(([label, n]) => html`<li><strong>${n}</strong> ${label}</li>`)}</ul>`}
        <form method="post" action="/admin/people/${str(losing.id)}/merge" class="stack">
          <input type="hidden" name="into" value="${str(surviving.id)}">
          ${field({
            name: "reason",
            label: "Why are these the same person?",
            type: "textarea",
            rows: 3,
            required: true,
            help: "Recorded on the audit row — merges carry a reason.",
          })}
          ${submitButton("Merge these two people")}
        </form>
        <p><a href="/admin/people/${str(losing.id)}">Cancel</a></p>`,
      "What will change",
    )}
  `;
}

/* -------------------------------------------------------------------------- */
/* /portal/profile                                                             */
/* -------------------------------------------------------------------------- */

const COMPLETENESS_ITEMS: { key: string; label: string }[] = [
  { key: "headline", label: "a one-line headline" },
  { key: "job_title", label: "your job title" },
  { key: "company", label: "your company" },
  { key: "bio", label: "a bio" },
  { key: "short_bio", label: "a short bio for the schedule card" },
  { key: "headshot_asset_id", label: "a headshot" },
  { key: "location", label: "where you are based" },
];

export function missingProfileItems(profile: Row & { links: Row[] }): string[] {
  const missing = COMPLETENESS_ITEMS.filter((i) => !profile[i.key]).map((i) => i.label);
  if (profile.links.length === 0) missing.push("at least one link");
  return missing;
}

export interface PortalProfileData {
  person: Row;
  profile: Row & { completeness: number; links: Row[] };
  lastEditedBy: string | null;
}

export function portalProfileView(d: PortalProfileData): SafeHtml {
  const visibility = parseJson<Record<string, string>>(d.profile.visibility, {});
  const missing = missingProfileItems(d.profile);
  const vis = (key: string) =>
    field({
      name: `visibility.${key}`,
      label: "Show publicly",
      type: "checkbox",
      value: visibility[key] !== "private",
      id: `vis_${key}`,
    });

  return html`
    ${pageHead("My profile", "This is what shows up next to your talk. You decide what is public.")}
    ${card(
      html`<div class="progress-row">${progressBar(num(d.profile.completeness))}<span class="small muted">${num(d.profile.completeness)}% complete</span></div>
        ${missing.length === 0
          ? html`<p class="small">Nothing missing — thank you.</p>`
          : html`<p class="small">Still missing: ${missing.join(", ")}.</p>`}
        ${d.lastEditedBy ? html`<p class="notice">Last edited by <strong>${d.lastEditedBy}</strong>. If that is not what you wanted, change it back.</p>` : raw("")}`,
      "Completeness",
    )}
    <form method="post" action="/portal/profile" enctype="multipart/form-data" class="stack">
      ${card(
        html`${field({ name: "headline", label: "Headline", value: d.profile.headline ?? "", placeholder: "Staff Engineer, Acme" })}
          ${vis("headline")}
          ${field({ name: "job_title", label: "Job title", value: d.profile.job_title ?? "" })}
          ${vis("job_title")}
          ${field({ name: "company", label: "Company", value: d.profile.company ?? "" })}
          ${vis("company")}
          ${field({ name: "location", label: "Location", value: d.profile.location ?? "", placeholder: "Berlin, Germany" })}
          ${vis("location")}
          ${field({ name: "pronouns", label: "Pronouns", value: d.person.pronouns ?? "", help: "Free text. Never inferred." })}
          ${vis("pronouns")}`,
        "About you",
      )}
      ${card(
        html`${field({ name: "short_bio", label: "Short bio", type: "textarea", rows: 3, value: d.profile.short_bio ?? "", help: "For the schedule card." })}
          ${vis("short_bio")}
          ${field({ name: "bio", label: "Bio", type: "textarea", rows: 10, value: d.profile.bio ?? "", help: "Markdown. Shown on your speaker page." })}
          ${vis("bio")}`,
        "Bio",
      )}
      ${card(
        html`${d.profile.headshot_asset_id
            ? html`<p><img class="avatar" src="${headshotUrl(str(d.profile.headshot_asset_id))}" alt="Your headshot" width="120" height="120"></p>`
            : raw("")}
          ${field({ name: "headshot", label: "Headshot", type: "file", accept: "image/jpeg,image/png,image/webp,image/avif" })}
          <p class="small muted">Uploading again never overwrites — the previous version stays stored and listed.</p>`,
        "Headshot",
      )}
      ${card(
        html`<p class="small muted">Absolute https URLs only.</p>
          ${[0, 1, 2, 3, 4].map((i) => {
            const l = d.profile.links[i] as Row | undefined;
            return html`<div class="link-row">
              ${field({
                name: "link_kind",
                label: `Link ${i + 1}`,
                type: "select",
                value: l ? str(l.kind) : "",
                options: PROFILE_LINK_KIND.map((k) => ({ value: k, label: humanise(k) })),
                id: `link_kind_${i}`,
              })}
              ${field({ name: "link_url", label: "URL", value: l ? str(l.url) : "", placeholder: "https://", id: `link_url_${i}` })}
              ${field({ name: "link_label", label: "Label", value: l && l.label ? str(l.label) : "", id: `link_label_${i}` })}
            </div>`;
          })}`,
        "Links",
      )}
      ${card(
        html`${field({
            name: "is_listed",
            label: "List me in the public speaker directory",
            type: "checkbox",
            value: bool(d.profile.is_listed),
            help: "You can opt out of the directory and still speak. Only you can change this.",
          })}
          <p class="small muted">
            Phone, dietary and accessibility notes are for logistics and never appear on any public page, whatever you set here.
          </p>
          ${field({ name: "phone", label: "Phone (logistics only)", value: d.profile.phone ?? "" })}
          ${field({ name: "dietary_notes", label: "Dietary notes (logistics only)", type: "textarea", rows: 2, value: d.profile.dietary_notes ?? "" })}
          ${field({
            name: "accessibility_notes",
            label: "Accessibility notes (logistics only)",
            type: "textarea",
            rows: 2,
            value: d.profile.accessibility_notes ?? "",
          })}`,
        "Privacy and logistics",
      )}
      ${submitButton("Save my profile")}
    </form>
  `;
}
