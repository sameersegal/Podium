/**
 * Two-way sync — admin surface and `/v1` — 09, "Two-way sync"; R31.
 *
 * The mapping screen is where INV-09-17 is meant to be felt rather than
 * enforced: a derived column is not offered, a push-only subject renders its
 * direction control disabled with the reason next to it, and a field whose
 * write-back revokes a session's content approval says so where it is chosen.
 * The validation still runs on save — a form is not a security boundary — but
 * an organizer should not be able to build a mapping that cannot work.
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumstack/data/db.js";
import {
  SUBJECT_SPECS,
  SYNC_SUBJECTS,
  fieldSpec,
  pushableFields,
  subjectSpec,
  writableFields,
  type SyncFieldMap,
  type SyncSubject,
} from "@podiumstack/domain/platform/sync.js";
import type { SyncPlugin, SyncTable } from "@podiumstack/plugins/registry.js";

import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput } from "../../http/input.js";
import { htmlResponse, json, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, empty, field, humanise, pageHead, stat, table } from "../../ui/layout.js";
import { adminPage } from "../../ui/shell.js";

import { getIntegration, resolvePluginForIntegration } from "./service.js";
import {
  activeMappings,
  backfillMapping,
  conflictsFor,
  createMapping,
  fieldMapOf,
  getMapping,
  linkReadiness,
  linkStats,
  resolveConflict,
  runsFor,
  scaffoldMapping,
  updateMapping,
} from "./sync.js";
import { schedulePull, schedulePush } from "./sync-delivery.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });
const WARN = (message: string) => ({ "set-cookie": flashCookie("warn", message) });

export function registerSyncRoutes(router: Router<RequestContext>): void {
  registerAdminRoutes(router);
  registerSyncApi(router);
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

async function syncTablesFor(ctx: RequestContext, integrationId: string): Promise<SyncTable[]> {
  const app = ctx.app();
  const integration = await getIntegration(app, integrationId);
  const resolved = await resolvePluginForIntegration(app, integration);
  if (!resolved || resolved.plugin.capability !== "sync") return [];
  try {
    return await (resolved.plugin as SyncPlugin).list_tables(resolved.ctx);
  } catch {
    // The mapping form is still useful with the table typed by hand; a base
    // that cannot be listed is a credential problem the health check reports.
    return [];
  }
}

/** `field.<name>` / `dir.<name>` pairs from the mapping form. */
function readFieldMap(input: { has(k: string): boolean; str(k: string, d?: string): string }, subject: string): SyncFieldMap[] {
  const out: SyncFieldMap[] = [];
  for (const spec of pushableFields(subject)) {
    const external = input.str(`field.${spec.field}`, "").trim();
    if (!external) continue;
    const wantsBoth = input.str(`dir.${spec.field}`, "push") === "both";
    out.push({ field: spec.field, external_field: external, direction: wantsBoth ? "both" : "push" });
  }
  return out;
}

function mappingJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    integration_id: str(row.integration_id),
    event_id: strOrNull(row.event_id),
    subject: str(row.subject),
    external_table_id: str(row.external_table_id),
    external_table_name: str(row.external_table_name),
    field_map: fieldMapOf(row),
    include_pii: bool(row.include_pii),
    filter: parseJson<Record<string, unknown> | null>(row.filter, null),
    is_active: bool(row.is_active),
    last_push_at: strOrNull(row.last_push_at),
    last_pull_at: strOrNull(row.last_pull_at),
    row_version: num(row.row_version, 1),
  };
}

function linkJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    mapping_id: str(row.mapping_id),
    subject_type: str(row.subject_type),
    subject_id: str(row.subject_id),
    external_id: strOrNull(row.external_id),
    status: str(row.status),
    conflict: parseJson<Record<string, unknown> | null>(row.conflict_payload, null),
    last_error: strOrNull(row.last_error),
    last_pushed_at: strOrNull(row.last_pushed_at),
    last_pulled_at: strOrNull(row.last_pulled_at),
  };
}

