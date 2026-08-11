/**
 * Identity & Access — the admin and portal surfaces.
 *
 * `/admin/team` (role grants and invitations), `/admin/events/:eventId/roster`
 * (the `EventRoster` read model), `/admin/people/:personId` (the person record,
 * merge included) and `/portal/profile` (the speaker's own profile, which is
 * the only place `visibility` and `is_listed` can be changed — INV-01-13).
 *
 * Sign-in lives in `auth-routes.ts`.
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { DEFAULT_PROFILE_VISIBILITY, isAbsoluteHttps, normaliseEmail } from "@podiumconf/domain/identity/types.js";
import type { ParticipantKind, ParticipantSource, ParticipantStatus } from "@podiumconf/domain/identity/types.js";
import { DomainError, forbidden, invariantError, notFound, validationError } from "@podiumconf/domain/shared/errors.js";
import { redactList, redactRecord } from "@podiumconf/domain/shared/pii.js";
import type { Role, ScopeType } from "@podiumconf/domain/shared/authorization.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html } from "../../ui/html.js";
import { adminPage, loadEvent, portalPage } from "../../ui/shell.js";
import { pageOf, pageRequest } from "./listing.js";
import {
  acceptUrlPanel,
  mergeConfirmView,
  personView,
  portalProfileView,
  rosterView,
  teamView,
  type ScopeOption,
} from "./views.js";
import {
  addParticipant,
  addPersonNote,
  createInvitation,
  dismissMergeCandidate,
  eventRoster,
  findOrCreatePerson,
  getOrCreateProfile,
  getPerson,
  grantRole,
  invitePortalAccess,
  listInvitations,
  listPersonNotes,
  listTeam,
  mergeImpact,
  mergePeople,
  personDisplayName,
  profileWithCompleteness,
  replaceProfileLinks,
  revokeInvitation,
  revokeRole,
  setParticipantStatus,
  setPersonTags,
  storeHeadshot,
  updateProfile,
  type PersonRow,
  type RosterFilters,
} from "./service.js";
// The person record is a shared admin screen: Identity owns the record, the
// Speaker CRM owns the segments and boards shown alongside it. The dependency
// runs one way (crm/service → identity/service), so reading it here is not a
// cycle.
import { cardsForPerson, listSegments, listPipelines } from "../crm/service.js";

const VISIBILITY_KEYS = Object.keys(DEFAULT_PROFILE_VISIBILITY);

export function registerIdentityRoutes(router: Router<RequestContext>): void {
  registerTeamRoutes(router);
  registerRosterRoutes(router);
  registerPersonRoutes(router);
  registerPortalProfileRoutes(router);
  registerManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* /admin/team                                                                 */
/* -------------------------------------------------------------------------- */

async function scopeOptions(ctx: RequestContext): Promise<ScopeOption[]> {
  const app = ctx.app();
  const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
  const options: ScopeOption[] = [{ value: `org:${ctx.orgId}`, label: "The whole organization" }];
  for (const e of events) {
    options.push({ value: `event:${str(e.id)}`, label: `Event · ${str(e.name)}` });
    const tracks = await app.db.select<Row>("track", { event_id: str(e.id) }, { orderBy: "sort_order" });
    for (const t of tracks) options.push({ value: `track:${str(t.id)}`, label: `Track · ${str(e.name)} → ${str(t.name)}` });
  }
  return options;
}

function parseScope(raw: string): { scope_type: ScopeType; scope_id: string } {
  const [type, id] = raw.split(":");
  if (type !== "org" && type !== "event" && type !== "track") {
    throw validationError("Choose a scope for this role.", [{ field_key: "scope", message: "Pick an organization, event or track." }]);
  }
  if (!id) throw validationError("Choose a scope for this role.", [{ field_key: "scope", message: "Pick an organization, event or track." }]);
  return { scope_type: type, scope_id: id };
}

/**
 * Who may hand out which role. `owner` and `admin` are org configuration;
 * staffing an event with chairs, organizers and reviewers is part of
 * configuring that event, which is the row `program_chair` holds.
 */
