/**
 * 07 — Onboarding: the admin builder and board, the speaker checklist, and
 * the JSON surfaces.
 *
 * Admin (server-rendered):
 *   /admin/events/:eventId/tasks…      definitions, ad-hoc tasks
 *   /admin/events/:eventId/onboarding  OrganizerOnboardingBoard
 *   /admin/tasks/:taskId               instance detail, review actions
 *
 * Portal:
 *   /portal/tasks…                     SpeakerChecklist
 *
 * Management API: /v1/task-definitions…, /v1/tasks…
 */

import { bool, num, parseJson, str, type Row } from "@podiumconf/data/db.js";
import {
  ASSIGNEE_RULE,
  DUE_RULE,
  REQUIREMENT_TYPE,
  TASK_CATEGORY,
  TASK_SUBJECT_TYPE,
  TASK_TRIGGER,
  type RequirementType,
  type TaskCategory,
  type TaskInstanceStatus,
  type TaskSubjectType,
  type TaskViewer,
} from "@podiumconf/domain/onboarding/types.js";
import { ATTENDANCE_MODE, SPEAKER_ROLE } from "@podiumconf/domain/program/types.js";
import { formatDateInZone } from "@podiumconf/domain/shared/time.js";
import { ORIGIN } from "@podiumconf/domain/event-config/types.js";
import { notFound } from "@podiumconf/domain/shared/errors.js";
import { eventRow } from "../event-config/views.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput, type Input } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, progressBar, table } from "../../ui/layout.js";
import { adminPage, portalPage, toEventRef, type EventRef } from "../../ui/shell.js";
import {
  activateTaskDefinition,
  approveTask,
  cancelInstance,
  createAdhocTask,
  createDefaultTaskDefinitions,
  createTaskDefinition,
  getDefinition,
  getInstance,
  listDefinitions,
  listSubmissions,
  reopenTask,
  requestChanges,
  retireTaskDefinition,
  rematerialise,
  sendManualReminder,
  startTask,
  storeTaskUpload,
  submitTask,
  updateTaskDefinition,
  waiveMany,
  waiveTask,
  type DefinitionInput,
} from "./service.js";
import {
  completionStatsByDefinition,
  definitionJson,
  instanceJson,
  nominatedPersonIds,
  organizerBoard,
  speakerChecklist,
  submissionJson,
  visibilityOf,
  type BoardFilters,
} from "./views.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

function opts(values: readonly string[]): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: humanise(v) }));
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadEventFor(ctx: RequestContext, idOrSlug: string): Promise<{ row: Row; ref: EventRef }> {
  const row = await eventRow(ctx.app(), idOrSlug);
  ctx.eventId = str(row.id);
  return { row, ref: toEventRef(row) };
}

/** INV-07-10 — everything a viewer's role and relationships grant them. */
async function buildViewer(ctx: RequestContext): Promise<TaskViewer> {
  const personId = ctx.person?.id ?? null;
  const nominated = personId ? await nominatedPersonIds(ctx.app(), personId) : [];
  return {
    person_id: personId,
    is_event_staff: ctx.isStaff(),
    session_ids: ctx.principals.relationships.session_ids,
    sponsor_ids: ctx.principals.relationships.sponsor_ids,
    nominated_person_ids: nominated,
  };
}

