/**
 * Per-request context: who is calling, which org and event, and the unit of
 * work they write through.
 *
 * Authentication is resolved from exactly one of: a session cookie (portal and
 * management UI), an API key (management API), or nothing (public surfaces).
 */

import { AppContext, type Env } from "@podiumconf/data/context.js";
import { bool, D1Db, parseJson, str, type Row } from "@podiumconf/data/db.js";
import { hashToken } from "@podiumconf/domain/identity/credentials.js";
import type { Actor } from "@podiumconf/domain/events/envelope.js";
import {
  accessFor,
  canAct,
  canRead,
  canWrite,
  isStaff,
  NO_RELATIONSHIPS,
  type ApiScope,
  type Capability,
  type Principals,
  type Relationships,
  type RoleGrantView,
  type Target,
} from "@podiumconf/domain/shared/authorization.js";
import { forbidden, unauthorized } from "@podiumconf/domain/shared/errors.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { nowIso } from "@podiumconf/domain/shared/time.js";

export const SESSION_COOKIE = "podium_session";
export const FLASH_COOKIE = "podium_flash";

export interface PersonView {
  id: string;
  org_id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  status: string;
}

export interface RequestContext {
  req: Request;
  env: Env;
  url: URL;
  orgId: string;
  person: PersonView | null;
  apiKeyId: string | null;
  apiScopes: ApiScope[] | null;
  apiEventIds: string[] | null;
  principals: Principals;
  actor: Actor;
  correlationId: string;
  flash: { kind: "ok" | "err" | "warn" | "info"; message: string } | null;
  /** Set by handlers that resolve an event from the path. */
  eventId: string | null;
  /**
   * `Organization.default_timezone` — the zone org-level screens render
   * instants in, where no event has narrowed it further (11, "Time": every
   * instant is displayed in a stated zone, never raw).
   */
  orgTimezone: string;
  now: string;
  app(eventId?: string | null): AppContext;
  can(capability: Capability, target?: Target): boolean;
  canWrite(capability: Capability, target?: Target): boolean;
  canRead(capability: Capability, target?: Target): boolean;
  requireWrite(capability: Capability, target?: Target): void;
  requireRead(capability: Capability, target?: Target): void;
  requirePerson(): PersonView;
  isStaff(target?: Target): boolean;
  /** `pii:read` for API keys, the PII row of the matrix for people. */
  includePii(target?: Target): boolean;
  waitUntil(p: Promise<unknown>): void;
}

export function cookiesOf(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setCookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; path?: string } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, "SameSite=Lax"];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
}

export function flashCookie(kind: "ok" | "err" | "warn" | "info", message: string): string {
  return setCookie(FLASH_COOKIE, JSON.stringify({ kind, message }), { maxAge: 30 });
}

/** The single org of this deployment (01, "Tenancy": one Organization per deployment). */
export async function resolveOrgId(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM organization ORDER BY created_at LIMIT 1").first<{ id: string }>();
  return row?.id ?? "";
}

async function loadPerson(db: D1Db, personId: string): Promise<PersonView | null> {
  const row = await db.byId<Record<string, unknown>>("person", personId);
  if (!row) return null;
  // INV-01-9: reads follow the merge pointer.
  if (row.merged_into_person_id) return loadPerson(db, str(row.merged_into_person_id));
  return {
    id: str(row.id),
    org_id: str(row.org_id),
    full_name: str(row.full_name),
    display_name: row.display_name ? str(row.display_name) : null,
    email: str(row.email),
    status: str(row.status),
  };
}

export async function loadGrants(db: D1Db, personId: string, now: string): Promise<RoleGrantView[]> {
  const rows = await db.select<Record<string, unknown>>("role_grant", { person_id: personId });
  return rows
    .map((r) => ({
      role: str(r.role) as RoleGrantView["role"],
      scope_type: str(r.scope_type) as RoleGrantView["scope_type"],
      scope_id: str(r.scope_id),
      expires_at: r.expires_at ? str(r.expires_at) : null,
      revoked_at: r.revoked_at ? str(r.revoked_at) : null,
    }))
    .filter((g) => !g.revoked_at && (!g.expires_at || g.expires_at > now));
}

/**
 * Relationship-derived permissions — 01, "Effective permissions". They end
 * when the relationship ends, which is why they are recomputed per request
 * rather than baked into a session.
 */
export async function loadRelationships(db: D1Db, personId: string): Promise<Relationships> {
  const [speakerRows, submitted, credited, contacts, participants] = await Promise.all([
    db.raw<{ session_id: string }>(
      "SELECT session_id FROM session_speaker WHERE person_id = ? AND confirmation_status != 'replaced'",
      [personId],
    ),
    db.raw<{ id: string }>("SELECT id FROM proposal WHERE submitter_person_id = ? AND deleted_at IS NULL", [personId]),
    db.raw<{ proposal_id: string }>(
      "SELECT proposal_id FROM proposal_speaker WHERE person_id = ? AND participation_status != 'removed'",
      [personId],
    ),
    db.raw<{ sponsor_id: string }>("SELECT sponsor_id FROM sponsor_contact WHERE person_id = ? AND status = 'active'", [
      personId,
    ]),
    db.raw<{ event_id: string }>("SELECT event_id FROM event_participant WHERE person_id = ?", [personId]),
  ]);
  return {
    session_ids: speakerRows.map((r) => r.session_id),
    proposal_ids: [...new Set([...submitted.map((r) => r.id), ...credited.map((r) => r.proposal_id)])],
    sponsor_ids: contacts.map((r) => r.sponsor_id),
    participant_event_ids: participants.map((r) => r.event_id),
  };
}