function runJson(row: Row): Record<string, unknown> {
  return {
    id: str(row.id),
    mapping_id: str(row.mapping_id),
    direction: str(row.direction),
    trigger: str(row.trigger),
    status: str(row.status),
    counts: parseJson<Record<string, number>>(row.counts, {}),
    started_at: str(row.started_at),
    finished_at: strOrNull(row.finished_at),
    error: strOrNull(row.error),
  };
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

function registerAdminRoutes(router: Router<RequestContext>): void {
  /** The conflict queue, across every mapping. The screen INV-09-18 exists for. */
  router.get("/admin/sync", async (_req, ctx) => {
    ctx.requireRead("sync.resolve_conflict");
    const app = ctx.app();
    const conflicts = await conflictsFor(app);
    const mappings = await app.db.select<Row>("sync_mapping", {});
    const byId = new Map(mappings.map((m) => [str(m.id), m]));
    const canWrite = ctx.canWrite("sync.resolve_conflict");

    const rows = conflicts.map((link) => {
      const mapping = byId.get(str(link.mapping_id));
      const payload = parseJson<{ rejected?: Record<string, unknown>; refused_because?: string }>(link.conflict_payload, {});
      const fields = Object.keys(payload.rejected ?? {});
      return html`<tr>
        <td>
          <strong>${humanise(str(link.subject_type))}</strong><br />
          <span class="mono small muted">${str(link.subject_id)}</span>
        </td>
        <td>${mapping ? str(mapping.external_table_name) || str(mapping.external_table_id) : raw("—")}</td>
        <td>${fields.length > 0 ? fields.join(", ") : raw("—")}</td>
        <td class="small muted">${payload.refused_because ?? "Changed in Podium after the last push."}</td>
        <td>
          ${canWrite
            ? html`${actionForm(`/admin/sync/links/${str(link.id)}/resolve`, "Keep Podium's", {
                hidden: { resolution: "keep_podium" },
              })}
              ${actionForm(`/admin/sync/links/${str(link.id)}/resolve`, "Take theirs", {
                hidden: { resolution: "accept_external" },
                confirm: "Clear the conflict and let the next sync carry the external values in against the current version?",
              })}`
            : raw("")}
        </td>
      </tr>`;
    });

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Sync conflicts", active: "integrations", width: "wide" },
        html`${pageHead(
            "Sync conflicts",
            "Edits made in a linked table that lost to a change made here since the last push. Nothing was overwritten either way.",
          )}
          ${table(["Record", "Table", "Fields", "Why it lost", ""], rows, "No conflicts. Every linked table agrees with Podium.")}
          <p class="muted small">
            <strong>Keep Podium's</strong> re-pushes what is stored here, which is what the authority rule implies.
            <strong>Take theirs</strong> does not write the refused values either — it clears the conflict so the next sync
            carries them in against the current version, through the same rules an organizer would hit by hand.
          </p>`,
      ),
    );
  });

  router.post("/admin/sync/links/:linkId/resolve", async (req, ctx, params) => {
    ctx.requireWrite("sync.resolve_conflict");
    const input = await readInput(req);
    const app = ctx.app();
    const resolution = input.str("resolution", "keep_podium") === "accept_external" ? "accept_external" : "keep_podium";
    const link = await resolveConflict(app, params.linkId, resolution);
    await app.flush();
    await schedulePush(ctx.env, app.orgId, str(link.mapping_id), "manual");
    return redirect("/admin/sync", 303, OK(resolution === "keep_podium" ? "Podium's value will be pushed back." : "Cleared. The next sync will re-read it."));
  });

  /** Mappings for one installed integration. */
  router.get("/admin/integrations/:id/sync", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const integration = await getIntegration(app, params.id);
    const mappings = await app.db.select<Row>("sync_mapping", { integration_id: params.id });
    const tables = await syncTablesFor(ctx, params.id);
    const canWrite = ctx.canWrite("org.configure");

    const rows = await Promise.all(
      mappings.map(async (m) => {
        const stats = await linkStats(app, str(m.id));
        return html`<tr>
          <td>
            <a href="/admin/sync/${str(m.id)}"><strong>${SUBJECT_SPECS[str(m.subject) as SyncSubject]?.label ?? humanise(str(m.subject))}</strong></a>
            <br /><span class="mono small muted">${str(m.external_table_name) || str(m.external_table_id)}</span>
          </td>
          <td>${bool(m.is_active) ? badge("active", "ok") : badge("paused")}</td>
          <td>${num(stats.in_sync, 0)}</td>
          <td>${num(stats.pending_push, 0)}</td>
          <td>${stats.conflict ? badge(`${stats.conflict} in conflict`, "warn") : raw("—")}</td>
          <td>${stats.error ? badge(`${stats.error} failing`, "danger") : raw("—")}</td>
        </tr>`;
      }),
    );

    return htmlResponse(
      adminPage(
        ctx,
        { title: `${str(integration.display_name)} — sync`, active: "integrations", width: "wide" },
        html`${pageHead(
            `${str(integration.display_name)} — tables`,
            "One mapping mirrors one kind of record into one table. Podium stays the system of record: every mapped field is pushed, and only the fields you mark two-way come back.",
          )}
          ${table(["Mapping", "State", "In sync", "Pending", "Conflicts", "Errors"], rows, "No tables mapped yet.")}
          ${canWrite ? newMappingCard(params.id, tables) : raw("")}`,
      ),
    );
  });

  router.post("/admin/integrations/:id/sync", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const subject = input.str("subject") as SyncSubject;
    const spec = subjectSpec(subject);

    // Everything pushable, push-only, to start. The organizer opens the mapping
    // and turns individual fields two-way, which is the moment the warnings
    // about approval revocation and PII are worth showing.
    const fieldMap: SyncFieldMap[] = pushableFields(subject, input.bool("include_pii")).map((f) => ({
      field: f.field,
      external_field: f.label,
      direction: "push",
    }));

    const mapping = await createMapping(app, {
      integration_id: params.id,
      subject,
      external_table_id: input.str("external_table_id"),
      external_table_name: input.optional("external_table_name") ?? input.str("external_table_id"),
      field_map: fieldMap,
      include_pii: input.bool("include_pii"),
      event_id: input.optional("event_id") ?? (spec.scope === "event" ? ctx.eventId : null),
    });
    const created = await backfillMapping(app, mapping);
    await app.flush();
    await schedulePush(ctx.env, app.orgId, str(mapping.id), "manual");
    return redirect(`/admin/sync/${str(mapping.id)}`, 303, OK(`Mapped. ${created} record(s) queued for the first push.`));
  });

  /** One mapping: the field map, the state of its links, and its recent runs. */
  router.get("/admin/sync/:mappingId", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const mapping = await getMapping(app, params.mappingId);
    const subject = str(mapping.subject);
    const spec = subjectSpec(subject);
    const current = new Map(fieldMapOf(mapping).map((e) => [e.field, e]));
    const stats = await linkStats(app, params.mappingId);
    const runs = await runsFor(app, params.mappingId);
    const readiness = await linkReadiness(app, mapping);
    const canWrite = ctx.canWrite("org.configure");
    const includePii = bool(mapping.include_pii);

    const fieldRows = pushableFields(subject, includePii).map((f) => {
      const entry = current.get(f.field);
      const twoWayAllowed = !spec.pushOnly && f.writable && !f.derived && !f.pii;
      return html`<tr>
        <td>
          <strong>${f.label}</strong>${f.primary ? badge("primary", "ok") : raw("")}<br />
          <span class="mono small muted">${f.field}</span> ${badge(columnKindLabel(f.kind))}
          ${f.pii ? badge("personal data", "warn") : raw("")}
          ${f.revokesApproval ? badge("revokes approval", "warn") : raw("")}
          ${f.kind === "link" ? html`<br /><span class="small muted">links to ${SUBJECT_SPECS[f.linkTo!].label}</span>` : raw("")}
          ${f.optionsFrom ? html`<br /><span class="small muted">a dropdown of this event's ${f.optionsFrom === "track" ? "tracks" : "formats"}, matched by name</span>` : raw("")}
        </td>
        <td>
          <input name="field.${f.field}" value="${entry?.external_field ?? ""}" placeholder="column name" ${canWrite ? raw("") : raw("disabled")} />
        </td>
        <td>
          ${twoWayAllowed
            ? html`<label class="small"
                ><input type="checkbox" name="dir.${f.field}" value="both" ${entry?.direction === "both" ? raw("checked") : raw("")} ${canWrite ? raw("") : raw("disabled")} />
                accept edits back</label
              >
              ${f.revokesApproval
                ? html`<br /><span class="small muted">Editing this in the table revokes the session's content approval and writes a revision.</span>`
                : raw("")}`
            : html`<span class="small muted">${twoWayReason(subject, f.field)}</span>`}
        </td>
      </tr>`;
    });

    return htmlResponse(
      adminPage(
        ctx,
        { title: spec.label, active: "integrations", width: "wide" },
        html`${pageHead(
            `${spec.label} → ${str(mapping.external_table_name) || str(mapping.external_table_id)}`,
            spec.pushOnly ?? "Every mapped field is pushed. Tick a field to accept edits back; Podium still wins if both sides changed.",
            html`${canWrite ? actionForm(`/admin/sync/${params.mappingId}/scaffold`, "Create/update columns") : raw("")}
              ${canWrite ? actionForm(`/admin/sync/${params.mappingId}/push`, "Push now") : raw("")}
              ${canWrite && writableFields(subject).length > 0 ? actionForm(`/admin/sync/${params.mappingId}/pull`, "Pull now") : raw("")}`,
          )}
          ${readiness.length > 0
            ? card(
                html`<p class="small muted">
                    Relationships are pushed as real links between tables, so each one needs its own table mirrored in the
                    same base. The reverse column appears automatically on the other side — you never map both ends.
                  </p>
                  <ul class="small">
                    ${readiness.map(
                      (r) =>
                        html`<li>
                          ${r.label} — ${r.mapped ? badge("mapped", "ok") : badge("not mapped yet", "warn")}
                          ${r.mapped ? raw("") : html`<span class="muted"> the column stays empty until it is</span>`}
                        </li>`,
                    )}
                  </ul>`,
                "Linked tables",
              )
            : raw("")}
          <div class="stats">
            ${stat("In sync", num(stats.in_sync, 0))} ${stat("Pending", num(stats.pending_push, 0))}
            ${stat("Conflicts", num(stats.conflict, 0), "/admin/sync")} ${stat("Errors", num(stats.error, 0))}
          </div>
          ${spec.pushOnly ? card(html`<p class="small">${spec.pushOnly}</p>`, "Push-only") : raw("")}
          <form method="post" action="/admin/sync/${params.mappingId}" class="stack">
            ${card(
              html`${table(["Field", "Column in the table", "Direction"], fieldRows)}
                ${field({
                  name: "include_pii",
                  label: "Carry personal data into this table",
                  type: "checkbox",
                  value: includePii,
                  help: "Off by default. Personal data is pushed only with this on, and is never accepted back.",
                })}
                ${field({ name: "is_active", label: "Sync is on", type: "checkbox", value: bool(mapping.is_active) })}
                <input type="hidden" name="row_version" value="${num(mapping.row_version, 1)}" />
                ${canWrite ? html`<button type="submit">Save mapping</button>` : raw("")}`,
              "Fields",
            )}
          </form>
          ${card(
            table(
              ["When", "Direction", "Trigger", "Result", "Counts"],
              runs.map(
                (r) => html`<tr>
                  <td class="small">${str(r.started_at)}</td>
                  <td>${badge(str(r.direction))}</td>
                  <td class="small muted">${humanise(str(r.trigger))}</td>
                  <td>${badge(str(r.status), str(r.status) === "completed" ? "ok" : str(r.status) === "failed" ? "danger" : "warn")}</td>
                  <td class="small mono">${countsLabel(parseJson<Record<string, number>>(r.counts, {}))}${r.error ? html`<br /><span class="muted">${str(r.error)}</span>` : raw("")}</td>
                </tr>`,
              ),
              "No runs yet.",
            ),
            "Recent runs",
          )}`,
      ),
    );
  });

  router.post("/admin/sync/:mappingId", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const input = await readInput(req);
    const app = ctx.app();
    const mapping = await getMapping(app, params.mappingId);
    const includePii = input.bool("include_pii");

    await updateMapping(
      app,
      params.mappingId,
      { field_map: readFieldMap(input, str(mapping.subject)), include_pii: includePii, is_active: input.bool("is_active") },
      Number(input.str("row_version", "")) || null,
    );
    await app.flush();
    await schedulePush(ctx.env, app.orgId, params.mappingId, "manual");
    return redirect(`/admin/sync/${params.mappingId}`, 303, OK("Saved. Every linked record will be pushed again."));
  });

  router.post("/admin/sync/:mappingId/push", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const mapping = await getMapping(app, params.mappingId);
    const queued = await backfillMapping(app, mapping);
    await app.flush();
    await schedulePush(ctx.env, app.orgId, params.mappingId, "manual");
    return redirect(`/admin/sync/${params.mappingId}`, 303, OK(`Queued${queued > 0 ? ` — ${queued} record(s) waiting` : ""}.`));
  });

  router.post("/admin/sync/:mappingId/scaffold", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const result = await scaffoldMapping(app, await getMapping(app, params.mappingId));
    await app.flush();
    const note = result.skipped.length > 0 ? ` ${result.skipped.join(", ")} still needs its own table first.` : "";
    return redirect(
      `/admin/sync/${params.mappingId}`,
      303,
      OK(`${result.created ? "Created" : "Updated"} “${result.table}”.${note}`),
    );
  });

  router.post("/admin/sync/:mappingId/pull", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const mapping = await getMapping(app, params.mappingId);
    if (writableFields(str(mapping.subject)).length === 0) {
      return redirect(`/admin/sync/${params.mappingId}`, 303, WARN("Nothing on this mapping is accepted back, so there is nothing to pull."));
    }
    await schedulePull(ctx.env, app.orgId, params.mappingId, "manual");
    return redirect(`/admin/sync/${params.mappingId}`, 303, OK("Reading the table now."));
  });
}

