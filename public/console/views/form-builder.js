/**
 * `/admin/cfps/:cfpId/form` — the submission form builder.
 *
 * Three columns, which is the shape this job has: a palette of what you can
 * add, the form you are building, and the settings of the one thing you have
 * selected. The screen it replaces had no palette (a field's type was an entry
 * in a `<select>` inside an add-form at the bottom of each step) and no
 * selection (every field rendered its whole editing form inline, so a
 * twelve-field step was twelve open forms stacked vertically).
 *
 * ## What the model makes the builder responsible for
 *
 * - **INV-02-8** — a conditional field may only depend on a field that comes
 *   before it. Reordering can break that, so a drop is applied, checked against
 *   the finished order server-side, and refused as a whole if it broke a rule.
 *   The refusal is the interesting case: the field snaps back and the toast
 *   says which condition it would have broken.
 * - **INV-02-9** — a published form is immutable except for cosmetic edits and
 *   order. So a published form can be *rearranged* in place but a field cannot
 *   be moved into another step, and the header says which of the two you are
 *   editing rather than letting you discover it from an error.
 * - **INV-02-6 / INV-02-7** — keys are unique and a `maps_to` is claimed by at
 *   most one field. Both are enforced server-side; the inspector shows the
 *   clash rather than pre-empting it, because the server is the only thing that
 *   knows about the field another organizer added while this was open.
 */

import { h, cx, debounce, redraw } from "../kit.js";
import { api, unwrap } from "../api.js";
import { resource, reload, put, toast, reportError } from "../store.js";
import { setChrome } from "../chrome.js";
import { badge, button, card, empty, field, humanise, icons, notice, pageHead, FIELD_GLYPH } from "../ui.js";
import { beginDrag, drag, dropsAt, isDragging } from "../dnd.js";

/** Which field the inspector is showing, what the palette search says, the new step's title. */
const ui = { selected: null, search: "", adding: false, newStepTitle: "" };

/**
 * Edits typed but not yet saved, per field.
 *
 * A view that runs on every redraw re-asserts every input's value from the
 * data it was given, so a half-typed label would be reset by any unrelated
 * redraw — a toast, a live frame, another field saving. Holding the in-flight
 * text here makes the view's idea of the input and the reader's the same thing
 * until the save lands.
 */
const pending = new Map();
const flushers = new Map();

const GROUP_LABELS = { text: "Text", choice: "Choice", session: "Session details", other: "Other" };

export function formBuilder(params) {
  setChrome({ section: "cfp", title: "Form builder" });

  const key = "builder:" + params.cfpId;
  const res = resource(key, () => api.get("/v1/cfps/" + params.cfpId + "/builder").then(unwrap));

  if (res.error) {
    return card(notice(res.error.message, "err"), "Could not load the builder");
  }
  if (!res.data) return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));

  const d = res.data;
  if (!d.form) {
    return card(empty("This call has no form yet."), d.cfp.name);
  }

  const ctx = { key, cfpId: params.cfpId, data: d, form: d.form, canWrite: d.can_write, draft: d.form.status === "draft" };

  return h(
    "div",
    { class: "console-builder" },
    builderHead(ctx),
    h(
      "div",
      { class: "console-builder-cols" },
      palette(ctx),
      canvas(ctx),
      inspector(ctx),
    ),
    drag.item ? ghost() : null,
  );
}

/* -------------------------------------------------------------------------- */
/* Head                                                                        */
/* -------------------------------------------------------------------------- */

function builderHead(ctx) {
  const form = ctx.form;
  return h(
    "div",
    null,
    pageHead(
      ctx.data.cfp.name + " — submission form",
      "Steps, fields, conditional visibility, and what each answer becomes on the proposal.",
      h(
        "div",
        { class: "console-actions" },
        badge(form.status),
        h("span", { class: "badge" }, "version " + form.version),
        h("a", { class: "btn secondary", href: "/admin/cfps/" + ctx.cfpId + "/form/preview" }, "Preview"),
        ctx.canWrite && ctx.draft ? button("Publish this version", () => publish(ctx)) : null,
        ctx.canWrite && form.status === "published" ? button("New draft version", () => newVersion(ctx), { variant: "secondary" }) : null,
      ),
    ),
    // INV-02-9, said before it is discovered: on a published form order and
    // wording are editable and structure is not.
    form.status === "published"
      ? notice(
          "This version is live. You can rearrange it and reword it in place — anything structural needs a new draft version.",
          "warn",
        )
      : null,
    form.status === "retired" ? notice("This version has been retired. Edit the current draft instead.", "warn") : null,
  );
}

