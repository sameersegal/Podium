/**
 * Per-request context: who is calling, which org and event, and the unit of
 * work they write through.
 *
 * Authentication is resolved from exactly one of: a session cookie (portal and
 * management UI), an API key (management API), or nothing (public surfaces).
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { bool, D1Db, parseJson, str, type Row } from "@podiumstack/data/db.js";
import { hashToken } from "@podiumstack/domain/identity/credentials.js";
import type { Actor } from "@podiumstack/domain/events/envelope.js";
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
} from "@podiumstack/domain/shared/authorization.js";
import { DomainError, forbidden, unauthorized } from "@podiumstack/domain/shared/errors.js";
import { newId } from "@podiumstack/domain/shared/ids.js";
import { nowIso } from "@podiumstack/domain/shared/time.js";

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
   * What the console rail's counts say, loaded once per admin page view by
   * `ui/rail-counts.ts` before the router runs.
   *
   * It lives on the context rather than being threaded through `adminPage`
   * because the rail is chrome: a hundred screens would otherwise each have to
   * know what the rail says about the screen beside it, and ninety-nine of them
   * would pass nothing. Absent — on every non-admin request, and on any admin
   * request where the query would not have been worth it — the rail simply
   * draws no numbers.
   */
  rail?: import("../ui/rail-counts.js").RailCounts;
  /** How many D1 statements this request has prepared so far. See `countingEnv`. */
  queries: QueryCounter;
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

/**
 * INV-01-18: a session credential travels only over a secure context and is
 * unreadable to scripts.
 *
 * `Secure` is unconditional, and that is a deliberate choice about the dev
 * server rather than an oversight about it: browsers treat `http://localhost`
 * as a secure context, so a `Secure` cookie is set and sent there exactly as it
 * is over https. The only thing this breaks is a plain-http origin that is not
 * localhost — `npm run dev:lan`, reached by IP from a phone — and a session
 * cookie that silently works over plain http on a shared network is the thing
 * the flag exists to prevent. Test the LAN case over a tunnel, not by dropping
 * the flag.
 *
 * `SameSite=Lax` is load-bearing here in a way it is not in most apps: there is
 * no CSRF token anywhere. It is the only thing standing between a third-party
 * page and a state-changing form post, which is why no route may perform a
 * mutation on `GET` — see "The admin console" in docs/implementation.md.
 */
export function setCookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; path?: string } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, "SameSite=Lax", "Secure"];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  // The attributes must match the ones the cookie was set with or the browser
  // treats this as a different cookie and the original survives the sign-out.
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

/**
 * Where a post-sign-in `?next=` may point — INV-01-18.
 *
 * Only a same-origin path, and the check is on the string rather than on a
 * parsed URL because the interesting inputs are the ones that parse to
 * something other than they read as. `//evil.example` is a protocol-relative
 * URL, not a path. `/\evil.example` is treated as `//` by some browsers.
 * `https://evil.example` is obvious and is not the one that gets through.
 *
 * The failure this prevents: an attacker sends `/login?next=https://evil.example`,
 * the person signs in on the real site with a real password, and lands on a
 * copy of it — a phishing primitive on the one page most likely to be trusted.
 */
export function safeNext(next: string | null | undefined, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
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

/**
 * Counts the statements one request prepares.
 *
 * The performance contract is "D1 queries per request — single digits; an N+1
 * is a defect, not a slow path", and a budget nobody can read is a budget
 * nobody keeps. This makes the number observable from a browser and from the
 * test harness (`tests/integration/foundation/query-budget.test.ts`) instead of
 * countable only by reading the code and hoping.
 *
 * A `Proxy` over the binding rather than a counter inside `D1Db`, because
 * several `D1Db` instances exist per request — one per `AppContext` — and the
 * budget is about the request, not about any one of them. `prepare` is the only
 * door into D1: `select`, `raw`, `batch` and every write go through it.
 *
 * The count rides on the environment, so every `AppContext` the request builds
 * shares it without being told to. Cost is one increment per statement.
 */
export interface QueryCounter {
  count: number;
}

function countingEnv(env: Env, counter: QueryCounter): Env {
  const db = new Proxy(env.DB, {
    get(target, prop) {
      // `target` as the receiver, not the proxy: a host accessor that reads
      // `this` would otherwise be handed the wrapper and re-enter this trap.
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        counter.count++;
        return (value as D1Database["prepare"]).call(target, sql);
      };
    },
  });
  return { ...env, DB: db };
}