function requireGrantPermission(ctx: RequestContext, role: Role, scope: { scope_type: ScopeType; scope_id: string }): void {
  if (role === "owner" || role === "admin" || scope.scope_type === "org") {
    ctx.requireWrite("org.configure");
    return;
  }
  ctx.requireWrite("event.configure", { event_id: scope.scope_type === "event" ? scope.scope_id : ctx.eventId, track_id: scope.scope_type === "track" ? scope.scope_id : null });
}

function registerTeamRoutes(router: Router<RequestContext>): void {
  router.get("/admin/team", async (_req, ctx) => {
    if (!ctx.isStaff()) throw forbidden("The team screen is for event staff.");
    const app = ctx.app();
    const [team, invitations, options] = await Promise.all([listTeam(app), listInvitations(app), scopeOptions(ctx)]);
    const includePii = ctx.includePii();
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Team", active: "team" },
        teamView({
          rows: team.rows.map((r) => ({
            ...r,
            // INV-11-4: `Person.email` and `Invitation.email` are redacted
            // without `pii:read`.
            person: r.person ? (redactRecord("Person", r.person as Row, { includePii }) as PersonRow) : null,
            granted_by: r.granted_by,
          })),
          scopeNames: team.scopeNames,
          invitations: redactList("Invitation", invitations, { includePii }),
          scopeOptions: options,
          now: ctx.now,
          canWrite: ctx.canWrite("org.configure") || ctx.canWrite("event.configure"),
        }),
      ),
    );
  });

  router.post("/admin/team/grants", async (req, ctx) => {
    const input = await readInput(req);
    const scope = parseScope(input.str("scope"));
    const role = input.str("role") as Role;
    requireGrantPermission(ctx, role, scope);
    const app = ctx.app();
    const email = normaliseEmail(input.str("email"));
    const existing = await app.db.first<PersonRow>("person", { email });
    if (!existing) {
      throw validationError("Nobody here has that email — invite them instead.", [
        { field_key: "email", message: "No person with that email. Use the invitation form." },
      ]);
    }
    const person = await getPerson(app, existing.id);
    await grantRole(app, {
      person_id: person.id,
      role,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      expires_at: input.optional("expires_at"),
    });
    await app.flush();
    return redirect("/admin/team", 303, { "set-cookie": flashCookie("ok", `${personDisplayName(person)} is now a ${role}.`) });
  });

  router.post("/admin/team/invitations", async (req, ctx) => {
    const input = await readInput(req);
    const scope = parseScope(input.str("scope"));
    const role = input.str("role") as Role;
    requireGrantPermission(ctx, role, scope);
    const kind = input.str("kind", "reviewer");
    if (kind !== "staff" && kind !== "reviewer") {
      throw validationError("The team screen invites staff and reviewers.", [{ field_key: "kind", message: "Choose staff or reviewer." }]);
    }
    const app = ctx.app();
    const email = normaliseEmail(input.str("email"));
    if (!email.includes("@")) {
      throw validationError("That is not an email address.", [{ field_key: "email", message: "Enter an email address." }]);
    }
    const existing = await app.db.first<PersonRow>("person", { email });
    const person = existing
      ? await getPerson(app, existing.id)
      : await findOrCreatePerson(app, { email, full_name: input.str("full_name") || email, status: "invited", source: "invitation" });

    const invitation = await createInvitation(
      app,
      {
        email,
        kind,
        person_id: person.id,
        intended_role: role,
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        expires_in_days: num(input.int("expires_in_days", 14), 14),
      },
      ctx.env.PUBLIC_BASE_URL || ctx.url.origin,
    );
    await app.flush();
    // INV-01-15: rendered, not redirected to — the link is returned exactly
    // once, in the response to the command that created it.
    return htmlResponse(
      adminPage(ctx, { title: "Invitation created", active: "team" }, acceptUrlPanel(invitation.accept_url, invitation.email, "/admin/team")),
    );
  });

  router.post("/admin/team/grants/:grantId/revoke", async (_req, ctx, params) => {
    const app = ctx.app();
    const grant = await app.db.byId<Row>("role_grant", params.grantId);
    if (!grant) throw notFound("Role grant", params.grantId);
    requireGrantPermission(ctx, str(grant.role) as Role, {
      scope_type: str(grant.scope_type) as ScopeType,
      scope_id: str(grant.scope_id),
    });
    await revokeRole(app, params.grantId);
    await app.flush();
    return redirect("/admin/team", 303, { "set-cookie": flashCookie("ok", "Role revoked.") });
  });

  router.post("/admin/team/invitations/:invitationId/revoke", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    await revokeInvitation(app, params.invitationId);
    await app.flush();
    return redirect("/admin/team", 303, { "set-cookie": flashCookie("ok", "Invitation revoked.") });
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/events/:eventId/roster                                               */
/* -------------------------------------------------------------------------- */

function rosterFiltersFrom(url: URL): RosterFilters {
  const outstanding = url.searchParams.get("outstanding");
  return {
    q: url.searchParams.get("q"),
    status: url.searchParams.get("status"),
    kind: url.searchParams.get("kind"),
    track_id: url.searchParams.get("track_id"),
    outstanding: outstanding === "any" || outstanding === "none" ? outstanding : null,
  };
}

function registerRosterRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/roster", async (_req, ctx, params) => {
    ctx.eventId = params.eventId;
    const event = await loadEvent(ctx, params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    ctx.eventId = event.id;
    ctx.requireRead("roster.manage", { event_id: event.id });
    const app = ctx.app(event.id);
    const filters = rosterFiltersFrom(ctx.url);
    const [rows, tracks] = await Promise.all([
      eventRoster(app, event.id, filters),
      app.db.select<Row>("track", { event_id: event.id }, { orderBy: "sort_order" }),
    ]);
    const includePii = ctx.includePii({ event_id: event.id });
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Roster · ${event.name}`, event, active: "roster", width: "wide" },
        rosterView({
          event,
          rows: rows.map((r) => ({ ...r, email: includePii ? r.email : "[redacted]" })),
          filters,
          tracks,
          canWrite: ctx.canWrite("roster.manage", { event_id: event.id }),
        }),
      ),
    );
  });

  router.post("/admin/events/:eventId/roster", async (req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("roster.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const person = await findOrCreatePerson(app, {
      email: input.str("email"),
      full_name: input.str("full_name"),
      status: "invited",
      is_placeholder: !input.str("full_name"),
      source: "roster",
    });
    await addParticipant(app, {
      event_id: params.eventId,
      person_id: person.id,
      kind: (input.str("kind", "speaker") || "speaker") as ParticipantKind,
      status: (input.str("status", "invited") || "invited") as ParticipantStatus,
      source: "manual",
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/roster`, 303, {
      "set-cookie": flashCookie("ok", `${personDisplayName(person)} is on the roster.`),
    });
  });

  router.post("/admin/events/:eventId/roster/:participantId/status", async (req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("roster.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await setParticipantStatus(app, params.participantId, input.str("status") as ParticipantStatus);
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/roster`, 303, { "set-cookie": flashCookie("ok", "Roster status updated.") });
  });

  router.post("/admin/events/:eventId/roster/:participantId/portal-invite", async (_req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("roster.manage", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const invitation = await invitePortalAccess(app, params.participantId, ctx.env.PUBLIC_BASE_URL || ctx.url.origin);
    await app.flush();
    const event = await loadEvent(ctx, params.eventId);
    // INV-01-15 again: every invitation kind offers the link on screen.
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Portal invitation", event, active: "roster" },
        acceptUrlPanel(invitation.accept_url, invitation.email, `/admin/events/${params.eventId}/roster`),
      ),
    );
  });

  router.post("/admin/events/:eventId/roster/:participantId/note", async (req, ctx, params) => {
    ctx.eventId = params.eventId;
    ctx.requireWrite("person_note.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const participant = await app.db.byId<Row>("event_participant", params.participantId);
    if (!participant) throw notFound("Participant", params.participantId);
    await addPersonNote(app, { person_id: str(participant.person_id), event_id: params.eventId, body: input.str("body") });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/roster`, 303, { "set-cookie": flashCookie("ok", "Note added.") });
  });
}