export async function buildContext(req: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<RequestContext> {
  const url = new URL(req.url);
  const now = nowIso();
  const orgId = await resolveOrgId(env);
  const db = new D1Db(env.DB, orgId);
  const orgRow = orgId ? await db.byId<Row>("organization", orgId) : null;
  const orgTimezone = str(orgRow?.default_timezone, "UTC");

  let person: PersonView | null = null;
  let apiKeyId: string | null = null;
  let apiScopes: ApiScope[] | null = null;
  let apiEventIds: string[] | null = null;
  let grants: RoleGrantView[] = [];
  let relationships: Relationships = NO_RELATIONSHIPS;

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const secret = auth.slice(7).trim();
    const row = await db.first<Record<string, unknown>>("api_key", { secret_hash: hashToken(secret) });
    if (row && !row.revoked_at && (!row.expires_at || str(row.expires_at) > now)) {
      apiKeyId = str(row.id);
      apiScopes = parseJson<ApiScope[]>(row.scopes, []);
      const evs = parseJson<string[]>(row.event_ids, []);
      apiEventIds = evs.length ? evs : null;
      // INV-09-11: revocation takes effect immediately, so `last_used_at` is a
      // write we can afford to defer but the check above is not.
      waitUntil(db.update("api_key", apiKeyId, { last_used_at: now }));
      grants = apiKeyGrants(apiScopes, orgId);
    }
  }

  if (!apiKeyId) {
    const token = cookiesOf(req)[SESSION_COOKIE];
    if (token) {
      const sess = await db.first<Record<string, unknown>>("auth_session", { token_hash: hashToken(token) });
      if (sess && str(sess.expires_at) > now) {
        person = await loadPerson(db, str(sess.person_id));
        if (person) {
          [grants, relationships] = await Promise.all([loadGrants(db, person.id, now), loadRelationships(db, person.id)]);
          waitUntil(db.update("auth_session", str(sess.id), { last_seen_at: now }));
        }
      }
    }
  }

  const actor: Actor = apiKeyId
    ? { type: "api_key", id: apiKeyId, display_name: "api key" }
    : person
      ? { type: "person", id: person.id, display_name: person.display_name ?? person.full_name }
      : { type: "system", id: null, display_name: "anonymous" };

  const principals: Principals = { org_id: orgId, person_id: person?.id ?? null, grants, relationships, api_scopes: apiScopes, api_event_ids: apiEventIds };

  const cookies = cookiesOf(req);
  let flash: RequestContext["flash"] = null;
  if (cookies[FLASH_COOKIE]) {
    try {
      flash = JSON.parse(cookies[FLASH_COOKIE]);
    } catch {
      flash = null;
    }
  }

  const correlationId = newId("DomainEventRecord");

  const ctx: RequestContext = {
    req,
    env,
    url,
    orgId,
    person,
    apiKeyId,
    apiScopes,
    apiEventIds,
    principals,
    actor,
    correlationId,
    flash,
    eventId: null,
    orgTimezone,
    now,
    waitUntil,
    app(eventId?: string | null) {
      return new AppContext({
        env,
        orgId,
        eventId: eventId ?? ctx.eventId,
        actor,
        correlationId,
        ip: req.headers.get("cf-connecting-ip"),
        userAgent: req.headers.get("user-agent"),
        // Lets `flush()` poke the live rooms after the response has gone out
        // rather than in front of it.
        waitUntil,
      });
    },
    can(capability, target) {
      return canAct(principals, capability, { event_id: ctx.eventId, ...target }, now) && hasScopeFor(apiScopes, capability, false);
    },
    canWrite(capability, target) {
      return canWrite(principals, capability, { event_id: ctx.eventId, ...target }, now) && hasScopeFor(apiScopes, capability, true);
    },
    canRead(capability, target) {
      return canRead(principals, capability, { event_id: ctx.eventId, ...target }, now) && hasScopeFor(apiScopes, capability, false);
    },
    requireWrite(capability, target) {
      if (!ctx.canWrite(capability, target)) throw denial(ctx, capability);
    },
    requireRead(capability, target) {
      if (!ctx.can(capability, target)) throw denial(ctx, capability);
    },
    requirePerson() {
      if (!person) throw unauthorized("Sign in to continue.");
      return person;
    },
    isStaff(target) {
      return isStaff(principals, { event_id: ctx.eventId, ...target }, now);
    },
    includePii(target) {
      if (apiScopes) return apiScopes.includes("pii:read");
      return accessFor(principals, "pii.read", { event_id: ctx.eventId, ...target }, now) !== "none";
    },
  };
  return ctx;
}

