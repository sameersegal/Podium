/**
 * Sponsorship — 03-sponsorship.md.
 *
 * Aggregate roots: `Sponsor`, `SponsorshipTier`. `Sponsorship`, `Entitlement`
 * and `SponsorContact` change through them.
 *
 * The one idea the whole context turns on: **consumption is a hold, not a
 * decrement**. `Entitlement.consumed_count` and `remaining` are derived from the
 * proposals pointing at the entitlement and have no column (INV-11-6) — every
 * read goes through `entitlementUsage`.
 */

import type { AppContext } from "@podiumstack/data/context.js";
import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import { DomainError, invariantError, notFound } from "@podiumstack/domain/shared/errors.js";
import { newId, slugify } from "@podiumstack/domain/shared/ids.js";
import { addDays } from "@podiumstack/domain/shared/time.js";
import {
  checkMaySubmitForSponsor,
  checkQuantityReduction,
  checkSponsorDeletable,
  checkSponsorNotBlocked,
  checkSponsorshipUsable,
  entitlementState,
  expiringSoon,
  isPubliclyVisible,
  usageOf,
  type ContactRole,
  type EntitlementCounts,
  type EntitlementSource,
  type EntitlementType,
  type EntitlementUsage,
  type RuleFailure,
  type SponsorStatus,
} from "@podiumstack/domain/sponsorship/types.js";
import { RELEASED_STATUSES } from "@podiumstack/domain/submissions/types.js";

/* -------------------------------------------------------------------------- */
/* Rule failures become typed errors                                           */
/* -------------------------------------------------------------------------- */

export function raise(failure: RuleFailure): never {
  throw invariantError(failure.invariant, failure.code, failure.message, failure.details);
}

export function raiseIf(failure: RuleFailure | null): void {
  if (failure) raise(failure);
}

/* -------------------------------------------------------------------------- */
/* Sponsor                                                                     */
/* -------------------------------------------------------------------------- */

export interface SponsorInput {
  name: string;
  display_name?: string | null;
  slug?: string | null;
  website_url?: string | null;
  description?: string | null;
  industry_tags?: string[];
  internal_notes?: string | null;
  status?: SponsorStatus;
  logo_asset_id?: string | null;
  logo_dark_asset_id?: string | null;
}

export async function createSponsor(app: AppContext, input: SponsorInput): Promise<Row> {
  const id = newId("Sponsor");
  const now = app.now();
  const slug = await uniqueSponsorSlug(app, input.slug || slugify(input.name));
  const row: Row = {
    id,
    name: input.name.trim(),
    display_name: input.display_name ?? null,
    slug,
    website_url: input.website_url ?? null,
    logo_asset_id: input.logo_asset_id ?? null,
    logo_dark_asset_id: input.logo_dark_asset_id ?? null,
    description: input.description ?? null,
    industry_tags: JSON.stringify(input.industry_tags ?? []),
    internal_notes: input.internal_notes ?? null,
    status: input.status ?? "prospect",
    created_at: now,
    updated_at: now,
    row_version: 1,
  };
  await app.db.insert("sponsor", row);
  app.events.emit({
    type: "sponsor.created",
    subject: { type: "sponsor", id },
    data: { sponsor_id: id, name: row.name, slug },
  });
  app.audit.record({ action: "sponsor.create", entity_type: "sponsor", entity_id: id, after: { name: row.name, slug } });
  return row;
}

async function uniqueSponsorSlug(app: AppContext, base: string): Promise<string> {
  let slug = slugify(base);
  for (let i = 2; i < 50; i++) {
    const clash = await app.db.first<Row>("sponsor", { slug });
    if (!clash) return slug;
    slug = `${slugify(base)}-${i}`;
  }
  return `${slugify(base)}-${Date.now()}`;
}

export async function getSponsor(app: AppContext, sponsorId: string): Promise<Row> {
  const row = await app.db.byId<Row>("sponsor", sponsorId);
  if (!row) throw notFound("Sponsor", sponsorId);
  return row;
}

export async function updateSponsor(app: AppContext, sponsorId: string, patch: Partial<SponsorInput>): Promise<void> {
  const before = await getSponsor(app, sponsorId);
  const values: Row = { updated_at: app.now() };
  for (const key of ["name", "display_name", "website_url", "description", "internal_notes", "status", "logo_asset_id", "logo_dark_asset_id"] as const) {
    if (key in patch) values[key] = (patch as Record<string, unknown>)[key] ?? null;
  }
  if (patch.industry_tags) values.industry_tags = JSON.stringify(patch.industry_tags);
  // INV-11-8: `slug` is immutable once public; renames issue a redirect record.
  await app.db.update("sponsor", sponsorId, values);
  app.audit.record({
    action: "sponsor.update",
    entity_type: "sponsor",
    entity_id: sponsorId,
    before: { name: before.name, status: before.status },
    after: values,
  });
}

