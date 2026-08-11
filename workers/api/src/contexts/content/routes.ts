/**
 * 11 — Cross-cutting content: admin UI + management API for `Asset`,
 * `AssetComment`, `CustomFieldDefinition`, `BulkImport` and `Export`.
 *
 * Admin: /admin/events/:eventId/files, /files/:assetId(/download),
 *   /admin/custom-fields, /admin/imports(/:id), /admin/exports(/:id).
 * Management API: /v1/assets, /v1/custom-fields, /v1/imports, /v1/exports.
 * Plus `GET /v1/me/export`.
 */

import { bool, num, parseJson, str, strOrNull, type Row } from "@podiumconf/data/db.js";
import { DomainError, forbidden, notFound } from "@podiumconf/domain/shared/errors.js";
import {
  ASSET_PURPOSES,
  CUSTOM_FIELD_AUDIENCES,
  CUSTOM_FIELD_SUBJECTS,
  CUSTOM_FIELD_TYPES,
  EXPORT_FORMATS,
  EXPORT_SUBJECTS,
  IMPORT_SUBJECTS,
} from "@podiumconf/domain/content/types.js";
import { markLatest, slotKey as buildSlotKey } from "@podiumconf/domain/content/assets.js";
import { verifyStorageUrl } from "@podiumconf/plugins/storage/r2.js";
import { resolvePlugin } from "../platform/service.js";
import { flashCookie, type RequestContext } from "../../http/context.js";
import { readInput } from "../../http/input.js";
import { htmlResponse, json, noContent, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, markdown, raw, type SafeHtml } from "../../ui/html.js";
import { actionForm, badge, card, field, humanise, pageHead, table } from "../../ui/layout.js";
import { adminPage, toEventRef } from "../../ui/shell.js";
import {
  addComment,
  editComment,
  getAsset,
  latestInSlot,
  listSlotVersions,
  presignAssetUpload,
  threadedComments,
  uploadAssetDirect,
} from "./assets.js";
import {
  archiveDefinition,
  createDefinition,
  definitionCountBySubject,
  getDefinition,
  listDefinitions,
  overSoftLimit,
  unarchiveDefinition,
  updateDefinition,
  usageFor,
} from "./custom-fields.js";
import {
  createImport,
  fieldChoicesFor,
  getImport,
  listImports,
  parsedCsvOf,
  previewImport,
  previewedRows,
  runImport,
  setMapping,
} from "./import.js";
import { createExport, generateExport, getExport, listExports } from "./export.js";
import { assetJson, commentJson, customFieldJson, exportJson, exportSize, filesLibrary, importJson, sessionsMissingSlides } from "./views.js";

const OK = (message: string) => ({ "set-cookie": flashCookie("ok", message) });

export function registerContentRoutes(router: Router<RequestContext>): void {
  registerAssetRoutes(router);
  registerCustomFieldRoutes(router);
  registerImportRoutes(router);
  registerExportRoutes(router);
  registerMeExportRoute(router);
  registerContentManagementApi(router);
}

/* -------------------------------------------------------------------------- */
/* Assets — files library, upload, download, comments                        */
/* -------------------------------------------------------------------------- */

/** Staff can see anything; a speaker/sponsor contact can see their own slot. */
async function assertCanViewAsset(ctx: RequestContext, asset: Row): Promise<void> {
  if (ctx.isStaff()) return;
  if (str(asset.uploaded_by_person_id) === ctx.person?.id) return;
  if (str(asset.visibility) === "public" && str(asset.scan_status) === "clean") return;
  const [subjectType, subjectId] = str(asset.slot_key).split(":");
  if (subjectType === "person" && subjectId === ctx.person?.id) return;
  if (subjectType === "session" && ctx.principals.relationships.session_ids.includes(subjectId)) return;
  if (subjectType === "task") {
    const app = ctx.app();
    const task = await app.db.byId<Row>("task_instance", subjectId);
    if (task && str(task.assignee_person_id) === ctx.person?.id) return;
  }
  throw forbidden("You do not have access to that file.");
}