/**
 * What each capability lets somebody do, said the way the person refused it would
 * say it. The keys are the authorization matrix's vocabulary; unfolding one into
 * prose ("org configure") reads as a leaked identifier, so every member spells
 * itself out. Typed as a full `Record`, so a new capability fails the build here
 * rather than falling back to its own key at runtime.
 */
const CAPABILITY_PHRASE: Record<Capability, string> = {
  "org.configure": "change organization settings",
  "event.configure": "change this event's settings",
  "config.manage": "manage this event's configuration",
  "cfp.configure": "configure calls for proposals",
  "proposal.submit": "submit a proposal",
  "proposal.read_any": "read other people's proposals",
  "proposal.edit": "edit this proposal",
  "review.read": "read reviews",
  "review.submit": "submit a review",
  "decision.manage": "record or publish decisions",
  "sponsor.manage": "manage sponsors",
  "session.manage": "manage sessions",
  "session.approve_content": "approve session content",
  "session.restore_revision": "restore an earlier revision",
  "roster.manage": "manage the roster",
  "speaker_profile.edit": "edit this speaker profile",
  "speaker_profile.set_visibility": "change what a speaker profile shows publicly",
  "person_note.manage": "read or write internal notes",
  "contact_directory.read": "browse the contact directory",
  "segment.manage": "manage segments",
  "pipeline.manage": "manage pipelines",
  "asset.comment": "comment on this file",
  "campaign.send": "send campaigns",
  "communications.read": "read sent messages",
  "bulk.import": "import data",
  "export.request": "request an export",
  "custom_field.manage": "manage custom fields",
  "task.define": "define tasks",
  "task.complete": "complete this task",
  "task.approve": "approve a completed task",
  "schedule.place": "place sessions on the schedule",
  "schedule.publish": "publish the schedule",
  "schedule.read_published": "read the published schedule",
  "pii.read": "see personal contact details",
  "sync.resolve_conflict": "resolve a sync conflict",
  "audit.read": "read the audit log",
};

function denial(ctx: RequestContext, capability: Capability) {
  if (!ctx.person && !ctx.apiKeyId) return unauthorized("Sign in to continue.");
  return forbidden(`You do not have permission to ${CAPABILITY_PHRASE[capability]}.`);
}

/**
 * An API key presents scopes, not roles. Map its scopes onto the equivalent
 * org-scoped grant so one matrix governs both callers.
 */
function apiKeyGrants(scopes: ApiScope[], orgId: string): RoleGrantView[] {
  const writes = scopes.some((s) => s.endsWith(":write") || s === "schedule:publish");
  return [
    {
      role: writes ? "admin" : "viewer",
      scope_type: "org",
      scope_id: orgId,
      expires_at: null,
      revoked_at: null,
    },
  ];
}

const CAPABILITY_SCOPES: Partial<Record<Capability, { read: ApiScope[]; write: ApiScope[] }>> = {
  "proposal.read_any": { read: ["proposals:read"], write: ["proposals:write"] },
  "proposal.edit": { read: ["proposals:read"], write: ["proposals:write"] },
  "review.read": { read: ["reviews:read"], write: ["reviews:write"] },
  "review.submit": { read: ["reviews:read"], write: ["reviews:write"] },
  "decision.manage": { read: ["decisions:read"], write: ["decisions:write"] },
  "session.manage": { read: ["sessions:read"], write: ["sessions:write"] },
  "sponsor.manage": { read: ["sponsors:read"], write: ["sponsors:write"] },
  "task.complete": { read: ["tasks:read"], write: ["tasks:write"] },
  "task.approve": { read: ["tasks:read"], write: ["tasks:write"] },
  "task.define": { read: ["tasks:read"], write: ["tasks:write"] },
  "schedule.place": { read: ["schedule:read"], write: ["schedule:publish"] },
  "schedule.publish": { read: ["schedule:read"], write: ["schedule:publish"] },
  "speaker_profile.edit": { read: ["speakers:read"], write: ["speakers:write"] },
  "roster.manage": { read: ["speakers:read"], write: ["speakers:write"] },
  "event.configure": { read: ["events:read"], write: ["events:write"] },
  "config.manage": { read: ["events:read"], write: ["events:write"] },
  "cfp.configure": { read: ["events:read"], write: ["events:write"] },
  // A key driving the sync must hold `events:write`; without it, reading a
  // conflict queue is all it can do. `hasScopeFor` defaults an unmapped
  // capability to `true`, so leaving this out would let a `tasks:write` key
  // resolve conflicts on the programme.
  "sync.resolve_conflict": { read: ["events:read"], write: ["events:write"] },
};

function hasScopeFor(scopes: ApiScope[] | null, capability: Capability, write: boolean): boolean {
  if (!scopes) return true; // a person, not a key
  const need = CAPABILITY_SCOPES[capability];
  if (!need) return true;
  return (write ? need.write : [...need.read, ...need.write]).some((s) => scopes.includes(s));
}

export { bool, parseJson, str };