/* -------------------------------------------------------------------------- */
/* /admin/people/:personId                                                     */
/* -------------------------------------------------------------------------- */

function registerPersonRoutes(router: Router<RequestContext>): void {
  router.get("/admin/people/:personId/merge", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const into = ctx.url.searchParams.get("into") ?? "";
    const losing = await getPerson(app, params.personId);
    const surviving = await getPerson(app, into);
    const impact = await mergeImpact(app, losing.id);
    return htmlResponse(adminPage(ctx, { title: "Confirm a merge", active: "contacts", width: "narrow" }, mergeConfirmView(losing, surviving, impact)));
  });

  router.get("/admin/people/:personId", async (_req, ctx, params) => {
    if (!ctx.isStaff()) throw forbidden("Person records are for event staff.");
    const app = ctx.app();
    const { personRecord } = await import("./service.js");
    const record = await personRecord(app, params.personId);
    const [events, segments, pipelines, cards] = await Promise.all([
      app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" }),
      listSegments(app),
      listPipelines(app, { status: "active" }),
      cardsForPerson(app, record.person.id),
    ]);
    const includePii = ctx.includePii();
    return htmlResponse(
      adminPage(
        ctx,
        { title: str(record.person.full_name), active: "contacts", width: "wide" },
        personView({
          record: { ...record, person: redactRecord("Person", record.person as Row, { includePii }) as PersonRow },
          canEditProfile: ctx.canWrite("speaker_profile.edit"),
          canWriteNotes: ctx.canRead("person_note.manage") && ctx.person?.id !== record.person.id,
          canMerge: ctx.canWrite("org.configure"),
          events,
          segments,
          pipelines,
          cards,
        }),
      ),
    );
  });

  router.post("/admin/people/:personId/profile", async (req, ctx, params) => {
    ctx.requireWrite("speaker_profile.edit");
    const input = await readInput(req);
    const app = ctx.app();
    const patch: Record<string, unknown> = {};
    for (const f of ["headline", "job_title", "company", "bio", "short_bio", "location"]) {
      if (input.has(f)) patch[f] = input.optional(f);
    }
    // Forwarded deliberately: if a caller tries to set consent fields here,
    // INV-01-13 must refuse rather than silently drop them.
    if (input.has("visibility")) patch.visibility = input.json<Record<string, string>>("visibility", {});
    if (input.has("is_listed")) patch.is_listed = input.bool("is_listed");
    await updateProfile(app, params.personId, patch, { isOwner: ctx.person?.id === params.personId, editedByRole: "organizer" });
    await app.flush();
    return redirect(`/admin/people/${params.personId}`, 303, { "set-cookie": flashCookie("ok", "Profile updated. They will see who changed it.") });
  });

  router.post("/admin/people/:personId/tags", async (req, ctx, params) => {
    ctx.requireWrite("speaker_profile.edit");
    const input = await readInput(req);
    const app = ctx.app();
    await setPersonTags(
      app,
      params.personId,
      input.str("tags").split(",").map((t) => t.trim()).filter(Boolean),
    );
    await app.flush();
    return redirect(`/admin/people/${params.personId}`, 303, { "set-cookie": flashCookie("ok", "Tags saved.") });
  });

  router.post("/admin/people/:personId/notes", async (req, ctx, params) => {
    ctx.requireWrite("person_note.manage");
    const input = await readInput(req);
    const app = ctx.app();
    await addPersonNote(app, { person_id: params.personId, event_id: input.optional("event_id"), body: input.str("body") });
    await app.flush();
    return redirect(`/admin/people/${params.personId}#notes`, 303, { "set-cookie": flashCookie("ok", "Note added.") });
  });

  router.post("/admin/people/:personId/merge-candidates/:otherId/dismiss", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    await dismissMergeCandidate(app, params.personId, params.otherId);
    await app.flush();
    return redirect(`/admin/people/${params.personId}`, 303, { "set-cookie": flashCookie("ok", "Dismissed — that pair will not be offered again.") });
  });

  router.post("/admin/people/:personId/merge-lookup", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const raw = input.str("other");
    const other = raw.includes("@") ? await app.db.first<PersonRow>("person", { email: normaliseEmail(raw) }) : await app.db.byId<PersonRow>("person", raw);
    if (!other) throw notFound("Person", raw);
    return redirect(`/admin/people/${params.personId}/merge?into=${other.id}`, 303);
  });

  router.post("/admin/people/:personId/merge", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const reason = input.str("reason");
    if (!reason) {
      // INV-11-5: merges carry a reason.
      throw validationError("A merge needs a reason.", [{ field_key: "reason", message: "Say why these are the same person." }]);
    }
    const app = ctx.app();
    await mergePeople(app, input.str("into"), params.personId, reason);
    await app.flush();
    return redirect(`/admin/people/${input.str("into")}`, 303, { "set-cookie": flashCookie("ok", "Merged. Reads now follow the pointer.") });
  });

  router.post("/admin/people/:personId/deactivate", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    await deactivate(app, params.personId, input.str("reason", "no reason given"));
    await app.flush();
    return redirect(`/admin/people/${params.personId}`, 303, { "set-cookie": flashCookie("ok", "Deactivated.") });
  });
}

