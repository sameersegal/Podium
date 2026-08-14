/**
 * Identity & Access — the shared kernel (01-identity-and-access.md).
 *
 * Aggregate roots: `Organization`, `Person`, `Invitation`.
 */

import { AppContext, type Env } from "@podiumstack/data/context.js";
import { bool, buildInsert, buildUpdate, num, parseJson, str, strOrNull, type Row, type Statement } from "@podiumstack/data/db.js";
import { beyondCpuBudget, hashToken, needsRehash, newToken, hashPassword, verifyPassword } from "@podiumstack/domain/identity/credentials.js";
import {
  canTransitionParticipant,
  DEFAULT_PROFILE_VISIBILITY,
  isAbsoluteHttps,
  normaliseEmail,
  normaliseName,
  profileCompleteness,
  type InvitationKind,
  type ParticipantKind,
  type ParticipantSource,
  type ParticipantStatus,
} from "@podiumstack/domain/identity/types.js";
import { SYSTEM_ACTOR } from "@podiumstack/domain/events/envelope.js";
import { DomainError, forbidden, invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId, slugify } from "@podiumstack/domain/shared/ids.js";
import { addDays, isValidTimezone, nowIso } from "@podiumstack/domain/shared/time.js";
import type { Role, ScopeType } from "@podiumstack/domain/shared/authorization.js";

export interface PersonRow extends Row {
  id: string;
  org_id: string;
  email: string;
  full_name: string;
  display_name: string | null;
  status: string;
  is_placeholder: number;
}

/* -------------------------------------------------------------------------- */
/* Organization — first-run setup                                             */
/* -------------------------------------------------------------------------- */

export interface SetupOrganizationInput {
  org_name: string;
  org_slug?: string | null;
  default_timezone: string;
  contact_email: string;
  /**
   * `Organization.postal_address` (01) — required here even though the
   * column is nullable: this is the one moment the operator's attention is
   * guaranteed, and the field is what makes the outbound email footer
   * CAN-SPAM-compliant (09, "Conference-first rendering and audience"). The
   * column stays nullable for the Organization rows this migration ran
   * against, not for new ones.
   */
  postal_address: string;
  owner_full_name: string;
  owner_email: string;
  owner_password: string;
}

export interface SetupOrganizationResult {
  /** Bound to the new org id — the caller signs the owner in through this. */
  app: AppContext;
  organization_id: string;
  person_id: string;
}

/**
 * D1 (SQLite) reports a primary-key collision with exactly this message
 * shape — confirmed against the real `env.DB` binding, not assumed:
 * `D1_ERROR: UNIQUE constraint failed: bootstrap_state.id: SQLITE_CONSTRAINT
 * (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`. D1 does not expose a structured
 * error code here, so this is a substring match, pinned by
 * `setup-race.test.ts`. Deliberately narrow: matching on `SQLITE_CONSTRAINT`
 * alone would also catch a foreign-key or unrelated unique-index failure
 * elsewhere in the same batch (e.g. two attempts racing on the same owner
 * email) and misreport it as "already set up", which is exactly the failure
 * mode defect 2 exists to close off.
 */
function isBootstrapLockConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("SQLITE_CONSTRAINT") && message.includes("bootstrap_state.id");
}

/**
 * First-run bootstrap (01, "Tenancy": "One Organization per deployment";
 * "First-run setup"). Every other function in this file takes an `AppContext`
 * whose `orgId` already names a real `Organization` row; this one cannot,
 * because that row does not exist yet — it builds its own, bound to a freshly
 * minted id, and hands it back so the caller (the `/setup` route) can sign
 * the new owner in exactly as `/signup` does.
 *
 * SECURITY (INV-01-16): this runs with no principal and creates an
 * administrator. The route MUST refuse the request before calling this when
 * `resolveOrgId` already finds a row — but that check and this function's
 * first write are not the same statement, so the real backstop against two
 * concurrent requests both bootstrapping the deployment is `bootstrap_state`:
 * its primary key holds exactly one value, and claiming it is deliberately
 * the first statement of the one batch below.
 *
 * ATOMICITY: `Organization`, `Person`, their `password` `AuthIdentity` and
 * the `owner` `RoleGrant` are collected as statements and executed in a
 * single `Db.batch()` (one D1 transaction) rather than each committing on
 * its own — a failure anywhere in this function must never leave a claimed
 * `bootstrap_state` lock with no `Organization` behind it, or an
 * `Organization` with no owner who can sign in. `findOrCreatePerson`,
 * `setPassword` and `grantRole` each still write immediately for every other
 * caller; here they are given the batch to append to instead, so their
 * column/uniqueness logic is not duplicated for this one path.
 */
export async function setupOrganization(env: Env, input: SetupOrganizationInput): Promise<SetupOrganizationResult> {
  const orgName = input.org_name.trim();
  if (!orgName) throw new DomainError({ code: "invalid_organization", message: "An organization needs a name.", status: 422 });

  const contactEmail = normaliseEmail(input.contact_email);
  if (!contactEmail.includes("@")) {
    throw new DomainError({ code: "invalid_email", message: `"${input.contact_email}" is not an email address.`, status: 422 });
  }

  const timezone = input.default_timezone.trim();
  if (!isValidTimezone(timezone)) {
    throw new DomainError({ code: "invalid_timezone", message: `"${input.default_timezone}" is not a recognised IANA timezone.`, status: 422 });
  }

  // The column is nullable (an existing deployment's Organization row may
  // predate the field) but the field on this screen is not: bootstrap is the
  // one moment the operator's attention is guaranteed, and the footer needs it.
  const postalAddress = input.postal_address.trim();
  if (!postalAddress) {
    throw new DomainError({ code: "invalid_postal_address", message: "A mailing address is required — it appears in every email this deployment sends.", status: 422 });
  }

  const ownerName = input.owner_full_name.trim();
  if (!ownerName) throw new DomainError({ code: "invalid_person", message: "Your name is required.", status: 422 });

  const ownerEmail = normaliseEmail(input.owner_email);
  if (!ownerEmail.includes("@")) {
    throw new DomainError({ code: "invalid_email", message: `"${input.owner_email}" is not an email address.`, status: 422 });
  }

  // Fail fast on the password before doing anything else — `setPassword`
  // enforces the same rule, but there is no reason to hash it or touch the
  // database for a request that was always going to fail validation.
  if (input.owner_password.length < 8) {
    throw new DomainError({ code: "weak_password", message: "Use at least 8 characters.", status: 422 });
  }

  const orgId = newId("Organization");
  const app = new AppContext({ env, orgId, actor: SYSTEM_ACTOR });
  const now = app.now();

  // `organization` is empty on every request racing to bootstrap an empty
  // deployment, so two concurrent requests may well compute the same slug —
  // that is fine. Only one of their batches below can actually commit
  // (`bootstrap_state`'s primary key), and a batch that loses is rolled back
  // in full, slug collision included.
  const slug = await uniqueOrganizationSlug(app, input.org_slug?.trim() || orgName);

  const statements: Statement[] = [
    // INV-01-16: first statement in the batch, and the one that decides who
    // wins a race. A conflict here now aborts every write below it, in the
    // same transaction, rather than being the only write that happened.
    { sql: "INSERT INTO bootstrap_state (id, organization_id, created_at) VALUES (1, ?, ?)", params: [orgId, now] },
  ];

  const org = buildInsert(
    "organization",
    {
      id: orgId,
      name: orgName,
      slug,
      primary_domain: null,
      logo_asset_id: null,
      default_timezone: timezone,
      contact_email: contactEmail,
      postal_address: postalAddress,
      // Deliberately no `auth` key: leaving it unset lets `passwordLoginEnabled`
      // fall through to its dynamic default — on, because a brand-new
      // deployment has no `email` integration (R23) — rather than baking in an
      // explicit `false` that could lock the owner who just created it out.
      settings: JSON.stringify({}),
      created_at: now,
      updated_at: now,
      row_version: 1,
    },
    orgId,
  );
  statements.push(org.statement);
  app.events.emit({
    type: "organization.created",
    subject: { type: "organization", id: orgId },
    data: { organization_id: orgId, name: orgName, slug },
  });
  app.audit.record({ action: "organization.create", entity_type: "organization", entity_id: orgId, after: { name: orgName, slug } });

  const person = await findOrCreatePerson(
    app,
    { email: ownerEmail, full_name: ownerName, status: "active", source: "setup" },
    { batch: statements },
  );
  // `setPassword` normally re-reads the `Person` row by id; `person` here is
  // not committed yet (it is still just a statement in `statements`), so it
  // is passed in directly rather than fetched. `hashPassword` runs inside it,
  // synchronously, before this function returns — i.e. before the batch
  // below ever executes.
  await setPassword(app, person.id, input.owner_password, { batch: statements, person });
  await grantRole(app, { person_id: person.id, role: "owner", scope_type: "org", scope_id: orgId }, { batch: statements });

  try {
    await app.db.batch(statements);
  } catch (err) {
    if (isBootstrapLockConflict(err)) {
      throw invariantError(
        "INV-01-16",
        "organization_already_exists",
        "This deployment has already been set up. Sign in instead.",
        undefined,
        403,
      );
    }
    throw err;
  }

  return { app, organization_id: orgId, person_id: person.id };
}