function registerAssetRoutes(router: Router<RequestContext>): void {
  router.get("/admin/events/:eventId/files", async (_req, ctx, params) => {
    ctx.requireRead("session.manage", { event_id: params.eventId });
    const app = ctx.app(params.eventId);
    const event = await app.db.byId<Row>("event", params.eventId);
    if (!event) throw notFound("Event", params.eventId);
    const ref = toEventRef(event);

    const kind = ctx.url.searchParams.get("kind");
    const missing = ctx.url.searchParams.get("missing") === "1";
    const library = await filesLibrary(app, { kind });
    // A files library scoped to this event: keep rows whose slot points at
    // this event's sessions/roster, plus anything with no event affinity.
    const sessionIds = new Set((await app.db.select<Row>("session", { event_id: params.eventId })).map((s) => str(s.id)));
    const participantIds = new Set((await app.db.raw<{ person_id: string }>("SELECT person_id FROM event_participant WHERE event_id = ?", [params.eventId])).map((r) => r.person_id));
    const scoped = library.filter((row) => {
      const [t, id] = row.slot_key.split(":");
      if (t === "session") return sessionIds.has(id);
      if (t === "person") return participantIds.has(id);
      return false;
    });

    const rows = scoped.map(
      (r) => html`<tr>
        <td><a href="/files/${str(r.latest.id)}"><strong>${str(r.latest.filename)}</strong></a></td>
        <td>${badge(str(r.latest.purpose))}</td>
        <td>${badge(str(r.latest.scan_status), str(r.latest.scan_status) === "clean" ? "ok" : str(r.latest.scan_status) === "infected" ? "err" : "warn")}</td>
        <td>v${num(r.latest.version)} (${r.version_count} total)</td>
        <td>${r.comment_count}</td>
        <td class="small">${r.belongs_to.label}</td>
        <td class="small">${str(r.latest.created_at)}</td>
      </tr>`,
    );

    const missingRows = missing ? await sessionsMissingSlides(app, params.eventId) : [];

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Files", event: ref, active: "files", width: "wide" },
        html`${pageHead("Files", "Every deliverable across the event — deck, headshot, logo or signed document — with its version history and comments.")}
          <form method="get" class="inline-grid">
            ${field({ name: "kind", label: "Kind", type: "select", value: kind ?? "", options: ASSET_PURPOSES.map((p) => ({ value: p, label: humanise(p) })) })}
            ${field({ name: "missing", label: "Show sessions with no slides yet", type: "checkbox", value: missing })}
            <button type="submit" class="secondary">Filter</button>
          </form>
          ${missing
            ? card(
                table(["Session"], missingRows.map((s) => html`<tr><td><a href="/admin/events/${params.eventId}/sessions/${str(s.id)}">${str(s.title)}</a></td></tr>`), "Every session has slides."),
                "Missing slides",
              )
            : table(["File", "Kind", "Scan", "Version", "Comments", "Belongs to", "Uploaded"], rows, "No files yet.")}
          ${card(
            html`<form method="post" action="/admin/events/${params.eventId}/files/upload" enctype="multipart/form-data" class="stack">
              ${field({ name: "file", label: "File", type: "file", required: true })}
              ${field({ name: "subject_type", label: "Belongs to", type: "select", required: true, options: [{ value: "session", label: "Session" }, { value: "person", label: "Person" }, { value: "sponsor", label: "Sponsor" }] })}
              ${field({ name: "subject_id", label: "Subject id", required: true, help: "The session, person or sponsor id." })}
              ${field({ name: "kind", label: "Slot (e.g. slides, headshot, logo)", value: "document" })}
              ${field({ name: "purpose", label: "Purpose", type: "select", required: true, value: "document", options: ASSET_PURPOSES.map((p) => ({ value: p, label: humanise(p) })) })}
              <button type="submit">Upload</button>
            </form>`,
            "Upload a file (works with scripts blocked)",
          )}`,
      ),
    );
  });

  router.post("/admin/events/:eventId/files/upload", async (req, ctx, params) => {
    ctx.requireWrite("session.manage", { event_id: params.eventId });
    const input = await readInput(req);
    const app = ctx.app(params.eventId);
    const files = input.files("file");
    if (!files[0]) throw new DomainError({ code: "no_file", message: "Choose a file.", status: 422 });
    const slot = buildSlotKey(input.str("subject_type"), input.str("subject_id"), input.optional("kind"));
    const { asset } = await uploadAssetDirect(app, {
      file: files[0],
      slot_key: slot,
      purpose: (input.str("purpose", "document") as never) || "document",
    });
    await app.flush();
    return redirect(`/admin/events/${params.eventId}/files`, 303, OK(`Uploaded ${str(asset.filename)}.`));
  });

  router.get("/files/:assetId", async (_req, ctx, params) => {
    const app = ctx.app();
    const asset = await getAsset(app, params.assetId);
    await assertCanViewAsset(ctx, asset);
    const versions = await listSlotVersions(app, str(asset.slot_key));
    const marked = markLatest(versions.map((v) => ({ id: str(v.id), version: num(v.version), deleted_at: strOrNull(v.deleted_at), row: v })));
    const threads = await threadedComments(app, str(asset.slot_key));
    const canComment = ctx.isStaff() || str(asset.uploaded_by_person_id) === ctx.person?.id;

    const authorIds = [...new Set(threads.flatMap((t) => [str(t.comment.author_person_id), ...t.replies.map((r) => str(r.author_person_id))]))];
    const authors = authorIds.length ? await app.db.select<Row>("person", { id: authorIds }, { includeDeleted: true }) : [];
    const nameOf = (id: string) => {
      const p = authors.find((a) => str(a.id) === id);
      return p ? str(p.display_name) || str(p.full_name) : id;
    };

    const commentHtml = (c: Row) =>
      html`<div class="comment"><strong>${nameOf(str(c.author_person_id))}</strong> · <span class="small muted">${str(c.created_at)}</span>${c.edited_at ? html` <span class="small muted">(edited)</span>` : raw("")}
        <div>${markdown(str(c.body))}</div></div>`;

    return htmlResponse(
      adminPage(
        ctx,
        { title: str(asset.filename), width: "narrow" },
        html`${pageHead(str(asset.filename), `${str(asset.content_type)} · ${str(asset.purpose)} · slot ${str(asset.slot_key)}`)}
          ${card(
            table(
              ["Version", "Filename", "Size", "Scan", "Uploaded", ""],
              marked.map(
                (m) => html`<tr>
                  <td>v${m.version}${m.is_latest ? html` ${badge("latest", "ok")}` : raw("")}</td>
                  <td>${str(m.row.filename)}</td>
                  <td>${num(m.row.size_bytes)} bytes</td>
                  <td>${badge(str(m.row.scan_status), str(m.row.scan_status) === "clean" ? "ok" : "warn")}</td>
                  <td class="small">${str(m.row.created_at)}</td>
                  <td class="right"><a class="btn secondary small" href="/files/${m.id}/download">Download</a></td>
                </tr>`,
              ),
              "No versions.",
            ),
            "Every version",
          )}
          ${canComment
            ? card(
                html`${threads.map((t) => html`${commentHtml(t.comment)}<div class="replies">${t.replies.map(commentHtml)}</div>`)}
                  <form method="post" action="/files/${params.assetId}/comments" class="stack">
                    ${field({ name: "body", label: "Add a comment", type: "textarea", rows: 3 })}
                    <button type="submit" class="small">Comment</button>
                  </form>`,
                "Comments",
              )
            : raw("")}`,
      ),
    );
  });

  router.get("/files/:assetId/download", async (_req, ctx, params) => {
    const app = ctx.app();
    const asset = await getAsset(app, params.assetId);
    await assertCanViewAsset(ctx, asset);
    const object = await app.env.ASSETS_BUCKET.get(str(asset.storage_key));
    if (!object) throw notFound("File");
    return new Response(object.body, {
      headers: {
        "content-type": str(asset.content_type),
        "content-disposition": `attachment; filename="${str(asset.filename).replace(/"/g, "")}"`,
        "content-length": String(num(asset.size_bytes)),
      },
    });
  });

  router.post("/files/:assetId/comments", async (req, ctx, params) => {
    ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();
    await addComment(app, { asset_id: params.assetId, body: input.str("body"), parent_id: input.optional("parent_id") });
    await app.flush();
    return redirect(`/files/${params.assetId}`, 303, OK("Comment added."));
  });

  router.post("/files/:assetId/comments/:commentId", async (req, ctx, params) => {
    ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();
    await editComment(app, params.commentId, input.str("body"));
    await app.flush();
    return redirect(`/files/${params.assetId}`, 303, OK("Comment updated."));
  });

  /* The presigned flow's PUT/GET targets — 09, `storage` capability. */
  router.put("/files/upload", async (req, ctx) => {
    const key = ctx.url.searchParams.get("key") ?? "";
    const expires = Number(ctx.url.searchParams.get("expires") ?? 0);
    const sig = ctx.url.searchParams.get("sig") ?? "";
    const app = ctx.app();
    const resolved = await resolvePlugin(app, "storage", null);
    const secret = resolved?.ctx.secret ?? null;
    if (!secret || !(await verifyStorageUrl(secret, "upload", key, expires, sig, Date.now()))) {
      return json({ error: "invalid_signature", message: "That upload link is invalid or has expired." }, { status: 403 });
    }
    const body = await req.arrayBuffer();
    await ctx.env.ASSETS_BUCKET.put(key, body, { httpMetadata: { contentType: req.headers.get("content-type") ?? undefined } });
    const assetRow = await app.db.first<Row>("asset", { storage_key: key });
    if (assetRow && str(assetRow.checksum) === "") {
      const { sha256Hex } = await import("@podiumconf/domain/identity/credentials.js");
      await app.db.update("asset", str(assetRow.id), { size_bytes: body.byteLength, checksum: await sha256Hex(body) });
    }
    return noContent();
  });

  router.get("/files/blob", async (_req, ctx) => {
    const key = ctx.url.searchParams.get("key") ?? "";
    const expires = Number(ctx.url.searchParams.get("expires") ?? 0);
    const sig = ctx.url.searchParams.get("sig") ?? "";
    const filename = ctx.url.searchParams.get("filename") ?? "file";
    const app = ctx.app();
    const resolved = await resolvePlugin(app, "storage", null);
    const secret = resolved?.ctx.secret ?? null;
    if (!secret || !(await verifyStorageUrl(secret, "download", key, expires, sig, Date.now()))) {
      return json({ error: "invalid_signature", message: "That download link is invalid or has expired." }, { status: 403 });
    }
    const object = await ctx.env.ASSETS_BUCKET.get(key);
    if (!object) return notFoundResponse();
    return new Response(object.body, { headers: { "content-disposition": `attachment; filename="${filename}"` } });
  });
}