async function deactivate(app: ReturnType<RequestContext["app"]>, personId: string, reason: string): Promise<void> {
  const { deactivatePerson } = await import("./service.js");
  await deactivatePerson(app, personId, reason);
}

/* -------------------------------------------------------------------------- */
/* /portal/profile                                                             */
/* -------------------------------------------------------------------------- */

function linksFrom(input: Input): { kind: string; url: string; label: string | null; is_public: boolean }[] {
  const kinds = input.list("link_kind");
  const urls = input.list("link_url");
  const labels = input.list("link_label");
  const out: { kind: string; url: string; label: string | null; is_public: boolean }[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = (urls[i] ?? "").trim();
    if (!url) continue;
    // INV-01-5 is enforced again in the service; failing here gives the form a
    // field-level error instead of a page-level one.
    if (!isAbsoluteHttps(url)) {
      throw invariantError("INV-01-5", "invalid_profile_link", `"${url}" must be an absolute https URL.`, { url });
    }
    out.push({ kind: kinds[i] || "other", url, label: labels[i]?.trim() || null, is_public: true });
  }
  return out;
}

function registerPortalProfileRoutes(router: Router<RequestContext>): void {
  router.get("/portal/profile", async (_req, ctx) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const profile = await profileWithCompleteness(app, person.id);
    const editor = profile.last_edited_by_person_id && str(profile.last_edited_by_person_id) !== person.id
      ? await app.db.byId<PersonRow>("person", str(profile.last_edited_by_person_id))
      : null;
    const row = await app.db.byId<Row>("person", person.id);
    return htmlResponse(
      portalPage(
        ctx,
        { title: "My profile", active: "profile" },
        portalProfileView({ person: row ?? {}, profile, lastEditedBy: editor ? personDisplayName(editor) : null }),
      ),
    );
  });

  router.post("/portal/profile", async (req, ctx) => {
    const person = ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();

    const patch: Record<string, unknown> = {};
    for (const f of ["headline", "job_title", "company", "bio", "short_bio", "location", "phone", "dietary_notes", "accessibility_notes"]) {
      patch[f] = input.optional(f);
    }

    const [file] = input.files("headshot");
    if (file && file.size > 0) patch.headshot_asset_id = await storeHeadshot(app, person.id, file);
    else if (input.optional("headshot_asset_id")) patch.headshot_asset_id = input.str("headshot_asset_id");

    // INV-01-13: the speaker is the owner here, so these are the one place
    // `visibility` and `is_listed` may change.
    const visibility: Record<string, string> = {};
    for (const key of VISIBILITY_KEYS) visibility[key] = input.bool(`visibility.${key}`) ? "public" : "private";
    patch.visibility = visibility;
    patch.is_listed = input.bool("is_listed");

    await updateProfile(app, person.id, patch, { isOwner: true, editedByRole: "speaker" });

    if (input.has("pronouns")) {
      await app.db.update("person", person.id, { pronouns: input.optional("pronouns"), updated_at: app.now() });
    }

    const profile = await getOrCreateProfile(app, person.id);
    await replaceProfileLinks(app, str(profile.id), linksFrom(input));
    await app.flush();
    return redirect("/portal/profile", 303, { "set-cookie": flashCookie("ok", "Saved.") });
  });
}