/** `Organization.slug` is unique globally, not per org (there being none yet). */
async function uniqueOrganizationSlug(app: AppContext, desired: string): Promise<string> {
  const base = slugify(desired);
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    const existing = await app.db.first<Row>("organization", { slug: candidate });
    if (!existing) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

export interface UpsertPersonInput {
  email: string;
  full_name: string;
  display_name?: string | null;
  pronouns?: string | null;
  timezone?: string | null;
  locale?: string | null;
  is_placeholder?: boolean;
  status?: "invited" | "active" | "deactivated";
  tags?: string[];
  custom_field_values?: Record<string, unknown>;
  source?: string;
}

/**
 * A person can exist with no ability to log in — a co-speaker added by name and
 * email during submission is a real `Person` from the moment they are named.
 *
 * INV-01-1: `Person.email` is unique per org among non-deleted, non-merged
 * people, so this is an upsert by email rather than a blind insert.
 */
export interface WriteBatchOpts {
  /**
   * When given, this call's write(s) are appended here instead of executing
   * immediately — the caller is responsible for running `ctx.db.batch(...)`
   * itself, atomically, once every statement it needs is collected (see
   * `setupOrganization`). Every other caller leaves this unset and gets the
   * original immediate-write behaviour, unchanged.
   */
  batch?: Statement[];
}

export async function findOrCreatePerson(
  ctx: AppContext,
  input: UpsertPersonInput,
  opts: WriteBatchOpts = {},
): Promise<PersonRow> {
  const email = normaliseEmail(input.email);
  if (!email || !email.includes("@")) {
    throw new DomainError({ code: "invalid_email", message: `"${input.email}" is not an email address.`, status: 422 });
  }
  const existing = await ctx.db.first<PersonRow>("person", { email });
  const now = ctx.now();
  if (existing) {
    // INV-01-9: writes resolve to the surviving person.
    const resolved = await resolveMerged(ctx, existing);
    const patch: Row = {};
    if (bool(resolved.is_placeholder) && !input.is_placeholder) {
      patch.is_placeholder = 0;
      if (input.full_name && input.full_name !== resolved.full_name) patch.full_name = input.full_name;
    }
    if (input.display_name && !resolved.display_name) patch.display_name = input.display_name;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = now;
      if (opts.batch) {
        opts.batch.push(buildUpdate("person", resolved.id, patch, ctx.orgId));
      } else {
        await ctx.db.update("person", resolved.id, patch);
      }
      return { ...resolved, ...patch } as PersonRow;
    }
    return resolved;
  }

  const id = newId("Person");
  const values: Row = {
    id,
    org_id: ctx.orgId,
    email,
    full_name: input.full_name?.trim() || email,
    display_name: input.display_name ?? null,
    pronouns: input.pronouns ?? null,
    timezone: input.timezone ?? null,
    locale: input.locale ?? null,
    status: input.status ?? "invited",
    is_placeholder: input.is_placeholder ? 1 : 0,
    tags: JSON.stringify(input.tags ?? []),
    custom_field_values: JSON.stringify(input.custom_field_values ?? {}),
    created_at: now,
    updated_at: now,
  };
  let row: Row;
  if (opts.batch) {
    const built = buildInsert("person", values, ctx.orgId);
    opts.batch.push(built.statement);
    row = built.row;
  } else {
    row = await ctx.db.insert("person", values);
  }
  ctx.events.emit({
    type: "person.created",
    subject: { type: "person", id },
    data: { person_id: id, full_name: row.full_name, email, source: input.source ?? "manual" },
  });
  ctx.audit.record({ action: "person.create", entity_type: "person", entity_id: id, after: { email, full_name: row.full_name } });
  return row as PersonRow;
}

export async function resolveMerged(ctx: AppContext, person: PersonRow): Promise<PersonRow> {
  let current = person;
  for (let i = 0; i < 5 && current.merged_into_person_id; i++) {
    const next = await ctx.db.byId<PersonRow>("person", str(current.merged_into_person_id));
    if (!next) break;
    current = next;
  }
  return current;
}

export async function getPerson(ctx: AppContext, personId: string): Promise<PersonRow> {
  const row = await ctx.db.byId<PersonRow>("person", personId);
  if (!row) throw notFound("Person", personId);
  return resolveMerged(ctx, row);
}

export function personDisplayName(p: { display_name?: unknown; full_name?: unknown }): string {
  return str(p.display_name) || str(p.full_name);
}

export async function deactivatePerson(ctx: AppContext, personId: string, reason: string): Promise<void> {
  const person = await getPerson(ctx, personId);
  const now = ctx.now();
  await ctx.db.update("person", person.id, { status: "deactivated", updated_at: now });
  // INV-01-10: deactivating revokes role grants and cancels open assignments;
  // it does not remove them from sessions they spoke at.
  await ctx.db.rawRun("UPDATE role_grant SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL", [now, person.id]);
  await ctx.db.rawRun(
    "UPDATE review_assignment SET status = 'revoked' WHERE reviewer_person_id = ? AND status IN ('assigned','accepted','in_progress')",
    [person.id],
  );
  ctx.events.emit({ type: "person.deactivated", subject: { type: "person", id: person.id }, data: { person_id: person.id, reason } });
  ctx.audit.record({ action: "person.deactivate", entity_type: "person", entity_id: person.id, reason });
}

/**
 * Person merge — 01, "Person merge". The loser gets `merged_into_person_id`,
 * all references are repointed, and `person.merged` is emitted. Never automatic.
 */
