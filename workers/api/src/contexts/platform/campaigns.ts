/**
 * `Campaign` + `CampaignRecipient` — 09, "Campaigns: organizer-composed bulk
 * messaging".
 *
 * `audience` is stored as criteria, resolved at send time (09, "Design
 * points"): "'All confirmed speakers with an outstanding task' is a query, and
 * storing it as a query is what makes a scheduled campaign correct when it
 * fires rather than correct when it was written."
 */

import type { AppContext } from "@podiumconf/data/context.js";
import { num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { DomainError, notFound } from "@podiumconf/domain/shared/errors.js";
import { newId } from "@podiumconf/domain/shared/ids.js";
import { assertTemplateBody } from "@podiumconf/domain/platform/rendering.js";
import { renderTemplate } from "@podiumconf/domain/platform/rendering.js";
import { assertCampaignTransition, type AudienceCriteria, type CampaignStatus } from "@podiumconf/domain/platform/types.js";
import type { DeliveryMessage } from "../../consumers/delivery.js";
import { attemptSend, baseVariables, writeNotification } from "./notifications.js";

export interface CampaignInput {
  name: string;
  channel: "email" | "chat";
  template_id?: string | null;
  subject?: string | null;
  body_markdown: string;
  audience: AudienceCriteria;
  event_id?: string | null;
}

async function templateKeyFor(app: AppContext, templateId: string | null | undefined): Promise<string | null> {
  if (!templateId) return null;
  const row = await app.db.byId<Row>("notification_template", templateId);
  return row ? str(row.key) : null;
}

export async function createCampaign(app: AppContext, input: CampaignInput): Promise<Row> {
  if (!input.name.trim()) throw new DomainError({ code: "invalid_name", message: "Give the campaign an internal name.", status: 422 });
  const key = await templateKeyFor(app, input.template_id);
  assertTemplateBody(key, input.subject ?? null, input.body_markdown); // INV-09-13

  const id = newId("Campaign");
  const row: Row = {
    id,
    org_id: app.orgId,
    event_id: input.event_id ?? app.eventId ?? null,
    name: input.name.trim(),
    channel: input.channel,
    template_id: input.template_id ?? null,
    subject: input.subject ?? null,
    body_markdown: input.body_markdown,
    audience: JSON.stringify(input.audience ?? {}),
    status: "draft",
    created_by_person_id: app.actor.id ?? "system",
    created_at: app.now(),
    updated_at: app.now(),
    row_version: 1,
  };
  await app.db.insert("campaign", row);
  const recipientCount = (await resolveAudience(app, input.audience ?? {})).length;
  app.events.emit({
    type: "campaign.created",
    subject: { type: "campaign", id },
    data: { campaign_id: id, event_id: row.event_id, channel: input.channel, template_id: input.template_id ?? null, recipient_count: recipientCount },
  });
  app.audit.record({ action: "campaign.create", entity_type: "campaign", entity_id: id, after: { name: row.name } });
  return row;
}

export async function updateCampaign(app: AppContext, id: string, patch: Partial<CampaignInput>): Promise<void> {
  const campaign = await getCampaign(app, id);
  if (str(campaign.status) !== "draft") {
    throw new DomainError({ code: "campaign_not_editable", message: "Only a draft campaign can be edited.", status: 422 });
  }
  const update: Row = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.subject !== undefined) update.subject = patch.subject;
  if (patch.body_markdown !== undefined) update.body_markdown = patch.body_markdown;
  if (patch.template_id !== undefined) update.template_id = patch.template_id;
  if (patch.audience !== undefined) update.audience = JSON.stringify(patch.audience);
  if (Object.keys(update).length === 0) return;

  const key = await templateKeyFor(app, (patch.template_id ?? str(campaign.template_id)) || null);
  assertTemplateBody(key, str(update.subject ?? campaign.subject ?? ""), str(update.body_markdown ?? campaign.body_markdown)); // INV-09-13

  update.updated_at = app.now();
  await app.db.update("campaign", id, update);
  app.audit.record({ action: "campaign.update", entity_type: "campaign", entity_id: id, after: update });
}