export async function buildContext(req: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<RequestContext> {
  const url = new URL(req.url);
  const now = nowIso();
  // Wrapped before anything reads: `resolveOrgId` is itself a query, and a
  // counter that starts after the first one is a counter that is wrong by one.
  const queries: QueryCounter = { count: 0 };
  env = countingEnv(env, queries);
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
    queries,
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
 * INV-09-27 — a first-person statement is authored by its person, never by an
 * API key.
 *
 * Submitting a proposal and writing a review are the two of these. Both are
 * somebody's own assertion, and both keep that person's name for as long as
 * the record exists: a submission is what an acceptance is granted against, a
 * review is what a decision is justified by under an anonymity setting that
 * only means anything if the author is who the assignment says. A credential
 * held by software is nobody.
 *
 * The refusal is separate from the capability check and runs before it, so the
 * answer names the rule. Left to the guards, a key submitting a proposal got a
 * 422 listing every unanswered form field, and a key posting a review got
 * "Sign in to continue" — both true, neither the reason.
 */
export function requirePersonalAuthorship(ctx: RequestContext, act: string): void {
  if (!ctx.apiKeyId) return;
  throw new DomainError({
    code: "authorship_requires_person",
    message: `${act} is that person's own statement and cannot be done with an API key; they do it signed in as themselves.`,
    invariant: "INV-09-27",
    status: 403,
  });
}

/**
 * An API key presents scopes, not roles. It still needs a grant, because one
 * matrix governs both callers — but the grant is a floor to stand on, not the
 * permission. `CAPABILITY_SCOPES` is the permission, and since it now covers
 * every capability and defaults to deny (INV-09-25), the pair is exact: a key
 * holding `proposals:read` passes the `admin` row for `proposal.read_any` and
 * fails the scope check on every other capability, including `proposal.edit`,
 * whose write needs `proposals:write`.
 *
 * This used to grade the role instead — `admin` for a key with any `:write`
 * scope, `viewer` otherwise — and both halves were wrong. `viewer` appeared in
 * no capability at all, so a read-only key could read nothing; and `admin`
 * carried every capability the scope table did not yet mention, so a key made
 * for `tasks:write` could mint a second key with `pii:read`. Grading a role by
 * scope is a lossy translation in both directions; the fix is to stop doing it
 * and let the scopes speak for themselves.
 */
function apiKeyGrants(_scopes: ApiScope[], orgId: string): RoleGrantView[] {
  return [
    {
      role: "admin",
      scope_type: "org",
      scope_id: orgId,
      expires_at: null,
      revoked_at: null,
    },
  ];
}

/**
 * Every capability, and the scopes that reach it — INV-09-25.
 *
 * `Record`, not `Partial<Record>`, on purpose: the type is the enforcement.
 * This table used to cover eighteen of the thirty-six capabilities and
 * `hasScopeFor` answered `true` for the rest, which meant the role decided
 * them — and the role a key gets is `admin` the moment it holds any `:write`
 * scope. A key created for `tasks:write` could therefore reach `org.configure`
 * and mint a second key holding `pii:read` and `decisions:write`. Adding a
 * capability now fails to compile until somebody decides which scope it
 * belongs to, which is the only way a table like this stays complete.
 *
 * Three groupings are worth stating rather than leaving to be inferred:
 *
 * - **Outreach is governed by the speaker scopes.** `campaign.send` and
 *   `communications.read` write to and read about people, not the programme,
 *   and 09 has no campaign scope. A key that may not write to speakers may not
 *   email them either.
 * - **`entitlements:*` sit alongside `sponsors:*` on `sponsor.manage`,** which
 *   is the capability every entitlement route is guarded by. Without this the
 *   two entitlement scopes 09 defines reach nothing at all.
 * - **`webhooks:manage` is the platform-administration scope.** It is what
 *   `org.configure` and `audit.read` require, so integrations, templates and
 *   the audit log stay reachable by a key that explicitly asked for them —
 *   and by no other. Minting API keys is excluded from it separately, at the
 *   route: see INV-09-26.
 */
const CAPABILITY_SCOPES: Record<Capability, { read: ApiScope[]; write: ApiScope[] }> = {
  "org.configure": { read: ["webhooks:manage"], write: ["webhooks:manage"] },
  "audit.read": { read: ["webhooks:manage"], write: ["webhooks:manage"] },

  "event.configure": { read: ["events:read"], write: ["events:write"] },
  "config.manage": { read: ["events:read"], write: ["events:write"] },
  "cfp.configure": { read: ["events:read"], write: ["events:write"] },
  "custom_field.manage": { read: ["events:read"], write: ["events:write"] },
  "bulk.import": { read: ["events:read"], write: ["events:write"] },
  "export.request": { read: ["events:read"], write: ["events:write"] },
  // A key driving the sync must hold `events:write`; without it, reading a
  // conflict queue is all it can do.
  "sync.resolve_conflict": { read: ["events:read"], write: ["events:write"] },

  "proposal.submit": { read: ["proposals:read"], write: ["proposals:write"] },
  "proposal.read_any": { read: ["proposals:read"], write: ["proposals:write"] },
  "proposal.edit": { read: ["proposals:read"], write: ["proposals:write"] },

  "review.read": { read: ["reviews:read"], write: ["reviews:write"] },
  "review.submit": { read: ["reviews:read"], write: ["reviews:write"] },
  "decision.manage": { read: ["decisions:read"], write: ["decisions:write"] },

  "session.manage": { read: ["sessions:read"], write: ["sessions:write"] },
  "session.approve_content": { read: ["sessions:read"], write: ["sessions:write"] },
  "session.restore_revision": { read: ["sessions:read"], write: ["sessions:write"] },
  "asset.comment": { read: ["sessions:read"], write: ["sessions:write"] },

  "sponsor.manage": {
    read: ["sponsors:read", "entitlements:read"],
    write: ["sponsors:write", "entitlements:write"],
  },

  "speaker_profile.edit": { read: ["speakers:read"], write: ["speakers:write"] },
  "speaker_profile.set_visibility": { read: ["speakers:read"], write: ["speakers:write"] },
  "roster.manage": { read: ["speakers:read"], write: ["speakers:write"] },
  "person_note.manage": { read: ["speakers:read"], write: ["speakers:write"] },
  "contact_directory.read": { read: ["speakers:read"], write: ["speakers:write"] },
  "segment.manage": { read: ["speakers:read"], write: ["speakers:write"] },
  "pipeline.manage": { read: ["speakers:read"], write: ["speakers:write"] },
  "campaign.send": { read: ["speakers:read"], write: ["speakers:write"] },
  "communications.read": { read: ["speakers:read"], write: ["speakers:write"] },

  "task.complete": { read: ["tasks:read"], write: ["tasks:write"] },
  "task.approve": { read: ["tasks:read"], write: ["tasks:write"] },
  "task.define": { read: ["tasks:read"], write: ["tasks:write"] },

  "schedule.place": { read: ["schedule:read"], write: ["schedule:publish"] },
  "schedule.publish": { read: ["schedule:read"], write: ["schedule:publish"] },
  "schedule.read_published": { read: ["schedule:read"], write: ["schedule:publish"] },

  "pii.read": { read: ["pii:read"], write: ["pii:read"] },
};

/**
 * INV-09-25 — a key reaches exactly what its scopes name, and nothing else.
 * Default-deny: an unmapped capability is refused rather than deferred to the
 * role, because deferring is what let a narrow key act as an org admin.
 */
function hasScopeFor(scopes: ApiScope[] | null, capability: Capability, write: boolean): boolean {
  if (!scopes) return true; // a person, not a key
  const need = CAPABILITY_SCOPES[capability];
  if (!need) return false;
  return (write ? need.write : [...need.read, ...need.write]).some((s) => scopes.includes(s));
}

export { bool, parseJson, str };