function readDefinitionInput(input: Input): DefinitionInput {
  return {
    key: input.optional("key"),
    title: input.str("title"),
    instructions: input.optional("instructions"),
    category: (input.str("category", "other") || "other") as TaskCategory,
    requirement_type: (input.str("requirement_type", "text_response") || "text_response") as RequirementType,
    config: input.json<Record<string, unknown>>("config", {}),
    subject_type: (input.str("subject_type", "session") || "session") as TaskSubjectType,
    assignee_rule: input.str("assignee_rule", "each_speaker") || "each_speaker",
    assignee_person_id: input.optional("assignee_person_id"),
    assignee_person_ids: splitList(input.str("assignee_person_ids")),
    applies_to: input.json<Record<string, unknown>>("applies_to", {}),
    trigger: input.str("trigger", "on_session_confirmed") || "on_session_confirmed",
    trigger_task_key: input.optional("trigger_task_key"),
    due_rule: input.str("due_rule", "none") || "none",
    due_value: input.json<Record<string, unknown>>("due_value", {}),
    is_blocking: input.bool("is_blocking"),
    is_required: input.has("is_required") ? input.bool("is_required") : true,
    requires_review: input.bool("requires_review"),
    auto_complete_on_event: input.optional("auto_complete_on_event"),
    depends_on_task_keys: splitList(input.str("depends_on_task_keys")),
    sort_order: input.int("sort_order", 0) ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerOnboardingRoutes(router: Router<RequestContext>): void {
  registerAdminDefinitionRoutes(router);
  registerAdminBoardRoutes(router);
  registerAdminInstanceRoutes(router);
  registerPortalRoutes(router);
  registerManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* Admin — task definitions & ad-hoc tasks                                    */
/* -------------------------------------------------------------------------- */

function definitionFields(def: Row | null, tracks: Row[], formats: Row[]): SafeHtml {
  const applies = def ? parseJson<Record<string, unknown>>(def.applies_to, {}) : {};
  return html`
    ${field({ name: "title", label: "Title", required: true, value: def ? str(def.title) : "", placeholder: "Upload your headshot" })}
    ${field({ name: "key", label: "Key", value: def ? str(def.key) : "", help: "Stable across years for reporting. Leave blank to derive it from the title." })}
    ${field({ name: "instructions", label: "Instructions", type: "textarea", rows: 3, value: def ? str(def.instructions) : "", help: "Markdown; explain why — it measurably lifts completion." })}
    ${field({ name: "category", label: "Category", type: "select", required: true, value: def ? str(def.category) : "other", options: opts(TASK_CATEGORY) })}
    ${field({ name: "requirement_type", label: "Requirement type", type: "select", required: true, value: def ? str(def.requirement_type) : "text_response", options: opts(REQUIREMENT_TYPE) })}
    ${field({ name: "config", label: "Config (JSON)", type: "textarea", rows: 3, value: def ? JSON.stringify(parseJson(def.config, {})) : "{}", help: "Shape depends on requirement type — see 07-onboarding.md." })}
    ${field({ name: "subject_type", label: "Subject type", type: "select", required: true, value: def ? str(def.subject_type) : "session", options: opts(TASK_SUBJECT_TYPE) })}
    ${field({ name: "assignee_rule", label: "Assignee rule", type: "select", required: true, value: def ? str(def.assignee_rule) : "each_speaker", options: opts(ASSIGNEE_RULE) })}
    ${field({ name: "assignee_person_id", label: "Named organizer (for named_organizer)", value: def ? str(def.assignee_person_id) : "" })}
    ${field({ name: "assignee_person_ids", label: "Named people (for named_people)", type: "textarea", rows: 2, value: def ? parseJson<string[]>(def.assignee_person_ids, []).join(", ") : "", help: "Person ids, comma or newline separated. A named-people task needs at least one." })}
    ${field({ name: "applies_to", label: "Applies to (JSON filter)", type: "textarea", rows: 2, value: JSON.stringify(applies), help: `{origins, format_ids, track_ids, attendance_modes, speaker_roles} — empty = everything. Origins: ${ORIGIN.join(", ")}. Attendance: ${ATTENDANCE_MODE.join(", ")}. Roles: ${SPEAKER_ROLE.join(", ")}. Tracks/formats on this event: ${[...tracks.map((t) => str(t.id) + "=" + str(t.name)), ...formats.map((f) => str(f.id) + "=" + str(f.name))].join(", ") || "none yet"}.` })}
    ${field({ name: "trigger", label: "Trigger", type: "select", required: true, value: def ? str(def.trigger) : "on_session_confirmed", options: opts(TASK_TRIGGER) })}
    ${field({ name: "trigger_task_key", label: "Trigger task key (for on_task_completed)", value: def ? str(def.trigger_task_key) : "" })}
    ${field({ name: "due_rule", label: "Due rule", type: "select", required: true, value: def ? str(def.due_rule) : "none", options: opts(DUE_RULE) })}
    ${field({ name: "due_value", label: "Due value (JSON)", value: def ? JSON.stringify(parseJson(def.due_value, {})) : "{}", help: `{"date": "2027-05-01"} or {"offset_days": -14, "at_time": "17:00"} — negative is before.` })}
    ${field({ name: "is_blocking", label: "Blocking — while this is incomplete, the session cannot be published", type: "checkbox", value: def ? bool(def.is_blocking) : false })}
    ${field({ name: "is_required", label: "Required (unchecked = a nudge, not an obligation)", type: "checkbox", value: def ? bool(def.is_required) : true })}
    ${field({ name: "requires_review", label: "Requires organizer review", type: "checkbox", value: def ? bool(def.requires_review) : false })}
    ${field({ name: "auto_complete_on_event", label: "Auto-completes on domain event", value: def ? str(def.auto_complete_on_event) : "" })}
    ${field({ name: "depends_on_task_keys", label: "Depends on task keys", type: "textarea", rows: 2, value: def ? parseJson<string[]>(def.depends_on_task_keys, []).join(", ") : "", help: "Comma or newline separated definition keys. This task stays blocked until they are done, so the dependencies cannot form a loop." })}
    ${field({ name: "sort_order", label: "Sort order", type: "number", value: def ? num(def.sort_order) : 0 })}
  `;
}

function registerAdminDefinitionRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/tasks", async (_req, ctx, params) => {
    ctx.requireRead("task.define", { event_id: params.eventId });
    const { ref } = await loadEventFor(ctx, params.eventId);
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("task.define", { event_id: ref.id });
    const [defs, tracks, formats] = await Promise.all([
      listDefinitions(app, ref.id),
      app.db.select<Row>("track", { event_id: ref.id }),
      app.db.select<Row>("session_format", { event_id: ref.id }),
    ]);

    const rows = defs.map(
      (d) => html`<tr>
        <td><a href="/admin/events/${ref.id}/tasks/${str(d.id)}"><strong>${str(d.title)}</strong></a><br><span class="mono small muted">${str(d.key)} · v${num(d.version, 1)}</span></td>
        <td>${badge(str(d.category))}</td>
        <td>${humanise(str(d.requirement_type))}</td>
        <td>${humanise(str(d.assignee_rule))}</td>
        <td>${humanise(str(d.trigger))}</td>
        <td>${bool(d.is_blocking) ? badge("blocking", "warn") : raw("")} ${bool(d.requires_review) ? badge("reviewed", "info") : raw("")}</td>
        <td>${badge(str(d.status), str(d.status) === "active" ? "ok" : str(d.status) === "retired" ? "err" : "")}</td>
        <td class="right">
          ${canWrite
            ? html`${str(d.status) !== "active" ? actionForm(`/admin/events/${ref.id}/tasks/${str(d.id)}/activate`, "Activate") : raw("")}
                ${str(d.status) === "active" ? actionForm(`/admin/events/${ref.id}/tasks/${str(d.id)}/retire`, "Retire", { confirm: "Retire this task? Existing instances are unaffected." }) : raw("")}
                ${str(d.status) === "active" ? actionForm(`/admin/events/${ref.id}/tasks/${str(d.id)}/rematerialise`, "Re-materialise", { confirm: "Apply this definition to every eligible existing session, speaker and sponsor now? Instances already materialised are left as-is." }) : raw("")}`
            : raw("")}
        </td>
      </tr>`,
    );

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Onboarding tasks", event: ref, active: "onboarding", width: "wide" },
        html`${pageHead(
            "Task definitions",
            "Definitions are templates; instances are the obligations they create. Editing one never rewrites what people already did.",
            canWrite && defs.length === 0
              ? actionForm(`/admin/events/${ref.id}/tasks/seed-defaults`, "Seed the default checklist")
              : html`<a class="btn secondary" href="/admin/events/${ref.id}/onboarding">View board</a>`,
          )}
          ${table(["Task", "Category", "Type", "Assignee", "Trigger", "Weight", "Status", ""], rows, "No task definitions yet.")}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/events/${ref.id}/tasks" class="stack">
                  ${definitionFields(null, tracks, formats)}
                  <button type="submit">Create definition</button>
                </form>`,
                "New task definition",
              )
            : raw("")}
          ${canWrite
            ? card(
                html`<p class="muted">Title, instructions, type, due date, who — the definition behind it is an implementation detail. Materialises immediately, one instance per named person.</p>
                  <form method="post" action="/admin/events/${ref.id}/tasks/adhoc" class="stack">
                    ${field({ name: "title", label: "Title", required: true, placeholder: "Sign the speaker release form" })}
                    ${field({ name: "instructions", label: "Instructions", type: "textarea", rows: 2 })}
                    ${field({ name: "requirement_type", label: "Type", type: "select", required: true, value: "acknowledgement", options: opts(REQUIREMENT_TYPE) })}
                    ${field({ name: "due_rule", label: "Due", type: "select", required: true, value: "fixed_date", options: opts(DUE_RULE) })}
                    ${field({ name: "due_date", label: "Due date", type: "date" })}
                    ${field({ name: "assignee_person_ids", label: "Who (person ids, comma or newline separated)", type: "textarea", rows: 2, required: true })}
                    ${field({ name: "is_blocking", label: "Blocking", type: "checkbox" })}
                    ${field({ name: "requires_review", label: "Requires review", type: "checkbox" })}
                    <button type="submit">Create ad-hoc task</button>
                  </form>`,
                "Ad-hoc task",
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/tasks", async (req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await createTaskDefinition(app, params.eventId, readDefinitionInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks`, 303, OK("Task definition created as a draft. Activate it to start materialising instances."));
  });

  router.post("/admin/events/:eventId/tasks/seed-defaults", async (_req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const created = await createDefaultTaskDefinitions(app, params.eventId);
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks`, 303, OK(`${created.length} default task${created.length === 1 ? "" : "s"} created and activated.`));
  });

  router.post("/admin/events/:eventId/tasks/adhoc", async (req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const dueValue = input.optional("due_date") ? { date: input.str("due_date") } : {};
    const created = await createAdhocTask(app, params.eventId, {
      title: input.str("title"),
      instructions: input.optional("instructions"),
      requirement_type: (input.str("requirement_type", "acknowledgement") || "acknowledgement") as RequirementType,
      due_rule: input.str("due_rule", "fixed_date") || "fixed_date",
      due_value: dueValue,
      assignee_person_ids: splitList(input.str("assignee_person_ids")),
      is_blocking: input.bool("is_blocking"),
      requires_review: input.bool("requires_review"),
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks`, 303, OK(`Ad-hoc task created for ${created.length} ${created.length === 1 ? "person" : "people"}.`));
  });

  router.get("/admin/events/:eventId/tasks/:defId", async (_req, ctx, params) => {
    ctx.requireRead("task.define", { event_id: params.eventId });
    const { ref } = await loadEventFor(ctx, params.eventId);
    const app = ctx.app(ref.id);
    const canWrite = ctx.canWrite("task.define", { event_id: ref.id });
    const [def, tracks, formats, rules] = await Promise.all([
      getDefinition(app, params.defId),
      app.db.select<Row>("track", { event_id: ref.id }),
      app.db.select<Row>("session_format", { event_id: ref.id }),
      app.db.select<Row>("task_reminder_rule", { definition_id: params.defId }),
    ]);
    const instanceCount = await app.db.count("task_instance", { definition_id: params.defId });

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(def.title), event: ref, active: "onboarding", width: "narrow" },
        html`${pageHead(str(def.title), `${instanceCount} instance${instanceCount === 1 ? "" : "s"} materialised so far. Version ${num(def.version, 1)}.`, badge(str(def.status), str(def.status) === "active" ? "ok" : ""))}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/events/${ref.id}/tasks/${params.defId}" class="stack">
                  ${definitionFields(def, tracks, formats)}
                  <button type="submit">Save</button>
                </form>`,
                "Edit",
              )
            : raw("")}
          ${card(
              rules.length
                ? table(
                    ["Offset (days)", "Channel", "Escalates to"],
                    rules.map((r) => html`<tr><td>${num(r.offset_days)}</td><td>${str(r.channel)}</td><td>${str(r.escalate_to) || "—"}</td></tr>`),
                  )
                : empty("No reminder rules yet."),
              "Reminder rules",
            )}
          ${canWrite
            ? card(
                html`<form method="post" action="/admin/events/${ref.id}/tasks/${params.defId}/reminder-rules" class="inline-grid">
                  ${field({ name: "offset_days", label: "Offset from due date (days)", type: "number", required: true, help: "Negative = before, positive = escalation after." })}
                  ${field({ name: "channel", label: "Channel", type: "select", required: true, value: "email", options: opts(["email", "webhook"]) })}
                  ${field({ name: "template_key", label: "Template key", value: "task.reminder" })}
                  ${field({ name: "escalate_to", label: "Escalate to", type: "select", options: opts(["none", "primary_speaker", "sponsor_primary_contact", "organizer"]) })}
                  <button type="submit">Add rule</button>
                </form>`,
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/tasks/:defId", async (req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    await updateTaskDefinition(app, params.defId, readDefinitionInput(input));
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks/${params.defId}`, 303, OK("Saved. Existing instances are unaffected."));
  });

  router.post("/admin/events/:eventId/tasks/:defId/activate", async (_req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    await activateTaskDefinition(app, params.defId);
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks`, 303, OK("Activated."));
  });

  router.post("/admin/events/:eventId/tasks/:defId/retire", async (_req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    await retireTaskDefinition(app, params.defId);
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks`, 303, OK("Retired."));
  });

  router.post("/admin/events/:eventId/tasks/:defId/rematerialise", async (_req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const created = await rematerialise(app, params.defId);
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks`, 303, OK(`${created} new instance${created === 1 ? "" : "s"} materialised.`));
  });

  router.post("/admin/events/:eventId/tasks/:defId/reminder-rules", async (req, ctx, params) => {
    ctx.requireWrite("task.define", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const { newId } = await import("@podiumconf/domain/shared/ids.js");
    await app.db.insert("task_reminder_rule", {
      id: newId("TaskReminderRule"),
      definition_id: params.defId,
      offset_days: input.int("offset_days", 0) ?? 0,
      channel: input.str("channel", "email") || "email",
      template_key: input.str("template_key", "task.reminder") || "task.reminder",
      escalate_to: input.optional("escalate_to"),
      only_if_status: null,
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/tasks/${params.defId}`, 303, OK("Reminder rule added."));
  });
}

/* -------------------------------------------------------------------------- */
/* Admin — OrganizerOnboardingBoard                                           */
/* -------------------------------------------------------------------------- */

function readBoardFilters(ctx: RequestContext): BoardFilters {
  const q = ctx.url.searchParams;
  return {
    track_id: q.get("track_id") || null,
    format_id: q.get("format_id") || null,
    sponsor_id: q.get("sponsor_id") || null,
    definition_id: q.get("definition_id") || null,
    assignee_person_id: q.get("assignee_person_id") || null,
    status: q.get("status") || null,
    overdue: q.get("overdue") === "1",
  };
}

function registerAdminBoardRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/onboarding", async (_req, ctx, params) => {
    ctx.requireRead("task.complete", { event_id: params.eventId });
    const { ref } = await loadEventFor(ctx, params.eventId);
    const app = ctx.app(ref.id);
    const canRemind = ctx.canWrite("task.complete", { event_id: ref.id });
    const canWaive = ctx.canWrite("task.approve", { event_id: ref.id });
    const filters = readBoardFilters(ctx);
    const [rows, defs, tracks] = await Promise.all([organizerBoard(app, ref.id, filters), listDefinitions(app, ref.id), app.db.select<Row>("track", { event_id: ref.id })]);

    const activeFilters = [filters.track_id, filters.definition_id, filters.status, filters.overdue ? "1" : ""].filter(Boolean).length;
    const filterForm = html`<details class="filter-bar"${activeFilters > 0 ? raw(" open") : raw("")}>
      <summary>Filters${activeFilters > 0 ? html` <span class="badge info">${activeFilters}</span>` : raw("")}</summary>
      <form method="get" class="inline-grid">
        ${field({ name: "track_id", label: "Track", type: "select", value: filters.track_id ?? "", options: tracks.map((t) => ({ value: str(t.id), label: str(t.name) })) })}
        ${field({ name: "definition_id", label: "Task", type: "select", value: filters.definition_id ?? "", options: defs.map((d) => ({ value: str(d.id), label: str(d.title) })) })}
        ${field({ name: "status", label: "Status", type: "select", value: filters.status ?? "", options: opts(["blocked", "not_started", "in_progress", "submitted", "changes_requested", "completed", "waived", "cancelled"]) })}
        ${field({ name: "overdue", label: "Overdue only", type: "checkbox", value: filters.overdue })}
        <div class="actions">
          <button type="submit">Filter</button>
          ${activeFilters > 0 ? html`<a class="btn secondary" href="/admin/events/${ref.id}/onboarding">Clear</a>` : raw("")}
        </div>
      </form>
    </details>`;

    const rows_ = rows.map(
      (r) => html`<tr>
        <td><input type="checkbox" name="task_ids" value="${str(r.instance.id)}" form="board-actions"></td>
        <td style="min-width:14rem">${r.session_title ?? r.sponsor_name ?? "—"}</td>
        <td>${str(r.instance.title)}</td>
        <td class="nowrap">${r.assignee_name}</td>
        <td>${badge(str(r.instance.status))}</td>
        <td class="nowrap">${str(r.instance.due_at) ? formatDateInZone(str(r.instance.due_at), ref.timezone) : "—"}${r.is_overdue ? html` <span class="badge err">overdue</span>` : raw("")}</td>
        <td class="right"><a class="btn secondary small" href="/admin/tasks/${str(r.instance.id)}">Open</a></td>
      </tr>`,
    );

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Onboarding board", event: ref, active: "onboarding", width: "wide" },
        html`${pageHead(
            "Onboarding board",
            "Every session and sponsor's obligations, filterable to exactly the set worth chasing. Select rows, then remind or waive.",
            ctx.canWrite("task.define", { event_id: ref.id })
              ? html`<a class="btn secondary" href="/admin/events/${ref.id}/tasks">Manage tasks</a>`
              : undefined,
          )}
          ${filterForm}
          <form method="post" action="/admin/events/${ref.id}/onboarding/remind" id="board-actions">
            ${canRemind || canWaive
              ? html`<div class="bulk-actions">
                  <span class="muted small">Tick the rows you want, then:</span>
                  ${canRemind ? html`<button type="submit" formaction="/admin/events/${ref.id}/onboarding/remind">Remind selected</button>` : raw("")}
                  ${canWaive
                    ? html`<span class="copy-url">
                        <input type="text" name="reason" placeholder="Reason for waiving" form="board-waive-reason">
                        <button type="submit" class="secondary" formaction="/admin/events/${ref.id}/onboarding/waive">Waive selected</button>
                      </span>`
                    : raw("")}
                </div>`
              : raw("")}
            ${table(["", "Session / sponsor", "Task", "Assignee", "Status", "Due", ""], rows_, "Nothing matches these filters.", { tall: true })}
          </form>
          <form id="board-waive-reason"></form>
          ${card(
            table(
              ["Task", "Completed", "Waived", "Outstanding", "Cancelled", "%", "Median days"],
              (await completionStatsByDefinition(app, ref.id)).map(
                (s) => html`<tr>
                  <td>${str(s.definition.title)}</td>
                  <td>${s.completed}</td>
                  <td>${s.waived}</td>
                  <td>${s.outstanding}</td>
                  <td>${s.cancelled}</td>
                  <td style="min-width:8rem"><div class="progress-row">${progressBar(s.percent)}<span class="small muted">${s.percent}%</span></div></td>
                  <td>${s.median_days_to_complete ?? "—"}</td>
                </tr>`,
              ),
              "No task definitions yet.",
            ),
            "Completion by task",
          )}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/onboarding/remind", async (req, ctx, params) => {
    ctx.requireWrite("task.complete", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const ids = input.list("task_ids");
    const result = await sendManualReminder(app, ids, ctx.person?.id ?? null); // INV-07-13
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/onboarding`, 303, OK(`Reminded ${result.sent}, skipped ${result.suppressed} (already complete or recently reminded).`));
  });

  router.post("/admin/events/:eventId/onboarding/waive", async (req, ctx, params) => {
    ctx.requireWrite("task.approve", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const ids = input.list("task_ids");
    const reason = input.str("reason");
    if (!reason.trim()) return redirect(`/admin/events/${params.eventId}/onboarding`, 303, { "set-cookie": flashCookie("err", "A waiver needs a reason.") });
    const n = await waiveMany(app, ids, reason, ctx.person?.id ?? null); // INV-07-7
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/onboarding`, 303, OK(`Waived ${n} task${n === 1 ? "" : "s"}.`));
  });
}

/* -------------------------------------------------------------------------- */
/* Admin — instance detail                                                    */
/* -------------------------------------------------------------------------- */

function registerAdminInstanceRoutes(router: Router<RequestContext>): void {
  router.get("/admin/tasks/:taskId", async (_req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.taskId);
    ctx.requireRead("task.complete", { event_id: str(t.event_id) });
    const app = ctx.app(str(t.event_id));
    const ref = toEventRef(await eventRow(app, str(t.event_id)));
    const canApprove = ctx.canWrite("task.approve", { event_id: ref.id });
    const submissions = await listSubmissions(app, params.taskId);
    const def = await getDefinition(app, str(t.definition_id));

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(t.title), event: ref, active: "onboarding", width: "narrow" },
        html`${pageHead(str(t.title), `${humanise(str(t.subject_type))} obligation, assigned to a speaker or contact. ${str(t.due_at) ? `Due ${str(t.due_at).slice(0, 10)}.` : ""}`, badge(str(t.status)))}
          ${card(
            html`<dl class="kv">
              <dt>Status</dt><dd>${badge(str(t.status))}</dd>
              <dt>Blocking</dt><dd>${bool(t.is_blocking) ? "Yes — blocks schedule publication" : "No"}</dd>
              <dt>Requires review</dt><dd>${bool(t.requires_review) ? "Yes" : "No"}</dd>
              <dt>Reminders sent</dt><dd>${num(t.reminder_count)}${str(t.last_reminded_at) ? ` · last ${str(t.last_reminded_at).slice(0, 10)}` : ""}</dd>
            </dl>`,
            "Overview",
          )}
          ${canApprove
            ? card(
                html`${str(t.status) === "submitted"
                    ? html`${actionForm(`/admin/tasks/${params.taskId}/approve`, "Approve", { className: "" })}
                        <form method="post" action="/admin/tasks/${params.taskId}/request-changes" class="inline-grid">
                          ${field({ name: "note", label: "What needs to change", required: true })}
                          <button type="submit" class="secondary">Request changes</button>
                        </form>`
                    : raw("")}
                  ${str(t.status) === "completed" ? actionForm(`/admin/tasks/${params.taskId}/reopen`, "Reopen") : raw("")}
                  ${t.status !== "waived" && t.status !== "cancelled"
                    ? html`<form method="post" action="/admin/tasks/${params.taskId}/waive" class="inline-grid">
                        ${field({ name: "reason", label: "Waiver reason", required: true })}
                        <button type="submit" class="secondary">Waive</button>
                      </form>`
                    : raw("")}
                  ${actionForm(`/admin/tasks/${params.taskId}/remind`, "Send a reminder now")}`,
                "Review",
              )
            : raw("")}
          ${card(
              submissions.length
                ? html`${submissions.map((s) => {
                    const j = submissionJson(s, str(def.category), ctx.includePii());
                    return html`<div class="submission">
                      <p><strong>Version ${num(s.version)}</strong> — ${str(s.submitted_at)} · ${badge(str(s.review_outcome) || "pending")}</p>
                      <pre class="mono small">${JSON.stringify(j.payload, null, 2)}</pre>
                      ${j.asset_ids && (j.asset_ids as string[]).length ? html`<p class="small muted">Assets: ${(j.asset_ids as string[]).join(", ")}</p>` : raw("")}
                      ${str(s.review_note) ? html`<p class="small">Review note: ${str(s.review_note)}</p>` : raw("")}
                    </div>`;
                  })}`
                : empty("No submissions yet."),
            "Submissions",
          )}`,
      ),
    );
  });

  router.post("/admin/tasks/:taskId/approve", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.taskId);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    await approveTask(app, params.taskId, ctx.person?.id ?? null, input.optional("note"));
    await app.flush();
    return redirect(`/admin/tasks/${params.taskId}`, 303, OK("Approved."));
  });

  router.post("/admin/tasks/:taskId/request-changes", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.taskId);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    await requestChanges(app, params.taskId, ctx.person?.id ?? null, input.str("note"));
    await app.flush();
    return redirect(`/admin/tasks/${params.taskId}`, 303, OK("Changes requested."));
  });

  router.post("/admin/tasks/:taskId/waive", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.taskId);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    await waiveTask(app, params.taskId, input.str("reason"), ctx.person?.id ?? null);
    await app.flush();
    return redirect(`/admin/tasks/${params.taskId}`, 303, OK("Waived."));
  });

  router.post("/admin/tasks/:taskId/reopen", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.taskId);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    await reopenTask(app, params.taskId, input.optional("reason"));
    await app.flush();
    return redirect(`/admin/tasks/${params.taskId}`, 303, OK("Reopened."));
  });

  router.post("/admin/tasks/:taskId/remind", async (_req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.taskId);
    ctx.requireWrite("task.complete", { event_id: str(t.event_id) });
    const app = ctx.app(str(t.event_id));
    const result = await sendManualReminder(app, [params.taskId], ctx.person?.id ?? null);
    await app.flush();
    return redirect(`/admin/tasks/${params.taskId}`, 303, OK(result.sent ? "Reminder sent." : "Not sent — already complete or recently reminded."));
  });
}