async function transition(app: AppContext, id: string, to: CampaignStatus): Promise<Row> {
  const campaign = await getCampaign(app, id);
  const from = str(campaign.status) as CampaignStatus;
  assertCampaignTransition(from, to);
  await app.db.update("campaign", id, { status: to, updated_at: app.now() });
  return { ...campaign, status: to };
}

export async function scheduleCampaign(app: AppContext, id: string, scheduledFor: string): Promise<void> {
  await transition(app, id, "scheduled");
  await app.db.update("campaign", id, { scheduled_for: scheduledFor });
  app.audit.record({ action: "campaign.schedule", entity_type: "campaign", entity_id: id, after: { scheduled_for: scheduledFor } });
}

export async function cancelCampaign(app: AppContext, id: string): Promise<void> {
  await transition(app, id, "cancelled");
  app.audit.record({ action: "campaign.cancel", entity_type: "campaign", entity_id: id });
}

/** `draft --> sending` or `scheduled --> sending` (09 state diagram). */
export async function sendCampaignNow(app: AppContext, id: string): Promise<void> {
  await transition(app, id, "sending");
  app.audit.record({ action: "campaign.send", entity_type: "campaign", entity_id: id });
  const message: DeliveryMessage = { kind: "campaign", campaign_id: id, org_id: app.orgId };
  try {
    await app.env.DELIVERY_QUEUE.send(message);
  } catch (err) {
    console.warn("campaign send enqueue failed", { campaign_id: id, error: String(err) });
  }
}

export async function listCampaigns(app: AppContext, eventId?: string | null): Promise<Row[]> {
  const where: Row = {};
  if (eventId) where.event_id = eventId;
  return app.db.select<Row>("campaign", where, { orderBy: "created_at DESC" });
}