async function publish(ctx) {
  try {
    const next = await api.post("/v1/forms/" + ctx.form.id + "/publish");
    put(ctx.key, Object.assign({}, ctx.data, { form: next }));
    toast("ok", "Form published. The previous version is retired; drafts already bound to it keep it.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  }
}

async function newVersion(ctx) {
  try {
    await api.post("/v1/cfps/" + ctx.cfpId + "/forms", {});
    toast("ok", "New draft version created from the published one.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The field types, grouped and searchable, each with its glyph and a line
 * saying what it is for.
 *
 * The list comes from the server (`GET /v1/cfps/:cfpId/builder`), derived from
 * the `FIELD_TYPE` enum, so it cannot drift from the model the way a hard-coded
 * copy would.
 */
function palette(ctx) {
  const q = ui.search.trim().toLowerCase();
  const types = ctx.data.field_types.filter(
    (t) => !q || t.label.toLowerCase().includes(q) || t.type.includes(q) || t.description.toLowerCase().includes(q),
  );
  const groups = ["text", "choice", "session", "other"]
    .map((g) => ({ key: g, label: GROUP_LABELS[g], items: types.filter((t) => t.group === g) }))
    .filter((g) => g.items.length);

  const target = defaultStep(ctx);

  return h(
    "aside",
    { class: "console-panel console-palette" },
    h(
      "div",
      { class: "console-panel-head" },
      h("h2", null, "Add a field"),
      h(
        "div",
        { class: "console-search" },
        icons.search(),
        h("input", {
          type: "search",
          value: ui.search,
          placeholder: "Search field types…",
          "aria-label": "Search field types",
          oninput: (e) => {
            ui.search = e.target.value;
            redraw();
          },
        }),
      ),
      target
        ? h("p", { class: "console-panel-hint" }, "Adding to ", h("strong", null, target.title))
        : h("p", { class: "console-panel-hint" }, "Add a step first."),
    ),
    h(
      "div",
      { class: "console-panel-body" },
      groups.length
        ? groups.map((g) =>
            h(
              "section",
              { key: g.key, class: "console-palette-group" },
              h("h3", null, g.label),
              h(
                "ul",
                null,
                g.items.map((t) =>
                  h(
                    "li",
                    { key: t.type },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "console-type",
                        disabled: !ctx.canWrite || !target || ui.adding,
                        title: ctx.draft ? null : "A published form cannot gain a field. Create a new draft version first.",
                        onclick: () => addField(ctx, t, target),
                      },
                      h("span", { class: "console-type-glyph", "aria-hidden": "true" }, FIELD_GLYPH[t.type] || "?"),
                      h(
                        "span",
                        { class: "console-type-body" },
                        h("span", { class: "console-type-label" }, t.label),
                        h("span", { class: "console-type-hint" }, t.description),
                      ),
                      icons.plus(),
                    ),
                  ),
                ),
              ),
            ),
          )
        : empty("No field type matches “" + ui.search + "”."),
    ),
  );
}

/** The step a new field lands in: the selected field's step, else the last one. */
function defaultStep(ctx) {
  const steps = ctx.form.steps;
  if (!steps.length) return null;
  const selected = findField(ctx.form, ui.selected);
  if (selected) return steps.find((s) => s.id === selected.step.id) || steps[steps.length - 1];
  return steps[steps.length - 1];
}

async function addField(ctx, type, step) {
  if (ui.adding) return;
  ui.adding = true;
  try {
    const created = await api.post("/v1/forms/" + ctx.form.id + "/fields", {
      step_id: step.id,
      label: type.label,
      type: type.type,
      audience: "public",
      is_required: false,
      // A choice field with no options is a dead control, so it starts with
      // two rather than none and the inspector opens on them.
      options: type.takes_options ? [{ value: "option-1", label: "Option 1" }, { value: "option-2", label: "Option 2" }] : null,
    });
    ui.selected = created && created.id ? created.id : null;
    toast("ok", type.label + " added.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  } finally {
    ui.adding = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Canvas                                                                      */
/* -------------------------------------------------------------------------- */

function canvas(ctx) {
  const steps = [...ctx.form.steps].sort((a, b) => a.sort_order - b.sort_order);
  return h(
    "div",
    { class: "console-canvas" },
    steps.map((step, i) => stepCard(ctx, step, i, steps.length)),
    ctx.canWrite && ctx.draft ? addStepCard(ctx) : null,
  );
}

function stepCard(ctx, step, index, total) {
  const fields = [...step.fields].sort((a, b) => a.sort_order - b.sort_order);
  return h(
    "section",
    {
      key: step.id,
      class: cx("card", "console-step", isDragging(step.id) && "console-dragged"),
      "data-dnd-item": "step",
      "data-dnd-id": step.id,
    },
    h(
      "header",
      { class: "console-step-head" },
      ctx.canWrite
        ? h(
            "button",
            {
              type: "button",
              class: "console-grip-btn",
              "aria-label": "Drag to reorder " + step.title,
              onpointerdown: (ev) =>
                beginDrag(ev, { kind: "step", id: step.id, label: step.title, fromGroup: ctx.form.id, fromIndex: index }, (item, groupId, to) =>
                  commitStepMove(ctx, item, to),
                ),
            },
            icons.drag(),
          )
        : null,
      h("h2", null, step.title),
      step.is_optional ? h("span", { class: "badge" }, "optional") : null,
      step.visible_when ? h("span", { class: "badge", title: "Shown only when a condition is met" }, "conditional") : null,
      h("span", { class: "console-step-count" }, fields.length + (fields.length === 1 ? " field" : " fields")),
      ctx.canWrite
        ? h(
            "div",
            { class: "console-row-actions" },
            button("↑", () => moveStep(ctx, step, index - 1), { variant: "secondary", size: "small", disabled: index === 0, ariaLabel: "Move " + step.title + " up" }),
            button("↓", () => moveStep(ctx, step, index + 1), { variant: "secondary", size: "small", disabled: index === total - 1, ariaLabel: "Move " + step.title + " down" }),
            ctx.draft
              ? button("Remove", () => removeStep(ctx, step), { variant: "secondary", size: "small", disabled: fields.length > 0, title: fields.length ? "Remove its fields first." : null })
              : null,
          )
        : null,
    ),
    step.description ? h("p", { class: "lede" }, step.description) : null,
    h(
      "ul",
      { class: "console-fields", "data-dnd-group": "field", "data-dnd-id": step.id },
      fields.length === 0 && !dropsAt(step.id, 0)
        ? h("li", { class: "console-fields-empty" }, "No fields yet — pick one from the left.")
        : null,
      fields.map((f, i) => [
        dropsAt(step.id, i) ? insertionLine("before-" + f.id) : null,
        fieldRow(ctx, step, f, i, fields.length),
      ]),
      dropsAt(step.id, fields.length) ? insertionLine("end-" + step.id) : null,
    ),
  );
}

function insertionLine(key) {
  return h("li", { key: "line-" + key, class: "console-insertion", "aria-hidden": "true" });
}

function fieldRow(ctx, step, f, index, total) {
  const selected = ui.selected === f.id;
  return h(
    "li",
    {
      key: f.id,
      class: cx("console-field", selected && "is-selected", isDragging(f.id) && "console-dragged"),
      "data-dnd-item": "field",
      "data-dnd-id": f.id,
    },
    ctx.canWrite
      ? h(
          "button",
          {
            type: "button",
            class: "console-grip-btn",
            "aria-label": "Drag to reorder " + f.label,
            onpointerdown: (ev) =>
              beginDrag(ev, { kind: "field", id: f.id, label: f.label, fromGroup: step.id, fromIndex: index }, (item, groupId, to) =>
                commitFieldMove(ctx, item, groupId, to),
              ),
          },
          icons.drag(),
        )
      : null,
    h(
      "button",
      {
        type: "button",
        class: "console-field-main",
        "aria-pressed": selected ? "true" : "false",
        onclick: () => {
          ui.selected = selected ? null : f.id;
          redraw();
        },
      },
      h("span", { class: "console-field-glyph", "aria-hidden": "true" }, FIELD_GLYPH[f.type] || "?"),
      h(
        "span",
        { class: "console-field-body" },
        h(
          "span",
          { class: "console-field-label" },
          f.label,
          f.is_required ? h("span", { class: "req", title: "Required" }, "*") : null,
        ),
        h(
          "span",
          { class: "console-field-meta" },
          h("span", { class: "mono" }, f.key),
          " · ",
          typeLabel(ctx, f.type),
          f.maps_to && f.maps_to !== "none" ? [" · ", h("span", { class: "badge" }, "→ " + humanise(f.maps_to))] : null,
          f.audience !== "public" ? [" · ", h("span", { class: "badge warn" }, humanise(f.audience))] : null,
          f.pii ? [" · ", h("span", { class: "badge err", title: "Personal data" }, "PII")] : null,
          f.visible_when ? [" · ", h("span", { class: "badge" }, "conditional")] : null,
        ),
      ),
    ),
    ctx.canWrite
      ? h(
          "div",
          { class: "console-row-actions" },
          button("↑", () => moveField(ctx, step, f, index - 1), { variant: "secondary", size: "small", disabled: index === 0, ariaLabel: "Move " + f.label + " up" }),
          button("↓", () => moveField(ctx, step, f, index + 1), { variant: "secondary", size: "small", disabled: index === total - 1, ariaLabel: "Move " + f.label + " down" }),
        )
      : null,
  );
}

function typeLabel(ctx, type) {
  const spec = ctx.data.field_types.find((t) => t.type === type);
  return spec ? spec.label : humanise(type);
}

function addStepCard(ctx) {
  const add = async () => {
    if (!ui.newStepTitle.trim()) return toast("err", "A step needs a title.");
    try {
      await api.post("/v1/forms/" + ctx.form.id + "/steps", { title: ui.newStepTitle.trim(), is_optional: false });
      ui.newStepTitle = "";
      toast("ok", "Step added.");
      reload(ctx.key);
    } catch (err) {
      reportError(err);
    }
  };
  return card(
    h(
      "div",
      { class: "console-add-step" },
      field({
        name: "step_title",
        label: "Step title",
        placeholder: "Sponsorship details",
        value: ui.newStepTitle,
        oninput: (e) => {
          ui.newStepTitle = e.target.value;
          redraw();
        },
      }),
      button("Add step", add),
    ),
    "Add a step",
  );
}

/* -------------------------------------------------------------------------- */
/* Reordering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every reorder — dragged or pressed — becomes one `POST …/reorder` carrying
 * the whole new order, because that is the only shape INV-02-8 can be checked
 * against. Applying a multi-position move as a sequence of swaps would fail the
 * check against an intermediate order nobody asked for.
 */
async function applyOrder(ctx, steps, fields, description) {
  try {
    const next = await api.post("/v1/forms/" + ctx.form.id + "/reorder", { steps, fields });
    put(ctx.key, Object.assign({}, ctx.data, { form: next }));
  } catch (err) {
    if (err.invariant === "INV-02-8") {
      // The interesting failure: the drop would have moved a field above
      // something whose visibility depends on it. Say which, rather than
      // "invalid".
      toast("err", err.message, { duration: 8000 });
    } else if (err.invariant === "INV-02-9") {
      toast("err", err.message, { duration: 8000 });
    } else {
      reportError(err);
    }
    // Nothing was applied server-side, and the local copy was never mutated,
    // so the row snaps back by simply re-rendering what is already held.
    reload(ctx.key);
    return;
  }
  if (description) toast("ok", description);
}

function commitStepMove(ctx, item, toIndex) {
  const order = [...ctx.form.steps].sort((a, b) => a.sort_order - b.sort_order).map((s) => s.id);
  const from = order.indexOf(item.id);
  if (from < 0) return;
  order.splice(from, 1);
  order.splice(clamp(toIndex, 0, order.length), 0, item.id);
  applyOrder(ctx, order.map((id, i) => ({ id, sort_order: i })), []);
}

function moveStep(ctx, step, toIndex) {
  commitStepMove(ctx, { id: step.id }, toIndex);
}

function commitFieldMove(ctx, item, toStepId, toIndex) {
  const byStep = new Map();
  for (const s of ctx.form.steps) {
    byStep.set(
      s.id,
      [...s.fields].sort((a, b) => a.sort_order - b.sort_order).map((f) => f.id),
    );
  }
  const source = byStep.get(item.fromGroup);
  if (source) {
    const at = source.indexOf(item.id);
    if (at >= 0) source.splice(at, 1);
  }
  const target = byStep.get(toStepId);
  if (!target) return;
  target.splice(clamp(toIndex, 0, target.length), 0, item.id);

  const fields = [];
  for (const [stepId, ids] of byStep) {
    ids.forEach((id, i) => fields.push({ id, step_id: stepId, sort_order: i }));
  }
  applyOrder(ctx, [], fields, item.fromGroup !== toStepId ? "Moved to another step." : null);
}

function moveField(ctx, step, f, toIndex) {
  commitFieldMove(ctx, { id: f.id, fromGroup: step.id }, step.id, toIndex);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/* -------------------------------------------------------------------------- */
/* Inspector                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The selected field's settings. Text edits autosave on a pause; anything with
 * a discrete value saves on change. Nothing here has a Save button, because a
 * builder in which each of forty fields has its own unsaved state is a builder
 * that loses work.
 */
function inspector(ctx) {
  const found = findField(ctx.form, ui.selected);
  if (!found) {
    return h(
      "aside",
      { class: "console-panel console-inspector" },
      h("div", { class: "console-panel-head" }, h("h2", null, "Field settings")),
      h("div", { class: "console-panel-body" }, empty("Select a field to edit it.")),
    );
  }

  const f = found.field;
  const spec = ctx.data.field_types.find((t) => t.type === f.type);
  /** A discrete choice saves immediately; there is nothing to keep typing. */
  const save = (patch) => flushNow(ctx, f.id, patch);
  /** Text saves on a pause, and reads back what was typed in the meantime. */
  const typed = (name) => (e) => queue(ctx, f.id, name, e.target.value);
  const shown = (name) => {
    const p = pending.get(f.id);
    return p && name in p ? p[name] : f[name] == null ? "" : f[name];
  };

  return h(
    "aside",
    { class: "console-panel console-inspector" },
    h(
      "div",
      { class: "console-panel-head" },
      h("h2", null, "Field settings"),
      h("p", { class: "console-panel-hint" }, found.step.title, " · ", h("span", { class: "mono" }, f.key)),
    ),
    h(
      "div",
      { class: "console-panel-body stack" },
      field({ name: "label", label: "Label", required: true, value: shown("label"), oninput: typed("label") }),
      field({ name: "help_text", label: "Help text", value: shown("help_text"), oninput: typed("help_text") }),
      field({ name: "placeholder", label: "Placeholder", value: shown("placeholder"), oninput: typed("placeholder") }),
      field({
        name: "type",
        label: "Type",
        type: "select",
        value: f.type,
        disabled: !ctx.draft,
        help: ctx.draft ? null : "Changing a type needs a new draft version (INV-02-9).",
        options: ctx.data.field_types.map((t) => ({ value: t.type, label: t.label })),
        onchange: (e) => save({ type: e.target.value }),
      }),
      spec && spec.takes_options ? optionsEditor(f, save) : null,
      field({ name: "is_required", label: "Required", type: "checkbox", value: f.is_required, onchange: (e) => save({ is_required: e.target.checked }) }),
      field({
        name: "maps_to",
        label: "Becomes",
        type: "select",
        value: f.maps_to,
        disabled: !ctx.draft,
        help: "Promotes the answer into a first-class column on the proposal. At most one field per form may claim each (INV-02-7).",
        options: ctx.data.maps_to,
        onchange: (e) => save({ maps_to: e.target.value }),
      }),
      field({
        name: "audience",
        label: "Who sees the answer",
        type: "select",
        value: f.audience,
        options: ctx.data.audiences,
        disabled: !ctx.draft,
        onchange: (e) => save({ audience: e.target.value }),
      }),
      field({
        name: "pii",
        label: "This answer is personal data",
        type: "checkbox",
        value: f.pii,
        disabled: !ctx.draft,
        help: "Redaction is default-on: a field marked here is withheld from every surface that is not entitled to it.",
        onchange: (e) => save({ pii: e.target.checked }),
      }),
      f.visible_when
        ? h(
            "div",
            { class: "console-condition" },
            h("h4", null, "Shown only when"),
            h("p", { class: "small mono" }, JSON.stringify(f.visible_when)),
            ctx.draft ? button("Always show it", () => save({ visible_when: null }), { variant: "secondary", size: "small" }) : null,
          )
        : null,
      ctx.draft
        ? h(
            "div",
            { class: "console-inspector-danger" },
            button("Remove this field", () => removeField(ctx, f), { variant: "secondary" }),
          )
        : null,
    ),
  );
}

function optionsEditor(f, save) {
  const lines = (f.options || []).map((o) => o.label).join("\n");
  return field({
    name: "options",
    label: "Options",
    type: "textarea",
    rows: Math.max(3, (f.options || []).length + 1),
    value: lines,
    help: "One per line. The stored value is derived from the label.",
    onchange: (e) => {
      const options = e.target.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((label) => ({ value: slug(label), label }));
      save({ options });
    },
  });
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** Hold a keystroke, show it back, and save once typing pauses. */
function queue(ctx, fieldId, name, value) {
  const patch = pending.get(fieldId) || {};
  patch[name] = value;
  pending.set(fieldId, patch);

  let flush = flushers.get(fieldId);
  if (!flush) {
    flush = debounce(() => flushPending(ctx, fieldId), 600);
    flushers.set(fieldId, flush);
  }
  flush();
  redraw();
}

function flushPending(ctx, fieldId) {
  const patch = pending.get(fieldId);
  if (!patch) return;
  // Cleared before the request goes out, so a keystroke that arrives while it
  // is in flight starts a fresh patch rather than being dropped by the
  // response.
  pending.delete(fieldId);
  send(ctx, fieldId, patch);
}

function flushNow(ctx, fieldId, patch) {
  const held = pending.get(fieldId);
  if (held) {
    pending.delete(fieldId);
    patch = Object.assign({}, held, patch);
  }
  send(ctx, fieldId, patch);
}

async function send(ctx, fieldId, patch) {
  try {
    await api.patch("/v1/fields/" + fieldId, patch);
    reload(ctx.key);
  } catch (err) {
    // INV-02-6 (duplicate key) and INV-02-7 (a mapping already claimed) both
    // land here, and both carry a message naming the other field.
    reportError(err);
    reload(ctx.key);
  }
}

async function removeField(ctx, f) {
  try {
    await api.del("/v1/fields/" + f.id);
    if (ui.selected === f.id) ui.selected = null;
    toast("ok", "Field removed.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  }
}

async function removeStep(ctx, step) {
  try {
    await api.del("/v1/steps/" + step.id);
    toast("ok", "Step removed.");
    reload(ctx.key);
  } catch (err) {
    reportError(err);
  }
}

function findField(form, id) {
  if (!id) return null;
  for (const step of form.steps) {
    for (const f of step.fields) if (f.id === id) return { step, field: f };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The floating label that follows the pointer                                 */
/* -------------------------------------------------------------------------- */

function ghost() {
  return h(
    "div",
    { class: "console-ghost", style: { left: drag.x + "px", top: drag.y + "px" }, "aria-hidden": "true" },
    drag.item.label,
  );
}