/* -------------------------------------------------------------------------- */
/* Portal — SpeakerChecklist                                                  */
/* -------------------------------------------------------------------------- */

function completionForm(t: Row, taskId: string): SafeHtml {
  const type = str(t.requirement_type) as RequirementType;
  const config = parseJson<Record<string, unknown>>(t.config, {});
  switch (type) {
    case "acknowledgement":
      return html`${field({ name: "accepted", label: str(config.checkbox_label as string) || "I accept", type: "checkbox", required: true })}
        ${config.require_typed_name ? field({ name: "typed_name", label: "Type your full name to sign", required: true }) : raw("")}`;
    case "form":
      return html`${config.form_id
        ? field({ name: "answers", label: "Answers (JSON)", type: "textarea", rows: 4, help: "This task points at a submission form; a dedicated renderer is not wired up yet — send the answers as JSON." })
        : html`<p class="notice warn">This task has no form configured yet. Ask an organizer.</p>`}`;
    case "file_upload": {
      // The constraints are enforced server-side either way; saying them at the
      // point of upload is what stops a speaker discovering a 40 MB limit after
      // waiting for a 60 MB upload.
      const accept = config.accept as string[] | undefined;
      const limits = [
        accept?.length ? `Accepted: ${accept.join(", ")}` : null,
        config.max_file_mb ? `Maximum ${str(config.max_file_mb as string)} MB per file` : null,
        config.max_files ? `Up to ${str(config.max_files as string)} file(s)` : null,
      ].filter(Boolean);
      return html`${field({ name: "file", label: "File", type: "file", required: true, accept: accept?.join(","), help: limits.join(" · ") || undefined })}
        ${config.naming_hint ? html`<p class="help">${str(config.naming_hint as string)}</p>` : raw("")}`;
    }
    case "external_link":
      return html`${config.url ? html`<p><a href="${str(config.url as string)}" target="_blank" rel="noopener">${str((config.label as string) || "Open")}</a></p>` : raw("")}
        ${field({ name: "confirmed", label: str((config.confirm_label as string) || "I've done this"), type: "checkbox", required: true })}`;
    case "external_action":
      return html`<p class="muted">This completes automatically once ${str((config.integration_key as string) || "the integration")} reports it.</p>`;
    case "scheduling":
      return html`${config.booking_url ? html`<p><a href="${str(config.booking_url as string)}" target="_blank" rel="noopener">Book a slot</a></p>` : raw("")}
        ${field({ name: "booked", label: "I've booked my slot", type: "checkbox", required: true })}`;
    case "text_response":
      return field({ name: "text", label: str((config.prompt as string) || "Your answer"), type: "textarea", rows: 5, required: true });
    case "speaker_nomination":
      return html`${[1, 2, 3].map(
        (i) => html`<div class="inline-grid">
          ${field({ name: `nominee_name_${i}`, label: `Speaker ${i} — full name` })}
          ${field({ name: `nominee_email_${i}`, label: `Speaker ${i} — email`, type: "email" })}
        </div>`,
      )}`;
    default:
      return raw("");
  }
}