/* -------------------------------------------------------------------------- */
/* Management API — /v1                                                        */
/* -------------------------------------------------------------------------- */

function registerManagementApi(router: Router<RequestContext>): void {
  router.get("/v1/people", async (_req, ctx) => {
    ctx.requireRead("speaker_profile.edit");
    const { limit, cursor } = pageRequest(ctx.url);
    const app = ctx.app();
    const params: unknown[] = [ctx.orgId];
    let sql = "SELECT * FROM person WHERE org_id = ? AND deleted_at IS NULL AND merged_into_person_id IS NULL";
    const q = ctx.url.searchParams.get("q");
    if (q) {
      sql += " AND (lower(full_name) LIKE ? OR lower(email) LIKE ?)";
      params.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
    }
    if (cursor) {
      sql += " AND id > ?";
      params.push(cursor);
    }
    sql += ` ORDER BY id LIMIT ${limit + 1}`;
    const rows = await app.db.raw<Row>(sql, params);
    const page = pageOf(rows, limit);
    return json({ ...page, data: redactList("Person", page.data, { includePii: ctx.includePii() }).map(publicPersonShape) });
  });

  router.get("/v1/people/:personId", async (_req, ctx, params) => {
    ctx.requireRead("speaker_profile.edit");
    const app = ctx.app();
    const person = await getPerson(app, params.personId);
    const profile = await profileWithCompleteness(app, person.id);
    const includePii = ctx.includePii();
    return json({
      ...publicPersonShape(redactRecord("Person", person as Row, { includePii })),
      profile: redactRecord("SpeakerProfile", { ...profile, links: undefined } as Row, { includePii }),
      links: profile.links,
      // `completeness` is derived and read-only (INV-11-6).
      completeness: profile.completeness,
    });
  });

  router.get("/v1/people/:personId/notes", async (_req, ctx, params) => {
    ctx.requireRead("person_note.manage");
    const app = ctx.app();
    // INV-01-14: throws rather than redacting when the reader is the subject.
    const notes = await listPersonNotes(app, params.personId);
    return json({ data: notes });
  });

  router.post("/v1/people/:personId/notes", async (req, ctx, params) => {
    ctx.requireWrite("person_note.manage");
    const input = await readInput(req);
    const app = ctx.app();
    const body = input.str("body");
    if (!body) throw validationError("A note needs a body.", [{ field_key: "body", message: "Write something." }]);
    const id = await addPersonNote(app, { person_id: params.personId, event_id: input.optional("event_id"), body });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/participants", async (_req, ctx) => {
    const eventId = ctx.url.searchParams.get("event_id");
    if (!eventId) throw validationError("event_id is required.", [{ field_key: "event_id", message: "Which event's roster?" }]);
    ctx.eventId = eventId;
    ctx.requireRead("roster.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const rows = await eventRoster(app, eventId, rosterFiltersFrom(ctx.url));
    const includePii = ctx.includePii({ event_id: eventId });
    const { limit, cursor } = pageRequest(ctx.url);
    const sliced = rows.filter((r) => !cursor || str(r.participant.id) > cursor).slice(0, limit + 1);
    const page = pageOf(
      sliced.map((r) => ({
        id: str(r.participant.id),
        event_id: eventId,
        person_id: r.person_id,
        full_name: r.full_name,
        email: includePii ? r.email : "[redacted]",
        kind: str(r.participant.kind),
        status: str(r.participant.status),
        source: str(r.participant.source),
        portal_access: str(r.participant.portal_access),
        // Derived (INV-11-6), computed at read time.
        session_count: r.session_count,
        task_completion: r.task_completion,
      })),
      limit,
    );
    return json(page);
  });

  router.post("/v1/participants", async (req, ctx) => {
    const input = await readInput(req);
    const eventId = input.str("event_id");
    ctx.eventId = eventId;
    ctx.requireWrite("roster.manage", { event_id: eventId });
    const app = ctx.app(eventId);
    const person = input.optional("person_id")
      ? await getPerson(app, input.str("person_id"))
      : await findOrCreatePerson(app, { email: input.str("email"), full_name: input.str("full_name"), source: "api" });
    const row = await addParticipant(app, {
      event_id: eventId,
      person_id: person.id,
      kind: (input.str("kind", "speaker") || "speaker") as ParticipantKind,
      status: (input.str("status", "invited") || "invited") as ParticipantStatus,
      source: (input.str("source", "manual") || "manual") as ParticipantSource,
    });
    await app.flush();
    return json({ id: str(row.id), person_id: person.id }, { status: 201 });
  });

  router.get("/v1/invitations", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const rows = await listInvitations(app, { status: ctx.url.searchParams.get("status") });
    const { limit, cursor } = pageRequest(ctx.url);
    const page = pageOf(rows.filter((r) => !cursor || str(r.id) > cursor).slice(0, limit + 1), limit);
    // `accept_url` is absent: it is returned exactly once, by the create
    // command, and is never re-readable (INV-01-15). `token_hash` never leaves.
    return json({
      ...page,
      data: redactList("Invitation", page.data, { includePii: ctx.includePii() }).map(({ token_hash: _t, ...rest }) => rest),
    });
  });

  router.post("/v1/invitations", async (req, ctx) => {
    const input = await readInput(req);
    const scope = input.optional("scope_type")
      ? { scope_type: input.str("scope_type") as ScopeType, scope_id: input.str("scope_id") }
      : { scope_type: "org" as ScopeType, scope_id: ctx.orgId };
    const role = input.optional("intended_role") as Role | null;
    if (role) requireGrantPermission(ctx, role, scope);
    else ctx.requireWrite("roster.manage", { event_id: input.optional("context_id") });
    const app = ctx.app();
    const invitation = await createInvitation(
      app,
      {
        email: input.str("email"),
        kind: input.str("kind", "staff") as "staff",
        intended_role: role,
        scope_type: role ? scope.scope_type : null,
        scope_id: role ? scope.scope_id : null,
        context_type: input.optional("context_type") as "event" | null,
        context_id: input.optional("context_id"),
        expires_in_days: num(input.int("expires_in_days", 14), 14),
      },
      ctx.env.PUBLIC_BASE_URL || ctx.url.origin,
    );
    await app.flush();
    return json(invitation, { status: 201 });
  });

  router.get("/v1/role-grants", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const { limit, cursor } = pageRequest(ctx.url);
    const params: unknown[] = [ctx.orgId];
    let sql = "SELECT * FROM role_grant WHERE org_id = ?";
    const personId = ctx.url.searchParams.get("person_id");
    if (personId) {
      sql += " AND person_id = ?";
      params.push(personId);
    }
    if (cursor) {
      sql += " AND id > ?";
      params.push(cursor);
    }
    sql += ` ORDER BY id LIMIT ${limit + 1}`;
    return json(pageOf(await app.db.raw<Row>(sql, params), limit));
  });

  router.post("/v1/role-grants", async (req, ctx) => {
    const input = await readInput(req);
    const scope = { scope_type: input.str("scope_type", "org") as ScopeType, scope_id: input.str("scope_id") || ctx.orgId };
    const role = input.str("role") as Role;
    requireGrantPermission(ctx, role, scope);
    const app = ctx.app();
    const id = await grantRole(app, {
      person_id: input.str("person_id"),
      role,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      expires_at: input.optional("expires_at"),
    });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.delete("/v1/role-grants/:grantId", async (_req, ctx, params) => {
    const app = ctx.app();
    const grant = await app.db.byId<Row>("role_grant", params.grantId);
    if (!grant) throw notFound("Role grant", params.grantId);
    requireGrantPermission(ctx, str(grant.role) as Role, {
      scope_type: str(grant.scope_type) as ScopeType,
      scope_id: str(grant.scope_id),
    });
    await revokeRole(app, params.grantId); // INV-01-8 refuses the last owner.
    await app.flush();
    return json({ ok: true });
  });
}

/** The `Person` fields the API exposes, with JSON-decoded columns. */
function publicPersonShape(row: Row): Row {
  return {
    id: str(row.id),
    email: row.email,
    full_name: str(row.full_name),
    display_name: strOrNull(row.display_name),
    pronouns: strOrNull(row.pronouns),
    timezone: strOrNull(row.timezone),
    locale: strOrNull(row.locale),
    status: str(row.status),
    is_placeholder: bool(row.is_placeholder),
    tags: parseJson<string[]>(row.tags, []),
    custom_field_values: parseJson<Record<string, unknown>>(row.custom_field_values, {}),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

export { DomainError };