function notFoundResponse() {
  return json({ error: "not_found", message: "Not found." }, { status: 404 });
}

/* -------------------------------------------------------------------------- */
/* Custom fields                                                              */
/* -------------------------------------------------------------------------- */

function registerCustomFieldRoutes(router: Router<RequestContext>): void {
  router.get("/admin/custom-fields", async (_req, ctx) => {
    ctx.requireRead("custom_field.manage");
    const app = ctx.app();
    const subject = ctx.url.searchParams.get("subject_type") as never;
    const defs = await listDefinitions(app, subject || null);
    const counts = await definitionCountBySubject(app);
    const canWrite = ctx.canWrite("custom_field.manage");

    const rows = [];
    for (const d of defs) {
      const usage = await usageFor(app, d);
      rows.push(html`<tr>
        <td><strong>${str(d.label)}</strong><br><span class="mono small muted">${str(d.key)}</span></td>
        <td>${badge(str(d.subject_type))}</td>
        <td>${badge(str(d.type))}</td>
        <td>${bool(d.pii) ? badge("PII", "warn") : raw("")} ${badge(str(d.audience))}</td>
        <td>${Math.round(usage.fill_rate * 100)}% (${usage.filled}/${usage.total})</td>
        <td class="small">${usage.last_used_at ?? "never"}</td>
        <td>${badge(str(d.status), str(d.status) === "active" ? "ok" : "")}</td>
        <td class="right">
          ${canWrite
            ? str(d.status) === "active"
              ? actionForm(`/admin/custom-fields/${str(d.id)}/archive`, "Archive", { confirm: "Archive this field? Values are kept." })
              : actionForm(`/admin/custom-fields/${str(d.id)}/unarchive`, "Unarchive")
            : raw("")}
        </td>
      </tr>`);
    }

    const warnings = Object.entries(counts)
      .filter(([, n]) => overSoftLimit(n))
      .map(([s, n]) => `${s} has ${n} active fields`);

    return htmlResponse(
      adminPage(
        ctx,
        { title: "Custom fields", active: "custom-fields", width: "wide" },
        html`${pageHead(
            "Custom fields",
            "Adding a field means deciding its PII class — whether it holds personal data, and who is allowed to see it, are both answered when you create it and never guessed for you.",
            canWrite ? html`<a class="btn" href="/admin/custom-fields/new">New field</a>` : raw(""),
          )}
          ${warnings.length ? html`<p class="notice warn">${warnings.join("; ")} — proliferation is surfaced, not capped (R27).</p>` : raw("")}
          ${table(["Field", "Subject", "Type", "Classification", "Fill rate", "Last used", "Status", ""], rows, "No custom fields yet.")}`,
      ),
    );
  });

  router.get("/admin/custom-fields/new", async (_req, ctx) => {
    ctx.requireWrite("custom_field.manage");
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New custom field", active: "custom-fields", width: "narrow" },
        html`${pageHead("New custom field")}
          ${card(html`<form method="post" action="/admin/custom-fields/new" class="stack">
            ${field({ name: "subject_type", label: "Subject", type: "select", required: true, options: CUSTOM_FIELD_SUBJECTS.map((s) => ({ value: s, label: humanise(s) })) })}
            ${field({ name: "label", label: "Label", required: true, placeholder: "T-shirt size" })}
            ${field({ name: "key", label: "Key", help: "Lowercase, hyphenated. Immutable once values exist. Leave blank to derive from the label." })}
            ${field({ name: "type", label: "Type", type: "select", required: true, options: CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: humanise(t) })) })}
            ${field({ name: "options", label: "Options (for select types)", type: "textarea", rows: 3, help: "One per line: value|Label" })}
            ${field({ name: "is_required", label: "Required", type: "checkbox" })}
            ${field({ name: "pii", label: "Holds personal data", type: "select", required: true, options: [{ value: "true", label: "Yes — treat as PII" }, { value: "false", label: "No" }], help: "No default — say so either way. A field marked as personal data is redacted from exports and public pages unless the reader may see contact details." })}
            ${field({ name: "audience", label: "Audience", type: "select", required: true, options: CUSTOM_FIELD_AUDIENCES.map((a) => ({ value: a, label: humanise(a) })), help: "public may reach a publication snapshot." })}
            <button type="submit">Create field</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/custom-fields/new", async (req, ctx) => {
    ctx.requireWrite("custom_field.manage");
    const input = await readInput(req);
    const app = ctx.app();
    const optionLines = input.str("options");
    const options = optionLines
      ? optionLines
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [value, label] = l.split("|");
            return { value: (value ?? l).trim(), label: (label ?? value ?? l).trim() };
          })
      : null;
    const row = await createDefinition(app, {
      subject_type: input.str("subject_type") as never,
      key: input.optional("key") ?? "",
      label: input.str("label"),
      type: input.str("type"),
      options,
      is_required: input.bool("is_required"),
      pii: input.has("pii") ? input.str("pii") === "true" : undefined,
      audience: input.optional("audience"),
    });
    await app.flush();
    return redirect("/admin/custom-fields", 303, OK(`"${str(row.label)}" created.`));
  });

  router.post("/admin/custom-fields/:id/archive", async (_req, ctx, params) => {
    ctx.requireWrite("custom_field.manage");
    const app = ctx.app();
    await archiveDefinition(app, params.id);
    await app.flush();
    return redirect("/admin/custom-fields", 303, OK("Field archived."));
  });

  router.post("/admin/custom-fields/:id/unarchive", async (_req, ctx, params) => {
    ctx.requireWrite("custom_field.manage");
    const app = ctx.app();
    await unarchiveDefinition(app, params.id);
    await app.flush();
    return redirect("/admin/custom-fields", 303, OK("Field restored."));
  });
}