/** What column type this field wants, said the way a table tool says it. */
function columnKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    text: "text",
    long_text: "long text",
    number: "number",
    boolean: "checkbox",
    date: "date",
    select: "single select",
    multi_select: "multiple select",
    url: "URL",
    email: "email",
    link: "linked records",
    attachment: "attachment",
  };
  return labels[kind] ?? kind;
}

function twoWayReason(subject: string, fieldName: string): string {
  const spec = subjectSpec(subject);
  if (spec.pushOnly) return "Push-only.";
  const f = fieldSpec(subject, fieldName);
  if (f?.kind === "link") return "A relationship — managed here, mirrored out.";
  if (f?.kind === "attachment") return "A file — uploads go through the file pipeline.";
  if (f?.pii) return "Personal data is never accepted back.";
  if (f?.derived) return "Computed here — nothing to write.";
  return "Push-only.";
}

function countsLabel(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${v}`)
    .join("  ") || "nothing to do";
}

function newMappingCard(integrationId: string, tables: SyncTable[]): SafeHtml {
  return card(
    html`<form method="post" action="/admin/integrations/${integrationId}/sync" class="stack">
      ${field({
        name: "subject",
        label: "What to mirror",
        type: "select",
        required: true,
        options: SYNC_SUBJECTS.map((s) => ({
          value: s,
          label: SUBJECT_SPECS[s].pushOnly ? `${SUBJECT_SPECS[s].label} (push-only)` : SUBJECT_SPECS[s].label,
        })),
      })}
      ${tables.length > 0
        ? field({
            name: "external_table_id",
            label: "Into which table",
            type: "select",
            required: true,
            options: tables.map((t) => ({ value: t.external_table_id, label: t.name })),
          })
        : field({
            name: "external_table_id",
            label: "Into which table",
            required: true,
            help: "The table id. Listing the base failed — check the integration's health.",
          })}
      ${field({
        name: "include_pii",
        label: "Carry personal data",
        type: "checkbox",
        help: "Leave off unless the table needs emails or contact details. It can be turned on later.",
      })}
      <button type="submit">Map this table</button>
    </form>`,
    "Mirror another kind of record",
  );
}

/* -------------------------------------------------------------------------- */
/* Management API                                                              */
/* -------------------------------------------------------------------------- */

function registerSyncApi(router: Router<RequestContext>): void {
  /** What each subject offers, in each direction — what a mapping UI needs. */
  router.get("/v1/sync/subjects", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    return json(
      SYNC_SUBJECTS.map((s) => {
        const spec = SUBJECT_SPECS[s];
        const writable = new Set(writableFields(s).map((f) => f.field));
        return {
          subject: s,
          label: spec.label,
          scope: spec.scope,
          push_only: spec.pushOnly ?? null,
          writable: writableFields(s).map((f) => f.field),
          primary_field: spec.fields.find((f) => f.primary)?.field ?? null,
          links_to: [...new Set(spec.fields.filter((f) => f.linkTo).map((f) => f.linkTo))],
          fields: spec.fields.map((f) => ({
            field: f.field,
            label: f.label,
            kind: f.kind,
            writable: writable.has(f.field),
            derived: Boolean(f.derived),
            pii: Boolean(f.pii),
            primary: Boolean(f.primary),
            links_to: f.linkTo ?? null,
            options_from: f.optionsFrom ?? null,
            revokes_approval: Boolean(f.revokesApproval),
          })),
        };
      }),
    );
  });

  router.get("/v1/sync/mappings", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    return json((await app.db.select<Row>("sync_mapping", {})).map(mappingJson));
  });

  router.post("/v1/sync/mappings", async (req, ctx) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const body = (await req.json()) as Record<string, unknown>;
    const mapping = await createMapping(app, {
      integration_id: String(body.integration_id ?? ""),
      subject: String(body.subject ?? "") as SyncSubject,
      external_table_id: String(body.external_table_id ?? ""),
      external_table_name: body.external_table_name === undefined ? null : String(body.external_table_name),
      field_map: (body.field_map ?? []) as SyncFieldMap[],
      include_pii: Boolean(body.include_pii),
      filter: (body.filter ?? null) as Record<string, unknown> | null,
      event_id: body.event_id === undefined ? null : String(body.event_id),
    });
    await backfillMapping(app, mapping);
    await app.flush();
    await schedulePush(ctx.env, app.orgId, str(mapping.id), "manual");
    return json(mappingJson(mapping), { status: 201 });
  });

  router.get("/v1/sync/mappings/:id", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const mapping = await getMapping(app, params.id);
    return json({ ...mappingJson(mapping), links: await linkStats(app, params.id) });
  });

  router.post("/v1/sync/mappings/:id", async (req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const body = (await req.json()) as Record<string, unknown>;
    const mapping = await updateMapping(
      app,
      params.id,
      {
        field_map: body.field_map as SyncFieldMap[] | undefined,
        include_pii: body.include_pii === undefined ? undefined : Boolean(body.include_pii),
        filter: body.filter === undefined ? undefined : ((body.filter ?? null) as Record<string, unknown> | null),
        is_active: body.is_active === undefined ? undefined : Boolean(body.is_active),
        external_table_id: body.external_table_id === undefined ? undefined : String(body.external_table_id),
      },
      body.row_version === undefined ? null : Number(body.row_version),
    );
    await app.flush();
    return json(mappingJson(mapping));
  });

  router.get("/v1/sync/mappings/:id/runs", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    return json((await runsFor(ctx.app(), params.id)).map(runJson));
  });

  router.get("/v1/sync/mappings/:id/links", async (_req, ctx, params) => {
    ctx.requireRead("org.configure");
    const app = ctx.app();
    const rows = await app.db.select<Row>("external_record_link", { mapping_id: params.id }, { limit: 500 });
    return json(rows.map(linkJson));
  });

  router.post("/v1/sync/mappings/:id/push", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const queued = await backfillMapping(app, await getMapping(app, params.id));
    await app.flush();
    await schedulePush(ctx.env, app.orgId, params.id, "manual");
    return json({ queued }, { status: 202 });
  });

  router.post("/v1/sync/mappings/:id/scaffold", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const result = await scaffoldMapping(app, await getMapping(app, params.id));
    await app.flush();
    return json(result);
  });

  router.post("/v1/sync/mappings/:id/pull", async (_req, ctx, params) => {
    ctx.requireWrite("org.configure");
    const app = ctx.app();
    const mapping = await getMapping(app, params.id);
    if (writableFields(str(mapping.subject)).length === 0) {
      return json({ error: "subject_is_push_only", invariant: "INV-09-23" }, { status: 422 });
    }
    await schedulePull(ctx.env, app.orgId, params.id, "manual");
    return json({ scheduled: true }, { status: 202 });
  });

  router.get("/v1/sync/conflicts", async (_req, ctx) => {
    ctx.requireRead("sync.resolve_conflict");
    return json((await conflictsFor(ctx.app())).map(linkJson));
  });

  router.post("/v1/sync/links/:linkId/resolve", async (req, ctx, params) => {
    ctx.requireWrite("sync.resolve_conflict");
    const app = ctx.app();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const resolution = body.resolution === "accept_external" ? "accept_external" : "keep_podium";
    const link = await resolveConflict(app, params.linkId, resolution);
    await app.flush();
    await schedulePush(ctx.env, app.orgId, str(link.mapping_id), "manual");
    return json(linkJson(link));
  });

  /** Every active mapping, for an operator checking what a base is wired to. */
  router.get("/v1/sync/active", async (_req, ctx) => {
    ctx.requireRead("org.configure");
    return json((await activeMappings(ctx.app())).map(mappingJson));
  });
}