function registerPortalRoutes(router: Router<RequestContext>): void {
  router.get("/portal/tasks", async (_req, ctx) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const items = await speakerChecklist(app, person.id);
    const rows = items.map(
      (it) => html`<tr class="${it.is_overdue ? "warn" : ""}">
        <td><a href="/portal/tasks/${str(it.instance.id)}">${str(it.instance.title)}</a>${it.session_title ? html`<br><span class="small muted">${it.session_title}</span>` : raw("")}</td>
        <td>${badge(str(it.instance.status))}</td>
        <td>${str(it.instance.due_at) ? str(it.instance.due_at).slice(0, 10) : "—"}${it.is_overdue ? " (overdue)" : ""}</td>
        <td>${it.next_action}</td>
      </tr>`,
    );
    return htmlResponse(
      portalPage(
        ctx,
        { title: "My tasks", active: "tasks", width: "default" },
        html`${pageHead("My tasks", "Everything you need to do before the event, ordered by what is overdue and what is next.")}
          ${table(["Task", "Status", "Due", "Next action"], rows, "Nothing here yet — checklists appear once your session is confirmed.")}`,
      ),
    );
  });

  router.get("/portal/tasks/:taskId", async (_req, ctx, params) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const t = await getInstance(app, params.taskId);
    const viewer = await buildViewer(ctx);
    const visibility = visibilityOf(t, viewer);
    if (visibility === "none") throw notFound("Task", params.taskId);

    if (visibility !== "full") {
      return htmlResponse(
        portalPage(
          ctx,
          { title: str(t.title), active: "tasks" },
          html`${pageHead(str(t.title), "You can see this task's status, but not its details.")}
            ${card(html`<p>${badge(str(t.status))}</p>`)}`,
        ),
      );
    }

    const isAssignee = str(t.assignee_person_id) === person.id;
    const isTerminal = t.status === "completed" || t.status === "waived" || t.status === "cancelled";
    const submissions = await listSubmissions(app, params.taskId);

    return htmlResponse(
      portalPage(
        ctx,
        { title: str(t.title), active: "tasks", width: "narrow" },
        html`${pageHead(str(t.title), str(t.instructions) ? str(t.instructions) : "", badge(str(t.status)))}
          ${str(t.due_at) ? html`<p class="muted">Due ${str(t.due_at).slice(0, 10)}.</p>` : raw("")}
          ${t.status === "changes_requested" && str(t.review_note) ? html`<p class="notice warn">Changes requested: ${str(t.review_note)}</p>` : raw("")}
          ${isAssignee && !isTerminal
            ? card(
                html`<form method="post" action="/portal/tasks/${params.taskId}" enctype="multipart/form-data" class="stack">
                  ${completionForm(t, params.taskId)}
                  <button type="submit">Submit</button>
                </form>`,
              )
            : raw("")}
          ${isTerminal ? html`<p class="notice ${t.status === "completed" ? "ok" : "warn"}">${t.status === "completed" ? "Done." : t.status === "waived" ? `Waived — ${str(t.waiver_reason)}` : "This is no longer needed."}</p>` : raw("")}
          ${submissions.length
            ? card(
                html`${submissions.map(
                  (s) =>
                    html`<p class="small">Version ${num(s.version)} — ${str(s.submitted_at)} · ${badge(str(s.review_outcome) || "pending")}${str(s.review_note) ? html`<br>${str(s.review_note)}` : raw("")}</p>`,
                )}`,
                "Your submissions",
              )
            : raw("")}`,
      ),
    );
  });

  router.post("/portal/tasks/:taskId", async (req, ctx, params) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const t = await getInstance(app, params.taskId);
    const input = await readInput(req);
    const type = str(t.requirement_type) as RequirementType;
    const config = parseJson<Record<string, unknown>>(t.config, {});
    let payload: Record<string, unknown> = {};
    let assetIds: string[] = [];

    switch (type) {
      case "acknowledgement":
        payload = {
          accepted: input.bool("accepted"),
          typed_name: input.optional("typed_name"),
          document_version: config.document_version ?? null,
          ip: req.headers.get("cf-connecting-ip"),
          user_agent: req.headers.get("user-agent"),
          accepted_at: app.now(),
        };
        break;
      case "form":
        payload = { answers: input.json<Record<string, unknown>>("answers", {}) };
        break;
      case "file_upload": {
        const files = input.files("file");
        if (files[0]) assetIds.push(await storeTaskUpload(app, params.taskId, files[0], person.id));
        assetIds.push(...input.list("asset_ids"));
        break;
      }
      case "external_link":
        payload = { confirmed: input.bool("confirmed") };
        break;
      case "scheduling":
        payload = { booked: input.bool("booked"), slot_at: input.optional("slot_at") };
        break;
      case "text_response":
        payload = { text: input.str("text") };
        break;
      case "speaker_nomination": {
        const nominees: { full_name: string; email: string }[] = [];
        for (let i = 1; i <= 3; i++) {
          const name = input.optional(`nominee_name_${i}`);
          const email = input.optional(`nominee_email_${i}`);
          if (name || email) nominees.push({ full_name: name ?? "", email: email ?? "" });
        }
        payload = { nominees };
        break;
      }
      default:
        break;
    }

    const { result } = await submitTask(app, params.taskId, { personId: person.id, isStaff: ctx.isStaff() }, { payload, asset_ids: assetIds });
    await app.flush();
    return redirect(`/portal/tasks/${params.taskId}`, 303, OK(result.satisfied ? "Submitted." : (result.message ?? "Saved — we'll finish this once it's ready.")));
  });
}