export async function mergePeople(ctx: AppContext, survivingId: string, mergedId: string, reason: string): Promise<void> {
  if (survivingId === mergedId) {
    throw new DomainError({ code: "invalid_merge", message: "A person cannot be merged into themselves.", status: 422 });
  }
  const surviving = await getPerson(ctx, survivingId);
  const loser = await getPerson(ctx, mergedId);
  const now = ctx.now();

  const repoint: [string, string][] = [
    ["auth_identity", "person_id"],
    ["speaker_profile", "person_id"],
    ["event_participant", "person_id"],
    ["person_note", "person_id"],
    ["role_grant", "person_id"],
    ["proposal", "submitter_person_id"],
    ["proposal_speaker", "person_id"],
    ["session_speaker", "person_id"],
    ["sponsor_contact", "person_id"],
    ["task_instance", "assignee_person_id"],
    ["review_assignment", "reviewer_person_id"],
    ["review", "reviewer_person_id"],
    ["prospect_card", "person_id"],
    ["notification_delivery", "recipient_person_id"],
  ];
  for (const [table, column] of repoint) {
    try {
      await ctx.db.rawRun(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`, [surviving.id, loser.id]);
    } catch {
      // A unique index can refuse a repoint (the same person already there);
      // OR IGNORE leaves the loser's row, which the merge pointer resolves.
    }
  }
  await ctx.db.update("person", loser.id, { merged_into_person_id: surviving.id, status: "deactivated", updated_at: now });
  await ctx.db.rawRun("DELETE FROM person_merge_candidate WHERE person_id = ? OR candidate_person_id = ?", [loser.id, loser.id]);

  ctx.events.emit({
    type: "person.merged",
    subject: { type: "person", id: surviving.id },
    data: { surviving_person_id: surviving.id, merged_person_id: loser.id, merged_by: ctx.actor.id ?? null },
  });
  ctx.audit.record({
    action: "person.merge",
    entity_type: "person",
    entity_id: surviving.id,
    before: { merged_person_id: loser.id, email: loser.email },
    reason, // INV-11-5: merges carry a reason.
  });
}

/**
 * `PersonMergeCandidate` — surfaced, never auto-merged. A dismissal is
 * remembered so the same pair is not offered forever.
 */
export async function detectMergeCandidates(ctx: AppContext, personId: string): Promise<number> {
  const person = await ctx.db.byId<PersonRow>("person", personId);
  if (!person) return 0;
  const normal = normaliseName(str(person.full_name));
  const profile = await ctx.db.first<Row>("speaker_profile", { person_id: personId });
  const company = str(profile?.company).toLowerCase();
  const others = await ctx.db.select<PersonRow>("person", {});
  let created = 0;
  for (const other of others) {
    if (other.id === personId || other.merged_into_person_id) continue;
    const signals: string[] = [];
    if (normaliseName(str(other.full_name)) === normal && normal.length > 2) signals.push("same_normalised_name");
    if (company) {
      const otherProfile = await ctx.db.first<Row>("speaker_profile", { person_id: other.id });
      if (str(otherProfile?.company).toLowerCase() === company && signals.includes("same_normalised_name")) {
        signals.push("same_name_and_company");
      }
    }
    if (signals.length === 0) continue;
    const [a, b] = [personId, other.id].sort();
    const existing = await ctx.db.raw<Row>(
      "SELECT * FROM person_merge_candidate WHERE person_id = ? AND candidate_person_id = ?",
      [a, b],
    );
    if (existing.length > 0) continue;
    const confidence = Math.min(1, 0.5 + signals.length * 0.25);
    await ctx.db.rawRun(
      "INSERT INTO person_merge_candidate (org_id, person_id, candidate_person_id, signals, confidence, created_at) VALUES (?,?,?,?,?,?)",
      [ctx.orgId, a, b, JSON.stringify(signals), confidence, ctx.now()],
    );
    ctx.events.emit({
      type: "person.merge_candidate_detected",
      subject: { type: "person", id: a },
      data: { person_id: a, candidate_person_id: b, signals, confidence },
    });
    created++;
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/* Auth identities                                                             */
/* -------------------------------------------------------------------------- */

export interface SetPasswordOpts extends WriteBatchOpts {
  /**
   * The `Person` row, when the caller already holds it. Required alongside
   * `batch` when that row was itself only just appended to the same batch and
   * so is not readable through `ctx.db` yet — `getPerson`'s usual lookup
   * would (wrongly) report it missing. Every non-batch caller omits this and
   * gets the original `getPerson(ctx, personId)` lookup.
   */
  person?: PersonRow;
}

/**
 * INV-01-12: `credential_hash` is required when `provider = password` and must
 * be null for every other provider.
 */
export async function setPassword(ctx: AppContext, personId: string, plaintext: string, opts: SetPasswordOpts = {}): Promise<void> {
  if (plaintext.length < 8) {
    throw new DomainError({ code: "weak_password", message: "Use at least 8 characters.", status: 422 });
  }
  const person = opts.person ?? (await getPerson(ctx, personId));
  const subject = normaliseEmail(str(person.email)); // for `password`, the lowercased email
  const now = ctx.now();
  const existing = await ctx.db.first<Row>("auth_identity", { provider: "password", subject });
  const hash = hashPassword(plaintext);
  if (existing) {
    if (opts.batch) {
      opts.batch.push(buildUpdate("auth_identity", str(existing.id), { credential_hash: hash, credential_updated_at: now }, ctx.orgId));
    } else {
      await ctx.db.update("auth_identity", str(existing.id), { credential_hash: hash, credential_updated_at: now });
    }
    return;
  }
  const row: Row = {
    id: newId("AuthIdentity"),
    person_id: person.id,
    provider: "password",
    subject,
    credential_hash: hash,
    credential_updated_at: now,
    email_at_provider: subject,
    created_at: now,
  };
  if (opts.batch) {
    opts.batch.push(buildInsert("auth_identity", row, ctx.orgId).statement);
  } else {
    await ctx.db.insert("auth_identity", row);
  }
}

export async function verifyPasswordLogin(ctx: AppContext, email: string, plaintext: string): Promise<PersonRow | null> {
  const subject = normaliseEmail(email);
  const identity = await ctx.db.first<Row>("auth_identity", { provider: "password", subject });
  if (!identity?.credential_hash) return null;
  const stored = str(identity.credential_hash);
  // Verifying a hash written with the old parameters costs ~345 ms of CPU and
  // would be killed mid-request, which surfaces as a 503 rather than a failed
  // sign-in. Refuse it deliberately and say what to do about it.
  if (beyondCpuBudget(stored)) {
    throw new DomainError({
      code: "credential_needs_reset",
      // Not "reset your password": there is no reset route, so the only way
      // back in is an invitation, which INV-01-15 guarantees is always
      // retrievable on screen by whoever issues it.
      message: "This password was stored under settings this deployment can no longer check. Ask an administrator for a new invitation link to sign in and set a new password.",
      status: 409,
    });
  }
  if (!verifyPassword(plaintext, stored)) return null;
  const person = await ctx.db.byId<PersonRow>("person", str(identity.person_id));
  if (!person) return null;
  if (str(person.status) === "deactivated") throw forbidden("This account has been deactivated.");
  const patch: Row = { last_used_at: ctx.now() };
  // Carry the hash to the current parameters while we hold the plaintext.
  if (needsRehash(stored)) {
    patch.credential_hash = hashPassword(plaintext);
    patch.credential_updated_at = ctx.now();
  }
  await ctx.db.update("auth_identity", str(identity.id), patch);
  return resolveMerged(ctx, person);
}

/**
 * R23 — password login is off in production configuration, **on** in the
 * shipped default seed and wherever no `email` integration is active. A
 * deployment that can neither send mail nor accept a password is a deployment
 * nobody can sign into.
 */
export async function passwordLoginEnabled(ctx: AppContext): Promise<boolean> {
  const org = await ctx.db.byId<Row>("organization", ctx.orgId);
  const settings = parseJson<Record<string, unknown>>(org?.settings, {});
  const auth = (settings.auth ?? {}) as Record<string, unknown>;
  if (typeof auth.password_login_enabled === "boolean") return auth.password_login_enabled;
  const emailIntegration = await ctx.db.first<Row>("integration", { capability: "email", status: "active" });
  return !emailIntegration;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export async function startSession(ctx: AppContext, personId: string): Promise<string> {
  const token = newToken();
  const now = ctx.now();
  await ctx.db.insert("auth_session", {
    id: newId("Session_Cookie"),
    token_hash: hashToken(token),
    person_id: personId,
    org_id: ctx.orgId,
    created_at: now,
    expires_at: addDays(now, 30),
    last_seen_at: now,
  });
  await ctx.db.update("person", personId, { status: "active", updated_at: now });
  return token;
}

export async function endSession(ctx: AppContext, token: string): Promise<void> {
  await ctx.db.hardDelete("auth_session", { token_hash: hashToken(token) });
}

/* -------------------------------------------------------------------------- */
/* Role grants                                                                 */
/* -------------------------------------------------------------------------- */

export async function grantRole(
  ctx: AppContext,
  input: { person_id: string; role: Role; scope_type: ScopeType; scope_id: string; expires_at?: string | null },
  opts: WriteBatchOpts = {},
): Promise<string> {
  // INV-01-6: owner and admin only at org scope; track_lead only at track scope.
  if ((input.role === "owner" || input.role === "admin") && input.scope_type !== "org") {
    throw invariantError("INV-01-6", "invalid_grant_scope", `${input.role} may only be granted at org scope.`);
  }
  if (input.role === "track_lead" && input.scope_type !== "track") {
    throw invariantError("INV-01-6", "invalid_grant_scope", "track_lead may only be granted at track scope.");
  }
  const existing = await ctx.db.first<Row>("role_grant", {
    person_id: input.person_id,
    role: input.role,
    scope_type: input.scope_type,
    scope_id: input.scope_id,
    revoked_at: null,
  });
  if (existing) return str(existing.id);

  const id = newId("RoleGrant");
  const row: Row = {
    id,
    org_id: ctx.orgId,
    person_id: input.person_id,
    role: input.role,
    scope_type: input.scope_type,
    scope_id: input.scope_id,
    granted_by_person_id: ctx.actor.id ?? input.person_id,
    granted_at: ctx.now(),
    expires_at: input.expires_at ?? null,
  };
  if (opts.batch) {
    opts.batch.push(buildInsert("role_grant", row, ctx.orgId).statement);
  } else {
    await ctx.db.insert("role_grant", row);
  }
  ctx.events.emit({
    type: "role_grant.created",
    subject: { type: "person", id: input.person_id },
    data: {
      person_id: input.person_id,
      role: input.role,
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      granted_by: ctx.actor.id ?? null,
    },
  });
  ctx.audit.record({ action: "role_grant.create", entity_type: "role_grant", entity_id: id, after: input });
  return id;
}

export async function revokeRole(ctx: AppContext, grantId: string): Promise<void> {
  const grant = await ctx.db.byId<Row>("role_grant", grantId);
  if (!grant) throw notFound("Role grant", grantId);
  if (str(grant.role) === "owner") {
    // INV-01-8: an org must always have at least one active owner.
    const owners = await ctx.db.raw<{ n: number }>(
      "SELECT COUNT(*) AS n FROM role_grant WHERE org_id = ? AND role = 'owner' AND revoked_at IS NULL",
      [ctx.orgId],
    );
    if ((owners[0]?.n ?? 0) <= 1) {
      throw invariantError("INV-01-8", "last_owner", "An organization must always have at least one active owner.");
    }
  }
  await ctx.db.update("role_grant", grantId, { revoked_at: ctx.now() });
  ctx.events.emit({
    type: "role_grant.revoked",
    subject: { type: "person", id: str(grant.person_id) },
    data: {
      person_id: str(grant.person_id),
      role: str(grant.role),
      scope_type: str(grant.scope_type),
      scope_id: str(grant.scope_id),
      revoked_by: ctx.actor.id ?? null,
    },
  });
  ctx.audit.record({ action: "role_grant.revoke", entity_type: "role_grant", entity_id: grantId, before: grant });
}

/* -------------------------------------------------------------------------- */
/* Invitations                                                                 */
/* -------------------------------------------------------------------------- */

export interface CreateInvitationInput {
  email: string;
  kind: InvitationKind;
  person_id?: string | null;
  intended_role?: Role | null;
  scope_type?: ScopeType | null;
  scope_id?: string | null;
  context_type?: "proposal" | "session" | "sponsor" | "event" | null;
  context_id?: string | null;
  expires_in_days?: number;
}

export interface CreatedInvitation {
  id: string;
  /**
   * INV-01-15: returned exactly once, in the response to the command that
   * created it, and never re-readable. Every kind must offer it, so that
   * provisioning an account never depends on mail delivery.
   */
  accept_url: string;
  email: string;
}

export async function createInvitation(
  ctx: AppContext,
  input: CreateInvitationInput,
  baseUrl: string,
): Promise<CreatedInvitation> {
  const email = normaliseEmail(input.email);
  const token = newToken();
  const id = newId("Invitation");
  const now = ctx.now();
  const expiresAt = addDays(now, input.expires_in_days ?? 14);
  await ctx.db.insert("invitation", {
    id,
    org_id: ctx.orgId,
    email,
    person_id: input.person_id ?? null,
    kind: input.kind,
    intended_role: input.intended_role ?? null,
    scope_type: input.scope_type ?? null,
    scope_id: input.scope_id ?? null,
    context_type: input.context_type ?? null,
    context_id: input.context_id ?? null,
    token_hash: hashToken(token), // INV-01-7: the raw token is never stored.
    status: "pending",
    expires_at: expiresAt,
    invited_by_person_id: ctx.actor.id ?? "system",
    created_at: now,
  });
  ctx.events.emit({
    type: "invitation.sent",
    subject: { type: "invitation", id },
    data: {
      invitation_id: id,
      kind: input.kind,
      email,
      context_type: input.context_type ?? null,
      context_id: input.context_id ?? null,
      expires_at: expiresAt,
    },
  });
  ctx.audit.record({ action: "invitation.create", entity_type: "invitation", entity_id: id, after: { email, kind: input.kind } });
  return { id, accept_url: `${baseUrl}/invite/${token}`, email };
}

export async function acceptInvitation(
  ctx: AppContext,
  token: string,
  personInput: { full_name?: string; password?: string | null },
): Promise<{ person: PersonRow; invitation: Row }> {
  const invitation = await ctx.db.first<Row>("invitation", { token_hash: hashToken(token) });
  if (!invitation) throw notFound("Invitation");
  // INV-01-7: single-use, invalid once status != pending.
  if (str(invitation.status) !== "pending") {
    throw invariantError("INV-01-7", "invitation_not_pending", `This invitation is ${str(invitation.status)}.`);
  }
  if (str(invitation.expires_at) <= ctx.now()) {
    await ctx.db.update("invitation", str(invitation.id), { status: "expired" });
    ctx.events.emit({
      type: "invitation.expired",
      subject: { type: "invitation", id: str(invitation.id) },
      data: { invitation_id: str(invitation.id) },
    });
    throw invariantError("INV-01-7", "invitation_expired", "This invitation has expired. Ask for a new one.");
  }

  const person = invitation.person_id
    ? await getPerson(ctx, str(invitation.person_id))
    : await findOrCreatePerson(ctx, {
        email: str(invitation.email),
        full_name: personInput.full_name || str(invitation.email),
        status: "active",
        source: "invitation",
      });

  if (personInput.full_name && bool(person.is_placeholder)) {
    await ctx.db.update("person", person.id, { full_name: personInput.full_name, is_placeholder: 0, updated_at: ctx.now() });
    person.full_name = personInput.full_name;
  }
  if (personInput.password) await setPassword(ctx, person.id, personInput.password);

  await ctx.db.update("invitation", str(invitation.id), {
    status: "accepted",
    accepted_at: ctx.now(),
    person_id: person.id,
  });

  if (invitation.intended_role && invitation.scope_type && invitation.scope_id) {
    await grantRole(ctx, {
      person_id: person.id,
      role: str(invitation.intended_role) as Role,
      scope_type: str(invitation.scope_type) as ScopeType,
      scope_id: str(invitation.scope_id),
    });
  }

  ctx.events.emit({
    type: "invitation.accepted",
    subject: { type: "invitation", id: str(invitation.id) },
    data: { invitation_id: str(invitation.id), person_id: person.id },
  });
  return { person, invitation };
}

/* -------------------------------------------------------------------------- */
/* Speaker profile                                                             */
/* -------------------------------------------------------------------------- */

export async function getOrCreateProfile(ctx: AppContext, personId: string): Promise<Row> {
  const existing = await ctx.db.first<Row>("speaker_profile", { person_id: personId });
  if (existing) return existing;
  const id = newId("SpeakerProfile");
  const row: Row = {
    id,
    person_id: personId,
    org_id: ctx.orgId,
    visibility: JSON.stringify(DEFAULT_PROFILE_VISIBILITY),
    is_listed: 1,
    updated_at: ctx.now(),
  };
  await ctx.db.insert("speaker_profile", row);
  return row;
}

export const PROFILE_CONTENT_FIELDS = [
  "headline",
  "job_title",
  "company",
  "bio",
  "short_bio",
  "location",
  "phone",
  "dietary_notes",
  "accessibility_notes",
  "headshot_asset_id",
] as const;

/**
 * INV-01-13: only the profile's own person may change `visibility` or
 * `is_listed`. Any other field may be edited by staff, always recording
 * `last_edited_by_person_id` and an audit row.
 */
export async function updateProfile(
  ctx: AppContext,
  personId: string,
  patch: Record<string, unknown>,
  opts: { isOwner: boolean; editedByRole: string },
): Promise<void> {
  const profile = await getOrCreateProfile(ctx, personId);
  const changed: string[] = [];
  const update: Row = {};

  for (const f of PROFILE_CONTENT_FIELDS) {
    if (f in patch && patch[f] !== undefined && String(patch[f] ?? "") !== String(profile[f] ?? "")) {
      update[f] = patch[f] ?? null;
      changed.push(f);
    }
  }
  if ("visibility" in patch || "is_listed" in patch) {
    if (!opts.isOwner) {
      throw invariantError(
        "INV-01-13",
        "visibility_is_the_speakers_consent",
        "Only the speaker may change what is public about them.",
      );
    }
    if ("visibility" in patch) {
      update.visibility = JSON.stringify(patch.visibility);
      changed.push("visibility");
    }
    if ("is_listed" in patch) {
      update.is_listed = patch.is_listed ? 1 : 0;
      changed.push("is_listed");
    }
  }
  if (changed.length === 0) return;

  update.updated_at = ctx.now();
  update.last_edited_by_person_id = ctx.actor.id ?? personId;
  await ctx.db.update("speaker_profile", str(profile.id), update);

  ctx.events.emit({
    type: "speaker_profile.updated",
    subject: { type: "person", id: personId },
    data: {
      person_id: personId,
      changed_fields: changed,
      edited_by_person_id: ctx.actor.id ?? null,
      edited_by_role: opts.editedByRole,
    },
  });
  ctx.audit.record({
    action: "speaker_profile.update",
    entity_type: "speaker_profile",
    entity_id: str(profile.id),
    after: { changed_fields: changed },
  });
}

export async function replaceProfileLinks(
  ctx: AppContext,
  profileId: string,
  links: { kind: string; url: string; label?: string | null; is_public?: boolean }[],
): Promise<void> {
  for (const l of links) {
    // INV-01-5: absolute https only.
    if (!isAbsoluteHttps(l.url)) {
      throw invariantError("INV-01-5", "invalid_profile_link", `"${l.url}" must be an absolute https URL.`, { url: l.url });
    }
  }
  await ctx.db.hardDelete("profile_link", { speaker_profile_id: profileId });
  await ctx.db.insertMany(
    "profile_link",
    links.map((l, i) => ({
      id: newId("ProfileLink"),
      speaker_profile_id: profileId,
      kind: l.kind,
      url: l.url,
      label: l.label ?? null,
      sort_order: i,
      is_public: l.is_public === false ? 0 : 1,
    })),
  );
}

export async function profileWithCompleteness(ctx: AppContext, personId: string): Promise<Row & { completeness: number; links: Row[] }> {
  const profile = await getOrCreateProfile(ctx, personId);
  const links = await ctx.db.select<Row>("profile_link", { speaker_profile_id: str(profile.id) }, { orderBy: "sort_order" });
  return {
    ...profile,
    links,
    completeness: profileCompleteness({ ...profile, link_count: links.length }),
  };
}

/* -------------------------------------------------------------------------- */
/* Event roster                                                                */
/* -------------------------------------------------------------------------- */

export interface AddParticipantInput {
  event_id: string;
  person_id: string;
  kind: ParticipantKind;
  status: ParticipantStatus;
  source: ParticipantSource;
  portal_access?: "none" | "invited" | "active" | "revoked";
  custom_field_values?: Record<string, unknown>;
}

/**
 * INV-01-11: one `EventParticipant` per `(event, person)`. Membership grants
 * portal sign-in only; it never confers read or write access to any proposal,
 * session, task or review.
 */
export async function addParticipant(ctx: AppContext, input: AddParticipantInput): Promise<Row> {
  const existing = await ctx.db.first<Row>("event_participant", { event_id: input.event_id, person_id: input.person_id });
  const now = ctx.now();
  if (existing) {
    const patch: Row = { updated_at: now };
    // Promotion only: a confirmed participant is not demoted by a later import.
    const order: ParticipantStatus[] = ["prospect", "invited", "confirmed", "declined", "withdrawn"];
    if (order.indexOf(input.status) > order.indexOf(str(existing.status) as ParticipantStatus)) {
      patch.status = input.status;
    }
    if (Object.keys(patch).length > 1) {
      await ctx.db.update("event_participant", str(existing.id), patch);
      if (patch.status) {
        ctx.events.emit({
          type: "event_participant.status_changed",
          subject: { type: "person", id: input.person_id },
          event_id: input.event_id,
          data: {
            participant_id: str(existing.id),
            event_id: input.event_id,
            person_id: input.person_id,
            from: str(existing.status),
            to: patch.status,
          },
        });
      }
    }
    return { ...existing, ...patch };
  }

  const id = newId("EventParticipant");
  const row: Row = {
    id,
    org_id: ctx.orgId,
    event_id: input.event_id,
    person_id: input.person_id,
    kind: input.kind,
    status: input.status,
    source: input.source,
    portal_access: input.portal_access ?? "none",
    custom_field_values: JSON.stringify(input.custom_field_values ?? {}),
    added_by_person_id: ctx.actor.id ?? "system",
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insert("event_participant", row);
  ctx.events.emit({
    type: "event_participant.added",
    subject: { type: "person", id: input.person_id },
    event_id: input.event_id,
    data: {
      participant_id: id,
      event_id: input.event_id,
      person_id: input.person_id,
      kind: input.kind,
      status: input.status,
      source: input.source,
    },
  });
  return row;
}

export async function setParticipantStatus(ctx: AppContext, participantId: string, to: ParticipantStatus): Promise<void> {
  const row = await ctx.db.byId<Row>("event_participant", participantId);
  if (!row) throw notFound("Participant", participantId);
  const from = str(row.status) as ParticipantStatus;
  if (from === to) return;
  if (!canTransitionParticipant(from, to)) {
    throw new DomainError({
      code: "illegal_transition",
      message: `A roster entry cannot move from ${from} to ${to}.`,
      status: 422,
      details: { from, to },
    });
  }
  await ctx.db.update("event_participant", participantId, { status: to, updated_at: ctx.now() });
  ctx.events.emit({
    type: "event_participant.status_changed",
    subject: { type: "person", id: str(row.person_id) },
    event_id: str(row.event_id),
    data: { participant_id: participantId, event_id: str(row.event_id), person_id: str(row.person_id), from, to },
  });
  ctx.audit.record({ action: "event_participant.status_change", entity_type: "event_participant", entity_id: participantId, before: { status: from }, after: { status: to } });
}

export async function invitePortalAccess(ctx: AppContext, participantId: string, baseUrl: string): Promise<CreatedInvitation> {
  const row = await ctx.db.byId<Row>("event_participant", participantId);
  if (!row) throw notFound("Participant", participantId);
  const person = await getPerson(ctx, str(row.person_id));
  const invitation = await createInvitation(
    ctx,
    {
      email: str(person.email),
      kind: "speaker_portal",
      person_id: person.id,
      context_type: "event",
      context_id: str(row.event_id),
    },
    baseUrl,
  );
  await ctx.db.update("event_participant", participantId, {
    portal_access: "invited",
    portal_invited_at: ctx.now(),
    updated_at: ctx.now(),
  });
  ctx.events.emit({
    type: "event_participant.portal_invited",
    subject: { type: "person", id: person.id },
    event_id: str(row.event_id),
    data: {
      participant_id: participantId,
      event_id: str(row.event_id),
      person_id: person.id,
      invitation_id: invitation.id,
    },
  });
  return invitation;
}

/* -------------------------------------------------------------------------- */
/* Person notes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * INV-01-14: note bodies are never exposed to the person they are about, in
 * any role, through any surface. The surface is absent, not redacted.
 */
export async function addPersonNote(
  ctx: AppContext,
  input: { person_id: string; event_id?: string | null; body: string },
): Promise<string> {
  const id = newId("PersonNote");
  await ctx.db.insert("person_note", {
    id,
    org_id: ctx.orgId,
    person_id: input.person_id,
    event_id: input.event_id ?? null,
    body: input.body,
    author_person_id: ctx.actor.id ?? "system",
    created_at: ctx.now(),
  });
  ctx.events.emit({
    type: "person_note.added",
    subject: { type: "person", id: input.person_id },
    data: {
      note_id: id,
      person_id: input.person_id,
      event_id: input.event_id ?? null,
      author_person_id: ctx.actor.id ?? null,
      // body deliberately absent — INV-01-14
    },
  });
  return id;
}

/**
 * INV-01-14: note bodies are never exposed to the person they are about, **in
 * any role**. An admin reading their own record does not see notes about
 * themselves either — the surface is absent, not redacted, because "the only
 * reliable way to prevent it is to make the surface impossible rather than
 * careful".
 */
export function assertNotesNotAboutReader(ctx: AppContext, subjectPersonId: string): void {
  if (ctx.actor.type === "person" && ctx.actor.id && ctx.actor.id === subjectPersonId) {
    throw invariantError(
      "INV-01-14",
      "notes_never_visible_to_subject",
      "Notes about a person are never shown to that person, at any permission level.",
      { person_id: subjectPersonId },
      403,
    );
  }
}

export async function listPersonNotes(ctx: AppContext, personId: string, opts: { eventId?: string | null } = {}): Promise<Row[]> {
  assertNotesNotAboutReader(ctx, personId); // INV-01-14
  const where: Row = { person_id: personId };
  if (opts.eventId) where.event_id = opts.eventId;
  return ctx.db.select<Row>("person_note", where, { orderBy: "created_at DESC" });
}

/* -------------------------------------------------------------------------- */
/* Invitations — the team screen's half                                        */
/* -------------------------------------------------------------------------- */

export async function revokeInvitation(ctx: AppContext, invitationId: string): Promise<void> {
  const inv = await ctx.db.byId<Row>("invitation", invitationId);
  if (!inv) throw notFound("Invitation", invitationId);
  const from = str(inv.status);
  if (from !== "pending") {
    // The `Invitation` diagram draws revoked only from pending.
    throw new DomainError({
      code: "illegal_transition",
      message: `An invitation that is ${from} cannot be revoked.`,
      status: 422,
      details: { from, to: "revoked" },
    });
  }
  await ctx.db.update("invitation", invitationId, { status: "revoked" });
  ctx.audit.record({ action: "invitation.revoke", entity_type: "invitation", entity_id: invitationId, before: { status: from } });
}

export async function listInvitations(ctx: AppContext, opts: { status?: string | null } = {}): Promise<Row[]> {
  const where: Row = {};
  if (opts.status) where.status = opts.status;
  const rows = await ctx.db.select<Row>("invitation", where, { orderBy: "created_at DESC", limit: 200 });
  const now = ctx.now();
  // `pending` past `expires_at` reads as expired even before the sweeper runs.
  return rows.map((r) => (str(r.status) === "pending" && str(r.expires_at) <= now ? { ...r, status: "expired" } : r));
}

export interface TeamRow {
  grant: Row;
  person: PersonRow | null;
  granted_by: PersonRow | null;
}

/**
 * `/admin/team` — every `RoleGrant` with its person, role, scope, who granted
 * it and when it expires. Grants are org-, event- or track-scoped (INV-01-6),
 * so the scope is resolved to a name here rather than shown as a raw ulid.
 */
export async function listTeam(ctx: AppContext): Promise<{ rows: TeamRow[]; scopeNames: Record<string, string>; ownerCount: number }> {
  const grants = await ctx.db.select<Row>("role_grant", {}, { orderBy: "granted_at DESC" });
  const peopleIds = [...new Set(grants.flatMap((g) => [str(g.person_id), str(g.granted_by_person_id)]).filter(Boolean))];
  const people = peopleIds.length ? await ctx.db.select<PersonRow>("person", { id: peopleIds }, { includeDeleted: true }) : [];
  const byId = new Map(people.map((p) => [p.id, p]));

  const scopeNames: Record<string, string> = { [ctx.orgId]: "the whole organization" };
  const eventIds = grants.filter((g) => str(g.scope_type) === "event").map((g) => str(g.scope_id));
  const trackIds = grants.filter((g) => str(g.scope_type) === "track").map((g) => str(g.scope_id));
  if (eventIds.length) {
    for (const e of await ctx.db.select<Row>("event", { id: [...new Set(eventIds)] })) scopeNames[str(e.id)] = str(e.name);
  }
  if (trackIds.length) {
    for (const t of await ctx.db.raw<Row>(
      `SELECT id, name FROM track WHERE id IN (${[...new Set(trackIds)].map(() => "?").join(",")})`,
      [...new Set(trackIds)],
    )) {
      scopeNames[str(t.id)] = str(t.name);
    }
  }

  const now = ctx.now();
  const ownerCount = grants.filter((g) => str(g.role) === "owner" && !g.revoked_at && (!g.expires_at || str(g.expires_at) > now)).length;
  return {
    rows: grants.map((g) => ({
      grant: g,
      person: byId.get(str(g.person_id)) ?? null,
      granted_by: byId.get(str(g.granted_by_person_id)) ?? null,
    })),
    scopeNames,
    ownerCount,
  };
}

export function grantIsActive(grant: Row, now: string): boolean {
  if (grant.revoked_at) return false;
  if (grant.expires_at && str(grant.expires_at) <= now) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Merge candidates                                                            */
/* -------------------------------------------------------------------------- */

export interface MergeCandidateView {
  person_id: string;
  candidate_person_id: string;
  signals: string[];
  confidence: number;
  other: PersonRow | null;
}

export async function mergeCandidatesFor(ctx: AppContext, personId: string): Promise<MergeCandidateView[]> {
  const rows = await ctx.db.raw<Row>(
    `SELECT * FROM person_merge_candidate
      WHERE org_id = ? AND (person_id = ? OR candidate_person_id = ?) AND dismissed_at IS NULL`,
    [ctx.orgId, personId, personId],
  );
  const out: MergeCandidateView[] = [];
  for (const r of rows) {
    const otherId = str(r.person_id) === personId ? str(r.candidate_person_id) : str(r.person_id);
    const other = await ctx.db.byId<PersonRow>("person", otherId);
    out.push({
      person_id: str(r.person_id),
      candidate_person_id: str(r.candidate_person_id),
      signals: parseJson<string[]>(r.signals, []),
      confidence: num(r.confidence),
      other,
    });
  }
  return out;
}

/** "A dismissal is remembered so the same pair is not offered forever" (01). */
export async function dismissMergeCandidate(ctx: AppContext, aId: string, bId: string): Promise<void> {
  const [a, b] = [aId, bId].sort();
  await ctx.db.rawRun(
    `UPDATE person_merge_candidate SET dismissed_by_person_id = ?, dismissed_at = ?
      WHERE org_id = ? AND person_id = ? AND candidate_person_id = ?`,
    [ctx.actor.id ?? null, ctx.now(), ctx.orgId, a, b],
  );
  ctx.audit.record({ action: "person.merge_candidate_dismiss", entity_type: "person", entity_id: a, after: { candidate_person_id: b } });
}

/**
 * What a merge will repoint, counted before it happens. The merge screen shows
 * this because "a wrong merge exposes one person's proposals to another" (01),
 * and a confirmation step with nothing on it is not a confirmation.
 */
export async function mergeImpact(ctx: AppContext, losingPersonId: string): Promise<Record<string, number>> {
  const counts: [string, string, string][] = [
    ["proposals submitted", "proposal", "submitter_person_id"],
    ["proposals credited on", "proposal_speaker", "person_id"],
    ["sessions credited on", "session_speaker", "person_id"],
    ["roster rows", "event_participant", "person_id"],
    ["onboarding tasks", "task_instance", "assignee_person_id"],
    ["review assignments", "review_assignment", "reviewer_person_id"],
    ["reviews written", "review", "reviewer_person_id"],
    ["sponsor contact rows", "sponsor_contact", "person_id"],
    ["notes about them", "person_note", "person_id"],
    ["role grants", "role_grant", "person_id"],
    ["sign-in identities", "auth_identity", "person_id"],
    ["prospect cards", "prospect_card", "person_id"],
  ];
  const out: Record<string, number> = {};
  for (const [label, table, column] of counts) {
    const rows = await ctx.db.raw<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [losingPersonId]);
    const n = num(rows[0]?.n);
    if (n > 0) out[label] = n;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Cross-event history                                                         */
/* -------------------------------------------------------------------------- */

export interface SessionGiven {
  session_id: string;
  event_id: string;
  event_name: string;
  starts_on: string;
  title: string;
  status: string;
  track_id: string | null;
}

/** Every session a person is credited on, with its event and date (14). */
export async function sessionsGiven(ctx: AppContext, personId: string): Promise<SessionGiven[]> {
  const rows = await ctx.db.raw<Row>(
    `SELECT s.id, s.title, s.status, s.track_id, s.event_id, e.name AS event_name, e.starts_on
       FROM session_speaker ss
       JOIN session s ON s.id = ss.session_id
       JOIN event e ON e.id = s.event_id
      WHERE ss.person_id = ? AND s.org_id = ? AND s.deleted_at IS NULL
        AND s.status != 'cancelled' AND ss.confirmation_status != 'replaced'
      ORDER BY e.starts_on DESC`,
    [personId, ctx.orgId],
  );
  return rows.map((r) => ({
    session_id: str(r.id),
    event_id: str(r.event_id),
    event_name: str(r.event_name),
    starts_on: str(r.starts_on),
    title: str(r.title),
    status: str(r.status),
    track_id: strOrNull(r.track_id),
  }));
}

export interface ParticipationRow {
  participant: Row;
  event_id: string;
  event_name: string;
  starts_on: string;
}

export async function participationOf(ctx: AppContext, personId: string): Promise<ParticipationRow[]> {
  const rows = await ctx.db.raw<Row>(
    `SELECT ep.*, e.name AS event_name, e.starts_on
       FROM event_participant ep JOIN event e ON e.id = ep.event_id
      WHERE ep.person_id = ? AND ep.org_id = ? AND e.deleted_at IS NULL
      ORDER BY e.starts_on DESC`,
    [personId, ctx.orgId],
  );
  return rows.map((r) => ({ participant: r, event_id: str(r.event_id), event_name: str(r.event_name), starts_on: str(r.starts_on) }));
}

/* -------------------------------------------------------------------------- */
/* EventRoster — the read model in 01                                          */
/* -------------------------------------------------------------------------- */

export interface TaskCompletion {
  completed: number;
  waived: number;
  outstanding: number;
  overdue: number;
}

export const EMPTY_COMPLETION: TaskCompletion = { completed: 0, waived: 0, outstanding: 0, overdue: 0 };

export interface RosterFilters {
  status?: string | null;
  kind?: string | null;
  track_id?: string | null;
  /** `any` — at least one outstanding task; `none` — nothing outstanding. */
  outstanding?: "any" | "none" | null;
  q?: string | null;
}

export interface RosterRow {
  participant: Row;
  person_id: string;
  full_name: string;
  email: string;
  company: string | null;
  job_title: string | null;
  headshot_asset_id: string | null;
  sessions: { id: string; title: string; track_id: string | null; status: string }[];
  /** Derived (INV-11-6): non-cancelled sessions they are credited on. */
  session_count: number;
  /** Derived (INV-11-6): `{completed, waived, outstanding, overdue}`. */
  task_completion: TaskCompletion;
}

/**
 * `EventRoster` (01, "Roster read model") — `EventParticipant` joined with
 * `SpeakerProfile`, session titles and task completion.
 *
 * "It must render completion state at list level — the whole point is not
 * opening 200 records to find the four that are stuck", which is why the
 * derived columns are computed for the whole page in three queries rather than
 * per row.
 */
export async function eventRoster(ctx: AppContext, eventId: string, filters: RosterFilters = {}): Promise<RosterRow[]> {
  const params: unknown[] = [ctx.orgId, eventId];
  let sql = `SELECT ep.*, p.full_name, p.email, p.display_name, sp.company, sp.job_title, sp.headshot_asset_id
               FROM event_participant ep
               JOIN person p ON p.id = ep.person_id
          LEFT JOIN speaker_profile sp ON sp.person_id = p.id
              WHERE ep.org_id = ? AND ep.event_id = ? AND p.deleted_at IS NULL`;
  if (filters.status) {
    sql += " AND ep.status = ?";
    params.push(filters.status);
  }
  if (filters.kind) {
    sql += " AND ep.kind = ?";
    params.push(filters.kind);
  }
  if (filters.q) {
    // searchable by name, email and company (01)
    sql += " AND (lower(p.full_name) LIKE ? OR lower(p.email) LIKE ? OR lower(COALESCE(sp.company,'')) LIKE ?)";
    const like = `%${filters.q.toLowerCase()}%`;
    params.push(like, like, like);
  }
  sql += " ORDER BY p.full_name";
  const rows = await ctx.db.raw<Row>(sql, params);

  const personIds = rows.map((r) => str(r.person_id));
  const sessionsByPerson = new Map<string, RosterRow["sessions"]>();
  const completionByPerson = new Map<string, TaskCompletion>();
  if (personIds.length > 0) {
    const placeholders = personIds.map(() => "?").join(",");
    const sessionRows = await ctx.db.raw<Row>(
      `SELECT ss.person_id, s.id, s.title, s.track_id, s.status
         FROM session_speaker ss JOIN session s ON s.id = ss.session_id
        WHERE s.event_id = ? AND s.org_id = ? AND s.deleted_at IS NULL
          AND s.status != 'cancelled' AND ss.confirmation_status != 'replaced'
          AND ss.person_id IN (${placeholders})`,
      [eventId, ctx.orgId, ...personIds],
    );
    for (const s of sessionRows) {
      const list = sessionsByPerson.get(str(s.person_id)) ?? [];
      list.push({ id: str(s.id), title: str(s.title), track_id: strOrNull(s.track_id), status: str(s.status) });
      sessionsByPerson.set(str(s.person_id), list);
    }
    const taskRows = await ctx.db.raw<Row>(
      `SELECT assignee_person_id, status, due_at FROM task_instance
        WHERE org_id = ? AND event_id = ? AND assignee_person_id IN (${placeholders})`,
      [ctx.orgId, eventId, ...personIds],
    );
    const now = ctx.now();
    for (const t of taskRows) {
      const key = str(t.assignee_person_id);
      const c = completionByPerson.get(key) ?? { ...EMPTY_COMPLETION };
      const status = str(t.status);
      if (status === "completed") c.completed++;
      else if (status === "waived") c.waived++;
      else if (status !== "cancelled") {
        c.outstanding++;
        if (status === "overdue" || (t.due_at && str(t.due_at) < now)) c.overdue++;
      }
      completionByPerson.set(key, c);
    }
  }

  let out: RosterRow[] = rows.map((r) => {
    const personId = str(r.person_id);
    const sessions = sessionsByPerson.get(personId) ?? [];
    return {
      participant: r,
      person_id: personId,
      full_name: str(r.full_name),
      email: str(r.email),
      company: strOrNull(r.company),
      job_title: strOrNull(r.job_title),
      headshot_asset_id: strOrNull(r.headshot_asset_id),
      sessions,
      session_count: sessions.length,
      task_completion: completionByPerson.get(personId) ?? { ...EMPTY_COMPLETION },
    };
  });

  if (filters.track_id) out = out.filter((r) => r.sessions.some((s) => s.track_id === filters.track_id));
  if (filters.outstanding === "any") out = out.filter((r) => r.task_completion.outstanding > 0);
  if (filters.outstanding === "none") out = out.filter((r) => r.task_completion.outstanding === 0);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Headshot upload                                                             */
/* -------------------------------------------------------------------------- */

const HEADSHOT_MAX_BYTES = 8 * 1024 * 1024;
const HEADSHOT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];

function sanitiseFilename(name: string): string {
  return (name || "headshot").replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A headshot is an `Asset` in the slot `person:<id>:headshot` (11, "Assets").
 *
 * INV-11-9: re-uploading never overwrites — it creates `version = max + 1` with
 * `supersedes_asset_id` set, and every prior version stays listed and
 * retrievable. Bytes go to R2 through the binding; nothing about the file is
 * trusted from the client (`content_type` and `size_bytes` are measured here).
 */
export async function storeHeadshot(ctx: AppContext, personId: string, file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) throw new DomainError({ code: "empty_upload", message: "That file was empty.", status: 422 });
  if (buffer.byteLength > HEADSHOT_MAX_BYTES) {
    throw new DomainError({ code: "file_too_large", message: "A headshot must be 8 MB or smaller.", status: 422 });
  }
  const contentType = file.type || "application/octet-stream";
  if (!HEADSHOT_TYPES.includes(contentType)) {
    throw new DomainError({
      code: "unsupported_media_type",
      message: `A headshot must be a JPEG, PNG, WebP or AVIF image (that one is ${contentType}).`,
      status: 422,
    });
  }

  const slotKey = `person:${personId}:headshot`;
  const prior = await ctx.db.raw<Row>(
    "SELECT id, version FROM asset WHERE slot_key = ? AND org_id = ? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    [slotKey, ctx.orgId],
  );
  const version = num(prior[0]?.version, 0) + 1;
  const id = newId("Asset");
  const filename = sanitiseFilename(file.name);
  const storageKey = `${ctx.orgId}/person/${personId}/headshot/${version}/${filename}`;
  await ctx.env.ASSETS_BUCKET.put(storageKey, buffer, { httpMetadata: { contentType } });

  await ctx.db.insert("asset", {
    id,
    org_id: ctx.orgId,
    storage_key: storageKey,
    filename,
    content_type: contentType,
    size_bytes: buffer.byteLength,
    checksum: await sha256Hex(buffer),
    scan_status: "pending", // INV-11-3: the content context clears it before any public surface uses it.
    visibility: "public",
    uploaded_by_person_id: ctx.actor.id ?? personId,
    purpose: "headshot",
    slot_key: slotKey,
    version,
    supersedes_asset_id: prior[0] ? str(prior[0].id) : null,
    created_at: ctx.now(),
  });
  ctx.events.emit({
    type: "asset.uploaded",
    subject: { type: "asset", id },
    data: {
      asset_id: id,
      slot_key: slotKey,
      version,
      purpose: "headshot",
      filename,
      size_bytes: buffer.byteLength,
      uploaded_by_person_id: ctx.actor.id ?? personId,
    },
  });
  if (prior[0]) {
    ctx.events.emit({
      type: "asset.version_superseded",
      subject: { type: "asset", id },
      data: { asset_id: id, superseded_asset_id: str(prior[0].id), slot_key: slotKey, version },
    });
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* The person record                                                           */
/* -------------------------------------------------------------------------- */

export interface PersonRecord {
  person: PersonRow;
  profile: Row & { completeness: number; links: Row[] };
  participation: ParticipationRow[];
  sessions: SessionGiven[];
  notes: Row[];
  note_authors: Record<string, string>;
  merge_candidates: MergeCandidateView[];
  tags: string[];
  custom_field_values: Record<string, unknown>;
}

export async function personRecord(ctx: AppContext, personId: string): Promise<PersonRecord> {
  const person = await getPerson(ctx, personId);
  const [profile, participation, sessions, merge_candidates] = await Promise.all([
    profileWithCompleteness(ctx, person.id),
    participationOf(ctx, person.id),
    sessionsGiven(ctx, person.id),
    mergeCandidatesFor(ctx, person.id),
  ]);
  // INV-01-14: absent, not redacted, when the reader is the subject.
  const notes = ctx.actor.id === person.id ? [] : await ctx.db.select<Row>("person_note", { person_id: person.id }, { orderBy: "created_at DESC" });
  const authorIds = [...new Set(notes.map((n) => str(n.author_person_id)).filter(Boolean))];
  const authors = authorIds.length ? await ctx.db.select<PersonRow>("person", { id: authorIds }, { includeDeleted: true }) : [];
  return {
    person,
    profile,
    participation,
    sessions,
    notes,
    note_authors: Object.fromEntries(authors.map((a) => [a.id, personDisplayName(a)])),
    merge_candidates,
    tags: parseJson<string[]>(person.tags, []),
    custom_field_values: parseJson<Record<string, unknown>>(person.custom_field_values, {}),
  };
}

/** Org-level labels that persist across events (01, `Person.tags`). */
/** The directory fields staff may correct. `email` is absent deliberately — see below. */
export const PERSON_EDITABLE_FIELDS = ["full_name", "display_name", "pronouns", "timezone", "locale"] as const;

/**
 * Correct a person's directory record.
 *
 * `email` is not here. It is unique per org (INV-01-1) and is what
 * authentication resolves against, so changing it is an identity operation with
 * its own path, not a field edit.
 *
 * Emits `person.updated` carrying **field names only**. A payload quoting the
 * new value would put a name and a timezone into the webhook fan-out, where a
 * different consumer's redaction rules apply (INV-11-4) — the same reason
 * `speaker_profile.updated` has always carried `changed_fields[]` and nothing else.
 */
export async function updatePersonDetails(
  ctx: AppContext,
  personId: string,
  patch: Record<string, unknown>,
): Promise<string[]> {
  const person = await getPerson(ctx, personId);
  const update: Row = {};
  const changed: string[] = [];

  for (const f of PERSON_EDITABLE_FIELDS) {
    if (!(f in patch)) continue;
    const next = patch[f] === "" || patch[f] === undefined ? null : patch[f];
    if (String(next ?? "") === String(person[f] ?? "")) continue;
    update[f] = next;
    changed.push(f);
  }

  if ("tags" in patch) {
    const raw = patch.tags;
    const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    const clean = [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    if (JSON.stringify(clean) !== JSON.stringify(parseJson<string[]>(person.tags, []))) {
      update.tags = JSON.stringify(clean);
      changed.push("tags");
    }
  }

  if (changed.length === 0) return [];

  update.updated_at = ctx.now();
  await ctx.db.update("person", personId, update);

  ctx.events.emit({
    type: "person.updated",
    subject: { type: "person", id: personId },
    data: { person_id: personId, changed_fields: changed, edited_by_person_id: ctx.actor.id ?? null },
  });
  ctx.audit.record({
    action: "person.update",
    entity_type: "person",
    entity_id: personId,
    before: Object.fromEntries(changed.map((f) => [f, person[f] ?? null])),
    after: Object.fromEntries(changed.map((f) => [f, update[f] ?? null])),
  });
  return changed;
}

export async function setPersonTags(ctx: AppContext, personId: string, tags: string[]): Promise<void> {
  await updatePersonDetails(ctx, personId, { tags });
}