/**
 * INV-03-9 — deleting a sponsor is a soft delete (INV-11-2) and is refused
 * while any spent entitlement is attached to a non-cancelled session.
 */
export async function softDeleteSponsor(app: AppContext, sponsorId: string, reason: string): Promise<void> {
  const sponsor = await getSponsor(app, sponsorId);
  const live = await app.db.raw<{ session_id: string }>(
    `SELECT s.id AS session_id
       FROM session s
      WHERE s.sponsor_id = ? AND s.status != 'cancelled' AND s.deleted_at IS NULL`,
    [sponsorId],
  );
  raiseIf(checkSponsorDeletable(str(sponsor.name), live.map((r) => r.session_id)));
  await app.db.softDelete("sponsor", sponsorId, app.now());
  app.audit.record({
    action: "sponsor.delete",
    entity_type: "sponsor",
    entity_id: sponsorId,
    before: { name: sponsor.name },
    reason,
  });
}

/* -------------------------------------------------------------------------- */
/* SponsorshipTier + TierEntitlementTemplate                                   */
/* -------------------------------------------------------------------------- */

export interface TierInput {
  name: string;
  slug?: string | null;
  level?: number;
  description?: string | null;
  is_public?: boolean;
  sort_order?: number;
}

export async function createTier(app: AppContext, eventId: string, input: TierInput): Promise<Row> {
  const id = newId("SponsorshipTier");
  const row: Row = {
    id,
    event_id: eventId,
    name: input.name.trim(),
    slug: slugify(input.slug || input.name),
    level: input.level ?? 0,
    description: input.description ?? null,
    is_public: input.is_public === false ? 0 : 1,
    sort_order: input.sort_order ?? 0,
  };
  await app.db.insert("sponsorship_tier", row);
  app.audit.record({ action: "sponsorship_tier.create", entity_type: "sponsorship_tier", entity_id: id, after: row });
  return row;
}

export async function updateTier(app: AppContext, tierId: string, patch: Partial<TierInput>): Promise<void> {
  const values: Row = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.level !== undefined) values.level = patch.level;
  if (patch.description !== undefined) values.description = patch.description ?? null;
  if (patch.is_public !== undefined) values.is_public = patch.is_public ? 1 : 0;
  if (patch.sort_order !== undefined) values.sort_order = patch.sort_order;
  if (Object.keys(values).length === 0) return;
  await app.db.update("sponsorship_tier", tierId, values);
  app.audit.record({ action: "sponsorship_tier.update", entity_type: "sponsorship_tier", entity_id: tierId, after: values });
}

export interface TemplateInput {
  entitlement_type: EntitlementType;
  quantity: number;
  allowed_format_ids?: string[];
  constraints?: Record<string, unknown> | null;
  notes?: string | null;
}

export async function addTierTemplate(app: AppContext, tierId: string, input: TemplateInput): Promise<Row> {
  const id = newId("TierEntitlementTemplate");
  const row: Row = {
    id,
    tier_id: tierId,
    entitlement_type: input.entitlement_type,
    quantity: Math.max(0, Math.round(input.quantity)),
    allowed_format_ids: JSON.stringify(input.allowed_format_ids ?? []),
    constraints: input.constraints ? JSON.stringify(input.constraints) : null,
    notes: input.notes ?? null,
  };
  await app.db.insert("tier_entitlement_template", row);
  app.audit.record({ action: "tier_entitlement_template.create", entity_type: "tier_entitlement_template", entity_id: id, after: row });
  return row;
}

export async function removeTierTemplate(app: AppContext, templateId: string): Promise<void> {
  // Templates are configuration, not content: nothing references them once
  // copied onto a sponsorship, so this is a real delete.
  await app.db.hardDelete("tier_entitlement_template", { id: templateId });
  app.audit.record({ action: "tier_entitlement_template.delete", entity_type: "tier_entitlement_template", entity_id: templateId });
}

export async function tierTemplates(app: AppContext, tierId: string): Promise<Row[]> {
  return app.db.select<Row>("tier_entitlement_template", { tier_id: tierId });
}

/**
 * Copy an event's rate card onto another event (02, "Cloning an edition").
 *
 * The tiers and their entitlement templates, never a `Sponsorship` or an
 * `Entitlement` (INV-02-14): the package is configuration, the deal is a fact
 * about a company that has not signed anything for the new event yet.
 *
 * `allowed_format_ids` is remapped through `formatIds` — a template pointing at
 * last year's `SessionFormat` would silently allow nothing (INV-02-17 is the
 * same rule for CFP options). A format with no counterpart is dropped from the
 * list rather than carried across the event boundary.
 */