/* -------------------------------------------------------------------------- */
/* Management API                                                             */
/* -------------------------------------------------------------------------- */

function pageParams(ctx: RequestContext): { cursor: string | null; limit: number } {
  return { cursor: ctx.url.searchParams.get("cursor"), limit: Number(ctx.url.searchParams.get("limit") ?? 50) };
}

async function cursorPage(app: ReturnType<RequestContext["app"]>, table: string, where: Record<string, string>, cursor: string | null, limit: number) {
  const lim = Math.min(Math.max(limit, 1), 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(where)) {
    clauses.push(`${k} = ?`);
    params.push(v);
  }
  if (cursor) {
    clauses.push("id > ?");
    params.push(cursor);
  }
  const sql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = await app.db.raw<Row>(`SELECT * FROM ${table}${sql} ORDER BY id LIMIT ${lim + 1}`, params);
  const items = rows.slice(0, lim);
  return { items, next_cursor: rows.length > lim ? str(items[items.length - 1]?.id) : null };
}

function registerManagementApi(router: Router<RequestContext>): void {
  router.get("/v1/task-definitions", async (_req, ctx) => {
    ctx.requireRead("task.define");
    const { cursor, limit } = pageParams(ctx);
    const eventId = ctx.url.searchParams.get("event_id");
    const where: Record<string, string> = eventId ? { event_id: eventId } : {};
    if (eventId) ctx.requireRead("task.define", { event_id: eventId });
    const page = await cursorPage(ctx.app(), "task_definition", where, cursor, limit);
    return json({ data: page.items.map(definitionJson), next_cursor: page.next_cursor });
  });

  router.post("/v1/task-definitions", async (req, ctx) => {
    const input = await readInput(req);
    const eventId = input.str("event_id");
    ctx.requireWrite("task.define", { event_id: eventId });
    const app = ctx.app(eventId);
    const row = await createTaskDefinition(app, eventId, {
      title: input.str("title"),
      instructions: input.optional("instructions"),
      category: (input.str("category", "other") || "other") as TaskCategory,
      requirement_type: (input.str("requirement_type", "text_response") || "text_response") as RequirementType,
      config: input.json("config", {}),
      subject_type: (input.str("subject_type", "session") || "session") as TaskSubjectType,
      assignee_rule: input.str("assignee_rule", "each_speaker") || "each_speaker",
      assignee_person_ids: input.list("assignee_person_ids"),
      applies_to: input.json("applies_to", {}),
      trigger: input.str("trigger", "on_session_confirmed") || "on_session_confirmed",
      due_rule: input.str("due_rule", "none") || "none",
      due_value: input.json("due_value", {}),
      is_blocking: input.bool("is_blocking"),
      is_required: input.has("is_required") ? input.bool("is_required") : true,
      requires_review: input.bool("requires_review"),
    });
    await app.flush();
    return json(definitionJson(row), { status: 201 });
  });

  router.get("/v1/task-definitions/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const def = await getDefinition(app, params.id);
    ctx.requireRead("task.define", { event_id: str(def.event_id) });
    return json(definitionJson(def));
  });

  router.post("/v1/task-definitions/:id/activate", async (_req, ctx, params) => {
    const app = ctx.app();
    const def = await getDefinition(app, params.id);
    ctx.requireWrite("task.define", { event_id: str(def.event_id) });
    const row = await activateTaskDefinition(app, params.id);
    await app.flush();
    return json(definitionJson(row));
  });

  router.post("/v1/task-definitions/:id/retire", async (_req, ctx, params) => {
    const app = ctx.app();
    const def = await getDefinition(app, params.id);
    ctx.requireWrite("task.define", { event_id: str(def.event_id) });
    const row = await retireTaskDefinition(app, params.id);
    await app.flush();
    return json(definitionJson(row));
  });

  router.post("/v1/task-definitions/:id/rematerialise", async (_req, ctx, params) => {
    const app = ctx.app();
    const def = await getDefinition(app, params.id);
    ctx.requireWrite("task.define", { event_id: str(def.event_id) });
    const created = await rematerialise(app, params.id);
    await app.flush();
    return json({ created });
  });

  router.get("/v1/tasks", async (_req, ctx) => {
    ctx.requireRead("task.complete");
    const eventId = ctx.url.searchParams.get("event_id");
    if (eventId) ctx.requireRead("task.complete", { event_id: eventId });
    const { cursor, limit } = pageParams(ctx);
    const where: Record<string, string> = {};
    if (eventId) where.event_id = eventId;
    const assignee = ctx.url.searchParams.get("assignee_person_id");
    if (assignee) where.assignee_person_id = assignee;
    const status = ctx.url.searchParams.get("status");
    if (status) where.status = status;
    const app = ctx.app();
    const page = await cursorPage(app, "task_instance", where, cursor, limit);
    const viewer = await buildViewer(ctx);
    const now = app.now();
    const data = page.items
      .map((row) => ({ row, visibility: visibilityOf(row, viewer) }))
      .filter((x) => x.visibility !== "none")
      .map((x) => instanceJson(x.row, { visibility: x.visibility, now }));
    return json({ data, next_cursor: page.next_cursor });
  });

  router.get("/v1/tasks/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const t = await getInstance(app, params.id);
    const viewer = await buildViewer(ctx);
    const visibility = visibilityOf(t, viewer);
    if (visibility === "none") throw notFound("Task", params.id);
    return json(instanceJson(t, { visibility, now: app.now() }));
  });

  /** `TaskSubmission.payload` is PII when the definition's category is travel or legal. */
  router.get("/v1/tasks/:id/submissions", async (_req, ctx, params) => {
    const app = ctx.app();
    const t = await getInstance(app, params.id);
    const viewer = await buildViewer(ctx);
    const visibility = visibilityOf(t, viewer);
    if (visibility !== "full") throw notFound("Task", params.id); // status_only never sees payloads
    const def = await getDefinition(app, str(t.definition_id));
    const submissions = await listSubmissions(app, params.id);
    return json({ data: submissions.map((s) => submissionJson(s, str(def.category), ctx.includePii())) });
  });

  router.post("/v1/tasks/:id/approve", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.id);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    const row = await approveTask(app, params.id, ctx.person?.id ?? null, input.optional("note"));
    await app.flush();
    return json(instanceJson(row, { visibility: "full", now: app.now() }));
  });

  router.post("/v1/tasks/:id/request-changes", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.id);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    const row = await requestChanges(app, params.id, ctx.person?.id ?? null, input.str("note"));
    await app.flush();
    return json(instanceJson(row, { visibility: "full", now: app.now() }));
  });

  router.post("/v1/tasks/:id/waive", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.id);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    const row = await waiveTask(app, params.id, input.str("reason"), ctx.person?.id ?? null);
    await app.flush();
    return json(instanceJson(row, { visibility: "full", now: app.now() }));
  });

  router.post("/v1/tasks/:id/cancel", async (req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.id);
    ctx.requireWrite("task.approve", { event_id: str(t.event_id) });
    const input = await readInput(req);
    const app = ctx.app(str(t.event_id));
    const row = await cancelInstance(app, params.id, input.str("reason", "Cancelled by an organizer."));
    await app.flush();
    return json(row ? instanceJson(row, { visibility: "full", now: app.now() }) : instanceJson(t, { visibility: "full", now: app.now() }));
  });

  router.post("/v1/tasks/:id/start", async (_req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.id);
    ctx.requireRead("task.complete", { event_id: str(t.event_id) });
    const app = ctx.app(str(t.event_id));
    const row = await startTask(app, params.id, { personId: ctx.person?.id ?? null, isStaff: ctx.isStaff({ event_id: str(t.event_id) }) });
    await app.flush();
    return json(instanceJson(row, { visibility: "full", now: app.now() }));
  });

  router.post("/v1/tasks/:id/remind", async (_req, ctx, params) => {
    const t = await getInstance(ctx.app(), params.id);
    ctx.requireWrite("task.complete", { event_id: str(t.event_id) });
    const app = ctx.app(str(t.event_id));
    const result = await sendManualReminder(app, [params.id], ctx.person?.id ?? null);
    await app.flush();
    return json(result);
  });
}