export async function getCampaign(app: AppContext, id: string): Promise<Row> {
  const row = await app.db.byId<Row>("campaign", id);
  if (!row) throw notFound("Campaign", id);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Audience resolution — criteria, resolved at send time                      */
/* -------------------------------------------------------------------------- */

export interface AudienceMember {
  person_id: string;
  email: string;
  name: string;
}

/**
 * "'All confirmed speakers with an outstanding task' is a query" (09). Each
 * `kind` is one such query; `has_outstanding_tasks` / `task_state` narrow any
 * of them further.
 */
export async function resolveAudience(app: AppContext, audience: AudienceCriteria): Promise<AudienceMember[]> {
  const eventId = audience.event_id ?? app.eventId ?? null;
  let personIds: string[] = [];

  switch (audience.kind) {
    case "people":
      personIds = audience.person_ids ?? [];
      break;
    case "segment": {
      if (audience.segment_id) {
        // A dynamic segment stores its filter in `criteria`, not a frozen
        // `member_person_ids` list — reading the column directly here (as
        // this used to) resolved every dynamic segment to zero recipients,
        // silently, at the one moment it mattered: actually sending. The
        // segment detail page already gets this right (`segmentMembers`);
        // this has to agree with it.
        const { getSegment, segmentMembers } = await import("../crm/service.js");
        const seg = await getSegment(app, audience.segment_id);
        personIds = (await segmentMembers(app, seg)).map((m) => str(m.id));
      }
      break;
    }
    case "sponsor_contacts": {
      const rows = await app.db.raw<{ person_id: string }>(
        "SELECT DISTINCT sc.person_id FROM sponsor_contact sc JOIN sponsor s ON s.id = sc.sponsor_id WHERE s.org_id = ? AND sc.status = 'active'",
        [app.orgId],
      );
      personIds = rows.map((r) => r.person_id);
      break;
    }
    case "reviewers": {
      if (!eventId) break;
      const rows = await app.db.raw<{ person_id: string }>(
        "SELECT DISTINCT person_id FROM role_grant WHERE role = 'reviewer' AND ((scope_type = 'event' AND scope_id = ?) OR scope_type = 'org') AND revoked_at IS NULL",
        [eventId],
      );
      personIds = rows.map((r) => r.person_id);
      break;
    }
    case "speakers": {
      if (!eventId) break;
      const rows = await app.db.raw<{ person_id: string }>(
        `SELECT DISTINCT ss.person_id FROM session_speaker ss JOIN session s ON s.id = ss.session_id
          WHERE s.event_id = ? AND s.deleted_at IS NULL AND s.status != 'cancelled' AND ss.confirmation_status != 'replaced'`,
        [eventId],
      );
      personIds = rows.map((r) => r.person_id);
      break;
    }
    case "event_participants":
    default: {
      if (!eventId) break;
      const params: unknown[] = [eventId];
      let sql = "SELECT person_id, status FROM event_participant WHERE event_id = ?";
      if (audience.participant_status?.length) {
        sql += ` AND status IN (${audience.participant_status.map(() => "?").join(",")})`;
        params.push(...audience.participant_status);
      }
      const rows = await app.db.raw<{ person_id: string }>(sql, params);
      personIds = rows.map((r) => r.person_id);
      if (audience.track_ids?.length) {
        const placeholders = audience.track_ids.map(() => "?").join(",");
        const trackRows = await app.db.raw<{ person_id: string }>(
          `SELECT DISTINCT ss.person_id FROM session_speaker ss JOIN session s ON s.id = ss.session_id
            WHERE s.event_id = ? AND s.track_id IN (${placeholders})`,
          [eventId, ...audience.track_ids],
        );
        const allowed = new Set(trackRows.map((r) => r.person_id));
        personIds = personIds.filter((id) => allowed.has(id));
      }
      break;
    }
  }

  personIds = [...new Set(personIds)];
  if (audience.has_outstanding_tasks !== undefined && eventId && personIds.length) {
    const placeholders = personIds.map(() => "?").join(",");
    const rows = await app.db.raw<{ assignee_person_id: string }>(
      `SELECT DISTINCT assignee_person_id FROM task_instance
        WHERE event_id = ? AND assignee_person_id IN (${placeholders}) AND status NOT IN ('completed','waived','cancelled')`,
      [eventId, ...personIds],
    );
    const outstanding = new Set(rows.map((r) => r.assignee_person_id));
    personIds = audience.has_outstanding_tasks ? personIds.filter((id) => outstanding.has(id)) : personIds.filter((id) => !outstanding.has(id));
  }
  if (!personIds.length) return [];

  const placeholders = personIds.map(() => "?").join(",");
  const people = await app.db.raw<Row>(
    `SELECT id, full_name, display_name, email FROM person WHERE org_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
    [app.orgId, ...personIds],
  );
  return people
    .filter((p) => p.email)
    .map((p) => ({ person_id: str(p.id), email: str(p.email), name: str(p.display_name) || str(p.full_name) }));
}

/** "Preview resolves against a real recipient" (09) — capped for the compose screen. */
export async function previewAudience(app: AppContext, audience: AudienceCriteria, limit = 20): Promise<{ total: number; sample: AudienceMember[] }> {
  const all = await resolveAudience(app, audience);
  return { total: all.length, sample: all.slice(0, limit) };
}

/* -------------------------------------------------------------------------- */
/* Sending — one delivery per recipient, idempotent per (campaign, person)     */
/* -------------------------------------------------------------------------- */

export interface CampaignSendResult {
  sent: number;
  suppressed: number;
  failed: number;
  queued_no_provider: number;
}

/**
 * Processes an entire campaign in one pass: resolves the audience, writes one
 * `CampaignRecipient` + `NotificationDelivery` per person not already
 * recorded (INV-09-14), and dispatches each. Runs inside the delivery
 * consumer, not the request path.
 */
export async function runCampaignSend(app: AppContext, campaignId: string): Promise<CampaignSendResult> {
  const campaign = await getCampaign(app, campaignId);
  const status = str(campaign.status);
  if (status !== "sending" && status !== "scheduled") {
    // Already finished (sent / partially_failed / cancelled) — a redelivered
    // queue message is a no-op.
    return { sent: 0, suppressed: 0, failed: 0, queued_no_provider: 0 };
  }
  if (status === "scheduled") await app.db.update("campaign", campaignId, { status: "sending", updated_at: app.now() });

  app.eventId = strOrNull(campaign.event_id) ?? app.eventId;
  const audience = parseJson<AudienceCriteria>(campaign.audience, {});
  const members = await resolveAudience(app, audience);

  const existing = await app.db.raw<Row>("SELECT person_id FROM campaign_recipient WHERE campaign_id = ?", [campaignId]);
  const already = new Set(existing.map((r) => str(r.person_id)));

  const result: CampaignSendResult = { sent: 0, suppressed: 0, failed: 0, queued_no_provider: 0 };
  const templateKey = await templateKeyFor(app, strOrNull(campaign.template_id));

  for (const member of members) {
    if (already.has(member.person_id)) continue; // INV-09-14
    const recipient = await app.db.byId<Row>("person", member.person_id);
    if (!recipient) continue;
    const vars = await baseVariables(app, recipient);
    const subject = campaign.subject ? renderTemplate(str(campaign.subject), vars).text : str(campaign.name);
    const body = renderTemplate(str(campaign.body_markdown), vars).text;

    const notificationId = await writeNotification(app, {
      template_key: templateKey,
      recipient_person_id: member.person_id,
      recipient_email: member.email,
      channel: str(campaign.channel) as "email" | "chat",
      subject_type: "campaign",
      subject_id: campaignId,
      subject,
      rendered_body: body,
      // A campaign is not a decision notification — INV-09-10's exemption does
      // not extend to it (09, "Design points").
      transactional: false,
      campaign_id: campaignId,
    });

    await app.db.rawRun(
      "INSERT OR IGNORE INTO campaign_recipient (campaign_id, person_id, resolved_email, notification_id, status) VALUES (?,?,?,?,?)",
      [campaignId, member.person_id, member.email, notificationId, "queued"],
    );

    const outcome = await attemptSend(app, notificationId);
    await app.db.rawRun("UPDATE campaign_recipient SET status = ?, suppressed_reason = ? WHERE campaign_id = ? AND person_id = ?", [
      outcome.status,
      outcome.suppressed_reason ?? null,
      campaignId,
      member.person_id,
    ]);

    if (outcome.status === "sent") result.sent++;
    else if (outcome.status === "suppressed") result.suppressed++;
    else if (outcome.status === "failed") {
      result.failed++;
      app.events.emit({
        type: "campaign.recipient_failed",
        subject: { type: "campaign", id: campaignId },
        data: { campaign_id: campaignId, person_id: member.person_id, reason: outcome.suppressed_reason ?? "send_failed" },
      });
    } else result.queued_no_provider++;
  }

  const finalStatus = result.failed > 0 ? "partially_failed" : "sent";
  await app.db.update("campaign", campaignId, { status: finalStatus, sent_at: app.now(), updated_at: app.now() });
  app.events.emit({
    type: "campaign.sent",
    subject: { type: "campaign", id: campaignId },
    data: { campaign_id: campaignId, recipient_count: members.length, sent: result.sent, suppressed: result.suppressed, failed: result.failed },
  });
  return result;
}

export async function campaignStats(app: AppContext, campaignId: string): Promise<Record<string, number>> {
  const rows = await app.db.raw<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM campaign_recipient WHERE campaign_id = ? GROUP BY status",
    [campaignId],
  );
  const out: Record<string, number> = { queued: 0, sent: 0, delivered: 0, bounced: 0, suppressed: 0, failed: 0 };
  for (const r of rows) out[r.status] = num(r.n);
  return out;
}