export async function copyTiersToEvent(
  app: AppContext,
  fromEventId: string,
  toEventId: string,
  formatIds: Map<string, string>,
): Promise<Row[]> {
  const source = await app.db.select<Row>("sponsorship_tier", { event_id: fromEventId }, { orderBy: "sort_order, level DESC" });
  const created: Row[] = [];
  for (const [i, t] of source.entries()) {
    const tier = await createTier(app, toEventId, {
      name: str(t.name),
      slug: str(t.slug),
      level: num(t.level),
      description: strOrNull(t.description),
      is_public: bool(t.is_public),
      sort_order: num(t.sort_order, i),
    });
    for (const tpl of await tierTemplates(app, str(t.id))) {
      await addTierTemplate(app, str(tier.id), {
        entitlement_type: str(tpl.entitlement_type) as EntitlementType,
        quantity: num(tpl.quantity),
        allowed_format_ids: parseJson<string[]>(tpl.allowed_format_ids, [])
          .map((id) => formatIds.get(id))
          .filter((id): id is string => Boolean(id)),
        constraints: parseJson<Record<string, unknown> | null>(tpl.constraints, null),
        notes: strOrNull(tpl.notes),
      });
    }
    created.push(tier);
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/* Sponsorship                                                                 */
/* -------------------------------------------------------------------------- */

export interface SponsorshipInput {
  sponsor_id: string;
  event_id: string;
  tier_id?: string | null;
  contract_reference?: string | null;
  public_from?: string | null;
  internal_notes?: string | null;
  sort_order_override?: number | null;
  /** Copy the tier's `TierEntitlementTemplate`s into concrete entitlements. */
  apply_tier_entitlements?: boolean;
}

/**
 * INV-03-1 — one `Sponsorship` per `(sponsor, event)`.
 * INV-03-7 — a blocked sponsor may not hold new entitlements.
 */
export async function createSponsorship(app: AppContext, input: SponsorshipInput): Promise<Row> {
  const sponsor = await getSponsor(app, input.sponsor_id);
  raiseIf(checkSponsorNotBlocked({ name: str(sponsor.name), status: str(sponsor.status) })); // INV-03-7

  const existing = await app.db.first<Row>("sponsorship", { sponsor_id: input.sponsor_id, event_id: input.event_id });
  if (existing) {
    throw invariantError(
      "INV-03-1",
      "sponsorship_exists",
      `${str(sponsor.name)} already has a sponsorship for this event.`,
      { sponsorship_id: str(existing.id) },
      409,
    );
  }

  const id = newId("Sponsorship");
  const now = app.now();
  const row: Row = {
    id,
    sponsor_id: input.sponsor_id,
    event_id: input.event_id,
    tier_id: input.tier_id ?? null,
    status: "pending",
    confirmed_at: null,
    contract_reference: input.contract_reference ?? null,
    public_from: input.public_from ?? null,
    internal_notes: input.internal_notes ?? null,
    sort_order_override: input.sort_order_override ?? null,
    created_at: now,
    updated_at: now,
    row_version: 1,
  };
  await app.db.insert("sponsorship", row);
  app.audit.record({ action: "sponsorship.create", entity_type: "sponsorship", entity_id: id, after: row });

  if (input.tier_id && input.apply_tier_entitlements !== false) {
    await applyTierToSponsorship(app, id, input.tier_id);
  }
  return row;
}

export async function getSponsorship(app: AppContext, sponsorshipId: string): Promise<Row> {
  const row = await app.db.byId<Row>("sponsorship", sponsorshipId);
  if (!row) throw notFound("Sponsorship", sponsorshipId);
  return row;
}

/**
 * 03, `TierEntitlementTemplate`: "Applying a tier to a sponsorship copies these
 * into concrete `Entitlement` rows — a copy, not a reference, because deals get
 * negotiated and the copy is then edited without rewriting the tier for
 * everyone else."
 */
export async function applyTierToSponsorship(app: AppContext, sponsorshipId: string, tierId: string): Promise<Row[]> {
  const sponsorship = await getSponsorship(app, sponsorshipId);
  const templates = await tierTemplates(app, tierId);
  const existing = await app.db.select<Row>("entitlement", { sponsorship_id: sponsorshipId });
  const alreadyFromTemplate = new Set(
    existing.filter((e) => str(e.source) === "tier_template").map((e) => str(e.entitlement_type)),
  );

  if (str(sponsorship.tier_id) !== tierId) {
    await app.db.update("sponsorship", sponsorshipId, { tier_id: tierId, updated_at: app.now() });
  }

  const created: Row[] = [];
  for (const t of templates) {
    // Re-applying a tier does not double the grant.
    if (alreadyFromTemplate.has(str(t.entitlement_type))) continue;
    created.push(
      await grantEntitlement(app, sponsorshipId, {
        entitlement_type: str(t.entitlement_type) as EntitlementType,
        quantity: num(t.quantity),
        allowed_format_ids: parseJson<string[]>(t.allowed_format_ids, []),
        constraints: parseJson<Record<string, unknown> | null>(t.constraints, null),
        notes: strOrNull(t.notes),
        source: "tier_template",
      }),
    );
  }
  app.audit.record({
    action: "sponsorship.apply_tier",
    entity_type: "sponsorship",
    entity_id: sponsorshipId,
    after: { tier_id: tierId, granted: created.length },
  });
  return created;
}

/** `pending -> confirmed`. Only a confirmed sponsorship may spend (INV-03-2). */
export async function confirmSponsorship(app: AppContext, sponsorshipId: string): Promise<void> {
  const sponsorship = await getSponsorship(app, sponsorshipId);
  const from = str(sponsorship.status);
  if (from === "confirmed") return;
  if (from !== "pending") {
    throw new DomainError({
      code: "illegal_transition",
      message: `A ${from} sponsorship cannot be confirmed.`,
      status: 422,
      details: { from, to: "confirmed" },
    });
  }
  const sponsor = await getSponsor(app, str(sponsorship.sponsor_id));
  raiseIf(checkSponsorNotBlocked({ name: str(sponsor.name), status: str(sponsor.status) })); // INV-03-7

  const now = app.now();
  await app.db.update("sponsorship", sponsorshipId, { status: "confirmed", confirmed_at: now, updated_at: now });
  app.events.emit({
    type: "sponsorship.confirmed",
    subject: { type: "sponsorship", id: sponsorshipId },
    event_id: str(sponsorship.event_id),
    data: {
      sponsorship_id: sponsorshipId,
      sponsor_id: str(sponsorship.sponsor_id),
      event_id: str(sponsorship.event_id),
      tier_id: strOrNull(sponsorship.tier_id),
    },
  });
  app.audit.record({
    action: "sponsorship.confirm",
    entity_type: "sponsorship",
    entity_id: sponsorshipId,
    before: { status: from },
    after: { status: "confirmed" },
  });
}

export async function cancelSponsorship(app: AppContext, sponsorshipId: string, reason: string): Promise<void> {
  const sponsorship = await getSponsorship(app, sponsorshipId);
  const from = str(sponsorship.status);
  if (from === "cancelled") return;
  await app.db.update("sponsorship", sponsorshipId, { status: "cancelled", updated_at: app.now() });
  app.events.emit({
    type: "sponsorship.cancelled",
    subject: { type: "sponsorship", id: sponsorshipId },
    event_id: str(sponsorship.event_id),
    data: { sponsorship_id: sponsorshipId, reason },
  });
  app.audit.record({
    action: "sponsorship.cancel",
    entity_type: "sponsorship",
    entity_id: sponsorshipId,
    before: { status: from },
    after: { status: "cancelled" },
    reason, // INV-11-5
  });
}

export async function updateSponsorship(
  app: AppContext,
  sponsorshipId: string,
  patch: { contract_reference?: string | null; public_from?: string | null; internal_notes?: string | null; sort_order_override?: number | null },
): Promise<void> {
  const values: Row = { updated_at: app.now() };
  for (const key of ["contract_reference", "public_from", "internal_notes", "sort_order_override"] as const) {
    if (key in patch) values[key] = (patch as Record<string, unknown>)[key] ?? null;
  }
  await app.db.update("sponsorship", sponsorshipId, values);
  app.audit.record({ action: "sponsorship.update", entity_type: "sponsorship", entity_id: sponsorshipId, after: values });
}

/* -------------------------------------------------------------------------- */
/* Entitlement                                                                 */
/* -------------------------------------------------------------------------- */

export interface EntitlementInput {
  entitlement_type: EntitlementType;
  quantity: number;
  allowed_format_ids?: string[];
  constraints?: Record<string, unknown> | null;
  submission_deadline?: string | null;
  expires_at?: string | null;
  source?: EntitlementSource;
  notes?: string | null;
}

export async function grantEntitlement(app: AppContext, sponsorshipId: string, input: EntitlementInput): Promise<Row> {
  const sponsorship = await getSponsorship(app, sponsorshipId);
  const sponsor = await getSponsor(app, str(sponsorship.sponsor_id));
  raiseIf(checkSponsorNotBlocked({ name: str(sponsor.name), status: str(sponsor.status) })); // INV-03-7

  const id = newId("Entitlement");
  const now = app.now();
  const row: Row = {
    id,
    sponsorship_id: sponsorshipId,
    entitlement_type: input.entitlement_type,
    quantity: Math.max(0, Math.round(input.quantity)),
    allowed_format_ids: JSON.stringify(input.allowed_format_ids ?? []),
    constraints: input.constraints ? JSON.stringify(input.constraints) : null,
    submission_deadline: input.submission_deadline ?? null,
    expires_at: input.expires_at ?? null,
    source: input.source ?? "manual",
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
    row_version: 1,
  };
  await app.db.insert("entitlement", row);
  app.events.emit({
    type: "entitlement.granted",
    subject: { type: "entitlement", id },
    event_id: str(sponsorship.event_id),
    data: {
      entitlement_id: id,
      sponsorship_id: sponsorshipId,
      entitlement_type: input.entitlement_type,
      quantity: row.quantity,
      source: row.source,
    },
  });
  app.audit.record({ action: "entitlement.grant", entity_type: "entitlement", entity_id: id, after: row });
  return row;
}

export async function getEntitlement(app: AppContext, entitlementId: string): Promise<Row> {
  const row = await app.db.byId<Row>("entitlement", entitlementId);
  if (!row) throw notFound("Entitlement", entitlementId);
  return row;
}

/**
 * INV-03-4 — lowering `quantity` below `consumed_count` is refused; the sponsor
 * manager must first release specific proposals. Quantity changes are one of
 * the actions 11-cross-cutting.md requires an audit row for.
 */
export async function updateEntitlement(
  app: AppContext,
  entitlementId: string,
  patch: Partial<EntitlementInput>,
  reason?: string | null,
): Promise<void> {
  const before = await getEntitlement(app, entitlementId);
  const values: Row = { updated_at: app.now() };

  if (patch.quantity !== undefined) {
    const counts = await entitlementCounts(app, entitlementId);
    raiseIf(checkQuantityReduction(entitlementId, Math.round(patch.quantity), counts)); // INV-03-4
    values.quantity = Math.max(0, Math.round(patch.quantity));
  }
  if (patch.allowed_format_ids !== undefined) values.allowed_format_ids = JSON.stringify(patch.allowed_format_ids ?? []);
  if (patch.constraints !== undefined) values.constraints = patch.constraints ? JSON.stringify(patch.constraints) : null;
  if (patch.submission_deadline !== undefined) values.submission_deadline = patch.submission_deadline ?? null;
  if (patch.expires_at !== undefined) values.expires_at = patch.expires_at ?? null;
  if (patch.notes !== undefined) values.notes = patch.notes ?? null;
  if (patch.entitlement_type !== undefined) values.entitlement_type = patch.entitlement_type;

  await app.db.update("entitlement", entitlementId, values);
  app.audit.record({
    action: "entitlement.update",
    entity_type: "entitlement",
    entity_id: entitlementId,
    before: { quantity: before.quantity, expires_at: before.expires_at, submission_deadline: before.submission_deadline },
    after: values,
    reason: reason ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Derived consumption — the heart of the context                              */
/* -------------------------------------------------------------------------- */

interface ProposalHoldRow extends Row {
  id: string;
  entitlement_id: string;
  status: string;
  session_id: string | null;
  last_activity_at: string;
  session_status: string | null;
}

/**
 * R22 — "An entitlement hold is released after 14 days of no activity, with a
 * warning email at 7", configurable per event as
 * `Event.settings.sponsorship.draft_abandonment_days`.
 */
export const DEFAULT_DRAFT_ABANDONMENT_DAYS = 14;
export const DRAFT_ABANDONMENT_WARNING_DAYS = 7;

export interface AbandonmentPolicy {
  days: number;
  warning_days: number;
  /** Drafts with `last_activity_at` at or before this instant are abandoned. */
  cutoff: string;
  warning_cutoff: string;
}

export async function abandonmentPolicy(app: AppContext, eventId: string, now = app.now()): Promise<AbandonmentPolicy> {
  const ev = await app.db.byId<Row>("event", eventId);
  const settings = parseJson<Record<string, unknown>>(ev?.settings, {});
  const sponsorship = (settings.sponsorship ?? {}) as Record<string, unknown>;
  const raw = Number(sponsorship.draft_abandonment_days);
  const days = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_DRAFT_ABANDONMENT_DAYS;
  const warning = Math.min(DRAFT_ABANDONMENT_WARNING_DAYS, Math.max(1, days - 1));
  return {
    days,
    warning_days: warning,
    cutoff: addDays(now, -days),
    warning_cutoff: addDays(now, -warning),
  };
}

/**
 * 03 — "`consumed_count` is therefore derived from the proposals pointing at
 * the entitlement, never a hand-maintained counter."
 *
 * A proposal counts as **spent** once it is on a non-cancelled session, as
 * **held** while it is alive, and as neither once it is withdrawn, rejected,
 * expired, or abandoned past the timeout (the `held --> available` edge in 03's
 * diagram reads "draft withdrawn / abandoned / rejected").
 */
export async function entitlementCounts(
  app: AppContext,
  entitlementId: string,
  excludeProposalId?: string | null,
): Promise<EntitlementCounts> {
  const map = await entitlementCountsFor(app, [entitlementId], excludeProposalId);
  return map.get(entitlementId) ?? { held_count: 0, spent_count: 0 };
}

export async function entitlementCountsFor(
  app: AppContext,
  entitlementIds: string[],
  excludeProposalId?: string | null,
): Promise<Map<string, EntitlementCounts>> {
  const out = new Map<string, EntitlementCounts>();
  for (const id of entitlementIds) out.set(id, { held_count: 0, spent_count: 0 });
  if (entitlementIds.length === 0) return out;

  const placeholders = entitlementIds.map(() => "?").join(",");
  const rows = await app.db.raw<ProposalHoldRow>(
    `SELECT p.id, p.entitlement_id, p.status, p.session_id, p.last_activity_at, p.event_id,
            s.status AS session_status
       FROM proposal p
       LEFT JOIN session s ON s.id = p.session_id AND s.deleted_at IS NULL
      WHERE p.deleted_at IS NULL AND p.entitlement_id IN (${placeholders})`,
    [...entitlementIds],
  );

  // One policy lookup per distinct event, not per proposal.
  const policies = new Map<string, AbandonmentPolicy>();
  for (const r of rows) {
    const eventId = str(r.event_id);
    if (!policies.has(eventId)) policies.set(eventId, await abandonmentPolicy(app, eventId));
  }

  for (const r of rows) {
    const counts = out.get(str(r.entitlement_id));
    if (!counts) continue;
    if (excludeProposalId && str(r.id) === excludeProposalId) continue;
    if ((RELEASED_STATUSES as readonly string[]).includes(str(r.status))) continue;
    if (r.session_id && str(r.session_status) !== "cancelled") {
      counts.spent_count += 1;
      continue;
    }
    if (str(r.status) === "draft") {
      const policy = policies.get(str(r.event_id));
      if (policy && str(r.last_activity_at) <= policy.cutoff) continue; // abandoned — hold released
    }
    counts.held_count += 1;
  }
  return out;
}

/** `{quantity, consumed_count, remaining, state}` — every derived field, computed. */
export async function entitlementUsage(app: AppContext, entitlementId: string): Promise<EntitlementUsage> {
  const row = await getEntitlement(app, entitlementId);
  const counts = await entitlementCounts(app, entitlementId);
  return usageOf({ id: entitlementId, quantity: num(row.quantity), expires_at: strOrNull(row.expires_at) }, counts, app.now());
}

export async function entitlementUsageFor(app: AppContext, rows: Row[]): Promise<Map<string, EntitlementUsage>> {
  const ids = rows.map((r) => str(r.id));
  const counts = await entitlementCountsFor(app, ids);
  const now = app.now();
  const out = new Map<string, EntitlementUsage>();
  for (const r of rows) {
    const id = str(r.id);
    out.set(
      id,
      usageOf(
        { id, quantity: num(r.quantity), expires_at: strOrNull(r.expires_at) },
        counts.get(id) ?? { held_count: 0, spent_count: 0 },
        now,
      ),
    );
  }
  return out;
}

export async function entitlementsForSponsorship(app: AppContext, sponsorshipId: string): Promise<Row[]> {
  return app.db.select<Row>("entitlement", { sponsorship_id: sponsorshipId }, { orderBy: "created_at" });
}

/** Entitlement totals for one sponsorship — the "used / total" the admin screen exists for. */
export interface SponsorshipUsage {
  entitlements: (Row & { usage: EntitlementUsage })[];
  consumed_count: number;
  quantity: number;
  remaining: number;
}

export async function sponsorshipUsage(app: AppContext, sponsorshipId: string): Promise<SponsorshipUsage> {
  const rows = await entitlementsForSponsorship(app, sponsorshipId);
  const usage = await entitlementUsageFor(app, rows);
  const entitlements = rows.map((r) => ({ ...r, usage: usage.get(str(r.id))! }));
  return {
    entitlements,
    quantity: entitlements.reduce((n, e) => n + e.usage.quantity, 0),
    consumed_count: entitlements.reduce((n, e) => n + e.usage.consumed_count, 0),
    remaining: entitlements.reduce((n, e) => n + e.usage.remaining, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Hold · release · spend                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The hold is derived, so "holding" is not a write — it is the emission of the
 * fact that a proposal now points at the entitlement, which is what the nudge
 * jobs and the sponsor portal subscribe to. Emitting it twice for the same
 * proposal is prevented by the reaction log, not by a counter.
 */
export async function emitHold(app: AppContext, entitlementId: string, proposalId: string): Promise<EntitlementUsage> {
  const usage = await entitlementUsage(app, entitlementId);
  const entitlement = await getEntitlement(app, entitlementId);
  const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
  app.events.emit({
    type: "entitlement.held",
    subject: { type: "entitlement", id: entitlementId },
    event_id: str(sponsorship.event_id),
    data: { entitlement_id: entitlementId, proposal_id: proposalId, remaining: usage.remaining },
  });
  return usage;
}

/**
 * Pure event-plus-audit, like `emitHold` — no state guard, so it is the
 * caller's job to call it exactly once per release. INV-04-10 wants the
 * withdraw/reject/expire releases in the same transaction as the proposal
 * transition, so those three call this directly (`submissions/service.ts`);
 * `draft.abandoned` has no such transaction to piggyback on (it is a cron
 * sweep, not a request), so `sponsorship.release_entitlement`
 * (`reactions.ts`) is the only caller for that one path. Never both for the
 * same fact — that produced two `entitlement.released` events per withdrawal.
 */
export async function emitRelease(
  app: AppContext,
  entitlementId: string,
  proposalId: string,
  reason: string,
): Promise<EntitlementUsage> {
  const usage = await entitlementUsage(app, entitlementId);
  const entitlement = await getEntitlement(app, entitlementId);
  const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
  app.events.emit({
    type: "entitlement.released",
    subject: { type: "entitlement", id: entitlementId },
    event_id: str(sponsorship.event_id),
    data: { entitlement_id: entitlementId, proposal_id: proposalId, reason, remaining: usage.remaining },
  });
  app.audit.record({
    action: "entitlement.release",
    entity_type: "entitlement",
    entity_id: entitlementId,
    after: { proposal_id: proposalId, remaining: usage.remaining },
    reason,
  });
  return usage;
}

/**
 * `held --> spent: proposal approved and session created`. Emits
 * `entitlement.spent`, and `entitlement.exhausted` when the last slot goes —
 * the two hooks the sponsor-chasing nudges hang off.
 */
export async function spendEntitlement(app: AppContext, entitlementId: string, sessionId: string): Promise<EntitlementUsage> {
  const entitlement = await getEntitlement(app, entitlementId);
  const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
  const usage = await entitlementUsage(app, entitlementId);
  app.events.emit({
    type: "entitlement.spent",
    subject: { type: "entitlement", id: entitlementId },
    event_id: str(sponsorship.event_id),
    data: { entitlement_id: entitlementId, session_id: sessionId, remaining: usage.remaining },
  });
  if (usage.remaining === 0) {
    app.events.emit({
      type: "entitlement.exhausted",
      subject: { type: "entitlement", id: entitlementId },
      event_id: str(sponsorship.event_id),
      data: { entitlement_id: entitlementId, sponsor_id: str(sponsorship.sponsor_id) },
    });
  }
  app.audit.record({
    action: "entitlement.spend",
    entity_type: "entitlement",
    entity_id: entitlementId,
    after: { session_id: sessionId, remaining: usage.remaining },
  });
  return usage;
}

/* -------------------------------------------------------------------------- */
/* SponsorContact                                                              */
/* -------------------------------------------------------------------------- */

export interface ContactInput {
  sponsor_id: string;
  person_id: string;
  contact_role?: ContactRole;
  event_id?: string | null;
  can_submit_sessions?: boolean;
  can_manage_contacts?: boolean;
}

export async function addSponsorContact(app: AppContext, input: ContactInput): Promise<Row> {
  const existing = await app.db.first<Row>("sponsor_contact", {
    sponsor_id: input.sponsor_id,
    person_id: input.person_id,
  });
  const now = app.now();
  if (existing) {
    await app.db.update("sponsor_contact", str(existing.id), {
      status: "active",
      revoked_at: null,
      contact_role: input.contact_role ?? str(existing.contact_role),
      can_submit_sessions: input.can_submit_sessions === false ? 0 : 1,
      can_manage_contacts: input.can_manage_contacts ? 1 : 0,
    });
    return { ...existing, status: "active" };
  }
  const id = newId("SponsorContact");
  const row: Row = {
    id,
    sponsor_id: input.sponsor_id,
    person_id: input.person_id,
    contact_role: input.contact_role ?? "primary",
    event_id: input.event_id ?? null,
    can_submit_sessions: input.can_submit_sessions === false ? 0 : 1,
    can_manage_contacts: input.can_manage_contacts ? 1 : 0,
    status: "active",
    invited_at: now,
    accepted_at: null,
    revoked_at: null,
  };
  await app.db.insert("sponsor_contact", row);
  app.events.emit({
    type: "sponsor_contact.invited",
    subject: { type: "sponsor_contact", id },
    event_id: input.event_id ?? null,
    data: {
      sponsor_contact_id: id,
      sponsor_id: input.sponsor_id,
      person_id: input.person_id,
      contact_role: row.contact_role,
    },
  });
  app.audit.record({ action: "sponsor_contact.create", entity_type: "sponsor_contact", entity_id: id, after: row });
  return row;
}

/**
 * 03 — "Contacts churn constantly … `status=revoked` plus a fresh invitation is
 * the whole story; nothing is orphaned because proposals belong to the
 * *sponsor*, not to the contact who typed them." Revoking ends the
 * relationship-derived access in the same transaction (11, rule 1).
 */
export async function revokeSponsorContact(app: AppContext, contactId: string): Promise<void> {
  const contact = await app.db.byId<Row>("sponsor_contact", contactId);
  if (!contact) throw notFound("Sponsor contact", contactId);
  await app.db.update("sponsor_contact", contactId, { status: "revoked", revoked_at: app.now() });
  app.events.emit({
    type: "sponsor_contact.revoked",
    subject: { type: "sponsor_contact", id: contactId },
    event_id: strOrNull(contact.event_id),
    data: {
      sponsor_contact_id: contactId,
      sponsor_id: str(contact.sponsor_id),
      person_id: str(contact.person_id),
    },
  });
  app.audit.record({ action: "sponsor_contact.revoke", entity_type: "sponsor_contact", entity_id: contactId, before: contact });
}

export async function sponsorContacts(app: AppContext, sponsorId: string): Promise<Row[]> {
  return app.db.select<Row>("sponsor_contact", { sponsor_id: sponsorId });
}

/**
 * INV-03-6 — only an active `SponsorContact` with `can_submit_sessions`, or
 * staff with `sponsor_manager`, may create or edit a proposal against that
 * sponsor's entitlements.
 */
export async function assertMaySubmitForSponsor(
  app: AppContext,
  sponsorId: string,
  eventId: string,
  personId: string | null,
  isSponsorManager: boolean,
): Promise<void> {
  if (isSponsorManager) return;
  const contact = personId
    ? await app.db.first<Row>("sponsor_contact", { sponsor_id: sponsorId, person_id: personId })
    : null;
  raiseIf(
    checkMaySubmitForSponsor(
      contact
        ? {
            status: str(contact.status),
            can_submit_sessions: bool(contact.can_submit_sessions),
            event_id: strOrNull(contact.event_id),
          }
        : null,
      isSponsorManager,
      eventId,
    ),
  );
}

/**
 * The guard a sponsor proposal must pass before it may hold a slot: sponsor not
 * blocked (INV-03-7), sponsorship confirmed and unexpired (INV-03-2).
 */
export async function assertEntitlementUsable(app: AppContext, entitlementId: string): Promise<{ entitlement: Row; sponsorship: Row; sponsor: Row }> {
  const entitlement = await getEntitlement(app, entitlementId);
  const sponsorship = await getSponsorship(app, str(entitlement.sponsorship_id));
  const sponsor = await getSponsor(app, str(sponsorship.sponsor_id));
  raiseIf(checkSponsorNotBlocked({ name: str(sponsor.name), status: str(sponsor.status) })); // INV-03-7
  raiseIf(
    checkSponsorshipUsable(
      { status: str(sponsorship.status) },
      { expires_at: strOrNull(entitlement.expires_at) },
      app.now(),
    ),
  ); // INV-03-2
  return { entitlement, sponsorship, sponsor };
}

/* -------------------------------------------------------------------------- */
/* Read models                                                                 */
/* -------------------------------------------------------------------------- */

export interface SponsorshipListRow {
  sponsorship: Row;
  sponsor: Row;
  tier: Row | null;
  usage: SponsorshipUsage;
  public_now: boolean;
}

export async function sponsorshipsForEvent(app: AppContext, eventId: string): Promise<SponsorshipListRow[]> {
  const sponsorships = await app.db.select<Row>("sponsorship", { event_id: eventId }, { orderBy: "created_at" });
  const tiers = await app.db.select<Row>("sponsorship_tier", { event_id: eventId });
  const tierById = new Map(tiers.map((t) => [str(t.id), t]));
  const now = app.now();

  const out: SponsorshipListRow[] = [];
  for (const s of sponsorships) {
    const sponsor = await app.db.byId<Row>("sponsor", str(s.sponsor_id));
    if (!sponsor) continue; // INV-11-2: a soft-deleted sponsor drops out of every read
    out.push({
      sponsorship: s,
      sponsor,
      tier: s.tier_id ? (tierById.get(str(s.tier_id)) ?? null) : null,
      usage: await sponsorshipUsage(app, str(s.id)),
      public_now: isPubliclyVisible({ status: str(s.status), public_from: strOrNull(s.public_from) }, now), // INV-03-8
    });
  }
  return out;
}

/**
 * `PublicSponsor` (03, "Public sponsor read model"): never `internal_notes`,
 * `contract_reference`, entitlement counts, contacts, or `status`.
 */
export interface PublicSponsor {
  name: string;
  display_name: string | null;
  slug: string;
  website_url: string | null;
  description: string | null;
  logo_asset_id: string | null;
  logo_dark_asset_id: string | null;
  tier_name: string | null;
  tier_level: number | null;
  sort_order: number;
}

export async function publicSponsorsForEvent(app: AppContext, eventId: string): Promise<PublicSponsor[]> {
  const rows = await sponsorshipsForEvent(app, eventId);
  return rows
    .filter((r) => r.public_now) // INV-03-8
    .filter((r) => !r.tier || bool(r.tier.is_public))
    .map((r) => ({
      name: str(r.sponsor.name),
      display_name: strOrNull(r.sponsor.display_name),
      slug: str(r.sponsor.slug),
      website_url: strOrNull(r.sponsor.website_url),
      description: strOrNull(r.sponsor.description),
      logo_asset_id: strOrNull(r.sponsor.logo_asset_id),
      logo_dark_asset_id: strOrNull(r.sponsor.logo_dark_asset_id),
      tier_name: r.tier ? str(r.tier.name) : null,
      tier_level: r.tier ? num(r.tier.level) : null,
      sort_order: r.sponsorship.sort_order_override !== null ? num(r.sponsorship.sort_order_override) : (r.tier ? -num(r.tier.level) : 0),
    }))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export { entitlementState, expiringSoon, isPubliclyVisible };
