/**
 * Sponsorship surfaces — the admin screens and the `/v1` management endpoints.
 *
 * The screen this context exists for is
 * `GET /admin/events/:eventId/sponsorships`: every sponsor, their tier, their
 * status, and **entitlements used / total**. "The number of them is
 * contractually bounded, which is the single fact that generic CFP tools have
 * no way to express."
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { DomainError, notFound } from "@podiumstack/domain/shared/errors.js";
import { redactList, redactRecord } from "@podiumstack/domain/shared/pii.js";
import {
  ENTITLEMENT_TYPE,
  CONTACT_ROLE,
  SPONSOR_STATUS,
  type ContactRole,
  type EntitlementType,
  type SponsorStatus,
} from "@podiumstack/domain/sponsorship/types.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, progressBar, submitButton, table } from "../../ui/layout.js";
import { adminPage, loadEvent } from "../../ui/shell.js";
import { createInvitation, findOrCreatePerson, personDisplayName } from "../identity/service.js";
import {
  addSponsorContact,
  addTierTemplate,
  applyTierToSponsorship,
  cancelSponsorship,
  confirmSponsorship,
  createSponsor,
  createSponsorship,
  createTier,
  entitlementsForSponsorship,
  entitlementUsageFor,
  getEntitlement,
  getSponsor,
  getSponsorship,
  grantEntitlement,
  removeTierTemplate,
  revokeSponsorContact,
  softDeleteSponsor,
  sponsorContacts,
  sponsorshipsForEvent,
  sponsorshipUsage,
  tierTemplates,
  updateEntitlement,
  updateSponsor,
  updateSponsorship,
} from "./service.js";

const TYPE_OPTIONS = ENTITLEMENT_TYPE.map((t) => ({ value: t, label: humanise(t) }));
const ROLE_OPTIONS = CONTACT_ROLE.map((t) => ({ value: t, label: humanise(t) }));
const STATUS_OPTIONS = SPONSOR_STATUS.map((t) => ({ value: t, label: humanise(t) }));

export function registerSponsorshipRoutes(router: Router<RequestContext>): void {
  /* ---------------------------------------------------------------------- */
  /* Admin — sponsors                                                        */
  /* ---------------------------------------------------------------------- */

  router.get("/admin/sponsors", async (_req, ctx) => {
    ctx.requireRead("sponsor.manage");
    const app = ctx.app();
    const sponsors = await app.db.select<Row>("sponsor", {}, { orderBy: "name" });
    const counts = await app.db.raw<{ sponsor_id: string; n: number }>(
      "SELECT sponsor_id, COUNT(*) AS n FROM sponsorship GROUP BY sponsor_id",
      [],
    );
    const byId = new Map(counts.map((c) => [c.sponsor_id, c.n]));

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Sponsors", active: "sponsors", width: "wide" },
        html`${pageHead(
          "Sponsors",
          "Companies, carried across events. The same sponsor comes back next year — that is half the value of having events be plural.",
          html`<a class="btn" href="/admin/sponsors/new">Add a sponsor</a>`,
        )}
        ${table(
          ["Sponsor", "Slug", "Status", "Events", ""],
          sponsors.map(
            (s) => html`<tr>
              <td><a href="/admin/sponsors/${str(s.id)}"><strong>${str(s.name)}</strong></a>
                ${s.display_name ? html`<div class="small muted">shown as ${str(s.display_name)}</div>` : raw("")}</td>
              <td class="mono small">${str(s.slug)}</td>
              <td>${badge(str(s.status))}</td>
              <td>${byId.get(str(s.id)) ?? 0}</td>
              <td><a class="small" href="/admin/sponsors/${str(s.id)}">Open</a></td>
            </tr>`,
          ),
          "No sponsors yet.",
        )}`,
      ),
    );
  });

  router.get("/admin/sponsors/new", async (_req, ctx) => {
    ctx.requireWrite("sponsor.manage");
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Add a sponsor", active: "sponsors", width: "narrow" },
        html`${pageHead("Add a sponsor")}
        ${card(html`<form method="post" action="/admin/sponsors/new" class="stack">
          ${field({ name: "name", label: "Legal or trading name", required: true })}
          ${field({ name: "display_name", label: "Display name", help: "What goes on the website, if different." })}
          ${field({ name: "slug", label: "Slug", help: "Leave blank to derive it from the name." })}
          ${field({ name: "website_url", label: "Website" })}
          ${field({ name: "description", label: "Public blurb", type: "textarea", rows: 4, help: "Markdown." })}
          ${field({ name: "status", label: "Status", type: "select", required: true, value: "prospect", options: STATUS_OPTIONS })}
          ${field({ name: "internal_notes", label: "Internal notes", type: "textarea", rows: 3, help: "Organizer-only. Never public." })}
          ${submitButton("Create sponsor")}
        </form>`)}`,
      ),
    );
  });

  router.post("/admin/sponsors/new", async (req, ctx) => {
    ctx.requireWrite("sponsor.manage");
    const input = await readInput(req);
    const app = ctx.app();
    const sponsor = await createSponsor(app, {
      name: input.str("name"),
      display_name: input.optional("display_name"),
      slug: input.optional("slug"),
      website_url: input.optional("website_url"),
      description: input.optional("description"),
      internal_notes: input.optional("internal_notes"),
      status: (input.optional("status") as SponsorStatus) ?? "prospect",
    });
    await app.flush();
    return redirect(`/admin/sponsors/${str(sponsor.id)}`, 303, {
      "set-cookie": flashCookie("ok", `${str(sponsor.name)} added.`),
    });
  });

  router.get("/admin/sponsors/:sponsorId", async (_req, ctx, params) => {
    ctx.requireRead("sponsor.manage", { sponsor_id: params.sponsorId });
    const app = ctx.app();
    const sponsor = await getSponsor(app, params.sponsorId);
    const contacts = await sponsorContacts(app, params.sponsorId);
    const includePii = ctx.includePii({ sponsor_id: params.sponsorId });

    const people = new Map<string, Row>();
    for (const c of contacts) {
      const p = await app.db.byId<Row>("person", str(c.person_id));
      if (p) people.set(str(c.person_id), redactRecord("Person", p, { includePii }));
    }

    const sponsorships = await app.db.select<Row>("sponsorship", { sponsor_id: params.sponsorId }, { orderBy: "created_at DESC" });
    const rows: SafeHtml[] = [];
    for (const s of sponsorships) {
      const ev = await app.db.byId<Row>("event", str(s.event_id));
      const usage = await sponsorshipUsage(app, str(s.id));
      rows.push(html`<tr>
        <td>${ev ? html`<a href="/admin/events/${str(ev.id)}/sponsorships">${str(ev.name)}</a>` : "(deleted event)"}</td>
        <td>${badge(str(s.status))}</td>
        <td>${usage.consumed_count} / ${usage.quantity}</td>
        <td class="mono small">${strOrNull(s.contract_reference) ?? "—"}</td>
        <td><a class="small" href="/admin/sponsorships/${str(s.id)}/entitlements">Entitlements</a></td>
      </tr>`);
    }

    const accept = ctx.url.searchParams.get("accept_url");

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(sponsor.name), active: "sponsors", width: "wide" },
        html`${pageHead(str(sponsor.name), `${str(sponsor.slug)} · ${humanise(str(sponsor.status))}`)}
        ${accept
          ? card(html`<h2>Invitation created</h2>
              <p class="lede">Give this link to the contact. It is shown once and cannot be retrieved again.</p>
              <p class="mono break">${accept}</p>`)
          : raw("")}
        ${card(
          html`<form method="post" action="/admin/sponsors/${params.sponsorId}" class="stack">
            ${field({ name: "name", label: "Name", required: true, value: str(sponsor.name) })}
            ${field({ name: "display_name", label: "Display name", value: strOrNull(sponsor.display_name) ?? "" })}
            ${field({ name: "website_url", label: "Website", value: strOrNull(sponsor.website_url) ?? "" })}
            ${field({ name: "description", label: "Public blurb", type: "textarea", rows: 4, value: strOrNull(sponsor.description) ?? "" })}
            ${field({ name: "status", label: "Status", type: "select", required: true, value: str(sponsor.status), options: STATUS_OPTIONS })}
            ${field({ name: "internal_notes", label: "Internal notes", type: "textarea", rows: 3, value: strOrNull(sponsor.internal_notes) ?? "" })}
            ${submitButton("Save")}
          </form>`,
          "Details",
        )}
        ${card(
          html`${table(
            ["Person", "Role", "May submit", "Status", ""],
            contacts.map((c) => {
              const person = people.get(str(c.person_id));
              return html`<tr>
                <td>${person ? personDisplayName(person) : "(removed)"}
                  <div class="small muted">${person ? str(person.email) : ""}</div></td>
                <td>${humanise(str(c.contact_role))}</td>
                <td>${bool(c.can_submit_sessions) ? "Yes" : "No"}</td>
                <td>${badge(str(c.status))}</td>
                <td>${str(c.status) === "active"
                  ? actionForm(`/admin/sponsors/${params.sponsorId}/contacts/${str(c.id)}/revoke`, "Revoke", {
                      confirm: "Revoke this contact's access?",
                    })
                  : raw("")}</td>
              </tr>`;
            }),
            "No contacts yet.",
          )}
          <form method="post" action="/admin/sponsors/${params.sponsorId}/contacts" class="stack">
            <h3>Invite a contact</h3>
            ${field({ name: "full_name", label: "Name", required: true })}
            ${field({ name: "email", label: "Email", type: "email", required: true })}
            ${field({ name: "contact_role", label: "Role", type: "select", required: true, value: "primary", options: ROLE_OPTIONS })}
            ${field({ name: "can_submit_sessions", label: "May submit sessions", type: "checkbox", value: true })}
            ${field({ name: "can_manage_contacts", label: "May manage other contacts", type: "checkbox" })}
            ${submitButton("Invite contact")}
          </form>`,
          "Contacts",
        )}
        ${card(html`${table(["Event", "Status", "Entitlements used", "Contract", ""], rows, "No sponsorships yet.")}`, "Sponsorships")}
        ${card(
          html`<form method="post" action="/admin/sponsors/${params.sponsorId}/delete" class="stack"
                     data-confirm="Remove this sponsor?">
            ${field({ name: "reason", label: "Reason", required: true, help: "Recorded on the audit row." })}
            <button type="submit" class="danger">Remove sponsor</button>
          </form>`,
          "Remove",
        )}`,
      ),
    );
  });

  router.post("/admin/sponsors/:sponsorId", async (req, ctx, params) => {
    ctx.requireWrite("sponsor.manage", { sponsor_id: params.sponsorId });
    const input = await readInput(req);
    const app = ctx.app();
    await updateSponsor(app, params.sponsorId, {
      name: input.str("name"),
      display_name: input.optional("display_name"),
      website_url: input.optional("website_url"),
      description: input.optional("description"),
      internal_notes: input.optional("internal_notes"),
      status: (input.optional("status") as SponsorStatus) ?? undefined,
    });
    await app.flush();
    return redirect(`/admin/sponsors/${params.sponsorId}`, 303, { "set-cookie": flashCookie("ok", "Saved.") });
  });

  router.post("/admin/sponsors/:sponsorId/delete", async (req, ctx, params) => {
    ctx.requireWrite("sponsor.manage", { sponsor_id: params.sponsorId });
    const input = await readInput(req);
    const app = ctx.app();
    await softDeleteSponsor(app, params.sponsorId, input.str("reason", "removed by an organizer"));
    await app.flush();
    return redirect("/admin/sponsors", 303, { "set-cookie": flashCookie("ok", "Sponsor removed.") });
  });

  router.post("/admin/sponsors/:sponsorId/contacts", async (req, ctx, params) => {
    ctx.requireWrite("sponsor.manage", { sponsor_id: params.sponsorId });
    const input = await readInput(req);
    const app = ctx.app();
    const sponsor = await getSponsor(app, params.sponsorId);
    const person = await findOrCreatePerson(app, {
      email: input.str("email"),
      full_name: input.str("full_name"),
      status: "invited",
      source: "sponsor_contact",
    });
    await addSponsorContact(app, {
      sponsor_id: params.sponsorId,
      person_id: person.id,
      contact_role: (input.optional("contact_role") as ContactRole) ?? "primary",
      can_submit_sessions: input.bool("can_submit_sessions"),
      can_manage_contacts: input.bool("can_manage_contacts"),
    });
    // INV-01-15 — the accept_url is returned exactly once, in the response to
    // the command that created it, and is never re-readable.
    const invitation = await createInvitation(
      app,
      {
        email: input.str("email"),
        kind: "sponsor_contact",
        person_id: person.id,
        context_type: "sponsor",
        context_id: params.sponsorId,
      },
      ctx.env.PUBLIC_BASE_URL,
    );
    await app.flush();
    return redirect(
      `/admin/sponsors/${params.sponsorId}?accept_url=${encodeURIComponent(invitation.accept_url)}`,
      303,
      { "set-cookie": flashCookie("ok", `${str(sponsor.name)}: contact invited.`) },
    );
  });

  router.post("/admin/sponsors/:sponsorId/contacts/:contactId/revoke", async (_req, ctx, params) => {
    ctx.requireWrite("sponsor.manage", { sponsor_id: params.sponsorId });
    const app = ctx.app();
    await revokeSponsorContact(app, params.contactId);
    await app.flush();
    return redirect(`/admin/sponsors/${params.sponsorId}`, 303, { "set-cookie": flashCookie("ok", "Contact revoked.") });
  });

  /* ---------------------------------------------------------------------- */
  /* Admin — tiers                                                           */
  /* ---------------------------------------------------------------------- */

  router.get("/admin/events/:eventId/tiers", async (_req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireRead("sponsor.manage", { event_id: params.eventId });
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    const app = ctx.app(params.eventId);
    const tiers = await app.db.select<Row>("sponsorship_tier", { event_id: params.eventId }, { orderBy: "sort_order, level DESC" });
    const formats = await app.db.select<Row>("session_format", { event_id: params.eventId }, { orderBy: "sort_order" });

    const blocks: SafeHtml[] = [];
    for (const tier of tiers) {
      const templates = await tierTemplates(app, str(tier.id));
      blocks.push(
        card(
          html`<h2>${str(tier.name)} <span class="badge">level ${num(tier.level)}</span> ${bool(tier.is_public) ? raw("") : badge("private")}</h2>
          ${str(tier.description ?? "") ? html`<p class="muted">${str(tier.description)}</p>` : raw("")}
          ${table(
            ["Entitlement", "Quantity", "Allowed formats", ""],
            templates.map((t) => {
              const allowed = parseJson<string[]>(t.allowed_format_ids, []);
              return html`<tr>
                <td>${humanise(str(t.entitlement_type))}</td>
                <td>${num(t.quantity)}</td>
                <td class="small">${allowed.length === 0
                  ? "any"
                  : allowed.map((id) => str(formats.find((f) => str(f.id) === id)?.name ?? id)).join(", ")}</td>
                <td>${actionForm(`/admin/tier-templates/${str(t.id)}/delete`, "Remove", { confirm: "Remove this entitlement from the tier?" })}</td>
              </tr>`;
            }),
            "This tier grants nothing yet.",
          )}
          <form method="post" action="/admin/events/${params.eventId}/tiers/${str(tier.id)}/templates" class="row-form">
            ${field({ name: "entitlement_type", label: "Entitlement", type: "select", required: true, options: TYPE_OPTIONS, value: "session_slot" })}
            ${field({ name: "quantity", label: "Quantity", type: "number", required: true, value: 1, min: 0 })}
            ${field({
              name: "allowed_format_ids",
              label: "Allowed formats",
              type: "multi_select",
              help: "Leave empty for any format.",
              options: formats.map((f) => ({ value: str(f.id), label: str(f.name) })),
            })}
            ${submitButton("Add to tier", "small")}
          </form>`,
        ),
      );
    }

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Sponsorship tiers", event, active: "sponsors", width: "wide" },
        html`${pageHead(
          "Sponsorship tiers",
          "Per event, because the packages change every year. Applying a tier to a sponsorship copies these into concrete entitlements — a copy, not a reference.",
        )}
        ${blocks.length ? blocks : empty("No tiers yet.")}
        ${card(
          html`<form method="post" action="/admin/events/${params.eventId}/tiers" class="stack">
            ${field({ name: "name", label: "Tier name", required: true, placeholder: "Diamond" })}
            ${field({ name: "slug", label: "Slug", help: "Leave blank to derive it." })}
            ${field({ name: "level", label: "Level", type: "number", value: 0, help: "Higher is more prominent." })}
            ${field({ name: "description", label: "Description", type: "textarea", rows: 2 })}
            ${field({ name: "is_public", label: "Show on the sponsor wall", type: "checkbox", value: true })}
            ${submitButton("Add tier")}
          </form>`,
          "New tier",
        )}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/tiers", async (req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("sponsor.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await createTier(app, params.eventId, {
      name: input.str("name"),
      slug: input.optional("slug"),
      level: input.int("level", 0) ?? 0,
      description: input.optional("description"),
      is_public: input.bool("is_public"),
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tiers`, 303, { "set-cookie": flashCookie("ok", "Tier added.") });
  });

  router.post("/admin/events/:eventId/tiers/:tierId/templates", async (req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("sponsor.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await addTierTemplate(app, params.tierId, {
      entitlement_type: (input.str("entitlement_type") || "session_slot") as EntitlementType,
      quantity: input.int("quantity", 1) ?? 1,
      allowed_format_ids: input.list("allowed_format_ids"),
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tiers`, 303, { "set-cookie": flashCookie("ok", "Entitlement added to the tier.") });
  });

  router.post("/admin/tier-templates/:templateId/delete", async (req, ctx, params) => {
    ctx.requireWrite("sponsor.manage");
    const app = ctx.app();
    await removeTierTemplate(app, params.templateId);
    await app.flush();
    const back = req.headers.get("referer") ?? "/admin/sponsors";
    return redirect(back, 303, { "set-cookie": flashCookie("ok", "Removed.") });
  });

  /* ---------------------------------------------------------------------- */
  /* Admin — sponsorships for an event                                       */
  /* ---------------------------------------------------------------------- */

  router.get("/admin/events/:eventId/sponsorships", async (_req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireRead("sponsor.manage", { event_id: params.eventId });
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    const app = ctx.app(params.eventId);

    const rows = await sponsorshipsForEvent(app, params.eventId);
    const tiers = await app.db.select<Row>("sponsorship_tier", { event_id: params.eventId }, { orderBy: "level DESC" });
    const sponsors = await app.db.select<Row>("sponsor", {}, { orderBy: "name" });
    const taken = new Set(rows.map((r) => str(r.sponsor.id)));

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Sponsorships", event, active: "sponsors", width: "wide" },
        html`${pageHead(
          "Sponsorships",
          "Who has bought what, and how much of it they have used.",
          html`<a class="btn secondary" href="/admin/events/${params.eventId}/tiers">Manage tiers</a>`,
        )}
        ${table(
          ["Sponsor", "Tier", "Status", "Entitlements used", "Public", ""],
          rows.map(
            (r) => html`<tr>
              <td><a href="/admin/sponsors/${str(r.sponsor.id)}"><strong>${str(r.sponsor.name)}</strong></a></td>
              <td>${r.tier ? str(r.tier.name) : html`<span class="muted small">bespoke</span>`}</td>
              <td>${badge(str(r.sponsorship.status))}</td>
              <td style="min-width:12rem">
                <strong>${r.usage.consumed_count} / ${r.usage.quantity}</strong>
                ${progressBar(r.usage.quantity === 0 ? 0 : (r.usage.consumed_count / r.usage.quantity) * 100)}
                <div class="small muted">
                  ${r.usage.entitlements
                    .map((e) => `${humanise(str(e.entitlement_type))} ${e.usage.consumed_count}/${e.usage.quantity}`)
                    .join(" · ") || "none granted"}
                </div>
              </td>
              <td>${r.public_now ? badge("live") : html`<span class="muted small">no</span>`}</td>
              <td class="nowrap">
                <a class="small" href="/admin/sponsorships/${str(r.sponsorship.id)}/entitlements">Entitlements</a>
                ${str(r.sponsorship.status) === "pending"
                  ? actionForm(`/admin/sponsorships/${str(r.sponsorship.id)}/confirm`, "Confirm")
                  : raw("")}
                ${str(r.sponsorship.status) !== "cancelled"
                  ? actionForm(`/admin/sponsorships/${str(r.sponsorship.id)}/cancel`, "Cancel", {
                      confirm: "Cancel this sponsorship?",
                      hidden: { reason: "cancelled by an organizer" },
                    })
                  : raw("")}
              </td>
            </tr>`,
          ),
          "No sponsorships for this event yet.",
        )}
        ${card(
          html`<form method="post" action="/admin/events/${params.eventId}/sponsorships" class="stack">
            ${field({
              name: "sponsor_id",
              label: "Sponsor",
              type: "select",
              required: true,
              options: sponsors
                .filter((s) => !taken.has(str(s.id)))
                .map((s) => ({ value: str(s.id), label: str(s.name) })),
              help: "One sponsorship per sponsor per event.",
            })}
            ${field({
              name: "tier_id",
              label: "Tier",
              type: "select",
              options: tiers.map((t) => ({ value: str(t.id), label: str(t.name) })),
              help: "Leave blank for a bespoke deal. Choosing a tier copies its entitlements.",
            })}
            ${field({ name: "contract_reference", label: "Contract reference", help: "The id in your CRM. Money lives in that system, not this one." })}
            ${field({ name: "public_from", label: "Public from", type: "datetime-local", help: "When the logo may appear publicly." })}
            ${submitButton("Add sponsorship")}
          </form>`,
          "New sponsorship",
        )}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/sponsorships", async (req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("sponsor.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await createSponsorship(app, {
      sponsor_id: input.str("sponsor_id"),
      event_id: params.eventId,
      tier_id: input.optional("tier_id"),
      contract_reference: input.optional("contract_reference"),
      public_from: toInstant(input.optional("public_from")),
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/sponsorships`, 303, { "set-cookie": flashCookie("ok", "Sponsorship added.") });
  });

  router.post("/admin/sponsorships/:id/confirm", async (_req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    await confirmSponsorship(app, params.id);
    await app.flush();
    return redirect(`/admin/events/${str(sponsorship.event_id)}/sponsorships`, 303, {
      "set-cookie": flashCookie("ok", "Sponsorship confirmed."),
    });
  });

  router.post("/admin/sponsorships/:id/cancel", async (req, ctx, params) => {
    const input = await readInput(req);
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    await cancelSponsorship(app, params.id, input.str("reason", "cancelled by an organizer"));
    await app.flush();
    return redirect(`/admin/events/${str(sponsorship.event_id)}/sponsorships`, 303, {
      "set-cookie": flashCookie("ok", "Sponsorship cancelled."),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Admin — entitlements on one sponsorship                                 */
  /* ---------------------------------------------------------------------- */

  router.get("/admin/sponsorships/:id/entitlements", async (_req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireRead("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    const sponsor = await getSponsor(app, str(sponsorship.sponsor_id));
    const event = await loadEvent(ctx, str(sponsorship.event_id));
    const usage = await sponsorshipUsage(app, params.id);
    const formats = await app.db.select<Row>("session_format", { event_id: str(sponsorship.event_id) }, { orderBy: "sort_order" });
    const tiers = await app.db.select<Row>("sponsorship_tier", { event_id: str(sponsorship.event_id) }, { orderBy: "level DESC" });

    const holders = await app.db.raw<Row>(
      `SELECT p.id, p.reference, p.title, p.status, p.entitlement_id, p.session_id
         FROM proposal p
        WHERE p.org_id = ? AND p.deleted_at IS NULL AND p.entitlement_id IN (
              SELECT id FROM entitlement WHERE sponsorship_id = ?)
        ORDER BY p.created_at`,
      [ctx.orgId, params.id],
    );

    return htmlResponse(
      adminPage(
        ctx,
        { title: `${str(sponsor.name)} — entitlements`, event, active: "sponsors", width: "wide" },
        html`${pageHead(
          `${str(sponsor.name)} — entitlements`,
          "A countable right, granted by a contract, consumed by a submission. Consumption is a hold, not a decrement: a draft already holds a slot.",
        )}
        ${table(
          ["Type", "Used / total", "State", "Allowed formats", "Deadlines", "Source", ""],
          usage.entitlements.map((e) => {
            const allowed = parseJson<string[]>(e.allowed_format_ids, []);
            return html`<tr>
              <td><strong>${humanise(str(e.entitlement_type))}</strong>
                ${e.notes ? html`<div class="small muted">${str(e.notes)}</div>` : raw("")}</td>
              <td><strong>${e.usage.consumed_count} / ${e.usage.quantity}</strong>
                <div class="small muted">${e.usage.held_count} held · ${e.usage.spent_count} spent · ${e.usage.remaining} left</div></td>
              <td>${badge(e.usage.state, e.usage.state === "forfeited" ? "err" : e.usage.state === "spent" ? "ok" : e.usage.state === "held" ? "info" : "")}</td>
              <td class="small">${allowed.length === 0 ? "any" : allowed.map((id) => str(formats.find((f) => str(f.id) === id)?.name ?? id)).join(", ")}</td>
              <td class="small">
                ${e.submission_deadline ? html`submit by ${str(e.submission_deadline)}<br>` : raw("")}
                ${e.expires_at ? html`expires ${str(e.expires_at)}` : raw("")}
                ${!e.submission_deadline && !e.expires_at ? raw("—") : raw("")}
              </td>
              <td class="small">${humanise(str(e.source))}</td>
              <td>
                <form method="post" action="/admin/entitlements/${str(e.id)}" class="row-form">
                  ${field({ name: "quantity", label: "Qty", type: "number", value: e.usage.quantity, min: 0 })}
                  ${field({ name: "submission_deadline", label: "Submit by", type: "datetime-local", value: toLocal(strOrNull(e.submission_deadline)) })}
                  ${field({ name: "expires_at", label: "Expires", type: "datetime-local", value: toLocal(strOrNull(e.expires_at)) })}
                  ${field({ name: "reason", label: "Reason", placeholder: "Required for a quantity change" })}
                  ${submitButton("Save", "small secondary")}
                </form>
              </td>
            </tr>`;
          }),
          "Nothing granted yet.",
        )}
        ${card(
          html`${table(
            ["Reference", "Title", "Status", "Counts as"],
            holders.map(
              (p) => html`<tr>
                <td class="mono small"><a href="/admin/proposals/${str(p.id)}">${str(p.reference)}</a></td>
                <td>${str(p.title) || "Untitled"}</td>
                <td>${badge(str(p.status))}</td>
                <td>${p.session_id ? "spent" : ["withdrawn", "rejected", "expired"].includes(str(p.status)) ? "released" : "held"}</td>
              </tr>`,
            ),
            "No proposals against these entitlements yet.",
          )}`,
          "What is consuming them",
        )}
        ${card(
          html`<form method="post" action="/admin/sponsorships/${params.id}/entitlements" class="stack">
            ${field({ name: "entitlement_type", label: "Entitlement", type: "select", required: true, options: TYPE_OPTIONS, value: "session_slot" })}
            ${field({ name: "quantity", label: "Quantity", type: "number", required: true, value: 1, min: 0 })}
            ${field({
              name: "allowed_format_ids",
              label: "Allowed formats",
              type: "multi_select",
              options: formats.map((f) => ({ value: str(f.id), label: str(f.name) })),
              help: "Empty means any format.",
            })}
            ${field({ name: "submission_deadline", label: "Submission deadline", type: "datetime-local", help: "Usually later than the CFP." })}
            ${field({ name: "expires_at", label: "Expires at", type: "datetime-local", help: "Unspent after this is forfeited — a nudge, not a hard delete." })}
            ${field({ name: "notes", label: "Notes", help: "So “why does Acme have three slots?” is answerable." })}
            ${submitButton("Grant entitlement")}
          </form>`,
          "Grant another",
        )}
        ${tiers.length
          ? card(
              html`<form method="post" action="/admin/sponsorships/${params.id}/apply-tier" class="row-form">
                ${field({ name: "tier_id", label: "Tier", type: "select", required: true, options: tiers.map((t) => ({ value: str(t.id), label: str(t.name) })), value: strOrNull(sponsorship.tier_id) ?? "" })}
                ${submitButton("Copy the tier's entitlements", "secondary")}
              </form>`,
              "Apply a tier",
            )
          : raw("")}`,
      ),
    );
  });

  router.post("/admin/sponsorships/:id/entitlements", async (req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    const input = await readInput(req);
    await grantEntitlement(app, params.id, {
      entitlement_type: (input.str("entitlement_type") || "session_slot") as EntitlementType,
      quantity: input.int("quantity", 1) ?? 1,
      allowed_format_ids: input.list("allowed_format_ids"),
      submission_deadline: toInstant(input.optional("submission_deadline")),
      expires_at: toInstant(input.optional("expires_at")),
      notes: input.optional("notes"),
      source: "manual",
    });
    await app.flush();
    return redirect(`/admin/sponsorships/${params.id}/entitlements`, 303, { "set-cookie": flashCookie("ok", "Entitlement granted.") });
  });

  router.post("/admin/sponsorships/:id/apply-tier", async (req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id) });
    const input = await readInput(req);
    const created = await applyTierToSponsorship(app, params.id, input.str("tier_id"));
    await app.flush();
    return redirect(`/admin/sponsorships/${params.id}/entitlements`, 303, {
      "set-cookie": flashCookie("ok", `${created.length} entitlement${created.length === 1 ? "" : "s"} copied from the tier.`),
    });
  });

  router.post("/admin/entitlements/:entitlementId", async (req, ctx, params) => {
    const app = ctx.app();
    const entitlement = await getEntitlement(app, params.entitlementId);
    const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    const input = await readInput(req);
    const quantity = input.int("quantity", null);
    if (quantity !== null && quantity !== num(entitlement.quantity) && !input.optional("reason")) {
      // 11-cross-cutting.md: an entitlement quantity change must be audited,
      // and overrides carry a reason (INV-11-5).
      throw new DomainError({
        code: "reason_required",
        message: "Changing an entitlement's quantity needs a reason for the audit log.",
        status: 422,
        invariant: "INV-11-5",
      });
    }
    await updateEntitlement(
      app,
      params.entitlementId,
      {
        quantity: quantity ?? undefined,
        submission_deadline: toInstant(input.optional("submission_deadline")),
        expires_at: toInstant(input.optional("expires_at")),
      },
      input.optional("reason"),
    );
    await app.flush();
    return redirect(`/admin/sponsorships/${str(entitlement.sponsorship_id)}/entitlements`, 303, {
      "set-cookie": flashCookie("ok", "Entitlement updated."),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Management API — /v1                                                    */
  /* ---------------------------------------------------------------------- */

  router.get("/v1/sponsors", async (_req, ctx) => {
    ctx.requireRead("sponsor.manage");
    const app = ctx.app();
    const limit = Math.min(200, Number(ctx.url.searchParams.get("limit") ?? 50));
    const cursor = ctx.url.searchParams.get("cursor");
    const rows = await app.db.raw<Row>(
      `SELECT * FROM sponsor WHERE org_id = ? AND deleted_at IS NULL ${cursor ? "AND id > ?" : ""} ORDER BY id LIMIT ?`,
      cursor ? [ctx.orgId, cursor, limit + 1] : [ctx.orgId, limit + 1],
    );
    const page = rows.slice(0, limit);
    return json({
      data: page.map(sponsorResource),
      next_cursor: rows.length > limit ? str(page[page.length - 1]?.id) : null,
    });
  });

  router.post("/v1/sponsors", async (req, ctx) => {
    ctx.requireWrite("sponsor.manage");
    const input = await readInput(req);
    const app = ctx.app();
    const sponsor = await createSponsor(app, {
      name: input.str("name"),
      display_name: input.optional("display_name"),
      slug: input.optional("slug"),
      website_url: input.optional("website_url"),
      description: input.optional("description"),
      status: (input.optional("status") as SponsorStatus) ?? undefined,
    });
    await app.flush();
    return json(sponsorResource(sponsor), { status: 201 });
  });

  router.get("/v1/sponsors/:sponsorId", async (_req, ctx, params) => {
    ctx.requireRead("sponsor.manage", { sponsor_id: params.sponsorId });
    const app = ctx.app();
    const sponsor = await getSponsor(app, params.sponsorId);
    const contacts = await sponsorContacts(app, params.sponsorId);
    const includePii = ctx.includePii({ sponsor_id: params.sponsorId });
    const people: Row[] = [];
    for (const c of contacts) {
      const p = await app.db.byId<Row>("person", str(c.person_id));
      if (p) people.push({ ...p, contact_role: c.contact_role, contact_status: c.status });
    }
    return json({
      ...sponsorResource(sponsor),
      // `Person.email` is PII; redaction is default-on (INV-09-5 / INV-11-4).
      contacts: redactList("Person", people, { includePii }).map((p) => ({
        person_id: str(p.id),
        full_name: str(p.full_name),
        email: p.email,
        contact_role: str(p.contact_role),
        status: str(p.contact_status),
      })),
    });
  });

  router.patch("/v1/sponsors/:sponsorId", async (req, ctx, params) => {
    ctx.requireWrite("sponsor.manage", { sponsor_id: params.sponsorId });
    const input = await readInput(req);
    const app = ctx.app();
    await updateSponsor(app, params.sponsorId, input.all() as Record<string, never>);
    await app.flush();
    return json(sponsorResource(await getSponsor(app, params.sponsorId)));
  });

  router.get("/v1/sponsorships", async (_req, ctx) => {
    ctx.requireRead("sponsor.manage");
    const app = ctx.app();
    const eventId = ctx.url.searchParams.get("event_id");
    if (!eventId) throw new DomainError({ code: "event_id_required", message: "Pass ?event_id=", status: 400 });
    ctx.eventId = eventId;
    ctx.requireRead("sponsor.manage", { event_id: eventId });
    const rows = await sponsorshipsForEvent(app, eventId);
    return json({
      data: rows.map((r) => ({
        ...sponsorshipResource(r.sponsorship),
        sponsor: { id: str(r.sponsor.id), name: str(r.sponsor.name), slug: str(r.sponsor.slug) },
        tier: r.tier ? { id: str(r.tier.id), name: str(r.tier.name), level: num(r.tier.level) } : null,
        entitlement_summary: { quantity: r.usage.quantity, consumed_count: r.usage.consumed_count, remaining: r.usage.remaining },
        public_now: r.public_now,
      })),
      next_cursor: null,
    });
  });

  router.post("/v1/sponsorships", async (req, ctx) => {
    const input = await readInput(req);
    const eventId = input.str("event_id");
    ctx.eventId = eventId;
    ctx.requireWrite("sponsor.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const sponsorship = await createSponsorship(app, {
      sponsor_id: input.str("sponsor_id"),
      event_id: eventId,
      tier_id: input.optional("tier_id"),
      contract_reference: input.optional("contract_reference"),
      public_from: input.optional("public_from"),
    });
    await app.flush();
    return json(sponsorshipResource(sponsorship), { status: 201 });
  });

  router.get("/v1/sponsorships/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireRead("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    const usage = await sponsorshipUsage(app, params.id);
    return json({
      ...sponsorshipResource(sponsorship),
      entitlements: usage.entitlements.map(entitlementResource),
      entitlement_summary: { quantity: usage.quantity, consumed_count: usage.consumed_count, remaining: usage.remaining },
    });
  });

  router.patch("/v1/sponsorships/:id", async (req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id) });
    const input = await readInput(req);
    await updateSponsorship(app, params.id, {
      contract_reference: input.optional("contract_reference"),
      public_from: input.optional("public_from"),
      internal_notes: input.optional("internal_notes"),
      sort_order_override: input.int("sort_order_override", null),
    });
    await app.flush();
    return json(sponsorshipResource(await getSponsorship(app, params.id)));
  });

  router.post("/v1/sponsorships/:id/confirm", async (_req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id) });
    await confirmSponsorship(app, params.id);
    await app.flush();
    return json(sponsorshipResource(await getSponsorship(app, params.id)));
  });

  router.post("/v1/sponsorships/:id/cancel", async (req, ctx, params) => {
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, params.id);
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id) });
    const input = await readInput(req);
    await cancelSponsorship(app, params.id, input.str("reason", "cancelled via API"));
    await app.flush();
    return json(sponsorshipResource(await getSponsorship(app, params.id)));
  });

  router.get("/v1/entitlements", async (_req, ctx) => {
    ctx.requireRead("sponsor.manage");
    const app = ctx.app();
    const sponsorshipId = ctx.url.searchParams.get("sponsorship_id");
    const eventId = ctx.url.searchParams.get("event_id");
    const rows = sponsorshipId
      ? await entitlementsForSponsorship(app, sponsorshipId)
      : await app.db.raw<Row>(
          `SELECT en.* FROM entitlement en JOIN sponsorship sp ON sp.id = en.sponsorship_id
            JOIN sponsor s ON s.id = sp.sponsor_id AND s.org_id = ? AND s.deleted_at IS NULL
            ${eventId ? "WHERE sp.event_id = ?" : ""} ORDER BY en.id`,
          eventId ? [ctx.orgId, eventId] : [ctx.orgId],
        );
    const usage = await entitlementUsageFor(app, rows);
    return json({
      data: rows.map((r) => entitlementResource({ ...r, usage: usage.get(str(r.id))! })),
      next_cursor: null,
    });
  });

  router.get("/v1/entitlements/:entitlementId", async (_req, ctx, params) => {
    const app = ctx.app();
    const entitlement = await getEntitlement(app, params.entitlementId);
    const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireRead("sponsor.manage", { event_id: str(sponsorship.event_id), sponsor_id: str(sponsorship.sponsor_id) });
    const usage = await entitlementUsageFor(app, [entitlement]);
    return json(entitlementResource({ ...entitlement, usage: usage.get(params.entitlementId)! }));
  });

  router.post("/v1/entitlements", async (req, ctx) => {
    const input = await readInput(req);
    const app = ctx.app();
    const sponsorship = await getSponsorship(app, input.str("sponsorship_id"));
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id) });
    const row = await grantEntitlement(app, str(sponsorship.id), {
      entitlement_type: (input.str("entitlement_type") || "session_slot") as EntitlementType,
      quantity: input.int("quantity", 1) ?? 1,
      allowed_format_ids: input.list("allowed_format_ids"),
      submission_deadline: input.optional("submission_deadline"),
      expires_at: input.optional("expires_at"),
      notes: input.optional("notes"),
      source: "manual",
    });
    await app.flush();
    const usage = await entitlementUsageFor(app, [row]);
    return json(entitlementResource({ ...row, usage: usage.get(str(row.id))! }), { status: 201 });
  });

  router.patch("/v1/entitlements/:entitlementId", async (req, ctx, params) => {
    const app = ctx.app();
    const entitlement = await getEntitlement(app, params.entitlementId);
    const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
    ctx.eventId = str(sponsorship.event_id);
    ctx.requireWrite("sponsor.manage", { event_id: str(sponsorship.event_id) });
    const input = await readInput(req);
    if (input.has("consumed_count") || input.has("remaining")) {
      // INV-11-6 — derived fields are never writable through any API.
      throw new DomainError({
        code: "derived_field_not_writable",
        message: "consumed_count and remaining are derived from the proposals holding this entitlement.",
        status: 422,
        invariant: "INV-11-6",
      });
    }
    await updateEntitlement(
      app,
      params.entitlementId,
      {
        quantity: input.int("quantity", null) ?? undefined,
        allowed_format_ids: input.has("allowed_format_ids") ? input.list("allowed_format_ids") : undefined,
        submission_deadline: input.has("submission_deadline") ? input.optional("submission_deadline") : undefined,
        expires_at: input.has("expires_at") ? input.optional("expires_at") : undefined,
        notes: input.has("notes") ? input.optional("notes") : undefined,
      },
      input.optional("reason"),
    );
    await app.flush();
    const updated = await getEntitlement(app, params.entitlementId);
    const usage = await entitlementUsageFor(app, [updated]);
    return json(entitlementResource({ ...updated, usage: usage.get(params.entitlementId)! }));
  });
}

/* -------------------------------------------------------------------------- */
/* Resources                                                                   */
/* -------------------------------------------------------------------------- */

function sponsorResource(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    name: str(row.name),
    display_name: strOrNull(row.display_name),
    slug: str(row.slug),
    website_url: strOrNull(row.website_url),
    description: strOrNull(row.description),
    industry_tags: parseJson<string[]>(row.industry_tags, []),
    status: str(row.status),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function sponsorshipResource(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    sponsor_id: str(row.sponsor_id),
    event_id: str(row.event_id),
    tier_id: strOrNull(row.tier_id),
    status: str(row.status),
    confirmed_at: strOrNull(row.confirmed_at),
    contract_reference: strOrNull(row.contract_reference),
    public_from: strOrNull(row.public_from),
    sort_order_override: row.sort_order_override === null ? null : num(row.sort_order_override),
  };
}

function entitlementResource(row: Row & { usage?: { quantity: number; consumed_count: number; remaining: number; state: string } }): Record<string, unknown> {
  return {
    id: str(row.id),
    sponsorship_id: str(row.sponsorship_id),
    entitlement_type: str(row.entitlement_type),
    quantity: num(row.quantity),
    // Derived — computed at read time, never stored, never writable (INV-11-6).
    consumed_count: row.usage?.consumed_count ?? 0,
    remaining: row.usage?.remaining ?? num(row.quantity),
    state: row.usage?.state ?? "available",
    allowed_format_ids: parseJson<string[]>(row.allowed_format_ids, []),
    constraints: parseJson<Record<string, unknown> | null>(row.constraints, null),
    submission_deadline: strOrNull(row.submission_deadline),
    expires_at: strOrNull(row.expires_at),
    source: str(row.source),
    notes: strOrNull(row.notes),
  };
}

/** `datetime-local` inputs post `YYYY-MM-DDTHH:MM`; instants are stored UTC. */
function toInstant(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value.length === 16 ? `${value}:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toLocal(instant: string | null): string {
  return instant ? instant.slice(0, 16) : "";
}