/* -------------------------------------------------------------------------- */
/* Bulk import                                                                */
/* -------------------------------------------------------------------------- */

function registerImportRoutes(router: Router<RequestContext>): void {
  router.get("/admin/imports", async (_req, ctx) => {
    ctx.requireRead("bulk.import");
    const app = ctx.app();
    const imports = await listImports(app);
    const rows = imports.map(
      (i) => html`<tr>
        <td><a href="/admin/imports/${str(i.id)}"><strong>${str(i.subject)}</strong></a></td>
        <td>${badge(str(i.status))}</td>
        <td class="small">${str(i.created_at)}</td>
      </tr>`,
    );
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Imports", active: "imports", width: "wide" },
        html`${pageHead(
            "Imports",
            "Map, validate, preview, then run — nothing is written until the preview is confirmed.",
            html`<a class="btn" href="/admin/imports/new">New import</a>`,
          )}
          ${table(["Subject", "Status", "Started"], rows, "No imports yet.")}`,
      ),
    );
  });

  router.get("/admin/imports/new", async (_req, ctx) => {
    ctx.requireWrite("bulk.import");
    const app = ctx.app();
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New import", active: "imports", width: "narrow" },
        html`${pageHead("New import", "A CSV of name,email,title,company,bio creates people, speaker profiles and roster rows.")}
          ${card(html`<form method="post" action="/admin/imports/new" enctype="multipart/form-data" class="stack">
            ${field({ name: "subject", label: "What are you importing", type: "select", required: true, options: IMPORT_SUBJECTS.map((s) => ({ value: s, label: humanise(s) })) })}
            ${field({ name: "event_id", label: "Event (for a roster import)", type: "select", options: events.map((e) => ({ value: str(e.id), label: str(e.name) })) })}
            ${field({ name: "file", label: "CSV file", type: "file", accept: ".csv,text/csv", required: true })}
            <button type="submit">Upload and map</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/imports/new", async (req, ctx) => {
    ctx.requireWrite("bulk.import");
    const input = await readInput(req);
    const app = ctx.app();
    const files = input.files("file");
    const row = await createImport(app, { subject: input.str("subject") as never, event_id: input.optional("event_id"), file: files[0] });
    await app.flush();
    return redirect(`/admin/imports/${str(row.id)}`, 303, OK("File uploaded. Confirm the column mapping next."));
  });

  router.get("/admin/imports/:id", async (_req, ctx, params) => {
    ctx.requireRead("bulk.import");
    const app = ctx.app();
    const importRow = await getImport(app, params.id);
    const parsed = await parsedCsvOf(app, importRow);
    const mapping = parseJson<Record<string, string>>(importRow.column_mapping, {});
    const fields = fieldChoicesFor(str(importRow.subject) as never);
    const status = str(importRow.status);

    let body: SafeHtml;
    if (status === "mapping" || status === "uploaded") {
      body = html`${card(
        html`<form method="post" action="/admin/imports/${params.id}/map" class="stack">
          <p class="muted">${parsed.rows.length} data row(s), ${parsed.headers.length} column(s).</p>
          ${parsed.headers.map(
            (h) => html`<div class="field"><label>${h}</label>
              <select name="map.${h}">
                <option value="">— ignore —</option>
                ${fields.map((f) => html`<option value="${f.key}"${mapping[h] === f.key ? raw(" selected") : raw("")}>${f.label}${f.required ? " *" : ""}</option>`)}
              </select>
            </div>`,
          )}
          ${field({ name: "dedupe_key", label: "Deduplicate on", type: "select", value: str(importRow.dedupe_key, "email"), options: [{ value: "email", label: "Email" }, { value: "reference", label: "Reference" }, { value: "none", label: "None — every row is new" }] })}
          ${field({ name: "on_duplicate", label: "On duplicate", type: "select", value: str(importRow.on_duplicate, "update"), options: [{ value: "update", label: "Update the existing record" }, { value: "skip", label: "Skip" }, { value: "create_anyway", label: "Create anyway" }] })}
          <button type="submit">Preview</button>
        </form>`,
        "Map columns",
      )}`;
    } else if (status === "previewing") {
      const rows = await previewedRows(app, params.id);
      body = html`${card(
        html`<p>${rows.filter((r) => str(r.outcome) === "create").length} to create ·
            ${rows.filter((r) => str(r.outcome) === "update").length} to update ·
            ${rows.filter((r) => str(r.outcome) === "skip").length} to skip ·
            ${rows.filter((r) => str(r.outcome) === "error").length} error(s)</p>
          ${table(
            ["Row", "Outcome", "Message"],
            rows.map((r) => html`<tr><td>${num(r.row_number)}</td><td>${badge(str(r.outcome), str(r.outcome) === "error" ? "err" : str(r.outcome) === "skip" ? "warn" : "ok")}</td><td class="small">${strOrNull(r.message) ?? "—"}</td></tr>`),
            "Nothing to preview.",
          )}
          <form method="post" action="/admin/imports/${params.id}/run"><button type="submit">Run import</button></form>`,
        "Preview",
      )}`;
    } else {
      const rows = await previewedRows(app, params.id);
      body = html`${card(
        html`${table(
          ["Row", "Result", "Message"],
          rows.map((r) => html`<tr><td>${num(r.row_number)}</td><td>${badge(str(r.outcome))}</td><td class="small">${strOrNull(r.message) ?? "—"}</td></tr>`),
          "Nothing ran.",
        )}`,
        "Result",
      )}`;
    }

    return htmlResponse(adminPage(ctx, { title: `Import — ${str(importRow.subject)}`, active: "imports", width: "wide" }, html`${pageHead(`Import: ${humanise(str(importRow.subject))}`, `${badge(status)}`)}${body}`));
  });

  router.post("/admin/imports/:id/map", async (req, ctx, params) => {
    ctx.requireWrite("bulk.import");
    const input = await readInput(req);
    const app = ctx.app();
    const all = input.all();
    const columnMapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("map.") && v) columnMapping[k.slice(4)] = String(v);
    }
    await setMapping(app, params.id, {
      column_mapping: columnMapping,
      dedupe_key: input.str("dedupe_key", "email") as never,
      on_duplicate: input.str("on_duplicate", "update") as never,
    });
    await previewImport(app, params.id);
    await app.flush();
    return redirect(`/admin/imports/${params.id}`, 303, OK("Previewed. Nothing has been written yet."));
  });

  router.post("/admin/imports/:id/run", async (_req, ctx, params) => {
    ctx.requireWrite("bulk.import");
    const app = ctx.app();
    const result = await runImport(app, params.id);
    await app.flush();
    return redirect(`/admin/imports/${params.id}`, 303, OK(`Created ${result.created_count}, updated ${result.updated_count}, skipped ${result.skipped_count}, ${result.error_count} error(s).`));
  });
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

function registerExportRoutes(router: Router<RequestContext>): void {
  router.get("/admin/exports", async (_req, ctx) => {
    ctx.requireRead("export.request");
    const app = ctx.app();
    const exports = await listExports(app);
    const rows = [];
    for (const e of exports) {
      const size = await exportSize(app, e);
      rows.push(html`<tr>
        <td>${str(e.subject)}</td>
        <td>${badge(str(e.format))}</td>
        <td>${badge(str(e.status), str(e.status) === "ready" ? "ok" : str(e.status) === "failed" ? "err" : "")}</td>
        <td class="small">${str(e.created_at)}</td>
        <td class="right">${str(e.status) === "ready" ? html`<a class="btn secondary small" href="/admin/exports/${str(e.id)}/download">Download</a>` : raw("")}</td>
      </tr>`);
    }
    return htmlResponse(
      adminPage(
        ctx,
        { title: "Exports", active: "exports", width: "wide" },
        html`${pageHead(
            "Exports",
            "Generated exactly under your own permissions — never a side door around what you may already see. Expire after 7 days.",
            html`<a class="btn" href="/admin/exports/new">New export</a>`,
          )}
          ${table(["Subject", "Format", "Status", "Requested", ""], rows, "No exports yet.")}`,
      ),
    );
  });

  router.get("/admin/exports/new", async (_req, ctx) => {
    ctx.requireWrite("export.request");
    const app = ctx.app();
    const events = await app.db.select<Row>("event", {}, { orderBy: "starts_on DESC" });
    const hasPii = ctx.includePii();
    return htmlResponse(
      adminPage(
        ctx,
        { title: "New export", active: "exports", width: "narrow" },
        html`${pageHead("New export")}
          ${card(html`<form method="post" action="/admin/exports/new" class="stack">
            ${field({ name: "subject", label: "Subject", type: "select", required: true, options: EXPORT_SUBJECTS.map((s) => ({ value: s, label: humanise(s) })) })}
            ${field({ name: "format", label: "Format", type: "select", required: true, value: "csv", options: EXPORT_FORMATS.filter((f) => f !== "xlsx" && f !== "ics").map((f) => ({ value: f, label: f.toUpperCase() })) })}
            ${field({ name: "event_id", label: "Event", type: "select", options: events.map((e) => ({ value: str(e.id), label: str(e.name) })) })}
            ${field({ name: "round_id", label: "Review round id (review_results only)" })}
            ${hasPii ? field({ name: "include_pii", label: "Include personal data", type: "checkbox", help: "Requires pii:read; still narrowed to what you could read on screen." }) : raw("")}
            <button type="submit">Generate</button>
          </form>`)}`,
      ),
    );
  });

  router.post("/admin/exports/new", async (req, ctx) => {
    ctx.requireWrite("export.request");
    const input = await readInput(req);
    const app = ctx.app();
    const roundId = input.optional("round_id");
    const row = await createExport(app, ctx.principals, {
      subject: input.str("subject") as never,
      format: input.str("format", "csv") as never,
      event_id: input.optional("event_id"),
      include_pii: input.bool("include_pii"),
      filters: roundId ? { round_id: roundId } : null,
    });
    await app.flush();
    ctx.waitUntil(
      (async () => {
        const genApp = ctx.app(strOrNull(row.event_id));
        await generateExport(genApp, ctx.principals, str(row.id));
        await genApp.flush();
      })(),
    );
    return redirect(`/admin/exports/${str(row.id)}`, 303, OK("Generating — this usually takes a few seconds."));
  });

  router.get("/admin/exports/:id", async (_req, ctx, params) => {
    ctx.requireRead("export.request");
    const app = ctx.app();
    const row = await getExport(app, params.id);
    const size = await exportSize(app, row);
    return htmlResponse(
      adminPage(
        ctx,
        { title: `Export — ${str(row.subject)}`, active: "exports", width: "narrow" },
        html`${pageHead(`${humanise(str(row.subject))} export`, `${badge(str(row.status))}`)}
          ${card(
            html`<p>Format: <strong>${str(row.format)}</strong></p>
              <p>Includes personal data: ${bool(row.include_pii) ? "yes" : "no"}</p>
              ${size.byte_size !== null ? html`<p>Size: ${size.byte_size} bytes</p>` : raw("")}
              <p>Expires: ${str(row.expires_at)}</p>
              ${str(row.status) === "ready" ? html`<p><a class="btn" href="/admin/exports/${params.id}/download">Download</a></p>` : raw("")}
              ${str(row.status) === "failed" ? html`<p class="notice err">Generation failed.</p>` : raw("")}`,
          )}`,
      ),
    );
  });

  router.get("/admin/exports/:id/download", async (_req, ctx, params) => {
    ctx.requireRead("export.request");
    const app = ctx.app();
    const row = await getExport(app, params.id);
    if (!row.result_asset_id) throw notFound("Export result");
    const asset = await getAsset(app, str(row.result_asset_id));
    const object = await ctx.env.ASSETS_BUCKET.get(str(asset.storage_key));
    if (!object) throw notFound("Export file");
    return new Response(object.body, {
      headers: { "content-type": str(asset.content_type), "content-disposition": `attachment; filename="${str(asset.filename)}"` },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* /v1/me/export — a person's own data (11, "Export")                        */
/* -------------------------------------------------------------------------- */

function registerMeExportRoute(router: Router<RequestContext>): void {
  router.get("/v1/me/export", async (_req, ctx) => {
    const person = ctx.requirePerson();
    const app = ctx.app();
    const [profile, participation, proposals, sessions, tasks, notifications, assets] = await Promise.all([
      app.db.first<Row>("speaker_profile", { person_id: person.id }),
      app.db.raw<Row>("SELECT * FROM event_participant WHERE person_id = ?", [person.id]),
      app.db.raw<Row>("SELECT * FROM proposal WHERE submitter_person_id = ? AND deleted_at IS NULL", [person.id]),
      app.db.raw<Row>(
        "SELECT s.* FROM session_speaker ss JOIN session s ON s.id = ss.session_id WHERE ss.person_id = ? AND s.deleted_at IS NULL",
        [person.id],
      ),
      app.db.raw<Row>("SELECT * FROM task_instance WHERE assignee_person_id = ?", [person.id]),
      app.db.raw<Row>("SELECT id, created_at, template_key, subject, status FROM notification_delivery WHERE recipient_person_id = ? ORDER BY created_at DESC", [person.id]),
      app.db.raw<Row>("SELECT * FROM asset WHERE uploaded_by_person_id = ? AND deleted_at IS NULL", [person.id]),
    ]);
    return json({
      person: { id: person.id, full_name: person.full_name, display_name: person.display_name, email: person.email },
      profile: profile ?? null,
      participation,
      proposals,
      sessions,
      tasks,
      notifications,
      assets: assets.map((a) => ({ id: str(a.id), filename: str(a.filename), purpose: str(a.purpose), created_at: str(a.created_at), download_url: `/files/${str(a.id)}/download` })),
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Management API                                                              */
/* -------------------------------------------------------------------------- */

export function registerContentManagementApi(router: Router<RequestContext>): void {
  router.post("/v1/assets", async (req, ctx) => {
    ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();
    const files = input.files("file");
    if (!files[0]) throw new DomainError({ code: "no_file", message: "Attach a file.", status: 422 });
    const slot = buildSlotKey(input.str("subject_type"), input.str("subject_id"), input.optional("kind"));
    const { asset, superseded } = await uploadAssetDirect(app, {
      file: files[0],
      slot_key: slot,
      purpose: (input.str("purpose", "document") as never) || "document",
      visibility: (input.optional("visibility") as never) ?? "private",
    });
    await app.flush();
    return json({ ...assetJson(asset, true), superseded_asset_id: superseded ? str(superseded.id) : null }, { status: 201 });
  });

  router.post("/v1/assets/presign", async (req, ctx) => {
    ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();
    const slot = buildSlotKey(input.str("subject_type"), input.str("subject_id"), input.optional("kind"));
    const result = await presignAssetUpload(app, {
      slot_key: slot,
      filename: input.str("filename"),
      content_type: input.str("content_type", "application/octet-stream"),
      size_bytes: input.int("size_bytes", 0) ?? 0,
      purpose: (input.str("purpose", "document") as never) || "document",
      visibility: (input.optional("visibility") as never) ?? "private",
    });
    await app.flush();
    return json({ asset: assetJson(result.asset, true), upload: result.upload }, { status: 201 });
  });

  router.get("/v1/assets/:id", async (_req, ctx, params) => {
    const app = ctx.app();
    const asset = await getAsset(app, params.id);
    await assertCanViewAsset(ctx, asset);
    const latest = await latestInSlot(app, str(asset.slot_key));
    return json(assetJson(asset, latest?.id === asset.id));
  });

  router.get("/v1/assets/:id/comments", async (_req, ctx, params) => {
    const app = ctx.app();
    const asset = await getAsset(app, params.id);
    await assertCanViewAsset(ctx, asset);
    const threads = await threadedComments(app, str(asset.slot_key));
    return json(threads.map((t) => ({ comment: commentJson(t.comment), replies: t.replies.map(commentJson) })));
  });

  router.post("/v1/assets/:id/comments", async (req, ctx, params) => {
    ctx.requirePerson();
    const input = await readInput(req);
    const app = ctx.app();
    const id = await addComment(app, { asset_id: params.id, body: input.str("body"), parent_id: input.optional("parent_id") });
    await app.flush();
    return json({ id }, { status: 201 });
  });

  router.get("/v1/custom-fields", async (_req, ctx) => {
    ctx.requireRead("custom_field.manage");
    const app = ctx.app();
    return json((await listDefinitions(app, ctx.url.searchParams.get("subject_type") as never)).map(customFieldJson));
  });
  router.post("/v1/custom-fields", async (req, ctx) => {
    ctx.requireWrite("custom_field.manage");
    const input = await readInput(req);
    const app = ctx.app();
    const row = await createDefinition(app, {
      subject_type: input.str("subject_type") as never,
      key: input.optional("key") ?? "",
      label: input.str("label"),
      type: input.str("type"),
      options: input.has("options") ? input.json("options", null) : null,
      is_required: input.bool("is_required"),
      pii: input.has("pii") ? input.bool("pii") : undefined,
      audience: input.optional("audience"),
    });
    await app.flush();
    return json(customFieldJson(row), { status: 201 });
  });
  router.post("/v1/custom-fields/:id", async (req, ctx, params) => {
    ctx.requireWrite("custom_field.manage");
    const input = await readInput(req);
    const app = ctx.app();
    if (input.str("action") === "archive") await archiveDefinition(app, params.id);
    else if (input.str("action") === "unarchive") await unarchiveDefinition(app, params.id);
    else {
      await updateDefinition(app, params.id, {
        label: input.optional("label") ?? undefined,
        help_text: input.optional("help_text"),
        is_required: input.has("is_required") ? input.bool("is_required") : undefined,
        show_in_list: input.has("show_in_list") ? input.bool("show_in_list") : undefined,
        is_filterable: input.has("is_filterable") ? input.bool("is_filterable") : undefined,
      });
    }
    await app.flush();
    return json(customFieldJson(await getDefinition(app, params.id)));
  });

  router.get("/v1/imports", async (_req, ctx) => {
    ctx.requireRead("bulk.import");
    return json((await listImports(ctx.app())).map(importJson));
  });
  router.post("/v1/imports", async (req, ctx) => {
    ctx.requireWrite("bulk.import");
    const input = await readInput(req);
    const app = ctx.app();
    const files = input.files("file");
    const row = await createImport(app, {
      subject: input.str("subject") as never,
      event_id: input.optional("event_id"),
      file: files[0],
      csvText: files[0] ? undefined : input.optional("csv_text") ?? undefined,
    });
    await app.flush();
    return json(importJson(row), { status: 201 });
  });
  router.get("/v1/imports/:id", async (_req, ctx, params) => {
    ctx.requireRead("bulk.import");
    return json(importJson(await getImport(ctx.app(), params.id)));
  });
  router.post("/v1/imports/:id/map", async (req, ctx, params) => {
    ctx.requireWrite("bulk.import");
    const input = await readInput(req);
    const app = ctx.app();
    await setMapping(app, params.id, {
      column_mapping: input.json("column_mapping", {}),
      dedupe_key: input.str("dedupe_key", "email") as never,
      on_duplicate: input.str("on_duplicate", "update") as never,
    });
    const preview = await previewImport(app, params.id);
    await app.flush();
    return json({ import: importJson(await getImport(app, params.id)), rows: preview.rows, summary: preview.summary });
  });
  router.post("/v1/imports/:id/run", async (_req, ctx, params) => {
    ctx.requireWrite("bulk.import");
    const app = ctx.app();
    const result = await runImport(app, params.id);
    await app.flush();
    return json({ import: importJson(await getImport(app, params.id)), ...result });
  });

  router.get("/v1/exports", async (_req, ctx) => {
    ctx.requireRead("export.request");
    const app = ctx.app();
    const rows = await listExports(app);
    const out = [];
    for (const r of rows) {
      const size = await exportSize(app, r);
      out.push(exportJson(r, size.row_count, size.byte_size));
    }
    return json(out);
  });
  router.post("/v1/exports", async (req, ctx) => {
    ctx.requireWrite("export.request");
    const input = await readInput(req);
    const app = ctx.app();
    const row = await createExport(app, ctx.principals, {
      subject: input.str("subject") as never,
      format: input.str("format", "csv") as never,
      event_id: input.optional("event_id"),
      include_pii: input.bool("include_pii"),
      filters: input.has("filters") ? input.json("filters", null) : null,
      options: input.has("options") ? input.json("options", null) : null,
    });
    await app.flush();
    ctx.waitUntil(
      (async () => {
        const genApp = ctx.app(strOrNull(row.event_id));
        await generateExport(genApp, ctx.principals, str(row.id));
        await genApp.flush();
      })(),
    );
    return json(exportJson(row, null, null), { status: 201 });
  });
  router.get("/v1/exports/:id", async (_req, ctx, params) => {
    ctx.requireRead("export.request");
    const app = ctx.app();
    const row = await getExport(app, params.id);
    const size = await exportSize(app, row);
    return json(exportJson(row, size.row_count, size.byte_size));
  });
}
